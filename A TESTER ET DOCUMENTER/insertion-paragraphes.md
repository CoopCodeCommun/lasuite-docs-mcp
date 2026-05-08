# Insertion et modification de paragraphes via MCP

## Ce qui a été fait

Premier livrable du serveur `lasuite-docs-mcp`. 6 tools MCP exposés en stdio. La connexion WebSocket Hocuspocus contourne les 4 obstacles techniques identifiés lors du proof of concept (Origin, Cookie, token Hocuspocus, polyfill via HocuspocusProviderWebsocket).

### Modifications

| Fichier | Changement |
|---|---|
| `src/server.ts` | Création du serveur MCP avec 6 tools |
| `src/docs/session.ts` | Cache session Yjs + ops read/insert/update/delete |
| `src/docs/blocks.ts` | Sérialisation BlockNote ↔ JSON simplifié |
| `src/docs/connection.ts` | Wrapper WebSocket avec Origin + Cookie |
| `src/docs/client.ts` | Wrapper REST sur l'API Django Docs |
| `src/types.ts` | Types partagés |

## Tests à réaliser

### Test 1 : Build et démarrage stdio

1. `npm install && npm run build` — sortie : pas d'erreur, `dist/server.js` existe.
2. `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js` — sortie : JSON listant les 6 tools.

### Test 2 : Tests unitaires

1. `npm test` — sortie : 8+ tests passent (blocks.ts).

### Test 3 : Test d'intégration end-to-end

1. Créer un doc public+editor sur `notes.liiib.re` (lien public, rôle Editor) ou utiliser un doc dédié.
2. Récupérer son UUID depuis l'URL.
3. `export DOCS_INTEGRATION_DOC_ID=<UUID>`
4. `npm run test:integration`
5. Sortie attendue : 7 étapes terminent, `✅ Integration test PASSED`.

### Test 4 : Live edit avec un humain

1. Ouvrir le doc dans le navigateur.
2. Configurer Claude Desktop avec le serveur MCP (cf. README.md).
3. Demander à l'agent : « Insère un paragraphe avec le texte "Bonjour" dans le doc `<UUID>` ».
4. Vérifier dans le navigateur : le paragraphe apparaît immédiatement.
5. Demander : « Modifie ce paragraphe pour qu'il contienne "Bonsoir" ».
6. Vérifier que le texte se modifie en temps réel dans le navigateur.
7. Demander : « Supprime ce paragraphe ».
8. Vérifier qu'il disparaît.

### Test 5 : Cas d'erreur

1. **Doc inexistant** : `read_document` avec un UUID inventé → réponse `code: DOC_NOT_FOUND`.
2. **Doc privé** : créer un doc `link_reach: restricted`, tenter `read_document` → `code: DOC_NOT_PUBLIC`.
3. **Bloc inexistant** : `update_block` avec un block_id bidon → `code: BLOCK_NOT_FOUND`.
4. **Validation zod** : `insert_block` sans `content.text` → `code: INVALID_INPUT`.

## Compatibilité

- Compatible avec n'importe quelle instance la-suite Docs accessible en HTTPS, paramétrée via `DOCS_INSTANCE_URL`.
- Aucune authentification utilisateur en v0.1.0 — uniquement docs `link_reach: public` + `link_role: editor`.
- Co-édition humaine en temps réel : oui (via le serveur Hocuspocus de l'instance).
