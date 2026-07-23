/**
 * Graceful-shutdown budgets are shared with the CLI/PM2 supervisor. Keep the
 * ordering monotonic: a Riff create/follow-up fetch is bounded at 10s,
 * admission restoration after a refused prepare at 11s, and ordinary worker
 * exit at 3s. Shutdown never cancels accepted Riff work as a fallback.
 */
export const RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000;
/** Admission restoration can wait for the same bounded 10s create/follow-up
 * that prepare was draining. The daemon keeps its retirement fence throughout. */
export const RIFF_ADMISSION_RESTORE_TIMEOUT_MS = 11_000;
/** Bounded acquisition of the bot-wide mutation lease. A timed-out waiter is
 * removed and can never run after shutdown has already been refused. */
export const BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS = 1_000;
/** Initial all-owner snapshot and phase-2 batch CAS each use one short lock. */
export const RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS = 1_000;
export const RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS = 1_000;
/** Scheduling/logging slack inside the supervisor-visible daemon budget. */
export const DAEMON_SHUTDOWN_OVERHEAD_MS = 2_000;
export const DAEMON_WORKER_EXIT_GRACE_MS = 3_000;
export const DAEMON_SHUTDOWN_MAX_MS =
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
  + RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
  + RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS
  + RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
  + Math.max(RIFF_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
  + DAEMON_SHUTDOWN_OVERHEAD_MS;
export const PM2_DAEMON_KILL_TIMEOUT_MS = 29_000;
export const PM2_DAEMON_RESTART_DELAY_MS = 3_000;
/** A full restart-delay plus projection jitter. The fleet helper must observe
 * this quiet window after every signalled generation exits. */
export const FLEET_SUCCESSOR_SETTLE_MS = PM2_DAEMON_RESTART_DELAY_MS + 500;
export const FLEET_DAEMON_EXIT_WAIT_MS = 60_000;

if (PM2_DAEMON_KILL_TIMEOUT_MS <= DAEMON_SHUTDOWN_MAX_MS) {
  throw new Error('PM2 daemon kill timeout must exceed the complete daemon shutdown budget');
}
if (DAEMON_SHUTDOWN_MAX_MS > 28_000) {
  throw new Error('complete daemon shutdown budget must remain at or below 28 seconds');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= PM2_DAEMON_KILL_TIMEOUT_MS) {
  throw new Error('fleet restart wait must exceed the PM2 daemon kill timeout');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= DAEMON_SHUTDOWN_MAX_MS + FLEET_SUCCESSOR_SETTLE_MS) {
  throw new Error('fleet restart wait must cover daemon shutdown plus successor quiet window');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= PM2_DAEMON_KILL_TIMEOUT_MS + FLEET_SUCCESSOR_SETTLE_MS) {
  throw new Error('fleet restart wait must cover PM2 kill timeout plus successor quiet window');
}
