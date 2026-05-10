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
import { randomUUID } from 'node:crypto';
import { appendInlineMarkdownToParent } from './markdown.js';
import type { Block, BlockContent, BlockId } from '../types.js';

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
  if (blockNodeName === 'image') {
    // Bloc image standard BlockNote : les infos sont dans les attributs
    // (url, caption, name), pas dans le texte. Le texte concaténé est
    // toujours vide pour ce type.
    // / BlockNote standard image block: info is in attributes.
    return {
      id: blockIdentifier,
      type: 'image',
      text: '',
      url: blockContentElement.getAttribute('url') ?? '',
      name: blockContentElement.getAttribute('name') ?? '',
      caption: blockContentElement.getAttribute('caption') ?? '',
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
 * Sérialise le contenu inline d'un élément (paragraph, heading, ...) en
 * markdown : les marks Yjs (bold/italic/code/strike/link) sont reconverties
 * vers leurs marqueurs markdown (**bold**, *italic*, `code`, ~~strike~~,
 * [text](url)).
 * / Serializes inline content of an element back to markdown: Yjs marks
 * / become markdown markers.
 *
 * C'est l'opération inverse de `appendInlineMarkdownToParent`. Permet à
 * `read_document` de retourner du markdown propre que l'agent peut
 * réutiliser tel quel dans un `update_block` ou un `insert_block`.
 * / Inverse of appendInlineMarkdownToParent. Enables clean markdown
 * / round-trips through read → update/insert.
 */
function extractTextFromElement(parentElement: Y.XmlElement): string {
  let serializedMarkdown = '';
  for (const childNode of parentElement.toArray()) {
    if (childNode instanceof Y.XmlText) {
      serializedMarkdown += yjsTextToMarkdown(childNode);
    }
  }
  return serializedMarkdown;
}

/**
 * Convertit un Y.XmlText en markdown en parcourant ses runs (delta).
 * / Converts a Y.XmlText to markdown by walking its delta runs.
 */
function yjsTextToMarkdown(yjsText: Y.XmlText): string {
  // toDelta() retourne [{insert: string, attributes?: {bold, italic, ...}}, ...]
  // / toDelta() returns runs with insert + attributes.
  type DeltaRun = { insert: string; attributes?: Record<string, unknown> };
  const deltaRuns = yjsText.toDelta() as DeltaRun[];
  let markdownOutput = '';
  for (const run of deltaRuns) {
    markdownOutput += runToMarkdown(run);
  }
  return markdownOutput;
}

/**
 * Convertit un run (insert + attributes) en markdown. Wrappe le texte avec
 * les marqueurs markdown selon les marks actives.
 * / Wraps text with markdown markers per active marks.
 *
 * Ordre d'application des wrappers (de l'extérieur vers l'intérieur) :
 *   link > strike > bold > italic > code
 * Cet ordre n'a pas d'incidence fonctionnelle (markdown est associatif),
 * mais on le fixe pour des sorties stables.
 * / Wrapper order (outer → inner): link > strike > bold > italic > code.
 * / Order is fixed for stable output (functionally associative).
 */
function runToMarkdown(deltaRun: { insert: string; attributes?: Record<string, unknown> }): string {
  let wrappedText = deltaRun.insert;
  const activeAttrs = deltaRun.attributes ?? {};

  // Code en premier (le plus interne) : un caractère ` à chaque bout.
  // / Code first (innermost): backticks.
  if (activeAttrs.code === true) {
    wrappedText = '`' + wrappedText + '`';
  }
  // Italic : *...*
  if (activeAttrs.italic === true) {
    wrappedText = '*' + wrappedText + '*';
  }
  // Bold : **...**
  if (activeAttrs.bold === true) {
    wrappedText = '**' + wrappedText + '**';
  }
  // Strike : ~~...~~
  if (activeAttrs.strike === true) {
    wrappedText = '~~' + wrappedText + '~~';
  }
  // Link : [text](href) — le plus externe pour englober tout le reste.
  // / Link: outermost wrapper to enclose all other marks.
  const linkAttribute = activeAttrs.link as { href?: string } | undefined;
  if (linkAttribute && typeof linkAttribute.href === 'string') {
    wrappedText = '[' + wrappedText + '](' + linkAttribute.href + ')';
  }

  return wrappedText;
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
  // Les attributs sont stockés dans _prelimAttrs jusqu'à l'intégration dans
  // un Y.Doc (lors de l'insert par l'appelant).
  // / Build the blockContainer with id and default visual attributes.
  // Attributes are stored in _prelimAttrs until integration into a Y.Doc
  // (when the caller inserts the element).
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
 * Construit un Y.XmlElement de type blockContainer contenant un bloc
 * image BlockNote. L'id du container est généré automatiquement.
 * / Builds a blockContainer Y.XmlElement holding a BlockNote image block.
 *
 * Le bloc image n'a pas de contenu texte interne : tout est dans les
 * attributs (url, name, caption). Pas besoin du pattern
 * build → attach → populate qui sert pour les marks Yjs des paragraphes.
 * / Image blocks have no inline text — all info is in attributes.
 *
 * @param imageProperties - url (REST media), name (filename), caption optionnelle
 * @returns Un Y.XmlElement blockContainer non encore attaché
 */
export function buildImageBlockContainer(
  imageProperties: {
    url: string;
    name: string;
    caption?: string;
  },
): Y.XmlElement {
  const newBlockContainer = new Y.XmlElement('blockContainer');
  newBlockContainer.setAttribute('id', randomUUID());
  newBlockContainer.setAttribute('backgroundColor', 'default');
  newBlockContainer.setAttribute('textColor', 'default');

  // Élément <image> avec props standard BlockNote.
  // / <image> element with standard BlockNote props.
  const imageElement = new Y.XmlElement('image');
  imageElement.setAttribute('url', imageProperties.url);
  imageElement.setAttribute('name', imageProperties.name);
  imageElement.setAttribute('caption', imageProperties.caption ?? '');
  imageElement.setAttribute('showPreview', 'true');
  imageElement.setAttribute('previewWidth', '512');
  imageElement.setAttribute('backgroundColor', 'default');
  imageElement.setAttribute('textAlignment', 'left');

  newBlockContainer.insert(0, [imageElement]);

  return newBlockContainer;
}

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

/**
 * Construit l'élément de contenu d'un bloc (paragraph ou heading).
 * / Builds the content element of a block (paragraph or heading).
 */
function buildContentElement(blockContent: BlockContent): Y.XmlElement {
  // ATTENTION (Yjs _prelimAttrs trap) : on ne touche PAS au contenu inline
  // ici, parce que cet élément n'est pas encore attaché à un Y.Doc. Les
  // marks Yjs (`text.insert(pos, str, {bold:true})`) lèvent une erreur sur
  // un Y.XmlText détaché. C'est `populateInlineContent` qui finalise le
  // contenu APRÈS attachement (cf. session.ts::insertBlock).
  // / Yjs gotcha: marks fail on detached elements. populateInlineContent
  // / fills the content AFTER the chain is attached to the doc.
  if (blockContent.type === 'paragraph') {
    const paragraphElement = new Y.XmlElement('paragraph');
    paragraphElement.setAttribute('backgroundColor', 'default');
    paragraphElement.setAttribute('textColor', 'default');
    paragraphElement.setAttribute('textAlignment', 'left');
    return paragraphElement;
  }

  // type === 'heading'
  const headingElement = new Y.XmlElement('heading');
  headingElement.setAttribute('backgroundColor', 'default');
  headingElement.setAttribute('textColor', 'default');
  headingElement.setAttribute('textAlignment', 'left');
  headingElement.setAttribute('level', String(blockContent.level));
  return headingElement;
}

/**
 * Finalise le contenu inline d'un blockContainer DÉJÀ ATTACHÉ au doc.
 * Trouve le paragraph/heading enfant et y insère le markdown parsé.
 * / Finalizes inline content of a blockContainer ALREADY ATTACHED to doc.
 *
 * Doit être appelé après que le blockContainer ait été inséré dans son
 * parent (blockGroup), pour que les marks Yjs et les <link> children
 * puissent être créés sans déclencher l'erreur "Invalid access: Add Yjs
 * type to a document before reading data".
 */
export function populateInlineContent(
  attachedBlockContainer: Y.XmlElement,
  inlineMarkdown: string,
): void {
  const contentElement = findFirstNonBlockGroupChildExt(attachedBlockContainer);
  if (contentElement === null) {
    return;
  }
  appendInlineMarkdownToParent(contentElement, inlineMarkdown);
}

/**
 * Helper local (non exporté à part) : trouve le premier enfant non-blockGroup
 * d'un blockContainer. Dupliqué de session.ts pour éviter import circulaire.
 * / Local helper: first non-blockGroup child. Duplicated to avoid cycle.
 */
function findFirstNonBlockGroupChildExt(
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
