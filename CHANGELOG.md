# Changelog

## 3. Support du markdown inline et fix race condition / Inline markdown support and race condition fix

**Date :** 2026-05-09
**Version :** 0.3.0

**Quoi / What :**
- **Markdown inline** : `insert_block` et `update_block` interprètent désormais leur paramètre `text` comme du **markdown inline**. Les marqueurs `**gras**`, `*italique*`, `` `code inline` ``, `~~barré~~` deviennent des marks Yjs côté BlockNote ; les `[texte](url)` deviennent des liens cliquables (mark Yjs `link`).
- **Round-trip markdown** : `read_document` retourne désormais le contenu en markdown (au lieu de pseudo-XML). Un agent peut lire un bloc, modifier le markdown, et le réinjecter via `update_block` sans perte.
- **Fix race condition (v0.2.1 incluse)** : `insert_block`, `update_block`, `delete_block` attendent désormais que l'update Yjs soit propagé au serveur Hocuspocus avant de retourner. Avant ce fix, un process MCP éphémère (ex: appel JSON-RPC unique sur stdio) pouvait perdre l'update.
- **Listage d'arborescence** (déjà ajouté en patch entre 0.2.0 et 0.3.0) : 2 nouveaux tools `list_document_children` et `list_document_descendants`. La surface MCP passe à **16 tools**.

**Pourquoi / Why :** La v0.2 traitait le `text` comme du texte brut, ce qui produisait des sorties moches (`**gras**` apparaissait littéralement dans BlockNote). Un agent IA produit naturellement du markdown ; en supportant ce format en input et en output, on supprime la friction et on permet aux agents de générer de vrais documents structurés. La race condition était un bug latent qui se manifestait en usage script ou test d'intégration.

### Fichiers ajoutés / Added files

| Fichier / File | Rôle / Role |
|---|---|
| `src/docs/markdown.ts` | Parser markdown inline → marks Yjs (gras, italique, code, strike, link) |
| `tests/markdown.test.ts` | Tests unitaires sur le parser (11 tests) |

### Fichiers modifiés / Modified files

| Fichier / File | Changement / Change |
|---|---|
| `src/docs/blocks.ts` | `buildContentElement` ne pose plus le contenu inline (refactor build → attach → populate). Nouvelle fonction `populateInlineContent`. `extractTextFromElement` reconverit les marks Yjs en markdown pour la sortie. |
| `src/docs/session.ts` | `insertBlock` appelle `populateInlineContent` après attachement. `replaceTextInElement` reparse le markdown. Nouvelle méthode privée `awaitFlush` pour le fix race condition, appelée par `insertBlock`/`updateBlockText`/`deleteBlock`. |
| `tests/blocks.test.ts` | Tests adaptés au nouveau pattern build → attach → populate. |
| `package.json` | Dépendance `marked@^18` ajoutée. Version `0.3.0`. |

### Migration

- **Migration nécessaire / Migration required :** Non / No
- L'API publique des tools n'a pas changé. Si un agent envoyait du texte brut sans aucun marqueur markdown, le comportement reste identique. Si un agent avait par accident `**` ou `_` dans son texte plain (cas rare), ces caractères seront maintenant interprétés.

---

## 2. Authentification utilisateur et détection dynamique de l'instance / User authentication and dynamic instance detection

**Date :** 2026-05-08
**Version :** 0.2.0

**Quoi / What :** Ajout de 8 tools MCP pour les opérations qui nécessitent une authentification utilisateur (création top-level / sous-doc, suppression, déplacement, duplication, renommage, listing personnel) plus 2 tools de gestion des credentials. La configuration `DOCS_INSTANCE_URL` devient optionnelle : l'instance Docs est désormais détectée à partir des liens vers des documents que l'utilisateur partage avec l'agent.

**Pourquoi / Why :** La v0.1 ne permettait que la lecture et l'édition de documents publics existants. Pour pouvoir créer une arborescence et opérer en tant qu'utilisateur connecté, on ajoute le support des cookies de session Django + protection CSRF. La détection dynamique d'instance évite à l'utilisateur de configurer une variable d'environnement et permet à l'agent de switcher entre instances dans la même session.

### Fichiers ajoutés / Added files

| Fichier / File | Rôle / Role |
|---|---|
| `src/auth/credentials.ts` | CredentialsStore avec garde-fous anti-fuite |
| `src/auth/instance.ts` | InstanceStore + parseDocsUrl |
| `tests/credentials.test.ts` | Tests unitaires anti-fuite |
| `tests/instance.test.ts` | Tests parseDocsUrl + matches |
| `tests/integration-auth.test.ts` | Test e2e v0.2 |
| `A TESTER ET DOCUMENTER/auth-utilisateur.md` | Scénarios manuels |

### Fichiers modifiés / Modified files

| Fichier / File | Changement / Change |
|---|---|
| `src/server.ts` | 8 nouveaux tools + dispatch doc_id|doc_url + 2 stores |
| `src/types.ts` | 3 nouveaux codes d'erreur (AUTH_REQUIRED, INSTANCE_NOT_SET, INSTANCE_MISMATCH) |
| `src/docs/client.ts` | Méthodes d'écriture + 4 headers auth |
| `src/docs/connection.ts` | Cookie utilisateur si CredentialsStore non-vide |
| `src/docs/session.ts` | Constructeur accepte un CredentialsStore optionnel |
| `package.json` | Version 0.2.0, script test:integration:auth |
| `README.md` | DOCS_INSTANCE_URL optionnelle, 8 nouveaux tools documentés |
| `docs/architecture.md` | Section auth + détection instance |

### Migration

- **Migration nécessaire / Migration required :** Non / No
- Les déploiements v0.1 existants (avec `DOCS_INSTANCE_URL` configurée) fonctionnent identiquement en v0.2 sans aucun changement de config.

---

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
