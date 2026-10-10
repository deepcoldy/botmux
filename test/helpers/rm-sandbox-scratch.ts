/**
 * Delete a scratch tree that contains bwrap DENY-MASK sources.
 *
 * WHY THIS EXISTS: the sandbox (and the tests that mirror it) chmods every mask
 * source to `0o000` — emptiness is the guarantee, but the mode is what makes a
 * mask unlistable for a non-root uid. A `0o000` DIRECTORY cannot be traversed,
 * and `rm -r` must traverse to unlink what is inside, so a plain
 * `rmSync(root, { recursive: true, force: true })` throws
 * `EACCES: permission denied, rm '<scratch>'`. `force: true` does NOT help: it
 * suppresses ENOENT, not EACCES.
 *
 * MEASURED — why it hid for so long: as root the delete succeeds, because
 * CAP_DAC_OVERRIDE bypasses the DAC check. It fails only for a normal uid, which
 * is exactly what a GitHub runner is. For a normal uid the two runtimes differ on
 * an EMPTY mask dir, which is the shape these suites actually build:
 *   empty 0o000 dir     → Node deletes it (rmdir needs no traversal); Bun EACCES
 *   non-empty 0o000 dir → both EACCES (each must traverse before it can unlink)
 * So today's CI symptom is Bun-specific, but the hazard is not: the moment a mask
 * dir holds an entry, Node throws too. Hence a runtime-agnostic "reopen, then
 * delete" — this is a cleanup bug, NOT a runtime difference, and it must NOT be
 * "fixed" with a bun-only skip.
 *
 * It surfaces as a failing UNNAMED afterEach/afterAll hook while every real case
 * is green — a shape that reads like the suite is broken when only teardown is.
 *
 * Restoring traversal (0o700) on the way out is safe: the tree is a mkdtemp
 * scratch dir being deleted in the same breath, so no mask outlives this call.
 */
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function rmSandboxScratch(root: string | undefined | null): void {
  if (!root) return;
  // Depth-first, chmod-then-descend: a 0o000 dir is unreadable until it is
  // chmod'ed, so the restore has to happen BEFORE readdir, not after.
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    try { chmodSync(dir, 0o700); } catch { /* already gone, or not ours */ }
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      // lstat, never stat: a symlink must not walk us out of the scratch tree.
      try { if (lstatSync(full).isDirectory()) stack.push(full); } catch { /* vanished */ }
    }
  }
  rmSync(root, { recursive: true, force: true });
}
