import { readlinkSync } from 'node:fs';
import type { DaemonSession } from './types.js';
/** Private worker IPC only. Configuration/intended flags never constitute proof.
 * Task4 must report actual post-launch namespace and filesystem enforcement. */
export interface BytedcliContainmentReport {
  readonly protocol: 'botmux.bytedcli-containment.v1';
  readonly sessionId: string; readonly workerGeneration: number; readonly workerPid: number;
  readonly cliPid: number; readonly pidNamespace: string; readonly hostPidNamespace: string;
  readonly filesystem: 'allowlist'; readonly protectedRoots: readonly string[];
  readonly protectedRootsEnforced: true; readonly freshCredentialFreeLaunch: true;
}
const reports = new WeakMap<DaemonSession, BytedcliContainmentReport>();
const strictSessions = new WeakSet<DaemonSession>();
export function markBytedcliStrictSession(ds: DaemonSession): void { strictSessions.add(ds); ds.session.bytecloudBrokerStrict = true; }
export function bytedcliSessionWasStrict(ds: DaemonSession): boolean { return strictSessions.has(ds); }
/** Called exclusively by Task4's authenticated current-generation worker handler. */
export function rememberBytedcliContainment(ds: DaemonSession, report: BytedcliContainmentReport): boolean {
  if (report.protocol !== 'botmux.bytedcli-containment.v1' || report.sessionId !== ds.session.sessionId
    || report.workerGeneration !== ds.workerGeneration || report.workerPid !== ds.worker?.pid
    || report.cliPid !== ds.localProcessAttestation?.cliPid || !report.protectedRoots.length
    || !report.protectedRoots.every(path => path.startsWith('/') && !path.startsWith('/$bunfs/'))
    || report.filesystem !== 'allowlist' || report.protectedRootsEnforced !== true
    || report.freshCredentialFreeLaunch !== true) return false;
  reports.set(ds, Object.freeze({ ...report, protectedRoots: Object.freeze([...report.protectedRoots]) }));
  markBytedcliStrictSession(ds); return true;
}
export function bytedcliContainmentAvailable(ds: DaemonSession, requiredRoots: readonly string[]): boolean {
  const report = reports.get(ds);
  if (process.platform !== 'linux' || !report || ds.session.status !== 'active'
    || !ds.session.backendType || !['pty', 'tmux'].includes(ds.session.backendType) || ds.session.adoptedFrom
    || report.workerGeneration !== ds.workerGeneration || report.workerPid !== ds.worker?.pid
    || report.cliPid !== ds.localProcessAttestation?.cliPid
    || requiredRoots.length === 0 || !requiredRoots.every(root => report.protectedRoots.includes(root))) return false;
  try {
    const host = readlinkSync('/proc/self/ns/pid');
    const cli = readlinkSync(`/proc/${report.cliPid}/ns/pid`);
    return host === report.hostPidNamespace && cli === report.pidNamespace && cli !== host;
  } catch { return false; }
}
