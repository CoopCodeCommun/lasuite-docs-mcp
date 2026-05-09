/**
 * Parser markdown inline → marks Yjs sur un Y.XmlText.
 * / Inline markdown parser → Yjs marks on a Y.XmlText.
 *
 * LOCALISATION : src/docs/markdown.ts
 *
 * BlockNote utilise des marks Yjs sur Y.XmlText pour le formatage inline :
 *   - **gras**       → mark `bold: true`
 *   - *italique*     → mark `italic: true`
 *   - `code inline`  → mark `code: true`
 *   - ~~barré~~      → mark `strike: true`
 *   - [text](url)    → enfant <link href="url">text</link> (pas une mark)
 *
 * Le parsing accepte du markdown inline (pas multiligne, pas de blocs).
 * Pour insérer plusieurs paragraphes ou des structures (listes, code blocks),
 * utiliser le tool insert_markdown qui produit plusieurs blocs.
 *
 * COMMUNICATION :
 * Importé par : blocks.ts (buildContentElement) et session.ts (replaceTextInElement).
 */

import * as Y from 'yjs';
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';

/**
 * Marks Yjs supportées sur les Y.XmlText BlockNote.
 * Le lien est aussi une mark : `link: { href: "..." }`. BlockNote/ProseMirror
 * stocke les liens comme une mark plutôt qu'un élément XML enfant.
 * / Yjs marks supported on BlockNote Y.XmlText. Link is also a mark with href.
 */
type InlineMarks = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: { href: string };
};

/**
 * Insère du markdown inline dans un Y.XmlText vide, en convertissant
 * les marqueurs **gras**, *italique*, `code`, ~~barré~~ en marks Yjs,
 * et les [liens](url) en éléments <link> enfants.
 * / Inserts inline markdown into an empty Y.XmlText, converting markers
 * / to Yjs marks and links to <link> children.
 *
 * Le Y.XmlText doit être vide à l'appel ; cette fonction l'écrit depuis
 * la position 0. Si le markdown est juste du texte simple (sans marqueurs),
 * fonctionne comme un text.insert(0, markdown) classique.
 * / Y.XmlText must be empty on call. Plain text input falls back to insert.
 *
 * Doit être appelé à l'intérieur d'une Y.Doc.transact() pour que les marks
 * soient bien intégrées dans le doc.
 * / Must be called inside a Y.Doc.transact() for proper mark integration.
 */
export function applyInlineMarkdownToYjsText(
  targetText: Y.XmlText,
  markdownInline: string,
): void {
  // marked.lexer en mode inline retourne directement les tokens inline.
  // / marked.lexer in inline mode returns inline tokens directly.
  const inlineTokens = marked.Lexer.lexInline(markdownInline);
  for (const token of inlineTokens) {
    appendTokenToText(targetText, token, {});
  }
}

/**
 * Construit un Y.XmlElement qui peut contenir un Y.XmlText avec marks
 * et des éléments <link> enfants. Utilisé pour les blocs paragraph et heading.
 * / Builds a paragraph/heading-style content holder containing a Y.XmlText
 * / with marks and <link> children.
 *
 * Pour les blocs où le contenu inline est juste du texte plat (rare),
 * c'est équivalent à un Y.XmlText avec un seul run. Pour du markdown,
 * c'est ce qui permet d'avoir le rendu joli côté BlockNote.
 *
 * NOTE : BlockNote attend que le contenu inline soit DIRECTEMENT dans
 * le Y.XmlElement parent (paragraph, heading), pas dans un sous-élément.
 * Donc cette fonction prend l'élément parent en argument et y insère
 * directement les Y.XmlText et <link> à plat.
 */
export function appendInlineMarkdownToParent(
  parentElement: Y.XmlElement,
  markdownInline: string,
): void {
  // ATTENTION (Yjs gotcha) : `parentElement` doit déjà être attaché à un
  // Y.Doc à l'appel. Toutes les Y.XmlText / Y.XmlElement créées ici sont
  // attachées immédiatement à `parentElement` AVANT d'y écrire — sinon
  // les marks ou attributes lèvent "Invalid access: Add Yjs type to a
  // document before reading data".
  // / Yjs gotcha: parent must already be attached to a Y.Doc. All children
  // / created here are attached BEFORE writing into them.
  const inlineTokens = marked.Lexer.lexInline(markdownInline);
  let pendingText: Y.XmlText | null = null;

  const ensurePendingText = (): Y.XmlText => {
    if (pendingText === null) {
      pendingText = new Y.XmlText();
      // Attach FIRST, write AFTER.
      parentElement.insert(parentElement.length, [pendingText]);
    }
    return pendingText;
  };

  for (const token of inlineTokens) {
    // Tous les tokens (y compris liens) sont rendus comme du texte avec
    // marks dans le Y.XmlText. BlockNote/ProseMirror stocke les liens
    // comme une mark `link: {href}`, pas comme un élément XML.
    // / All tokens (including links) become marked text in Y.XmlText.
    appendTokenToText(ensurePendingText(), token, {});
  }

  // Si rien n'a été ajouté (markdown vide), insère quand même un Y.XmlText
  // vide pour respecter la structure BlockNote (paragraph doit contenir
  // au moins un Y.XmlText).
  // / If nothing was added, still insert an empty Y.XmlText for BlockNote.
  if (parentElement.length === 0) {
    parentElement.insert(0, [new Y.XmlText()]);
  }
}


/**
 * Récursivement ajoute un token marked à un Y.XmlText, en accumulant les
 * marks selon le type du token (strong → bold, em → italic, codespan → code,
 * del → strike). Les marks sont héritées dans la récursion (un *italic
 * **bold***  donne du texte avec bold + italic).
 * / Recursively appends a marked token to a Y.XmlText, accumulating marks
 * / by token type. Marks inherit through recursion.
 */
function appendTokenToText(
  targetText: Y.XmlText,
  token: Token,
  inheritedMarks: InlineMarks,
): void {
  switch (token.type) {
    case 'text':
      // Texte simple : insère avec les marks héritées.
      // / Plain text: insert with inherited marks.
      insertTextWithMarks(targetText, (token as Tokens.Text).text, inheritedMarks);
      return;

    case 'strong':
      // **gras** : récursion avec bold ajouté.
      // / **bold**: recurse with bold added.
      for (const inner of (token as Tokens.Strong).tokens) {
        appendTokenToText(targetText, inner, { ...inheritedMarks, bold: true });
      }
      return;

    case 'em':
      // *italique* : récursion avec italic ajouté.
      // / *italic*: recurse with italic added.
      for (const inner of (token as Tokens.Em).tokens) {
        appendTokenToText(targetText, inner, { ...inheritedMarks, italic: true });
      }
      return;

    case 'codespan':
      // `code` : insère avec mark code (pas de récursion, codespan est leaf).
      // / `code`: insert with code mark (codespan is a leaf token).
      insertTextWithMarks(
        targetText,
        (token as Tokens.Codespan).text,
        { ...inheritedMarks, code: true },
      );
      return;

    case 'del':
      // ~~barré~~ : récursion avec strike ajouté.
      // / ~~strike~~: recurse with strike added.
      for (const inner of (token as Tokens.Del).tokens) {
        appendTokenToText(targetText, inner, { ...inheritedMarks, strike: true });
      }
      return;

    case 'link': {
      // [text](url) : récursion avec link ajouté comme mark. Le texte du
      // lien peut contenir d'autres marks (ex: [**gras**](url)).
      // / [text](url): recurse with link mark. Inner text can have other marks.
      const linkToken = token as Tokens.Link;
      const linkMark: InlineMarks = {
        ...inheritedMarks,
        link: { href: linkToken.href },
      };
      if (linkToken.tokens && linkToken.tokens.length > 0) {
        for (const inner of linkToken.tokens) {
          appendTokenToText(targetText, inner, linkMark);
        }
      } else {
        insertTextWithMarks(targetText, linkToken.text, linkMark);
      }
      return;
    }

    case 'br':
      // Saut de ligne explicite (deux espaces + \n en markdown).
      // / Explicit line break (two spaces + \n in markdown).
      insertTextWithMarks(targetText, '\n', inheritedMarks);
      return;

    case 'escape':
      // Caractère échappé (\*, \_, etc.) : insère le texte sans la barre.
      // / Escaped character: insert text without the backslash.
      insertTextWithMarks(targetText, (token as Tokens.Escape).text, inheritedMarks);
      return;

    default:
      // Tout le reste (html inline, images, etc.) : on insère le `raw`
      // tel quel pour ne rien perdre. Comportement défensif.
      // / Anything else (inline html, images, etc.): insert raw to lose nothing.
      if ('raw' in token && typeof token.raw === 'string') {
        insertTextWithMarks(targetText, token.raw, inheritedMarks);
      }
      return;
  }
}

/**
 * Insère du texte dans un Y.XmlText avec les marks données. Si aucune mark
 * n'est active, équivaut à un text.insert classique.
 * / Inserts text into a Y.XmlText with given marks. No-mark = plain insert.
 */
function insertTextWithMarks(
  targetText: Y.XmlText,
  textToInsert: string,
  activeMarks: InlineMarks,
): void {
  // Une mark "active" est soit un booléen true (bold/italic/code/strike),
  // soit un objet non-null (link).
  // / Active mark = true boolean (bold/italic/code/strike) or non-null object (link).
  const hasAnyMark = Object.values(activeMarks).some(
    (markValue) => markValue === true || (markValue !== undefined && markValue !== false),
  );
  if (hasAnyMark) {
    targetText.insert(targetText.length, textToInsert, activeMarks as Record<string, unknown>);
  } else {
    targetText.insert(targetText.length, textToInsert);
  }
}
