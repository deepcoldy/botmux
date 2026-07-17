import { join } from 'node:path';

/** Daemon and manual CLI must derive the exact same scheduler lease for a
 * concrete run root. `baseDir/runId` is the runDir, so anchoring the sibling
 * lease in baseDir keeps it outside mutable run artifacts while remaining
 * unique to that on-disk run namespace. */
export function v3DriveLeaseTarget(baseDir: string, runId: string): string {
  return join(baseDir, `.v3-drive-${runId}`);
}

export const V3_DRIVE_LEASE_MAX_WAIT_MS = 15_000;
