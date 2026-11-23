/**
 * Buffer rows as tmux `capture-pane -p` prints them (no `-J`): one row per
 * line, every row terminated, wide-character padding skipped. `plainRows` is
 * the bare text, trimmed of every trailing space. `serializeRows` is the `-e`
 * flavour with SGR colours, trimmed as tmux 2.8 to 3.6a trim it (see
 * serializeRows).
 */

import type { IBuffer, IBufferCell } from '@xterm/headless';

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
 * Rows [start, end) with SGR colours, each ending in `eol`.
 *
 * tmux (grid_string_cells) prints every cell of the row it allocated, erased
 * ones as spaces, with an SGR sequence before each cell whose attributes
 * differ from the cell before it, then trims the trailing spaces of that
 * text. So blanks, styled or not, survive up to the row's last attribute
 * change, which the sequence after them protects: a reverse-video cursor
 * followed by default cells is kept, one in the last column is not, and a
 * background bar that reaches the margin goes entirely. tmux grows a row's
 * allocation only in steps (a quarter, half, all of the width), so a styled
 * blank in the last allocated cell is trimmed there too; that depends on the
 * row's history and is not modelled. Nor are cells xterm and tmux fill with
 * different attributes (the margin cell a wide character wraps past, cells
 * ICH inserts): there xterm sees a change tmux does not.
 *
 * Unlike tmux the pen is reset before every line ending, so replaying the
 * text never paints a coloured background into the row a scroll opens.
 */
export function serializeRows(buffer: IBuffer, start: number, end: number, eol = '\r\n'): string {
  const cell = buffer.getNullCell();
  let out = '';
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    /** The row up to its last non-blank cell or attribute change, and the pen at its end. */
    let kept = '';
    let keptPen = DEFAULT_PEN;
    /** What follows it: an SGR sequence and blanks, kept only if a later change protects them. */
    let pending = '';
    let pen = DEFAULT_PEN;
    for (let x = 0; line && x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const next = cell.isAttributeDefault() ? DEFAULT_PEN : penOf(cell);
      if (!samePen(next, pen)) {
        kept += pending;
        keptPen = pen;
        pending = sgr(pen, next);
        pen = next;
      }
      const chars = cell.getChars();
      if (chars === '' || chars === ' ') {
        pending += ' ';
      } else {
        kept += pending + chars;
        keptPen = pen;
        pending = '';
      }
    }
    out += kept;
    if (!samePen(keptPen, DEFAULT_PEN)) out += '\x1b[0m';
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

function samePen(a: Pen, b: Pen): boolean {
  return a === b || (a.fg === b.fg && a.bg === b.bg && a.flags === b.flags);
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
