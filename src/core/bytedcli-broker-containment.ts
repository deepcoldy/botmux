import { readProcessStartIdentity } from './session-marker.js';
import { observeBytedcliLinuxContainment } from './bytedcli-linux-containment.js';
import { readlinkSync } from 'node:fs';
import type { DaemonSession } from './types.js';
/** Private worker IPC only. Configuration/intended flags never constitute proof.
 * Task4 must report actual post-launch namespace and filesystem enforcement. */
export interface BytedcliWorkerContainment {
  readonly workerGeneration: number;
  readonly credentialRoots: readonly string[];
  readonly executableReadOnlyRoots: readonly string[];
}
export interface BytedcliContainmentReport {
  readonly protocol: 'botmux.bytedcli-containment.v1';
  readonly sessionId: string; readonly workerGeneration: number; readonly workerPid: number;
  readonly cliPid: number; readonly pidNamespace: string; readonly hostPidNamespace: string;
  readonly workerProcStart?: string;
  readonly cliProcStart?: string; readonly cliSpawnGeneration?: number;
  readonly filesystem: 'allowlist'; readonly protectedRoots: readonly string[];
  readonly protectedRootsEnforced: true; readonly freshCredentialFreeLaunch: true;
}
const reports = new WeakMap<DaemonSession, BytedcliContainmentReport>();
const strictSessions = new WeakSet<DaemonSession>();
export function markBytedcliStrictSession(ds: DaemonSession): void { strictSessions.add(ds); ds.session.bytecloudBrokerStrict = true; }
export function bytedcliSessionWasStrict(ds: DaemonSession): boolean { return strictSessions.has(ds) || ds.session.bytecloudBrokerStrict === true; }
/** Called exclusively by Task4's authenticated current-generation worker handler. */
export function rememberBytedcliContainment(ds: DaemonSession, report: BytedcliContainmentReport): boolean {
  if (report.protocol !== 'botmux.bytedcli-containment.v1' || report.sessionId !== ds.session.sessionId
    || report.workerGeneration !== ds.workerGeneration || report.workerPid !== ds.worker?.pid
    || report.cliPid !== ds.localProcessAttestation?.cliPid || !report.protectedRoots.length
    || !report.protectedRoots.every(path => path.startsWith('/') && !path.startsWith('/$bunfs/'))
    || report.filesystem !== 'allowlist' || report.protectedRootsEnforced !== true
    || report.freshCredentialFreeLaunch !== true) return false;
  const contract = ds.initConfig?.bytedcliContainment;
  if (!contract || !report.cliProcStart || !report.cliSpawnGeneration || !report.workerProcStart
    || readProcessStartIdentity(report.workerPid) !== report.workerProcStart
    || report.cliProcStart !== ds.localProcessAttestation?.cliProcStart
    || report.cliSpawnGeneration !== ds.localProcessAttestation?.cliSpawnGeneration
    || report.workerGeneration !== ds.session.workerGeneration
    || contract.workerGeneration !== report.workerGeneration) return false;
  const observed = observeBytedcliLinuxContainment(report.cliPid, contract);
  if (!observed || observed.cliProcStart !== report.cliProcStart || observed.pidNamespace !== report.pidNamespace
    || observed.hostPidNamespace !== report.hostPidNamespace
    || ![...contract.credentialRoots, ...contract.executableReadOnlyRoots].every(root => report.protectedRoots.includes(root))) return false;
  reports.set(ds, Object.freeze({ ...report, protectedRoots: Object.freeze([...report.protectedRoots]) }));
  markBytedcliStrictSession(ds); return true;
}
export function bytedcliContainmentAvailable(ds: DaemonSession, requiredRoots: readonly string[]): boolean {
  const report = reports.get(ds);
  if (process.platform !== 'linux' || !report || ds.worker?.killed || ds.session.status !== 'active'
    || readProcessStartIdentity(report.workerPid) !== report.workerProcStart
    || !ds.session.backendType || !['pty', 'tmux'].includes(ds.session.backendType) || ds.session.adoptedFrom
    || report.workerGeneration !== ds.workerGeneration || report.workerPid !== ds.worker?.pid
    || report.cliPid !== ds.localProcessAttestation?.cliPid
    || report.cliProcStart !== ds.localProcessAttestation?.cliProcStart
    || report.cliSpawnGeneration !== ds.localProcessAttestation?.cliSpawnGeneration
    || readProcessStartIdentity(report.cliPid) !== report.cliProcStart
    || requiredRoots.length === 0 || !requiredRoots.every(root => report.protectedRoots.includes(root))) return false;
  try {
    const host = readlinkSync('/proc/self/ns/pid');
    const cli = readlinkSync(`/proc/${report.cliPid}/ns/pid`);
    return host === report.hostPidNamespace && cli === report.pidNamespace && cli !== host;
  } catch { return false; }
}

/** This seam is called only by the actual ChildProcess private IPC listener.
 * Neither a public HTTP report nor an obsolete worker object is accepted. */
export function acceptBytedcliWorkerContainment(ds: DaemonSession, worker: DaemonSession['worker'],
  generation: number, report: BytedcliContainmentReport): boolean {
  return !!worker && !worker.killed && ds.worker === worker && ds.workerGeneration === generation
    && ds.session.workerGeneration === generation && rememberBytedcliContainment(ds, report);
}
