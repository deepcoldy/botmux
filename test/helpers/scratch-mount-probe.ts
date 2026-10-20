/**
 * Can THIS host run a Linux scratch session's host-side setup?
 *
 * Exercises the exact primitives prepareScratchSandbox needs before it ever
 * looks at the CLI argv: bwrap on PATH, the full-root overlay for the given
 * storage (root: tmpfs slot + kernel overlay, or a disk upper with the kernel
 * overlay and the fuse-overlayfs fallback; unprivileged: fuse-overlayfs), and a
 * COW write into a working dir under /tmp through the merged view (its own
 * spawn-time probe). Root without CAP_SYS_ADMIN and without usable FUSE (a
 * restricted container), or unprivileged fuse-overlayfs that cannot recreate
 * root-owned ancestors in the upper, fail here — scratch cannot start there.
 *
 * Same layout as a session (mount infra and working dir are siblings): a
 * working dir whose own entries include the FUSE mountpoint makes
 * fuse-overlayfs look itself up and hang.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmSandboxScratch } from './rm-sandbox-scratch.js';

function unmount(mountPoint: string): void {
  if (spawnSync('umount', [mountPoint], { stdio: 'ignore' }).status !== 0) {
    spawnSync('fusermount', ['-u', mountPoint], { stdio: 'ignore' });
  }
}

export function scratchMountRuntimeAvailable(storage: 'tmpfs' | 'disk'): boolean {
  if (process.platform !== 'linux') return false;
  if (spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status !== 0) return false;
  const isRoot = process.getuid?.() === 0;
  if (storage === 'tmpfs' && !isRoot) return false; // a tmpfs slot needs root
  const root = mkdtempSync('/tmp/scratch-probe-');
  const slot = join(root, 'infra', 'slot');
  const merged = join(root, 'infra', 'merged');
  const work = join(root, 'work');
  const mounted: string[] = [];
  try {
    for (const d of [slot, merged, work]) mkdirSync(d, { recursive: true });
    if (storage === 'tmpfs') {
      if (spawnSync('mount', ['-t', 'tmpfs', '-o', 'mode=700', 'tmpfs', slot], { stdio: 'ignore' }).status !== 0) return false;
      mounted.unshift(slot);
    }
    const upper = join(slot, 'upper');
    const overlayWork = join(slot, 'work');
    for (const d of [upper, overlayWork]) mkdirSync(d, { recursive: true });
    const options = `lowerdir=/,upperdir=${upper},workdir=${overlayWork}`;
    const kernel = isRoot
      && spawnSync('mount', ['-t', 'overlay', 'overlay', '-o', options, merged], { stdio: 'ignore' }).status === 0;
    // Same fallback as the product: a disk upper may be refused by the kernel
    // overlay (upper below lower=/); fuse-overlayfs serves it.
    const overlayMounted = kernel || ((!isRoot || storage === 'disk')
      && spawnSync('fuse-overlayfs', ['-o', options, merged], { stdio: 'ignore' }).status === 0);
    if (!overlayMounted) return false;
    mounted.unshift(merged);
    const cowProbe = join(merged, work, 'cow-probe');
    writeFileSync(cowProbe, 'x');
    const copiedUpOnly = readFileSync(cowProbe, 'utf8') === 'x' && !existsSync(join(work, 'cow-probe'));
    rmSync(cowProbe, { force: true });
    return copiedUpOnly;
  } catch {
    return false;
  } finally {
    for (const mp of mounted) unmount(mp);
    // Refuses (and reports) while anything is still mounted below: never
    // delete through a lowerdir=/ overlay.
    rmSandboxScratch(root);
  }
}
