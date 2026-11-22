/**
 * Buffer rows as tmux `capture-pane -p` prints them (no `-J`): one row per
 * line, every row terminated, wide-character padding skipped, trailing blank
 * cells dropped whatever their colours. `serializeRows` is the `-e` flavour
 * with SGR colours; `plainRows` is the bare text.
 */

import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/headless';

const COLOR_MODE_P16 = 0x1000000;
const COLOR_MODE_P256 = 0x2000000;
const COLOR_MODE_RGB = 0x3000000;

const BOLD = 1 << 0;
const DIM = 1 << 1;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;
const BLINK = 1 << 4;
const INVERSE = 1 << 5;
const INVISIBLE = 1 << 6;
const STRIKETHROUGH = 1 << 7;
const OVERLINE = 1 << 8;

const FLAG_PARAMS: ReadonlyArray<readonly [number, string]> = [
  [BOLD, '1'],
  [DIM, '2'],
  [ITALIC, '3'],
  [UNDERLINE, '4'],
  [BLINK, '5'],
  [INVERSE, '7'],
  [INVISIBLE, '8'],
  [STRIKETHROUGH, '9'],
  [OVERLINE, '53'],
];

interface Pen {
  /** Colour mode | colour; 0 is the default colour. */
  fg: number;
  bg: number;
  flags: number;
}

const DEFAULT_PEN: Pen = { fg: 0, bg: 0, flags: 0 };

/**
 * Rows [start, end) with SGR colours, each ending in `eol`. Unlike tmux the pen
 * is reset before every line ending, so replaying the text never paints a
 * coloured background into the row a scroll opens.
 */
export function serializeRows(buffer: IBuffer, start: number, end: number, eol = '\r\n'): string {
  const cell = buffer.getNullCell();
  let out = '';
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    let pen = DEFAULT_PEN;
    if (line) {
      const width = contentWidth(line, cell);
      let text = '';
      for (let x = 0; x < width; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        const next = cell.isAttributeDefault() ? DEFAULT_PEN : penOf(cell);
        if (next.fg !== pen.fg || next.bg !== pen.bg || next.flags !== pen.flags) {
          out += text + sgr(pen, next);
          text = '';
          pen = next;
        }
        text += cell.getChars() || ' ';
      }
      out += text;
    }
    if (pen.fg !== 0 || pen.bg !== 0 || pen.flags !== 0) out += '\x1b[0m';
    out += eol;
  }
  return out;
}

/** Rows [start, end) as plain text, each ending in `eol`. */
export function plainRows(buffer: IBuffer, start: number, end: number, eol = '\n'): string {
  let out = '';
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (line) out += trimTrailingSpaces(line.translateToString(true));
    out += eol;
  }
  return out;
}

function trimTrailingSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x20) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Cells up to and including the last one that is neither empty nor a space. */
function contentWidth(line: IBufferLine, cell: IBufferCell): number {
  for (let x = line.length - 1; x >= 0; x--) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) return x + 1;
    const chars = cell.getChars();
    if (chars !== '' && chars !== ' ') return x + 1;
  }
  return 0;
}

function penOf(cell: IBufferCell): Pen {
  let flags = 0;
  if (cell.isBold()) flags |= BOLD;
  if (cell.isDim()) flags |= DIM;
  if (cell.isItalic()) flags |= ITALIC;
  if (cell.isUnderline()) flags |= UNDERLINE;
  if (cell.isBlink()) flags |= BLINK;
  if (cell.isInverse()) flags |= INVERSE;
  if (cell.isInvisible()) flags |= INVISIBLE;
  if (cell.isStrikethrough()) flags |= STRIKETHROUGH;
  if (cell.isOverline()) flags |= OVERLINE;
  return {
    fg: colourKey(cell.getFgColorMode(), cell.getFgColor()),
    bg: colourKey(cell.getBgColorMode(), cell.getBgColor()),
    flags,
  };
}

function colourKey(mode: number, colour: number): number {
  return mode === COLOR_MODE_P16 || mode === COLOR_MODE_P256 || mode === COLOR_MODE_RGB ? mode | (colour & 0xffffff) : 0;
}

/** SGR moving the receiver from `prev` to `next`; turning any attribute off resets first, as tmux does. */
function sgr(prev: Pen, next: Pen): string {
  const params: string[] = [];
  let from = prev;
  if ((prev.flags & ~next.flags) !== 0) {
    params.push('0');
    from = DEFAULT_PEN;
  }
  for (const [bit, param] of FLAG_PARAMS) {
    if ((next.flags & bit) !== 0 && (from.flags & bit) === 0) params.push(param);
  }
  if (next.fg !== from.fg) params.push(colourParams(next.fg, 30));
  if (next.bg !== from.bg) params.push(colourParams(next.bg, 40));
  return params.length > 0 ? `\x1b[${params.join(';')}m` : '';
}

function colourParams(key: number, base: 30 | 40): string {
  const value = key & 0xffffff;
  switch (key & 0x3000000) {
    case COLOR_MODE_P16:
      return String(value < 8 ? base + value : base + 60 + value - 8);
    case COLOR_MODE_P256:
      return `${base + 8};5;${value}`;
    case COLOR_MODE_RGB:
      return `${base + 8};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
    default:
      return String(base + 9);
  }
}
