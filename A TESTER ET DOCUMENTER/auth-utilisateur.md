# Authentification utilisateur (v0.2)

## Ce qui a été fait

8 nouveaux tools MCP (`set_session_credentials`, `clear_session_credentials`, `create_document`, `delete_document`, `move_document`, `duplicate_document`, `update_document_title`, `list_my_documents`) qui nécessitent un cookie de session Docs valide. La config `DOCS_INSTANCE_URL` devient optionnelle : l'instance est détectée depuis les liens.

## Tests à réaliser

### Test 1 : Démarrage sans config

1. Lancer le serveur MCP sans `DOCS_INSTANCE_URL` dans l'env.
2. Appeler `list_documents` via tools/call → réponse attendue : `{code: "INSTANCE_NOT_SET", ...}`.
3. Appeler `read_document({doc_url: "https://notes.liiib.re/docs/<UUID>/"})` → l'instance est settled, le doc est lu.
4. Appeler `list_documents` à nouveau → marche.

### Test 2 : Création authentifiée

1. Récupérer ton `docs_sessionid` et `csrftoken` depuis Chrome ou Firefox (cf. README).
2. Appeler `set_session_credentials({docs_sessionid, csrftoken})`.
3. Appeler `create_document({title: "Test"})` → un doc top-level est créé chez toi.
4. Appeler `create_document({title: "Sub", parent_id: <id>})` → un sous-doc est créé sous le précédent.
5. Vérifier sur `notes.liiib.re/docs/` qu'ils sont bien listés sous ton compte.
6. Cleanup : `delete_document({doc_id: <id_top>})`.

### Test 3 : Switch d'instance

1. `set_session_credentials({docs_sessionid: "...", csrftoken: "...", instance_url: "https://notes.liiib.re"})`.
2. `read_document({doc_url: "https://other-docs.example/docs/<UUID>/"})` → réponse attendue : `INSTANCE_MISMATCH`.
3. `clear_session_credentials()` (n'affecte pas l'instance).
4. Recommencer avec une URL de la nouvelle instance + nouveau `set_session_credentials({..., instance_url: "https://other-docs.example"})`.

### Test 4 : Cookie expiré

Difficile à tester en moins de 12h. Alternative :
1. `set_session_credentials({docs_sessionid: "valeur_invalide", csrftoken: "..."})`.
2. Appeler `create_document({title: "x"})` → le serveur retourne `401`/`403`, le client renvoie `AUTH_REQUIRED` variant "expired".

### Test 5 : Sécurité — pas de fuite de credentials

Tester unitairement : `console.log(store)` après set ne révèle pas la valeur (cf. `tests/credentials.test.ts`).

### Test 6 : Test d'intégration end-to-end

1. `export DOCS_INSTANCE_URL=https://notes.liiib.re`
2. `export DOCS_INTEGRATION_SESSIONID=<valeur>`
3. `export DOCS_INTEGRATION_CSRFTOKEN=<valeur>`
4. `npm run test:integration:auth`
5. Sortie attendue : 8 étapes, `✅ v0.2 integration test PASSED`. Tous les docs créés sont supprimés à la fin.

## Compatibilité

- Compat v0.1 préservée : si `DOCS_INSTANCE_URL` est définie, le MCP fonctionne exactement comme avant.
- Lecture de docs publics : reste anonyme, pas de credentials nécessaires (comportement v0.1 préservé).
