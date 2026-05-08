/**
 * Tests unitaires pour blocks.ts.
 * / Unit tests for blocks.ts.
 *
 * LOCALISATION : tests/blocks.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { xmlFragmentToBlocks, buildBlockContainer } from '../src/docs/blocks.js';
import { findBlockContainerById } from '../src/docs/blocks.js';

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
});

describe('buildBlockContainer', () => {
  it('should build a paragraph blockContainer with proper attributes', () => {
    // Arrange : les éléments Yjs ne sont lisibles (getAttribute / toArray) qu'une
    // fois intégrés dans un Y.Doc. On crée un doc de test pour les y attacher.
    // / Yjs elements are only readable (getAttribute / toArray) once integrated
    // into a Y.Doc. We create a test doc to attach them.
    const testDoc = new Y.Doc();
    const testFragment = testDoc.getXmlFragment('test');
    const testBlockGroup = new Y.XmlElement('blockGroup');

    let builtBlockContainer!: Y.XmlElement;
    testDoc.transact(() => {
      // Act
      builtBlockContainer = buildBlockContainer({
        type: 'paragraph',
        text: 'Hello world',
      });
      testBlockGroup.insert(0, [builtBlockContainer]);
      testFragment.insert(0, [testBlockGroup]);
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
    // Arrange : doc de test pour rendre les éléments lisibles après intégration
    // / Test doc to make elements readable after integration
    const testDoc = new Y.Doc();
    const testFragment = testDoc.getXmlFragment('test');
    const testBlockGroup = new Y.XmlElement('blockGroup');

    let builtBlockContainer!: Y.XmlElement;
    testDoc.transact(() => {
      // Act
      builtBlockContainer = buildBlockContainer({
        type: 'heading',
        level: 2,
        text: 'Titre',
      });
      testBlockGroup.insert(0, [builtBlockContainer]);
      testFragment.insert(0, [testBlockGroup]);
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
      blockGroup.insert(0, [firstContainer, targetContainer]);
      documentFragment.insert(0, [blockGroup]);
      // Set the attribute AFTER integration so it sticks (Yjs constraint).
      // / Set attribute AFTER integration to avoid _prelimAttrs trap.
      targetContainer.setAttribute('id', 'TARGET');
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
