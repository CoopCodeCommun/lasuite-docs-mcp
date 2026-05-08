#!/usr/bin/env node
/**
 * Serveur MCP `lasuite-docs-mcp` — point d'entrée stdio.
 * / MCP server `lasuite-docs-mcp` — stdio entrypoint.
 *
 * LOCALISATION : src/server.ts
 *
 * Ce module :
 *   1. Charge la configuration depuis l'environnement (DOCS_INSTANCE_URL, ...).
 *   2. Instancie SessionManager (cache Yjs) et DocsRestClient (REST).
 *   3. Déclare les 5 tools MCP (+ 1 metadata) avec validation zod.
 *   4. Démarre le transport stdio.
 *
 * COMMUNICATION :
 * stdin/stdout : protocole MCP avec le client (Claude Desktop, etc.)
 * Délègue à : SessionManager (lecture/édition Yjs), DocsRestClient (REST)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SessionManager } from './docs/session.js';
import { DocsRestClient } from './docs/client.js';
import { DocsError } from './types.js';

// 1. Charge la configuration depuis l'environnement.
// / Load config from environment.
const docsInstanceUrl =
  process.env.DOCS_INSTANCE_URL ?? 'https://notes.liiib.re';
const sessionTtlMs = Number(process.env.DOCS_SESSION_TTL_MS ?? '300000');
const syncTimeoutMs = Number(process.env.DOCS_SYNC_TIMEOUT_MS ?? '10000');

// 2. Instancie les services.
// / Instantiate services.
const sessionManager = new SessionManager(
  docsInstanceUrl,
  sessionTtlMs,
  syncTimeoutMs,
);
const docsRestClient = new DocsRestClient(docsInstanceUrl);

// 3. Schemas zod pour la validation des inputs.
// / Zod schemas for input validation.
const documentIdentifierSchema = z
  .string()
  .uuid('doc_id must be a valid UUID v4');

const blockContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paragraph'),
    text: z.string().min(1, 'text must not be empty'),
  }),
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1, 'text must not be empty'),
  }),
]);

const insertBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  content: blockContentSchema,
  after_block_id: z.string().nullable().optional(),
});

const updateBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  block_id: z.string(),
  text: z.string().min(1, 'text must not be empty'),
});

const deleteBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  block_id: z.string(),
});

const readDocumentInputSchema = z.object({
  doc_id: documentIdentifierSchema,
});

// 4. Définition des tools MCP.
// / MCP tool definitions.
const toolDefinitionList = [
  {
    name: 'list_documents',
    description:
      'Liste les documents publics (link_reach=public) accessibles sur l\'instance Docs configurée.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_document',
    description:
      'Lit la liste structurée des blocs (paragraphes, headings) d\'un document public. Retourne un tableau de {id, type, text, level?}.',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string', format: 'uuid' } },
      required: ['doc_id'],
    },
  },
  {
    name: 'insert_block',
    description:
      'Insère un nouveau bloc (paragraph ou heading) dans le document. Si after_block_id est null/absent, insertion en tête. Retourne le block_id généré.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        content: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'paragraph' },
                text: { type: 'string' },
              },
              required: ['type', 'text'],
            },
            {
              type: 'object',
              properties: {
                type: { const: 'heading' },
                level: { type: 'integer', enum: [1, 2, 3] },
                text: { type: 'string' },
              },
              required: ['type', 'level', 'text'],
            },
          ],
        },
        after_block_id: { type: ['string', 'null'] },
      },
      required: ['doc_id', 'content'],
    },
  },
  {
    name: 'update_block',
    description:
      'Remplace le texte d\'un bloc existant identifié par son block_id. Le type/niveau ne change pas.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        block_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['doc_id', 'block_id', 'text'],
    },
  },
  {
    name: 'delete_block',
    description: 'Supprime un bloc identifié par son block_id.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        block_id: { type: 'string' },
      },
      required: ['doc_id', 'block_id'],
    },
  },
  {
    name: 'get_document_metadata',
    description:
      'Récupère les métadonnées d\'un document (titre, dates, link_reach, link_role) sans charger son contenu.',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string', format: 'uuid' } },
      required: ['doc_id'],
    },
  },
];

// 5. Création du serveur MCP.
// / MCP server creation.
const mcpServer = new Server(
  { name: 'lasuite-docs-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Handler pour `tools/list`.
// / Handler for `tools/list`.
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitionList,
}));

// Handler pour `tools/call`. Route vers la bonne fonction selon le nom.
// / Handler for `tools/call`. Routes to the right function by tool name.
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawToolArguments = request.params.arguments ?? {};

  try {
    if (toolName === 'list_documents') {
      const publicDocumentList = await docsRestClient.listPublicDocuments();
      return formatToolSuccess(publicDocumentList);
    }

    if (toolName === 'read_document') {
      const validatedInput = readDocumentInputSchema.parse(rawToolArguments);
      // Vérifie que le doc est public avant de tenter la connexion WS.
      // / Check the doc is public before opening a WS connection.
      const documentMetadata = await docsRestClient.fetchDocumentMetadata(
        validatedInput.doc_id,
      );
      const blockList = await sessionManager.readDocument(
        validatedInput.doc_id,
      );
      return formatToolSuccess({
        id: validatedInput.doc_id,
        title: documentMetadata.title,
        blocks: blockList,
      });
    }

    if (toolName === 'insert_block') {
      const validatedInput = insertBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      const newBlockIdentifier = await sessionManager.insertBlock(
        validatedInput.doc_id,
        validatedInput.content,
        validatedInput.after_block_id ?? null,
      );
      return formatToolSuccess({ block_id: newBlockIdentifier });
    }

    if (toolName === 'update_block') {
      const validatedInput = updateBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      await sessionManager.updateBlockText(
        validatedInput.doc_id,
        validatedInput.block_id,
        validatedInput.text,
      );
      return formatToolSuccess({ ok: true });
    }

    if (toolName === 'delete_block') {
      const validatedInput = deleteBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      await sessionManager.deleteBlock(
        validatedInput.doc_id,
        validatedInput.block_id,
      );
      return formatToolSuccess({ ok: true });
    }

    if (toolName === 'get_document_metadata') {
      const validatedInput = readDocumentInputSchema.parse(rawToolArguments);
      const documentMetadata = await docsRestClient.fetchDocumentMetadata(
        validatedInput.doc_id,
      );
      return formatToolSuccess(documentMetadata);
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (caughtError) {
    return formatToolError(caughtError);
  }
});

/**
 * Formate un résultat de tool MCP en succès JSON.
 * / Formats an MCP tool success as JSON.
 */
function formatToolSuccess(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Formate une erreur de tool MCP. Distingue DocsError (codes métier) des
 * erreurs techniques.
 * / Formats an MCP tool error. Distinguishes DocsError from technical errors.
 */
function formatToolError(caughtError: unknown) {
  if (caughtError instanceof DocsError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ code: caughtError.code, message: caughtError.message }),
        },
      ],
    };
  }
  if (caughtError instanceof z.ZodError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            code: 'INVALID_INPUT',
            message: caughtError.message,
            issues: caughtError.issues,
          }),
        },
      ],
    };
  }
  const errorMessage =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ code: 'INTERNAL_ERROR', message: errorMessage }),
      },
    ],
  };
}

// 6. Démarrage du transport stdio.
// / Start stdio transport.
const stdioTransport = new StdioServerTransport();
await mcpServer.connect(stdioTransport);

// Shutdown propre sur SIGINT/SIGTERM.
// / Clean shutdown on SIGINT/SIGTERM.
process.on('SIGINT', () => {
  sessionManager.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  sessionManager.shutdown();
  process.exit(0);
});
