# Guide architecture & développement

Ce document explique **comment** `lasuite-docs-mcp` est construit, **pourquoi** ces choix, et quels **pièges** ont été rencontrés en cours de route. Il s'adresse aux contributeurs et aux futurs mainteneurs (humains ou agents). Le `README.md` couvre l'install et l'usage ; ce fichier couvre le « sous le capot ».

> Pour le design détaillé : [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](superpowers/specs/2026-05-08-docs-mcp-design.md)
> Pour la décomposition tâche-par-tâche : [`docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`](superpowers/plans/2026-05-08-docs-mcp-implementation.md)

---

## 1. Contexte

[la-suite Docs](https://github.com/suitenumerique/docs) est un éditeur collaboratif de documents (alternative open-source à Notion / Google Docs), basé sur Django + Next.js + BlockNote + Yjs. Chaque document est un état CRDT Yjs synchronisé en temps réel via un serveur WebSocket Hocuspocus séparé.

Le but de ce projet : exposer ce système d'édition à un **agent IA** via le protocole MCP, de telle sorte que l'agent puisse lire et modifier des paragraphes individuels d'un document **en temps réel et en cohabitation avec des humains qui éditent le doc dans leur navigateur**.

**Non-objectifs en v1** : authentification utilisateur, recherche sémantique, gestion des accès, types de blocs avancés (listes, codeblocks, tables), formatage inline. Le scope est volontairement étroit pour livrer une base solide.

---

## 2. Architecture en bref

```
┌──────────────────────────────────────────────────────────┐
│                  Client MCP (Claude Desktop, etc.)        │
└──────────────────────────────┬───────────────────────────┘
                               │ stdio (JSON-RPC)
                               ▼
┌──────────────────────────────────────────────────────────┐
│                       src/server.ts                       │
│       (entrée MCP, zod, routage des 6 tools)              │
└──────┬───────────────────────────────┬───────────────────┘
       │                               │
       ▼                               ▼
┌──────────────────┐      ┌──────────────────────────────┐
│  docs/client.ts  │      │      docs/session.ts         │
│  (REST API Docs) │      │ cache <docId, YjsSession>    │
└────────┬─────────┘      │ + ops read/insert/update/    │
         │                │   delete                      │
         │                └──────┬──────────────┬─────────┘
         │                       │              │
         ▼                       ▼              ▼
   ┌─────────────┐     ┌─────────────────┐   ┌────────────┐
   │ HTTPS REST  │     │ docs/connection │   │ docs/blocks│
   │ Django API  │     │ (WS + Origin +  │   │ (XmlFrag ↔ │
   └─────────────┘     │   Cookie)       │   │  JSON)     │
                       └────────┬────────┘   └────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │ Hocuspocus WS   │
                       │ /collaboration/ │
                       │   ws/           │
                       └─────────────────┘
```

| Module | Responsabilité unique |
|---|---|
| `src/server.ts` | Entrée MCP stdio, validation zod, routage des 6 tools, formatage des erreurs |
| `src/types.ts` | Types partagés (`DocumentId`, `BlockId`, `Block`, `BlockContent`, `DocsError`) |
| `src/docs/client.ts` | Wrapper REST sur l'API Django Docs (lister, métadonnées, vérification publique) |
| `src/docs/connection.ts` | Sous-classe `ws.WebSocket` qui injecte les en-têtes Origin et Cookie |
| `src/docs/session.ts` | Cache `Map<DocumentId, OpenYjsSession>`, sync initial, GC TTL, opérations métier |
| `src/docs/blocks.ts` | Conversion bidirectionnelle entre `Y.XmlFragment` BlockNote et la liste JSON aplatie |

Chaque fichier a une responsabilité unique. `server.ts` ne touche pas à Yjs, `connection.ts` ne fait pas de parsing, `blocks.ts` ne fait pas de réseau. Cette séparation rend chaque unité testable indépendamment et évite que la complexité Yjs ne contamine le reste du code.

---

## 3. Les quatre obstacles techniques du WebSocket Hocuspocus

C'est **le cœur** du projet, la valeur ajoutée par rapport à un appel REST simple. Le serveur de collaboration Hocuspocus de la-suite Docs impose quatre contrôles peu documentés au handshake WebSocket. Tomber sur un seul de ces obstacles renvoie un message d'erreur générique (souvent `4001 Origin not allowed`) qui ne donne aucune piste sur la véritable cause. Les voici, dans l'ordre où ils sont rencontrés.

### 3.1. Origin contrôlée

Le middleware `wsSecurity` du paquet `y-provider` côté Docs vérifie que l'en-tête HTTP `Origin` est dans une liste autorisée (`COLLABORATION_SERVER_ORIGIN`). Sans cet en-tête, ou avec une autre valeur, le serveur ferme avec `4001 Origin not allowed`.

Le client `ws` de Node ne définit pas l'`Origin` par défaut (contrairement au navigateur). Il faut le forcer explicitement.

```ts
// connection.ts
super(address, protocols, {
  origin: expectedOrigin,  // dérivée de DOCS_INSTANCE_URL
  ...
});
```

### 3.2. Cookie obligatoire (même pour un doc public)

Le même middleware exige qu'un en-tête `Cookie` quelconque soit présent. Sans cookie, le serveur ferme avec `4001 No cookies` — y compris pour des documents `link_reach: "public"` que personne n'a besoin d'authentifier.

La valeur du cookie n'est pas validée pour les docs publics. Un cookie bidon suffit.

```ts
// connection.ts
super(address, protocols, {
  origin: expectedOrigin,
  headers: {
    Cookie: 'docs_sessionid=anonymous-bot',  // suffit pour les docs publics
  },
});
```

### 3.3. Token Hocuspocus dummy

Le client `HocuspocusProvider` n'envoie un message `AuthenticationMessage` au serveur **que si** un `token` est défini dans sa config. Sans token, la connexion WebSocket s'établit (handshake OK), mais la synchronisation Yjs ne démarre jamais : le serveur reste en attente de l'auth, le client n'envoie rien, deadlock silencieux.

Le serveur Docs ne valide pas la valeur du token (pas de hook `onAuthenticate` côté serveur). N'importe quelle string non-vide débloque le sync.

```ts
// session.ts
new HocuspocusProvider({
  websocketProvider,
  name: documentIdentifier,
  document: yjsDocument,
  token: 'notoken',  // contenu sans importance, juste déclencheur d'AuthenticationMessage
});
```

### 3.4. `WebSocketPolyfill` ignoré sur `HocuspocusProvider`

Le piège le plus subtil. La signature naïve `new HocuspocusProvider({ url, name, WebSocketPolyfill, ... })` accepte `WebSocketPolyfill` sans broncher, mais ne le forwarde pas. La méthode `setConfiguration` de `HocuspocusProvider` crée silencieusement un sous-`HocuspocusProviderWebsocket` interne en passant **uniquement** `url`, `connect` et `parameters`. Le `WebSocketPolyfill` est perdu, et la connexion utilise le `WebSocket` natif de Node — sans Origin ni Cookie. Retour à l'erreur `4001 Origin not allowed`.

La solution : instancier soi-même le `HocuspocusProviderWebsocket`, et le passer via `websocketProvider` :

```ts
// session.ts
const websocketProvider = new HocuspocusProviderWebsocket({
  url: websocketUrl,
  WebSocketPolyfill: this.docsWebSocketClass as unknown as typeof WebSocket,
});

const hocuspocusProvider = new HocuspocusProvider({
  websocketProvider,  // pré-construit avec le polyfill correct
  name: documentIdentifier,
  document: yjsDocument,
  token: 'notoken',
});
```

---

## 4. Décisions architecturales

### 4.1. Node.js plutôt que Python

Le SDK officiel d'Hocuspocus n'existe qu'en JavaScript / TypeScript. Implémenter le protocole binaire Hocuspocus à la main en Python (varint, sync messages, awareness) serait faisable mais coûteux et fragile, alors que le SDK Node fonctionne « clé en main ». Le SDK MCP officiel (`@modelcontextprotocol/sdk`) est aussi disponible en Node, ce qui rend la stack cohérente.

### 4.2. Connexion persistante avec cache TTL

Trois approches étaient possibles pour gérer les connexions WebSocket :

- **A. Connexion persistante** — ouvrir une fois, garder en cache, réutiliser pour les ops suivantes
- **B. Connexion éphémère** — ouvrir / sync / op / fermer, à chaque tool call
- **C. REST PATCH `/content/`** — pas de WebSocket, on récupère le blob Yjs via REST et on le réécrit

L'approche A a été retenue. Le sync initial coûte ~1 seconde (handshake + auth + state vector exchange). Si l'agent enchaîne 5 modifications sur le même doc, l'approche B paie ~5 secondes de latence cumulée et ouvre la porte à des conditions de concurrence (un autre client peut pousser un update entre nos GET et PATCH). L'approche C contourne complètement Yjs : pas de propagation aux clients live, et on écrase le travail concurrent d'un humain qui édite.

L'approche A est implémentée par `SessionManager` (`src/docs/session.ts`) avec :
- Une `Map<DocumentId, OpenYjsSession>` qui garde les sessions chaudes
- Un timer de garbage collection qui tourne toutes les 60 secondes
- Une session inactive depuis plus de `DOCS_SESSION_TTL_MS` (5 minutes par défaut) est fermée

Le timer utilise `setInterval(...).unref()` pour ne pas empêcher le process de se fermer.

### 4.3. Documents publics uniquement (en v1)

Pas d'authentification utilisateur. Le serveur MCP ne touche qu'aux documents avec `link_reach: "public"` et `link_role: "editor"`. La vérification est faite côté client (`DocsRestClient.assertPublicEditor`) **avant** d'ouvrir une connexion WebSocket — si un agent demande à éditer un doc privé, il reçoit `DocsError("DOC_NOT_PUBLIC")` immédiatement, sans avoir tenté de connexion.

Ce choix réduit drastiquement la surface : pas de gestion de cookie de session, pas d'OIDC, pas de refresh de token. Un cookie bidon (`docs_sessionid=anonymous-bot`) suffit pour tous les docs publics.

L'authentification utilisateur est explicitement marquée comme un objectif post-v1.

### 4.4. Édition au niveau du bloc, pas au niveau du caractère

La granularité minimale exposée à l'agent est le bloc-paragraphe (ou bloc-heading). Pas d'API pour insérer un mot après le 5ème caractère du paragraphe X. Trois raisons :

1. **Lisibilité pour l'agent** : un agent IA comprend mieux une opération « remplace le contenu du bloc `7a59...` par `<nouveau texte>` » qu'une opération « delete 23 caractères à partir de la position 41, puis insert <texte> ».
2. **Compatibilité CRDT** : `replaceTextInElement` supprime tous les `Y.XmlText` existants du bloc et insère un seul nouveau `Y.XmlText`. Si un humain édite le même bloc en même temps, les deux modifications coexistent (texte concaténé / entrelacé selon les positions). On ne perd jamais de données.
3. **Simplicité de la surface MCP** : 6 tools au lieu de 12, signatures évidentes, validation zod minimale.

Si un agent veut une édition fine, il peut faire `read_document` → raisonner sur le contenu du bloc → `update_block` avec le nouveau texte complet.

### 4.5. UUID stable plutôt qu'index numérique

Chaque `blockContainer` BlockNote a un attribut `id` (UUID v4 généré à la création du bloc). C'est cet UUID qui est exposé à l'agent comme identifiant de bloc, et c'est cet UUID que l'agent utilise pour cibler un bloc dans `update_block` ou `delete_block`.

Pourquoi pas un index numérique (« le 3ème bloc ») ? Parce que dans un environnement multi-utilisateur, **les indices décalent**. Si l'agent lit le doc à T₀, voit que le bloc à éditer est à l'index 3, et qu'un humain insère un paragraphe au début à T₁, l'index 3 pointe maintenant sur le mauvais bloc. L'UUID, lui, reste valide tant que le bloc existe — c'est le contrat fondamental que Yjs garantit pour ses identifiants.

---

## 5. Le piège Yjs `_prelimAttrs`

C'est le piège le plus retors rencontré pendant l'implémentation. À documenter en gras parce qu'il n'est pas évident, qu'il provoque des bugs silencieux, et que typecheck + tests unitaires en mémoire **ne le détectent pas**.

### 5.1. Le bug

```ts
// Ce code semble correct mais retourne toujours une string vide
const container = new Y.XmlElement('blockContainer');
container.setAttribute('id', randomUUID());

const id = container.getAttribute('id');  // → undefined !
```

### 5.2. Pourquoi

Dans Yjs 13.6.x, un `Y.XmlElement` qui n'est pas (encore) intégré dans un `Y.Doc` stocke ses attributs dans un buffer interne `_prelimAttrs` et son contenu dans `_prelimContent`. Tant que l'élément n'est pas attaché à un parent qui appartient à un document, `getAttribute` retourne `undefined` et `toArray` retourne un tableau vide — **même si on vient juste d'appeler `setAttribute` ou `insert` sur lui**.

Plus violemment, certains accès jettent une exception explicite :
```
Invalid access: Add Yjs type to a document before reading data.
```

### 5.3. La règle

**Toute lecture d'attribut ou d'enfants doit suivre l'attachement au document.** Dans une transaction Yjs, faire `parent.insert(index, [child])` AVANT toute lecture sur `child`.

### 5.4. Exemple avant/après

```ts
// ❌ MAUVAIS — l'attribut est dans _prelimAttrs, getAttribute retourne undefined
ydoc.transact(() => {
  const container = buildBlockContainer(content);
  const id = container.getAttribute('id');     // undefined
  blockGroup.insert(0, [container]);
});

// ✅ BON — d'abord intégrer, puis lire
ydoc.transact(() => {
  const container = buildBlockContainer(content);
  blockGroup.insert(0, [container]);
  const id = container.getAttribute('id');     // OK
});
```

### 5.5. Où ça apparaît dans ce projet

Trois points de vigilance :

1. **`SessionManager.insertBlock` dans `src/docs/session.ts`** : la lecture de l'`id` du bloc fraîchement créé se fait **après** `topLevelBlockGroup.insert(...)`. Le commentaire en place rappelle pourquoi.
2. **Tests unitaires de `buildBlockContainer` dans `tests/blocks.test.ts`** : les tests qui vérifient les attributs du bloc fabriqué wrappent les assertions dans un `Y.Doc.transact()` qui insère le bloc dans un `blockGroup` rattaché au fragment, AVANT les `expect`.
3. **`findBlockContainerById` dans `src/docs/blocks.ts`** : ne pose pas de problème car il opère sur des blocs **déjà** dans le document (lus depuis un fragment synchronisé).

### 5.6. Le faux ami : typecheck et tests-en-mémoire passent malgré le bug

Le plus dangereux : ce bug **ne casse pas** le typecheck (Yjs déclare le retour de `getAttribute` comme `string | undefined`, donc `?? ''` est techniquement correct), et il peut passer inaperçu dans des tests unitaires si on ne pense pas à tester le chemin réseau. Le seul moyen sûr de le détecter est un test d'intégration avec une vraie session Yjs synchronisée.

---

## 6. Conventions de code

Le projet suit le style **FALC** (Facile A Lire et Comprendre), inspiré du skill `djc` adapté au contexte Node/TypeScript :

- **Variables verbeuses** : `currentDocumentSession` plutôt que `s`, `blockToInsertContent` plutôt que `c`. Aucune abréviation cryptique.
- **For loops simples** plutôt que des chaînes `.map().filter().reduce()` à plusieurs niveaux. Le code se lit linéairement.
- **TypeScript strict** : pas de `any`, types nommés en haut du fichier, `unknown` pour les valeurs externes.
- **Pas d'abstractions prématurées** : 3 occurrences identiques avant de factoriser. Trois `if` similaires valent mieux qu'un dispatcher générique précoce.
- **Une responsabilité par fichier** : `connection.ts` ne fait pas de parsing, `blocks.ts` ne fait pas de réseau, `server.ts` ne fait pas de logique métier.
- **Commentaires bilingues FR / EN** : header obligatoire en haut de chaque module avec une description FR détaillée, une ligne EN one-liner, un marqueur `LOCALISATION : <chemin>`, et une section `FLUX :` ou `COMMUNICATION :` quand pertinent.
- **Erreurs typées** : la classe `DocsError` enveloppe un code (`DOC_NOT_FOUND`, `DOC_NOT_PUBLIC`, `BLOCK_NOT_FOUND`, ...) que `server.ts` traduit en réponse MCP structurée. Pas de `Error("oops")` générique.

Pourquoi ces règles ? Pour que le code reste lisible par un développeur qui n'a pas le contexte de la session de construction, et pour que les agents IA qui modifient le projet à l'avenir puissent raisonner localement sans avoir à charger toute la codebase en contexte.

---

## 7. Comment ce projet a été construit

Ce projet a été construit en une session avec [Claude Code](https://docs.claude.com/en/docs/claude-code) en suivant le framework [Superpowers](https://github.com/anthropics/skills) :

1. **Brainstorming** — exploration du contexte (codebase Docs, proof of concept Hocuspocus), clarification des requirements (scope, granularité, auth, format), proposition de 3 approches architecturales avec trade-offs.
2. **Spec** — rédaction du design détaillé sauvegardé dans [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](superpowers/specs/2026-05-08-docs-mcp-design.md), revue interne et validation par l'utilisateur.
3. **Plan** — décomposition en 12 tâches bite-sized avec tests-first sauvegardée dans [`docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`](superpowers/plans/2026-05-08-docs-mcp-implementation.md).
4. **Implémentation** — chaque tâche dispatchée à un sub-agent indépendant (modèle Sonnet ou Haiku selon complexité), suivie d'une revue de conformité au spec et d'une revue de qualité du code par d'autres sub-agents.
5. **Final review** — un sub-agent à plus grand contexte revoit l'ensemble pour cohérence inter-fichiers et gaps avec la spec.
6. **Test d'intégration live** — exécution du scénario read → insert → update → delete contre une instance réelle (`notes.liiib.re`).

Cette approche a deux avantages :
- Chaque sub-agent a un contexte propre et focalisé sur sa tâche, ce qui améliore la qualité du code produit
- Les revues automatisées détectent les déviations du spec avant qu'elles ne s'accumulent

Elle a aussi mis en évidence des limites à connaître : un piège technique récurrent peut être corrigé dans les tests sans être corrigé dans le code de production (cas du piège `_prelimAttrs` ci-dessus), parce que chaque sub-agent travaille dans son périmètre. C'est pour ça qu'un test d'intégration end-to-end contre une vraie instance reste indispensable, même quand toutes les revues sub-agent ont passé.

---

## 8. Pour aller plus loin

**Ressources internes :**
- [`README.md`](../README.md) — install, configuration, usage avec Claude Desktop
- [`CHANGELOG.md`](../CHANGELOG.md) — historique des versions
- [`A TESTER ET DOCUMENTER/`](../A%20TESTER%20ET%20DOCUMENTER/) — scénarios de test manuel par feature
- [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](superpowers/specs/2026-05-08-docs-mcp-design.md) — spec validée
- [`docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`](superpowers/plans/2026-05-08-docs-mcp-implementation.md) — plan d'implémentation

**Ressources externes :**
- [la-suite Docs](https://github.com/suitenumerique/docs) — l'éditeur cible
- [Yjs](https://docs.yjs.dev/) — le CRDT sous-jacent
- [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction) — le serveur de collaboration WebSocket
- [BlockNote](https://www.blocknotejs.org/) — l'éditeur de blocs utilisé par Docs (XML schema)
- [Model Context Protocol](https://modelcontextprotocol.io/) — la spec du protocole MCP
