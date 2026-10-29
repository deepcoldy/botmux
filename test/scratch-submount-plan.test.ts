import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assignSubDirs,
  planScratchSubmounts,
  SCRATCH_SUBMOUNT_OVERLAY_LIMIT,
  scratchSubmountOverflowNotice,
} from '../src/adapters/backend/scratch-sandbox.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

/** One /proc/self/mountinfo line (fields per proc(5)). */
function line(id: number, mountpoint: string, fstype: string, source = 'none'): string {
  const encoded = mountpoint.replace(/ /g, '\\040');
  return `${id} 1 0:${id} / ${encoded} rw,relatime shared:${id} - ${fstype} ${source} rw`;
}

function mountinfo(entries: Array<[string, string]>): string {
  return [line(1, '/', 'ext4', '/dev/vda1'), ...entries.map(([mp, type], i) => line(i + 2, mp, type))].join('\n');
}

const points = (entries: { mountpoint: string }[]): string[] => entries.map(e => e.mountpoint);

describe('planScratchSubmounts: botmux\'s own scratch trees are never re-wrapped', () => {
  // A session of another BOTMUX_HOME (or a test/probe dir) left mounted: main
  // overlay, a bind into it, its sub-overlays, a propagated copy under a
  // sub-overlay, and a legacy build's copy of yet another tree inside it.
  const other = '/data00/home-b/.botmux/data/sandboxes/sid-b';
  const probe = '/root/.cache/botmux/session-tmp/p1/k1/probe-scratch-x/data/sandboxes/probe';
  const table = mountinfo([
    ['/data00', 'ext4'],
    ['/var/lib/docker/overlay2/abc/merged', 'overlay'],
    ['/home/u/remote', 'fuse.sshfs'],
    [`${other}/root`, 'overlay'],
    [`${other}/root/data00`, 'overlay'],
    [`${other}/subroots/0/merged`, 'overlay'],
    [`${other}/subroots/1/merged`, 'fuse.fuse-overlayfs'],
    [`${other}/subroots/0/merged/nested`, 'overlay'],
    [`${other}/root${probe}/root`, 'overlay'],
    [`${probe}/root`, 'fuse.fuse-overlayfs'],
    [`${probe}/subroots/3/merged`, 'fuse.fuse-overlayfs'],
    // A user's own chroot farm that merely looks like a tree.
    ['/srv/sandboxes/alpine/root', 'overlay'],
  ]);
  const trees = new Set([other, probe]);

  it('skips every mount inside a scratch tree, whatever data dir it lives in and whatever its fs type', () => {
    const plan = planScratchSubmounts({
      mountinfo: table, infraRoots: ['/root/.botmux/data'], writable: ['/data00/proj'],
      isScratchTree: root => trees.has(root),
    });
    expect(points(plan.overlay)).toEqual([
      '/data00',
      '/home/u/remote',
      '/srv/sandboxes/alpine/root',
      '/var/lib/docker/overlay2/abc/merged',
    ]);
    expect(plan.readOnly).toEqual([]);
    expect(plan.scratchTreeMounts).toBe(8);
  });

  it('decides on the outermost tree first and never probes paths inside one', () => {
    const asked: string[] = [];
    planScratchSubmounts({
      mountinfo: table, infraRoots: [], writable: ['/data00'],
      isScratchTree: root => { asked.push(root); return trees.has(root); },
    });
    // The legacy copy nested under `other` is settled by `other`; the inner
    // root (a path inside its merged view) is never looked at.
    expect(asked).not.toContain(`${other}/root${probe}`);
    expect(new Set(asked)).toEqual(new Set([other, probe, '/srv/sandboxes/alpine']));
  });

  it('keeps the existing exclusions: container-owned prefixes, infra roots, virtual fs types', () => {
    const plan = planScratchSubmounts({
      mountinfo: mountinfo([
        ['/tmp/sbx-life-x/.botmux/data/sandboxes/s/root', 'overlay'],
        ['/run/user/0', 'tmpfs'],
        ['/var/tmp/botmux-scratch/s', 'tmpfs'],
        ['/root/.botmux/data/sandboxes/own/root', 'overlay'],
        ['/snap/core/1', 'squashfs'],
        ['/proc/sys/fs/binfmt_misc', 'binfmt_misc'],
        ['/data01', 'xfs'],
      ]),
      infraRoots: ['/root/.botmux/data', '/var/tmp/botmux-scratch'],
      writable: ['/data01'],
      isScratchTree: () => true,
    });
    expect(points(plan.overlay)).toEqual(['/data01']);
  });
});

describe('planScratchSubmounts: the on-disk tree fingerprint', () => {
  it('recognises a tree by its subroots dir or its marker, not by a look-alike path', () => {
    // Not under tmpdir(): /tmp (CI's TMPDIR) is a prefix scratch never wraps at all.
    const base = realpathSync(mkdtempSync(join(resolve('.'), '.scratch-plan-')));
    try {
      const withSubroots = join(base, 'a', 'sandboxes', 's1');
      const withMarker = join(base, 'b', 'sandboxes', 's2');
      const lookalike = join(base, 'c', 'sandboxes', 'box');
      mkdirSync(join(withSubroots, 'subroots'), { recursive: true });
      mkdirSync(withMarker, { recursive: true });
      writeFileSync(join(withMarker, 'scratch.json'), '{}');
      mkdirSync(join(lookalike, 'root'), { recursive: true });
      // A FILE named subroots is not the layout prepare creates.
      writeFileSync(join(lookalike, 'subroots'), '');
      const plan = planScratchSubmounts({
        mountinfo: mountinfo([
          [`${withSubroots}/root`, 'overlay'],
          [`${withSubroots}/subroots/0/merged`, 'overlay'],
          [`${withMarker}/root`, 'fuse.fuse-overlayfs'],
          [`${lookalike}/root`, 'overlay'],
        ]),
        infraRoots: [], writable: [base],
      });
      expect(points(plan.overlay)).toEqual([`${lookalike}/root`]);
      expect(plan.scratchTreeMounts).toBe(3);
    } finally {
      rmSandboxScratch(base);
    }
  });
});

describe('planScratchSubmounts: the per-session overlay limit', () => {
  const many = Array.from({ length: 10 }, (_, i): [string, string] => [`/data/vol${i}`, 'ext4']);

  it('overlays shallow first up to the limit and reports the rest as read-only', () => {
    const plan = planScratchSubmounts({
      mountinfo: mountinfo([...many, ['/data', 'xfs']]), infraRoots: [], writable: ['/srv/elsewhere'], limit: 4,
      isScratchTree: () => false,
    });
    expect(points(plan.overlay)).toEqual(['/data', '/data/vol0', '/data/vol1', '/data/vol2']);
    expect(points(plan.readOnly)).toEqual([3, 4, 5, 6, 7, 8, 9].map(i => `/data/vol${i}`));
  });

  it('puts the working dir\'s path first: its ancestors and what lies below it', () => {
    const plan = planScratchSubmounts({
      mountinfo: mountinfo([
        ...many,
        ['/data', 'xfs'],
        ['/work/deep/project', 'ext4'],
        ['/work/deep/project/node_modules', 'ext4'],
        ['/work', 'ext4'],
      ]),
      infraRoots: [], writable: ['/work/deep/project'], limit: 4,
      isScratchTree: () => false,
    });
    // The three on the cwd's path, then the shallowest other; mounted
    // parent-before-child, so the result stays shallow first.
    expect(points(plan.overlay)).toEqual(['/data', '/work', '/work/deep/project', '/work/deep/project/node_modules']);
    expect(points(plan.readOnly)).toEqual(Array.from({ length: 10 }, (_, i) => `/data/vol${i}`));
  });

  it('keeps HOME\'s mount copy-on-write even when the working dir holds more mounts than the limit', () => {
    const underCwd = Array.from({ length: 6 }, (_, i): [string, string] => [`/work/proj/vol${i}`, 'ext4']);
    const plan = planScratchSubmounts({
      mountinfo: mountinfo([...underCwd, ['/work', 'ext4'], ['/home', 'ext4'], ['/data', 'xfs']]),
      infraRoots: [], writable: ['/work/proj', '/home/u'], limit: 4,
      isScratchTree: () => false,
    });
    // Mounts holding the working dir or HOME first, then those below them.
    expect(points(plan.overlay)).toEqual(['/home', '/work', '/work/proj/vol0', '/work/proj/vol1']);
    expect(points(plan.readOnly)).toContain('/data');
  });

  it('defaults to SCRATCH_SUBMOUNT_OVERLAY_LIMIT', () => {
    const entries = Array.from({ length: SCRATCH_SUBMOUNT_OVERLAY_LIMIT + 3 }, (_, i): [string, string] => [`/v/${String(i).padStart(4, '0')}`, 'ext4']);
    const plan = planScratchSubmounts({ mountinfo: mountinfo(entries), infraRoots: [], writable: ['/'], isScratchTree: () => false });
    expect(plan.overlay).toHaveLength(SCRATCH_SUBMOUNT_OVERLAY_LIMIT);
    expect(plan.readOnly).toHaveLength(3);
  });

  it('the user notice names the count and lists at most five of the read-only paths', () => {
    const readOnly = Array.from({ length: 7 }, (_, i) => `/data/vol${i}`);
    const notice = scratchSubmountOverflowNotice({ eligible: SCRATCH_SUBMOUNT_OVERLAY_LIMIT + 7, readOnly });
    expect(notice).toContain(String(SCRATCH_SUBMOUNT_OVERLAY_LIMIT + 7));
    for (const p of readOnly.slice(0, 5)) expect(notice).toContain(p);
    expect(notice).not.toContain('/data/vol5');
  });
});

describe('assignSubDirs: a sub-overlay keeps its dir across re-mounts', () => {
  const legacyOrder = () => ['/a', '/b', '/c'];

  it('reuses recorded dirs whatever the current order, and gives new mounts unused ones', () => {
    const dirs = assignSubDirs({
      mountpoints: ['/b', '/a', '/c', '/new'],
      recorded: [{ mountpoint: '/a', dir: '0' }, { mountpoint: '/c', dir: '1' }],
      legacyOrder,
      // `2` holds an upper of a mount that is gone now: never handed to another.
      usedOnDisk: ['0', '1', '2'],
    });
    expect(Object.fromEntries(dirs)).toEqual({ '/a': '0', '/c': '1', '/b': '3', '/new': '4' });
  });

  it('maps a meta written before dirs were recorded by the index the old code used', () => {
    const dirs = assignSubDirs({
      mountpoints: ['/a', '/c'],
      recorded: [{ mountpoint: '/a' }, { mountpoint: '/c' }],
      legacyOrder,
      usedOnDisk: ['0', '1', '2'],
    });
    expect(Object.fromEntries(dirs)).toEqual({ '/a': '0', '/c': '2' });
  });

  it('never hands a reconstructed index that another mount holds to a second overlay', () => {
    const dirs = assignSubDirs({
      mountpoints: ['/a', '/b', '/c'],
      // /c was recorded with dir 1, /b (recorded before dirs were) reconstructs to 1 too.
      recorded: [{ mountpoint: '/c', dir: '1' }, { mountpoint: '/b' }],
      legacyOrder,
      usedOnDisk: ['0', '1'],
    });
    expect(dirs.get('/c')).toBe('1');
    expect(new Set(dirs.values()).size).toBe(3);
    expect(['0', '1']).not.toContain(dirs.get('/b'));
  });

  it('numbers a fresh session from 0', () => {
    const dirs = assignSubDirs({ mountpoints: ['/x', '/y'], recorded: [], legacyOrder, usedOnDisk: [] });
    expect([...dirs.values()]).toEqual(['0', '1']);
  });
});
