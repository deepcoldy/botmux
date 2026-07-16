import { readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface CliPidMarkerRecord {
  sessionId: string;
  turnId: string | null;
  dispatchAttempt: number | null;
  procStart?: string;
  /** Worker generation that owns updates/cleanup for this marker. */
  workerPid: number;
}

interface MarkerIdentity {
  sessionId: string;
  procStart?: string;
  workerPid?: number;
}

export type CliPidMarkerWriteResult =
  | { written: true }
  | { written: false; ownerSessionId: string; ownerWorkerPid?: number };

function readMarkerIdentity(path: string): MarkerIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw) return null;
  if (!raw.startsWith('{')) return { sessionId: raw };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.procStart === 'string' && parsed.procStart
        ? { procStart: parsed.procStart }
        : {}),
      ...(typeof parsed.workerPid === 'number'
        && Number.isSafeInteger(parsed.workerPid)
        && parsed.workerPid > 0
        ? { workerPid: parsed.workerPid }
        : {}),
    };
  } catch {
    return null;
  }
}

function isDifferentLiveOwner(existing: MarkerIdentity, next: CliPidMarkerRecord): boolean {
  if (existing.sessionId === next.sessionId) return false;
  // A starttime mismatch proves this filename was left by an earlier process
  // that reused the same PID. Without both values, fail closed and preserve the
  // other session's claim.
  return !(existing.procStart && next.procStart && existing.procStart !== next.procStart);
}

function writeMarker(
  path: string,
  marker: CliPidMarkerRecord,
  reclaimSameSession: boolean,
): CliPidMarkerWriteResult {
  return withFileLockSync(path, () => {
    const existing = readMarkerIdentity(path);
    if (existing && isDifferentLiveOwner(existing, marker)) {
      return {
        written: false,
        ownerSessionId: existing.sessionId,
        ...(existing.workerPid ? { ownerWorkerPid: existing.workerPid } : {}),
      };
    }
    if (
      existing
      && existing.sessionId === marker.sessionId
      && existing.workerPid
      && existing.workerPid !== marker.workerPid
      && !reclaimSameSession
    ) {
      return {
        written: false,
        ownerSessionId: existing.sessionId,
        ownerWorkerPid: existing.workerPid,
      };
    }
    atomicWriteFileSync(path, JSON.stringify(marker));
    return { written: true };
  });
}

/** Claim a PID marker. A restarted worker may reclaim the same persisted session. */
export function claimCliPidMarkerFile(path: string, marker: CliPidMarkerRecord): CliPidMarkerWriteResult {
  return writeMarker(path, marker, true);
}

/** Rotate turn metadata without letting an older worker generation write back. */
export function updateCliPidMarkerFile(path: string, marker: CliPidMarkerRecord): CliPidMarkerWriteResult {
  return writeMarker(path, marker, false);
}

/** Remove only the marker still owned by this worker generation. */
export function releaseCliPidMarkerFile(
  path: string,
  owner: Pick<CliPidMarkerRecord, 'sessionId' | 'procStart' | 'workerPid'>,
): boolean {
  return withFileLockSync(path, () => {
    const existing = readMarkerIdentity(path);
    if (!existing || existing.sessionId !== owner.sessionId) return false;
    if (existing.workerPid && existing.workerPid !== owner.workerPid) return false;
    if (existing.procStart && owner.procStart && existing.procStart !== owner.procStart) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  });
}
