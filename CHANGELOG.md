# Changelog

## 5. Upload d'images / Image upload

**Date :** 2026-05-10
**Version :** 0.5.0

**Quoi / What :**
- **Nouveau tool `insert_image`** : permet à l'agent d'uploader une image (PNG, JPEG, GIF, WebP, SVG) en base64 et de l'insérer comme bloc image BlockNote dans un document. La surface MCP passe à **17 tools**.
- **Pipeline complet** : `POST /api/v1.0/documents/{id}/attachment-upload/` (multipart/form-data, champ `file`) → l'API retourne une URL `media-check` (polling antivirus) → bloc image inséré dans le Y.Doc avec cette URL → BlockNote remplace automatiquement par l'URL S3 finale après scan.
- **Lecture des images existantes** : `read_document` reconnaît désormais les blocs `image` et retourne `{type: 'image', url, name, caption, text: ''}` au lieu de `{type: 'unknown'}`. L'agent voit les images déjà présentes dans un doc.
- **Permissions** : exige `attachment_upload` côté Docs (équivalent `can_update`). Marche en mode authentifié et — si le doc est public-editor — en mode anonyme avec le warning persistance habituel.

**Pourquoi / Why :** Les agents IA produisent fréquemment des images (diagrammes, captures, illustrations générées). Sans support upload, ils devaient demander à l'utilisateur de coller manuellement les images, cassant le flux d'édition autonome. L'upload natif permet désormais de générer un schéma puis l'insérer en un seul appel d'outil.

### Fichiers modifiés / Modified files

| Fichier / File | Changement / Change |
|---|---|
| `src/types.ts` | Le type `Block` accepte désormais `{type: 'image', url, name, caption, text: ''}`. |
| `src/docs/blocks.ts` | `blockContainerToBlock` reconnaît les `<image>` et retourne leurs props. Nouvelle fonction `buildImageBlockContainer(props)` qui construit le blockContainer + élément `<image>` avec les props standard BlockNote (url, name, caption, showPreview, previewWidth, etc.). |
| `src/docs/client.ts` | Nouvelle méthode `uploadAttachment(docId, fileBuffer, fileName, mimeType)` : POST multipart/form-data sur `/attachment-upload/`, retourne l'URL absolue à utiliser dans le bloc. Headers manuels (pas de `buildAuthHeaders` pour préserver le boundary multipart). Gestion 401/403 cohérente avec le reste. |
| `src/docs/session.ts` | Nouvelle méthode `insertImageBlock(docId, imageProps, afterBlockId)` : insère un bloc image préconstruit dans le Y.Doc avec `awaitFlush` + persistance REST. |
| `src/server.ts` | Nouveau tool `insert_image` avec `insertImageInputSchema` (zod). Helper `guessMimeTypeFromFileName` pour deviner le MIME type depuis l'extension. Instructions MCP enrichies (mention de la feature image). Compteur `16 tools` → `17 tools`. |
| `package.json` | Version `0.5.0`. |

### Migration

- **Migration nécessaire / Migration required :** Non / No
- L'API publique des tools existants n'a pas changé. Les agents qui ne connaissent pas `insert_image` continuent de fonctionner identiquement.
- `read_document` retourne maintenant `{type: 'image', ...}` au lieu de `{type: 'unknown'}` pour les blocs image existants. Les agents qui ne géraient pas explicitement `unknown` ne sont pas impactés ; ceux qui s'appuyaient sur `unknown` pour deviner les images doivent passer sur le type `image`.

---

## 4. Persistance garantie + robustesse de l'authentification + instructions MCP / Guaranteed persistence + auth robustness + MCP instructions

**Date :** 2026-05-10
**Version :** 0.4.0

**Quoi / What :**
- **Persistance garantie côté serveur (le big fix)** : après chaque écriture Yjs (`insert_block`, `update_block`, `delete_block`) en mode authentifié, le MCP fait un `PATCH /api/v1.0/documents/{id}/` avec le state Yjs complet encodé en base64 et `websocket: true`. Imite le save loop du frontend BlockNote (60s). Sans ce PATCH, les écritures du MCP restaient uniquement en RAM Hocuspocus côté serveur (qui n'a aucun callback de persistance) et étaient perdues quand le serveur déchargeait le doc de sa mémoire.
- **Hydratation depuis REST snapshot avant la WebSocket** : `openNewSession` fetch le `content` REST et l'applique au Y.Doc local AVANT d'ouvrir la WS Hocuspocus. Sans ça, quand le serveur Hocuspocus est froid (aucun client humain en parallèle), le sync WS retourne un Y.Doc vide alors que le doc est rempli — `read_document` retournait `blocks: []` à tort.
- **Vérification immédiate des credentials au `set_session_credentials`** : ping `/api/v1.0/users/me/` synchrone après le set. Si le serveur dit non, clear automatique et lève `AUTH_REQUIRED` avec un message qui explique pourquoi d'autres tools peuvent quand même réussir (piège des docs publics). Empêche l'agent de croire qu'il est authentifié alors qu'il ne l'est pas.
- **Distinction 401 vs 403** : nouveau code d'erreur `PERMISSION_DENIED`. Avant, les deux étaient confondus en `AUTH_REQUIRED`, ce qui poussait l'agent à reposer des cookies inutilement quand il s'agissait en réalité d'une permission Django manquante (ex: `children_create: false`). Le message inclut le champ `detail` Django quand présent.
- **Cache WebSocket purgé au changement de credentials** : `set_session_credentials` et `clear_session_credentials` font maintenant un `shutdown()` du SessionManager. Avant, une WebSocket Hocuspocus ouverte avec un ancien cookie restait cachée 5 min même après le changement de credentials, et continuait à utiliser l'ancien cookie (le cookie est calculé uniquement au handshake WS). Bug pré-existant : le switch d'instance volontaire fuyait aussi des WebSocket — fixé au passage.
- **Warning automatique sur les writes anonymes** : la sortie de `insert_block` / `update_block` / `delete_block` contient un champ `warning` clair en mode anonyme — l'agent doit le transmettre à l'utilisateur pour qu'il garde son onglet ouvert (sinon écriture potentiellement perdue, le PATCH /content/ exigeant l'auth).
- **Instructions MCP au démarrage** : le serveur expose un mode d'emploi de ~600 tokens via le champ `instructions` du protocole MCP `initialize`. Cache côté client, lu à chaque turn de l'agent. Liste les pièges (auth muet, persistance anonyme), les codes d'erreur, le markdown inline, la co-édition live.
- **Réponse de `set_session_credentials` enrichie** : retourne `{ok, user}` avec l'identité reconnue par le serveur (email, full_name) — l'agent peut ainsi vérifier qu'il est connecté sous le bon compte.

**Pourquoi / Why :** Plusieurs bugs sérieux remontés en usage réel via Claude Desktop. Le plus grave : après plusieurs sessions d'écriture en autonomie, l'utilisateur retrouvait certains sous-documents complètement vides — les écritures de l'agent étaient perdues sans laisser de trace. Investigation : le serveur Hocuspocus de Docs n'a aucun mécanisme de persistance automatique, c'est le frontend navigateur qui sauvegarde toutes les 60s. Sans humain connecté en parallèle, les écritures du MCP étaient perdues quand Hocuspocus déchargeait le doc de sa mémoire. Le PATCH explicite après chaque write élimine cette dépendance. Les autres fixes (auth, cache WS) étaient des bugs latents découverts pendant l'investigation.

### Fichiers modifiés / Modified files

| Fichier / File | Changement / Change |
|---|---|
| `src/docs/client.ts` | Nouvelle méthode `verifyAuthenticatedUser` (ping `/users/me/`). Nouvelle méthode `patchDocumentContent` (persistance explicite vers REST). `fetchDocumentMetadata` retourne aussi `content`. `requestWithAuth` distingue 401 et 403 (nouveau `PERMISSION_DENIED` avec `detail` Django). Nouvelle méthode `buildPermissionDeniedMessage`. Variant `'invalid_at_set'` ajouté à `buildAuthRequiredMessage`. |
| `src/docs/session.ts` | Nouvelle méthode privée `hydrateFromRestSnapshot` (Y.applyUpdate du snapshot REST avant la WS). Nouvelle méthode privée `persistContentToRest` (PATCH après chaque write). `insertBlock` / `updateBlockText` / `deleteBlock` appellent `persistContentToRest` après `awaitFlush`. Constructeur accepte un `DocsRestClient` optionnel. |
| `src/server.ts` | `set_session_credentials` ping `/users/me/`, clear automatique en cas d'échec, retourne `{ok, user}`. `set_session_credentials` et `clear_session_credentials` purgent le SessionManager (shutdown des WS). Helper `withAnonymousPersistenceWarning` qui injecte un warning sur les writes anonymes. Constante `MCP_INSTRUCTIONS` exposée via `instructions` au handshake MCP. Descriptions de `insert_block`, `update_block`, `delete_block` enrichies de la note persistance. Bug pré-existant fixé : `sessionManager.shutdown()` ajouté avant le `null` au switch d'instance volontaire. |
| `src/types.ts` | Nouveau code d'erreur `PERMISSION_DENIED`. |
| `package.json` | Version `0.4.0`. |

### Migration

- **Migration nécessaire / Migration required :** Non / No
- L'API publique des tools n'a pas changé. Les codes d'erreur déjà connus continuent d'arriver dans les mêmes scénarios. Les nouveautés sont additives :
  - `PERMISSION_DENIED` apparaîtra à la place de `AUTH_REQUIRED` quand le serveur Django renvoie un 403 (permission refusée). L'agent doit traiter ce nouveau code (ne pas reposer de cookies, mais signaler à l'humain le manque de permission).
  - Le champ `warning` apparaît seulement en mode anonyme sur les writes. À transmettre à l'utilisateur.
  - La réponse de `set_session_credentials` contient maintenant un champ `user` avec l'identité validée — utile pour double-check.
  - Si vous appeliez `set_session_credentials` avec des cookies morts, vous receviez avant `{ok: true}` (silencieux). Vous recevez maintenant un `AUTH_REQUIRED` immédiat. C'est le comportement correct mais c'est un changement de surface pour les agents qui se reposaient sur le `{ok: true}` muet.

---

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
