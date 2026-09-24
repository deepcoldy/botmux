import type { DaemonSession } from './types.js';
import { suspendWorker } from './worker-pool.js';
import { isSuspendableBackendType } from './persistent-backend.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';

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

function liveWorkers(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  return [...activeSessions.values()].filter(ds => !!ds.worker && !ds.worker.killed);
}

/**
 * Shared candidate guards for every reclaim policy (count cap, idle TTL,
 * admission rescue). A live worker is eligible only when:
 *  - it is NOT an adopted session (suspending it would silently turn an
 *    observe/bridge session into a normal botmux session on resume), and
 *  - its backend survives a kill + cold resume (tmux/herdr/zellij/zmx only;
 *    pty/riff/mojo are skipped), and
 *  - it is currently idle (never cut off an in-flight reply).
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
    .sort((a, b) => (a.lastMessageAt || 0) - (b.lastMessageAt || 0));
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
 * (`lastScreenStatus !== 'idle'`) is never suspended. If every over-cap session
 * is busy, none are count-suspended this round and the next sweep retries.
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
    () => sweepIdleWorkers(activeSessions, opts),
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
    () => reclaimIdleWorkersForAdmission(activeSessions, opts),
  ).then(result => result.acquired ? result.value : []);
}
