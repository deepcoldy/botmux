import MarkdownIt from 'markdown-it';
import { randomBytes } from 'node:crypto';

// Parse only to locate standalone native blocks outside Markdown examples.
// The returned text still goes through the ordinary, HTML-disabled card renderer.
const blockScanner = new MarkdownIt({ html: false, linkify: false });
const OPEN = /^ {0,3}<(?:RichMediaCard|MediaCard)>/gm;
const CLOSE = /<\/(?:RichMediaCard|MediaCard)>[ \t]*(?=\r?$)/gm;

/** Doubao's terminal renderer understands these native image references; Lark
 * does not. Convert standalone JSON blocks to Markdown, without doing any I/O.
 * Doubao can close a RichMediaCard with MediaCard, so accept either spelling. */
export function normalizeDoubaoReplyImages(input: string): string {
  if (!input.includes('<RichMediaCard>') && !input.includes('<MediaCard>')) return input;
  const openings = [...input.matchAll(OPEN)];
  if (!openings.length) return input;
  const closings = [...input.matchAll(CLOSE)];
  // Mark candidate starts while parsing Markdown so inline code excludes only
  // its own spans, not an entire paragraph that also contains a real gallery.
  let prefix: string;
  do { prefix = `bmxDoubaoMediaMarker${randomBytes(8).toString('hex')}`; } while (input.includes(prefix));
  const markedParts: string[] = [];
  let cursor = 0;
  openings.forEach((opening, index) => {
    const position = opening.index! + opening[0].indexOf('<');
    markedParts.push(input.slice(cursor, position), `${prefix}${index}x`);
    cursor = position;
  });
  markedParts.push(input.slice(cursor));
  const marker = new RegExp(`${prefix}(\\d+)x`, 'g');
  const eligible = new Set<number>();
  // Recognize escaped fence lines like the card renderer, preserving the
  // original bytes of any examples rather than rewriting their native tags.
  const marked = markedParts.join('').replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm,
    line => line.replace(/\\`/g, '`'));
  for (const token of blockScanner.parse(marked, {})) {
    for (const child of token.children ?? []) {
      if (child.type !== 'text') continue;
      for (const match of child.content.matchAll(marker)) eligible.add(Number(match[1]));
    }
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let closingIndex = 0;
  for (let i = 0; i < openings.length; i++) {
    const opening = openings[i]!;
    const start = opening.index!;
    const bodyStart = start + opening[0].length;
    while (closingIndex < closings.length && closings[closingIndex]!.index! < bodyStart) closingIndex++;
    const closing = closings[closingIndex];
    // An unfinished block must not consume the next standalone block. Bound
    // before JSON.parse, with no cross-body regular expression/backtracking.
    if (!eligible.has(i) || !closing || closing.index! >= (openings[i + 1]?.index ?? Infinity)) continue;
    const end = closing.index! + closing[0].length;
    if (end - start > 64 * 1024) continue;
    try {
      const refs: unknown = JSON.parse(input.slice(bodyStart, closing.index).trim()).refs;
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > 16
        || !refs.every(ref => typeof ref === 'string' && ref.trim() && ref.length <= 4096 && !/[\x00-\x1f\x7f]/.test(ref))) continue;
      const markdown = refs.map((ref: string, index: number) => {
        // Encode plain paths as destinations, including parentheses and fragments.
        // A file URL is already escaped; URL preserves its existing percent escapes.
        const source = (ref.startsWith('file:') ? new URL(ref).href : encodeURI(ref).replace(/[?#]/g,
          char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).replace(/[()]/g,
          char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        return `${opening[0].slice(0, opening[0].indexOf('<'))}![图片 ${index + 1}](${source})`;
      }).join('\n\n');
      edits.push({ start, end, text: markdown });
    } catch { /* Malformed/unsupported native blocks remain ordinary text. */ }
  }
  const parts: string[] = [];
  cursor = 0;
  for (const edit of edits) {
    parts.push(input.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(input.slice(cursor));
  return parts.join('');
}
