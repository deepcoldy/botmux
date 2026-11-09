/**
 * PR2 start gate: physical domain key, cross-process registry, content
 * snapshots and the gate orchestration.
 *
 * Run: bun x vitest run --project unit test/traex-runtime-gate.test.ts
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveTraexRuntimeDomain,
  TRAEX_RUNTIME_LOCK_NAME,
  TRAEX_RUNTIME_REGISTRY_NAME,
} from '../src/services/traex-runtime-domain.js';
import {
  acquireTraexRuntimeStart,
  contentCompatible,
  occupantLiveness,
  readTraexRuntimeOccupants,
  releaseTraexRuntime,
  markTraexRuntimeRunning,
  type TraexRuntimeOccupant,
} from '../src/services/traex-runtime-registry.js';
import {
  captureTraexReleaseIdentity,
  comboKeyFromHashes,
  materializeTraexSnapshot,
  __testOnly_resetTraexSnapshotCache,
} from '../src/services/traex-runtime-snapshot.js';
import {
  acquireTraexRuntimeLease,
  computeTraexInstallSignature,
  precheckTraexRuntime,
} from '../src/services/traex-runtime-gate.js';

const dirs: string[] = [];

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

beforeEach(() => {
  __testOnly_resetTraexSnapshotCache();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
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

  it('fails closed when the shared skills directory is not writable', () => {
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
    await live.lease.release();
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

  it('fails closed when the shared cache cannot be coordinated', async () => {
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

  it('reports an unknown precheck when the domain is uncoordinated', () => {
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
    await lease.lease.release();
  });

  it('computes a stable install signature and leaves absent files as holes', () => {
    const dir = release('a');
    expect(computeTraexInstallSignature(dir)).toBe(computeTraexInstallSignature(dir));
    const bare = tempDir('botmux-traex-release-');
    writeFileSync(join(bare, 'traex'), 'only-main');
    expect(computeTraexInstallSignature(bare)).toContain('-|-');
  });
});
