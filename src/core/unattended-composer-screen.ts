/**
 * Which screen an unattended maintenance write (keep-alive, auto / idle
 * `/compact`) judges the composer on, and how a refusal names it in the log.
 *
 * A backend with its own synchronous viewport (tmux: capture-pane) is asked
 * directly, and a failed read is no evidence rather than a reason to fall back.
 * The worker's long-lived renderer is not that screen once a web terminal has
 * resized the pane: it keeps the worker's spawn size, so after the CLI repaints
 * for the new size the bytes it renders land elsewhere and the input box
 * vanishes from it while it sits on the pane — or a stale one stays drawn.
 * Backends without such a read (PTY: the renderer is the only screen it has)
 * keep the renderer; a backend whose screen is not authoritative at all (zmx)
 * gives none.
 */
import type { ScreenRow } from '../utils/terminal-cells.js';
import { composerScreenLogTail } from './prompt-cache-keepalive-gate.js';

export interface UnattendedComposerScreen {
  rows: ScreenRow[];
  source: 'pane' | 'renderer';
  size?: { cols: number; rows: number };
}

export function readUnattendedComposerScreen(input: {
  /** backendScreenEvidenceIsAuthoritativeForMutation() */
  authoritative: boolean;
  backend: {
    captureViewportCells?: () => ScreenRow[] | null;
    getPaneSize?: () => { cols: number; rows: number } | null;
  } | null | undefined;
  renderer: {
    viewportCells(): ScreenRow[];
    readonly xterm: { readonly cols: number; readonly rows: number };
  } | null | undefined;
}): UnattendedComposerScreen | undefined {
  if (!input.authoritative) return undefined;
  const be = input.backend;
  if (be?.captureViewportCells) {
    let rows: ScreenRow[] | null = null;
    try { rows = be.captureViewportCells(); } catch { rows = null; }
    if (!rows || rows.length === 0) return undefined;
    let size: { cols: number; rows: number } | null | undefined;
    try { size = be.getPaneSize?.(); } catch { size = undefined; }
    return { rows, source: 'pane', ...(size ? { size: { cols: size.cols, rows: size.rows } } : {}) };
  }
  if (!input.renderer) return undefined;
  try {
    const rows = input.renderer.viewportCells();
    const { cols, rows: height } = input.renderer.xterm;
    return { rows, source: 'renderer', size: { cols, rows: height } };
  } catch {
    return undefined;
  }
}

/** One log fragment naming what the gate saw: where the screen came from, its
 *  size against the renderer's, and its bottom rows without the user's text. */
export function describeUnattendedComposerScreen(
  screen: UnattendedComposerScreen | undefined,
  readyPattern: RegExp | undefined,
  renderSize: { cols: number; rows: number },
): string {
  if (!screen) return 'screen=none';
  const size = screen.size ? ` ${screen.size.cols}x${screen.size.rows}` : '';
  const tail = composerScreenLogTail(screen.rows, readyPattern);
  return `screen=${screen.source}${size} renderer=${renderSize.cols}x${renderSize.rows} tail=${JSON.stringify(tail)}`;
}
