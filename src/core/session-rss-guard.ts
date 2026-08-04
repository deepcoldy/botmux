import { sampleProcfs } from './resource-monitor/procfs.js';
import type { ProcessResourceSample } from './resource-monitor/types.js';
import type { DaemonSession } from './types.js';
import { isSuspendableBackendType } from './persistent-backend.js';
import { suspendWorker } from './worker-pool.js';
import { readProcessStartIdentity } from './session-marker.js';
import { logger } from '../utils/logger.js';

export interface SessionRssGuardOptions {
  /** Positive MiB threshold. Missing or <= 0 disables the guard. */
  maxSessionRssMiB?: number;
  processes?: ProcessResourceSample[];
  suspend?: typeof suspendWorker;
  processStart?: (pid: number) => string | undefined;
}

export interface SessionRssGuardResult {
  sessionId: string;
  rssBytes: number;
  thresholdBytes: number;
  pids: number[];
}

function collectChildren(processes: ProcessResourceSample[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    const arr = children.get(proc.ppid) ?? [];
    arr.push(proc.pid);
    children.set(proc.ppid, arr);
  }
  return children;
}

function collectSubtree(rootPid: number | undefined, children: Map<number, number[]>): Set<number> {
  const out = new Set<number>();
  if (!rootPid || rootPid <= 0) return out;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

function liveAttestedCliPid(ds: DaemonSession, processStart: (pid: number) => string | undefined): number | undefined {
  const attestation = ds.localProcessAttestation;
  if (!attestation?.cliPid) return undefined;
  if (attestation.workerGeneration !== undefined && ds.workerGeneration !== undefined && attestation.workerGeneration !== ds.workerGeneration) {
    return undefined;
  }
  if (attestation.cliProcStart && processStart(attestation.cliPid) !== attestation.cliProcStart) {
    return undefined;
  }
  return attestation.cliPid;
}

function sessionProcessPids(
  ds: DaemonSession,
  children: Map<number, number[]>,
  processStart: (pid: number) => string | undefined,
): Set<number> {
  const pids = new Set<number>();
  for (const pid of collectSubtree(ds.worker?.pid, children)) pids.add(pid);
  const cliPid = liveAttestedCliPid(ds, processStart);
  for (const pid of collectSubtree(cliPid, children)) pids.add(pid);
  return pids;
}

function sumRss(pids: Set<number>, byPid: Map<number, ProcessResourceSample>): number {
  let total = 0;
  for (const pid of pids) total += byPid.get(pid)?.rssBytes ?? 0;
  return total;
}

function eligibleForAutoSuspend(ds: DaemonSession): boolean {
  if (!ds.worker || ds.worker.killed) return false;
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) return false;
  if (!isSuspendableBackendType(ds.initConfig?.backendType)) return false;
  return ds.lastScreenStatus === 'idle';
}

/**
 * Suspend idle, resumable sessions whose worker+CLI footprint exceeds the
 * per-bot RSS threshold. This is a last-ditch guard for one runaway CLI; the
 * count-based maxLiveWorkers sweeper still handles ordinary resident-session
 * pressure.
 */
export function sweepOversizedSessions(
  activeSessions: Map<string, DaemonSession>,
  opts: SessionRssGuardOptions = {},
): SessionRssGuardResult[] {
  const thresholdMiB = opts.maxSessionRssMiB;
  if (!Number.isInteger(thresholdMiB) || !thresholdMiB || thresholdMiB <= 0) return [];
  const thresholdBytes = thresholdMiB * 1024 * 1024;
  const processes = opts.processes ?? sampleProcfs().processes;
  if (processes.length === 0) return [];

  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const children = collectChildren(processes);
  const processStart = opts.processStart ?? readProcessStartIdentity;
  const suspend = opts.suspend ?? suspendWorker;
  const suspended: SessionRssGuardResult[] = [];

  for (const ds of activeSessions.values()) {
    if (!eligibleForAutoSuspend(ds)) continue;
    const pids = sessionProcessPids(ds, children, processStart);
    if (pids.size === 0) continue;
    const rssBytes = sumRss(pids, byPid);
    if (rssBytes < thresholdBytes) continue;
    try {
      if (suspend(ds, 'session_rss_guard')) {
        suspended.push({
          sessionId: ds.session.sessionId,
          rssBytes,
          thresholdBytes,
          pids: [...pids].sort((a, b) => a - b),
        });
      }
    } catch (err) {
      logger.warn(`[session-rss-guard] suspend failed for ${ds.session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return suspended;
}
