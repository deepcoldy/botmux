/**
 * Graceful-shutdown budgets are shared with the CLI/fleet supervisor. Keep the
 * ordering monotonic: the longest pre-lineage remote operation is bounded at
 * 10s, admission restoration after a refused prepare at 11s, and ordinary
 * worker exit at 3s. Shutdown never cancels accepted remote work as a fallback.
 *
 * The default preserves the short local shutdown contract. Deployments whose
 * remote turns legitimately run longer can widen the complete contract through
 * one provider-neutral environment variable; every outer budget is derived
 * below so the daemon cannot silently outlive its supervisor.
 */
export const REMOTE_SHUTDOWN_DRAIN_TIMEOUT_ENV = 'BOTMUX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS';
export const DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000;
export const MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000;
export const MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS = 86_400_000;

export function parseRemoteShutdownDrainTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${REMOTE_SHUTDOWN_DRAIN_TIMEOUT_ENV} must be a base-10 positive integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
    || parsed > MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
  ) {
    throw new Error(
      `${REMOTE_SHUTDOWN_DRAIN_TIMEOUT_ENV} must be between `
      + `${MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS} and ${MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export const REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS = parseRemoteShutdownDrainTimeoutMs(
  process.env[REMOTE_SHUTDOWN_DRAIN_TIMEOUT_ENV],
);

/** Admission restoration can wait for the same bounded 10s create/follow-up
 * that prepare was draining. The daemon keeps its retirement fence throughout. */
export const REMOTE_ADMISSION_RESTORE_TIMEOUT_MS = 11_000;

/** Bounded acquisition of the bot-wide mutation lease. A timed-out waiter is
 * removed and can never run after shutdown has already been refused. */
export const BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS = 1_000;

/** Initial all-owner snapshot and phase-2 batch CAS each use one short lock. */
export const REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS = 1_000;
export const REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS = 1_000;

/** A provider terminal is not yet user-visible completion: the daemon still
 * has to deliver the final reply to the external IM sink. Keep this as a
 * separate outer-shutdown reserve so a long active turn cannot consume the
 * final-delivery window. The ordinary final pipeline retries at 0s, +5s and
 * +15s, so 20s covers its complete scheduling backoff. */
export const REMOTE_SHUTDOWN_FINAL_OUTPUT_DRAIN_TIMEOUT_MS = 20_000;

/** Scheduling/logging slack inside the supervisor-visible daemon budget. */
export const DAEMON_SHUTDOWN_OVERHEAD_MS = 2_000;
export const DAEMON_WORKER_EXIT_GRACE_MS = 3_000;

/**
 * Bound for settling live CoT thinking bubbles as「中断」on the graceful path.
 *
 * Deliberately NOT a new addend of DAEMON_SHUTDOWN_MAX_MS: this is a sub-budget
 * spent inside the existing remote-drain envelope — the
 * remote-drain phase it borrows from is entered only by remote backends
 * (`shutdownBackendDisposition` → 'remote-drain-detach', i.e. riff/mojo),
 * while pty/tmux sessions take 'detach'/'close' and never spend it. Every
 * caller additionally clamps to the absolute shutdown deadline. Cosmetic work
 * must never be the reason a shutdown misses its deadline.
 */
export const DAEMON_COT_SETTLE_MS = 2_000;
export const PM2_DAEMON_RESTART_DELAY_MS = 3_000;
/** A full restart-delay plus projection jitter. The fleet helper must observe
 * this quiet window after every signalled generation exits. */
export const FLEET_SUCCESSOR_SETTLE_MS = PM2_DAEMON_RESTART_DELAY_MS + 500;
export const DEFAULT_FLEET_DAEMON_EXIT_WAIT_MS = 60_000;
export const FLEET_DAEMON_KILL_SLACK_MS = 1_000;
export const FLEET_DAEMON_EXIT_SLACK_MS = 1_000;

export interface ShutdownBudgets {
  daemonShutdownMaxMs: number;
  fleetDaemonKillTimeoutMs: number;
  fleetDaemonExitWaitMs: number;
}

export function deriveShutdownBudgets(remoteDrainTimeoutMs: number): ShutdownBudgets {
  if (
    !Number.isSafeInteger(remoteDrainTimeoutMs)
    || remoteDrainTimeoutMs < MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
    || remoteDrainTimeoutMs > MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
  ) {
    throw new Error('remote shutdown drain timeout is outside the supported range');
  }
  const daemonShutdownMaxMs =
    BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
    + REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
    + remoteDrainTimeoutMs
    + REMOTE_SHUTDOWN_FINAL_OUTPUT_DRAIN_TIMEOUT_MS
    + REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
    + Math.max(REMOTE_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
    + DAEMON_SHUTDOWN_OVERHEAD_MS;
  const fleetDaemonKillTimeoutMs = daemonShutdownMaxMs + FLEET_DAEMON_KILL_SLACK_MS;
  const fleetDaemonExitWaitMs = Math.max(
    DEFAULT_FLEET_DAEMON_EXIT_WAIT_MS,
    fleetDaemonKillTimeoutMs + FLEET_SUCCESSOR_SETTLE_MS + FLEET_DAEMON_EXIT_SLACK_MS,
  );
  return { daemonShutdownMaxMs, fleetDaemonKillTimeoutMs, fleetDaemonExitWaitMs };
}

const derivedBudgets = deriveShutdownBudgets(REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS);
export const DAEMON_SHUTDOWN_MAX_MS = derivedBudgets.daemonShutdownMaxMs;
/** Supervisor SIGTERM→SIGKILL budget. Must exceed DAEMON_SHUTDOWN_MAX_MS. */
export const FLEET_DAEMON_KILL_TIMEOUT_MS = derivedBudgets.fleetDaemonKillTimeoutMs;
/** CLI wait budget. Must cover supervisor hard-stop plus successor quiet time. */
export const FLEET_DAEMON_EXIT_WAIT_MS = derivedBudgets.fleetDaemonExitWaitMs;

if (FLEET_DAEMON_KILL_TIMEOUT_MS <= DAEMON_SHUTDOWN_MAX_MS) {
  throw new Error('fleet supervisor killTimeoutMs must exceed the complete daemon shutdown budget');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= FLEET_DAEMON_KILL_TIMEOUT_MS) {
  throw new Error('fleet restart wait must exceed the fleet supervisor killTimeoutMs');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= DAEMON_SHUTDOWN_MAX_MS + FLEET_SUCCESSOR_SETTLE_MS) {
  throw new Error('fleet restart wait must cover daemon shutdown plus successor quiet window');
}
if (FLEET_DAEMON_EXIT_WAIT_MS <= FLEET_DAEMON_KILL_TIMEOUT_MS + FLEET_SUCCESSOR_SETTLE_MS) {
  throw new Error('fleet restart wait must cover fleet supervisor killTimeoutMs plus successor quiet window');
}
