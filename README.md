# lasuite-docs-mcp

Serveur **Model Context Protocol (MCP)** qui permet à un agent IA de lire et d'éditer des documents publics sur une instance [la-suite Docs](https://github.com/suitenumerique/docs), avec édition fine au niveau du paragraphe et compatibilité temps réel avec les éditeurs humains connectés.

## Statut

v0.1.0 — édition fine de docs publics uniquement (`link_reach: "public"`, `link_role: "editor"`). Pas d'authentification utilisateur.

## Tools MCP exposés

| Tool | Usage |
|---|---|
| `list_documents` | Liste les docs publics de l'instance |
| `read_document` | Lit la liste structurée des paragraphes/headings |
| `insert_block` | Insère un paragraphe ou heading à un endroit précis |
| `update_block` | Modifie le texte d'un bloc existant |
| `delete_block` | Supprime un bloc |
| `get_document_metadata` | Récupère les métadonnées (titre, dates, accès) |

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
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js | head -c 200
```

Doit retourner un JSON-RPC listant les 6 tools.

## Configuration

Variables d'environnement :

| Variable | Défaut | Description |
|---|---|---|
| `DOCS_INSTANCE_URL` | `https://notes.liiib.re` | URL HTTPS de l'instance Docs |
| `DOCS_SESSION_TTL_MS` | `300000` | TTL des sessions WebSocket en cache |
| `DOCS_SYNC_TIMEOUT_MS` | `10000` | Timeout du sync initial Yjs |

Voir `.env.example`.

## Usage avec Claude Desktop

Dans `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou équivalent :

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

Redémarre Claude Desktop, et tu peux demander : « Lis le doc `<UUID>` et insère un paragraphe au milieu ».

## Tests

```bash
npm test                    # Tests unitaires (vitest)
npm run test:integration    # Test e2e manuel (nécessite DOCS_INTEGRATION_DOC_ID)
npm run typecheck           # TypeScript check
```

## Architecture & contribuer

- [`docs/architecture.md`](docs/architecture.md) — guide architecture & développement : choix techniques, les 4 obstacles du WebSocket Hocuspocus, le piège Yjs `_prelimAttrs`, conventions de code. **Lire en premier** avant de modifier le code.
- [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](docs/superpowers/specs/2026-05-08-docs-mcp-design.md) — spec validée du design v1
- [`docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`](docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md) — plan d'implémentation (12 tâches)
- [`A TESTER ET DOCUMENTER/`](A%20TESTER%20ET%20DOCUMENTER/) — scénarios de test manuel par feature
- [`CHANGELOG.md`](CHANGELOG.md) — historique bilingue FR/EN

## Licence

MIT — Coopérative Code Commun
