import type { DaemonSession } from './types.js';
import { isSessionTransferring, suspendWorker } from './worker-pool.js';
import {
  getSessionPersistentBackendType,
  isSuspendableBackendType,
  persistentBackendTargetForSession,
} from './persistent-backend.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { logger } from '../utils/logger.js';

/**
 * Default per-bot live-session cap applied when a bot has no explicit
 * `maxLiveWorkers` configured. Keeps memory bounded out of the box: beyond this
 * many live sessions, the least-recently-used ones are suspended (CLI freed,
 * cold-resumes from transcript on the next message). A bot can override it from
 * the dashboard. NOTE: the dashboard help copy hardcodes this number
 * ('botDefaults.maxLiveWorkers*' i18n) — keep them in sync.
 */
export const DEFAULT_MAX_LIVE_WORKERS = 30;
export const IDLE_WORKER_SWEEP_MUTATION_ACQUIRE_TIMEOUT_MS = 1_000;
/**
 * Upper bound on idle workers suspended to rescue one marginal (within-10%)
 * worker-admission fork. Reclaiming more risks churning sessions without a
 * measurable payoff — the rescued fork itself adds one live worker back.
 */
export const ADMISSION_RECLAIM_MAX_SUSPEND = 4;
export const ADMISSION_RECLAIM_REASON = 'admission_memory';
export const IDLE_TTL_REASON = 'idle_ttl';

export interface IdleWorkerSweepOptions {
  /**
   * Explicit per-bot cap for THIS bot (one daemon = one bot, so the whole
   * `activeSessions` map belongs to a single bot). `undefined` (bot unset) →
   * fall back to {@link DEFAULT_MAX_LIVE_WORKERS}. `≤0` → no cap (escape hatch:
   * never count-suspend).
   */
  maxLiveWorkers?: number;
  /**
   * Per-bot idle time-to-live: a session whose status has been continuously
   * `idle` for this long is suspended regardless of the count cap.
   * `undefined` → TTL sweep disabled (the default).
   */
  idleTtlMs?: number;
  /** Injected clock for tests; production uses Date.now(). */
  now?: number;
  /**
   * Bound how long a detached sweep may wait for already-admitted turns.
   * A wedged admission must not hold the bot-wide mutation gate forever.
   */
  mutationAcquireTimeoutMs?: number;
}

export interface ReclaimIdleWorkersOptions {
  /** Defaults to {@link ADMISSION_RECLAIM_MAX_SUSPEND}. */
  maxSuspend?: number;
  /**
   * Session that requested the rescue — never a reclaim candidate. Today the
   * requester has no live worker at admission time so this is unreachable, but
   * forkWorker also supports live-worker kill-refork; this keeps a future idle
   * live-worker caller from suspending itself.
   */
  excludeSessionId?: string;
  mutationAcquireTimeoutMs?: number;
}

export interface IdleWorkerSweepResult {
  sessionId: string;
  reason: string;
}

export interface IdleSuspendCandidate {
  sessionId: string;
  larkAppId: string;
  title: string;
  lastActivityAt: number;
  idleForMs: number;
  workerPid?: number;
  backendType: string;
  backendTarget?: string;
  processTypes: string[];
  backingReleased?: boolean;
  workerRetirementRequested?: boolean;
}

export interface IdleAgeSweepOptions {
  olderThanMs: number;
  now?: number;
  mutationAcquireTimeoutMs?: number;
}

export interface IdleAgeSweepFailure {
  candidate: IdleSuspendCandidate;
  error: 'session_changed' | 'suspend_refused' | 'suspend_failed';
}

export interface IdleAgeSweepResult {
  candidates: IdleSuspendCandidate[];
  suspended: IdleSuspendCandidate[];
  failures: IdleAgeSweepFailure[];
}

function liveWorkers(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  return [...activeSessions.values()].filter(ds => !!ds.worker && !ds.worker.killed);
}

function uniqueLiveWorkers(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  const seen = new Set<string>();
  return liveWorkers(activeSessions).filter(ds => {
    const sessionId = ds.session.sessionId;
    if (seen.has(sessionId)) return false;
    seen.add(sessionId);
    return true;
  });
}

function conservativeIdleActivityAt(ds: DaemonSession): number | undefined {
  const persisted = Date.parse(ds.session.lastMessageAt ?? '');
  // idleSinceAt and spawnedAt are conservative safety clocks: an old message
  // must not make a newly-idle or newly-restored worker look seven days idle.
  const values = [persisted, ds.lastMessageAt, ds.idleSinceAt, ds.spawnedAt]
    .filter((value): value is number => typeof value === 'number'
      && Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function hasUnsettledIdleSuspendState(ds: DaemonSession): boolean {
  return hasProtectedSessionMutationOwnership(ds)
    || isSessionTransferring(ds)
    || !!ds.pendingRepo
    || !!ds.pendingRepoCommitInFlight
    || !!ds.worktreeCreating
    || !!ds.pendingRawInput
    || !!ds.pendingFollowUpInput
    || (ds.pendingFollowUps?.length ?? 0) > 0
    || !!ds.cascadeInFlight
    || (ds.cascadeDeferred?.length ?? 0) > 0
    || !!ds.tuiPromptCardId
    || (ds.tuiPromptOptions?.length ?? 0) > 0
    || !!ds.tuiPromptProcessing
    || !!ds.agentAttention
    || !!ds.usageLimit
    // Background tasks still running die with the CLI (same guard as the
    // cap / TTL / admission candidates in suspendableIdleCandidates).
    || (ds.backgroundTaskCount ?? 0) > 0
    || (ds.finalOutputDeliveriesInFlight?.size ?? 0) > 0
    || !!ds.pendingSuspendReason
    || ds.pendingSuspendGeneration !== undefined
    || ds.remoteCloseState !== undefined
    || ds.remoteShutdownState !== undefined;
}

function expectedReleasedProcessTypes(ds: DaemonSession, backendType: string): string[] {
  const cliId = ds.session.cliId ?? ds.initConfig?.cliId ?? 'cli';
  const processTypes = ['botmux __worker', `${backendType} session`, cliId];
  if (cliId === 'traex') processTypes.push('traex-code-mode-host');
  return processTypes;
}

/**
 * Read-only candidate selection for the operator maintenance command. This is
 * intentionally stricter than memory-pressure reclaim: unknown readiness or
 * activity fails closed, and manually locked / user-attention sessions are
 * never proposed. Selection uses daemon-owned runtime state, not `botmux list`
 * process guesses.
 */
export function selectIdleSuspendCandidates(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleAgeSweepOptions,
): IdleSuspendCandidate[] {
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs <= 0) return [];
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) return [];

  return uniqueLiveWorkers(activeSessions)
    .filter(ds => ds.session.status === 'active')
    .filter(ds => !ds.adoptedFrom && !ds.session.adoptedFrom && !ds.initConfig?.adoptMode)
    .filter(ds => ds.session.locked !== true)
    .filter(ds => getSessionPersistentBackendType(ds) !== undefined)
    .filter(ds => ds.workerReady === true && ds.lastScreenStatus === 'idle')
    .filter(ds => !hasUnsettledIdleSuspendState(ds))
    .map((ds): IdleSuspendCandidate | undefined => {
      const lastActivityAt = conservativeIdleActivityAt(ds);
      if (lastActivityAt === undefined || lastActivityAt > now
        || now - lastActivityAt < opts.olderThanMs) return undefined;
      const backend = persistentBackendTargetForSession(ds);
      if (!backend) return undefined;
      const backendTarget = 'agentName' in backend && backend.agentName
        ? `${backend.sessionName}:${backend.agentName}`
        : backend.sessionName;
      return {
        sessionId: ds.session.sessionId,
        larkAppId: ds.larkAppId,
        title: ds.session.title ?? '',
        lastActivityAt,
        idleForMs: now - lastActivityAt,
        ...(ds.worker?.pid !== undefined ? { workerPid: ds.worker.pid } : {}),
        backendType: backend.backendType,
        backendTarget,
        processTypes: expectedReleasedProcessTypes(ds, backend.backendType),
      };
    })
    .filter((candidate): candidate is IdleSuspendCandidate => candidate !== undefined)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
}

export function sweepIdleWorkersByAge(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleAgeSweepOptions,
): IdleAgeSweepResult {
  const candidates = selectIdleSuspendCandidates(activeSessions, opts);
  const bySessionId = new Map(
    uniqueLiveWorkers(activeSessions).map(ds => [ds.session.sessionId, ds] as const),
  );
  const suspended: IdleSuspendCandidate[] = [];
  const failures: IdleAgeSweepFailure[] = [];
  for (const candidate of candidates) {
    const ds = bySessionId.get(candidate.sessionId);
    if (!ds) {
      failures.push({ candidate, error: 'session_changed' });
      continue;
    }
    try {
      if (suspendWorker(ds, 'idle_timeout')) {
        suspended.push({
          ...candidate,
          backingReleased: true,
          workerRetirementRequested: true,
        });
      }
      else failures.push({ candidate, error: 'suspend_refused' });
    } catch (error) {
      failures.push({ candidate, error: 'suspend_failed' });
      logger.error(
        `[idle-suspend] failed session=${candidate.sessionId} bot=${candidate.larkAppId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { candidates, suspended, failures };
}

/**
 * Batch variant for the operator route. The verifier's kill/probe are
 * synchronous spawns (tmux/herdr/zellij CLI calls with multi-second deadlines,
 * up to two attempts each), so back-to-back candidates block the daemon event
 * loop for the sum of their worst-case durations. Yielding between candidates
 * (setImmediate, which runs after pending I/O) keeps Lark events, other
 * sessions and dashboard IPC flowing and bounds any single stall to one
 * candidate's teardown.
 *
 * Every candidate is re-checked against live state immediately before acting:
 * the previous candidate's kill/probe yielded the loop, so a worker screen can
 * have flipped idle→working (a scheduled turn) or an attention/prompt marker
 * can have arrived without a new admitted turn — the mutation gate blocks
 * admissions, not worker IPC observations.
 */
export async function sweepIdleWorkersByAgeAsync(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleAgeSweepOptions,
  yieldBetweenCandidates: () => Promise<void> = () => new Promise<void>(resolve => setImmediate(resolve)),
): Promise<IdleAgeSweepResult> {
  const candidates = selectIdleSuspendCandidates(activeSessions, opts);
  const suspended: IdleSuspendCandidate[] = [];
  const failures: IdleAgeSweepFailure[] = [];
  for (const candidate of candidates) {
    await yieldBetweenCandidates();
    // Re-run the full guard set rather than re-checking one field: the
    // eligibility predicate must stay identical to the dry-run selection.
    const stillEligible = selectIdleSuspendCandidates(activeSessions, {
      ...opts,
      now: opts.now ?? Date.now(),
    }).some(item => item.sessionId === candidate.sessionId);
    if (!stillEligible) {
      failures.push({ candidate, error: 'session_changed' });
      continue;
    }
    const bySessionId = new Map(
      uniqueLiveWorkers(activeSessions).map(ds => [ds.session.sessionId, ds] as const),
    );
    const ds = bySessionId.get(candidate.sessionId);
    if (!ds) {
      failures.push({ candidate, error: 'session_changed' });
      continue;
    }
    try {
      if (suspendWorker(ds, 'idle_timeout')) {
        suspended.push({
          ...candidate,
          backingReleased: true,
          workerRetirementRequested: true,
        });
      }
      else failures.push({ candidate, error: 'suspend_refused' });
    } catch (error) {
      failures.push({ candidate, error: 'suspend_failed' });
      logger.error(
        `[idle-suspend] failed session=${candidate.sessionId} bot=${candidate.larkAppId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { candidates, suspended, failures };
}

export function sweepIdleWorkersByAgeAfterTurnDrain(
  larkAppId: string,
  activeSessions: Map<string, DaemonSession>,
  opts: IdleAgeSweepOptions,
): Promise<IdleAgeSweepResult | null> {
  return tryWithBotTurnMutation(
    larkAppId,
    opts.mutationAcquireTimeoutMs ?? IDLE_WORKER_SWEEP_MUTATION_ACQUIRE_TIMEOUT_MS,
    () => sweepIdleWorkersByAgeAsync(activeSessions, opts),
  ).then(result => result.acquired ? result.value : null);
}

/**
 * Shared candidate guards for every reclaim policy (count cap, idle TTL,
 * admission rescue). A live worker is eligible only when:
 *  - it is NOT an adopted session (suspending it would silently turn an
 *    observe/bridge session into a normal botmux session on resume), and
 *  - its backend survives a kill + cold resume (tmux/herdr/zellij/zmx only;
 *    pty/riff/mojo are skipped), and
 *  - it is currently idle (never cut off an in-flight reply), and
 *  - no background task it launched is still running.
 * Ordered least-recently-messaged first so all policies evict LRU.
 */
function suspendableIdleCandidates(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  return liveWorkers(activeSessions)
    // Never suspend an adopted session. forkAdoptWorker stamps its
    // initConfig.backendType as tmux/herdr/zellij/zmx (so it would otherwise pass
    // isSuspendableBackendType), but the worker-null resume path in daemon.ts
    // re-forks via forkWorker — NOT forkAdoptWorker — so a suspended adopt
    // session would come back as a normal botmux bmx-* session, losing its
    // observe/bridge semantics and pushing wrapped messages into the user's
    // un-injected external CLI. Check both the runtime mirror and the persisted
    // marker so a restored adopt session is excluded too.
    .filter(ds => !ds.adoptedFrom && !ds.session.adoptedFrom)
    .filter(ds => isSuspendableBackendType(ds.initConfig?.backendType))
    // Correctness guard (not a timeout): never suspend a session that is
    // currently producing output — that would cut off an in-flight reply.
    .filter(ds => ds.lastScreenStatus === 'idle')
    // Same guard for work the turn left running: a CI monitor or test run in
    // the background (the card's 「后台子任务运行中（N）」) dies with the CLI and
    // a cold resume cannot bring it back, so the session would never hear its
    // result. Such a session counts as busy until the task stops.
    .filter(ds => !(ds.backgroundTaskCount && ds.backgroundTaskCount > 0))
    .sort((a, b) => (a.lastMessageAt || 0) - (b.lastMessageAt || 0));
}

function isCurrentSuspendableIdleCandidate(
  activeSessions: Map<string, DaemonSession>,
  candidate: DaemonSession,
): boolean {
  // Require the exact generation object selected before the async boundary.
  // A replacement generation with the same durable session id is new work and
  // must wait for a later sweep instead of inheriting this candidate snapshot.
  // Reuse the selector itself so later guard additions cannot drift between
  // initial selection and the pre-kill recheck.
  return suspendableIdleCandidates(activeSessions).includes(candidate);
}

function idleTtlExpiredNow(ds: DaemonSession, opts: IdleWorkerSweepOptions): boolean {
  return opts.idleTtlMs !== undefined
    && ds.idleSinceAt !== undefined
    && ds.idleSinceAt + opts.idleTtlMs <= (opts.now ?? Date.now());
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

function suspendAutomaticCandidate(
  ds: DaemonSession,
  reason: string,
  policy: 'cap_ttl' | 'admission',
): boolean {
  try {
    const suspended = suspendWorker(ds, reason);
    if (!suspended) {
      logger.warn(
        `[idle-worker-sweeper] candidate refused session=${ds.session.sessionId} `
        + `policy=${policy} reason=${reason}`,
      );
    }
    return suspended;
  } catch (error) {
    logger.error(
      `[idle-worker-sweeper] candidate failed session=${ds.session.sessionId} `
      + `policy=${policy} reason=${reason}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Count-based live-worker cap plus optional idle TTL. When this bot has more
 * live workers than its configured `maxLiveWorkers`, its longest-idle (by
 * lastMessageAt) eligible sessions are suspended down to the cap
 * ('live_worker_cap'). Independently, when `idleTtlMs` is set, every eligible
 * session that has stayed idle past the TTL is suspended ('idle_ttl'), even
 * while under the cap. The two policies take the UNION of the same ordered,
 * guarded candidate list in one pass and reuse the same suspendWorker path.
 *
 * The count policy deliberately has NO idle-time threshold: while resources
 * allow, an old session is never timed out by the cap. A session mid-turn
 * (`lastScreenStatus !== 'idle'`), or one whose background tasks still run, is
 * never suspended. If every over-cap session is busy, none are count-suspended
 * this round and the next sweep retries.
 */
export function sweepIdleWorkers(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleWorkerSweepOptions = {},
): IdleWorkerSweepResult[] {
  const cap = opts.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS;
  const ttlEnabled = opts.idleTtlMs !== undefined;
  const running = liveWorkers(activeSessions);
  const overCap = cap > 0 ? Math.max(0, running.length - cap) : 0;
  if (!ttlEnabled && (cap <= 0 || overCap === 0)) return [];

  const now = opts.now ?? Date.now();
  const ttlExpired = new Set<string>();
  if (ttlEnabled) {
    for (const ds of running) {
      // Sessions without a stamped idle edge (e.g. restored mid-idle after a
      // daemon restart) are NOT TTL-suspended until the next real idle edge.
      if (ds.idleSinceAt !== undefined && ds.idleSinceAt + (opts.idleTtlMs as number) <= now) {
        ttlExpired.add(ds.session.sessionId);
      }
    }
    if (overCap === 0 && ttlExpired.size === 0) return [];
  }

  const suspended: IdleWorkerSweepResult[] = [];
  let liveCount = running.length;
  for (const ds of suspendableIdleCandidates(activeSessions)) {
    const isTtl = ttlExpired.has(ds.session.sessionId);
    // TTL victims suspend regardless of the cap; a non-TTL candidate only
    // fills the count backfill while still over cap (TTL suspensions lower
    // liveCount too, so the cap may be reached early). `continue` (not break):
    // later TTL-due entries must still be visited.
    if (!isTtl && (cap <= 0 || liveCount <= cap)) continue;
    const reason = isTtl ? IDLE_TTL_REASON : 'live_worker_cap';
    if (!suspendWorker(ds, reason)) continue;
    suspended.push({ sessionId: ds.session.sessionId, reason });
    liveCount--;
  }
  return suspended;
}

/**
 * Event-loop-friendly automatic cap/TTL sweep. The synchronous API above stays
 * available for explicit callers and legacy tests; daemon automatic paths use
 * this variant so each candidate gets an I/O turn and a fresh generation/state
 * check immediately before its synchronous kill + post-probe.
 */
export async function sweepIdleWorkersAsync(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleWorkerSweepOptions = {},
  yieldBetweenCandidates: () => Promise<void> = yieldToEventLoop,
): Promise<IdleWorkerSweepResult[]> {
  const cap = opts.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS;
  const ttlEnabled = opts.idleTtlMs !== undefined;
  const initialRunning = liveWorkers(activeSessions);
  const initiallyOverCap = cap > 0 ? initialRunning.length > cap : false;
  const initiallyTtlDue = ttlEnabled && initialRunning.some(ds => idleTtlExpiredNow(ds, opts));
  if (!initiallyOverCap && !initiallyTtlDue) return [];

  const candidates = suspendableIdleCandidates(activeSessions);
  const suspended: IdleWorkerSweepResult[] = [];
  for (const candidate of candidates) {
    await yieldBetweenCandidates();
    if (!isCurrentSuspendableIdleCandidate(activeSessions, candidate)) continue;

    const isTtl = idleTtlExpiredNow(candidate, opts);
    const isOverCap = cap > 0 && liveWorkers(activeSessions).length > cap;
    if (!isTtl && !isOverCap) continue;
    const reason = isTtl ? IDLE_TTL_REASON : 'live_worker_cap';
    if (!suspendAutomaticCandidate(candidate, reason, 'cap_ttl')) continue;
    suspended.push({ sessionId: candidate.session.sessionId, reason });
  }
  return suspended;
}

/**
 * Reclaim idle workers to rescue a fork that was rejected in the marginal
 * memory band (available memory below reserve by ≤10%). Same candidate guards
 * as {@link sweepIdleWorkers}, but the count cap is IGNORED: admission rescue is
 * itself the memory-protection action. At most `maxSuspend` LRU sessions are
 * suspended. Returns the sessions actually suspended ('admission_memory').
 */
export function reclaimIdleWorkersForAdmission(
  activeSessions: Map<string, DaemonSession>,
  opts: ReclaimIdleWorkersOptions = {},
): IdleWorkerSweepResult[] {
  const maxSuspend = opts.maxSuspend ?? ADMISSION_RECLAIM_MAX_SUSPEND;
  if (maxSuspend <= 0) return [];
  const suspended: IdleWorkerSweepResult[] = [];
  for (const ds of suspendableIdleCandidates(activeSessions)) {
    if (suspended.length >= maxSuspend) break;
    if (opts.excludeSessionId !== undefined && ds.session.sessionId === opts.excludeSessionId) continue;
    if (!suspendWorker(ds, ADMISSION_RECLAIM_REASON)) continue;
    suspended.push({ sessionId: ds.session.sessionId, reason: ADMISSION_RECLAIM_REASON });
  }
  return suspended;
}

/** Async automatic admission reclaim with per-candidate revalidation/isolation. */
export async function reclaimIdleWorkersForAdmissionAsync(
  activeSessions: Map<string, DaemonSession>,
  opts: ReclaimIdleWorkersOptions = {},
  yieldBetweenCandidates: () => Promise<void> = yieldToEventLoop,
): Promise<IdleWorkerSweepResult[]> {
  const maxSuspend = opts.maxSuspend ?? ADMISSION_RECLAIM_MAX_SUSPEND;
  if (maxSuspend <= 0) return [];
  const candidates = suspendableIdleCandidates(activeSessions);
  const suspended: IdleWorkerSweepResult[] = [];
  for (const candidate of candidates) {
    if (suspended.length >= maxSuspend) break;
    await yieldBetweenCandidates();
    if (!isCurrentSuspendableIdleCandidate(activeSessions, candidate)) continue;
    if (opts.excludeSessionId !== undefined
      && candidate.session.sessionId === opts.excludeSessionId) continue;
    if (!suspendAutomaticCandidate(candidate, ADMISSION_RECLAIM_REASON, 'admission')) continue;
    suspended.push({
      sessionId: candidate.session.sessionId,
      reason: ADMISSION_RECLAIM_REASON,
    });
  }
  return suspended;
}

/**
 * Run a cap/TTL sweep only after every already-admitted inbound turn has either
 * durably accepted its input or finished.  A worker spawn can put the bot over
 * cap while another handler is paused in sender/reaction setup, before that
 * handler has changed its screen status or dispatch ledger.  A synchronous
 * sweep could otherwise mistake that handler's worker for idle, suspend it,
 * and make the subsequent send fail before acceptance.
 *
 * Spawn/idle callbacks commonly run inside an admission, so the mutation gate
 * upgrades the current lease when possible. Otherwise acquisition is bounded:
 * a wedged admission skips this sweep instead of freezing every later turn for
 * the bot. The next idle/spawn callback retries.
 */
export function sweepIdleWorkersAfterTurnDrain(
  larkAppId: string,
  activeSessions: Map<string, DaemonSession>,
  opts: IdleWorkerSweepOptions = {},
): Promise<IdleWorkerSweepResult[]> {
  return tryWithBotTurnMutation(
    larkAppId,
    opts.mutationAcquireTimeoutMs ?? IDLE_WORKER_SWEEP_MUTATION_ACQUIRE_TIMEOUT_MS,
    () => sweepIdleWorkersAsync(activeSessions, opts),
  ).then(result => result.acquired ? result.value : []);
}

/**
 * Admission-rescue counterpart of {@link sweepIdleWorkersAfterTurnDrain}: same
 * bounded mutation gate (forkWorker usually runs inside an admission, whose
 * lease is upgraded), reclaiming idle workers is skipped instead of blocking
 * when the gate cannot be acquired in time.
 */
export function reclaimIdleWorkersForAdmissionAfterTurnDrain(
  larkAppId: string,
  activeSessions: Map<string, DaemonSession>,
  opts: ReclaimIdleWorkersOptions = {},
): Promise<IdleWorkerSweepResult[]> {
  return tryWithBotTurnMutation(
    larkAppId,
    opts.mutationAcquireTimeoutMs ?? IDLE_WORKER_SWEEP_MUTATION_ACQUIRE_TIMEOUT_MS,
    () => reclaimIdleWorkersForAdmissionAsync(activeSessions, opts),
  ).then(result => result.acquired ? result.value : []);
}
