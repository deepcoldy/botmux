/**
 * Regression: the pipe-mode web-terminal seed must restore the pane cursor AND
 * preserve the grid exactly — including the trailing BLANK row below Claude's
 * bottom line.
 *
 * Claude Code (and other Ink TUIs) repaint their bottom block with height-
 * RELATIVE cursor moves (`\x1b[<n>A` + `\r\n`). When a fresh web client is
 * seeded from `tmux capture-pane` and then resumes the live pipe-pane stream,
 * the FIRST relative redraw assumes the cursor is exactly where the pane's
 * cursor is. `composeSeedBody`:
 *   - strips the SINGLE trailing line terminator (so the seed doesn't scroll the
 *     receiving xterm a row past the content — would drift DOWN), but NOT the
 *     trailing blank row (greedy strip would shift the grid up and drift UP);
 *   - appends a viewport-relative CUP to restore the cursor.
 *
 * The render cases below feed a seed + a few live relative-redraw frames through
 * a real xterm-headless and assert the status line updates IN PLACE with no
 * ghost. A real Claude pane has a blank bottom row, so the capture is modelled
 * with one.
 *
 * Run: pnpm vitest run test/web-terminal-seed-cursor.test.ts
 */
import { describe, it, expect } from 'vitest';
import xtermHeadless from '@xterm/headless';
import {
  composeSeedBody,
  normaliseCaptureLineEndings,
} from '../src/adapters/backend/tmux-pipe-backend.js';

const { Terminal } = xtermHeadless;
const COLS = 60;
const ROWS = 13;

// A capture-pane-style snapshot mirroring Claude's layout, with MORE lines than
// the viewport so the receiving xterm scrolls (the real condition: full
// scrollback >> rows — that's what makes a dropped blank row shift the grid).
// 20 scrollback lines, a 4-line bottom block (STATUS / TIP / INPUT / HINT) and —
// like a real pane — a trailing BLANK row. tmux separates rows with bare `\n`
// and emits a terminator after the last (blank) row, so the raw ends with `\n\n`.
// After scrolling, the last 13 rows form the viewport: the block lands at
// viewport rows 8–11 and the blank at row 12.
const HIST = Array.from({ length: 20 }, (_v, i) => 'HIST line ' + i);
const RAW_CAPTURE =
  [...HIST,
    'STATUS count=05 thinking',  // viewport row 8 — the "spinner" line
    'TIP send messages here',    // viewport row 9
    'INPUT',                     // viewport row 10 — cursor rests here
    'HINT bypass on',            // viewport row 11
    ''].join('\n') + '\n';       // viewport row 12 — trailing blank row
const NORMALISED = normaliseCaptureLineEndings(RAW_CAPTURE);

// The pane cursor rests on the INPUT line (viewport row 10, 0-based) at column 6
// — i.e. NOT on the bottom row, exactly like Claude's input box.
const CURSOR = { x: 6, y: 10 };

// Live frames the CLI would emit next: from the rest position (INPUT, row 10)
// hop up 2 to STATUS (row 8), rewrite it, hop back down 2 to rest. Pure
// height-relative moves — no absolute positioning.
function liveFrames(from: number, to: number): string {
  let s = '';
  for (let k = from; k <= to; k++) {
    s += '\x1b[2A\r\x1b[2KSTATUS count=' + String(k).padStart(2, '0') +
      ' thinking\x1b[2B\r\x1b[6C';
  }
  return s;
}

function write(t: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

async function renderViewport(seed: string, live: string): Promise<string[]> {
  const t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
  await write(t, seed);
  await write(t, live);
  const buf = t.buffer.active;
  const lines: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + ROWS; y++) {
    const ln = buf.getLine(y);
    lines.push((ln ? ln.translateToString(true) : '').replace(/\s+$/, ''));
  }
  t.dispose();
  return lines;
}

describe('pipe-mode web seed cursor restore', () => {
  it('updates the status line in place — no row drift, no ghost', async () => {
    const seed = composeSeedBody(NORMALISED, CURSOR);
    const viewport = await renderViewport(seed, liveFrames(6, 8));

    // Exactly one STATUS line (no stale ghost), showing the latest value, on the
    // real STATUS row with the full block (incl. trailing blank) intact below.
    const statusLines = viewport.filter((l) => l.startsWith('STATUS count='));
    expect(statusLines).toEqual(['STATUS count=08 thinking']);
    const idx = viewport.findIndex((l) => l.startsWith('STATUS count='));
    expect(viewport[idx + 1]).toBe('TIP send messages here');
    expect(viewport[idx + 2]).toBe('INPUT');
    expect(viewport[idx + 3]).toBe('HINT bypass on');
    expect(viewport[idx + 4]).toBe(''); // trailing blank row preserved
  });

  it('negative control: raw capture (no cursor restore) DOES drift', async () => {
    const viewport = await renderViewport(NORMALISED, liveFrames(6, 8));
    const statusLines = viewport.filter((l) => l.startsWith('STATUS count='));
    expect(statusLines.length).toBeGreaterThan(1); // stale ghost left behind
  });

  it('negative control: GREEDY trailing-newline strip drifts (the blank-row bug)', async () => {
    // What composeSeedBody must NOT do: strip every trailing \r\n. That deletes
    // the blank bottom row and shifts the grid up, so the redraw drifts.
    const greedy = NORMALISED.replace(/(\r\n)+$/, '') + `\x1b[${CURSOR.y + 1};${CURSOR.x + 1}H`;
    const viewport = await renderViewport(greedy, liveFrames(6, 8));
    const statusLines = viewport.filter((l) => l.startsWith('STATUS count='));
    expect(statusLines.length).toBeGreaterThan(1);
  });

  it('preserves trailing blank rows; strips only the final terminator', () => {
    // "a", "b", blank row -> keep the blank row's leading \r\n, drop the last.
    expect(composeSeedBody('a\r\nb\r\n\r\n', null)).toBe('a\r\nb\r\n');
    expect(composeSeedBody('a\r\nb\r\n', null)).toBe('a\r\nb');
    expect(composeSeedBody('a\r\nb\r\n', { x: 6, y: 10 })).toBe('a\r\nb\x1b[11;7H');
  });
});
