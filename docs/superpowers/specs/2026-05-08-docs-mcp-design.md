# Spec — `lasuite-docs-mcp` v1

**Date :** 2026-05-08
**Auteur :** Jonas Turbeaux (Coopérative Code Commun) avec assistant Claude Code
**Statut :** Design validé, prêt pour planification d'implémentation

---

## 1. Contexte et objectif

[la-suite Docs](https://github.com/suitenumerique/docs) est un éditeur collaboratif de documents, alternative open-source à Notion / Google Docs, basé sur Django + Next.js + BlockNote + Yjs (CRDT). Une session précédente a permis de prouver qu'un client externe (Node.js, hors instance hébergée) peut se connecter au serveur de collaboration WebSocket Hocuspocus et co-éditer un document en temps réel avec les humains qui l'éditent dans leur navigateur — à condition de gérer correctement quatre obstacles techniques :

1. Le header `Origin` doit valoir l'URL exacte de l'instance.
2. Un cookie quelconque doit être envoyé (même `docs_sessionid=anonymous-bot` suffit pour les docs publics).
3. Un `token` Hocuspocus dummy doit être passé au client pour déclencher l'envoi de l'`AuthenticationMessage`.
4. Le polyfill WebSocket doit être passé via `HocuspocusProviderWebsocket` (et non `HocuspocusProvider`), car ce dernier ne forwarde pas l'option vers son sous-provider.

Ce projet, **`lasuite-docs-mcp`**, transforme ce proof of concept en serveur **Model Context Protocol (MCP)** réutilisable. Un agent IA (Claude Desktop, Continue, Cursor, etc.) peut ainsi lire et éditer finement des documents Docs publics via une surface d'outils stable et minimale.

### Objectif principal de la v1

Permettre à un agent de **lire le contenu structuré d'un document Docs public** et de **modifier ses paragraphes individuellement** (insertion, mise à jour, suppression), sans réécrire le reste du document, et en restant compatible avec une édition humaine concurrente.

### Non-objectifs (explicitement hors v1)

- Authentification réelle (OIDC, OAuth2, bearer token utilisateur). La v1 ne touche qu'aux docs `link_reach: "public"` avec `link_role: "editor"`.
- Recherche sémantique sur les documents.
- Gestion des accès, invitations, partages.
- Historique des versions, restauration.
- Types de blocs avancés : listes, codeblocks, tables, callouts, médias.
- Formatage inline : gras, italique, liens.
- Édition fine au caractère près (insert à position N dans un paragraphe). La granularité v1 est le bloc entier.
- Écriture batch : si l'agent doit faire 5 modifications, il fait 5 appels.
- Surveillance temps réel (notifications quand un humain édite).

---

## 2. Architecture et composants

### Stack et transport

- **Langage** : Node.js + TypeScript. Réutilise l'outillage du proof : `@hocuspocus/provider`, `yjs`, `ws`.
- **SDK MCP** : `@modelcontextprotocol/sdk`, transport **stdio** (standard pour serveurs MCP locaux lancés par les clients comme Claude Desktop).
- **Configuration** : variable d'environnement `DOCS_INSTANCE_URL` (par défaut `https://notes.liiib.re`) pour le multi-instance.

### Modules

```
src/
├── server.ts            # Entrée MCP : déclare les tools, route vers les modules métier
├── docs/
│   ├── client.ts        # Wrapper REST sur l'API Django (lister docs, vérifier accès)
│   ├── connection.ts    # DocsWebSocket : wrapper ws qui injecte Origin + Cookie
│   ├── session.ts       # Cache des sessions Yjs ouvertes + TTL GC (5 min)
│   └── blocks.ts        # Conversion Y.XmlFragment ↔ liste JSON simplifiée
└── types.ts             # Types partagés (Block, ToolError, DocumentId, BlockId, …)
```

### Frontières de responsabilités

- `server.ts` ne contient aucune logique Yjs ni HTTP ; il valide les inputs MCP avec zod, délègue à `session` ou `client`, formate la sortie.
- `session.ts` est le seul module qui gère le cycle de vie des connexions WebSocket. Il expose une API métier de haut niveau : `read(docId)`, `insertBlock(docId, afterId, content)`, `updateBlock(docId, blockId, text)`, `deleteBlock(docId, blockId)`.
- `connection.ts` est le seul fichier qui peut faire `new WebSocket(...)`. Il encapsule les quatre contournements identifiés dans le proof.
- `blocks.ts` traduit dans les deux sens entre la structure Yjs (Y.XmlFragment d'éléments BlockNote) et la liste JSON simplifiée exposée à l'agent. Aucun accès réseau.
- `client.ts` sert exclusivement aux opérations REST : lister les docs publics accessibles et vérifier qu'un doc cible est `link_reach: "public"` + `link_role: "editor"` avant d'ouvrir une connexion WebSocket.

---

## 3. Surface MCP

Cinq tools obligatoires en v1 (lecture + édition), plus un sixième de métadonnées qui peut être inclus si peu coûteux. Signatures délibérément étroites.

### Tools de lecture

#### `list_documents()`

Renvoie les docs accessibles publiquement par l'instance configurée.

```ts
→ Array<{
    id: DocumentId;
    title: string;
    updated_at: string;       // ISO 8601
    link_reach: "public" | "authenticated" | "restricted";
    link_role: "reader" | "commenter" | "editor";
  }>
```

Filtrage côté client : seuls les docs avec `link_reach: "public"` sont renvoyés en v1.

#### `read_document({ doc_id })`

Synchronise via WebSocket (ouvre la session si pas en cache), renvoie la structure aplatie du document.

```ts
→ {
    id: DocumentId;
    title: string;
    blocks: Array<
      | { id: BlockId; type: "paragraph"; text: string }
      | { id: BlockId; type: "heading"; level: 1 | 2 | 3; text: string }
    >;
  }
```

Les blocs de types non supportés en v1 (listes, callouts, tables…) sont représentés par `{ id, type: "unknown", text: "..." }` pour que l'agent puisse les voir et raisonner sur leur position, sans pouvoir les éditer directement.

### Tools d'édition

#### `insert_block({ doc_id, content, after_block_id? })`

Insère un nouveau `blockContainer` (UUID auto-généré) après `after_block_id`. Si `after_block_id` est absent ou `null`, insertion en tête de document. Pour ajouter en queue, l'agent passe l'ID du dernier bloc qu'il a vu via `read_document`.

```ts
content:
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }

→ { block_id: BlockId }
```

#### `update_block({ doc_id, block_id, text })`

Remplace **uniquement le texte** d'un bloc existant. Le type et le niveau ne changent pas. Pour changer le type d'un bloc, l'agent fait `delete_block` + `insert_block`.

```ts
→ { ok: true }
```

#### `delete_block({ doc_id, block_id })`

Supprime un bloc complet du document.

```ts
→ { ok: true }
```

### Tool de métadonnées (inclusion conditionnelle)

#### `get_document_metadata({ doc_id })`

Renvoie les métadonnées sans charger le contenu — utile quand l'agent veut juste vérifier l'existence ou lire le titre. À inclure en v1 uniquement si l'implémentation ne demande pas plus de quelques lignes (le tool est essentiellement un appel REST direct sur l'API existante).

```ts
→ {
    id: DocumentId;
    title: string;
    updated_at: string;
    created_at: string;
    link_reach: string;
    link_role: string;
  }
```

---

## 4. Data flow — exemple complet

### Cas d'usage : « Insère un lorem au milieu, puis modifie-le »

#### Tour 1 — l'agent lit le document

```
USER  → "Insère un lorem au milieu de mon document"

Agent → MCP: read_document({ doc_id: "ccf1..." })
MCP   → ouvre la session WebSocket si pas en cache, attend le sync, renvoie:
        {
          blocks: [
            { id: "A1B2", type: "paragraph", text: "Mon intro" },
            { id: "C3D4", type: "heading", level: 2, text: "Conclusion" }
          ]
        }
```

L'agent **raisonne** sur le contenu : « le milieu, c'est entre l'intro et la conclusion, donc après `A1B2` ».

#### Tour 2 — l'agent insère

```
Agent → MCP: insert_block({
          doc_id: "ccf1...",
          content: { type: "paragraph", text: "Lorem ipsum dolor sit amet..." },
          after_block_id: "A1B2"
        })
MCP   → applique sur le Y.Doc en cache :
        blockGroup.insert(idxOf(A1B2)+1, [newContainer])
        Yjs propage l'update au serveur Hocuspocus → propagation à tous les clients
        → renvoie: { block_id: "E5F6" }
```

L'agent **mémorise `E5F6`** dans son contexte conversationnel.

#### Tour 3 — l'utilisateur demande une modification

```
USER  → "Traduis ce lorem en français"

Agent → MCP: update_block({
          doc_id: "ccf1...",
          block_id: "E5F6",          ← réutilise l'ID retourné au tour 2
          text: "Lorem ipsum traduit..."
        })
MCP   → trouve le blockContainer avec id="E5F6", localise son Y.XmlText interne,
        text.delete(0, len) puis text.insert(0, nouveauTexte)
        → renvoie: { ok: true }
```

### Pourquoi UUID stable et pas index numérique ?

Si entre le tour 1 et le tour 3 un humain insère un paragraphe au début, **l'index "2" pointerait sur le mauvais bloc**. L'UUID `E5F6` reste valide tant que le bloc existe — c'est le contrat CRDT de Yjs. Un agent peut donc raisonner en toute sécurité sur des IDs entre plusieurs tools calls, même séparés dans le temps et avec des éditeurs humains actifs entre-temps.

### Cas où l'agent doit re-lire

Si la conversation a été tronquée et que l'agent n'a plus `E5F6` en contexte, ou si l'utilisateur demande « modifie le paragraphe sur Lorem » sans que l'agent ait l'ID, l'agent appelle `read_document` à nouveau et identifie le bloc par son contenu textuel. C'est plus robuste que des indices fragiles.

---

## 5. Gestion d'erreurs

### Validation à l'entrée (zod sur les schemas MCP)

Chaque tool valide ses inputs avant tout I/O :

- `doc_id` doit être un UUID v4
- `content.type` ∈ `{ "paragraph", "heading" }`
- `content.level` ∈ `{ 1, 2, 3 }` si `type=heading`
- `text` non vide

### Erreurs métier — codes explicites retournés à l'agent

| Cas | Code | Comportement |
|---|---|---|
| Doc introuvable (404 REST) | `DOC_NOT_FOUND` | Tool error MCP, message clair |
| Doc non public (`link_reach != "public"`) | `DOC_NOT_PUBLIC` | Refusé avant la connexion WebSocket, vérification via `client.ts` |
| Doc public en lecture seule (`link_role != "editor"`) | `DOC_READONLY` | `read_document` marche, opérations d'écriture refusées |
| `block_id` inconnu dans le doc | `BLOCK_NOT_FOUND` | Tool error, suggérer `read_document` à l'agent |
| Type non supporté en v1 | `UNSUPPORTED_BLOCK_TYPE` | Avec la liste des types acceptés |
| Sync timeout (>10s) | `SYNC_TIMEOUT` | Possiblement instance down |

### Erreurs techniques — récupération

- **WebSocket reconnect** : `HocuspocusProvider` reconnecte automatiquement avec backoff. Si une opération tombe pendant un disconnect, on attend la reconnexion (max 5 secondes) avant de la rejouer. Au-delà : `SYNC_TIMEOUT`.
- **Cookie expiré / origin invalide** : ne devrait pas arriver vu qu'on est sur cookie bidon + origin dérivée de `DOCS_INSTANCE_URL`. Si ça arrive, c'est une erreur de configuration — message explicite pointant vers la variable d'environnement.

### Concurrence agent ↔ humain — non gérée comme une erreur

Yjs résout les conflits par construction. Si l'agent et un humain modifient le même bloc en même temps, les deux modifications coexistent (le texte se concatène ou s'entrelace selon les positions caractère par caractère). On ne le traite pas comme une erreur — c'est précisément le comportement attendu d'un CRDT et c'est l'intérêt principal de l'architecture choisie.

---

## 6. Stratégie de tests

### Tests unitaires (vitest, sans réseau) — `blocks.ts`

C'est le module le plus testable et le plus à risque (parsing/sérialisation BlockNote). Cible >90% de couverture.

```
- xmlFragmentToBlocks(fragment) sur des Y.Doc construits en mémoire :
  · doc vide → []
  · doc avec paragraph + heading → bonne extraction id/type/text/level
  · doc avec types non supportés → représentés en type "unknown"

- buildBlockContainer(content) :
  · paragraph → XmlElement bien formé (attrs backgroundColor/textColor/textAlignment)
  · heading level=2 → bons attrs
  · type invalide → throw

- Round-trip : build → fragment → parse retourne le contenu d'origine
```

### Tests d'intégration (script manuel, doc dédié) — `tests/integration/`

Un script `npm run test:integration` qui se connecte à un doc public dédié (UUID en variable d'environnement `DOCS_INTEGRATION_DOC_ID`), exécute la séquence complète :

```
read → insert → read (vérification) → update → read (vérification) → delete → read (vérification doc vide)
```

Idempotent : nettoie tous les blocs créés à la fin, même en cas d'échec partiel.

### Tests MCP — un seul smoke test

Un script qui lance le serveur MCP en stdio, lui envoie un `tools/list` et un `tools/call read_document`, vérifie que la réponse a la forme attendue. Pas de couverture exhaustive de tous les tools — ce qui est testé dans `blocks.ts` et l'intégration suffit.

### Pas de mock Hocuspocus en v1

Surcoût trop élevé pour le bénéfice. La CI peut sauter `test:integration`. Les tests unitaires sur `blocks.ts` couvrent l'essentiel de la logique.

---

## 7. Conventions de code et documentation

Style **FALC** (Facile à Lire et Comprendre), inspiré du skill djc utilisé sur les autres projets de la Coopérative Code Commun, adapté au contexte Node/TypeScript.

### Code

- **Variables verbeuses** : `currentDocumentSession` plutôt que `session`, `blockToInsertContent` plutôt que `c`. Aucune abréviation cryptique.
- **For loops simples** sur les transformations de blocs, pas de chaînes `.map().filter().reduce()` à 4 niveaux.
- **TypeScript explicite** : types nommés en haut du fichier (`type BlockId = string;`), `unknown` plutôt que `any`, pas de `as` qui contournent le type system.
- **Pas d'abstractions prématurées** : 3 occurrences identiques avant de factoriser.
- **Une responsabilité par fichier** : `connection.ts` ne fait pas de parsing, `blocks.ts` ne fait pas de réseau.

### Commentaires bilingues FR/EN

Header obligatoire en haut de chaque module :

```typescript
/**
 * Cache des sessions Yjs ouvertes par doc_id, avec TTL de garbage collection.
 * / Cache of open Yjs sessions per doc_id, with garbage collection TTL.
 *
 * LOCALISATION : src/docs/session.ts
 *
 * Quand un tool MCP est appelé, ce module fournit le Y.Doc déjà synchronisé
 * pour ce document, ou ouvre une nouvelle connexion Hocuspocus si pas en cache.
 * Une fois inactif pendant plus de 5 minutes, la connexion est fermée.
 *
 * FLUX :
 * 1. server.ts appelle getOrCreate(docId)
 * 2. Si cache hit : retourne la session, met à jour lastUsed
 * 3. Si cache miss : ouvre la WS via connection.ts, attend onSynced
 * 4. Le timer GC (toutes les 60s) ferme les sessions inactives
 *
 * COMMUNICATION :
 * Reçoit : appels depuis server.ts (un par tool call)
 * Émet : updates Yjs vers le serveur Hocuspocus (via Y.Doc.observe)
 */
```

Sur les fonctions importantes : docstring FR détaillée + ligne EN one-liner. Sur les opérations Yjs non évidentes, expliquer **pourquoi** on procède de telle manière.

### Documentation projet (à créer dans le repo)

- **`README.md`** : présentation, install, configuration, exemple d'utilisation depuis Claude Desktop.
- **`CHANGELOG.md`** au format djc : sections numérotées en ordre chronologique inverse, titres FR/EN, table des fichiers modifiés, flag « Migration nécessaire ».
- **`docs/superpowers/specs/`** : les specs (cette spec y est).
- **`A TESTER ET DOCUMENTER/`** à la racine : un `.md` par feature livrée, avec résumé technique + scénarios de test manuel reproductibles.

### Tests — style FALC

- Noms verbeux et descriptifs : `should_insert_paragraph_after_specific_block_id_when_after_id_provided` plutôt que `test1`.
- **Atomique** : 1 test = 1 assertion comportementale.
- Commentaires bilingues dans les tests aussi.
- Pas de fixtures magiques globales — chaque test construit explicitement son contexte minimal.

### Anti-patterns à éviter

| À éviter | Préférer | Pourquoi |
|---|---|---|
| `Map<string, any>` pour le cache | Type nommé `SessionCache = Map<DocumentId, YjsSession>` | Lisibilité + checking |
| Utility class `BlockUtils` avec 10 statics | Fonctions exportées du module `blocks.ts` | Pas de classe pour rien |
| Erreurs comme `Error("oops")` | Erreurs typées (`DocNotFoundError extends Error`) avec code MCP | L'agent peut router |
| Logique dans le constructor de `DocsWebSocket` | Constructor minimal, init explicite via `connect()` | Pas de side-effects cachés |
| Skip CHANGELOG après un changement | Entrée numérotée FR/EN à chaque feature/fix | Traçabilité |

---

## 8. Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `DOCS_INSTANCE_URL` | `https://notes.liiib.re` | URL HTTPS de l'instance Docs cible. Le WebSocket est dérivé : `wss://<host>/collaboration/ws/`. L'Origin envoyée est dérivée de cette URL. |
| `DOCS_SESSION_TTL_MS` | `300000` (5 min) | Durée d'inactivité avant fermeture d'une session WebSocket en cache. |
| `DOCS_SYNC_TIMEOUT_MS` | `10000` (10 s) | Délai max d'attente du sync initial avant `SYNC_TIMEOUT`. |
| `DOCS_INTEGRATION_DOC_ID` | _(non défini)_ | UUID d'un doc public dédié pour `npm run test:integration`. Si non défini, ces tests sont skippés. |

Aucune variable d'authentification réelle en v1 (cookie hardcodé `docs_sessionid=anonymous-bot`).

---

## 9. Travaux ultérieurs (post-v1)

À titre indicatif, hors scope de la spec actuelle :

- **v2 — Authentification utilisateur** : OIDC user flow ou cookie de session collé en config, pour accéder aux docs privés et organisationnels.
- **v3 — Types de blocs étendus** : listes (puces et numérotées), code blocks, tables.
- **v3 — Formatage inline** : gras, italique, liens.
- **v4 — Édition fine au caractère** : `insert_text(block_id, position, text)`, `replace_text(block_id, find, replace)`.
- **v4 — Recherche sémantique** : `search_documents(query)` qui interroge `/api/v1.0/documents/search/`.
- **v4 — Awareness** : exposer la présence des autres clients (`list_active_users(doc_id)`).

---

## 10. Décisions clés (récap)

| Décision | Choix | Raison |
|---|---|---|
| Scope v1 | Lecture + édition fine | Cible exactement le cas d'usage énoncé |
| Granularité | Bloc entier | Simple, lisible pour l'agent, suffisant |
| Authentification | Aucune réelle, doc public seul | Sécurité par scope, démarrage immédiat |
| Format de read | JSON simplifié `[{id, type, text, level?}]` | Compact, agent-friendly, expose les IDs stables |
| Architecture connexion | WebSocket persistant + cache TTL | Performance + sémantique live correcte |
| Langage | Node.js + TypeScript | Réutilise tout le proof, SDK MCP officiel disponible |
| Transport MCP | stdio | Standard pour serveurs MCP locaux |
| Multi-instance | Variable d'env `DOCS_INSTANCE_URL` | Réutilisable sans recompiler |

---

## 11. Critères de succès

La v1 est livrable quand :

1. Un agent (Claude Desktop ou équivalent) peut être configuré avec `lasuite-docs-mcp` en stdio et obtenir la liste des tools.
2. L'agent peut lire un document public sur `notes.liiib.re` et obtenir une liste structurée des paragraphes/headings avec leurs IDs.
3. L'agent peut insérer un paragraphe à un endroit précis du document, et l'humain qui édite le doc dans son navigateur voit l'insertion en temps réel.
4. L'agent peut modifier un paragraphe précis (par son ID) sans toucher aux autres blocs, et l'humain voit la modification.
5. L'agent peut supprimer un bloc précis.
6. Le scénario complet « insère un lorem au milieu, puis traduis-le en français » passe de bout en bout.
7. Les tests unitaires sur `blocks.ts` passent à >90% de couverture.
8. Le test d'intégration end-to-end (manuel) passe sans erreur résiduelle dans le doc cible.
9. Le `README.md`, le `CHANGELOG.md` et au moins un fichier dans `A TESTER ET DOCUMENTER/` sont présents.
