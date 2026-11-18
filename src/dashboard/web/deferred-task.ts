/** Start optional work after the browser has had a chance to paint the page.
 * The timer runs after the animation frame; starting work inside rAF itself
 * would still compete with that frame. Cleanup also covers route/bot switches.
 */
export function afterNextPaint(task: () => void): () => void {
  if (typeof window === 'undefined') {
    task();
    return () => {};
  }
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = setTimeout(() => { if (!cancelled) task(); }, 0);
  };
  const frame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(run)
    : (run(), undefined);
  return () => {
    cancelled = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}
