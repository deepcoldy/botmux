import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { readDurableProcessIdentity, isLinuxZombie } from '../utils/process-identity.js';
import { isProcessAlive } from './session-liveness.js';
import { parseProcessStat } from './resource-monitor/procfs.js';
import { isSuspendableBackendType, probePersistentBackendTarget, resolvePersistentBackendTarget } from './persistent-backend.js';

export interface RecycleProcess {
  pid: number;
  identity?: string;
  source: 'worker' | 'cli' | 'descendant';
  state: 'alive' | 'gone' | 'unknown' | 'reused';
  rssBytes?: number;
  fileDescriptors?: number;
  inotifyInstances?: number;
  inotifyWatches?: number;
}

export interface RecycleResources {
  registered: boolean;
  workerPort?: number;
  processes: RecycleProcess[];
  backing: { type?: Session['backendType']; state: 'missing' | 'exists' | 'unknown' | 'not_applicable' | 'remote' };
  errors: string[];
}

export function sampleRecycleProcess(pid: number, source: RecycleProcess['source'], expectedIdentity?: string): RecycleProcess {
  const identity = readDurableProcessIdentity(pid);
  const state = !isProcessAlive(pid) || isLinuxZombie(pid) ? 'gone'
    : !identity ? 'unknown' : expectedIdentity && expectedIdentity !== identity ? 'reused' : 'alive';
  const result: RecycleProcess = { pid, identity: expectedIdentity ?? identity, source, state };
  if (state !== 'alive' || process.platform !== 'linux') return result;
  try {
    const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m);
    result.rssBytes = rss ? Number(rss[1]) * 1024 : undefined;
    const fds = readdirSync(`/proc/${pid}/fd`);
    result.fileDescriptors = fds.length;
    let instances = 0;
    let watches = 0;
    for (const fd of fds) {
      try {
        if (!readlinkSync(`/proc/${pid}/fd/${fd}`).includes('inotify')) continue;
        instances++;
        watches += readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').split('\n').filter(line => line.startsWith('inotify ')).length;
      } catch { /* descriptors can close during a sample */ }
    }
    result.inotifyInstances = instances;
    result.inotifyWatches = watches;
  } catch { /* metrics unavailable does not prove process absence */ }
  return result;
}

/** Read-only attribution. Nothing here sends a signal other than kill(0),
 * probes a shared process for termination, or deletes an artifact. */
export function captureRecycleResources(session: Session, ds?: DaemonSession): RecycleResources {
  const processes: RecycleProcess[] = [];
  const errors: string[] = [];
  const workerPid = ds?.worker?.pid ?? session.pid;
  if (workerPid) processes.push(sampleRecycleProcess(workerPid, 'worker'));
  const attestation = ds?.localProcessAttestation;
  if (attestation?.cliPid && !processes.some(p => p.pid === attestation.cliPid)) {
    const cli = sampleRecycleProcess(attestation.cliPid, 'cli');
    // Attestation is bound to this worker generation. Refuse a reused CLI PID.
    if (attestation.cliProcStart && cli.identity?.endsWith(`:${attestation.cliProcStart}`) === false
        && cli.identity !== attestation.cliProcStart) errors.push('cli_process_identity_changed');
    else processes.push(cli);
  }
  if (process.platform === 'linux') {
    try {
      const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try { const row = parseProcessStat(readFileSync(`/proc/${name}/stat`, 'utf8')); return row ? [row] : []; }
        catch { return []; }
      });
      const owned = new Set(processes.filter(p => p.state === 'alive').map(p => p.pid));
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (!owned.has(row.pid) && owned.has(row.ppid)) {
            owned.add(row.pid);
            processes.push(sampleRecycleProcess(row.pid, 'descendant'));
            changed = true;
          }
        }
      }
    } catch { errors.push('process_descendants_unavailable'); }
  } else if (processes.some(p => p.state === 'alive')) {
    errors.push('process_descendants_unavailable_on_platform');
  }
  const type = ds?.initConfig?.backendType ?? session.backendType;
  let state: RecycleResources['backing']['state'] = 'not_applicable';
  if (isSuspendableBackendType(type)) {
    try { state = probePersistentBackendTarget(resolvePersistentBackendTarget(type, session.sessionId, session.persistentBackendTarget)); }
    catch { state = 'unknown'; }
  } else if (type === 'mojo' || type === 'riff') state = 'remote';
  else if (!type) state = 'unknown';
  return { registered: !!ds, workerPort: ds?.workerPort ?? undefined, processes, backing: { type, state }, errors };
}

export function rereadRecycleResources(before: RecycleResources, session: Session, ds?: DaemonSession): RecycleResources {
  // A stored PID can already belong to an unrelated process after close.
  // Only a live runtime may introduce new owned processes at readback.
  const after = captureRecycleResources({ ...session, pid: undefined }, ds);
  const observed = before.processes.map(p => sampleRecycleProcess(p.pid, p.source, p.identity));
  for (const p of after.processes) if (!observed.some(old => old.pid === p.pid)) observed.push(p);
  return { ...after, processes: observed, errors: [...new Set([...before.errors, ...after.errors])] };
}

export function resourceResiduals(resources: RecycleResources): string[] {
  return [
    ...(resources.registered ? ['active_registration_remains'] : []),
    ...resources.processes.filter(p => p.state === 'alive' || p.state === 'unknown').map(p => `${p.source}_${p.state}:${p.pid}`),
    ...(['exists', 'unknown'].includes(resources.backing.state) ? [`backing_${resources.backing.state}`] : []),
    ...resources.errors,
  ];
}
