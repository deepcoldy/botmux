import type { Session } from '../types.js';
import { pidNotProvablyGone } from '../utils/process-alive.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';
import { readProcessSystemdUnit } from '../utils/systemd-unit.js';
import { builtinFleetEntryMatches, readFleetProcessCommandLine } from './fleet-process-identity.js';
import { sessionScopeUnitName } from './session-scope.js';

/**
 * Bind a persisted `Session.pid` to the exact worker process it was recorded
 * for, so a later daemon never signals whatever process inherited the number.
 *
 * The daemon persists a worker's pid at fork and does NOT clear it when a
 * graceful fleet restart detaches persistent-backend workers (shutdown nulls
 * `ds.worker` before the exit callback runs). A session that is then kept for
 * lazy cold-resume keeps that pid for as long as it stays dormant — days or
 * weeks. Once the kernel wraps pid_max the number belongs to an unrelated
 * process, and the startup stale-pid sweep used to SIGTERM its process group:
 * a restart took down two running sessions whose CLI children had inherited
 * the pids of an 18-day-old and a 2-month-old record.
 *
 * Signalling therefore needs all of:
 *   1. a birth identity recorded at fork (`Session.pidProcStart`, the durable
 *      boot-id + /proc starttime form). Rows written before this existed carry
 *      none and are never signalled;
 *   2. the live process's identity equal to the recorded one;
 *   3. positive proof botmux launched it: a worker entry on its command line
 *      (`worker.js` / `__worker`, install-path independent like the fleet
 *      roles), or membership in this session's own systemd scope.
 * Any mismatch is logged and left alone.
 */

export interface SessionWorkerProcessRuntime {
  readIdentity(pid: number): string | undefined;
  readCommandLine(pid: number): string | undefined;
  readSystemdUnit(pid: number): string | undefined;
  /** Only ESRCH proves a pid gone; EPERM / unexpected errors stay "exists". */
  pidExists(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export type RecordedSessionWorkerInspection =
  /** Same process the row recorded, and botmux demonstrably launched it. */
  | { status: 'exact'; pid: number; processStart: string }
  /** No process has this pid any more. */
  | { status: 'gone' }
  /** The pid is alive but was born after the recorded worker: it was reused. */
  | { status: 'reused' }
  /** Legacy row without a recorded birth identity: unverifiable, never signalled. */
  | { status: 'unrecorded' }
  /** Identity matches but neither command line nor cgroup shows a botmux worker. */
  | { status: 'unproven' }
  /** The pid exists but its identity could not be read. */
  | { status: 'unverifiable' };

export const sessionWorkerProcessRuntime: SessionWorkerProcessRuntime = {
  readIdentity: readDurableProcessIdentity,
  readCommandLine: readFleetProcessCommandLine,
  readSystemdUnit: pid => readProcessSystemdUnit(pid),
  pidExists: pidNotProvablyGone,
  kill: (pid, signal) => { process.kill(pid, signal); },
};

/** Birth identity to persist next to a freshly forked worker's pid. */
export function readWorkerProcessStart(
  pid: number | undefined,
  runtime: SessionWorkerProcessRuntime = sessionWorkerProcessRuntime,
): string | undefined {
  return pid === undefined ? undefined : runtime.readIdentity(pid);
}

export function inspectRecordedSessionWorker(
  session: Pick<Session, 'sessionId' | 'pid' | 'pidProcStart'>,
  runtime: SessionWorkerProcessRuntime = sessionWorkerProcessRuntime,
): RecordedSessionWorkerInspection {
  const pid = session.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return { status: 'gone' };
  const first = runtime.readIdentity(pid);
  if (!first) return runtime.pidExists(pid) ? { status: 'unverifiable' } : { status: 'gone' };
  if (!session.pidProcStart) return { status: 'unrecorded' };
  if (first !== session.pidProcStart) return { status: 'reused' };
  const commandLine = runtime.readCommandLine(pid);
  const unit = runtime.readSystemdUnit(pid);
  const launchedByBotmux = (commandLine !== undefined && builtinFleetEntryMatches('worker', commandLine))
    || (unit !== undefined && unit === sessionScopeUnitName(session.sessionId));
  if (!launchedByBotmux) {
    return commandLine === undefined && unit === undefined ? { status: 'unverifiable' } : { status: 'unproven' };
  }
  // Sample the birth identity again: a pid recycled while the command line
  // and cgroup were being read must not inherit the verdict.
  const second = runtime.readIdentity(pid);
  if (second !== first) {
    if (second) return { status: 'reused' };
    return runtime.pidExists(pid) ? { status: 'unverifiable' } : { status: 'gone' };
  }
  return { status: 'exact', pid, processStart: first };
}

/** Is the exact process `target` attested still running (not exited, not replaced)? */
export function recordedSessionWorkerAlive(
  target: { pid: number; processStart: string },
  runtime: SessionWorkerProcessRuntime = sessionWorkerProcessRuntime,
): boolean {
  return runtime.readIdentity(target.pid) === target.processStart;
}

/**
 * Signal an `exact` worker, re-checking its birth identity immediately before
 * addressing the pid (and again before the single-pid fallback). Node/Bun do
 * not expose pidfd, so this narrows the reuse window rather than closing it.
 */
export function signalRecordedSessionWorker(
  target: { pid: number; processStart: string },
  signal: NodeJS.Signals,
  opts: { processGroup: boolean },
  runtime: SessionWorkerProcessRuntime = sessionWorkerProcessRuntime,
): boolean {
  if (runtime.readIdentity(target.pid) !== target.processStart) return false;
  if (opts.processGroup) {
    try {
      runtime.kill(-target.pid, signal);
      return true;
    } catch {
      // Not a group leader (or already gone): fall back to the pid itself.
    }
    if (runtime.readIdentity(target.pid) !== target.processStart) return false;
  }
  try {
    runtime.kill(target.pid, signal);
    return true;
  } catch {
    return false;
  }
}
