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
 *     or a signal) is a crash and restarts, under a backoff.
 *     The exit code alone is NOT proof the operator asked for the stop, so the
 *     live layer honours the sentinel only when IT initiated it (fleet-wide
 *     stopping flag / per-bot explicitStop set before the exit arrived); a 90
 *     that arrives without that intent is treated as a crash and restarted, so
 *     a stray signal from outside the supervision tree cannot permanently
 *     retire the fleet.
 *  2. max_restarts limits fast retries; after that, keep retrying at a slower
 *     rate so a temporary outage cannot permanently retire a service.
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
  /** Live OS pid, or 0 when not running. A launching row may retain the old
   * orphan PID until retirement is verified, before a replacement can spawn. */
  pid: number;
  /** Monotonic spawn counter — bumped on every (re)spawn. Addresses a child by
   *  (name, generation) so a stale exit never mutates a newer generation. */
  generation: number;
  status: FleetProcStatus;
  /** Fast-restart count, reset after a stable run or an operator start. */
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
  /** Durable birth identity for reclaiming this exact process generation after
   * supervisor death without ever signaling a recycled or cross-namespace PID. */
  processStart?: string;
}

export interface FleetState {
  supervisorPid: number;
  supervisorStartedAt: string;
  /** Durable birth identity; prevents stale/PID-namespace state from signaling
   * an unrelated process that happens to reuse supervisorPid. */
  supervisorProcessStart?: string;
  /** Linux PID namespace inode (pid:[...]); absent on other platforms. */
  supervisorPidNamespace?: string;
  /** Exact OS command line sampled for the same supervisor generation. */
  supervisorCommand?: string;
  /** Real entry path, used by Desktop to identify the owning installation. */
  supervisorEntry?: string;
  procs: FleetProcState[];
}

export interface RestartPolicy {
  /** Number of fast retries before switching to the cooldown. */
  maxRestarts: number;
  /** Base backoff between crash-restarts (ms); the live layer waits this long. */
  restartDelayMs: number;
  /** Retry interval after the fast-restart budget is exhausted. */
  restartCooldownMs?: number;
  /** A child running this long gets a fresh budget on its next exit. */
  resetAfterMs?: number;
}

export const DEFAULT_RESTART_POLICY = {
  maxRestarts: 10,
  restartDelayMs: 200,
  restartCooldownMs: 60_000,
  resetAfterMs: 60_000,
} satisfies RestartPolicy;

/**
 * Opt-in restart policy for ONE external member, carried on its spec. A member
 * without it is handled by the supervisor-wide {@link RestartPolicy} exactly as
 * before; nothing here applies to bot daemons, the dashboard or plugin services.
 *
 * It exists for a member whose failures are not all worth retrying and whose
 * retries are expensive (today: a WeCom gateway, which starts its own core on
 * every launch):
 *  - some exits mean "retrying cannot help" (the member was replaced by another
 *    instance of the same bot, its credentials were rejected, its configuration
 *    is invalid). The member says so with one of `noRestartExitCodes` and is
 *    parked 'errored' instead of being restarted into the same failure.
 *  - every other exit is retried forever with exponential backoff (up to
 *    `maxDelayMs`) instead of the supervisor-wide fast retries followed by a
 *    fixed cooldown.
 *  - a generation that stayed up for `stableRunMs` starts a fresh backoff
 *    streak, so an exit after hours of service waits the initial delay again.
 */
export interface ExternalRestartPolicy {
  /** Exit codes (with no signal) after which the member is not restarted. */
  noRestartExitCodes: readonly number[];
  /** Delay before the first restart of a backoff streak (ms). */
  initialDelayMs: number;
  /** Upper bound of the doubling delay (ms). */
  maxDelayMs: number;
  /** A generation that ran at least this long before exiting resets the streak (ms). */
  stableRunMs: number;
}

export type ExternalPolicyExitDecision =
  | { action: 'park'; reason: 'no_restart_exit_code' }
  | { action: 'restart'; nextRestarts: number; delayMs: number };

/** Delay before the `attempt`-th consecutive restart (1-based): doubles from
 *  `initialDelayMs`, capped at `maxDelayMs`. */
export function externalRestartDelayMs(policy: ExternalRestartPolicy, attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
}

/**
 * Decide what to do when a member that carries an {@link ExternalRestartPolicy}
 * exits on its own. `restarts` is the persisted streak so far; `ranMs` is how
 * long the generation that just exited was up.
 *   • a no-restart exit code (signal-less) → park 'errored'
 *   • anything else                         → restart after the backoff delay
 * A signal death is always retried: a code from the list only counts when the
 * member chose to exit with it.
 */
export function decideExternalPolicyExit(
  proc: { restarts: number; ranMs: number },
  exit: ChildExit,
  policy: ExternalRestartPolicy,
): ExternalPolicyExitDecision {
  if (exit.signal === null && exit.code !== null && policy.noRestartExitCodes.includes(exit.code)) {
    return { action: 'park', reason: 'no_restart_exit_code' };
  }
  const streak = proc.ranMs >= policy.stableRunMs ? 0 : proc.restarts;
  const nextRestarts = streak + 1;
  return { action: 'restart', nextRestarts, delayMs: externalRestartDelayMs(policy, nextRestarts) };
}

/** A child exit as reported by the OS: a numeric code XOR a signal. */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * True when this exit is a clean, operator-intended shutdown (do NOT restart).
 * ONLY a code === 90 qualifies; a signal death (code null) is always a crash,
 * matching pm2's rule that signal-only death is never a graceful sentinel.
 *
 * `honoursSentinel` is false for a member whose code is NOT ours (an external
 * command / plugin service). 90 is a PRIVATE handshake between botmux's own two
 * managed cores and this policy — a third-party program has never heard of it and
 * may use 90 as an ordinary failure code. Honouring it there means a plugin that
 * dies with 90 is read as "it asked not to be restarted" and silently vanishes,
 * with state showing a bland 'stopped' — defeating the crash-restart machinery
 * that is the whole reason such a service is supervised at all. Under pm2 this
 * could not happen: plugin apps were never given stop_exit_codes, so 90 was just
 * a crash and restarted. Operator-intended stops do NOT rely on the exit code
 * (the live layer marks them via explicitStop/stopping before the exit arrives),
 * so external members lose nothing by refusing the sentinel.
 */
export function isGracefulExit(exit: ChildExit, honoursSentinel = true): boolean {
  return honoursSentinel && exit.signal === null && exit.code === FLEET_GRACEFUL_EXIT_CODE;
}

export type ExitDecision =
  | { action: 'stop'; reason: 'graceful' }
  | { action: 'restart'; nextRestarts: number; delayMs: number };

/** A restart decision on a path where the graceful sentinel is NOT being
 *  honoured (an external/plugin member, or our own member's ordinary exit path
 *  on which a fleet stop / explicit stop-bot was already handled upstream).
 *  Deliberately excludes 'stop' so a caller that already owned the graceful
 *  outcome cannot carry a statically-dead branch. */
export type CrashExitDecision = Extract<ExitDecision, { action: 'restart' }>;

/**
 * Bound the retry rate, not the service's lifetime. A stable run resets the
 * fast-restart budget; repeated short failures keep retrying at the cooldown
 * interval with a saturated counter. The live layer supplies elapsed uptime.
 */
export function decideCrashExit(
  proc: Pick<FleetProcState, 'restarts'>,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
  uptimeMs = 0,
): CrashExitDecision {
  const restarts = uptimeMs >= (policy.resetAfterMs ?? DEFAULT_RESTART_POLICY.resetAfterMs) ? 0 : proc.restarts;
  return {
    action: 'restart',
    nextRestarts: Math.min(restarts + 1, policy.maxRestarts),
    delayMs: restarts >= policy.maxRestarts
      ? policy.restartCooldownMs ?? DEFAULT_RESTART_POLICY.restartCooldownMs
      : policy.restartDelayMs,
  };
}

/**
 * Decide what to do when a supervised proc exits. Pure: the live layer applies
 * the returned action (schedule respawn / write stopped).
 *   • graceful (code 90)            → stop, never restart
 *   • crash & under the cap         → restart (restarts+1)
 *   • crash & at/over the cap       → retry after the cooldown
 *
 * A caller passes honoursSentinel:true ONLY when it independently knows the
 * stop was requested through the sanctioned channel (the live supervisor sets
 * stopping/explicitStop before signaling, and those guards handle the 'stop'
 * outcome itself); it passes false on the ordinary child-exit path so an
 * unsolicited 90 self-heals.
 *
 * `honoursSentinel: false` (an external/plugin member, or an un-attested exit
 * of our own member) makes 90 an ordinary crash code — see isGracefulExit for
 * why a third-party program (or a stray external signal) must not be taken at
 * its word about our private sentinel.
 */
export function decideOnExit(
  proc: Pick<FleetProcState, 'restarts'>,
  exit: ChildExit,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
  honoursSentinel = true,
): ExitDecision {
  if (isGracefulExit(exit, honoursSentinel)) return { action: 'stop', reason: 'graceful' };
  return decideCrashExit(proc, policy);
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
