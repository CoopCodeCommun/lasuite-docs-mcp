# lasuite-docs-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node/TypeScript MCP server that exposes 5 tools (list_documents, read_document, insert_block, update_block, delete_block) for an AI agent to read and edit individual paragraphs of public Docs (la-suite) documents in real-time, via the Hocuspocus WebSocket.

**Architecture:** stdio MCP server. Cache `Map<docId, YjsSession>` of persistent Hocuspocus connections with 5-minute TTL garbage collection. Each tool routes through `session.ts` which exposes block-level operations (read/insert/update/delete) on top of the cached `Y.Doc`. `blocks.ts` translates between `Y.XmlFragment` (BlockNote layout) and a flat `[{id, type, text}]` JSON format. Origin and Cookie headers are injected via a custom `DocsWebSocket` class wrapping `ws`.

**Tech Stack:** Node.js 20+, TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk`, `@hocuspocus/provider`, `yjs`, `ws`, `zod` (input validation), `vitest` (unit tests).

---

## File Structure

Files this plan creates or modifies:

```
lasuite-docs-mcp/
├── package.json                                       # NEW — deps + scripts
├── tsconfig.json                                      # NEW — strict TS, ESM NodeNext
├── vitest.config.ts                                   # NEW — vitest config
├── .gitignore                                         # NEW — node_modules, dist, .env
├── .env.example                                       # NEW — DOCS_INSTANCE_URL etc.
├── README.md                                          # NEW — install + config + usage
├── CHANGELOG.md                                       # NEW — bilingual format djc
├── A TESTER ET DOCUMENTER/
│   └── insertion-paragraphes.md                       # NEW — manual test scenarios
├── src/
│   ├── server.ts                                      # NEW — MCP entrypoint, tool routing
│   ├── types.ts                                       # NEW — shared types
│   └── docs/
│       ├── client.ts                                  # NEW — REST wrapper
│       ├── connection.ts                              # NEW — DocsWebSocket
│       ├── session.ts                                 # NEW — Yjs session cache + ops
│       └── blocks.ts                                  # NEW — fragment ↔ JSON
└── tests/
    ├── blocks.test.ts                                 # NEW — unit tests
    └── integration.test.ts                            # NEW — manual e2e script
```

The legacy proof scripts (`demo.js`, `probe.js`, `probe2.js`, the existing `package.json` and `package-lock.json`) are removed in Task 1 to start clean — they served their purpose and remain accessible via git history.

---

## Convention notes (apply to every task)

- **Bilingual FR/EN headers** at the top of every TypeScript module (style djc adapted to TS — see Section 7 of the spec).
- **Verbose variable names** : `currentDocumentSession`, not `s` ; `blockToInsertContent`, not `c`.
- **One commit per task** unless explicitly noted otherwise. Commit messages are bilingual : `feat(blocks): add xmlFragmentToBlocks / extract block list from Yjs fragment`.
- **No `git push`, no `git commit --no-verify`, no destructive git ops without explicit user OK** (cf. user's global CLAUDE.md).
- **TDD strict** : write the failing test first, run it, then write the minimal implementation, run again to confirm green, commit.

---

## Task 1: Project bootstrap (clean slate + TypeScript)

**Files:**
- Delete: `demo.js`, `probe.js`, `probe2.js`, `package.json`, `package-lock.json`, `node_modules/`
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `vitest.config.ts`, `src/.gitkeep`, `tests/.gitkeep`

- [ ] **Step 1: Remove legacy proof files**

```bash
cd /home/jonas/Gits/lasuite-docs-mcp
rm -f demo.js probe.js probe2.js package.json package-lock.json
rm -rf node_modules
ls
# Should show: LICENSE, docs/
```

- [ ] **Step 2: Create `.gitignore`**

```
# Dependencies / Dépendances
node_modules/

# Build output / Sortie de build
dist/

# Environment / Variables d'environnement
.env

# IDE / Éditeurs
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db

# Test artifacts / Artefacts de tests
coverage/
*.log
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "lasuite-docs-mcp",
  "version": "0.1.0",
  "description": "MCP server pour lire et éditer des documents la-suite Docs / MCP server to read and edit la-suite Docs documents",
  "license": "MIT",
  "type": "module",
  "bin": {
    "lasuite-docs-mcp": "./dist/server.js"
  },
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "tsx tests/integration.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@hocuspocus/provider": "^2.13.5",
    "yjs": "^13.6.18",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
/**
 * Configuration vitest pour les tests unitaires.
 * / Vitest config for unit tests.
 *
 * LOCALISATION : vitest.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 6: Create `.env.example`**

```
# URL de l'instance Docs cible (https). Le WebSocket est dérivé : wss://<host>/collaboration/ws/
# / Target Docs instance URL. The WebSocket is derived from this.
DOCS_INSTANCE_URL=https://notes.liiib.re

# Durée d'inactivité avant fermeture d'une session WebSocket en cache (ms).
# / Inactivity time before closing a cached session.
DOCS_SESSION_TTL_MS=300000

# Délai max d'attente du sync initial (ms). Au-delà, retourne SYNC_TIMEOUT.
# / Max wait for initial sync.
DOCS_SYNC_TIMEOUT_MS=10000

# UUID d'un doc public dédié pour `npm run test:integration`.
# / UUID of a public doc dedicated to integration tests.
DOCS_INTEGRATION_DOC_ID=
```

- [ ] **Step 7: Create empty `src/.gitkeep` and `tests/.gitkeep`**

```bash
mkdir -p src tests
touch src/.gitkeep tests/.gitkeep
```

- [ ] **Step 8: Install dependencies and verify**

```bash
npm install
npm run typecheck
```

Expected: `npm install` completes without errors. `npm run typecheck` passes (empty src dir, no errors).

- [ ] **Step 9: Commit**

```bash
git add .gitignore .env.example package.json package-lock.json tsconfig.json vitest.config.ts src/.gitkeep tests/.gitkeep
git rm -f demo.js probe.js probe2.js
git commit -m "$(cat <<'EOF'
chore: bootstrap TypeScript MCP project / amorce projet TypeScript MCP

Replaces the proof-of-concept scripts with a TypeScript scaffold using
ESM NodeNext, vitest, and the planned dependency set.
/ Remplace les scripts de proof-of-concept par un échafaudage TypeScript
avec ESM NodeNext, vitest, et l'ensemble des dépendances planifiées.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
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
```

- [ ] **Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: PASS, no output.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "$(cat <<'EOF'
feat(types): add shared types and DocsError class / ajoute les types partagés

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `blocks.ts` — fragment to blocks (read direction)

**Files:**
- Create: `src/docs/blocks.ts` (partial — `xmlFragmentToBlocks` only)
- Test: `tests/blocks.test.ts`

- [ ] **Step 1: Write the failing test for an empty fragment**

Create `tests/blocks.test.ts`:

```ts
/**
 * Tests unitaires pour blocks.ts.
 * / Unit tests for blocks.ts.
 *
 * LOCALISATION : tests/blocks.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { xmlFragmentToBlocks } from '../src/docs/blocks.js';

describe('xmlFragmentToBlocks', () => {
  it('should return an empty array for an empty fragment', () => {
    // Arrange : doc Yjs vide / Empty Yjs doc
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');

    // Act : extraction de la liste de blocs / Extract the block list
    const extractedBlocks = xmlFragmentToBlocks(documentFragment);

    // Assert : aucun bloc / No block
    expect(extractedBlocks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL with `Cannot find module '../src/docs/blocks.js'` or similar.

- [ ] **Step 3: Write minimal `src/docs/blocks.ts`**

```ts
/**
 * Conversion entre Y.XmlFragment (structure BlockNote interne) et la
 * représentation aplatie [{id, type, text}] exposée à l'agent MCP.
 * / Conversion between Y.XmlFragment (BlockNote internal structure) and
 * the flat [{id, type, text}] representation exposed to the MCP agent.
 *
 * LOCALISATION : src/docs/blocks.ts
 *
 * BlockNote stocke un document sous la forme :
 *   <blockGroup>
 *     <blockContainer id="..." backgroundColor="default" textColor="default">
 *       <paragraph backgroundColor="..." textColor="..." textAlignment="left">
 *         <Y.XmlText>Contenu textuel</Y.XmlText>
 *       </paragraph>
 *     </blockContainer>
 *     ...
 *   </blockGroup>
 *
 * Ce module masque cette complexité à l'agent en exposant des Block JSON simples.
 *
 * COMMUNICATION :
 * Importé par : session.ts (pour read et les ops d'édition).
 */

import * as Y from 'yjs';
import type { Block } from '../types.js';

/**
 * Extrait la liste plate des blocs d'un Y.XmlFragment BlockNote.
 * / Extracts the flat list of blocks from a BlockNote Y.XmlFragment.
 *
 * Si le fragment est vide ou ne contient pas de blockGroup top-level,
 * retourne un tableau vide.
 * / If the fragment is empty or has no top-level blockGroup, returns [].
 *
 * @param documentFragment - Le Y.XmlFragment nommé "document-store"
 * @returns Liste plate des blocs avec leur id, type et texte
 */
export function xmlFragmentToBlocks(
  documentFragment: Y.XmlFragment,
): Block[] {
  // Cherche le blockGroup top-level. S'il n'existe pas, doc vide.
  // / Find top-level blockGroup. If absent, doc is empty.
  const topLevelBlockGroup = findTopLevelBlockGroup(documentFragment);
  if (!topLevelBlockGroup) {
    return [];
  }

  // Itère sur chaque blockContainer enfant et le convertit en Block.
  // / Iterate over each blockContainer child and convert to Block.
  const blockList: Block[] = [];
  for (const childElement of topLevelBlockGroup.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName === 'blockContainer'
    ) {
      const convertedBlock = blockContainerToBlock(childElement);
      if (convertedBlock) {
        blockList.push(convertedBlock);
      }
    }
  }
  return blockList;
}

/**
 * Trouve le premier élément blockGroup au niveau racine du fragment.
 * / Finds the first top-level blockGroup element in the fragment.
 */
function findTopLevelBlockGroup(
  documentFragment: Y.XmlFragment,
): Y.XmlElement | null {
  for (const childElement of documentFragment.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName === 'blockGroup'
    ) {
      return childElement;
    }
  }
  return null;
}

/**
 * Convertit un Y.XmlElement de type blockContainer en Block JSON.
 * Retourne null si le bloc n'a pas d'attribut id (cas anormal).
 * / Converts a blockContainer Y.XmlElement to a JSON Block.
 */
function blockContainerToBlock(
  blockContainerElement: Y.XmlElement,
): Block | null {
  const blockIdentifier = blockContainerElement.getAttribute('id');
  if (!blockIdentifier) {
    return null;
  }

  // Le premier enfant non-blockGroup est le block content (paragraph, heading, ...).
  // / The first non-blockGroup child is the block content.
  const blockContentElement = findBlockContentChild(blockContainerElement);
  if (!blockContentElement) {
    return { id: blockIdentifier, type: 'unknown', text: '' };
  }

  // Extrait le texte concaténé de tous les Y.XmlText enfants.
  // / Concatenate text from all Y.XmlText children.
  const concatenatedText = extractTextFromElement(blockContentElement);

  const blockNodeName = blockContentElement.nodeName;
  if (blockNodeName === 'paragraph') {
    return { id: blockIdentifier, type: 'paragraph', text: concatenatedText };
  }
  if (blockNodeName === 'heading') {
    const levelAttribute = blockContentElement.getAttribute('level');
    const headingLevel = parseHeadingLevel(levelAttribute);
    return {
      id: blockIdentifier,
      type: 'heading',
      level: headingLevel,
      text: concatenatedText,
    };
  }

  // Type inconnu en v1 : on expose l'id et le texte pour que l'agent
  // puisse au moins le voir, sans pouvoir l'éditer.
  // / Unknown type in v1: expose id and text so the agent can see it.
  return { id: blockIdentifier, type: 'unknown', text: concatenatedText };
}

/**
 * Trouve le premier enfant qui n'est pas un blockGroup imbriqué.
 * / Finds the first child that is not a nested blockGroup.
 */
function findBlockContentChild(
  blockContainerElement: Y.XmlElement,
): Y.XmlElement | null {
  for (const childElement of blockContainerElement.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName !== 'blockGroup'
    ) {
      return childElement;
    }
  }
  return null;
}

/**
 * Concatène le texte de tous les Y.XmlText enfants d'un élément.
 * / Concatenates text from all Y.XmlText children of an element.
 */
function extractTextFromElement(parentElement: Y.XmlElement): string {
  let concatenatedText = '';
  for (const childNode of parentElement.toArray()) {
    if (childNode instanceof Y.XmlText) {
      concatenatedText += childNode.toString();
    }
  }
  return concatenatedText;
}

/**
 * Parse l'attribut level d'un heading. Retourne 1, 2, ou 3.
 * Default 1 si l'attribut est absent ou invalide.
 * / Parses heading level attribute. Returns 1, 2, or 3.
 */
function parseHeadingLevel(rawLevelAttribute: string | undefined): 1 | 2 | 3 {
  if (rawLevelAttribute === '2') return 2;
  if (rawLevelAttribute === '3') return 3;
  return 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test
```

Expected: PASS (1 test).

- [ ] **Step 5: Add test for paragraph + heading extraction**

Append to `tests/blocks.test.ts`:

```ts
  it('should extract paragraph and heading blocks with their ids and text', () => {
    // Arrange : doc avec un paragraphe et un heading h2
    // / Doc with one paragraph and one h2 heading
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');

    yjsDocument.transact(() => {
      const blockGroup = new Y.XmlElement('blockGroup');

      const paragraphContainer = new Y.XmlElement('blockContainer');
      paragraphContainer.setAttribute('id', 'P1');
      const paragraphElement = new Y.XmlElement('paragraph');
      const paragraphText = new Y.XmlText();
      paragraphText.insert(0, 'Bonjour le monde');
      paragraphElement.insert(0, [paragraphText]);
      paragraphContainer.insert(0, [paragraphElement]);

      const headingContainer = new Y.XmlElement('blockContainer');
      headingContainer.setAttribute('id', 'H1');
      const headingElement = new Y.XmlElement('heading');
      headingElement.setAttribute('level', '2');
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Section 1');
      headingElement.insert(0, [headingText]);
      headingContainer.insert(0, [headingElement]);

      blockGroup.insert(0, [paragraphContainer, headingContainer]);
      documentFragment.insert(0, [blockGroup]);
    });

    // Act
    const extractedBlocks = xmlFragmentToBlocks(documentFragment);

    // Assert
    expect(extractedBlocks).toEqual([
      { id: 'P1', type: 'paragraph', text: 'Bonjour le monde' },
      { id: 'H1', type: 'heading', level: 2, text: 'Section 1' },
    ]);
  });

  it('should mark unknown block types as type "unknown"', () => {
    // Arrange : un blockContainer avec un type non supporté (ex: callout)
    // / A blockContainer with an unsupported type (e.g. callout)
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');

    yjsDocument.transact(() => {
      const blockGroup = new Y.XmlElement('blockGroup');
      const calloutContainer = new Y.XmlElement('blockContainer');
      calloutContainer.setAttribute('id', 'C1');
      const calloutElement = new Y.XmlElement('callout');
      const calloutText = new Y.XmlText();
      calloutText.insert(0, 'Note importante');
      calloutElement.insert(0, [calloutText]);
      calloutContainer.insert(0, [calloutElement]);
      blockGroup.insert(0, [calloutContainer]);
      documentFragment.insert(0, [blockGroup]);
    });

    // Act
    const extractedBlocks = xmlFragmentToBlocks(documentFragment);

    // Assert
    expect(extractedBlocks).toEqual([
      { id: 'C1', type: 'unknown', text: 'Note importante' },
    ]);
  });
```

- [ ] **Step 6: Run tests to verify they all pass**

```bash
npm test
```

Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/docs/blocks.ts tests/blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(blocks): xmlFragmentToBlocks extracts BlockNote layout to flat JSON
/ extrait la structure BlockNote vers JSON plat

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `blocks.ts` — buildBlockContainer (write direction)

**Files:**
- Modify: `src/docs/blocks.ts` (add `buildBlockContainer`)
- Test: `tests/blocks.test.ts` (add test cases)

- [ ] **Step 1: Write the failing test for paragraph build**

Append to `tests/blocks.test.ts`:

```ts
import { buildBlockContainer } from '../src/docs/blocks.js';

describe('buildBlockContainer', () => {
  it('should build a paragraph blockContainer with proper attributes', () => {
    // Arrange / Act
    const builtBlockContainer = buildBlockContainer({
      type: 'paragraph',
      text: 'Hello world',
    });

    // Assert : c'est bien un blockContainer avec id, attrs et un paragraph dedans
    // / It is a blockContainer with id, attrs, and a paragraph inside
    expect(builtBlockContainer.nodeName).toBe('blockContainer');
    expect(builtBlockContainer.getAttribute('id')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(builtBlockContainer.getAttribute('backgroundColor')).toBe(
      'default',
    );
    expect(builtBlockContainer.getAttribute('textColor')).toBe('default');

    const innerElements = builtBlockContainer.toArray();
    expect(innerElements).toHaveLength(1);
    const paragraphElement = innerElements[0] as Y.XmlElement;
    expect(paragraphElement.nodeName).toBe('paragraph');
    expect(paragraphElement.getAttribute('textAlignment')).toBe('left');

    const paragraphText = paragraphElement.toArray()[0] as Y.XmlText;
    expect(paragraphText.toString()).toBe('Hello world');
  });

  it('should build a heading blockContainer with the level attribute', () => {
    // Arrange / Act
    const builtBlockContainer = buildBlockContainer({
      type: 'heading',
      level: 2,
      text: 'Titre',
    });

    // Assert
    expect(builtBlockContainer.nodeName).toBe('blockContainer');
    const innerElements = builtBlockContainer.toArray();
    const headingElement = innerElements[0] as Y.XmlElement;
    expect(headingElement.nodeName).toBe('heading');
    expect(headingElement.getAttribute('level')).toBe('2');
    const headingText = headingElement.toArray()[0] as Y.XmlText;
    expect(headingText.toString()).toBe('Titre');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `buildBlockContainer is not exported`.

- [ ] **Step 3: Add `buildBlockContainer` to `src/docs/blocks.ts`**

Append to `src/docs/blocks.ts` (after `xmlFragmentToBlocks` and helpers):

```ts
import { randomUUID } from 'node:crypto';
import type { BlockContent } from '../types.js';

/**
 * Construit un Y.XmlElement de type blockContainer prêt à être inséré
 * dans un blockGroup. L'id est généré automatiquement (UUID v4).
 * / Builds a blockContainer Y.XmlElement ready to be inserted into a
 * blockGroup. The id is auto-generated (UUID v4).
 *
 * Cette fonction ne touche pas au document ; elle construit l'élément
 * isolé. C'est l'appelant qui fait le `blockGroup.insert(...)` au sein
 * d'une `Y.Doc.transact()`.
 * / This function does not touch the document; it builds the element
 * in isolation. The caller does the `blockGroup.insert(...)` inside
 * a `Y.Doc.transact()`.
 *
 * @param blockContent - Le contenu désiré (paragraph ou heading + texte)
 * @returns Un Y.XmlElement blockContainer non encore attaché
 */
export function buildBlockContainer(
  blockContent: BlockContent,
): Y.XmlElement {
  // 1. Construit le blockContainer avec id et attributs visuels par défaut.
  // / Build the blockContainer with id and default visual attributes.
  const newBlockContainer = new Y.XmlElement('blockContainer');
  newBlockContainer.setAttribute('id', randomUUID());
  newBlockContainer.setAttribute('backgroundColor', 'default');
  newBlockContainer.setAttribute('textColor', 'default');

  // 2. Construit l'élément de contenu (paragraph ou heading).
  // / Build the content element (paragraph or heading).
  const contentElement = buildContentElement(blockContent);

  // 3. Insère le contenu dans le container.
  // / Insert content into the container.
  newBlockContainer.insert(0, [contentElement]);

  return newBlockContainer;
}

/**
 * Construit l'élément de contenu d'un bloc (paragraph ou heading).
 * / Builds the content element of a block (paragraph or heading).
 */
function buildContentElement(blockContent: BlockContent): Y.XmlElement {
  if (blockContent.type === 'paragraph') {
    const paragraphElement = new Y.XmlElement('paragraph');
    paragraphElement.setAttribute('backgroundColor', 'default');
    paragraphElement.setAttribute('textColor', 'default');
    paragraphElement.setAttribute('textAlignment', 'left');
    const paragraphText = new Y.XmlText();
    paragraphText.insert(0, blockContent.text);
    paragraphElement.insert(0, [paragraphText]);
    return paragraphElement;
  }

  // type === 'heading'
  const headingElement = new Y.XmlElement('heading');
  headingElement.setAttribute('backgroundColor', 'default');
  headingElement.setAttribute('textColor', 'default');
  headingElement.setAttribute('textAlignment', 'left');
  headingElement.setAttribute('level', String(blockContent.level));
  const headingText = new Y.XmlText();
  headingText.insert(0, blockContent.text);
  headingElement.insert(0, [headingText]);
  return headingElement;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS (5 tests total).

- [ ] **Step 5: Add a round-trip test**

Append to `tests/blocks.test.ts`:

```ts
describe('round-trip', () => {
  it('should round-trip paragraph and heading content via build + parse', () => {
    // Arrange
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');

    yjsDocument.transact(() => {
      const blockGroup = new Y.XmlElement('blockGroup');
      blockGroup.insert(0, [
        buildBlockContainer({ type: 'paragraph', text: 'Premier' }),
        buildBlockContainer({ type: 'heading', level: 1, text: 'Titre' }),
        buildBlockContainer({ type: 'paragraph', text: 'Dernier' }),
      ]);
      documentFragment.insert(0, [blockGroup]);
    });

    // Act
    const extractedBlocks = xmlFragmentToBlocks(documentFragment);

    // Assert : le contenu textuel et les types sont préservés.
    // / Text content and types are preserved.
    expect(extractedBlocks).toHaveLength(3);
    expect(extractedBlocks[0]).toMatchObject({
      type: 'paragraph',
      text: 'Premier',
    });
    expect(extractedBlocks[1]).toMatchObject({
      type: 'heading',
      level: 1,
      text: 'Titre',
    });
    expect(extractedBlocks[2]).toMatchObject({
      type: 'paragraph',
      text: 'Dernier',
    });
  });
});
```

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: PASS (6 tests total).

- [ ] **Step 7: Commit**

```bash
git add src/docs/blocks.ts tests/blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(blocks): buildBlockContainer for write direction + round-trip test
/ buildBlockContainer pour la direction écriture + test round-trip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `blocks.ts` — findBlockContainerById helper

**Files:**
- Modify: `src/docs/blocks.ts` (add `findBlockContainerById`)
- Test: `tests/blocks.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Append to `tests/blocks.test.ts`:

```ts
import { findBlockContainerById } from '../src/docs/blocks.js';

describe('findBlockContainerById', () => {
  it('should return the blockContainer with matching id', () => {
    // Arrange
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');
    yjsDocument.transact(() => {
      const blockGroup = new Y.XmlElement('blockGroup');
      const firstContainer = buildBlockContainer({
        type: 'paragraph',
        text: 'A',
      });
      const targetContainer = buildBlockContainer({
        type: 'paragraph',
        text: 'B',
      });
      targetContainer.setAttribute('id', 'TARGET');
      blockGroup.insert(0, [firstContainer, targetContainer]);
      documentFragment.insert(0, [blockGroup]);
    });

    // Act
    const foundContainer = findBlockContainerById(documentFragment, 'TARGET');

    // Assert
    expect(foundContainer).not.toBeNull();
    expect(foundContainer?.getAttribute('id')).toBe('TARGET');
  });

  it('should return null when no block matches the id', () => {
    // Arrange
    const yjsDocument = new Y.Doc();
    const documentFragment = yjsDocument.getXmlFragment('document-store');

    // Act
    const foundContainer = findBlockContainerById(
      documentFragment,
      'NONEXISTENT',
    );

    // Assert
    expect(foundContainer).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test
```

Expected: FAIL — `findBlockContainerById is not exported`.

- [ ] **Step 3: Add `findBlockContainerById` and `findOrCreateBlockGroup` to `src/docs/blocks.ts`**

Append to `src/docs/blocks.ts`:

```ts
/**
 * Trouve le blockContainer top-level qui a l'id donné.
 * Retourne null si aucun match.
 * / Finds the top-level blockContainer with the given id, or null.
 *
 * Utilisé par les ops update_block et delete_block pour localiser le
 * bloc à modifier.
 * / Used by update_block and delete_block ops to locate the target.
 */
export function findBlockContainerById(
  documentFragment: Y.XmlFragment,
  blockIdentifier: BlockId,
): Y.XmlElement | null {
  const topLevelBlockGroup = findTopLevelBlockGroup(documentFragment);
  if (!topLevelBlockGroup) {
    return null;
  }

  for (const childElement of topLevelBlockGroup.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName === 'blockContainer' &&
      childElement.getAttribute('id') === blockIdentifier
    ) {
      return childElement;
    }
  }
  return null;
}

/**
 * Trouve l'index d'un blockContainer top-level dans le blockGroup.
 * Retourne -1 si non trouvé.
 * / Finds the index of a top-level blockContainer in the blockGroup.
 *
 * Utilisé par insert_block (pour insérer après un id donné) et delete_block.
 * / Used by insert_block (to insert after a given id) and delete_block.
 */
export function findBlockContainerIndex(
  documentFragment: Y.XmlFragment,
  blockIdentifier: BlockId,
): number {
  const topLevelBlockGroup = findTopLevelBlockGroup(documentFragment);
  if (!topLevelBlockGroup) {
    return -1;
  }

  const childElements = topLevelBlockGroup.toArray();
  for (let elementIndex = 0; elementIndex < childElements.length; elementIndex++) {
    const childElement = childElements[elementIndex];
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName === 'blockContainer' &&
      childElement.getAttribute('id') === blockIdentifier
    ) {
      return elementIndex;
    }
  }
  return -1;
}

/**
 * Trouve le blockGroup top-level, le crée s'il n'existe pas.
 * / Finds the top-level blockGroup, creates one if missing.
 *
 * Doit être appelé dans une `Y.Doc.transact()`.
 * / Must be called inside a Y.Doc.transact().
 */
export function findOrCreateTopLevelBlockGroup(
  documentFragment: Y.XmlFragment,
): Y.XmlElement {
  const existingBlockGroup = findTopLevelBlockGroup(documentFragment);
  if (existingBlockGroup) {
    return existingBlockGroup;
  }
  const newBlockGroup = new Y.XmlElement('blockGroup');
  documentFragment.insert(0, [newBlockGroup]);
  return newBlockGroup;
}
```

Also import `BlockId` at the top of `blocks.ts`:

```ts
import type { Block, BlockContent, BlockId } from '../types.js';
```

(Replace the existing `import type { Block } from '../types.js';` line with the line above.)

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/docs/blocks.ts tests/blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(blocks): add lookup helpers (findBlockContainerById, index, blockGroup)
/ ajoute les helpers de recherche

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `connection.ts` — DocsWebSocket wrapper

**Files:**
- Create: `src/docs/connection.ts`

This module is hard to unit test in isolation (it needs a real WebSocket server). It's covered by the integration test in Task 14. We do TDD-light here: write the file, run typecheck, commit.

- [ ] **Step 1: Write `src/docs/connection.ts`**

```ts
/**
 * Wrapper sur le client WebSocket `ws` qui injecte les en-têtes attendus
 * par le serveur Hocuspocus de la-suite Docs.
 * / Wrapper around the `ws` client that injects headers required by the
 * Hocuspocus server of la-suite Docs.
 *
 * LOCALISATION : src/docs/connection.ts
 *
 * Le serveur de collaboration de Docs (`y-provider`) impose deux contrôles
 * au handshake WebSocket (cf. src/middlewares.ts du repo Docs) :
 *   1. Header `Origin` doit valoir l'URL de l'instance.
 *   2. Header `Cookie` doit être présent (n'importe quelle valeur suffit
 *      pour les docs publics).
 *
 * Sans ces deux conditions, le serveur ferme avec :
 *   - 4001 "Origin not allowed", ou
 *   - 4001 "No cookies".
 *
 * En plus, ce wrapper est nécessaire car HocuspocusProviderWebsocket
 * appelle `new WebSocketPolyfill(this.url)` avec un seul argument, sans
 * forwarder d'options. Toute personnalisation des en-têtes doit donc
 * passer par une sous-classe de ws.
 *
 * COMMUNICATION :
 * Importé par : session.ts (pour fournir le polyfill au HocuspocusProviderWebsocket).
 */

import WebSocketBase from 'ws';

/**
 * Crée une classe DocsWebSocket configurée pour une instance Docs donnée.
 * / Creates a DocsWebSocket class configured for a given Docs instance.
 *
 * On retourne une classe (pas une instance) car HocuspocusProviderWebsocket
 * attend une référence de constructeur dans son option `WebSocketPolyfill`.
 * / We return a class (not an instance) because HocuspocusProviderWebsocket
 * expects a constructor reference in its `WebSocketPolyfill` option.
 *
 * @param docsInstanceUrl - URL HTTPS de l'instance Docs (ex: https://notes.liiib.re)
 * @returns Une sous-classe de ws.WebSocket prête à être passée à Hocuspocus
 */
export function createDocsWebSocketClass(
  docsInstanceUrl: string,
): typeof WebSocketBase {
  // Dérive l'origin attendue par le serveur Hocuspocus.
  // / Derive the Origin expected by the Hocuspocus server.
  const expectedOrigin = new URL(docsInstanceUrl).origin;

  // Cookie bidon : suffit pour les docs publics (le serveur exige juste
  // *un* cookie, mais ne valide pas son contenu pour les docs publics).
  // / Dummy cookie: sufficient for public docs.
  const dummyCookie = 'docs_sessionid=anonymous-bot';

  class DocsWebSocket extends WebSocketBase {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, {
        origin: expectedOrigin,
        headers: {
          Cookie: dummyCookie,
        },
      });
    }
  }

  return DocsWebSocket;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/docs/connection.ts
git commit -m "$(cat <<'EOF'
feat(connection): add DocsWebSocket wrapper for Origin/Cookie handshake
/ wrapper WebSocket pour le handshake Origin/Cookie

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `session.ts` — getOrCreate session with sync wait

**Files:**
- Create: `src/docs/session.ts`

- [ ] **Step 1: Write `src/docs/session.ts`**

```ts
/**
 * Cache des sessions Yjs ouvertes par doc_id, avec TTL de garbage collection.
 * / Cache of open Yjs sessions per doc_id, with garbage collection TTL.
 *
 * LOCALISATION : src/docs/session.ts
 *
 * Quand un tool MCP est appelé, ce module fournit le Y.Doc déjà synchronisé
 * pour ce document, ou ouvre une nouvelle connexion Hocuspocus si pas en cache.
 * Une fois inactif pendant plus de DOCS_SESSION_TTL_MS, la connexion est fermée.
 *
 * FLUX (getOrCreate) :
 * 1. server.ts appelle getOrCreate(docId)
 * 2. Si cache hit : retourne la session, met à jour lastUsed
 * 3. Si cache miss : ouvre la WS via DocsWebSocket, attend onSynced
 * 4. Le timer GC (toutes les 60s) ferme les sessions inactives
 *
 * COMMUNICATION :
 * Reçoit : appels depuis server.ts (un par tool call)
 * Émet : updates Yjs vers le serveur Hocuspocus (via Y.Doc.transact)
 */

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createDocsWebSocketClass } from './connection.js';
import { DocsError } from '../types.js';
import type { DocumentId } from '../types.js';

/**
 * Représentation interne d'une session Yjs ouverte.
 * / Internal representation of an open Yjs session.
 */
interface OpenYjsSession {
  yjsDocument: Y.Doc;
  hocuspocusProvider: HocuspocusProvider;
  websocketProvider: HocuspocusProviderWebsocket;
  lastUsedTimestamp: number;
}

/**
 * Manager des sessions Yjs en cache. Une instance par serveur MCP.
 * / Yjs session cache manager. One instance per MCP server.
 */
export class SessionManager {
  private readonly openSessionsByDocId = new Map<DocumentId, OpenYjsSession>();
  private readonly garbageCollectionInterval: NodeJS.Timeout;
  private readonly docsWebSocketClass: ReturnType<
    typeof createDocsWebSocketClass
  >;

  constructor(
    private readonly docsInstanceUrl: string,
    private readonly sessionTtlMs: number,
    private readonly syncTimeoutMs: number,
  ) {
    this.docsWebSocketClass = createDocsWebSocketClass(docsInstanceUrl);
    // Lance le GC toutes les 60 secondes pour fermer les sessions inactives.
    // / Run GC every 60s to close inactive sessions.
    this.garbageCollectionInterval = setInterval(() => {
      this.closeInactiveSessions();
    }, 60_000);
    // Empêche le timer de bloquer la fermeture du process.
    // / Don't keep the process alive just for this timer.
    this.garbageCollectionInterval.unref();
  }

  /**
   * Retourne la session pour `documentIdentifier`. L'ouvre et la synchronise
   * si elle n'est pas déjà en cache. Met à jour lastUsedTimestamp.
   * / Returns the session for `documentIdentifier`. Opens and syncs it
   * if not already cached. Updates lastUsedTimestamp.
   */
  async getOrCreate(documentIdentifier: DocumentId): Promise<OpenYjsSession> {
    const cachedSession = this.openSessionsByDocId.get(documentIdentifier);
    if (cachedSession) {
      cachedSession.lastUsedTimestamp = Date.now();
      return cachedSession;
    }

    // Cache miss : ouvre une nouvelle connexion Hocuspocus.
    // / Cache miss: open a new Hocuspocus connection.
    const newSession = await this.openNewSession(documentIdentifier);
    this.openSessionsByDocId.set(documentIdentifier, newSession);
    return newSession;
  }

  /**
   * Ouvre une connexion WS Hocuspocus pour `documentIdentifier` et attend
   * la synchronisation initiale (au max syncTimeoutMs).
   * / Opens a Hocuspocus WS connection and waits for initial sync.
   */
  private async openNewSession(
    documentIdentifier: DocumentId,
  ): Promise<OpenYjsSession> {
    const yjsDocument = new Y.Doc({ guid: documentIdentifier });

    // Construit l'URL WebSocket à partir de l'URL HTTPS de l'instance.
    // / Build WS URL from instance HTTPS URL.
    const websocketUrl = this.buildWebSocketUrl(documentIdentifier);

    const websocketProvider = new HocuspocusProviderWebsocket({
      url: websocketUrl,
      WebSocketPolyfill: this.docsWebSocketClass as unknown as typeof WebSocket,
    });

    const hocuspocusProvider = new HocuspocusProvider({
      websocketProvider,
      name: documentIdentifier,
      document: yjsDocument,
      // Token bidon : nécessaire pour que le client envoie l'AuthenticationMessage.
      // / Dummy token: required so the client sends AuthenticationMessage.
      token: 'notoken',
    });

    // Attend onSynced ou timeout.
    // / Wait for onSynced or timeout.
    await this.waitForInitialSync(hocuspocusProvider, documentIdentifier);

    return {
      yjsDocument,
      hocuspocusProvider,
      websocketProvider,
      lastUsedTimestamp: Date.now(),
    };
  }

  /**
   * Construit l'URL WebSocket Hocuspocus pour un doc donné.
   * / Builds the Hocuspocus WebSocket URL for a given doc.
   *
   * Format : wss://<host>/collaboration/ws/?room=<doc_id>
   */
  private buildWebSocketUrl(documentIdentifier: DocumentId): string {
    const httpsUrl = new URL(this.docsInstanceUrl);
    const websocketProtocol = httpsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${websocketProtocol}//${httpsUrl.host}/collaboration/ws/?room=${documentIdentifier}`;
  }

  /**
   * Attend l'événement onSynced du provider Hocuspocus, ou timeout après
   * syncTimeoutMs. Lance DocsError(SYNC_TIMEOUT) en cas de timeout.
   * / Waits for the provider's onSynced event, or times out.
   */
  private async waitForInitialSync(
    hocuspocusProvider: HocuspocusProvider,
    documentIdentifier: DocumentId,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Si déjà synced (cas improbable mais défensif).
      // / If already synced (defensive).
      if (hocuspocusProvider.synced) {
        resolve();
        return;
      }

      const timeoutHandle = setTimeout(() => {
        hocuspocusProvider.off('synced', onSyncedCallback);
        reject(
          new DocsError(
            'SYNC_TIMEOUT',
            `Sync timeout for document ${documentIdentifier} after ${this.syncTimeoutMs}ms`,
          ),
        );
      }, this.syncTimeoutMs);

      const onSyncedCallback = () => {
        clearTimeout(timeoutHandle);
        resolve();
      };

      hocuspocusProvider.on('synced', onSyncedCallback);
    });
  }

  /**
   * Ferme toutes les sessions inactives depuis plus de sessionTtlMs.
   * / Closes all sessions inactive for more than sessionTtlMs.
   */
  private closeInactiveSessions(): void {
    const currentTimestamp = Date.now();
    for (const [documentIdentifier, openSession] of this.openSessionsByDocId) {
      const inactivityDurationMs =
        currentTimestamp - openSession.lastUsedTimestamp;
      if (inactivityDurationMs > this.sessionTtlMs) {
        this.closeSession(documentIdentifier, openSession);
      }
    }
  }

  /**
   * Ferme une session : déconnecte le provider, retire de la map.
   * / Closes a session: disconnect provider, remove from map.
   */
  private closeSession(
    documentIdentifier: DocumentId,
    openSession: OpenYjsSession,
  ): void {
    openSession.hocuspocusProvider.disconnect();
    openSession.hocuspocusProvider.destroy();
    this.openSessionsByDocId.delete(documentIdentifier);
  }

  /**
   * Ferme toutes les sessions et arrête le GC. À appeler au shutdown.
   * / Closes all sessions and stops GC. Call on shutdown.
   */
  shutdown(): void {
    clearInterval(this.garbageCollectionInterval);
    for (const [documentIdentifier, openSession] of this.openSessionsByDocId) {
      this.closeSession(documentIdentifier, openSession);
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/docs/session.ts
git commit -m "$(cat <<'EOF'
feat(session): SessionManager with cache, sync wait, and TTL GC
/ SessionManager avec cache, attente sync et GC TTL

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `session.ts` — read/insert/update/delete operations

**Files:**
- Modify: `src/docs/session.ts` (add operation methods)

- [ ] **Step 1: Add operation methods to `SessionManager`**

Add the following methods inside the `SessionManager` class (before `shutdown`):

```ts
  /**
   * Lit la liste des blocs d'un document.
   * / Reads the block list of a document.
   */
  async readDocument(documentIdentifier: DocumentId) {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { xmlFragmentToBlocks } = await import('./blocks.js');
    return xmlFragmentToBlocks(documentFragment);
  }

  /**
   * Insère un nouveau bloc dans le document.
   * Si afterBlockIdentifier est null/undefined, insertion en tête.
   * Sinon, insertion juste après le bloc avec cet id.
   * / Inserts a new block. After-id null = insert at start.
   */
  async insertBlock(
    documentIdentifier: DocumentId,
    blockContent: BlockContentArg,
    afterBlockIdentifier: BlockId | null,
  ): Promise<BlockId> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const {
      buildBlockContainer,
      findOrCreateTopLevelBlockGroup,
      findBlockContainerIndex,
    } = await import('./blocks.js');

    let newBlockIdentifier = '';

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = findOrCreateTopLevelBlockGroup(documentFragment);
      const builtBlockContainer = buildBlockContainer(blockContent);
      newBlockIdentifier = builtBlockContainer.getAttribute('id') ?? '';

      const insertionIndex = computeInsertionIndex(
        documentFragment,
        afterBlockIdentifier,
        findBlockContainerIndex,
      );
      topLevelBlockGroup.insert(insertionIndex, [builtBlockContainer]);
    });

    return newBlockIdentifier;
  }

  /**
   * Remplace le texte d'un bloc existant.
   * / Replaces the text of an existing block.
   */
  async updateBlockText(
    documentIdentifier: DocumentId,
    blockIdentifier: BlockId,
    newText: string,
  ): Promise<void> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { findBlockContainerById } = await import('./blocks.js');

    const targetContainer = findBlockContainerById(
      documentFragment,
      blockIdentifier,
    );
    if (!targetContainer) {
      throw new DocsError(
        'BLOCK_NOT_FOUND',
        `Block ${blockIdentifier} not found in document ${documentIdentifier}`,
      );
    }

    openSession.yjsDocument.transact(() => {
      const contentElement = findFirstNonBlockGroupChild(targetContainer);
      if (!contentElement) {
        throw new DocsError(
          'UNSUPPORTED_BLOCK_TYPE',
          `Block ${blockIdentifier} has no content element`,
        );
      }
      replaceTextInElement(contentElement, newText);
    });
  }

  /**
   * Supprime un bloc du document.
   * / Deletes a block from the document.
   */
  async deleteBlock(
    documentIdentifier: DocumentId,
    blockIdentifier: BlockId,
  ): Promise<void> {
    const openSession = await this.getOrCreate(documentIdentifier);
    const documentFragment = openSession.yjsDocument.getXmlFragment(
      'document-store',
    );
    const { findBlockContainerIndex } = await import('./blocks.js');

    const blockIndex = findBlockContainerIndex(
      documentFragment,
      blockIdentifier,
    );
    if (blockIndex === -1) {
      throw new DocsError(
        'BLOCK_NOT_FOUND',
        `Block ${blockIdentifier} not found in document ${documentIdentifier}`,
      );
    }

    openSession.yjsDocument.transact(() => {
      const topLevelBlockGroup = documentFragment
        .toArray()
        .find(
          (n) =>
            n instanceof Y.XmlElement && n.nodeName === 'blockGroup',
        ) as Y.XmlElement | undefined;
      if (topLevelBlockGroup) {
        topLevelBlockGroup.delete(blockIndex, 1);
      }
    });
  }
```

Add these helper functions and types **outside** the class, at the bottom of the file:

```ts
/**
 * Type local pour le contenu de bloc à insérer.
 * Importé via re-export depuis types.ts pour limiter le couplage.
 * / Local type for block content. Imported via re-export from types.ts.
 */
type BlockContentArg =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string };

type BlockId = string;

/**
 * Calcule l'index où insérer un nouveau bloc dans le blockGroup.
 * Si afterBlockIdentifier est null, retourne 0 (insertion en tête).
 * Sinon, retourne l'index du bloc cible + 1.
 * Si le bloc cible n'existe pas, lève BLOCK_NOT_FOUND.
 * / Computes insertion index in the blockGroup.
 */
function computeInsertionIndex(
  documentFragment: Y.XmlFragment,
  afterBlockIdentifier: BlockId | null,
  findBlockContainerIndexFn: (
    fragment: Y.XmlFragment,
    id: BlockId,
  ) => number,
): number {
  if (afterBlockIdentifier === null || afterBlockIdentifier === undefined) {
    return 0;
  }
  const targetIndex = findBlockContainerIndexFn(
    documentFragment,
    afterBlockIdentifier,
  );
  if (targetIndex === -1) {
    throw new DocsError(
      'BLOCK_NOT_FOUND',
      `Block ${afterBlockIdentifier} not found (cannot insert after)`,
    );
  }
  return targetIndex + 1;
}

/**
 * Trouve le premier enfant non-blockGroup d'un blockContainer.
 * / Finds the first non-blockGroup child of a blockContainer.
 */
function findFirstNonBlockGroupChild(
  blockContainerElement: Y.XmlElement,
): Y.XmlElement | null {
  for (const childElement of blockContainerElement.toArray()) {
    if (
      childElement instanceof Y.XmlElement &&
      childElement.nodeName !== 'blockGroup'
    ) {
      return childElement;
    }
  }
  return null;
}

/**
 * Remplace tout le texte d'un élément (paragraph, heading, etc.).
 * Supprime les Y.XmlText existants et en insère un seul nouveau.
 * Doit être appelé dans une transaction.
 * / Replaces the full text of an element. Call inside a transaction.
 */
function replaceTextInElement(
  parentElement: Y.XmlElement,
  newText: string,
): void {
  // 1. Identifie tous les Y.XmlText enfants à supprimer.
  // / Identify all Y.XmlText children to delete.
  const childArray = parentElement.toArray();
  const textNodeIndices: number[] = [];
  for (let nodeIndex = 0; nodeIndex < childArray.length; nodeIndex++) {
    if (childArray[nodeIndex] instanceof Y.XmlText) {
      textNodeIndices.push(nodeIndex);
    }
  }

  // 2. Supprime les Y.XmlText du dernier au premier (pour ne pas décaler).
  // / Delete Y.XmlText from last to first (so indices don't shift).
  for (let reverseIndex = textNodeIndices.length - 1; reverseIndex >= 0; reverseIndex--) {
    parentElement.delete(textNodeIndices[reverseIndex], 1);
  }

  // 3. Insère un nouveau Y.XmlText avec le texte de remplacement.
  // / Insert a new Y.XmlText with the replacement text.
  const newTextNode = new Y.XmlText();
  newTextNode.insert(0, newText);
  parentElement.insert(0, [newTextNode]);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/docs/session.ts
git commit -m "$(cat <<'EOF'
feat(session): add read, insert, update, delete operations
/ ajoute les opérations de lecture et d'édition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `client.ts` — REST wrapper

**Files:**
- Create: `src/docs/client.ts`

- [ ] **Step 1: Write `src/docs/client.ts`**

```ts
/**
 * Wrapper REST sur l'API Django de la-suite Docs.
 * / REST wrapper over the la-suite Docs Django API.
 *
 * LOCALISATION : src/docs/client.ts
 *
 * Sert exclusivement aux opérations qui ne passent PAS par le WebSocket
 * Yjs : lister les docs accessibles, vérifier qu'un doc est public+editor,
 * récupérer ses métadonnées sans charger le contenu Yjs.
 *
 * COMMUNICATION :
 * Importé par : server.ts (pour list_documents et get_document_metadata).
 */

import { DocsError } from '../types.js';
import type { DocumentId, DocumentSummary } from '../types.js';

/**
 * Client REST minimal pour l'API Docs.
 * / Minimal REST client for the Docs API.
 */
export class DocsRestClient {
  constructor(private readonly docsInstanceUrl: string) {}

  /**
   * Récupère les métadonnées d'un document.
   * Lance DocsError(DOC_NOT_FOUND) en 404, DOC_NOT_PUBLIC si pas public.
   * / Fetches document metadata.
   */
  async fetchDocumentMetadata(
    documentIdentifier: DocumentId,
  ): Promise<DocumentSummary & { created_at: string }> {
    const apiResponse = await fetch(
      `${this.docsInstanceUrl}/api/v1.0/documents/${documentIdentifier}/`,
    );

    if (apiResponse.status === 404) {
      throw new DocsError(
        'DOC_NOT_FOUND',
        `Document ${documentIdentifier} not found on instance`,
      );
    }
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when fetching ${documentIdentifier}`,
      );
    }

    const documentData = (await apiResponse.json()) as {
      id: string;
      title: string;
      updated_at: string;
      created_at: string;
      link_reach: 'public' | 'authenticated' | 'restricted';
      link_role: 'reader' | 'commenter' | 'editor';
    };

    if (documentData.link_reach !== 'public') {
      throw new DocsError(
        'DOC_NOT_PUBLIC',
        `Document ${documentIdentifier} is not public (link_reach=${documentData.link_reach})`,
      );
    }

    return documentData;
  }

  /**
   * Vérifie qu'un doc est public ET éditable. Lance DocsError sinon.
   * / Verifies the doc is public AND editable.
   */
  async assertPublicEditor(documentIdentifier: DocumentId): Promise<void> {
    const documentMetadata = await this.fetchDocumentMetadata(
      documentIdentifier,
    );
    if (documentMetadata.link_role !== 'editor') {
      throw new DocsError(
        'DOC_READONLY',
        `Document ${documentIdentifier} is public but read-only (link_role=${documentMetadata.link_role})`,
      );
    }
  }

  /**
   * Liste les docs publics accessibles.
   * Note : l'API Docs ne propose pas de filtre serveur sur link_reach,
   * on filtre côté client après la récupération.
   * / Lists public docs accessible by the instance.
   */
  async listPublicDocuments(): Promise<DocumentSummary[]> {
    const apiResponse = await fetch(
      `${this.docsInstanceUrl}/api/v1.0/documents/?page_size=100`,
    );
    if (!apiResponse.ok) {
      throw new Error(
        `Unexpected response ${apiResponse.status} when listing documents`,
      );
    }

    const responseBody = (await apiResponse.json()) as {
      results: Array<DocumentSummary>;
    };

    // Filtre côté client : on ne garde que les docs publics.
    // / Client-side filter: keep only public docs.
    const publicDocumentList: DocumentSummary[] = [];
    for (const documentRecord of responseBody.results) {
      if (documentRecord.link_reach === 'public') {
        publicDocumentList.push({
          id: documentRecord.id,
          title: documentRecord.title,
          updated_at: documentRecord.updated_at,
          link_reach: documentRecord.link_reach,
          link_role: documentRecord.link_role,
        });
      }
    }
    return publicDocumentList;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/docs/client.ts
git commit -m "$(cat <<'EOF'
feat(client): add DocsRestClient for metadata and listing
/ DocsRestClient pour les métadonnées et le listing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `server.ts` — MCP entrypoint and tool registration

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Write `src/server.ts`**

```ts
#!/usr/bin/env node
/**
 * Serveur MCP `lasuite-docs-mcp` — point d'entrée stdio.
 * / MCP server `lasuite-docs-mcp` — stdio entrypoint.
 *
 * LOCALISATION : src/server.ts
 *
 * Ce module :
 *   1. Charge la configuration depuis l'environnement (DOCS_INSTANCE_URL, ...).
 *   2. Instancie SessionManager (cache Yjs) et DocsRestClient (REST).
 *   3. Déclare les 5 tools MCP (+ 1 metadata) avec validation zod.
 *   4. Démarre le transport stdio.
 *
 * COMMUNICATION :
 * stdin/stdout : protocole MCP avec le client (Claude Desktop, etc.)
 * Délègue à : SessionManager (lecture/édition Yjs), DocsRestClient (REST)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SessionManager } from './docs/session.js';
import { DocsRestClient } from './docs/client.js';
import { DocsError } from './types.js';

// 1. Charge la configuration depuis l'environnement.
// / Load config from environment.
const docsInstanceUrl =
  process.env.DOCS_INSTANCE_URL ?? 'https://notes.liiib.re';
const sessionTtlMs = Number(process.env.DOCS_SESSION_TTL_MS ?? '300000');
const syncTimeoutMs = Number(process.env.DOCS_SYNC_TIMEOUT_MS ?? '10000');

// 2. Instancie les services.
// / Instantiate services.
const sessionManager = new SessionManager(
  docsInstanceUrl,
  sessionTtlMs,
  syncTimeoutMs,
);
const docsRestClient = new DocsRestClient(docsInstanceUrl);

// 3. Schemas zod pour la validation des inputs.
// / Zod schemas for input validation.
const documentIdentifierSchema = z
  .string()
  .uuid('doc_id must be a valid UUID v4');

const blockContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paragraph'),
    text: z.string().min(1, 'text must not be empty'),
  }),
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1, 'text must not be empty'),
  }),
]);

const insertBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  content: blockContentSchema,
  after_block_id: z.string().nullable().optional(),
});

const updateBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  block_id: z.string(),
  text: z.string().min(1, 'text must not be empty'),
});

const deleteBlockInputSchema = z.object({
  doc_id: documentIdentifierSchema,
  block_id: z.string(),
});

const readDocumentInputSchema = z.object({
  doc_id: documentIdentifierSchema,
});

// 4. Définition des tools MCP.
// / MCP tool definitions.
const toolDefinitionList = [
  {
    name: 'list_documents',
    description:
      'Liste les documents publics (link_reach=public) accessibles sur l\'instance Docs configurée.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_document',
    description:
      'Lit la liste structurée des blocs (paragraphes, headings) d\'un document public. Retourne un tableau de {id, type, text, level?}.',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string', format: 'uuid' } },
      required: ['doc_id'],
    },
  },
  {
    name: 'insert_block',
    description:
      'Insère un nouveau bloc (paragraph ou heading) dans le document. Si after_block_id est null/absent, insertion en tête. Retourne le block_id généré.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        content: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'paragraph' },
                text: { type: 'string' },
              },
              required: ['type', 'text'],
            },
            {
              type: 'object',
              properties: {
                type: { const: 'heading' },
                level: { type: 'integer', enum: [1, 2, 3] },
                text: { type: 'string' },
              },
              required: ['type', 'level', 'text'],
            },
          ],
        },
        after_block_id: { type: ['string', 'null'] },
      },
      required: ['doc_id', 'content'],
    },
  },
  {
    name: 'update_block',
    description:
      'Remplace le texte d\'un bloc existant identifié par son block_id. Le type/niveau ne change pas.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        block_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['doc_id', 'block_id', 'text'],
    },
  },
  {
    name: 'delete_block',
    description: 'Supprime un bloc identifié par son block_id.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', format: 'uuid' },
        block_id: { type: 'string' },
      },
      required: ['doc_id', 'block_id'],
    },
  },
  {
    name: 'get_document_metadata',
    description:
      'Récupère les métadonnées d\'un document (titre, dates, link_reach, link_role) sans charger son contenu.',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string', format: 'uuid' } },
      required: ['doc_id'],
    },
  },
];

// 5. Création du serveur MCP.
// / MCP server creation.
const mcpServer = new Server(
  { name: 'lasuite-docs-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Handler pour `tools/list`.
// / Handler for `tools/list`.
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitionList,
}));

// Handler pour `tools/call`. Route vers la bonne fonction selon le nom.
// / Handler for `tools/call`. Routes to the right function by tool name.
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawToolArguments = request.params.arguments ?? {};

  try {
    if (toolName === 'list_documents') {
      const publicDocumentList = await docsRestClient.listPublicDocuments();
      return formatToolSuccess(publicDocumentList);
    }

    if (toolName === 'read_document') {
      const validatedInput = readDocumentInputSchema.parse(rawToolArguments);
      // Vérifie que le doc est public avant de tenter la connexion WS.
      // / Check the doc is public before opening a WS connection.
      const documentMetadata = await docsRestClient.fetchDocumentMetadata(
        validatedInput.doc_id,
      );
      const blockList = await sessionManager.readDocument(
        validatedInput.doc_id,
      );
      return formatToolSuccess({
        id: validatedInput.doc_id,
        title: documentMetadata.title,
        blocks: blockList,
      });
    }

    if (toolName === 'insert_block') {
      const validatedInput = insertBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      const newBlockIdentifier = await sessionManager.insertBlock(
        validatedInput.doc_id,
        validatedInput.content,
        validatedInput.after_block_id ?? null,
      );
      return formatToolSuccess({ block_id: newBlockIdentifier });
    }

    if (toolName === 'update_block') {
      const validatedInput = updateBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      await sessionManager.updateBlockText(
        validatedInput.doc_id,
        validatedInput.block_id,
        validatedInput.text,
      );
      return formatToolSuccess({ ok: true });
    }

    if (toolName === 'delete_block') {
      const validatedInput = deleteBlockInputSchema.parse(rawToolArguments);
      await docsRestClient.assertPublicEditor(validatedInput.doc_id);
      await sessionManager.deleteBlock(
        validatedInput.doc_id,
        validatedInput.block_id,
      );
      return formatToolSuccess({ ok: true });
    }

    if (toolName === 'get_document_metadata') {
      const validatedInput = readDocumentInputSchema.parse(rawToolArguments);
      const documentMetadata = await docsRestClient.fetchDocumentMetadata(
        validatedInput.doc_id,
      );
      return formatToolSuccess(documentMetadata);
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (caughtError) {
    return formatToolError(caughtError);
  }
});

/**
 * Formate un résultat de tool MCP en succès JSON.
 * / Formats an MCP tool success as JSON.
 */
function formatToolSuccess(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Formate une erreur de tool MCP. Distingue DocsError (codes métier) des
 * erreurs techniques.
 * / Formats an MCP tool error. Distinguishes DocsError from technical errors.
 */
function formatToolError(caughtError: unknown) {
  if (caughtError instanceof DocsError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ code: caughtError.code, message: caughtError.message }),
        },
      ],
    };
  }
  if (caughtError instanceof z.ZodError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            code: 'INVALID_INPUT',
            message: caughtError.message,
            issues: caughtError.issues,
          }),
        },
      ],
    };
  }
  const errorMessage =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ code: 'INTERNAL_ERROR', message: errorMessage }),
      },
    ],
  };
}

// 6. Démarrage du transport stdio.
// / Start stdio transport.
const stdioTransport = new StdioServerTransport();
await mcpServer.connect(stdioTransport);

// Shutdown propre sur SIGINT/SIGTERM.
// / Clean shutdown on SIGINT/SIGTERM.
process.on('SIGINT', () => {
  sessionManager.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  sessionManager.shutdown();
  process.exit(0);
});
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

Expected: PASS, `dist/server.js` exists.

- [ ] **Step 3: Verify server starts (no error on stdio init)**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | timeout 3 node dist/server.js | head -c 200
```

Expected: a JSON-RPC response listing the 6 tools.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): MCP stdio entrypoint with 6 tools and zod validation
/ point d'entrée MCP stdio avec 6 tools et validation zod

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Integration test script (manual end-to-end)

**Files:**
- Create: `tests/integration.test.ts`

This is a manual test, run with `npm run test:integration` against a real public doc whose UUID is set in `DOCS_INTEGRATION_DOC_ID`.

- [ ] **Step 1: Write `tests/integration.test.ts`**

```ts
/**
 * Test d'intégration manuel pour lasuite-docs-mcp.
 * / Manual integration test for lasuite-docs-mcp.
 *
 * LOCALISATION : tests/integration.test.ts
 *
 * Lance avec : npm run test:integration
 * Prérequis : variables d'env DOCS_INSTANCE_URL et DOCS_INTEGRATION_DOC_ID
 *
 * Scénario :
 *   1. Read initial du doc (snapshot count)
 *   2. Insert d'un paragraphe au début
 *   3. Read et vérification que le paragraphe est présent
 *   4. Update du paragraphe
 *   5. Read et vérification du nouveau texte
 *   6. Delete du paragraphe
 *   7. Read et vérification que le doc est revenu à son état initial
 *
 * Le test est idempotent : il nettoie son bloc en cas d'échec partiel.
 * / Idempotent: cleans up its block even on partial failure.
 */

import { SessionManager } from '../src/docs/session.js';
import { DocsRestClient } from '../src/docs/client.js';

async function main(): Promise<void> {
  const docsInstanceUrl = process.env.DOCS_INSTANCE_URL;
  const integrationDocumentId = process.env.DOCS_INTEGRATION_DOC_ID;

  if (!docsInstanceUrl || !integrationDocumentId) {
    console.error(
      'Missing DOCS_INSTANCE_URL or DOCS_INTEGRATION_DOC_ID in env.',
    );
    process.exit(1);
  }

  const docsRestClient = new DocsRestClient(docsInstanceUrl);
  const sessionManager = new SessionManager(docsInstanceUrl, 300_000, 10_000);

  let createdBlockId: string | null = null;

  try {
    console.log(`[1/7] Vérification que le doc est public...`);
    await docsRestClient.assertPublicEditor(integrationDocumentId);

    console.log(`[2/7] Read initial...`);
    const initialBlocks = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const initialBlockCount = initialBlocks.length;
    console.log(`      ${initialBlockCount} blocs initiaux`);

    console.log(`[3/7] Insert d'un paragraphe au début...`);
    createdBlockId = await sessionManager.insertBlock(
      integrationDocumentId,
      { type: 'paragraph', text: 'Test integration #1' },
      null,
    );
    console.log(`      block_id créé: ${createdBlockId}`);

    console.log(`[4/7] Read et vérification...`);
    const blocksAfterInsert = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const insertedBlock = blocksAfterInsert.find(
      (block) => block.id === createdBlockId,
    );
    if (!insertedBlock || insertedBlock.text !== 'Test integration #1') {
      throw new Error('Bloc inséré introuvable ou texte incorrect');
    }
    console.log(`      OK, bloc trouvé avec le bon texte`);

    console.log(`[5/7] Update du texte...`);
    await sessionManager.updateBlockText(
      integrationDocumentId,
      createdBlockId,
      'Test integration #2 (modifié)',
    );

    console.log(`[6/7] Read et vérification du nouveau texte...`);
    const blocksAfterUpdate = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const updatedBlock = blocksAfterUpdate.find(
      (block) => block.id === createdBlockId,
    );
    if (!updatedBlock || updatedBlock.text !== 'Test integration #2 (modifié)') {
      throw new Error('Texte non mis à jour');
    }
    console.log(`      OK, nouveau texte vérifié`);

    console.log(`[7/7] Delete et vérification que le bloc est parti...`);
    await sessionManager.deleteBlock(integrationDocumentId, createdBlockId);
    const blocksAfterDelete = await sessionManager.readDocument(
      integrationDocumentId,
    );
    const stillThere = blocksAfterDelete.find(
      (block) => block.id === createdBlockId,
    );
    if (stillThere) {
      throw new Error('Bloc supprimé toujours présent');
    }
    if (blocksAfterDelete.length !== initialBlockCount) {
      throw new Error(
        `Doc count incorrect : ${blocksAfterDelete.length} vs ${initialBlockCount} attendu`,
      );
    }
    console.log(`      OK, doc revenu à son état initial`);

    createdBlockId = null;
    console.log('');
    console.log('✅ Integration test PASSED');
  } catch (caughtError) {
    console.error('❌ Integration test FAILED:', caughtError);
    if (createdBlockId) {
      console.log(`Cleanup : tentative de suppression du bloc ${createdBlockId}...`);
      try {
        await sessionManager.deleteBlock(integrationDocumentId, createdBlockId);
        console.log('Cleanup OK');
      } catch (cleanupError) {
        console.error('Cleanup failed:', cleanupError);
      }
    }
    process.exit(1);
  } finally {
    sessionManager.shutdown();
  }
}

main();
```

- [ ] **Step 2: Document required env in `.env.example`**

The `.env.example` was already created in Task 1 with `DOCS_INTEGRATION_DOC_ID`. Verify the user has set it (or skip the test).

- [ ] **Step 3: Run integration test (only if `DOCS_INTEGRATION_DOC_ID` is set)**

```bash
# Set the env var to a public+editor doc UUID, then:
export DOCS_INSTANCE_URL=https://notes.liiib.re
export DOCS_INTEGRATION_DOC_ID=<UUID_d_un_doc_public_jetable>
npm run test:integration
```

Expected: 7 steps complete, `Integration test PASSED`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): manual end-to-end script (read+insert+update+delete)
/ script d'intégration manuel bout en bout

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Documentation files (README, CHANGELOG, A TESTER)

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `A TESTER ET DOCUMENTER/insertion-paragraphes.md`

- [ ] **Step 1: Write `README.md`**

```markdown
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

```bash
git clone https://github.com/CoopCodeCommun/lasuite-docs-mcp.git
cd lasuite-docs-mcp
npm install
npm run build
```

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

## Architecture

Voir [`docs/superpowers/specs/2026-05-08-docs-mcp-design.md`](docs/superpowers/specs/2026-05-08-docs-mcp-design.md) pour le design détaillé.

## Licence

MIT — Coopérative Code Commun
```

- [ ] **Step 2: Write `CHANGELOG.md`**

```markdown
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
```

- [ ] **Step 3: Write `A TESTER ET DOCUMENTER/insertion-paragraphes.md`**

```bash
mkdir -p "A TESTER ET DOCUMENTER"
```

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md "A TESTER ET DOCUMENTER/"
git commit -m "$(cat <<'EOF'
docs: README, CHANGELOG, and manual test scenarios
/ documentation README, CHANGELOG, scénarios de test manuel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after writing the plan)

### 1. Spec coverage

| Spec section | Task |
|---|---|
| § 2 Architecture / modules | Tasks 2-10 (un module par fichier) |
| § 3.1 list_documents | Task 9 (REST) + Task 10 (handler) |
| § 3.2 read_document | Tasks 3-4-5 (blocks) + Task 7-8 (session) + Task 10 (handler) |
| § 3.3 insert_block | Task 4 (build) + Task 8 (session) + Task 10 (handler) |
| § 3.4 update_block | Task 5 + Task 8 (session) + Task 10 (handler) |
| § 3.5 delete_block | Task 5 + Task 8 (session) + Task 10 (handler) |
| § 3.6 get_document_metadata | Task 9 + Task 10 |
| § 4 Data flow | Task 8 (session ops) + Task 11 (integration test reproduit le scénario) |
| § 5 Erreurs (codes typés) | Task 2 (DocsError) + Task 10 (formatToolError) |
| § 6 Tests | Tasks 3-5 (unit), Task 11 (integration), Task 10 step 3 (smoke MCP via echo) |
| § 7 Conventions FR/EN, FALC | Headers présents dans toutes les tâches de création de fichier |
| § 8 Variables d'env | Task 1 step 6 (.env.example) + Task 10 step 1 (lecture) |
| § 11 Critères de succès | Task 12 step 3 (A TESTER doc) + Task 11 (integration test) |

### 2. Placeholder scan

- ✅ Pas de "TBD", "TODO", "implement later".
- ✅ Code complet dans chaque step (pas de "..." ni "similar to Task N").
- ✅ Tous les commits ont un message bilingue concret.

### 3. Type consistency

- ✅ `DocumentId` et `BlockId` définis dans `types.ts` (Task 2), réutilisés partout.
- ✅ `Block` est l'union discriminée définie en Task 2, retournée par `xmlFragmentToBlocks` (Task 3) et exposée par `read_document` (Task 10).
- ✅ `BlockContent` (le type d'input pour insert) est cohérent entre `types.ts`, `blocks.ts` (`buildBlockContainer`), `session.ts` (`insertBlock`), et `server.ts` (`blockContentSchema` zod).
- ✅ `DocsError` et `DocsErrorCode` définis en Task 2, utilisés dans `session.ts` (Task 8), `client.ts` (Task 9), `server.ts` (Task 10).

### 4. Ambiguity

- ✅ Chaque task spécifie quels fichiers créer/modifier/tester.
- ✅ Les commandes ont une expected output explicite.
- ✅ Le scénario d'intégration (Task 11) est exhaustif et idempotent.

---

## Execution Handoff

**Plan complet sauvegardé dans `docs/superpowers/plans/2026-05-08-docs-mcp-implementation.md`. Deux options d'exécution :**

**1. Subagent-Driven (recommandé)** — Je dispatche un subagent frais par task, je review entre chaque task, itération rapide.

**2. Inline Execution** — J'exécute les tasks dans cette session avec executing-plans, exécution par batch avec checkpoints pour review.

**Quelle approche ?**
