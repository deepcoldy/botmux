/**
 * Transient snapshot helper for tmux pipe-pane sessions.
 *
 * Instead of accumulating PTY data into a long-lived xterm-headless instance
 * (the legacy renderer path), we ask tmux for a fresh ANSI snapshot of the
 * current pane viewport and feed it to a throwaway xterm-headless that gets
 * disposed immediately after we read it.
 *
 * Why: the long-lived buffer accumulates errors over time —
 *   - drift if the headless cols/rows don't match the real pane (web client
 *     resize changes the real pane via tmux resize-window, but the headless
 *     stays at spawn-time dimensions),
 *   - leftover history from before alt-buffer switches that the long buffer
 *     never strictly cleared,
 *   - cursor-positioning sequences emitted by the CLI landing at the wrong
 *     coordinates when the headless terminal is narrower than the real pane.
 *
 * Tmux's own state IS the authoritative current screen — capture-pane returns
 * what the user actually sees in their terminal. Seeding a fresh xterm-headless
 * with this snapshot every screenshot/screen-update means there is no
 * accumulated state to drift.
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { TmuxPipeBackend } from '../adapters/backend/tmux-pipe-backend.js';
import { readViewportText } from './terminal-renderer.js';
import { captureToPng } from './screenshot-renderer.js';
import { clamp, MIN_RENDER_COLS, MAX_RENDER_COLS, MIN_RENDER_ROWS, MAX_RENDER_ROWS } from './render-dimensions.js';

export interface TransientSnapshot {
  cols: number;
  rows: number;
  /** Raw ANSI captured from tmux capture-pane. Useful for hashing/dedup. */
  ansi: string;
}

/** Attempt to capture a fresh ANSI snapshot from a TmuxPipeBackend. Returns
 *  null if the backend isn't a pipe backend, the pane has gone away, or
 *  tmux refuses to answer. Callers should fall back to the legacy renderer
 *  path on null. */
export function tryCapturePipeSnapshot(
  backend: unknown,
  fallbackCols: number,
  fallbackRows: number,
): TransientSnapshot | null {
  if (!(backend instanceof TmuxPipeBackend)) return null;
  const live = backend.getPaneSize();
  const cols = clamp(live?.cols ?? fallbackCols, MIN_RENDER_COLS, MAX_RENDER_COLS);
  const rows = clamp(live?.rows ?? fallbackRows, MIN_RENDER_ROWS, MAX_RENDER_ROWS);
  // Viewport-only capture: same number of rows as the transient terminal,
  // so the snapshot never overflows and triggers a normal-buffer scroll.
  const ansi = backend.captureViewport();
  if (!ansi) return null;
  return { cols, rows, ansi };
}

/** Feed an ANSI snapshot into a transient xterm-headless and yield the
 *  terminal once tmux's bytes have been consumed by the parser. Caller MUST
 *  dispose() the terminal when done. */
async function buildTransientTerminal(snap: TransientSnapshot): Promise<InstanceType<typeof Terminal>> {
  const terminal = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
  // xterm.write() with a callback resolves after the async parser has fully
  // consumed the chunk. Without awaiting this, reading the buffer can race
  // and pick up partial state mid-parse.
  await new Promise<void>(resolve => terminal.write(snap.ansi, () => resolve()));
  return terminal;
}

/** Render a tmux pipe-pane snapshot to a PNG buffer. Returns null when the
 *  backend can't provide a snapshot — caller falls back to the legacy
 *  long-lived-renderer path. */
export async function snapshotToPng(
  backend: unknown,
  fallbackCols: number,
  fallbackRows: number,
): Promise<{ png: Buffer; ansi: string; content: string } | null> {
  const snap = tryCapturePipeSnapshot(backend, fallbackCols, fallbackRows);
  if (!snap) return null;
  const terminal = await buildTransientTerminal(snap);
  try {
    // Read the actual viewport — baseY may have shifted if the snapshot
    // ended with a newline that triggered a normal-buffer scroll. We want
    // the *current* visible rows, not buffer rows 0..N-1 which may be
    // stale scrollback after that scroll.
    const startY = terminal.buffer.active.baseY;
    const png = captureToPng(terminal, { cols: snap.cols, rows: snap.rows, startY });
    const content = readViewportText(terminal, { filter: true, startY, rows: snap.rows });
    return { png, ansi: snap.ansi, content };
  } finally {
    terminal.dispose();
  }
}

/** Render a tmux pipe-pane snapshot to filtered text (drops the bare prompt
 *  + input echo lines, same rules as TerminalRenderer.snapshot()). Returns
 *  null when the backend can't provide a snapshot. */
export async function snapshotToText(
  backend: unknown,
  fallbackCols: number,
  fallbackRows: number,
  opts: { filter: boolean },
): Promise<{ content: string; ansi: string } | null> {
  const snap = tryCapturePipeSnapshot(backend, fallbackCols, fallbackRows);
  if (!snap) return null;
  const terminal = await buildTransientTerminal(snap);
  try {
    // Read from the actual current viewport (see snapshotToPng comment).
    const startY = terminal.buffer.active.baseY;
    const content = readViewportText(terminal, { filter: opts.filter, startY, rows: snap.rows });
    return { content, ansi: snap.ansi };
  } finally {
    terminal.dispose();
  }
}
