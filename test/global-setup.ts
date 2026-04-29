/**
 * Vitest globalSetup. Runs once before any test file.
 *
 * In e2e mode (BOTMUX_E2E=1, set by scripts/run-e2e.ts) it sweeps stale botmux
 * scheduled tasks left over by previous test runs — tasks whose name matches
 * `sched-<digits>` and whose createdAt is older than 1 day. Outside e2e mode
 * this is a no-op so unit tests don't touch the developer's daemon state.
 */
export default async function globalSetup() {
  if (!process.env.BOTMUX_E2E) return;
  try {
    const { sweepOrphanSchedTasks } = await import('./e2e-browser/schedule-cleanup.js');
    const removed = await sweepOrphanSchedTasks(1);
    if (removed.length > 0) {
      console.warn(
        `[e2e globalSetup] swept ${removed.length} orphan schedule task(s): ${removed.join(', ')}`,
      );
    }
  } catch (err) {
    console.warn(`[e2e globalSetup] sweep skipped: ${(err as Error).message}`);
  }
}
