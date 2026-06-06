import type { DaemonSession } from './types.js';
import { readGlobalConfig } from '../global-config.js';
import { DEFAULT_IDLE_SUSPEND_MS, resolveWorkerBudget, type ResolvedWorkerBudget } from './worker-budget.js';
import { isSuspendableBackendType, suspendWorker } from './worker-pool.js';

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
  const budget = opts.workerBudget ?? resolveWorkerBudget(readGlobalConfig().worker);
  const maxLiveWorkers = budget.maxLiveWorkers;
  const idleMs = budget.idleSuspendMs;
  const running = liveWorkers(activeSessions);
  if (running.length <= maxLiveWorkers) return [];

  const candidates = running
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
