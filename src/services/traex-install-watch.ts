import type { DaemonSession } from '../core/types.js';
import {
  compareLaunchedInstall,
  resolveInstallIdentity,
  sameExecutableObject,
  type ExecutableIdentity,
} from './cli-install-identity.js';

/**
 * Per-install-entry observation shared by every worker of this daemon.
 *
 * The install entry comes from the worker's own attestation (`resolvedBin` at
 * spawn), so detection never runs a version probe and never depends on the
 * daemon's PATH or shell environment. The stat result is cached for a short
 * TTL: a periodic sweep of N idle workers must not hit the filesystem N times
 * per tick, and a running upgrade becomes visible within one TTL anyway.
 */
const INSTALL_IDENTITY_TTL_MS = 15_000;

interface CachedInstallIdentity {
  identity: ExecutableIdentity | undefined;
  checkedAt: number;
}

const installIdentityCache = new Map<string, CachedInstallIdentity>();

export type TraexInstallUnknownReason =
  | 'no-attestation'
  | 'running-identity-unknown'
  | 'install-entry-unknown'
  /** The worker did not record what the entry resolved to at spawn. */
  | 'install-at-spawn-unknown'
  /** At spawn the entry did not resolve to the object the process runs (a
   *  wrapper-script / launcher layout). This mitigation does not cover it. */
  | 'launch-unproven'
  | 'install-entry-missing'
  /** The two stats are not provably the same physical object (different
   *  device / unproven bind or overlay mapping). Never auto-reclaim. */
  | 'identity-unprovable';

export type TraexInstallObservation =
  | { state: 'not-traex' }
  | { state: 'unknown'; reason: TraexInstallUnknownReason; entry?: string }
  | {
      state: 'current' | 'stale';
      entry: string;
      running: ExecutableIdentity;
      installAtSpawn: ExecutableIdentity;
      install: ExecutableIdentity;
    };

function cachedInstallIdentity(entry: string, now: number): ExecutableIdentity | undefined {
  const cached = installIdentityCache.get(entry);
  if (cached && now - cached.checkedAt < INSTALL_IDENTITY_TTL_MS) return cached.identity;
  const identity = resolveInstallIdentity(entry);
  installIdentityCache.set(entry, { identity, checkedAt: now });
  return identity;
}

/**
 * Compare the process's actual running executable with the install entry it
 * was launched from.
 *
 * Only `stale` may drive an automatic reclaim. Every unavailable input is
 * `unknown`: macOS (no proven running-identity source), a worker that has not
 * attested yet, an adopted/launcher process, an install entry that no longer
 * resolves, or an entry that did not name the running image at spawn.
 */
export function observeTraexInstall(
  ds: DaemonSession,
  cliId: string,
  now = Date.now(),
): TraexInstallObservation {
  if (cliId !== 'traex') return { state: 'not-traex' };
  const attestation = ds.localProcessAttestation;
  if (!attestation) return { state: 'unknown', reason: 'no-attestation' };
  const running = attestation.cliExe;
  if (!running) return { state: 'unknown', reason: 'running-identity-unknown' };
  const entry = attestation.cliInstallEntry;
  if (!entry) return { state: 'unknown', reason: 'install-entry-unknown' };
  const installAtSpawn = attestation.cliInstallAtSpawn;
  if (!installAtSpawn) return { state: 'unknown', reason: 'install-at-spawn-unknown', entry };
  if (!sameExecutableObject(running, installAtSpawn)) return { state: 'unknown', reason: 'launch-unproven', entry };
  const install = cachedInstallIdentity(entry, now);
  if (!install) return { state: 'unknown', reason: 'install-entry-missing', entry };
  const comparison = compareLaunchedInstall(running, installAtSpawn, install);
  if (comparison === 'unknown') return { state: 'unknown', reason: 'identity-unprovable', entry };
  return { state: comparison, entry, running, installAtSpawn, install };
}

/** Unit-test seam: the cache is daemon-wide by design, so tests that change a
 *  fixture install entry need a deterministic reset. */
export function __testOnly_resetTraexInstallWatch(): void {
  installIdentityCache.clear();
}
