# Changelog

## 1. Initial release / Première version

**Date :** 2026-05-08
**Version :** 0.1.0

**Quoi / What :** Première version livrable du serveur MCP. Expose 6 tools (list_documents, read_document, insert_block, update_block, delete_block, get_document_metadata) pour la lecture et l'édition fine de documents publics sur une instance la-suite Docs.

**Pourquoi / Why :** Permettre à un agent IA d'éditer des paragraphes individuels d'un document Docs en restant compatible avec une édition humaine concurrente, sans réécrire le document entier.

### Fichiers créés / Created files

| Fichier / File | Rôle / Role |
|---|---|
| `src/server.ts` | Point d'entrée MCP stdio, déclaration des tools |
| `src/types.ts` | Types partagés et DocsError |
| `src/docs/client.ts` | Wrapper REST sur l'API Django Docs |
| `src/docs/connection.ts` | DocsWebSocket avec Origin et Cookie |
| `src/docs/session.ts` | Cache des sessions Yjs + ops d'édition |
| `src/docs/blocks.ts` | Conversion fragment Yjs ↔ JSON simplifié |
| `tests/blocks.test.ts` | Tests unitaires sur blocks.ts |
| `tests/integration.test.ts` | Test e2e manuel |
| `README.md` | Présentation, install, usage |
| `CHANGELOG.md` | Ce fichier |
| `docs/superpowers/specs/2026-05-08-docs-mcp-design.md` | Spec validée |
| `docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md` | Plan d'implémentation |
| `A TESTER ET DOCUMENTER/insertion-paragraphes.md` | Scénarios de test manuel |

### Migration

- **Migration nécessaire / Migration required :** Non / No
