/**
 * Types partagés entre les modules du serveur MCP.
 * / Shared types across MCP server modules.
 *
 * LOCALISATION : src/types.ts
 *
 * Centralise les contrats de données pour éviter les duplications et
 * garantir la cohérence entre server.ts, session.ts, blocks.ts et client.ts.
 *
 * COMMUNICATION :
 * Importé par : server.ts, session.ts, blocks.ts, client.ts
 */

// Identifiant d'un document Docs (UUID v4 string).
// / Document identifier (UUID v4 string).
export type DocumentId = string;

// Identifiant d'un blockContainer BlockNote dans le doc Yjs (UUID v4 string).
// / BlockContainer identifier (UUID v4 string).
export type BlockId = string;

// Bloc tel qu'exposé à l'agent via les tools MCP.
// / Block as exposed to the agent through MCP tools.
export type Block =
  | { id: BlockId; type: 'paragraph'; text: string }
  | { id: BlockId; type: 'heading'; level: 1 | 2 | 3; text: string }
  | { id: BlockId; type: 'unknown'; text: string };

// Contenu d'un bloc à insérer ou mettre à jour.
// / Block content for insertion or update.
export type BlockContent =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string };

// Résumé d'un document (sans son contenu).
// / Document summary (no content).
export interface DocumentSummary {
  id: DocumentId;
  title: string;
  updated_at: string;
  link_reach: 'public' | 'authenticated' | 'restricted';
  link_role: 'reader' | 'commenter' | 'editor';
}

// Codes d'erreur métier retournés à l'agent.
// / Business error codes returned to the agent.
export type DocsErrorCode =
  | 'DOC_NOT_FOUND'
  | 'DOC_NOT_PUBLIC'
  | 'AUTH_REQUIRED'
  | 'INSTANCE_NOT_SET'
  | 'INSTANCE_MISMATCH'
  | 'DOC_READONLY'
  | 'BLOCK_NOT_FOUND'
  | 'UNSUPPORTED_BLOCK_TYPE'
  | 'SYNC_TIMEOUT';

// Erreur métier dédiée pour le routage côté MCP.
// / Dedicated business error for MCP-side routing.
export class DocsError extends Error {
  constructor(public readonly code: DocsErrorCode, message: string) {
    super(message);
    this.name = 'DocsError';
  }
}
