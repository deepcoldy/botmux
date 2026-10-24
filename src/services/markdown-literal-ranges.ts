import MarkdownIt from 'markdown-it';

const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const MARKDOWN = new MarkdownIt();

export interface MarkdownLiteralRange {
  start: number;
  end: number;
}

interface FenceLine extends MarkdownLiteralRange {
  char: '`' | '~';
  runLength: number;
  canClose: boolean;
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

function fencedLiteralRanges(text: string): MarkdownLiteralRange[] {
  const fences: FenceLine[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = lineEnd(text, offset);
    const contentEnd = end > offset && text[end - 1] === '\r' ? end - 1 : end;
    const fence = FENCE_PATTERN.exec(text.slice(offset, contentEnd));
    if (fence) {
      const run = fence[2]!;
      fences.push({
        start: offset,
        end,
        char: run[0] as '`' | '~',
        runLength: run.length,
        canClose: fence[3]!.trim() === '',
      });
    }
    offset = end < text.length ? end + 1 : end;
  }

  const closerByFence = new Array<number | undefined>(fences.length);
  const nearestCloser = {
    '`': [] as Array<number | undefined>,
    '~': [] as Array<number | undefined>,
  };
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index]!;
    const nearestForChar = nearestCloser[fence.char];
    closerByFence[index] = nearestForChar[fence.runLength];
    if (fence.canClose) {
      for (let runLength = 3; runLength <= fence.runLength; runLength += 1) {
        nearestForChar[runLength] = index;
      }
    }
  }

  const ranges: MarkdownLiteralRange[] = [];
  for (let index = 0; index < fences.length;) {
    const closeIndex = closerByFence[index];
    if (closeIndex === undefined) {
      // An unmatched opener is ordinary model output, not a license to hide
      // every LinkRef that follows it.
      index += 1;
      continue;
    }
    ranges.push({ start: fences[index]!.start, end: fences[closeIndex]!.end });
    index = closeIndex + 1;
  }
  return ranges;
}

function indentedLiteralRanges(text: string): MarkdownLiteralRange[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }
  return MARKDOWN.parse(text, {})
    .filter(token => token.type === 'code_block' && token.map)
    .map((token) => ({
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
  const fenced = fencedLiteralRanges(text);
  const blocks = mergeRanges([...fenced, ...indentedLiteralRanges(text)]);
  return mergeRanges([...blocks, ...inlineLiteralRanges(text, blocks)]);
}
