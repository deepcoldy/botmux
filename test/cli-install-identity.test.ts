/**
 * PR1 mitigation: actual executable identity of a managed TRAE process.
 *
 * The point of these cases is that a running process must be compared by the
 * image it actually mapped (`/proc/<pid>/exe`), never by statting the current
 * install path — after an upgrade the path names a different inode and says
 * nothing about what the old process is running.
 *
 * Run: bun x vitest run --project unit test/cli-install-identity.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareLaunchedInstall,
  compareRunningToInstall,
  readRunningExeIdentity,
  resolveInstallIdentity,
  sameExecutableObject,
  type ExecutableIdentity,
} from '../src/services/cli-install-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

const children: ChildProcess[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-identity-'));
  dirs.push(dir);
  return dir;
}

const EXEC_SETTLE_MS = 2_000;

/**
 * Bun spawns through vfork, so its `spawn` event can arrive while the child is
 * still inside execve and `/proc/<pid>/exe` still names the Bun runtime. Wait,
 * bounded, until the kernel reports the copied CLI before asserting anything.
 */
async function spawnCopiedCli(dir: string): Promise<{ cli: string; child: ChildProcess }> {
  const cli = join(dir, 'traex');
  copyFileSync('/bin/sleep', cli);
  const child = spawn(cli, ['30'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });

  const image = realpathSync(cli);
  const deadline = Date.now() + EXEC_SETTLE_MS;
  for (;;) {
    let seen = '<unreadable>';
    try { seen = readlinkSync(`/proc/${child.pid}/exe`); } catch { /* not readable yet */ }
    if (seen === image) return { cli, child };
    if (Date.now() >= deadline) {
      throw new Error(`pid ${child.pid} still runs ${seen} after ${EXEC_SETTLE_MS}ms, expected ${image}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function identity(overrides: Partial<ExecutableIdentity> = {}): ExecutableIdentity {
  return {
    path: '/install/traex',
    dev: '1',
    ino: '100',
    size: '1000',
    mtimeNs: '1700000000000000000',
    source: 'install-stat',
    ...overrides,
  };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('compareRunningToInstall', () => {
  it('is current when inode, size and mtime match', () => {
    expect(compareRunningToInstall(identity(), identity({ source: 'linux-proc-exe' }))).toBe('current');
  });

  it('is unknown when the device differs: an alias must be proven, not guessed', () => {
    // Inode numbers are only unique per filesystem. A bind/overlay/scratch view
    // may name the same backing file, but that mapping is unproven here, so it
    // must never be reported as `current` (nor as `stale`, which would churn).
    expect(compareRunningToInstall(identity({ dev: '2' }), identity({ dev: '7' }))).toBe('unknown');
  });

  it('is stale when the inode changed (path re-pointed by an upgrade)', () => {
    expect(compareRunningToInstall(identity({ ino: '100' }), identity({ ino: '200' }))).toBe('stale');
  });

  it('is stale when the same inode was rewritten in place', () => {
    expect(compareRunningToInstall(identity({ size: '1000' }), identity({ size: '1001' }))).toBe('stale');
    expect(compareRunningToInstall(identity({ mtimeNs: '1' }), identity({ mtimeNs: '2' }))).toBe('stale');
  });

  it('is unknown when either side is unavailable', () => {
    expect(compareRunningToInstall(undefined, identity())).toBe('unknown');
    expect(compareRunningToInstall(identity(), undefined)).toBe('unknown');
  });
});

describe('resolveInstallIdentity', () => {
  it('resolves through a version symlink and returns the target inode', () => {
    const dir = tempDir();
    const target = join(dir, 'traex-0.214.1');
    const link = join(dir, 'current');
    writeFileSync(target, 'new-binary');
    // symlink to the versioned release, like ~/.local/bin/traex -> current/traex
    symlinkSync(target, link);

    const resolved = resolveInstallIdentity(link);
    expect(resolved).toBeDefined();
    expect(resolved!.ino).toBe(statSync(target, { bigint: true }).ino.toString());
    expect(resolved!.source).toBe('install-stat');
  });

  it('returns undefined for a missing entry', () => {
    expect(resolveInstallIdentity(join(tempDir(), 'nope'))).toBeUndefined();
    expect(resolveInstallIdentity('')).toBeUndefined();
  });
});

describe('readRunningExeIdentity', () => {
  it('reads the image the process actually runs, not the current path', async () => {
    const dir = tempDir();
    const { cli, child } = await spawnCopiedCli(dir);

    const before = readRunningExeIdentity(child.pid!);
    expect(before).toBeDefined();
    expect(before!.source).toBe('linux-proc-exe');
    expect(compareRunningToInstall(before, resolveInstallIdentity(cli))).toBe('current');

    // Upgrade in place: a new file is renamed over the entry while the old
    // process keeps running the unlinked inode.
    const next = join(dir, 'traex.next');
    copyFileSync('/bin/sleep', next);
    renameSync(next, cli);

    const after = readRunningExeIdentity(child.pid!);
    expect(after).toBeDefined();
    // The kernel view still points at the OLD inode...
    expect(after!.ino).toBe(before!.ino);
    // ...while the install entry now names the new one.
    expect(resolveInstallIdentity(cli)!.ino).not.toBe(after!.ino);
    expect(compareRunningToInstall(after, resolveInstallIdentity(cli))).toBe('stale');
  });

  it('keeps reporting the old identity after the running file is unlinked', async () => {
    const { cli, child } = await spawnCopiedCli(tempDir());

    const before = readRunningExeIdentity(child.pid!);
    expect(before).toBeDefined();
    unlinkSync(cli);

    // The ` (deleted)` suffix must not turn the stat into "unknown": a deleted
    // old inode is exactly the upgrade case this mitigation has to reclaim.
    const after = readRunningExeIdentity(child.pid!);
    expect(after).toBeDefined();
    expect(after!.ino).toBe(before!.ino);
    expect(compareRunningToInstall(after, resolveInstallIdentity(cli))).toBe('unknown');
  });

  it('returns undefined for a missing or invalid pid (unknown, never stale)', () => {
    expect(readRunningExeIdentity(process.pid + 999999)).toBeUndefined();
    expect(readRunningExeIdentity(0)).toBeUndefined();
    expect(readRunningExeIdentity(-1)).toBeUndefined();
    expect(readRunningExeIdentity(Number.NaN)).toBeUndefined();
  });

  it('refuses to pair the exe with a different process birth', async () => {
    const { child } = await spawnCopiedCli(tempDir());

    // The pid is alive, but the caller's attested birth token names some other
    // process: a reused pid must not authorize a reclaim of this one.
    expect(readRunningExeIdentity(child.pid!, 'birth-of-another-process')).toBeUndefined();
    // The real birth token still binds the exe read to this one process.
    const birth = readProcessStartIdentity(child.pid!);
    expect(birth).toBeDefined();
    expect(readRunningExeIdentity(child.pid!, birth)).toBeDefined();
  });
});

describe('sameExecutableObject', () => {
  it('requires the same dev:ino and unchanged metadata', () => {
    expect(sameExecutableObject(identity(), identity({ source: 'linux-proc-exe' }))).toBe(true);
    expect(sameExecutableObject(identity({ dev: '2' }), identity())).toBe(false);
    expect(sameExecutableObject(identity({ ino: '200' }), identity())).toBe(false);
    expect(sameExecutableObject(identity({ size: '999' }), identity())).toBe(false);
    expect(sameExecutableObject(undefined, identity())).toBe(false);
  });
});

describe('compareLaunchedInstall', () => {
  it('is unknown unless the entry named the running image at spawn', () => {
    const running = identity({ source: 'linux-proc-exe' });
    const upgraded = identity({ ino: '200' });
    expect(compareLaunchedInstall(running, undefined, upgraded)).toBe('unknown');
    // Wrapper layout: the entry was a different file all along, so a mismatch
    // with the running image says nothing about an upgrade.
    expect(compareLaunchedInstall(running, identity({ ino: '300' }), upgraded)).toBe('unknown');
  });

  it('compares a proven launch against the current install', () => {
    const running = identity({ source: 'linux-proc-exe' });
    expect(compareLaunchedInstall(running, identity(), identity())).toBe('current');
    expect(compareLaunchedInstall(running, identity(), identity({ ino: '200' }))).toBe('stale');
    expect(compareLaunchedInstall(running, identity(), identity({ dev: '2' }))).toBe('unknown');
  });
});
