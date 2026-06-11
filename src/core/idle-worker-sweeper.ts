import type { DaemonSession } from './types.js';
import { countConfiguredBots } from '../bot-registry.js';
import { readGlobalConfig } from '../global-config.js';
import { DEFAULT_IDLE_SUSPEND_MS, resolveWorkerBudget, type ResolvedWorkerBudget } from './worker-budget.js';
import { suspendWorker } from './worker-pool.js';
import { isSuspendableBackendType } from './persistent-backend.js';

export interface IdleWorkerSweepOptions {
  now?: number;
  workerBudget?: Pick<ResolvedWorkerBudget, 'maxLiveWorkers' | 'idleSuspendMs'>;
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
  const budget = opts.workerBudget ?? resolveWorkerBudget(readGlobalConfig().worker, undefined, countConfiguredBots());
  const maxLiveWorkers = budget.maxLiveWorkers;
  const idleMs = budget.idleSuspendMs;
  const running = liveWorkers(activeSessions);
  if (running.length <= maxLiveWorkers) return [];

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
  let liveCount = running.length;
  for (const ds of candidates) {
    if (liveCount <= maxLiveWorkers) break;
    if (!suspendWorker(ds, 'idle_worker_budget')) continue;
    suspended.push({ sessionId: ds.session.sessionId, reason: 'idle_worker_budget' });
    liveCount--;
  }
  return suspended;
}
