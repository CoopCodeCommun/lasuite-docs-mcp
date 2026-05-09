/**
 * Tests unitaires pour markdown.ts.
 * Vérifie le parsing du markdown inline en marks Yjs.
 * / Unit tests for markdown.ts. Verifies inline markdown → Yjs marks.
 *
 * LOCALISATION : tests/markdown.test.ts
 *
 * Pour vérifier les marks de manière fiable, on utilise `text.toDelta()`
 * qui retourne un tableau de runs typés avec leurs attributes :
 *   [{insert: "hello", attributes: {bold: true}}, {insert: " world"}]
 * C'est plus précis que toString() qui sérialise en pseudo-XML.
 * / We use text.toDelta() instead of toString() for precise mark assertions.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { appendInlineMarkdownToParent } from '../src/docs/markdown.js';

/**
 * Helper : crée un Y.Doc, un fragment, un parent attaché, et applique
 * le markdown dedans dans une transaction. Retourne les delta runs du
 * Y.XmlText résultant.
 * / Helper: build attached parent, apply markdown, return delta runs.
 */
function applyMarkdownAndGetDelta(markdown: string): Array<{
  insert: string;
  attributes?: Record<string, unknown>;
}> {
  const yjsDocument = new Y.Doc();
  const documentFragment = yjsDocument.getXmlFragment('test');
  const parentElement = new Y.XmlElement('paragraph');
  yjsDocument.transact(() => {
    documentFragment.insert(0, [parentElement]);
    appendInlineMarkdownToParent(parentElement, markdown);
  });
  // Concatène les deltas de tous les Y.XmlText enfants.
  // / Concatenate deltas from all Y.XmlText children.
  const allRuns: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
  for (const child of parentElement.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = child.toDelta() as Array<{
        insert: string;
        attributes?: Record<string, unknown>;
      }>;
      allRuns.push(...delta);
    }
  }
  return allRuns;
}

describe('appendInlineMarkdownToParent', () => {
  describe('plain text', () => {
    it('inserts plain text without marks', () => {
      const runs = applyMarkdownAndGetDelta('Hello world');
      expect(runs).toEqual([{ insert: 'Hello world' }]);
    });

    it('handles empty string by inserting an empty Y.XmlText', () => {
      const yjsDocument = new Y.Doc();
      const fragment = yjsDocument.getXmlFragment('test');
      const parent = new Y.XmlElement('paragraph');
      yjsDocument.transact(() => {
        fragment.insert(0, [parent]);
        appendInlineMarkdownToParent(parent, '');
      });
      // Doit avoir un Y.XmlText vide enfant pour respecter le schéma BlockNote.
      // / Must have one empty Y.XmlText child to satisfy BlockNote schema.
      expect(parent.length).toBe(1);
      const child = parent.toArray()[0];
      expect(child).toBeInstanceOf(Y.XmlText);
      expect((child as Y.XmlText).toString()).toBe('');
    });
  });

  describe('single marks', () => {
    it('parses **bold** as bold mark', () => {
      const runs = applyMarkdownAndGetDelta('Hello **world**');
      expect(runs).toEqual([
        { insert: 'Hello ' },
        { insert: 'world', attributes: { bold: true } },
      ]);
    });

    it('parses *italic* as italic mark', () => {
      const runs = applyMarkdownAndGetDelta('plain *fancy* end');
      expect(runs).toEqual([
        { insert: 'plain ' },
        { insert: 'fancy', attributes: { italic: true } },
        { insert: ' end' },
      ]);
    });

    it('parses `code` as code mark', () => {
      const runs = applyMarkdownAndGetDelta('use `npm` ok');
      expect(runs).toEqual([
        { insert: 'use ' },
        { insert: 'npm', attributes: { code: true } },
        { insert: ' ok' },
      ]);
    });

    it('parses ~~strike~~ as strike mark', () => {
      const runs = applyMarkdownAndGetDelta('~~old~~ new');
      expect(runs).toEqual([
        { insert: 'old', attributes: { strike: true } },
        { insert: ' new' },
      ]);
    });
  });

  describe('links', () => {
    it('parses [text](url) as link mark', () => {
      const runs = applyMarkdownAndGetDelta('see [docs](https://example.com)');
      expect(runs).toEqual([
        { insert: 'see ' },
        {
          insert: 'docs',
          attributes: { link: { href: 'https://example.com' } },
        },
      ]);
    });

    it('parses link with bold text inside', () => {
      const runs = applyMarkdownAndGetDelta('[**important**](https://x.com) link');
      expect(runs).toEqual([
        {
          insert: 'important',
          attributes: {
            bold: true,
            link: { href: 'https://x.com' },
          },
        },
        { insert: ' link' },
      ]);
    });
  });

  describe('combined marks', () => {
    it('parses **bold and *italic***', () => {
      // Note : la précédence markdown peut imbriquer différemment selon
      // le parser ; on accepte les deux ordres.
      // / Note: markdown precedence may nest differently across parsers.
      const runs = applyMarkdownAndGetDelta('**bold and *italic***');
      // On vérifie que les caractères "italic" ont bold + italic.
      const italicRun = runs.find(
        (r) => r.insert === 'italic' || r.insert.includes('italic'),
      );
      expect(italicRun?.attributes).toMatchObject({ bold: true, italic: true });
    });

    it('parses paragraph with multiple marks', () => {
      const runs = applyMarkdownAndGetDelta(
        'Mix **bold**, *italic*, `code`, ~~strike~~ done',
      );
      // 9 runs attendus : "Mix ", "bold", ", ", "italic", ", ", "code",
      //                   ", ", "strike", " done"
      // / 9 expected runs.
      expect(runs.length).toBeGreaterThanOrEqual(7);
      expect(runs.some((r) => r.attributes?.bold === true)).toBe(true);
      expect(runs.some((r) => r.attributes?.italic === true)).toBe(true);
      expect(runs.some((r) => r.attributes?.code === true)).toBe(true);
      expect(runs.some((r) => r.attributes?.strike === true)).toBe(true);
    });
  });

  describe('escapes', () => {
    it('preserves escaped asterisks as literal characters', () => {
      const runs = applyMarkdownAndGetDelta('not \\*really\\* bold');
      // Pas de mark bold, juste du texte avec astérisques préservés.
      // / No bold mark, just literal asterisks.
      const fullText = runs.map((r) => r.insert).join('');
      expect(fullText).toContain('*really*');
      expect(runs.some((r) => r.attributes?.bold === true)).toBe(false);
    });
  });
});
