import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mountsAtOrUnder } from '../../src/adapters/backend/sandbox.js';

/**
 * Take a test mount off the mount table; returns whether nothing is mounted at
 * or below `target` any more — read from mountinfo, exactly what the sandbox
 * removal guards look at.
 *
 * A plain unmount can be refused while something still holds the filesystem
 * (busy); the same call a moment later succeeds. So, like the production
 * unmountAny, fall back to a lazy detach (FUSE: `fusermount -u -z`, kernel
 * mounts: `umount -l`), which takes the mount off the table at once whatever
 * still holds it.
 */
export function detachTestMount(target: string): boolean {
  const attempts: Array<[string, string[]]> = [
    ['umount', [target]],
    ['fusermount', ['-u', target]],
    ['fusermount', ['-u', '-z', target]],
    ['umount', ['-l', target]],
  ];
  const refusals: string[] = [];
  for (const [command, args] of attempts) {
    if (mountsAtOrUnder(target)?.length === 0) return true;
    const run = spawnSync(command, args, { encoding: 'utf8' });
    refusals.push(`${command} ${args.slice(0, -1).join(' ')}: ${run.error?.message ?? (run.stderr.trim() || `exit ${run.status}`)}`);
  }
  if (mountsAtOrUnder(target)?.length === 0) return true;
  console.warn(`[test mount] ${target} is still mounted: ${refusals.join('; ')}`);
  return false;
}

/** Processes whose argv names `target`: a FUSE server (fuse-overlayfs takes its
 *  mountpoint as an argument), which the orphan sweep reads as "a live process
 *  holds this tree" (liveSandboxSids). */
function mountServerPids(target: string): number[] {
  let pids: string[];
  try { pids = readdirSync('/proc').filter(pid => /^\d+$/.test(pid)); } catch { return []; }
  return pids.filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(target); } catch { return false; }
  }).map(Number);
}

/**
 * Wait until no process names `target` in its argv. A FUSE server exits only
 * once its filesystem is gone: asynchronously after the unmount returns, and
 * for a lazily detached one only after the last holder lets go. Until then the
 * orphan sweep keeps the tree. Returns false if it is still there at the
 * deadline (0 = just look).
 */
function awaitMountServerExit(target: string, timeoutMs = 10_000): boolean {
  const deadline = Date.now() + timeoutMs;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const pids = mountServerPids(target);
    if (pids.length === 0) return true;
    if (Date.now() >= deadline) {
      if (timeoutMs > 0) console.warn(`[test mount] ${target}: server still running (pid ${pids.join(', ')})`);
      return false;
    }
    Atomics.wait(tick, 0, 0, 10);
  }
}

/** Unmount for good: off the table, and no server for it left running. */
export function unmountTestMount(target: string, timeoutMs?: number): boolean {
  return detachTestMount(target) && awaitMountServerExit(target, timeoutMs);
}
