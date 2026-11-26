/**
 * PR2 start gate: physical domain key, cross-process registry, content
 * snapshots and the gate orchestration.
 *
 * Run: bun x vitest run --project unit test/traex-runtime-gate.test.ts
 */
import {
  chmodSync,
  copyFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveTraexRuntimeDomain,
  TRAEX_RUNTIME_LOCK_NAME,
  TRAEX_RUNTIME_REGISTRY_NAME,
} from '../src/services/traex-runtime-domain.js';
import {
  abandonTraexRuntime,
  acquireTraexRuntimeStart,
  contentCompatible,
  occupantLiveness,
  readTraexRuntimeOccupants,
  releaseTraexRuntime,
  markTraexRuntimeDeathUnproven,
  markTraexRuntimeRunning,
  markTraexRuntimeUnknown,
  type TraexRuntimeOccupant,
} from '../src/services/traex-runtime-registry.js';
import { readProcessStartIdentity, findProcessesRunningUnder } from '../src/utils/process-identity.js';
import { standaloneSleep } from './helpers/standalone-sleep.js';
import { resolveInstallIdentity } from '../src/services/cli-install-identity.js';
import {
  captureTraexReleaseIdentity,
  comboKeyFromHashes,
  materializeTraexSnapshot,
  __testOnly_resetTraexSnapshotCache,
} from '../src/services/traex-runtime-snapshot.js';
import {
  acquireTraexRuntimeLease,
  acquireTraexRuntimePeerLease,
  acquireTraexRuntimeOccupancy,
  applyTraexRuntimeOwnershipEnv,
  captureTraexRunningContentIdentity,
  computeTraexInstallSignature,
  precheckTraexRuntime,
  traexLaunchUsesSharedRuntimeGate,
} from '../src/services/traex-runtime-gate.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
const rootIgnoresWritePermissionBits = process.geteuid?.() === 0;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A minimal release layout: `traex`, `traex-code-mode-host`, `trae-installation.json`. */
function release(content: string): string {
  const dir = tempDir('botmux-traex-release-');
  writeFileSync(join(dir, 'traex'), `traex-${content}`);
  writeFileSync(join(dir, 'traex-code-mode-host'), `helper-${content}`);
  writeFileSync(join(dir, 'trae-installation.json'), `{"version":"${content}"}`);
  return dir;
}

function traeHome(): string {
  return tempDir('botmux-traex-home-');
}

const sleepBin = standaloneSleep();
function realRelease(version = 'a'): string {
  const dir = tempDir('botmux-traex-real-release-');
  if (!sleepBin.path) throw new Error('standalone sleep unavailable');
  copyFileSync(sleepBin.path, join(dir, 'traex'));
  chmodSync(join(dir, 'traex'), 0o755);
  writeFileSync(join(dir, 'traex-code-mode-host'), `helper-${version}`);
  writeFileSync(join(dir, 'trae-installation.json'), JSON.stringify({ version }));
  return dir;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

beforeEach(() => {
  __testOnly_resetTraexSnapshotCache();
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }
  for (const dir of dirs.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('shared runtime gate launch eligibility', () => {
  it('keeps direct launches coordinated and excludes wrapperCli / forge-traex', () => {
    expect(traexLaunchUsesSharedRuntimeGate({})).toBe(true);
    expect(traexLaunchUsesSharedRuntimeGate({ cliLaunchMode: 'direct' })).toBe(true);
    expect(traexLaunchUsesSharedRuntimeGate({ wrapperCli: 'gateway traex' })).toBe(false);
    expect(traexLaunchUsesSharedRuntimeGate({ cliLaunchMode: 'forge-traex' })).toBe(false);
  });
});

describe('resolveTraexRuntimeDomain', () => {
  it('creates the skills root and returns a stable key before .system exists', () => {
    const home = traeHome();
    const first = resolveTraexRuntimeDomain(home);
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    // Simulate TRAE creating its cache after the key was first observed.
    mkdirSync(join(home, 'skills', '.system'), { recursive: true });
    writeFileSync(join(home, 'skills', '.system', 'marker'), 'b8aa9fda6f08d0ac');
    const second = resolveTraexRuntimeDomain(home);
    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') return;
    expect(second.domain.domainKey).toBe(first.domain.domainKey);
    expect(second.domain.lockPath).toBe(join(second.domain.skillsDir, TRAEX_RUNTIME_LOCK_NAME));
    expect(second.domain.registryPath).toBe(join(second.domain.skillsDir, TRAEX_RUNTIME_REGISTRY_NAME));
  });

  it('collapses two TRAE_HOMEs whose skills symlink to the same physical directory', () => {
    const physical = tempDir('botmux-traex-shared-skills-');
    const homeA = traeHome();
    const homeB = traeHome();
    symlinkSync(physical, join(homeA, 'skills'));
    symlinkSync(physical, join(homeB, 'skills'));
    const a = resolveTraexRuntimeDomain(homeA);
    const b = resolveTraexRuntimeDomain(homeB);
    expect(a.kind).toBe('ready');
    expect(b.kind).toBe('ready');
    if (a.kind !== 'ready' || b.kind !== 'ready') return;
    expect(a.domain.domainKey).toBe(b.domain.domainKey);
    expect(a.domain.lockPath).toBe(b.domain.lockPath);
    expect(a.domain.registryPath).toBe(b.domain.registryPath);
  });

  it.skipIf(rootIgnoresWritePermissionBits)('fails closed when the shared skills directory is not writable', () => {
    const home = traeHome();
    mkdirSync(join(home, 'skills'), { recursive: true });
    chmodSync(join(home, 'skills'), 0o555);
    const resolved = resolveTraexRuntimeDomain(home);
    expect(resolved.kind).toBe('uncoordinated');
    if (resolved.kind === 'uncoordinated') expect(resolved.reason).toBe('skills-dir-not-writable');
  });
});

describe('contentCompatible', () => {
  it('never treats an unknown content identity as compatible', () => {
    expect(contentCompatible('', '')).toBe(false);
    expect(contentCompatible('', 'abc')).toBe(false);
    expect(contentCompatible('abc', 'abc')).toBe(true);
    expect(contentCompatible('abc', 'def')).toBe(false);
  });
});

describe('traex runtime registry', () => {
  function domainFor(home: string) {
    const resolved = resolveTraexRuntimeDomain(home);
    if (resolved.kind !== 'ready') throw new Error('domain not ready');
    return resolved.domain;
  }

  it('allows same-content runtimes to overlap and blocks different content', async () => {
    const domain = domainFor(traeHome());
    const sameA = await acquireTraexRuntimeStart(domain, {
      occupantId: 'a', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    const sameB = await acquireTraexRuntimeStart(domain, {
      occupantId: 'b', comboKey: 'content-a', workerPid: process.ppid, daemonPid: process.ppid,
    });
    expect(sameA.decision).toBe('start');
    expect(sameB.decision).toBe('start');

    const other = await acquireTraexRuntimeStart(domain, {
      occupantId: 'c', comboKey: 'content-b', workerPid: 999_999, daemonPid: 999_999,
    });
    expect(other.decision).toBe('blocked');
    if (other.decision === 'blocked') {
      expect(other.blockers.map((blocker) => blocker.occupantId).sort()).toEqual(['a', 'b']);
    }
    expect(readTraexRuntimeOccupants(domain)?.map((occupant) => occupant.occupantId).sort())
      .toEqual(['a', 'b']);
  });

  it('blocks a proven content request while an unknown occupant holds the domain', async () => {
    const domain = domainFor(traeHome());
    // A distinct owner: the same worker superseding its own pre-exec record is
    // a legitimate restart, so the fixture must not reuse this process's pid.
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'unknown', comboKey: '', workerPid: process.ppid, daemonPid: process.ppid,
    });
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'new', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('blocked');
  });

  it('prunes only provably dead occupants', async () => {
    const domain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    const dead = await acquireTraexRuntimeStart(domain, {
      occupantId: 'dead', comboKey: 'content-old', workerPid: deadPid, daemonPid: deadPid,
      now: Date.now() - 120_000,
    });
    expect(dead.decision).toBe('start');
    // Attach a CLI pid the kernel proves gone; without it a `starting` record
    // may still hide a spawned CLI and must keep occupying the domain.
    await markTraexRuntimeRunning(domain, 'dead', { cliPid: deadPid });
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('start');
    expect(readTraexRuntimeOccupants(domain)?.map((occupant) => occupant.occupantId))
      .toEqual(['live']);
  });

  it('keeps a starting record whose CLI was never recorded', async () => {
    const domain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'starting-crash', comboKey: 'content-old', workerPid: deadPid, daemonPid: deadPid,
      now: Date.now() - 120_000,
    });
    // The worker may have exec'd a CLI before dying without recording its pid;
    // that cannot be proven gone, so the domain stays occupied (fail closed).
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('blocked');
  });

  it('backfills an unproven record with the running content key and never replaces a proven one', async () => {
    const domain = domainFor(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'opaque', comboKey: '', force: true, occupancyOnly: true,
      workerPid: process.ppid, daemonPid: process.ppid,
    });
    await markTraexRuntimeRunning(domain, 'opaque', { cliPid: process.pid, comboKey: 'content-a', installSignature: 'signature-a' });
    expect(readTraexRuntimeOccupants(domain)?.find(o => o.occupantId === 'opaque'))
      .toMatchObject({ comboKey: 'content-a', installSignature: 'signature-a' });

    // A proven identity is authoritative: a later observation never rewrites it.
    const provenDomain = domainFor(traeHome());
    await acquireTraexRuntimeStart(provenDomain, {
      occupantId: 'proven', comboKey: 'content-b', workerPid: 2_000_000_000, daemonPid: 2_000_000_000,
    });
    await markTraexRuntimeRunning(provenDomain, 'proven', {
      cliPid: process.pid, comboKey: 'content-c', installSignature: 'signature-c',
    });
    const proven = readTraexRuntimeOccupants(provenDomain)?.find(o => o.occupantId === 'proven');
    expect(proven?.comboKey).toBe('content-b');
    expect(proven?.installSignature).toBeUndefined();
  });

  it('inherits the proven content key when the same live CLI is re-registered', async () => {
    const domain = domainFor(traeHome());
    const cliStart = readProcessStartIdentity(process.pid);
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'first', comboKey: 'content-a', installSignature: 'signature-a', force: true, occupancyOnly: true,
      cliPid: process.pid, ...(cliStart ? { cliStart } : {}),
      workerPid: process.ppid, daemonPid: process.ppid,
    });
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'second', comboKey: '', force: true, occupancyOnly: true,
      cliPid: process.pid, ...(cliStart ? { cliStart } : {}),
      workerPid: process.ppid, daemonPid: process.ppid,
    });
    expect(readTraexRuntimeOccupants(domain)?.find(o => o.occupantId === 'second'))
      .toMatchObject({ comboKey: 'content-a', installSignature: 'signature-a' });
  });

  it('restores the scheduler install signature from snapshot provenance after reattach', async () => {
    const home = traeHome();
    const dir = release('a');
    const snapshot = await materializeTraexSnapshot({
      releaseDir: dir,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    const identity = await captureTraexRunningContentIdentity(resolveInstallIdentity(snapshot.traexPath)!);
    expect(identity?.installSignature).toBe(computeTraexInstallSignature(dir));
    const cliStart = readProcessStartIdentity(process.pid);
    const attached = await acquireTraexRuntimeOccupancy({
      traeHome: home,
      releaseDir: dir,
      existingRuntime: true,
      cliPid: process.pid,
      ...(cliStart ? { cliStart } : {}),
      workerPid: process.ppid,
      daemonPid: process.ppid,
    });
    expect(attached.kind).toBe('granted');
    if (attached.kind !== 'granted') return;

    // This is the worker's leaf-backfill contract: the content key and the
    // source signature come from the same verified snapshot manifest.
    await attached.lease.markRunning(process.pid, cliStart, identity);
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir }).state).toBe('compatible');
  });

  it('restores a non-snapshot legacy runtime with its verified install signature', async () => {
    const home = traeHome();
    const dir = release('legacy');
    const identity = await captureTraexRunningContentIdentity(resolveInstallIdentity(join(dir, 'traex'))!);
    expect(identity?.installSignature).toBe(computeTraexInstallSignature(dir));
    const cliStart = readProcessStartIdentity(process.pid);
    const attached = await acquireTraexRuntimeOccupancy({
      traeHome: home,
      releaseDir: dir,
      existingRuntime: true,
      cliPid: process.pid,
      ...(cliStart ? { cliStart } : {}),
      workerPid: process.ppid,
      daemonPid: process.ppid,
    });
    expect(attached.kind).toBe('granted');
    if (attached.kind !== 'granted') return;
    await attached.lease.markRunning(process.pid, cliStart, identity);
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir }).state).toBe('compatible');
  });

  it('keeps an unlinked and replaced running object unknown instead of hashing new bytes', async () => {
    const dir = release('old');
    const executable = join(dir, 'traex');
    const running = resolveInstallIdentity(executable)!;
    unlinkSync(executable);
    writeFileSync(executable, 'new-version');
    expect(await captureTraexRunningContentIdentity(running)).toBeUndefined();
  });

  it('lets a same-content start overlap an opaque runtime after its identity is backfilled', async () => {
    const domain = domainFor(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'opaque', comboKey: '', workerPid: process.ppid, daemonPid: process.ppid,
    });
    await markTraexRuntimeRunning(domain, 'opaque', { cliPid: process.pid, comboKey: 'content-a' });
    const same = await acquireTraexRuntimeStart(domain, {
      occupantId: 'same', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(same.decision).toBe('start');
    const other = await acquireTraexRuntimeStart(domain, {
      occupantId: 'other', comboKey: 'content-b', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(other.decision).toBe('blocked');
  });

  it('releases a starting orphan after the grace only when the snapshot scan is definitely empty', async () => {
    const domain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    const snapshotDir = tempDir('botmux-traex-orphan-');
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'orphan', comboKey: 'content-old', snapshotDir,
      workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 11 * 60_000,
    });
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('start');
    expect(readTraexRuntimeOccupants(domain)?.map(o => o.occupantId)).toEqual(['live']);
  });

  it('keeps a starting orphan inside the grace even when nothing runs from it', async () => {
    const domain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    const snapshotDir = tempDir('botmux-traex-orphan-');
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'orphan', comboKey: 'content-old', snapshotDir,
      workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 60_000,
    });
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('blocked');
  });

  it('releases an occupancy-only orphan after its longer grace and keeps a live adopted CLI', async () => {
    const orphanDomain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    const orphanRelease = tempDir('botmux-traex-occ-');
    await acquireTraexRuntimeStart(orphanDomain, {
      occupantId: 'occ-orphan', comboKey: '', force: true, occupancyOnly: true, traexPath: orphanRelease,
      workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 31 * 60_000,
    });
    const freed = await acquireTraexRuntimeStart(orphanDomain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(freed.decision).toBe('start');
    expect(readTraexRuntimeOccupants(orphanDomain)?.map(o => o.occupantId)).toEqual(['live']);

    const adoptedDomain = domainFor(traeHome());
    const adoptedRelease = tempDir('botmux-traex-occ-');
    await acquireTraexRuntimeStart(adoptedDomain, {
      occupantId: 'adopted', comboKey: 'content-a', force: true, occupancyOnly: true, traexPath: adoptedRelease,
      cliPid: process.pid, workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 31 * 60_000,
    });
    const same = await acquireTraexRuntimeStart(adoptedDomain, {
      occupantId: 'same', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(same.decision).toBe('start');
    expect(readTraexRuntimeOccupants(adoptedDomain)?.map(o => o.occupantId)).toContain('adopted');
  });

  it('releases an opaque new-exec orphan after the release-dir grace and keeps it inside it', async () => {
    const expiredDomain = domainFor(traeHome());
    const deadPid = 2_000_000_000;
    const expiredRelease = tempDir('botmux-traex-opaque-');
    // Low-level unknown new exec: no snapshot and no content key. Production
    // wrapper/forge launches no longer register such records, but the bounded
    // registry cleanup remains defensive for any record written this way.
    await acquireTraexRuntimeStart(expiredDomain, {
      occupantId: 'opaque-orphan', comboKey: '', traexPath: expiredRelease,
      workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 31 * 60_000,
    });
    const freed = await acquireTraexRuntimeStart(expiredDomain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(freed.decision).toBe('start');
    expect(readTraexRuntimeOccupants(expiredDomain)?.map(o => o.occupantId)).toEqual(['live']);

    const pendingDomain = domainFor(traeHome());
    const pendingRelease = tempDir('botmux-traex-opaque-');
    await acquireTraexRuntimeStart(pendingDomain, {
      occupantId: 'opaque-orphan', comboKey: '', traexPath: pendingRelease,
      workerPid: deadPid, daemonPid: deadPid, now: Date.now() - 20 * 60_000,
    });
    const blocked = await acquireTraexRuntimeStart(pendingDomain, {
      occupantId: 'live', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(blocked.decision).toBe('blocked');
  });

  it('keeps a record whose process birth cannot be proven', async () => {
    const domain = domainFor(traeHome());
    const occupant: TraexRuntimeOccupant = {
      occupantId: 'uncertain',
      comboKey: 'content-old',
      phase: 'running',
      workerPid: 2_000_000_000,
      daemonPid: 2_000_000_000,
      createdAt: 1,
      heartbeatAt: 1,
      leaseUntil: 2,
    };
    // No birth token + a pid that the kernel cannot prove gone => unknown.
    expect(occupantLiveness(occupant, Date.now())).toBe('unknown');
  });

  it('releases a slot explicitly', async () => {
    const domain = domainFor(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'a', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(await releaseTraexRuntime(domain, 'a')).toBe(true);
    expect(readTraexRuntimeOccupants(domain)).toEqual([]);
  });

  it('fails closed on a corrupt registry file', async () => {
    const domain = domainFor(traeHome());
    writeFileSync(domain.registryPath, '{not json');
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId: 'a', comboKey: 'content-a', workerPid: process.pid, daemonPid: process.pid,
    });
    expect(decision.decision).toBe('error');
    if (decision.decision === 'error') expect(decision.reason).toBe('registry-corrupt');
  });
});

describe('traex release snapshots', () => {
  it('derives the combo key from content only and reuses one snapshot per combination', async () => {
    const a1 = release('a');
    const a2 = release('a');
    const root = tempDir('botmux-traex-snapshots-');
    const first = await materializeTraexSnapshot({ releaseDir: a1, snapshotsRoot: root });
    const second = await materializeTraexSnapshot({ releaseDir: a2, snapshotsRoot: root });
    expect(second.dir).toBe(first.dir);
    expect(second.reused).toBe(true);
    expect(first.comboKey).toBe(second.comboKey);
    expect(readFileSync(first.traexPath, 'utf8')).toBe('traex-a');
    expect(first.helperPath && readFileSync(first.helperPath, 'utf8')).toBe('helper-a');
  });

  it('gives different content a different snapshot and directory', async () => {
    const root = tempDir('botmux-traex-snapshots-');
    const oldSnapshot = await materializeTraexSnapshot({ releaseDir: release('old'), snapshotsRoot: root });
    const newSnapshot = await materializeTraexSnapshot({ releaseDir: release('new'), snapshotsRoot: root });
    expect(newSnapshot.comboKey).not.toBe(oldSnapshot.comboKey);
    expect(newSnapshot.dir).not.toBe(oldSnapshot.dir);
    expect(readFileSync(newSnapshot.traexPath, 'utf8')).toBe('traex-new');
  });

  it('rejects content that changes between hash capture and copy (traex + helper)', async () => {
    const dir = release('A');
    const root = tempDir('botmux-traex-snapshots-');
    let switched = false;
    const snapshot = await materializeTraexSnapshot({
      releaseDir: dir,
      snapshotsRoot: root,
      __testOnly_onCaptured: (_identity, attempt) => {
        if (attempt !== 1 || switched) return;
        switched = true;
        writeFileSync(join(dir, 'traex'), 'traex-B');
        writeFileSync(join(dir, 'traex-code-mode-host'), 'helper-B');
        writeFileSync(join(dir, 'trae-installation.json'), '{"version":"B"}');
      },
    });
    // The published snapshot must be the post-switch content under its own key.
    expect(readFileSync(snapshot.traexPath, 'utf8')).toBe('traex-B');
    expect(snapshot.helperPath && readFileSync(snapshot.helperPath, 'utf8')).toBe('helper-B');
    const identityB = await captureTraexReleaseIdentity(dir);
    expect(snapshot.comboKey).toBe(identityB.comboKey);
    // The A identity was never published.
    const identityA = comboKeyFromHashes({
      traex: 'a'.repeat(64), helper: 'b'.repeat(64), installation: 'c'.repeat(64),
    });
    expect(snapshot.comboKey).not.toBe(identityA);
  });

  it('rejects content when only installation.json changes between capture and copy', async () => {
    const dir = release('A');
    const root = tempDir('botmux-traex-snapshots-');
    let switched = false;
    const snapshot = await materializeTraexSnapshot({
      releaseDir: dir,
      snapshotsRoot: root,
      __testOnly_onCaptured: (_identity, attempt) => {
        if (attempt !== 1 || switched) return;
        switched = true;
        writeFileSync(join(dir, 'trae-installation.json'), '{"version":"B"}');
      },
    });
    expect(readFileSync(snapshot.traexPath, 'utf8')).toBe('traex-A');
    expect(snapshot.installationPath && readFileSync(snapshot.installationPath, 'utf8'))
      .toBe('{"version":"B"}');
    expect(snapshot.manifest.installation?.sha256).toBe(
      (await captureTraexReleaseIdentity(dir)).hashes.installation,
    );
  });

  it('refuses a release with no main executable', async () => {
    const dir = tempDir('botmux-traex-release-');
    await expect(materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot: tempDir('botmux-traex-snapshots-') }))
      .rejects.toThrow(/missing its main executable/);
  });
});

describe('acquireTraexRuntimeLease', () => {
  it('grants a lease that publishes the snapshot paths', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const result = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('a'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') return;
    expect(result.lease.snapshot.traexPath).toContain(result.lease.snapshot.comboKey);
    expect(result.lease.snapshot.snapshot).toBe(true);
    // The lease may only be released once the CLI it started is proven gone.
    await result.lease.markRunning(2_000_000_000);
    await result.lease.release();
    const domain = resolveTraexRuntimeDomain(home);
    expect(domain.kind).toBe('ready');
    if (domain.kind === 'ready') expect(readTraexRuntimeOccupants(domain.domain)).toEqual([]);
  });

  it('keeps draining a lease whose CLI is still alive, and abandons a pre-exec lease', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const live = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('a'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(live.kind).toBe('granted');
    if (live.kind !== 'granted') return;
    await live.lease.markRunning(process.pid);
    await expect(live.lease.release()).rejects.toThrow('lease retained for retry');
    const domain = resolveTraexRuntimeDomain(home);
    if (domain.kind !== 'ready') throw new Error('domain not ready');
    const kept = readTraexRuntimeOccupants(domain.domain) ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.phase).toBe('draining');
    // A failed spawn has no CLI at all: the owner may explicitly abandon it.
    const failed = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('b'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(failed.kind).toBe('blocked');
    await live.lease.abandon();
    expect(readTraexRuntimeOccupants(domain.domain)).toEqual([]);
  });

  it('freezes an operator-pinned executable while leaving the pinned path untouched', async () => {
    const home = traeHome();
    const pinned = release('pinned');
    const pinnedExe = join(pinned, 'traex');
    const before = readFileSync(pinnedExe, 'utf8');
    const expected = await captureTraexReleaseIdentity(pinned, pinnedExe);
    const result = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: pinned,
      fixedPath: true,
      fixedExecutablePath: pinnedExe,
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') return;
    // A pinned runtime is still frozen: the gate never lets a later source
    // switch change what this process loads. The operator's config path is not
    // rewritten; only the launch object is a private copy.
    expect(result.lease.snapshot.snapshot).toBe(true);
    expect(result.lease.snapshot.traexPath).not.toBe(pinnedExe);
    expect(result.lease.snapshot.comboKey).toBe(expected.comboKey);
    expect(readFileSync(result.lease.snapshot.traexPath, 'utf8')).toBe(before);
    expect(readFileSync(pinnedExe, 'utf8')).toBe(before);
    await result.lease.abandon();
  });

  it('refuses to start a different content while an incompatible runtime lives', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const first = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('old'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') return;
    // The first runtime really started: attach a live CLI so the second start
    // cannot treat it as this worker's own superseded pre-exec reservation.
    await first.lease.markRunning(process.pid);
    const second = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('new'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(second.kind).toBe('blocked');
    if (second.kind === 'blocked') expect(second.blockers).toHaveLength(1);
    await first.lease.abandon();
  });

  it.skipIf(rootIgnoresWritePermissionBits)('fails closed when the shared cache cannot be coordinated', async () => {
    const home = traeHome();
    mkdirSync(join(home, 'skills'), { recursive: true });
    chmodSync(join(home, 'skills'), 0o555);
    const result = await acquireTraexRuntimeLease({
      traeHome: home,
      releaseDir: release('a'),
      workerPid: process.pid,
      daemonPid: process.pid,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.reason).toBe('uncoordinated');
  });

  it.skipIf(rootIgnoresWritePermissionBits)('reports an unknown precheck when the domain is uncoordinated', () => {
    const home = traeHome();
    mkdirSync(join(home, 'skills'), { recursive: true });
    chmodSync(join(home, 'skills'), 0o555);
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: release('a') }).state).toBe('unknown');
  });

  it('prechecks free, compatible and blocked domains from install signatures', async () => {
    const home = traeHome();
    const dir = release('a');
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir }).state).toBe('free');

    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const lease = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, workerPid: process.pid, daemonPid: process.pid, snapshotsRoot,
    });
    expect(lease.kind).toBe('granted');
    if (lease.kind !== 'granted') return;
    // Same release signature => scheduler may start in parallel.
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir }).state).toBe('compatible');
    // A different release signature => defer, never assume compatibility.
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: release('b') }).state).toBe('blocked');
    await lease.lease.abandon();
  });

  it('computes a stable install signature and leaves absent files as holes', () => {
    const dir = release('a');
    expect(computeTraexInstallSignature(dir)).toBe(computeTraexInstallSignature(dir));
    const bare = tempDir('botmux-traex-release-');
    writeFileSync(join(bare, 'traex'), 'only-main');
    expect(computeTraexInstallSignature(bare)).toContain('-|-');
  });
});

describe('runtime registry lifecycle regressions', () => {
  function testDomain(home: string) {
    const resolution = resolveTraexRuntimeDomain(home);
    if (resolution.kind !== 'ready') throw new Error('domain unavailable');
    return resolution.domain;
  }

  it('keeps no-PID starting and recovers legacy draining within the orphan grace', async () => {
    const home = traeHome();
    const domain = testDomain(home);
    const snapshotDir = tempDir('botmux-traex-empty-');
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'starting', comboKey: 'content-old', snapshotDir,
      workerPid: 2_000_000_000, daemonPid: 2_000_000_000, now: Date.now() - 11 * 60_000,
    });
    expect(await releaseTraexRuntime(domain, 'starting', { requireCliGone: true })).toBe(false);
    expect(readTraexRuntimeOccupants(domain)?.[0]?.phase).toBe('starting');
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: snapshotDir }).state).toBe('free');

    const legacyHome = traeHome();
    const legacyDomain = testDomain(legacyHome);
    const legacyRelease = tempDir('botmux-traex-legacy-release-');
    await acquireTraexRuntimeStart(legacyDomain, {
      occupantId: 'legacy-draining', comboKey: '', force: true, occupancyOnly: true,
      traexPath: legacyRelease, workerPid: 2_000_000_000, daemonPid: 2_000_000_000,
      now: Date.now() - 31 * 60_000,
    });
    const registryPath = legacyDomain.registryPath;
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.occupants[0].phase = 'draining';
    writeFileSync(registryPath, JSON.stringify(registry));
    expect(precheckTraexRuntime({ traeHome: legacyHome, releaseDir: legacyRelease }).state).toBe('free');
  });

  it('uses the custom executable identity for precheck and lease registration', async () => {
    const home = traeHome();
    const dir = release('custom');
    const executablePath = join(dir, 'custom-traex');
    writeFileSync(executablePath, 'custom-main');
    const signature = computeTraexInstallSignature(dir, executablePath);
    const identity = await captureTraexReleaseIdentity(dir, executablePath);
    expect(signature).toBe(identity.sourceSignature);
    const lease = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, executablePath,
      workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    expect(lease.kind).toBe('granted');
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir, executablePath }).state).toBe('compatible');
    writeFileSync(executablePath, 'changed-main');
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir, executablePath }).state).toBe('blocked');
  });

  it('refreshes the source signature when reusing a snapshot after an atomic same-content replacement', async () => {
    const dir = release('a');
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const first = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') return;
    const oldSignature = readTraexRuntimeOccupants(first.lease.domain)?.[0]?.installSignature;
    await first.lease.abandon();

    renameSync(join(dir, 'traex'), join(dir, 'traex.previous'));
    writeFileSync(join(dir, 'traex'), 'traex-a');
    const second = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, workerPid: process.ppid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(second.kind).toBe('granted');
    if (second.kind !== 'granted') return;
    expect(second.lease.snapshot.reused).toBe(true);
    const currentSignature = computeTraexInstallSignature(dir, join(dir, 'traex'));
    expect(currentSignature).not.toBe(oldSignature);
    expect(readTraexRuntimeOccupants(second.lease.domain)?.[0]?.installSignature).toBe(currentSignature);
    expect(precheckTraexRuntime({ traeHome: home, releaseDir: dir }).state).toBe('compatible');
  });

  it.skipIf(process.platform !== 'linux')('keeps death-unproven process groups blocked until every descendant exits', async () => {
    const domain = testDomain(traeHome());
    const leader = spawn('/bin/sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'ignore' });
    const pid = leader.pid!;
    const cliStart = readProcessStartIdentity(pid);
    try {
      await acquireTraexRuntimeStart(domain, {
        occupantId: 'rpc-leaf', comboKey: 'content-a', cliPid: pid, ...(cliStart ? { cliStart } : {}),
        workerPid: process.pid, daemonPid: process.pid,
      });
      if (leader.exitCode === null) await new Promise<void>(resolve => leader.once('exit', () => resolve()));
      await markTraexRuntimeDeathUnproven(domain, 'rpc-leaf', pid);
      const blocked = await acquireTraexRuntimeStart(domain, {
        occupantId: 'incompatible', comboKey: 'content-b', workerPid: process.pid, daemonPid: process.pid,
      });
      expect(blocked.decision).toBe('blocked');
      expect(readTraexRuntimeOccupants(domain)?.[0]?.deathUnproven).toBe(true);
      process.kill(-pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 50));
      const after = await acquireTraexRuntimeStart(domain, {
        occupantId: 'after-group-exit', comboKey: 'content-b', workerPid: process.pid, daemonPid: process.pid,
      });
      expect(after.decision).toBe('start');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
  });

  it.skipIf(process.platform !== 'linux')('keeps PID-less adopted occupancy closed when actual process identity is unproven', async () => {
    const dir = realRelease('adopt-no-pid');
    const occupancy = await acquireTraexRuntimeOccupancy({
      traeHome: traeHome(), releaseDir: dir, workerPid: process.pid, daemonPid: process.pid,
      existingRuntime: true,
    });
    expect(occupancy.kind).toBe('granted');
    if (occupancy.kind !== 'granted') return;
    const child = spawn(join(dir, 'traex'), ['60'], { stdio: 'ignore' });
    children.push(child);
    await new Promise(resolve => setTimeout(resolve, 50));
    await expect(occupancy.lease.release()).rejects.toThrow('lease retained for retry');
    expect(readTraexRuntimeOccupants(occupancy.lease.domain)?.map(entry => entry.occupantId)).toEqual([occupancy.lease.occupantId]);
    await exited(child);
    await expect(occupancy.lease.release()).rejects.toThrow('lease retained for retry');
    expect(readTraexRuntimeOccupants(occupancy.lease.domain)?.map(entry => entry.occupantId)).toEqual([occupancy.lease.occupantId]);
    await abandonTraexRuntime(occupancy.lease.domain, occupancy.lease.occupantId);
  });

  it.each(['app-server', 'viewer'] as const)('keeps independent RPC peer occupants when the %s exits first', async firstExit => {
    const app = await acquireTraexRuntimeLease({
      traeHome: traeHome(), releaseDir: release('a'), workerPid: process.pid, daemonPid: process.pid,
    });
    expect(app.kind).toBe('granted');
    if (app.kind !== 'granted') return;
    await app.lease.markRunning(process.pid);
    const viewer = await acquireTraexRuntimePeerLease(app.lease, {
      workerPid: process.pid, daemonPid: process.pid,
    });
    expect(viewer.kind).toBe('granted');
    if (viewer.kind !== 'granted') return;
    await viewer.lease.markRunning(process.ppid);
    expect(viewer.lease.occupantId).not.toBe(app.lease.occupantId);
    expect(viewer.lease.snapshot.comboKey).toBe(app.lease.snapshot.comboKey);
    expect(viewer.lease.installSignature).toBe(app.lease.installSignature);
    const occupants = readTraexRuntimeOccupants(app.lease.domain) ?? [];
    expect(occupants.find(entry => entry.occupantId === app.lease.occupantId)?.cliPid).toBe(process.pid);
    expect(occupants.find(entry => entry.occupantId === viewer.lease.occupantId)?.cliPid).toBe(process.ppid);

    const first = firstExit === 'app-server' ? app.lease : viewer.lease;
    const survivor = firstExit === 'app-server' ? viewer.lease : app.lease;
    await abandonTraexRuntime(app.lease.domain, first.occupantId);
    const blocked = await acquireTraexRuntimeStart(app.lease.domain, {
      occupantId: 'incompatible-after-peer-exit', comboKey: 'content-b',
      workerPid: process.pid, daemonPid: process.pid,
    });
    expect(blocked.decision).toBe('blocked');
    expect(readTraexRuntimeOccupants(app.lease.domain)?.map(entry => entry.occupantId)).toEqual([survivor.occupantId]);
    await abandonTraexRuntime(app.lease.domain, survivor.occupantId);
  });

  it.each([
    [undefined, undefined, 'blocked'],
    ['worker-birth', undefined, 'blocked'],
    [undefined, 'worker-birth', 'blocked'],
    ['worker-birth', 'worker-birth', 'start'],
  ] as const)('requires paired worker birth tokens for same-owner supersession (%s, %s)', async (oldBirth, newBirth, expected) => {
    const domain = testDomain(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'old-start', comboKey: 'content-old', workerPid: process.pid, daemonPid: process.pid,
      ...(oldBirth ? { workerStart: oldBirth } : {}),
    });
    const replacement = await acquireTraexRuntimeStart(domain, {
      occupantId: 'new-start', comboKey: 'content-new', workerPid: process.pid, daemonPid: process.pid,
      ...(newBirth ? { workerStart: newBirth } : {}),
    });
    expect(replacement.decision).toBe(expected);
  });

  it('does not supersede a running unknown occupant or inherit identity without birth proof', async () => {
    const domain = testDomain(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'old', comboKey: 'content-a', cliPid: process.pid, cliStart: 'birth-a',
      workerPid: process.pid, workerStart: 'worker-birth', daemonPid: process.pid,
    });
    await markTraexRuntimeUnknown(domain, 'old', { cliPid: process.pid });
    expect(readTraexRuntimeOccupants(domain)?.[0]?.phase).toBe('running');

    const replacement = await acquireTraexRuntimeStart(domain, {
      occupantId: 'replacement', comboKey: 'content-b',
      workerPid: process.pid, workerStart: 'worker-birth', daemonPid: process.pid,
    });
    expect(replacement.decision).toBe('blocked');

    const inherited = await acquireTraexRuntimeStart(domain, {
      occupantId: 'inherit-without-birth', comboKey: '', cliPid: process.pid,
      workerPid: process.pid, workerStart: 'worker-birth', daemonPid: process.pid,
    });
    expect(inherited.decision).toBe('blocked');
  });

  it('records the final source signature after an in-place upgrade during materialization', async () => {
    const dir = release('a');
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const result = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
      __testOnly_onCaptured: (_identity, attempt) => {
        if (attempt === 1) writeFileSync(join(dir, 'traex'), 'traex-b-longer');
      },
    });
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') return;
    const expected = computeTraexInstallSignature(dir, join(dir, 'traex'));
    expect(readTraexRuntimeOccupants(result.lease.domain)?.[0]?.installSignature).toBe(expected);
    expect(result.lease.snapshot.manifest?.sourceSignature).toBe(expected);
  });

  it('pairs a reused snapshot with the signature from the same capture after an A-to-B source race', async () => {
    const dir = release('a');
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    writeFileSync(join(dir, 'traex'), 'traex-b-longer');
    await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });

    writeFileSync(join(dir, 'traex'), 'a');
    const stale = computeTraexInstallSignature(dir, join(dir, 'traex'));
    const result = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: dir, workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
      __testOnly_onCaptured: (_identity, attempt) => {
        if (attempt === 1) writeFileSync(join(dir, 'traex'), 'traex-b-longer');
      },
    });
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') return;
    const expected = computeTraexInstallSignature(dir, join(dir, 'traex'));
    expect(result.lease.snapshot.reused).toBe(true);
    expect(result.lease.snapshot.sourceSignature).toBe(expected);
    const registered = readTraexRuntimeOccupants(result.lease.domain)?.[0]?.installSignature;
    expect(registered).toBe(expected);
    expect(registered).not.toBe(stale);
  });

  it('clears a stale cliStart whenever a new attach lacks a birth token, even for the same PID', async () => {
    const domain = testDomain(traeHome());
    await acquireTraexRuntimeStart(domain, {
      occupantId: 'pid-change', comboKey: 'content-a', cliPid: 2_000_000_000, cliStart: 'stale-birth',
      workerPid: process.pid, daemonPid: process.pid,
    });
    await markTraexRuntimeRunning(domain, 'pid-change', { cliPid: process.pid });
    let occupant = readTraexRuntimeOccupants(domain)![0];
    expect(occupant.cliStart).toBeUndefined();
    expect(occupantLiveness(occupant)).toBe('alive');

    await markTraexRuntimeUnknown(domain, 'pid-change', { cliPid: process.pid });
    occupant = readTraexRuntimeOccupants(domain)![0];
    expect(occupant.cliStart).toBeUndefined();
    expect(occupantLiveness(occupant)).toBe('alive');

    await markTraexRuntimeRunning(domain, 'pid-change', { cliPid: process.pid, cliStart: 'new-birth' });
    expect(readTraexRuntimeOccupants(domain)![0].cliStart).toBe('new-birth');
    // The PID may have been reused since that token was captured. A later
    // attach without fresh birth evidence must not keep the old identity.
    await markTraexRuntimeRunning(domain, 'pid-change', { cliPid: process.pid });
    occupant = readTraexRuntimeOccupants(domain)![0];
    expect(occupant.cliStart).toBeUndefined();
    expect(occupantLiveness(occupant)).toBe('alive');
  });

  it('publishes a first snapshot even when the platform has no /proc writer scan', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const snapshot = await materializeTraexSnapshot({
        releaseDir: release('a'), snapshotsRoot: tempDir('botmux-traex-snapshots-'),
      });
      expect(snapshot.manifest.verified).toBe(true);
      expect(readFileSync(snapshot.traexPath, 'utf8')).toBe('traex-a');
    } finally {
      platform.mockRestore();
    }
  });

  it.each(['complete', 'manifest', 'drift', 'helper'] as const)('republishes a corrupted snapshot after %s', async mode => {
    const dir = release('a');
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const snapshot = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    if (mode === 'complete') unlinkSync(join(snapshot.dir, '.complete'));
    else if (mode === 'manifest') writeFileSync(join(snapshot.dir, 'manifest.json'), '{broken');
    else if (mode === 'drift') writeFileSync(snapshot.traexPath, 'drifted-content-longer');
    else unlinkSync(snapshot.helperPath!);
    const repaired = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    expect(readFileSync(repaired.traexPath, 'utf8')).toBe('traex-a');
    expect(repaired.manifest.verified).toBe(true);
  });

  it.skipIf(!sleepBin.path)('blocks snapshot repair while a writer lives and resumes after exit', async () => {
    const dir = realRelease();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const snapshot = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    writeFileSync(join(snapshot.dir, 'manifest.json'), '{broken');
    const child = spawn(snapshot.traexPath, ['60']);
    children.push(child);
    await new Promise(resolve => setTimeout(resolve, 25));
    await expect(materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot }))
      .rejects.toThrow('live writer');
    await exited(child);
    const repaired = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    expect(repaired.manifest.verified).toBe(true);
  });

  it.skipIf(!sleepBin.path)('restores a quarantined snapshot when an outstanding lease execs during repair', async () => {
    const dir = realRelease();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const snapshot = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    const originalSize = statSync(snapshot.traexPath).size;
    appendFileSync(snapshot.traexPath, 'DRIFTED-OLD-IMAGE');
    let child: ChildProcess | undefined;
    await expect(materializeTraexSnapshot({
      releaseDir: dir,
      snapshotsRoot,
      __testOnly_beforeQuarantine: async () => {
        // This lease was admitted before the repair. It execs after the first
        // live-writer scan but before finalDir is quarantined.
        child = spawn(snapshot.traexPath, ['60']);
        children.push(child);
        for (let i = 0; i < 200; i++) {
          if ((findProcessesRunningUnder(snapshot.dir) ?? []).includes(child.pid!)) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(findProcessesRunningUnder(snapshot.dir)).toContain(child.pid);
      },
    })).rejects.toThrow('exec during quarantine');
    expect(existsSync(snapshot.dir)).toBe(true);
    expect(findProcessesRunningUnder(snapshot.dir)).toContain(child!.pid);
    expect(child!.exitCode).toBeNull();
    await exited(child!);
    const repaired = await materializeTraexSnapshot({ releaseDir: dir, snapshotsRoot });
    expect(statSync(repaired.traexPath).size).toBe(originalSize);
    expect(repaired.manifest.verified).toBe(true);
  });

  it.skipIf(!sleepBin.path)('scans deleted directories for live and deleted executables', async () => {
    const snapshot = await materializeTraexSnapshot({
      releaseDir: realRelease(), snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    const child = spawn(snapshot.traexPath, ['60']);
    children.push(child);
    await new Promise(resolve => setTimeout(resolve, 25));
    rmSync(snapshot.dir, { recursive: true, force: true });
    expect(findProcessesRunningUnder(snapshot.dir)).toContain(child.pid);
    expect(findProcessesRunningUnder(join(snapshot.dir, 'missing'))).toEqual([]);
    await exited(child);
  });
});

describe('runtime ownership and process identity', () => {
  it('stamps coordinated leases and clears stale ownership for private/occupancy leases', async () => {
    const home = traeHome();
    const coordinated = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: release('a'), workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    expect(coordinated.kind).toBe('granted');
    if (coordinated.kind !== 'granted') return;
    const env: NodeJS.ProcessEnv = {
      BOTMUX_TRAEX_OCCUPANT_ID: 'stale-occupant', BOTMUX_TRAEX_DOMAIN_KEY: 'stale-domain',
    };
    applyTraexRuntimeOwnershipEnv(env, coordinated.lease);
    expect(env).toMatchObject({
      BOTMUX_TRAEX_OCCUPANT_ID: coordinated.lease.occupantId,
      BOTMUX_TRAEX_DOMAIN_KEY: coordinated.lease.domain.domainKey,
    });

    const privateLease = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: release('a'), coordinate: false,
      workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot: tempDir('botmux-traex-snapshots-'),
    });
    expect(privateLease.kind).toBe('granted');
    if (privateLease.kind !== 'granted') return;
    applyTraexRuntimeOwnershipEnv(env, privateLease.lease);
    expect(env.BOTMUX_TRAEX_OCCUPANT_ID).toBe(`private-${privateLease.lease.occupantId}`);
    expect(env.BOTMUX_TRAEX_DOMAIN_KEY).toBe('private');

    const occupancy = await acquireTraexRuntimeOccupancy({
      traeHome: home, releaseDir: release('a'), existingRuntime: true,
      workerPid: process.pid, daemonPid: process.pid,
    });
    expect(occupancy.kind).toBe('granted');
    if (occupancy.kind !== 'granted') return;
    env.BOTMUX_TRAEX_OCCUPANT_ID = 'stale-occupant';
    env.BOTMUX_TRAEX_DOMAIN_KEY = 'stale-domain';
    applyTraexRuntimeOwnershipEnv(env, occupancy.lease);
    expect(env.BOTMUX_TRAEX_OCCUPANT_ID).toBeUndefined();
    expect(env.BOTMUX_TRAEX_DOMAIN_KEY).toBeUndefined();
  });

  it.skipIf(!sleepBin.path)('isolates live writers by occupant and domain instead of snapshot path', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const first = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease(), workerPid: 2_000_000_000, daemonPid: process.pid,
      snapshotsRoot, now: () => Date.now() - 11 * 60_000,
    });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') return;
    const own = spawn(first.lease.snapshot.traexPath, ['60'], {
      env: {
        ...process.env,
        BOTMUX_TRAEX_OCCUPANT_ID: first.lease.occupantId,
        BOTMUX_TRAEX_DOMAIN_KEY: first.lease.domain.domainKey,
      },
    });
    const other = spawn(first.lease.snapshot.traexPath, ['60'], {
      env: {
        ...process.env,
        BOTMUX_TRAEX_OCCUPANT_ID: 'other-occupant', BOTMUX_TRAEX_DOMAIN_KEY: 'other-domain',
      },
    });
    children.push(own, other);
    await new Promise(resolve => setTimeout(resolve, 25));
    const next = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease('b'), workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(next.kind).toBe('blocked');

    await exited(own);
    const admitted = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease('b'), workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(other.exitCode).toBeNull();
    expect(admitted.kind).toBe('granted');
  });

  it.skipIf(!sleepBin.path)('excludes explicitly private scratch writers from a coordinated domain', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const first = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease(), workerPid: 2_000_000_000, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') return;
    const privateLease = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease(), coordinate: false,
      workerPid: 2_000_000_001, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(privateLease.kind).toBe('granted');
    if (privateLease.kind !== 'granted') return;
    const own = spawn(first.lease.snapshot.traexPath, ['60'], {
      env: {
        ...process.env,
        BOTMUX_TRAEX_OCCUPANT_ID: first.lease.occupantId,
        BOTMUX_TRAEX_DOMAIN_KEY: first.lease.domain.domainKey,
      },
    });
    const scratch = spawn(privateLease.lease.snapshot.traexPath, ['60'], {
      env: {
        ...process.env,
        BOTMUX_TRAEX_OCCUPANT_ID: `private-${privateLease.lease.occupantId}`,
        BOTMUX_TRAEX_DOMAIN_KEY: 'private',
      },
    });
    children.push(own, scratch);
    await new Promise(resolve => setTimeout(resolve, 25));
    await first.lease.markRunning(own.pid!, readProcessStartIdentity(own.pid!));

    await exited(own);
    const admitted = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease('b'), workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(scratch.exitCode).toBeNull();
    expect(admitted.kind).toBe('granted');
  });

  it.skipIf(!sleepBin.path)('keeps writers whose descendants scrubbed ownership markers', async () => {
    const home = traeHome();
    const snapshotsRoot = tempDir('botmux-traex-snapshots-');
    const first = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease(), workerPid: 2_000_000_000, daemonPid: process.pid,
      snapshotsRoot, now: () => Date.now() - 11 * 60_000,
    });
    expect(first.kind).toBe('granted');
    if (first.kind !== 'granted') return;
    const child = spawn(first.lease.snapshot.traexPath, ['60'], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    children.push(child);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(findProcessesRunningUnder(first.lease.snapshot.dir, {
      occupantId: first.lease.occupantId,
      domainKey: first.lease.domain.domainKey,
    })).toContain(child.pid);
    const next = await acquireTraexRuntimeLease({
      traeHome: home, releaseDir: realRelease('b'), workerPid: process.pid, daemonPid: process.pid,
      snapshotsRoot,
    });
    expect(next.kind).toBe('blocked');
  });
});
