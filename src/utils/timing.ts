/**
 * Centralized async timing helpers for CLI adapters.
 *
 * Every adapter's writeInput() path waits real wall-clock time: an initial
 * submitDelay before pressing Enter, a per-line typing throttle, then a poll of
 * the CLI's history/transcript for the submit marker with a bounded budget. In
 * production these are genuine delays — the CLI needs time to register the
 * paste and render the input box before the trailing Enter submits.
 *
 * `BOTMUX_TIME_SCALE` multiplies every delay/budget routed through here. It
 * defaults to 1 (production: byte-for-byte unchanged behavior — when the env
 * var is unset `scaleMs` returns its argument verbatim and `delay` is identical
 * to the old per-adapter `new Promise(r => setTimeout(r, ms))`).
 *
 * Unit tests that mock the filesystem (memfs is synchronous, so the submit
 * marker is present the instant Enter fires) set the scale to a small value so
 * the 90+ submit-confirmation cases don't each pay a real ~0.5–3s wait. That
 * collapses a ~70s test file to a few seconds WITHOUT changing any branch the
 * code takes — only the wall-clock spent waiting on timers shrinks.
 *
 * The scale is read lazily on every call (not cached at module load) so a test
 * can set process.env *after* the adapter modules have already been imported.
 */

/** Current scale factor from BOTMUX_TIME_SCALE; 1 (no scaling) by default. */
export function timeScale(): number {
  const raw = process.env.BOTMUX_TIME_SCALE;
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Scale a millisecond duration by BOTMUX_TIME_SCALE (default: unchanged). */
export function scaleMs(ms: number): number {
  const s = timeScale();
  return s === 1 ? ms : Math.max(0, Math.round(ms * s));
}

/** Promise that resolves after `ms` (scaled by BOTMUX_TIME_SCALE). */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, scaleMs(ms)));
}
