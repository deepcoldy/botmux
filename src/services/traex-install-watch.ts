import type { DaemonSession } from '../core/types.js';
import {
  compareRunningToInstall,
  resolveInstallIdentity,
  sameExecutableObject,
  type ExecutableIdentity,
} from './cli-install-identity.js';
import {
  readTraexSnapshotProvenance,
  traexReleaseSignature,
} from './traex-runtime-snapshot.js';

/**
 * Per-install-entry observation shared by every worker of this daemon.
 *
 * The configured install entry comes from the worker's own attestation, so
 * detection never runs a version probe and never depends on the daemon's PATH
 * or shell environment. The stat result is cached for a short TTL: a periodic
 * sweep of N idle workers must not hit the filesystem N times per tick, and a
 * running upgrade becomes visible within one TTL anyway.
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
  /** The process is not proven to run the object this generation exec'd (a
   *  wrapper-script / launcher layout, or an attestation from before the
   *  launch-target identity was recorded). */
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
 *
 * A managed launch now execs a frozen snapshot, so `cliExe` (the snapshot) and
 * the configured entry are different objects even when nothing changed. The
 * launch is proven by `cliLaunchTargetIdentity`, and the upgrade comparison is
 * made between the configured entry's resolution at spawn and its current
 * resolution. Attestations produced before that split (the entry itself is a
 * snapshot path) are resolved through the snapshot's manifest provenance.
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

  // Preferred path: the worker recorded both the configured entry's spawn
  // identity and the exact object it exec'd.
  const installAtSpawn = attestation.cliInstallAtSpawn;
  const launchTargetIdentity = attestation.cliLaunchTargetIdentity;
  if (installAtSpawn && launchTargetIdentity) {
    if (!sameExecutableObject(running, launchTargetIdentity)) {
      return { state: 'unknown', reason: 'launch-unproven', entry };
    }
    const install = cachedInstallIdentity(entry, now);
    if (!install) return { state: 'unknown', reason: 'install-entry-missing', entry };
    const comparison = compareRunningToInstall(installAtSpawn, install);
    if (comparison === 'unknown') return { state: 'unknown', reason: 'identity-unprovable', entry };
    return { state: comparison, entry, running, installAtSpawn, install };
  }

  // Legacy attestation: the entry may already point at the snapshot the
  // process runs. Read the manifest to recover the configured source install.
  const provenance = readTraexSnapshotProvenance(entry);
  if (provenance) {
    const snapshotInstall = cachedInstallIdentity(entry, now);
    if (!snapshotInstall) return { state: 'unknown', reason: 'install-entry-missing', entry };
    if (!sameExecutableObject(running, snapshotInstall)) {
      return { state: 'unknown', reason: 'launch-unproven', entry };
    }
    if (!provenance.sourceSignature) {
      return { state: 'unknown', reason: 'identity-unprovable', entry };
    }
    const currentSignature = traexReleaseSignature(provenance.sourceReleaseDir);
    if (!currentSignature) return { state: 'unknown', reason: 'install-entry-missing', entry };
    if (currentSignature === provenance.sourceSignature) {
      return { state: 'current', entry, running, installAtSpawn: snapshotInstall, install: snapshotInstall };
    }
    // The source changed. We can prove staleness without an identity object
    // for the new content, but the return shape requires one; resolve the
    // current source install for diagnostics when it is readable.
    const install = resolveInstallIdentity(provenance.sourceReleaseDir)
      ?? cachedInstallIdentity(entry, now);
    if (!install) return { state: 'unknown', reason: 'install-entry-missing', entry };
    return { state: 'stale', entry, running, installAtSpawn: snapshotInstall, install };
  }

  // Direct (non-snapshot) launch: the process must run the very object the
  // configured entry named at spawn, and the entry must still name it.
  if (!installAtSpawn) return { state: 'unknown', reason: 'install-at-spawn-unknown', entry };
  if (!sameExecutableObject(running, installAtSpawn)) return { state: 'unknown', reason: 'launch-unproven', entry };
  const install = cachedInstallIdentity(entry, now);
  if (!install) return { state: 'unknown', reason: 'install-entry-missing', entry };
  const comparison = compareRunningToInstall(installAtSpawn, install);
  if (comparison === 'unknown') return { state: 'unknown', reason: 'identity-unprovable', entry };
  return { state: comparison, entry, running, installAtSpawn, install };
}

/** Unit-test seam: the cache is daemon-wide by design, so tests that change a
 *  fixture install entry need a deterministic reset. */
export function __testOnly_resetTraexInstallWatch(): void {
  installIdentityCache.clear();
}
