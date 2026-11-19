/**
 * Rendered viewport as cells, for recognizers that depend on a cell attribute
 * the plain-text snapshot drops (today: SGR 2 "dim", the only thing that tells
 * Claude Code's greyed-out prompt suggestion apart from a typed draft).
 *
 * Both backends go through the same xterm-headless buffer: the PTY backend's
 * long-lived renderer, and a tmux pane's capture-pane snapshot seeded into a
 * transient terminal (see utils/transient-snapshot.ts).
 */
import xtermHeadless from '@xterm/headless';

type Terminal = InstanceType<typeof xtermHeadless.Terminal>;

export interface ScreenCell {
  /** The cell's character; ' ' for an empty cell. */
  ch: string;
  dim: boolean;
  /** SGR 7. Claude Code draws its own cursor as one inverse cell. */
  inverse: boolean;
}

/** One rendered row. A wide character is a single entry (its trailing
 * zero-width cell is skipped), so joining `ch` yields the row's text. */
export type ScreenRow = ScreenCell[];

export function readViewportCells(
  terminal: Terminal,
  opts: { startY?: number; rows?: number } = {},
): ScreenRow[] {
  const buffer = terminal.buffer.active;
  const startY = opts.startY ?? buffer.baseY;
  const rows = opts.rows ?? terminal.rows;
  const cell = buffer.getNullCell();
  const result: ScreenRow[] = [];
  for (let y = startY; y < startY + rows; y++) {
    const line = buffer.getLine(y);
    const row: ScreenRow = [];
    if (line) {
      for (let x = 0; x < line.length; x++) {
        const current = line.getCell(x, cell);
        if (!current || current.getWidth() === 0) continue;
        row.push({ ch: current.getChars() || ' ', dim: current.isDim() !== 0, inverse: current.isInverse() !== 0 });
      }
    }
    result.push(row);
  }
  return result;
}

export function screenRowText(row: ScreenRow): string {
  return row.map(cell => cell.ch).join('');
}
