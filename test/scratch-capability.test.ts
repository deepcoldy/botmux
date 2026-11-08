/**
 * Scratch capability probe + prepare-failure notices.
 *
 * The verdict is pure over gathered facts, so the root / non-root × tmpfs /
 * disk matrix is driven with hand-built facts; the gatherer is driven with a
 * fake host (PATH, sysctls, /proc/filesystems, /dev/fuse) so nothing here reads
 * or mounts anything real.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateScratchCapability,
  gatherScratchFacts,
  SCRATCH_FAILURE_REASONS,
  scratchFailureNotice,
  type ScratchFacts,
  type ScratchProbeIo,
} from '../src/adapters/backend/scratch-capability.js';

const facts = (over: Partial<ScratchFacts> & { has?: Partial<ScratchFacts['has']> } = {}): ScratchFacts => ({
  platform: 'linux',
  uid: 0,
  forceFuse: false,
  bwrapSetuid: false,
  noNewPrivs: false,
  devFuse: 'ok',
  kernelOverlay: true,
  userns: { state: 'ok' },
  ...over,
  has: { bwrap: true, fuseOverlayfs: true, fusermount: true, sandboxExec: false, packageManager: 'apt-get', ...over.has },
});

describe('evaluateScratchCapability', () => {
  it('root with every dependency can use both storages', () => {
    const cap = evaluateScratchCapability(facts());
    expect(cap.summary).toBe('all');
    expect(cap.storages?.tmpfs).toEqual({ usable: 'yes', problems: [] });
    expect(cap.storages?.disk).toEqual({ usable: 'yes', problems: [] });
    expect(cap.submountsReadOnly).toBe(false);
  });

  it('non-root: tmpfs is never usable, disk is when FUSE is', () => {
    const cap = evaluateScratchCapability(facts({ uid: 1000 }));
    expect(cap.summary).toBe('disk-only');
    expect(cap.storages?.tmpfs.problems).toEqual(['tmpfs-needs-root']);
    expect(cap.storages?.disk).toEqual({ usable: 'yes', problems: [] });
    expect(cap.submountsReadOnly).toBe(true);
  });

  it('non-root without /dev/fuse cannot run scratch at all', () => {
    const cap = evaluateScratchCapability(facts({ uid: 1000, devFuse: 'missing' }));
    expect(cap.summary).toBe('none');
    expect(cap.storages?.disk.problems).toEqual(['dev-fuse-missing']);
  });

  it('non-root needs the setuid fusermount helper; root mounts FUSE itself', () => {
    const noHelper = evaluateScratchCapability(facts({ uid: 1000, has: { fusermount: false } }));
    expect(noHelper.storages?.disk.problems).toEqual(['fusermount-missing']);
    expect(noHelper.installHint).toBe('sudo apt-get install -y fuse3');
    expect(evaluateScratchCapability(facts({ uid: 0, kernelOverlay: false, has: { fusermount: false } })).storages?.disk.problems)
      .toEqual([]);
  });

  it('a /dev/fuse this uid cannot open is undecided while the setuid helper can open it, a problem otherwise', () => {
    const helper = evaluateScratchCapability(facts({ uid: 1000, devFuse: 'denied' }));
    expect(helper.storages?.disk.usable).toBe('unknown');
    expect(helper.summary).toBe('disk-only');
    expect(evaluateScratchCapability(facts({ uid: 1000, devFuse: 'denied', noNewPrivs: true })).storages?.disk.problems)
      .toEqual(['dev-fuse-denied', 'no-new-privs']);
    expect(evaluateScratchCapability(facts({ uid: 1000, devFuse: 'denied', has: { fusermount: false } })).storages?.disk.problems)
      .toEqual(['dev-fuse-denied', 'fusermount-missing']);
  });

  it('NoNewPrivs disarms the setuid helpers: no unprivileged FUSE mount, no setuid-bwrap bypass', () => {
    expect(evaluateScratchCapability(facts({ uid: 1000, noNewPrivs: true })).summary).toBe('none');
    expect(evaluateScratchCapability(facts({ uid: 1000, noNewPrivs: true })).storages?.disk.problems).toEqual(['no-new-privs']);
    expect(evaluateScratchCapability(facts({ uid: 0, noNewPrivs: true })).summary).toBe('all');
    expect(evaluateScratchCapability(facts({ uid: 0, userns: { state: 'blocked' }, bwrapSetuid: true, noNewPrivs: true })).summary).toBe('none');
  });

  it('root without kernel overlay: tmpfs (no FUSE fallback) fails, disk falls back to fuse-overlayfs', () => {
    const ok = evaluateScratchCapability(facts({ kernelOverlay: false }));
    expect(ok.summary).toBe('disk-only');
    expect(ok.storages?.tmpfs.problems).toEqual(['kernel-overlay-missing']);
    const noFuse = evaluateScratchCapability(facts({ kernelOverlay: false, has: { fuseOverlayfs: false } }));
    expect(noFuse.summary).toBe('none');
    expect(noFuse.storages?.disk.problems).toEqual(['fuse-overlayfs-missing']);
  });

  it('BOTMUX_SANDBOX_FUSE=1 makes root depend on FUSE for both storages', () => {
    const cap = evaluateScratchCapability(facts({ forceFuse: true, devFuse: 'denied' }));
    expect(cap.storages?.tmpfs.problems).toEqual(['dev-fuse-denied']);
    expect(cap.storages?.disk.problems).toEqual(['dev-fuse-denied']);
  });

  it('missing bwrap blocks both; root with a package manager is auto-installed by the first session', () => {
    const root = evaluateScratchCapability(facts({ has: { bwrap: false } }));
    expect(root.summary).toBe('none');
    expect(root.autoInstall).toBe(true);
    expect(root.installHint).toBe('apt-get install -y bubblewrap');
    const user = evaluateScratchCapability(facts({ uid: 1000, has: { bwrap: false, fuseOverlayfs: false, packageManager: 'dnf' } }));
    expect(user.autoInstall).toBe(false);
    expect(user.installHint).toBe('sudo dnf install -y bubblewrap fuse-overlayfs');
  });

  it('blocked user namespaces block scratch unless bwrap is setuid; undecidable ones never block', () => {
    expect(evaluateScratchCapability(facts({ uid: 1000, userns: { state: 'blocked' } })).summary).toBe('none');
    expect(evaluateScratchCapability(facts({ uid: 1000, userns: { state: 'blocked' }, bwrapSetuid: true })).summary).toBe('disk-only');
    const unknown = evaluateScratchCapability(facts({ userns: { state: 'unknown', detail: 'apparmor' } }));
    expect(unknown.summary).toBe('unknown');
    expect(unknown.storages?.disk.usable).toBe('unknown');
    expect(unknown.undecided).toEqual(['apparmor']);
  });

  it('macOS depends on sandbox-exec only; other platforms are unsupported', () => {
    expect(evaluateScratchCapability(facts({ platform: 'darwin', has: { sandboxExec: true } })).summary).toBe('all');
    expect(evaluateScratchCapability(facts({ platform: 'darwin' })).problems).toEqual(['sandbox-exec-missing']);
    expect(evaluateScratchCapability(facts({ platform: 'win32' })).problems).toEqual(['unsupported-platform']);
  });
});

describe('gatherScratchFacts', () => {
  const REG_EXEC = 0o100755;
  const fakeHost = (over: {
    uid?: number;
    files?: Record<string, string>;
    bins?: Record<string, number>;
    devFuse?: 'ok' | 'missing' | 'denied';
  } = {}): ScratchProbeIo => ({
    platform: 'linux',
    uid: over.uid ?? 1000,
    env: { PATH: '/usr/local/bin:/usr/bin' },
    readText: p => over.files?.[p],
    statMode: p => over.bins?.[p],
    openReadWrite: () => over.devFuse ?? 'ok',
  });

  it('finds executables on PATH and reads the setuid bit of bwrap', () => {
    const f = gatherScratchFacts(fakeHost({
      bins: { '/usr/bin/bwrap': 0o104755, '/usr/local/bin/fuse-overlayfs': REG_EXEC, '/usr/bin/fusermount3': REG_EXEC, '/usr/bin/apt-get': REG_EXEC },
      files: { '/proc/filesystems': 'nodev\tproc\nnodev\toverlay\n', '/proc/sys/user/max_user_namespaces': '1000\n' },
    }));
    expect(f.has).toMatchObject({ bwrap: true, fuseOverlayfs: true, fusermount: true, packageManager: 'apt-get' });
    expect(f.bwrapSetuid).toBe(true);
    expect(f.kernelOverlay).toBe(true);
    expect(f.userns.state).toBe('ok');
    expect(f.noNewPrivs).toBe(false);
  });

  it('reads NoNewPrivs from /proc/self/status', () => {
    expect(gatherScratchFacts(fakeHost({ files: { '/proc/self/status': 'Name:\tnode\nNoNewPrivs:\t1\nSeccomp:\t0\n' } })).noNewPrivs).toBe(true);
    expect(gatherScratchFacts(fakeHost({ files: { '/proc/self/status': 'NoNewPrivs:\t0\n' } })).noNewPrivs).toBe(false);
  });

  it('a non-executable file or a directory on PATH does not count', () => {
    const f = gatherScratchFacts(fakeHost({ bins: { '/usr/bin/bwrap': 0o100644, '/usr/local/bin/bwrap': 0o040755 } }));
    expect(f.has.bwrap).toBe(false);
  });

  it('user namespace sysctls: max=0 and unprivileged_userns_clone=0 block, AppArmor restriction is undecided', () => {
    const base = { '/proc/sys/user/max_user_namespaces': '1000' };
    expect(gatherScratchFacts(fakeHost({ files: { '/proc/sys/user/max_user_namespaces': '0' } })).userns.state).toBe('blocked');
    expect(gatherScratchFacts(fakeHost({ files: { ...base, '/proc/sys/kernel/unprivileged_userns_clone': '0' } })).userns.state).toBe('blocked');
    expect(gatherScratchFacts(fakeHost({ uid: 0, files: { ...base, '/proc/sys/kernel/unprivileged_userns_clone': '0' } })).userns.state).toBe('ok');
    expect(gatherScratchFacts(fakeHost({ files: { ...base, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' } })).userns.state).toBe('unknown');
    expect(gatherScratchFacts(fakeHost({ files: {} })).userns.state).toBe('unknown');
  });

  it('reports /dev/fuse as opened and an unreadable /proc/filesystems as undecided', () => {
    const f = gatherScratchFacts(fakeHost({ devFuse: 'denied' }));
    expect(f.devFuse).toBe('denied');
    expect(f.kernelOverlay).toBeUndefined();
  });
});

describe('scratchFailureNotice', () => {
  it('only a tmpfs upper lost in a reboot is told to start a new session', () => {
    const advisesNewSession = SCRATCH_FAILURE_REASONS.filter(reason => /新开/.test(scratchFailureNotice({ reason })));
    expect(advisesNewSession).toEqual(['tmpfs-upper-lost']);
  });

  it('carries the host detail and the install command it was given', () => {
    const text = scratchFailureNotice({ reason: 'deps-missing', detail: 'fuse-overlayfs', installHint: 'sudo apt-get install -y fuse-overlayfs' });
    expect(text).toContain('fuse-overlayfs');
    expect(text).toContain('sudo apt-get install -y fuse-overlayfs');
    expect(scratchFailureNotice({ reason: 'stale-mount', detail: '/d/sandboxes/s/root' })).toContain('umount -R /d/sandboxes/s/root');
  });
});
