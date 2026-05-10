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
    sessionManager = new SessionManager(
      origin,
      sessionTtlMs,
      syncTimeoutMs,
      credentialsStore,
      docsRestClient,
    );
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

// Borne haute pour image_data_base64. base64 multiplie la taille par ~1.33,
// donc 10 Mo de base64 ≈ 7.5 Mo binaire — confortable pour un schéma ou
// une capture, et raisonnable pour passer dans un message MCP. Au-delà,
// l'agent doit redimensionner ou demander à l'utilisateur d'uploader
// directement via le navigateur.
// / Cap on image_data_base64 size. 10 MB base64 ≈ 7.5 MB binary.
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

const insertImageInputSchema = z.intersection(
  documentReferenceSchema,
  z.object({
    image_data_base64: z
      .string()
      .min(1, 'image_data_base64 ne peut pas être vide')
      .max(
        MAX_IMAGE_BASE64_BYTES,
        `image_data_base64 dépasse la limite de ${MAX_IMAGE_BASE64_BYTES} caractères (~7.5 Mo binaire). Redimensionne l'image avant upload.`,
      ),
    file_name: z.string().min(1),
    mime_type: z.string().optional(),
    caption: z.string().optional(),
    after_block_id: z.string().nullable().optional(),
  }),
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
  {
    name: 'insert_block',
    description: 'Insère un nouveau bloc (paragraph ou heading) dans un document. Le champ `content.text` accepte du **markdown inline** : **gras**, *italique*, `code inline`, ~~barré~~, [texte](url). Si `after_block_id` est fourni, insertion juste après ce bloc ; sinon, insertion en tête du document. Référence du document : doc_id (UUID nu) OU doc_url (URL complète comme https://notes.liiib.re/docs/<UUID>/). PERSISTANCE : en mode authentifié (set_session_credentials posé), l\'écriture est garantie via PATCH /content/. En mode anonyme, la persistance n\'est PAS garantie — il faut que l\'utilisateur ait l\'onglet ouvert dans son navigateur (la réponse contiendra alors un champ `warning` à transmettre à l\'utilisateur).',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid', description: 'UUID du document. Alternative à doc_url.' },
        doc_url: { type: 'string', description: 'URL complète du document (https://<instance>/docs/<UUID>/). Alternative à doc_id ; settle aussi l\'instance MCP si pas encore settled.' },
        content: {
          description: 'Contenu du nouveau bloc. Discriminé par `type` : "paragraph" ou "heading".',
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'paragraph', description: 'Bloc paragraphe.' },
                text: { type: 'string', description: 'Texte du paragraphe. Markdown inline supporté (**gras**, *italique*, [lien](url), `code`, ~~barré~~).' },
              },
              required: ['type', 'text'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'heading', description: 'Bloc titre (h1/h2/h3).' },
                level: { type: 'integer', enum: [1, 2, 3], description: 'Niveau du heading. 1 = h1, 2 = h2, 3 = h3.' },
                text: { type: 'string', description: 'Texte du titre. Markdown inline supporté.' },
              },
              required: ['type', 'level', 'text'],
              additionalProperties: false,
            },
          ],
        },
        after_block_id: {
          type: ['string', 'null'],
          description: 'UUID d\'un bloc existant après lequel insérer le nouveau. Si null/absent, insertion en tête du document.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_block',
    description: 'Remplace le contenu textuel d\'un bloc existant. Le texte est interprété comme du **markdown inline** (mêmes marqueurs que insert_block). Le type/niveau du bloc ne change pas — pour changer le type, fais delete_block puis insert_block. PERSISTANCE : voir insert_block (idem — garantie en mode authentifié, best-effort en mode anonyme avec navigateur humain ouvert).',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        doc_url: { type: 'string' },
        block_id: { type: 'string', description: 'UUID du bloc à modifier (récupéré via read_document ou retourné par insert_block).' },
        text: { type: 'string', description: 'Nouveau texte du bloc. Markdown inline supporté (**gras**, *italique*, [lien](url), `code`, ~~barré~~).' },
      },
      required: ['block_id', 'text'],
    },
  },
  {
    name: 'delete_block',
    description: 'Supprime un bloc d\'un document. PERSISTANCE : voir insert_block (garantie en mode authentifié, best-effort en mode anonyme avec navigateur humain ouvert).',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        doc_url: { type: 'string' },
        block_id: { type: 'string', description: 'UUID du bloc à supprimer.' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'insert_image',
    description: 'Upload une image et l\'insère comme bloc image dans le document. L\'image est fournie en base64 via `image_data_base64` (limite raisonnable ~5 Mo de base64). Le MCP fait un POST multipart vers /api/v1.0/documents/{id}/attachment-upload/ puis insère un bloc image BlockNote pointant vers l\'URL retournée. PERSISTANCE : comme insert_block (garantie en mode authentifié, best-effort en anonyme). PERMISSIONS : exige `attachment_upload` (équivalent `can_update`) côté Docs.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        doc_url: { type: 'string' },
        image_data_base64: {
          type: 'string',
          description: 'Contenu binaire de l\'image encodé en base64 (sans préfixe data:). Formats supportés : ce que Docs accepte (PNG, JPEG, GIF, WebP, SVG typiquement).',
        },
        file_name: {
          type: 'string',
          description: 'Nom de fichier (avec extension) — utilisé pour la propriété `name` du bloc image et conservé côté storage. Ex: "diagramme.png".',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type de l\'image (ex: "image/png"). Optionnel : si absent, déduit de l\'extension de file_name.',
        },
        caption: {
          type: 'string',
          description: 'Légende sous l\'image (optionnel).',
        },
        after_block_id: {
          type: ['string', 'null'],
          description: 'UUID d\'un bloc existant après lequel insérer l\'image. Si null/absent, insertion en tête.',
        },
      },
      required: ['image_data_base64', 'file_name'],
    },
  },
  // v0.2 auth
  {
    name: 'set_session_credentials',
    description: 'Enregistre les cookies de session Docs en mémoire (docs_sessionid + csrftoken). Récupération : DevTools du navigateur connecté à l\'instance (F12 → Application/Stockage → Cookies → URL de l\'instance) → copier les valeurs des cookies `docs_sessionid` et `csrftoken`. Le couple expire ~12h après login. Optionnel : `instance_url` pour settle l\'instance MCP simultanément. Stockage en mémoire uniquement (jamais sur disque, jamais dans les outputs).',
    inputSchema: {
      type: 'object',
      properties: {
        docs_sessionid: { type: 'string', description: 'Valeur du cookie docs_sessionid (Django session).' },
        csrftoken: { type: 'string', description: 'Valeur du cookie csrftoken (Django CSRF).' },
        instance_url: { type: 'string', description: 'URL de l\'instance Docs (ex: https://notes.liiib.re). Optionnel.' },
      },
      required: ['docs_sessionid', 'csrftoken'],
    },
  },
  { name: 'clear_session_credentials', description: 'Vide les credentials. Conserve l\'instance settled.', inputSchema: { type: 'object', properties: {} } },
  // v0.2 écriture
  {
    name: 'create_document',
    description: 'Crée un nouveau document. Si `parent_id` est fourni, le doc est créé en tant que sous-document de ce parent (l\'utilisateur connecté doit avoir `can_update` sur le parent) ; sinon, doc top-level. Nécessite des credentials valides.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titre du nouveau document.' },
        parent_id: {
          type: ['string', 'null'],
          description: 'UUID du document parent. Si null/absent, doc top-level.',
        },
      },
      required: ['title'],
    },
  },
  { name: 'delete_document', description: 'Supprime un document (cascade sur les sous-docs).', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' } } } },
  {
    name: 'move_document',
    description: 'Déplace un document dans l\'arborescence. Position relative à `target_parent_id` : "first-child"/"last-child" pour devenir enfant, "left"/"right" pour devenir frère.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        doc_url: { type: 'string' },
        target_parent_id: { type: 'string', format: 'uuid', description: 'UUID du document de référence pour la position.' },
        position: {
          type: 'string',
          enum: ['first-child', 'last-child', 'left', 'right'],
          description: 'first-child = premier enfant de target. last-child = dernier enfant. left = frère placé juste avant target. right = frère placé juste après target.',
        },
      },
      required: ['target_parent_id', 'position'],
    },
  },
  { name: 'duplicate_document', description: 'Duplique un document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, with_accesses: { type: 'boolean' } } } },
  { name: 'update_document_title', description: 'Renomme un document.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, title: { type: 'string' } }, required: ['title'] } },
  { name: 'list_my_documents', description: 'Liste les documents accessibles à l\'utilisateur connecté (incluant les privés).', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, page_size: { type: 'integer' } } } },
  // v0.2.1 lecture d'arborescence
  { name: 'list_document_children', description: 'Liste les enfants directs d\'un document (1 niveau).', inputSchema: { type: 'object', properties: { doc_id: { type: 'string', format: 'uuid' }, doc_url: { type: 'string' } } } },
  { name: 'list_document_descendants', description: 'Liste tous les descendants d\'un document à plat (récursif jusqu\'à max_depth, défaut 5). Si aucun parent fourni, retourne tous les docs accessibles à l\'utilisateur connecté + leurs descendants.', inputSchema: { type: 'object', properties: { doc_id: { type: 'string', format: 'uuid' }, doc_url: { type: 'string' }, max_depth: { type: 'integer', minimum: 1, maximum: 10 } } } },
];

// -------- Création du serveur MCP

/**
 * Mode d'emploi global injecté dans le system prompt de l'agent au démarrage.
 * Le client MCP (Claude Desktop, Claude Code) lit ce texte une fois à
 * `initialize` et le réutilise à chaque turn — donc il est mis en cache
 * côté agent. Important pour éviter les pièges connus du protocole Docs.
 * / Global instructions injected into the agent's system prompt at MCP
 * / initialize. Cached by the client and visible to the agent at every
 * / turn — used to prevent known protocol pitfalls.
 */
const MCP_INSTRUCTIONS = `# lasuite-docs-mcp — mode d'emploi

Ce serveur expose 17 tools pour lire et éditer des documents la-suite Docs (instances type notes.numerique.gouv.fr, notes.liiib.re, etc.). Édition fine au niveau du paragraphe, upload d'images, et co-édition temps réel avec les éditeurs humains.

## Workflows clés

**Lecture/édition d'un doc public** : pas besoin de credentials. L'utilisateur te donne un lien type \`https://<instance>/docs/<UUID>/\`, tu peux directement appeler read_document, insert_block, etc.

**Édition authentifiée (recommandée)** : appelle \`set_session_credentials\` AVANT les opérations qui exigent une vraie identité Django (create_document, delete_document, move_document, duplicate_document, update_document_title, list_my_documents). Le tool ping \`/api/v1.0/users/me/\` immédiatement et te retourne l'identité reconnue par le serveur — vérifie que le \`user.email\` retourné correspond bien à l'utilisateur attendu.

## ⚠️ Piège critique : "auth muet" via lien public

Beaucoup de docs Docs sont en \`computed_link_reach: public\` avec \`computed_link_role: editor\`. Tout le monde peut les lire et les éditer SANS authentification.

→ Si tu vois \`read_document\`, \`insert_block\`, \`update_block\`, \`delete_block\` réussir avec des cookies invalides ou absents, ce N'EST PAS la preuve que tes cookies sont valides. Seules les opérations REST authentifiées (création/suppression/déplacement de docs) révèlent l'absence d'authentification.

→ Pour être sûr d'être authentifié : utilise \`set_session_credentials\` qui ping \`/users/me/\` immédiatement, ou tente \`create_document\`.

## ⚠️ Piège critique : persistance des écritures en mode anonyme

Le serveur Hocuspocus de Docs n'a AUCUN mécanisme de persistance automatique. La persistance vers le snapshot REST (champ \`content\`) est faite par le client navigateur (frontend BlockNote, save loop toutes les 60s).

- **En mode authentifié** (cookies posés) : le MCP fait un \`PATCH /api/v1.0/documents/{id}/\` avec le state Yjs encodé après chaque write → persistance garantie côté serveur.
- **En mode anonyme** : le PATCH est refusé par Django → aucune persistance directe possible. Si AUCUN humain n'a le doc ouvert dans son navigateur au moment du write, le serveur peut décharger le doc de sa mémoire avant qu'aucun snapshot ne soit fait → l'écriture est perdue.

→ En mode anonyme, la sortie de chaque write contient un champ \`warning\` qui rappelle à l'utilisateur de garder l'onglet ouvert. **Transmets ce warning à l'utilisateur final.**

## Codes d'erreur

- \`AUTH_REQUIRED\` : pose des cookies via set_session_credentials (le tool ping /users/me/ pour les valider immédiatement)
- \`PERMISSION_DENIED\` : tes cookies sont valides, mais l'opération est refusée par les permissions Django sur ce doc précis. Le message inclut souvent le \`detail\` Django avec la raison exacte
- \`DOC_READONLY\` : l'utilisateur connecté n'a pas le droit d'éditer ce doc
- \`DOC_NOT_FOUND\` / \`BLOCK_NOT_FOUND\` : ID invalide ou doc/bloc supprimé
- \`INSTANCE_NOT_SET\` : passe-moi un \`doc_url\` complet (https://<instance>/docs/<UUID>/) pour settle l'instance, ou définir DOCS_INSTANCE_URL côté config
- \`INSTANCE_MISMATCH\` : tu cibles un autre serveur que celui actuellement settled — appelle clear_session_credentials d'abord

## Images

Le tool \`insert_image\` upload une image (en base64) vers le storage S3 du document, puis insère un bloc image BlockNote pointant vers l'URL retournée. Formats : PNG, JPEG, GIF, WebP, SVG. Taille raisonnable (~5 Mo de base64). Les images sont scannées par antivirus côté serveur — l'URL retournée est d'abord une URL de polling \`media-check\`, qui est automatiquement remplacée par l'URL S3 finale par BlockNote quand le scan termine. Tu peux donc utiliser l'URL tout de suite sans attendre.

## Markdown inline supporté

Les paramètres \`text\` de \`insert_block\` et \`update_block\` sont interprétés comme du **markdown inline** :
- \`**gras**\`, \`*italique*\`, \`\`\`code\`\`\`, \`~~barré~~\`, \`[texte](url)\`
- \`read_document\` retourne le contenu en markdown : tu peux lire un bloc, modifier la chaîne, la réinjecter via update_block sans perte (round-trip propre).

## Co-édition live

Tu partages le même Y.Doc CRDT temps réel que les humains connectés au même doc dans leur navigateur :
- Tes \`insert_block\` apparaissent **instantanément** dans le navigateur de l'utilisateur connecté.
- Les frappes humaines sont visibles au prochain \`read_document\` de ta part.
- Conflits gérés automatiquement par le CRDT — pas d'écrasement.

→ Cas d'usage typique : « rédige la section X pendant que je tape la section Y » sur le même doc.
`;

const mcpServer = new Server(
  { name: 'lasuite-docs-mcp', version: '0.5.0' },
  { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
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
        return formatToolSuccess(withAnonymousPersistenceWarning({ block_id: blockId }));
      }
      case 'update_block': {
        const input = updateBlockInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertPublicEditor(docId);
        await getSessionManager().updateBlockText(docId, input.block_id, input.text);
        return formatToolSuccess(withAnonymousPersistenceWarning({ ok: true }));
      }
      case 'delete_block': {
        const input = deleteBlockInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertPublicEditor(docId);
        await getSessionManager().deleteBlock(docId, input.block_id);
        return formatToolSuccess(withAnonymousPersistenceWarning({ ok: true }));
      }
      case 'insert_image': {
        // Tool insert_image — upload + insertion d'un bloc image.
        // / Tool insert_image — upload + image block insertion.
        //
        // LOCALISATION : src/server.ts (case 'insert_image')
        //
        // FLUX :
        // 1. Valide l'input (zod). Borne haute MAX_IMAGE_BASE64_BYTES.
        // 2. Résout doc_id ou doc_url (settle l'instance si besoin).
        // 3. Vérifie l'accès en édition via assertEditAccess (REST).
        // 4. Décode le base64 en buffer binaire.
        // 5. Devine le MIME type si non fourni (extension du file_name).
        // 6. Upload via DocsRestClient.uploadAttachment (POST multipart) →
        //    URL absolue media-check (polling antivirus).
        // 7. Insert le bloc image dans le Y.Doc via SessionManager.
        //    insertImageBlock — qui fait awaitFlush + PATCH /content/.
        // 8. Retourne {block_id, image_url}, plus warning si anonyme.
        //
        // COMMUNICATION :
        // Reçoit : appel MCP de l'agent avec image en base64.
        // Émet :
        //   - REST : POST /api/v1.0/documents/{id}/attachment-upload/
        //   - REST : PATCH /api/v1.0/documents/{id}/ (persistance content)
        //   - WS Yjs : update du Y.Doc collaboratif (visible chez les
        //     éditeurs humains connectés en temps réel).
        const input = insertImageInputSchema.parse(rawArgs);
        const docId = resolveDocumentReference(input);
        await docsRestClient.assertEditAccess(docId);

        // Décode le base64 reçu de l'agent en buffer binaire avant
        // l'upload multipart. Si le base64 est invalide, Buffer.from
        // produit un buffer tronqué silencieusement — on accepte ce
        // comportement (le serveur Docs validera côté antivirus/format
        // et renverra une erreur HTTP qu'on remontera à l'agent).
        // / Decode base64 from agent input. Invalid base64 → truncated
        // / buffer silently — Docs server validates and returns an error.
        const fileBuffer = Buffer.from(input.image_data_base64, 'base64');
        const inferredMimeType =
          input.mime_type ?? guessMimeTypeFromFileName(input.file_name);

        const imageUrl = await docsRestClient.uploadAttachment(
          docId,
          fileBuffer,
          input.file_name,
          inferredMimeType,
        );

        const blockId = await getSessionManager().insertImageBlock(
          docId,
          {
            url: imageUrl,
            name: input.file_name,
            caption: input.caption,
          },
          input.after_block_id ?? null,
        );

        return formatToolSuccess(
          withAnonymousPersistenceWarning({
            block_id: blockId,
            image_url: imageUrl,
          }),
        );
      }
      case 'set_session_credentials': {
        const input = setSessionCredentialsInputSchema.parse(rawArgs);
        if (input.instance_url) {
          const incomingOrigin = new URL(input.instance_url).origin;
          if (instanceStore.has() && instanceStore.get() !== incomingOrigin) {
            // Switch volontaire d'instance : on ferme proprement le
            // SessionManager existant (pour ne pas laisser de WebSocket
            // ouverte sur l'ancienne instance) puis on le remet à null.
            // Il sera re-créé avec la nouvelle URL au prochain accès.
            // / Voluntary instance switch: shutdown old SessionManager
            // / before clearing, so its WebSockets don't leak.
            sessionManager?.shutdown();
            sessionManager = null;
          }
          instanceStore.set(input.instance_url);
        }
        credentialsStore.set({
          docs_sessionid: input.docs_sessionid,
          csrftoken: input.csrftoken,
        });
        // Vérifie immédiatement que ces cookies ouvrent bien une session
        // côté serveur Django via GET /users/me/. Sans ce check, des
        // cookies morts passent inaperçus tant que l'agent ne tente pas
        // une op REST authentifiée — parce que la lecture/écriture sur
        // les docs en lien public marche en anonyme. Ce check transforme
        // un fail-silencieux différé en feedback immédiat.
        // / Verify cookies open a real Django session right now via
        // / /users/me/. Otherwise dead cookies pass undetected because
        // / public-link docs accept anonymous reads/writes.
        let authenticatedUser: Record<string, unknown>;
        try {
          authenticatedUser = await docsRestClient.verifyAuthenticatedUser();
        } catch (verifyError) {
          // Vérification échouée : on remet l'état à zéro pour que l'agent
          // sache qu'il n'est pas authentifié. On ne touche PAS à
          // instanceStore (l'agent peut vouloir retenter avec d'autres
          // cookies sur la même instance).
          // / Verification failed: clear creds so the agent's view of state
          // / matches reality. Keep instanceStore (agent may retry).
          credentialsStore.clear();
          throw verifyError;
        }
        // Vérification OK. On purge maintenant les WebSocket ouvertes :
        // le cookie de session est calculé UNIQUEMENT au handshake WS,
        // donc une WS déjà ouverte (potentiellement anonyme) continuerait
        // à utiliser l'ancien cookie. Le prochain appel re-créera la WS
        // avec les nouveaux cookies validés.
        // / Cookie is only sent on WS handshake. Reset cache so the next
        // / call rebuilds the WS with the validated cookie.
        sessionManager?.shutdown();
        sessionManager = null;
        return formatToolSuccess({ ok: true, user: authenticatedUser });
      }
      case 'clear_session_credentials': {
        credentialsStore.clear();
        // Mêmes raisons que set_session_credentials : on ne veut pas
        // qu'une WS authentifiée reste cachée alors que le user a
        // explicitement demandé de revenir en mode anonyme.
        // / Same reasoning as set_session_credentials: don't keep
        // / authenticated WS cached after user requested anonymous.
        sessionManager?.shutdown();
        sessionManager = null;
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

/**
 * Si la session MCP est anonyme (pas de cookies posés), enrichit la
 * réponse d'un write avec un avertissement clair : la persistance n'est
 * pas garantie — le serveur Hocuspocus de Docs n'a aucun mécanisme de
 * persistance automatique, et le snapshot REST n'est mis à jour que
 * quand un client navigateur (humain) déclenche son save loop. Si
 * personne n'a le doc ouvert dans son navigateur au moment où l'agent
 * écrit, le serveur peut décharger le doc de sa mémoire avant qu'aucun
 * snapshot n'ait été persisté → l'écriture est perdue.
 * / If the MCP session is anonymous, attaches a clear warning to write
 * / responses: persistence is not guaranteed — Docs' Hocuspocus has no
 * / automatic persistence, the REST snapshot only updates when a browser
 * / client runs its save loop. Anonymous writes are best-effort.
 *
 * En mode authentifié, le SessionManager appelle PATCH /content/ après
 * chaque write — la persistence est alors garantie côté serveur.
 * / In authenticated mode, SessionManager PATCHes /content/ after each
 * / write — persistence is then guaranteed server-side.
 */
/**
 * Devine le MIME type d'une image à partir de l'extension du nom de
 * fichier. Volontairement minimaliste — on couvre les formats que les
 * agents utiliseront en pratique (PNG, JPEG, GIF, WebP, SVG). Pour les
 * cas exotiques, l'agent peut passer mime_type explicitement.
 * / Minimal MIME type guesser from filename extension. Agent can override
 * / via explicit mime_type for exotic formats.
 */
function guessMimeTypeFromFileName(fileName: string): string {
  const lowerCaseName = fileName.toLowerCase();
  if (lowerCaseName.endsWith('.png')) return 'image/png';
  if (lowerCaseName.endsWith('.jpg') || lowerCaseName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerCaseName.endsWith('.gif')) return 'image/gif';
  if (lowerCaseName.endsWith('.webp')) return 'image/webp';
  if (lowerCaseName.endsWith('.svg')) return 'image/svg+xml';
  // Fallback générique. Le serveur Docs validera de toute façon.
  // / Generic fallback. Docs server validates anyway.
  return 'application/octet-stream';
}

function withAnonymousPersistenceWarning<T extends object>(
  payload: T,
): T | T & { warning: string } {
  if (credentialsStore.has()) {
    return payload;
  }
  return {
    ...payload,
    warning:
      "⚠️ Mode anonyme : pour que cette modification soit persistée durablement, l'utilisateur doit garder l'onglet du document ouvert dans son navigateur (le frontend humain déclenche le save toutes les 60s). Sinon, le serveur Hocuspocus peut perdre l'écriture en déchargeant le doc de sa mémoire — le prochain visiteur verra l'ancien contenu. Pour une persistance garantie sans dépendance au navigateur humain, demande à l'utilisateur de poser ses cookies via set_session_credentials : le MCP fera alors un PATCH /content/ après chaque écriture.",
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
