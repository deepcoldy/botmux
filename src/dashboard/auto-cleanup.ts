/**
 * Scheduled auto-cleanup of idle sessions.
 *
 * Productizes the manual dashboard「清理空闲」button (POST
 * /api/sessions/cleanup-idle) into an unattended, config-driven sweep. When
 * `sessionCleanup.enabled` is on, the dashboard process periodically closes
 * sessions that have been idle longer than the configured threshold — reusing
 * the EXACT same candidate selection and per-session close logic as the button
 * (dashboard/session-cleanup.ts), so the two paths can never diverge on which
 * sessions are safe to close.
 *
 * WHY THE DASHBOARD PROCESS: only the dashboard aggregator holds the
 * cross-bot session view (aggregator.getSessions()) and the per-bot close
 * fan-out (proxyToDaemon → /api/sessions/<id>/close). It is also the single
 * host-wide process, so — unlike the per-bot daemons — a timer here runs
 * exactly once with no N-way duplication (cf. core/maintenance.ts, which must
 * gate itself to bot-0 for the same reason).
 *
 * `evaluateAutoCleanupDue` and `runAutoCleanupTick` are pure over their injected
 * deps (unit tested); startAutoCleanup wires the production timer.
 */
import {
  readGlobalConfig,
  SESSION_CLEANUP_DEFAULT_HOURS,
  SESSION_CLEANUP_DEFAULT_INTERVAL_MINUTES,
  SESSION_CLEANUP_MIN_INTERVAL_MINUTES,
  type SessionCleanupGlobalConfig,
  type SessionCleanupHours,
} from '../global-config.js';
import {
  cleanupIdleSessions,
  parseIdleCleanupHours,
  type IdleCleanupResult,
  type IdleCleanupCloseResult,
  type IdleCleanupSessionRow,
} from './session-cleanup.js';

/** How often the timer wakes to check whether a sweep is due. The actual sweep
 *  cadence is governed by `intervalMinutes` in config; this only bounds how
 *  promptly a config change / due interval is noticed. */
export const AUTO_CLEANUP_TICK_MS = 60_000;

/** Resolve the effective idle threshold, falling back to the default when the
 *  stored value is missing or (defensively) not one of the supported options. */
export function resolveCleanupHours(cfg: SessionCleanupGlobalConfig | undefined): SessionCleanupHours {
  const parsed = parseIdleCleanupHours(cfg?.olderThanHours);
  return (parsed ?? SESSION_CLEANUP_DEFAULT_HOURS) as SessionCleanupHours;
}

/** Resolve the effective check interval in ms, applying the default and the
 *  5-minute floor. A hand-edited sub-floor value is raised, never trusted. */
export function resolveCleanupIntervalMs(cfg: SessionCleanupGlobalConfig | undefined): number {
  const raw = cfg?.intervalMinutes;
  const minutes = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(SESSION_CLEANUP_MIN_INTERVAL_MINUTES, Math.floor(raw))
    : SESSION_CLEANUP_DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

export type AutoCleanupDecision =
  | 'disabled'   // feature off
  | 'not-yet'    // enabled, but the interval since the last run hasn't elapsed
  | 'due';       // run a sweep now

export interface AutoCleanupDueResult {
  decision: AutoCleanupDecision;
  /** Present on 'due': the idle threshold to sweep with. */
  hours?: SessionCleanupHours;
}

/**
 * Pure due-evaluation. `lastRunMs` is when the last sweep started (undefined =
 * never run this process → fire on the first tick after enable). A sweep is due
 * once at least `intervalMinutes` have elapsed since the last run.
 */
export function evaluateAutoCleanupDue(
  cfg: SessionCleanupGlobalConfig | undefined,
  lastRunMs: number | undefined,
  now: number,
): AutoCleanupDueResult {
  if (!cfg?.enabled) return { decision: 'disabled' };
  const intervalMs = resolveCleanupIntervalMs(cfg);
  if (lastRunMs !== undefined && now - lastRunMs < intervalMs) {
    return { decision: 'not-yet' };
  }
  return { decision: 'due', hours: resolveCleanupHours(cfg) };
}

export interface AutoCleanupTickDeps<T extends IdleCleanupSessionRow> {
  now: () => number;
  /** Live global sessionCleanup config (readGlobalConfig().sessionCleanup). */
  readConfig: () => SessionCleanupGlobalConfig | undefined;
  /** Timestamp (ms) the last sweep started, or undefined if none yet. */
  readLastRun: () => number | undefined;
  /** Persist the timestamp a sweep started (so the interval gate survives). */
  writeLastRun: (ms: number) => void;
  /** Current cross-bot session rows (aggregator.getSessions()). */
  getSessions: () => T[];
  /** Close one candidate — the SAME closer the manual route passes to
   *  cleanupIdleSessions (proxyToDaemon → /api/sessions/<id>/close). */
  closeCandidate: (row: T) => Promise<IdleCleanupCloseResult>;
  log?: (msg: string) => void;
}

/**
 * One tick: decide, and if due, run the sweep. Returns the cleanup result when a
 * sweep ran, or null when it was disabled / not yet due. Records the run start
 * time BEFORE awaiting the sweep, so a long sweep can't stack overlapping runs.
 */
export async function runAutoCleanupTick<T extends IdleCleanupSessionRow>(
  deps: AutoCleanupTickDeps<T>,
): Promise<IdleCleanupResult | null> {
  const now = deps.now();
  const cfg = deps.readConfig();
  const due = evaluateAutoCleanupDue(cfg, deps.readLastRun(), now);
  if (due.decision !== 'due' || !due.hours) return null;

  // Stamp the run start first: the interval gate must advance even if the sweep
  // throws or finds nothing, and a slow sweep must not let the next tick start a
  // concurrent one.
  deps.writeLastRun(now);

  const rows = deps.getSessions();
  const result = await cleanupIdleSessions(rows, due.hours, deps.closeCandidate, now);
  if (deps.log && (result.matched > 0 || result.failed > 0)) {
    const residualNote = result.residual > 0 ? `, residual ${result.residual}` : '';
    deps.log(
      `swept idle>${due.hours}h: matched ${result.matched}, closed ${result.closed}, `
      + `failed ${result.failed}${residualNote}`,
    );
  }
  return result;
}

/**
 * Wrap a tick in a single-flight gate. Timer callbacks may arrive while a large
 * sweep is still closing candidates; those overlapping callbacks resolve to
 * null instead of starting a second sweep over the same rows.
 */
export function createAutoCleanupTickRunner<T extends IdleCleanupSessionRow>(
  deps: AutoCleanupTickDeps<T>,
): () => Promise<IdleCleanupResult | null> {
  let active: Promise<IdleCleanupResult | null> | undefined;
  return () => {
    if (active) return Promise.resolve(null);
    const run = runAutoCleanupTick(deps);
    active = run;
    return run.finally(() => {
      if (active === run) active = undefined;
    });
  };
}

let timer: NodeJS.Timeout | undefined;
let startupTimer: NodeJS.Timeout | undefined;
let lastRunMs: number | undefined;

/**
 * Start the auto-cleanup timer. Call once, on the dashboard process only.
 * Idempotent. Deps are injected so production wiring stays thin and testable.
 */
export function startAutoCleanup(deps: {
  getSessions: () => IdleCleanupSessionRow[];
  closeCandidate: (row: IdleCleanupSessionRow) => Promise<IdleCleanupCloseResult>;
  log?: (msg: string) => void;
}): void {
  if (timer || startupTimer) return;
  const tickDeps: AutoCleanupTickDeps<IdleCleanupSessionRow> = {
    now: () => Date.now(),
    readConfig: () => readGlobalConfig().sessionCleanup,
    readLastRun: () => lastRunMs,
    writeLastRun: (ms) => { lastRunMs = ms; },
    getSessions: deps.getSessions,
    closeCandidate: deps.closeCandidate,
    log: deps.log,
  };
  const runTick = createAutoCleanupTickRunner(tickDeps);
  const tick = () => {
    void runTick().catch((e) => {
      deps.log?.(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  // First check shortly after startup (so an already-enabled config sweeps
  // promptly), then on a steady cadence.
  startupTimer = setTimeout(() => {
    startupTimer = undefined;
    tick();
  }, 15_000);
  startupTimer.unref?.();
  timer = setInterval(tick, AUTO_CLEANUP_TICK_MS);
  timer.unref?.();
}

export function stopAutoCleanup(): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
  if (timer) { clearInterval(timer); timer = undefined; }
}
