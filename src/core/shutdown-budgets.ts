/**
 * Graceful-shutdown budgets are ordered so a bounded Riff create/follow-up can
 * drain before the daemon persists its final lineage and asks workers to exit.
 * Shutdown never cancels accepted Riff work as a fallback.
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

/** Scheduling/logging slack inside the graceful daemon shutdown budget. */
export const DAEMON_SHUTDOWN_OVERHEAD_MS = 2_000;
export const DAEMON_WORKER_EXIT_GRACE_MS = 3_000;
export const DAEMON_SHUTDOWN_MAX_MS =
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
  + RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
  + RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS
  + RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
  + Math.max(RIFF_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
  + DAEMON_SHUTDOWN_OVERHEAD_MS;

if (DAEMON_SHUTDOWN_MAX_MS > 28_000) {
  throw new Error('complete daemon shutdown budget must remain at or below 28 seconds');
}
