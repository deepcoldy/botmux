import type { DaemonSession } from './types.js';
import { countConfiguredBots } from '../bot-registry.js';
import { readGlobalConfig, type IdleSuspendMode, type WorkerConfig } from '../global-config.js';
import { DEFAULT_IDLE_SUSPEND_MS, resolveWorkerBudget, type ResolvedWorkerBudget } from './worker-budget.js';
import { suspendWorker } from './worker-pool.js';
import { isSuspendableBackendType } from './persistent-backend.js';

export interface IdleWorkerSweepOptions {
  now?: number;
  workerBudget?: Pick<ResolvedWorkerBudget, 'maxLiveWorkers' | 'idleSuspendMs'> & { idleSuspendMode?: IdleSuspendMode };
  /**
   * This daemon's per-bot WorkerConfig (bots.json `worker` field), merged
   * field-by-field over the global config — multi-daemon deployments run one
   * bot per daemon, so the override scopes naturally to this process.
   */
  botWorkerOverride?: WorkerConfig;
}

export interface IdleWorkerSweepResult {
  sessionId: string;
  reason: string;
}

export const DEFAULT_IDLE_WORKER_MS = DEFAULT_IDLE_SUSPEND_MS;

function liveWorkers(activeSessions: Map<string, DaemonSession>): DaemonSession[] {
  return [...activeSessions.values()].filter(ds => !!ds.worker && !ds.worker.killed);
}

export function sweepIdleWorkers(
  activeSessions: Map<string, DaemonSession>,
  opts: IdleWorkerSweepOptions = {},
): IdleWorkerSweepResult[] {
  const now = opts.now ?? Date.now();
  const globalWorker = readGlobalConfig().worker;
  const workerConfig = (globalWorker || opts.botWorkerOverride)
    ? { ...globalWorker, ...opts.botWorkerOverride }
    : undefined;
  const budget = opts.workerBudget ?? resolveWorkerBudget(workerConfig, undefined, countConfiguredBots());
  const mode: IdleSuspendMode = budget.idleSuspendMode ?? 'budget';
  const maxLiveWorkers = budget.maxLiveWorkers;
  const idleMs = budget.idleSuspendMs;
  const running = liveWorkers(activeSessions);
  // 'always' suspends every eligible idle worker; 'budget' (default) only
  // trims the overflow above maxLiveWorkers, oldest-idle first.
  if (mode !== 'always' && running.length <= maxLiveWorkers) return [];

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
    .filter(ds => ds.lastScreenStatus === 'idle')
    .filter(ds => now - (ds.lastMessageAt || 0) >= idleMs)
    .sort((a, b) => (a.lastMessageAt || 0) - (b.lastMessageAt || 0));

  const suspended: IdleWorkerSweepResult[] = [];
  const reason = mode === 'always' ? 'idle_suspend_always' : 'idle_worker_budget';
  let liveCount = running.length;
  for (const ds of candidates) {
    if (mode !== 'always' && liveCount <= maxLiveWorkers) break;
    if (!suspendWorker(ds, reason)) continue;
    suspended.push({ sessionId: ds.session.sessionId, reason });
    liveCount--;
  }
  return suspended;
}
