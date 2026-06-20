import type { DaemonSession } from './types.js';
import { suspendWorker } from './worker-pool.js';
import { isSuspendableBackendType } from './persistent-backend.js';

/**
 * Default per-bot live-session cap applied when a bot has no explicit
 * `maxLiveWorkers` configured. Keeps memory bounded out of the box: beyond this
 * many live sessions, the least-recently-used ones are suspended (CLI freed,
 * cold-resumes from transcript on the next message). A bot can override it from
 * the dashboard. NOTE: the dashboard help copy hardcodes this number
 * ('botDefaults.maxLiveWorkers*' i18n) — keep them in sync.
 */
export const DEFAULT_MAX_LIVE_WORKERS = 30;

export interface IdleWorkerSweepOptions {
  /**
   * Explicit per-bot cap for THIS bot (one daemon = one bot, so the whole
   * `activeSessions` map belongs to a single bot). `undefined` (bot unset) →
   * fall back to {@link DEFAULT_MAX_LIVE_WORKERS}. `≤0` → no cap (escape hatch:
   * never suspend).
   */
  maxLiveWorkers?: number;
}

export interface IdleWorkerSweepResult {
  sessionId: string;
  reason: string;
}

function liveWorkers(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  return [...activeSessions.values()].filter(ds => !!ds.worker && !ds.worker.killed);
}

/**
 * Count-based live-worker cap. When this bot has more live workers than its
 * configured `maxLiveWorkers`, suspend its longest-idle (by lastMessageAt),
 * not-currently-busy, resumable-backend sessions down to the cap. The CLI keeps
 * running detached; the next message / terminal open re-forks the worker
 * (daemon.ts worker-null resume path).
 *
 * Deliberately has NO idle-time threshold: 申晗's policy is "while resources
 * allow, never time out an old session" — suspension only kicks in to enforce
 * an explicit per-bot count cap. The only guard kept is correctness, not a
 * timeout: a session that is mid-turn (`lastScreenStatus !== 'idle'`) is never
 * suspended so an in-flight reply is never interrupted. If every over-cap
 * session is busy, none are suspended this round and the next sweep retries.
 */
export function sweepIdleWorkers(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleWorkerSweepOptions = {},
): IdleWorkerSweepResult[] {
  const cap = opts.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS;
  if (cap <= 0) return [];  // explicit ≤0 = unlimited escape hatch
  const running = liveWorkers(activeSessions);
  if (running.length <= cap) return [];

  const candidates = running
    // Never suspend an adopted session. forkAdoptWorker stamps its
    // initConfig.backendType as tmux/herdr/zellij (so it would otherwise pass
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

  const suspended: IdleWorkerSweepResult[] = [];
  let liveCount = running.length;
  for (const ds of candidates) {
    if (liveCount <= cap) break;
    if (!suspendWorker(ds, 'live_worker_cap')) continue;
    suspended.push({ sessionId: ds.session.sessionId, reason: 'live_worker_cap' });
    liveCount--;
  }
  return suspended;
}
