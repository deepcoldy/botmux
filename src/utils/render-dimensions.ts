/**
 * Render-dimension policy for the headless xterm + screenshot canvas.
 *
 * Lives in its own file (not inside worker.ts) so tests can exercise the
 * pure resolver without importing the worker entrypoint, which has
 * module-load side effects (logger init, ipc-listener registration).
 */

/** Default render width for botmux-spawned CLIs — narrow enough for the
 *  web terminal to render comfortably and the card PNG to fit Lark's
 *  typical card width. */
export const DEFAULT_RENDER_COLS = 160;
export const DEFAULT_RENDER_ROWS = 50;

/** Hard upper bound on render dimensions — protects snapshot/PNG memory
 *  if a pane is reported as unreasonably wide (or a malformed init
 *  payload sneaks past). 320 covers all real-world tmux pane widths
 *  including ultrawide monitors; beyond this the canvas balloons and
 *  Lark cards stop looking sensible. */
export const MAX_RENDER_COLS = 320;
export const MAX_RENDER_ROWS = 100;
/** Lower bound — keeps a degenerate 1-col pane from producing a
 *  near-empty canvas. */
export const MIN_RENDER_COLS = 80;
export const MIN_RENDER_ROWS = 24;

/** Numeric clamp with NaN/Infinity guards. NaN snaps to the lower bound
 *  (safe default), ±Infinity to the matching bound. */
export function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value === Infinity) return hi;
  if (value === -Infinity) return lo;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

export interface RenderDimensions {
  cols: number;
  rows: number;
}

export interface RenderDimensionConfig {
  adoptMode?: boolean;
  adoptPaneCols?: number;
  adoptPaneRows?: number;
}

/** Compute the render dimensions for a session. Adopt mode pegs to the
 *  source pane (clamped to safe bounds); everything else uses the
 *  defaults so the web terminal + card stay narrow.
 *
 *  Why this matters: when the renderer is narrower than the source pane,
 *  ANSI meant for col 270 wraps to row 2 in the renderer's xterm. The
 *  snapshot then reads "row 2's first 160 cols" as the wrap target +
 *  whatever Claude actually wrote on row 2 — producing the duplicated /
 *  stair-stepped screenshot the live failure showed. Picking the correct
 *  width up-front (in `init` BEFORE startScreenUpdates) is the only fix
 *  that doesn't leave wrapped state in xterm's buffer. */
export function resolveRenderDimensions(cfg: RenderDimensionConfig): RenderDimensions {
  if (cfg.adoptMode) {
    return {
      cols: clamp(cfg.adoptPaneCols ?? DEFAULT_RENDER_COLS, MIN_RENDER_COLS, MAX_RENDER_COLS),
      rows: clamp(cfg.adoptPaneRows ?? DEFAULT_RENDER_ROWS, MIN_RENDER_ROWS, MAX_RENDER_ROWS),
    };
  }
  return { cols: DEFAULT_RENDER_COLS, rows: DEFAULT_RENDER_ROWS };
}
