/**
 * Fleet supervisor — PURE policy layer (no process I/O, no fs, no timers).
 *
 * This is the safety core of the pm2 replacement: it encodes the invariants the
 * old pm2-* guard modules enforced, as pure functions over plain state so they
 * can be unit-tested exhaustively without spawning anything. The live supervisor
 * (fleet-supervisor.ts) owns spawn/kill/fs/timers and calls into here for every
 * decision.
 *
 * Invariants preserved from pm2 (see the design doc):
 *  1. graceful-exit suppresses restart — a child that exits with
 *     DAEMON_GRACEFUL_EXIT_CODE (90) shut down cleanly and must NOT be restarted;
 *     every other exit (including signal death, which surfaces as a non-90 code
 *     or a signal) is a crash and restarts, under a backoff, up to maxRestarts.
 *  2. max_restarts cap — after maxRestarts crash-restarts a proc is parked
 *     'errored' and left alone (no restart storm).
 *  3. projection identity — the fleet's proc set has unique names and no two
 *     live procs share a pid (a duplicate would mean we lost track of a child).
 *  4. idempotent start — starting a fleet that is already fully online is a
 *     no-op; only missing/stopped procs are (re)spawned.
 *  5. generation-safe addressing — every spawn bumps a monotonic generation, so
 *     a kill/exit is always matched to the exact (pid, generation) it targeted
 *     and can never act on a newer replacement child.
 * (Single-supervisor mutual exclusion (flock) and kill_timeout live in the live
 *  layer since they need fs/timers; this module provides the decisions they use.)
 */

/** Clean-shutdown sentinel: a daemon that exits with this code is NOT restarted.
 *  Mirrors pm2's stop_exit_codes:[90] contract (see pm2-graceful-exit.ts). */
export const FLEET_GRACEFUL_EXIT_CODE = 90;

export type FleetProcStatus = 'online' | 'stopped' | 'errored' | 'launching';

/** One supervised bot daemon in the fleet state file. */
export interface FleetProcState {
  /** Stable process name (botmux-<index>), unique across the fleet. */
  name: string;
  /** Owning bot's larkAppId (for status/logs correlation). */
  appId: string;
  /** Live OS pid, or 0 when not running (stopped/errored/launching). */
  pid: number;
  /** Monotonic spawn counter — bumped on every (re)spawn. Addresses a child by
   *  (name, generation) so a stale exit never mutates a newer generation. */
  generation: number;
  status: FleetProcStatus;
  /** Crash-restart count since last clean start; compared against maxRestarts. */
  restarts: number;
  /** Exit code of the last exit (null while running / never exited). */
  lastExitCode: number | null;
  /** ISO timestamp of the last (re)spawn. */
  startedAt: string | null;
  /**
   * For an EXTERNAL member (a plugin service): a hash of the configuration this
   * process was actually started from. Absent for bot daemons and the dashboard,
   * whose configuration is not per-member.
   *
   * WHY IT IS PERSISTED HERE: the caller compares it against the hash of the
   * CURRENT definition to decide "was this started from a stale config, and does
   * it therefore need a restart to pick up the change?". That question can only
   * be answered by something that outlives the spawn, so it has to live in
   * fleet-state next to the pid. pm2 answered it by stashing the hash in its own
   * app metadata (`pm2_env`); fleet-state has no such bag, hence this field —
   * same semantics, different storage.
   */
  configHash?: string;
}

export interface FleetState {
  supervisorPid: number;
  supervisorStartedAt: string;
  procs: FleetProcState[];
}

export interface RestartPolicy {
  maxRestarts: number;
  /** Base backoff between crash-restarts (ms); the live layer waits this long. */
  restartDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { maxRestarts: 10, restartDelayMs: 200 };

/** A child exit as reported by the OS: a numeric code XOR a signal. */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** True when this exit is a clean, operator-intended shutdown (do NOT restart).
 *  ONLY a code === 90 qualifies; a signal death (code null) is always a crash,
 *  matching pm2's rule that signal-only death is never a graceful sentinel. */
export function isGracefulExit(exit: ChildExit): boolean {
  return exit.signal === null && exit.code === FLEET_GRACEFUL_EXIT_CODE;
}

export type ExitDecision =
  | { action: 'stop'; reason: 'graceful' }
  | { action: 'restart'; nextRestarts: number }
  | { action: 'park'; reason: 'max_restarts'; atRestarts: number };

/**
 * Decide what to do when a supervised proc exits. Pure: the live layer applies
 * the returned action (schedule respawn / write stopped / write errored).
 *   • graceful (code 90)            → stop, never restart
 *   • crash & under the cap         → restart (restarts+1)
 *   • crash & at/over the cap       → park errored, stop restarting
 */
export function decideOnExit(
  proc: Pick<FleetProcState, 'restarts'>,
  exit: ChildExit,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): ExitDecision {
  if (isGracefulExit(exit)) return { action: 'stop', reason: 'graceful' };
  const nextRestarts = proc.restarts + 1;
  if (nextRestarts > policy.maxRestarts) {
    return { action: 'park', reason: 'max_restarts', atRestarts: proc.restarts };
  }
  return { action: 'restart', nextRestarts };
}

/**
 * Validate the projection identity invariant over a proc set: names unique,
 * and no two RUNNING procs (pid > 1) share a pid. Throws on violation — the
 * live layer calls this before persisting state so a lost/duplicated child is
 * caught fail-closed instead of silently corrupting the fleet view.
 */
export function assertProjectionIdentity(procs: readonly FleetProcState[]): void {
  const names = new Set<string>();
  const pids = new Map<number, string>();
  for (const p of procs) {
    if (!p.name.trim()) throw new Error('fleet: empty proc name');
    if (names.has(p.name)) throw new Error(`fleet: duplicate proc name ${p.name}`);
    names.add(p.name);
    if (Number.isSafeInteger(p.pid) && p.pid > 1) {
      const prior = pids.get(p.pid);
      if (prior !== undefined) {
        throw new Error(`fleet: duplicate live pid ${p.pid} across ${prior} and ${p.name}`);
      }
      pids.set(p.pid, p.name);
    }
  }
}

/**
 * Idempotent-start planner: given the configured bot names and the current
 * proc states, return which names need (re)spawning. A proc that is already
 * 'online' with a live pid is left alone; 'stopped'/'errored'/'launching'/absent
 * names are (re)started. `isAlive` lets the live layer inject a real `kill -0`
 * liveness probe (default: trust status===online).
 */
export function planStart(
  configuredNames: readonly string[],
  current: readonly FleetProcState[],
  isAlive: (proc: FleetProcState) => boolean = (p) => p.status === 'online' && p.pid > 1,
): string[] {
  const byName = new Map(current.map((p) => [p.name, p]));
  const toStart: string[] = [];
  for (const name of configuredNames) {
    const proc = byName.get(name);
    if (!proc || !isAlive(proc)) toStart.push(name);
  }
  return toStart;
}

/** Fresh state entry for a newly-spawned proc (generation 1, online). */
export function freshProc(name: string, appId: string, pid: number, now: string, configHash?: string): FleetProcState {
  const proc: FleetProcState = { name, appId, pid, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: now };
  // Only external members carry one; keep the key absent otherwise so existing
  // state files and their assertions stay byte-identical.
  if (configHash !== undefined) proc.configHash = configHash;
  return proc;
}
