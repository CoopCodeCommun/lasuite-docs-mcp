# lasuite-docs-mcp

Serveur **Model Context Protocol (MCP)** qui permet à un agent IA de lire et d'éditer des documents sur une instance [la-suite Docs](https://github.com/suitenumerique/docs), avec édition fine au niveau du paragraphe et compatibilité temps réel avec les éditeurs humains connectés.

## Statut

v0.3.0 — support du **markdown inline** sur les opérations d'édition (`**gras**`, `*italique*`, `` `code` ``, `~~barré~~`, `[lien](url)`), avec round-trip markdown sur `read_document`. Hérite de la v0.2.0 : authentification utilisateur (cookies de session + CSRF) et détection dynamique de l'instance. **16 tools** : lecture (incluant l'arborescence des descendants), édition de contenu en markdown, gestion de l'arborescence, authentification.

## Tools MCP exposés

### Lecture

| Tool | Usage |
|---|---|
| `list_documents` | Liste les docs publics de l'instance |
| `read_document` | Lit la liste structurée des paragraphes/headings |
| `get_document_metadata` | Récupère les métadonnées (titre, dates, accès) |
| `list_document_children` | Enfants directs d'un document (1 niveau) |
| `list_document_descendants` | Tous les descendants à plat (récursif, `max_depth` borné). Sans parent → tous les docs accessibles à l'utilisateur. |

### Édition de contenu

| Tool | Usage |
|---|---|
| `insert_block` | Insère un paragraphe ou heading. Le `text` est interprété comme du **markdown inline** (gras, italique, code, strike, liens) |
| `update_block` | Modifie le texte d'un bloc existant. Idem : markdown inline supporté |
| `delete_block` | Supprime un bloc |

**Format markdown supporté** sur les paramètres `text` de `insert_block` et `update_block` :

| Markdown | Rendu BlockNote |
|---|---|
| `**gras**` | **gras** |
| `*italique*` | *italique* |
| `` `code` `` | `code` (police mono, fond gris) |
| `~~barré~~` | ~~barré~~ |
| `[texte](url)` | [texte](url) (lien cliquable) |
| `\*` `\_` `\`` etc. | Caractères littéraux échappés |

`read_document` retourne le contenu en markdown : un agent peut lire un bloc, modifier la chaîne markdown, et la réinjecter via `update_block` sans perte (round-trip propre).

### Authentification

| Tool | Usage |
|---|---|
| `set_session_credentials` | Enregistre `docs_sessionid` + `csrftoken` en mémoire (optionnel : settle l'instance) |
| `clear_session_credentials` | Vide les credentials (conserve l'instance) |

### Gestion de l'arborescence

| Tool | Usage |
|---|---|
| `create_document` | Crée un doc top-level ou un sous-doc (`parent_id`) |
| `delete_document` | Supprime un doc (cascade sur les sous-docs) |
| `move_document` | Déplace un doc dans l'arborescence |
| `duplicate_document` | Duplique un doc (optionnel : avec les accès) |
| `update_document_title` | Renomme un doc |
| `list_my_documents` | Liste les docs accessibles à l'utilisateur connecté |

## Installation

**Prérequis :** Node.js ≥ 20 (le projet utilise ESM NodeNext et `top-level await`).

```bash
git clone https://github.com/CoopCodeCommun/lasuite-docs-mcp.git
cd lasuite-docs-mcp
npm install
npm run build
```

Vérification rapide après build :

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js | head -c 300
```

Doit retourner un JSON-RPC listant les 16 tools.

## Configuration

Variables d'environnement :

| Variable | Défaut | Description |
|---|---|---|
| `DOCS_INSTANCE_URL` | — | URL HTTPS de l'instance Docs. **Optionnelle en v0.2** : l'instance est détectée automatiquement depuis les liens `doc_url` passés aux tools. Utile pour forcer une instance dès le démarrage (compat v0.1). |
| `DOCS_SESSION_TTL_MS` | `300000` | TTL des sessions WebSocket en cache |
| `DOCS_SYNC_TIMEOUT_MS` | `10000` | Timeout du sync initial Yjs |

Voir `.env.example`.

## Authentification utilisateur (v0.2)

Les tools de gestion de l'arborescence (`create_document`, `delete_document`, etc.) et `list_my_documents` nécessitent un cookie de session valide. Le flow est le suivant :

1. L'agent tente une opération d'écriture.
2. Le serveur retourne `{code: "AUTH_REQUIRED", ...}` avec les instructions pour récupérer les cookies.
3. L'utilisateur ouvre les DevTools de son navigateur sur l'instance Docs cible :
   - **Chrome / Edge / Brave** : F12 → onglet « Application » → « Cookies » → URL de l'instance → copier les valeurs de `docs_sessionid` et `csrftoken`.
   - **Firefox** : F12 → onglet « Stockage » → « Cookies » → URL de l'instance → copier les valeurs.
   - Note : `docs_sessionid` est marqué `HttpOnly`, il n'est visible que depuis les DevTools, pas depuis la console JavaScript.
4. L'utilisateur appelle `set_session_credentials({docs_sessionid: "...", csrftoken: "..."})`.
5. L'agent retente l'opération.

Les credentials expirent ~12h après la connexion. Ils sont stockés **uniquement en mémoire** (jamais écrits sur disque, jamais inclus dans les réponses des tools).

## Installation dans un client MCP

Remplace `/chemin/absolu/vers/lasuite-docs-mcp` par le chemin réel sur ta machine. `DOCS_INSTANCE_URL` est optionnelle (cf. section [Configuration](#configuration)).

### Claude Code (CLI Anthropic)

Le plus rapide, via la commande CLI :

```bash
# Disponible dans toutes tes sessions (recommandé pour un usage personnel)
claude mcp add --transport stdio --scope user lasuite-docs \
  -- node /chemin/absolu/vers/lasuite-docs-mcp/dist/server.js

# Avec une instance par défaut
claude mcp add --transport stdio --scope user \
  --env DOCS_INSTANCE_URL=https://notes.liiib.re \
  lasuite-docs -- node /chemin/absolu/vers/lasuite-docs-mcp/dist/server.js

# Limité à un projet précis (créera .mcp.json à la racine du projet)
claude mcp add --transport stdio --scope project lasuite-docs \
  -- node /chemin/absolu/vers/lasuite-docs-mcp/dist/server.js
```

Ou directement en JSON dans `~/.claude.json` (user) ou `.mcp.json` (project) :

```json
{
  "mcpServers": {
    "lasuite-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["/chemin/absolu/vers/lasuite-docs-mcp/dist/server.js"],
      "env": {
        "DOCS_INSTANCE_URL": "https://notes.liiib.re"
      }
    }
  }
}
```

### Claude Desktop

Dans `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), ou équivalent Linux :

```json
{
  "mcpServers": {
    "lasuite-docs": {
      "command": "node",
      "args": ["/chemin/absolu/vers/lasuite-docs-mcp/dist/server.js"],
      "env": {
        "DOCS_INSTANCE_URL": "https://notes.liiib.re"
      }
    }
  }
}
```

Redémarre Claude Desktop pour que la modif soit prise en compte.

### OpenCode

Dans `~/.config/opencode/opencode.json` (user) ou `./opencode.json` (project) :

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lasuite-docs": {
      "type": "local",
      "command": ["node", "/chemin/absolu/vers/lasuite-docs-mcp/dist/server.js"],
      "enabled": true,
      "environment": {
        "DOCS_INSTANCE_URL": "https://notes.liiib.re"
      }
    }
  }
}
```

Note : OpenCode utilise `command` comme tableau (pas `command` + `args` séparés) et `environment` (pas `env`).

### Premier usage

Une fois l'installation faite et le client redémarré, tu peux demander à l'agent : « Lis le doc `https://notes.liiib.re/docs/<UUID>/` et insère un paragraphe au milieu » — l'instance est extraite automatiquement du lien.

## Tests

```bash
npm test                        # Tests unitaires (vitest)
npm run test:integration        # Test e2e lecture (nécessite DOCS_INTEGRATION_DOC_ID)
npm run test:integration:auth   # Test e2e écriture auth (nécessite DOCS_INSTANCE_URL, DOCS_INTEGRATION_SESSIONID, DOCS_INTEGRATION_CSRFTOKEN)
npm run typecheck               # TypeScript check
```

## Architecture & contribuer

- [`docs/architecture.md`](docs/architecture.md) — guide architecture & développement : choix techniques, les 4 obstacles du WebSocket Hocuspocus, le piège Yjs `_prelimAttrs`, authentification v0.2. **Lire en premier** avant de modifier le code.
- [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](docs/superpowers/specs/2026-05-08-docs-mcp-design.md) — spec validée du design v0.1
- [`docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`](docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md) — plan d'implémentation v0.1
- [`docs/superpowers/plans/2026-05-08-docs-mcp-v0.2-implementation.md`](docs/superpowers/plans/2026-05-08-docs-mcp-v0.2-implementation.md) — plan d'implémentation v0.2
- [`A TESTER ET DOCUMENTER/`](A%20TESTER%20ET%20DOCUMENTER/) — scénarios de test manuel par feature
- [`CHANGELOG.md`](CHANGELOG.md) — historique bilingue FR/EN

## Licence

MIT — Coopérative Code Commun
