import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import type { WorkerConfig } from '../global-config.js';

export const MIN_AUTO_MAX_LIVE_WORKERS = 4;
export const MAX_AUTO_MAX_LIVE_WORKERS = 32;
export const DEFAULT_IDLE_SUSPEND_MS = 30 * 60_000;

export interface WorkerResources {
  cpuCount: number;
  memoryBytes: number;
}

export interface ResolvedWorkerBudget {
  maxLiveWorkers: number;
  idleSuspendMs: number;
  autoMaxLiveWorkers: number;
  maxLiveWorkersSource: 'auto' | 'config';
  idleSuspendMsSource: 'default' | 'config';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readMemoryLimitFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw || raw === 'max') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cgroupMemoryLimitBytes(hostMemoryBytes: number): number | undefined {
  const limits = [
    readMemoryLimitFile('/sys/fs/cgroup/memory.max'),
    readMemoryLimitFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
  ].filter((n): n is number => n !== undefined);
  if (limits.length === 0) return undefined;
  const limit = Math.min(...limits);
  return limit < hostMemoryBytes ? limit : undefined;
}

export function detectWorkerResources(): WorkerResources {
  const hostMemoryBytes = totalmem();
  return {
    cpuCount: Math.max(1, availableParallelism?.() ?? 1),
    memoryBytes: cgroupMemoryLimitBytes(hostMemoryBytes) ?? hostMemoryBytes,
  };
}

/**
 * Auto-derived per-daemon live-worker budget.
 *
 * `daemonCount` is the number of daemons sharing this machine (= bots in the
 * shared bots.json; multi-daemon deployments run one bot per process). The
 * machine-level budget min(cpu×2, memGiB) is split evenly across daemons —
 * without this, N daemons each claim the whole box and the effective
 * machine-wide cap silently becomes N × budget.
 */
export function autoMaxLiveWorkers(resources: WorkerResources = detectWorkerResources(), daemonCount = 1): number {
  const cpuBudget = Math.max(1, resources.cpuCount) * 2;
  const memoryBudget = Math.max(1, Math.round(resources.memoryBytes / 1024 ** 3));
  const machineBudget = Math.min(cpuBudget, memoryBudget);
  const perDaemon = Math.floor(machineBudget / Math.max(1, daemonCount));
  return clamp(perDaemon, MIN_AUTO_MAX_LIVE_WORKERS, MAX_AUTO_MAX_LIVE_WORKERS);
}

export function resolveWorkerBudget(
  workerConfig?: WorkerConfig,
  resources: WorkerResources = detectWorkerResources(),
  daemonCount = 1,
): ResolvedWorkerBudget {
  const auto = autoMaxLiveWorkers(resources, daemonCount);
  return {
    maxLiveWorkers: workerConfig?.maxLiveWorkers ?? auto,
    idleSuspendMs: workerConfig?.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS,
    autoMaxLiveWorkers: auto,
    maxLiveWorkersSource: workerConfig?.maxLiveWorkers === undefined ? 'auto' : 'config',
    idleSuspendMsSource: workerConfig?.idleSuspendMs === undefined ? 'default' : 'config',
  };
}
