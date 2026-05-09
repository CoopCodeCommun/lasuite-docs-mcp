#!/usr/bin/env node
/**
 * Serveur MCP `lasuite-docs-mcp` — point d'entrée stdio.
 * / MCP server `lasuite-docs-mcp` — stdio entrypoint.
 *
 * LOCALISATION : src/server.ts
 *
 * v0.2 : ajoute 8 tools (auth + écriture), 2 stores (Credentials + Instance),
 * et la détection dynamique de l'instance depuis les liens doc_url.
 *
 * COMMUNICATION :
 * stdin/stdout : protocole MCP avec le client
 * Délègue à : SessionManager (Yjs), DocsRestClient (REST), CredentialsStore + InstanceStore (auth/instance)
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
import { CredentialsStore } from './auth/credentials.js';
import { InstanceStore, parseDocsUrl } from './auth/instance.js';
import { DocsError } from './types.js';
import type { DocumentId } from './types.js';

// -------- Configuration depuis l'environnement
const sessionTtlMs = Number(process.env.DOCS_SESSION_TTL_MS ?? '300000');
const syncTimeoutMs = Number(process.env.DOCS_SYNC_TIMEOUT_MS ?? '10000');

// -------- Stores partagés
const credentialsStore = new CredentialsStore();
const instanceStore = InstanceStore.fromEnv(process.env);

// SessionManager nécessite une URL au démarrage. v0.2 : on le re-construit
// paresseusement à la première utilisation, une fois que l'instance est settled.
// / SessionManager needs a URL up front. v0.2: lazy-build it on first use.
let sessionManager: SessionManager | null = null;
function getSessionManager(): SessionManager {
  if (sessionManager === null) {
    const origin = instanceStore.get();
    if (origin === null) {
      throw new DocsError(
        'INSTANCE_NOT_SET',
        "Aucune instance Docs n'est configurée. Passe-moi un lien complet vers un document (ex: https://notes.liiib.re/docs/<UUID>/).",
      );
    }
    sessionManager = new SessionManager(origin, sessionTtlMs, syncTimeoutMs, credentialsStore);
  }
  return sessionManager;
}

const docsRestClient = new DocsRestClient(instanceStore, credentialsStore);

// -------- Schemas zod
const documentIdentifierSchema = z.string().uuid('doc_id must be a valid UUID v4');

// Référence à un document : doc_id (UUID nu) OR doc_url (URL complète)
// / Document reference: either doc_id (raw UUID) or doc_url (full URL)
const documentReferenceSchema = z.union([
  z.object({ doc_id: documentIdentifierSchema }),
  z.object({ doc_url: z.string().url() }),
]);

const blockContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1),
  }),
]);

const setSessionCredentialsInputSchema = z.object({
  docs_sessionid: z.string().min(1),
  csrftoken: z.string().min(1),
  instance_url: z.string().url().optional(),
});

const createDocumentInputSchema = z.object({
  title: z.string().min(1),
  parent_id: documentIdentifierSchema.nullable().optional(),
});

const moveDocumentInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({
    target_parent_id: documentIdentifierSchema,
    position: z.enum(['first-child', 'last-child', 'left', 'right']),
  }),
);

const duplicateDocumentInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({ with_accesses: z.boolean().optional() }),
);

const updateDocumentTitleInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({ title: z.string().min(1) }),
);

const listMyDocumentsInputSchema = z.object({
  page: z.number().int().positive().optional(),
  page_size: z.number().int().positive().max(100).optional(),
});

// list_document_descendants : parent optionnel (si absent → tous les docs du user)
// + max_depth optionnel pour borner la récursion.
// / list_document_descendants: optional parent + optional max_depth.
const listDocumentDescendantsInputSchema = z.union([
  z.object({}).strict(),
  z.intersection(
    documentReferenceSchema,
    z.object({ max_depth: z.number().int().positive().max(10).optional() }),
  ),
]);

const insertBlockInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({
    content: blockContentSchema,
    after_block_id: z.string().nullable().optional(),
  }),
);

const updateBlockInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({
    block_id: z.string(),
    text: z.string().min(1),
  }),
);

const deleteBlockInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({ block_id: z.string() }),
);

// -------- Helper : extraire (docId, settle instance si doc_url)
function resolveDocumentReference(
  ref: { doc_id: string } | { doc_url: string },
): DocumentId {
  if ('doc_url' in ref) {
    const parsed = parseDocsUrl(ref.doc_url);
    if (instanceStore.has() && instanceStore.get() !== parsed.origin) {
      throw new DocsError(
        'INSTANCE_MISMATCH',
        `Tu m'as donné un lien vers ${parsed.origin}, mais je suis actuellement connecté à ${instanceStore.get()}. Pour switcher, appelle clear_session_credentials puis recommence.`,
      );
    }
    if (!instanceStore.has()) {
      instanceStore.set(parsed.origin);
    }
    return parsed.docId;
  }
  return ref.doc_id;
}

// -------- Définition des tools
const toolDefinitionList = [
  // v0.1 lecture
  { name: 'list_documents', description: 'Liste les documents publics accessibles. Nécessite une instance settled.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'read_document', description: 'Lit la liste structurée des blocs d\'un document. Accepte doc_id ou doc_url.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string', format: 'uuid' }, doc_url: { type: 'string' } } } },
  { name: 'get_document_metadata', description: 'Métadonnées d\'un document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' } } } },
  // v0.1 édition contenu
  { name: 'insert_block', description: 'Insère un nouveau bloc dans le document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, content: { type: 'object' }, after_block_id: { type: ['string', 'null'] } }, required: ['content'] } },
  { name: 'update_block', description: 'Remplace le texte d\'un bloc.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, block_id: { type: 'string' }, text: { type: 'string' } }, required: ['block_id', 'text'] } },
  { name: 'delete_block', description: 'Supprime un bloc.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, block_id: { type: 'string' } }, required: ['block_id'] } },
  // v0.2 auth
  { name: 'set_session_credentials', description: 'Enregistre les cookies de session Docs en mémoire (docs_sessionid + csrftoken). Optionnel : instance_url pour settler l\'instance simultanément.', inputSchema: { type: 'object', properties: { docs_sessionid: { type: 'string' }, csrftoken: { type: 'string' }, instance_url: { type: 'string' } }, required: ['docs_sessionid', 'csrftoken'] } },
  { name: 'clear_session_credentials', description: 'Vide les credentials. Conserve l\'instance settled.', inputSchema: { type: 'object', properties: {} } },
  // v0.2 écriture
  { name: 'create_document', description: 'Crée un document. Si parent_id est fourni, c\'est un sous-doc ; sinon, top-level.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, parent_id: { type: ['string', 'null'] } }, required: ['title'] } },
  { name: 'delete_document', description: 'Supprime un document (cascade sur les sous-docs).', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' } } } },
  { name: 'move_document', description: 'Déplace un document dans l\'arborescence.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, target_parent_id: { type: 'string' }, position: { type: 'string', enum: ['first-child', 'last-child', 'left', 'right'] } }, required: ['target_parent_id', 'position'] } },
  { name: 'duplicate_document', description: 'Duplique un document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, with_accesses: { type: 'boolean' } } } },
  { name: 'update_document_title', description: 'Renomme un document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, title: { type: 'string' } }, required: ['title'] } },
  { name: 'list_my_documents', description: 'Liste les documents accessibles à l\'utilisateur connecté (incluant les privés).', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, page_size: { type: 'integer' } } } },
  // v0.2.1 lecture d'arborescence
  { name: 'list_document_children', description: 'Liste les enfants directs d\'un document (1 niveau).', inputSchema: { type: 'object', properties: { doc_id: { type: 'string', format: 'uuid' }, doc_url: { type: 'string' } } } },
  { name: 'list_document_descendants', description: 'Liste tous les descendants d\'un document à plat (récursif jusqu\'à max_depth, défaut 5). Si aucun parent fourni, retourne tous les docs accessibles à l\'utilisateur connecté + leurs descendants.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string', format: 'uuid' }, doc_url: { type: 'string' }, max_depth: { type: 'integer', minimum: 1, maximum: 10 } } } },
];

// -------- Création du serveur MCP
const mcpServer = new Server(
  { name: 'lasuite-docs-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitionList,
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = request.params.arguments ?? {};

  try {
    switch (toolName) {
      case 'list_documents': {
        const docs = await docsRestClient.listPublicDocuments();
        return formatToolSuccess(docs);
      }
      case 'read_document': {
        const ref = documentReferenceSchema.parse(rawArgs);
        const docId = resolveDocumentReference(ref);
        const meta = await docsRestClient.fetchDocumentMetadata(docId);
        const blocks = await getSessionManager().readDocument(docId);
        return formatToolSuccess({ id: docId, title: meta.title, blocks });
      }
      case 'get_document_metadata': {
        const ref = documentReferenceSchema.parse(rawArgs);
        const docId = resolveDocumentReference(ref);
        const meta = await docsRestClient.fetchDocumentMetadata(docId);
        return formatToolSuccess(meta);
      }
      case 'insert_block': {
        const input = insertBlockInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertPublicEditor(docId);
        const blockId = await getSessionManager().insertBlock(
          docId,
          input.content,
          input.after_block_id ?? null,
        );
        return formatToolSuccess({ block_id: blockId });
      }
      case 'update_block': {
        const input = updateBlockInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertPublicEditor(docId);
        await getSessionManager().updateBlockText(docId, input.block_id, input.text);
        return formatToolSuccess({ ok: true });
      }
      case 'delete_block': {
        const input = deleteBlockInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertPublicEditor(docId);
        await getSessionManager().deleteBlock(docId, input.block_id);
        return formatToolSuccess({ ok: true });
      }
      case 'set_session_credentials': {
        const input = setSessionCredentialsInputSchema.parse(rawArgs);
        if (input.instance_url) {
          const incomingOrigin = new URL(input.instance_url).origin;
          if (instanceStore.has() && instanceStore.get() !== incomingOrigin) {
            // Switch volontaire d'instance : on clear le SessionManager pour
            // qu'il soit re-créé avec la nouvelle URL au prochain accès.
            // / Voluntary instance switch: clear SessionManager too.
            sessionManager = null;
          }
          instanceStore.set(input.instance_url);
        }
        credentialsStore.set({
          docs_sessionid: input.docs_sessionid,
          csrftoken: input.csrftoken,
        });
        return formatToolSuccess({ ok: true });
      }
      case 'clear_session_credentials': {
        credentialsStore.clear();
        return formatToolSuccess({ ok: true });
      }
      case 'create_document': {
        const input = createDocumentInputSchema.parse(rawArgs);
        const result = await docsRestClient.createDocument(input.title, input.parent_id ?? null);
        return formatToolSuccess(result);
      }
      case 'delete_document': {
        const ref = documentReferenceSchema.parse(rawArgs);
        const docId = resolveDocumentReference(ref);
        await docsRestClient.deleteDocument(docId);
        return formatToolSuccess({ ok: true });
      }
      case 'move_document': {
        const input = moveDocumentInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.moveDocument(docId, input.target_parent_id, input.position);
        return formatToolSuccess({ ok: true });
      }
      case 'duplicate_document': {
        const input = duplicateDocumentInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        const result = await docsRestClient.duplicateDocument(docId, input.with_accesses ?? false);
        return formatToolSuccess(result);
      }
      case 'update_document_title': {
        const input = updateDocumentTitleInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.updateDocumentTitle(docId, input.title);
        return formatToolSuccess({ ok: true });
      }
      case 'list_document_children': {
        const ref = documentReferenceSchema.parse(rawArgs);
        const docId = resolveDocumentReference(ref);
        const children = await docsRestClient.listDocumentChildren(docId);
        return formatToolSuccess({ count: children.length, results: children });
      }
      case 'list_document_descendants': {
        const input = listDocumentDescendantsInputSchema.parse(rawArgs);
        // Parent optionnel : si pas de doc_id ni doc_url, on liste tout l'espace user.
        // / Optional parent: if neither doc_id nor doc_url, list whole user space.
        const hasParent = 'doc_id' in input || 'doc_url' in input;
        if (!hasParent) {
          const all = await docsRestClient.listDocumentDescendants(null, 1);
          return formatToolSuccess({ count: all.length, results: all });
        }
        const docId = resolveDocumentReference(
          input as { doc_id: string } | { doc_url: string },
        );
        const maxDepth = ('max_depth' in input ? input.max_depth : undefined) ?? 5;
        const descendants = await docsRestClient.listDocumentDescendants(docId, maxDepth);
        return formatToolSuccess({ count: descendants.length, results: descendants });
      }
      case 'list_my_documents': {
        const input = listMyDocumentsInputSchema.parse(rawArgs);
        const result = await docsRestClient.listMyDocuments(input.page ?? 1, input.page_size ?? 20);
        return formatToolSuccess(result);
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (caught) {
    return formatToolError(caught);
  }
});

function formatToolSuccess(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function formatToolError(caught: unknown) {
  if (caught instanceof DocsError) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ code: caught.code, message: caught.message }) }],
    };
  }
  if (caught instanceof z.ZodError) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ code: 'INVALID_INPUT', message: caught.message, issues: caught.issues }) }],
    };
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ code: 'INTERNAL_ERROR', message }) }],
  };
}

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

process.on('SIGINT', () => {
  if (sessionManager) sessionManager.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (sessionManager) sessionManager.shutdown();
  process.exit(0);
});
