/**
 * parseCapturedScreenRows reads `tmux capture-pane -e -p` without a terminal
 * emulator. It must see what xterm sees for the same bytes: every real capture
 * under test/fixtures is fed to both and compared cell by cell (text, dim,
 * inverse), plus the SGR edge cases a capture can carry.
 *
 * Run: bun run vitest run test/captured-screen-rows.test.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { parseCapturedScreenRows } from '../src/utils/captured-screen-rows.js';
import { normaliseCaptureLineEndings } from '../src/adapters/backend/tmux-pipe-backend.js';
import { readViewportCells, type ScreenRow } from '../src/utils/terminal-cells.js';

const { Terminal } = xtermHeadless;
const FIXTURES = join(process.cwd(), 'test/fixtures');

const CAPTURES: Array<[string, number, number]> = [
  ...readdirSync(join(FIXTURES, 'claude-prompt-suggestion'))
    .filter(name => name.endsWith('-160x50.txt'))
    .map(name => [`claude-prompt-suggestion/${name}`, 160, 50] as [string, number, number]),
  ['claude-composer-resize/pane-capture-214x62.txt', 214, 62],
];

async function xtermRows(capture: string, cols: number, rows: number): Promise<ScreenRow[]> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  try {
    // Without the newline after the last row, so the terminal does not scroll
    // the first row away (the sampler reads from baseY and loses it instead).
    await new Promise<void>(resolve => terminal.write(normaliseCaptureLineEndings(capture.replace(/\n$/, '')), () => resolve()));
    return readViewportCells(terminal, { startY: terminal.buffer.active.baseY, rows });
  } finally {
    terminal.dispose();
  }
}

/** Visible cells only: xterm pads every row to the width with blank cells. */
function visible(row: ScreenRow): Array<[string, boolean, boolean]> {
  const cells = row.map(cell => [cell.ch, cell.dim, cell.inverse] as [string, boolean, boolean]);
  while (cells.length > 0 && !cells[cells.length - 1][0].trim() && !cells[cells.length - 1][2]) cells.pop();
  return cells.map(([ch, dim, inverse]) => [ch, ch.trim() ? dim : false, inverse]);
}

describe('parseCapturedScreenRows', () => {
  it.each(CAPTURES)('matches xterm on %s', async (name, cols, rows) => {
    const capture = readFileSync(join(FIXTURES, name), 'utf8');
    const parsed = parseCapturedScreenRows(capture);
    const reference = await xtermRows(capture, cols, rows);
    expect(parsed).toHaveLength(rows);
    expect(parsed.map(visible)).toEqual(reference.map(visible));
  });

  it('tracks dim and inverse across rows the way a terminal does', () => {
    const rows = parseCapturedScreenRows([
      '\x1b[2mgrey',
      'still grey\x1b[22m plain',
      '\x1b[38;5;2mgreen is not dim \x1b[7mX\x1b[27m',
      '\x1b[2;7mboth\x1b[0m reset',
      '',
    ].join('\n'));
    const flags = (row: ScreenRow) => row.filter(c => c.ch.trim()).map(c => `${c.ch}${c.dim ? 'd' : ''}${c.inverse ? 'i' : ''}`).join(' ');
    expect(rows).toHaveLength(4);
    expect(flags(rows[0])).toBe('gd rd ed yd');
    expect(flags(rows[1])).toBe('sd td id ld ld gd rd ed yd p l a i n');
    expect(flags(rows[2])).toBe('g r e e n i s n o t d i m Xi');
    expect(flags(rows[3])).toBe('bdi odi tdi hdi r e s e t');
  });

  it('skips non-SGR escapes, keeps wide and combining characters as one cell', () => {
    const [row] = parseCapturedScreenRows('\x1b]8;;https://x\x1b\\链接\x1b]8;;\x1b\\ é\x1b[?25h!\n');
    expect(row.map(c => c.ch)).toEqual(['链', '接', ' ', 'é', '!']);
    expect(row.every(c => !c.dim && !c.inverse)).toBe(true);
  });
});
