/**
 * Removing a per-session sandbox tree must never recurse into a mount.
 *
 * A recursive rm does not stop at filesystem boundaries. A Linux scratch tree
 * that is still mounted holds the full-root COW view of the whole host at
 * `<tree>/root`, so a blind removal walks every host file and fills the upper
 * with whiteouts. Only the scratch teardown (unmount first) may remove a
 * scratch tree; every other removal path skips a tree with a mount at or below
 * it.
 *
 * Uses REAL mounts: a tmpfs as root, fuse-overlayfs over a tiny lower dir
 * otherwise (no privilege needed). Skips when neither is available.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachCredentialOnlyRelayOutbox,
  attachSandboxOutbox,
  mountsAtOrUnder,
  prepareCredentialOnlyRelayOutbox,
  sweepOrphanSandboxes,
  teardownDirectSandboxSession,
} from '../src/adapters/backend/sandbox.js';
import { isMountpoint, sweepOrphanScratchSandboxes, teardownScratchSession } from '../src/adapters/backend/scratch-sandbox.js';
import { teardownSessionSandboxTree } from '../src/adapters/backend/sandbox-tree-teardown.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

const isRoot = process.getuid?.() === 0;

function unmount(target: string): void {
  if (!isMountpoint(target)) return;
  if (spawnSync('umount', [target], { stdio: 'ignore' }).status === 0) return;
  spawnSync('fusermount', ['-u', target], { stdio: 'ignore' });
}

/** Mount a small writable filesystem at `target`; null when impossible here. */
function mountSmallFs(target: string, scratch: string): boolean {
  mkdirSync(target, { recursive: true });
  if (isRoot) {
    return spawnSync('mount', ['-t', 'tmpfs', '-o', 'mode=700,size=1m', 'tmpfs', target], { stdio: 'ignore' }).status === 0;
  }
  const lower = join(scratch, 'lower');
  const upper = join(scratch, 'upper');
  const work = join(scratch, 'work');
  for (const d of [lower, upper, work]) mkdirSync(d, { recursive: true });
  return spawnSync('fuse-overlayfs', ['-o', `lowerdir=${lower},upperdir=${upper},workdir=${work}`, target], { stdio: 'ignore' }).status === 0;
}

const mountsAvailable = process.platform === 'linux' && (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-mount-probe-'));
  try {
    const target = join(dir, 'm');
    const ok = mountSmallFs(target, join(dir, 'fs'));
    if (ok) unmount(target);
    return ok && !isMountpoint(target);
  } catch {
    return false;
  } finally {
    rmSandboxScratch(dir);
  }
})();

/** A session tree under a fresh data dir, old enough for the orphan sweep. */
function sessionTree(sessionId = 'sid-mounted') {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-mount-guard-')));
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  mkdirSync(join(sessionRoot, 'outbox'), { recursive: true });
  const age = () => {
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(sessionRoot, old, old);
  };
  return { dataDir, sessionId, sessionRoot, age };
}

describe.skipIf(!mountsAvailable)('sandbox tree removal never recurses into a mount', () => {
  it('reports mounts at or below a tree, deepest first', () => {
    const tree = sessionTree();
    const target = join(tree.sessionRoot, 'root');
    try {
      expect(mountsAtOrUnder(tree.sessionRoot)).toEqual([]);
      expect(mountSmallFs(target, join(tree.dataDir, 'fs'))).toBe(true);
      expect(mountsAtOrUnder(tree.sessionRoot)).toEqual([target]);
      expect(mountsAtOrUnder(target)).toEqual([target]);
      // A sibling with the same prefix is not "below".
      expect(mountsAtOrUnder(`${tree.sessionRoot}-other`)).toEqual([]);
    } finally {
      unmount(target);
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('the generic orphan sweep skips a mounted tree and leaves the mount untouched', () => {
    const tree = sessionTree();
    const target = join(tree.sessionRoot, 'root');
    try {
      expect(mountSmallFs(target, join(tree.dataDir, 'fs'))).toBe(true);
      writeFileSync(join(target, 'canary'), 'kept');
      tree.age();
      sweepOrphanSandboxes(tree.dataDir, new Set());
      expect(isMountpoint(target)).toBe(true);
      expect(readFileSync(join(target, 'canary'), 'utf8')).toBe('kept');
      expect(existsSync(tree.sessionRoot)).toBe(true);
      // Once nothing is mounted any more, the same sweep reclaims it.
      unmount(target);
      tree.age();
      sweepOrphanSandboxes(tree.dataDir, new Set());
      expect(existsSync(tree.sessionRoot)).toBe(false);
    } finally {
      unmount(target);
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('every direct-tree removal path refuses a tree with a mount below it', () => {
    const tree = sessionTree();
    const target = join(tree.sessionRoot, 'root');
    try {
      expect(mountSmallFs(target, join(tree.dataDir, 'fs'))).toBe(true);
      writeFileSync(join(target, 'canary'), 'kept');
      attachSandboxOutbox({ sessionId: tree.sessionId, dataDir: tree.dataDir })!.cleanup();
      teardownDirectSandboxSession(tree.sessionId, tree.dataDir);
      // The credential-only relay reuses the same per-session root (e.g. after a
      // flip from scratch): its cleanup is guarded the same way.
      prepareCredentialOnlyRelayOutbox({ sessionId: tree.sessionId, dataDir: tree.dataDir })!.cleanup();
      attachCredentialOnlyRelayOutbox({ sessionId: tree.sessionId, dataDir: tree.dataDir })!.cleanup();
      expect(readFileSync(join(target, 'canary'), 'utf8')).toBe('kept');
      expect(existsSync(join(tree.sessionRoot, 'outbox'))).toBe(true);
    } finally {
      unmount(target);
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('the scratch teardown unmounts first and never removes through a mount it could not take down', () => {
    const tree = sessionTree();
    const merged = join(tree.sessionRoot, 'root');
    const stray = join(tree.sessionRoot, 'outbox');
    try {
      writeFileSync(join(tree.sessionRoot, 'scratch.json'), JSON.stringify({ v: 1, sid: tree.sessionId, storage: 'disk', merged }));
      expect(mountSmallFs(merged, join(tree.dataDir, 'fs-merged'))).toBe(true);
      // A mount the scratch layout does not know about (not under the merged
      // root, not a subroot): teardown cannot unmount it, so it must not rm.
      expect(mountSmallFs(stray, join(tree.dataDir, 'fs-stray'))).toBe(true);
      writeFileSync(join(stray, 'canary'), 'kept');
      teardownScratchSession(tree.sessionId, tree.dataDir);
      expect(isMountpoint(merged)).toBe(false);
      expect(readFileSync(join(stray, 'canary'), 'utf8')).toBe('kept');
      expect(existsSync(tree.sessionRoot)).toBe(true);
      unmount(stray);
      teardownScratchSession(tree.sessionId, tree.dataDir);
      expect(existsSync(tree.sessionRoot)).toBe(false);
    } finally {
      unmount(stray);
      unmount(merged);
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('the worker-less close teardown routes a scratch tree through unmount-first', () => {
    const tree = sessionTree();
    const merged = join(tree.sessionRoot, 'root');
    try {
      writeFileSync(join(tree.sessionRoot, 'scratch.json'), JSON.stringify({ v: 1, sid: tree.sessionId, storage: 'disk', merged }));
      expect(mountSmallFs(merged, join(tree.dataDir, 'fs'))).toBe(true);
      writeFileSync(join(merged, 'canary'), 'x');
      teardownSessionSandboxTree(tree.sessionId, tree.dataDir);
      expect(isMountpoint(merged)).toBe(false);
      expect(existsSync(tree.sessionRoot)).toBe(false);
    } finally {
      unmount(merged);
      rmSandboxScratch(tree.dataDir);
    }
  });
});

// A scratch.json truncated by a crash mid-write (older builds wrote it in
// place) still marks a scratch tree: the generic sweep skips it, so the scratch
// sweep must reclaim it — from the default layout, unmount first — once the
// lifecycle guards pass, and still never remove through a mount it cannot take
// down. The slot pass is pointed at an empty dir: the real one is host-wide.
describe.skipIf(!mountsAvailable)('scratch sweep with a truncated marker', () => {
  const truncatedTree = () => {
    const tree = sessionTree(`sid-truncated-${randomBytes(4).toString('hex')}`);
    writeFileSync(join(tree.sessionRoot, 'scratch.json'), '{"v":1,"sid":"sid-trunc');
    const slotRoot = join(tree.dataDir, 'no-slots');
    mkdirSync(slotRoot);
    return { ...tree, slotRoot };
  };

  // Root only: an unprivileged (fuse-overlayfs) mount has a daemon whose argv
  // names the tree, so the sweep's live-process guard keeps it regardless.
  it.skipIf(!isRoot)('reclaims it once inactive and old enough: unmounts the default merged root, then removes', () => {
    const tree = truncatedTree();
    const merged = join(tree.sessionRoot, 'root');
    try {
      expect(mountSmallFs(merged, join(tree.dataDir, 'fs'))).toBe(true);
      writeFileSync(join(merged, 'canary'), 'x');
      tree.age();
      // Guards first: an active session keeps everything.
      sweepOrphanScratchSandboxes(tree.dataDir, new Set([tree.sessionId]), { slotRoot: tree.slotRoot });
      expect(isMountpoint(merged)).toBe(true);
      expect(existsSync(tree.sessionRoot)).toBe(true);
      sweepOrphanScratchSandboxes(tree.dataDir, new Set(), { slotRoot: tree.slotRoot });
      expect(isMountpoint(merged)).toBe(false);
      expect(existsSync(tree.sessionRoot)).toBe(false);
    } finally {
      unmount(merged);
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('keeps it while a mount below it cannot be taken down', () => {
    const tree = truncatedTree();
    const stray = join(tree.sessionRoot, 'outbox');
    try {
      expect(mountSmallFs(stray, join(tree.dataDir, 'fs'))).toBe(true);
      writeFileSync(join(stray, 'canary'), 'kept');
      tree.age();
      sweepOrphanScratchSandboxes(tree.dataDir, new Set(), { slotRoot: tree.slotRoot });
      expect(readFileSync(join(stray, 'canary'), 'utf8')).toBe('kept');
      expect(existsSync(join(tree.sessionRoot, 'scratch.json'))).toBe(true);
    } finally {
      unmount(stray);
      rmSandboxScratch(tree.dataDir);
    }
  });
});

describe.skipIf(!mountsAvailable)('test cleanup never deletes through a mount', () => {
  it('rmSandboxScratch keeps (and reports) a dir with a mount below it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-mount-cleanup-')));
    const target = join(dir, 'nested', 'mounted');
    try {
      expect(mountSmallFs(target, join(dir, 'fs'))).toBe(true);
      writeFileSync(join(target, 'canary'), 'kept');
      rmSandboxScratch(dir);
      expect(readFileSync(join(target, 'canary'), 'utf8')).toBe('kept');
      expect(existsSync(dir)).toBe(true);
    } finally {
      unmount(target);
      rmSandboxScratch(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });
});

describe('no bare recursive removal in the sandbox modules', () => {
  // 源码结构护栏(K1+K3)：模块级禁令——沙盒模块里任何递归 rmSync 只能出现在 removeTreeUnlessMounted 内部。
  // 上面的真实挂载用例只覆盖现有删除路径，新加一条裸 rmSync 它们照样绿；而一次删进仍挂载的 scratch
  // 全根 COW 视图就会遍历整台宿主（实测 Bun 的 rmSync 会删进挂载点，16f093ec7f，#2040）。
  it('every recursive rmSync goes through removeTreeUnlessMounted', () => {
    for (const file of ['sandbox.ts', 'scratch-sandbox.ts', 'scratch-sandbox-darwin.ts', 'sandbox-tree-teardown.ts']) {
      const source = readFileSync(new URL(`../src/adapters/backend/${file}`, import.meta.url), 'utf8');
      const recursive = [...source.matchAll(/rmSync\([^)]*recursive: true/g)];
      if (file !== 'sandbox.ts') {
        expect(recursive, file).toEqual([]);
        continue;
      }
      expect(recursive).toHaveLength(1);
      const helperAt = source.indexOf('export function removeTreeUnlessMounted(');
      const helperEnd = source.indexOf('\n}\n', helperAt);
      expect(recursive[0]!.index!).toBeGreaterThan(helperAt);
      expect(recursive[0]!.index!).toBeLessThan(helperEnd);
    }
  });
});

describe('scratch trees belong to the scratch sweeps', () => {
  it('the generic orphan sweep leaves a scratch-marked tree alone even with nothing mounted', () => {
    if (process.platform !== 'linux') return;
    const tree = sessionTree('sid-scratch');
    try {
      writeFileSync(join(tree.sessionRoot, 'scratch.json'), '{}');
      tree.age();
      sweepOrphanSandboxes(tree.dataDir, new Set());
      expect(existsSync(tree.sessionRoot)).toBe(true);
    } finally {
      rmSandboxScratch(tree.dataDir);
    }
  });

  it('the worker-less close teardown removes a plain (oncall / credential-only) tree', () => {
    if (process.platform !== 'linux') return;
    const tree = sessionTree('sid-direct');
    try {
      teardownSessionSandboxTree(tree.sessionId, tree.dataDir);
      expect(existsSync(tree.sessionRoot)).toBe(false);
      // Path-shaped ids are never joined into a removal target.
      teardownSessionSandboxTree('../escape', tree.dataDir);
    } finally {
      rmSandboxScratch(tree.dataDir);
    }
  });
});
