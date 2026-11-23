import xtermHeadless from '@xterm/headless';
import type { IBuffer, IBufferCell, ITerminalAddon, Terminal as HeadlessTerminal } from '@xterm/headless';
import * as unicode11 from '@xterm/addon-unicode11';

const { Terminal } = xtermHeadless;

type Unicode11Module = typeof import('@xterm/addon-unicode11');
const { Unicode11Addon } = ((unicode11 as Partial<Unicode11Module>).Unicode11Addon
  ? unicode11
  : (unicode11 as unknown as { default: Unicode11Module }).default);

/** A headless xterm set up like the web terminal: unicode11 widths, tmux-sized history. */
export function makeTerminal(cols: number, rows: number, scrollback = 50_000): HeadlessTerminal {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true, scrollOnEraseInDisplay: true, logLevel: 'off' });
  term.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
  term.unicode.activeVersion = '11';
  return term;
}

export function writeAll(term: HeadlessTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise(resolve => term.write(data, resolve));
}

function describeCell(cell: IBufferCell): string {
  const flags = [
    cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isBlink(),
    cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline(),
  ].map(f => (f ? '1' : '0')).join('');
  const fg = cell.isFgDefault() ? 'default' : `${cell.getFgColorMode()}:${cell.getFgColor()}`;
  const bg = cell.isBgDefault() ? 'default' : `${cell.getBgColorMode()}:${cell.getBgColor()}`;
  const chars = cell.getChars() || (cell.getWidth() === 0 ? '' : ' ');
  return `${JSON.stringify(chars)} w${cell.getWidth()} fg=${fg} bg=${bg} ${flags}`;
}

/** Every cell up to the row's last non-blank one (blank = empty or a space, whatever its colours). */
export function rowCells(buffer: IBuffer, y: number): string[] {
  const line = buffer.getLine(y);
  if (!line) return [];
  const cell = buffer.getNullCell();
  let width = 0;
  for (let x = line.length - 1; x >= 0; x--) {
    line.getCell(x, cell);
    const chars = cell.getChars();
    if (cell.getWidth() === 0 || (chars !== '' && chars !== ' ')) {
      width = x + 1;
      break;
    }
  }
  const out: string[] = [];
  for (let x = 0; x < width; x++) {
    line.getCell(x, cell);
    out.push(describeCell(cell));
  }
  return out;
}

export function bufferCells(buffer: IBuffer, start: number, end: number): string[][] {
  const rows: string[][] = [];
  for (let y = start; y < end; y++) rows.push(rowCells(buffer, y));
  return rows;
}

/** What a viewer of `term` sees: the active screen, its history when on the main screen, and the cursor. */
export function visibleState(term: HeadlessTerminal): { screen: string; cursor: [number, number]; history: string[][]; rows: string[][] } {
  const buffer = term.buffer.active;
  return {
    screen: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY],
    history: buffer.type === 'normal' ? bufferCells(buffer, 0, buffer.baseY) : [],
    rows: bufferCells(buffer, buffer.baseY, buffer.baseY + term.rows),
  };
}
