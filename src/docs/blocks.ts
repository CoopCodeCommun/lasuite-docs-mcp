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
