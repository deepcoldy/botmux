import MarkdownIt from 'markdown-it';
// markdown-it publishes this block rule at runtime but @types/markdown-it does
// not declare individual rules. Keep the suppression beside the internal import
// so every tsconfig that reaches this source sees the same typed wrapper below.
// @ts-expect-error markdown-it/lib/rules_block/fence.mjs has no published declaration
import markdownFence from 'markdown-it/lib/rules_block/fence.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type Token from 'markdown-it/lib/token.mjs';

const MARKDOWN = new MarkdownIt();
const CLOSED_FENCE_META = 'botmuxClosedFence';

export interface MarkdownLiteralRange {
  start: number;
  end: number;
}

interface FenceTokenMeta {
  [CLOSED_FENCE_META]?: boolean;
}

function countRun(text: string, index: number, char: '`'): number {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

function closesFence(state: StateBlock, line: number, markup: string): boolean {
  if (line < 0 || state.sCount[line]! - state.blkIndent >= 4) return false;
  let position = state.bMarks[line]! + state.tShift[line]!;
  const end = state.eMarks[line]!;
  const marker = markup.charCodeAt(0);
  if (state.src.charCodeAt(position) !== marker) return false;
  const runStart = position;
  position = state.skipChars(position, marker);
  if (position - runStart < markup.length) return false;
  return state.skipSpaces(position) >= end;
}

MARKDOWN.block.ruler.at('fence', (state, startLine, endLine, silent) => {
  const handled = markdownFence(state, startLine, endLine, silent);
  if (!handled || silent) return handled;
  const token = state.tokens.at(-1);
  if (token?.type === 'fence') {
    token.meta = {
      ...(token.meta && typeof token.meta === 'object' ? token.meta : {}),
      [CLOSED_FENCE_META]: closesFence(state, state.line - 1, token.markup),
    } satisfies FenceTokenMeta;
  }
  return handled;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

function blockLiteralRanges(text: string): MarkdownLiteralRange[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }
  return MARKDOWN.parse(text, {})
    .filter((token: Token) => token.map && (
      token.type === 'code_block'
      || (token.type === 'fence'
        && (token.meta as FenceTokenMeta | null)?.[CLOSED_FENCE_META] === true)
    ))
    .map((token: Token) => ({
      start: lineStarts[token.map![0]] ?? text.length,
      end: lineEnd(text, lineStarts[Math.max(token.map![0], token.map![1] - 1)] ?? text.length),
    }));
}

function inlineLiteralRanges(
  text: string,
  blocks: readonly MarkdownLiteralRange[],
): MarkdownLiteralRange[] {
  const ranges: MarkdownLiteralRange[] = [];
  let blockIndex = 0;
  for (let offset = 0; offset < text.length;) {
    const end = lineEnd(text, offset);
    while (blockIndex < blocks.length && blocks[blockIndex]!.end < offset) blockIndex += 1;
    if (blocks[blockIndex]?.start === offset) {
      offset = blocks[blockIndex]!.end < text.length ? blocks[blockIndex]!.end + 1 : text.length;
      blockIndex += 1;
      continue;
    }
    for (let index = offset; index < end;) {
      if (text[index] !== '`') {
        index += 1;
        continue;
      }
      const run = countRun(text, index, '`');
      let close = index + run;
      while (close < end) {
        if (text[close] !== '`') {
          close += 1;
          continue;
        }
        const closeRun = countRun(text, close, '`');
        if (closeRun === run) break;
        close += closeRun;
      }
      if (close >= end) {
        // Leave an unmatched run unprotected so a later LinkRef is still
        // executable instead of hiding the rest of the line.
        index += run;
        continue;
      }
      ranges.push({ start: index, end: close + run });
      index = close + run;
    }
    offset = end < text.length ? end + 1 : end;
  }
  return ranges;
}

function mergeRanges(ranges: MarkdownLiteralRange[]): MarkdownLiteralRange[] {
  const sorted = ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MarkdownLiteralRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }
  return merged;
}

/** Markdown regions whose contents are literal rather than executable LinkRef
 * or inline-link syntax. Visible URLs remain outside this abstraction and are
 * still inspected by final-link integrity. */
export function markdownLiteralRanges(text: string): MarkdownLiteralRange[] {
  const blocks = mergeRanges(blockLiteralRanges(text));
  return mergeRanges([...blocks, ...inlineLiteralRanges(text, blocks)]);
}
