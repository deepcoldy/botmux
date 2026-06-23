/**
 * Pick a working directory that is guaranteed to exist, for use as the explicit
 * `cwd` of child processes spawned from a long-lived server process.
 *
 * Why this exists: the botmux dashboard pm2 app runs with cwd = the botmux
 * checkout/worktree dir (PKG_ROOT). When that checkout is deleted out from under
 * it (a review worktree gets cleaned up, or an in-place update replaces the
 * dir), the dashboard process keeps running but its cwd becomes a dangling
 * inode. A child spawned with NO explicit cwd inherits that dead cwd, and any
 * tool that calls getcwd()/uv_cwd at startup (npm, node, git, ...) aborts with
 * `ENOENT ... uv_cwd` (npm exits 7). Passing an explicit, known-live cwd makes
 * those spawns immune to the parent's cwd dying.
 *
 * This helper must work even when the CALLER's own cwd is already dead, so it
 * relies solely on os.homedir() / os.tmpdir() (env/syscall based, cwd-free) and
 * existsSync()/statSync() with ABSOLUTE paths (which do not consult the process
 * cwd).
 */
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * First candidate that is an existing directory. Pure/injectable for testing.
 * Candidates must be absolute paths. Always returns something: the final
 * fallback (os.tmpdir()) is assumed to exist on any runnable host.
 */
export function firstExistingDir(candidates: string[]): string {
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      // dead/unreadable candidate — skip it
    }
  }
  return tmpdir();
}

/**
 * A directory guaranteed to exist, safe to use as a child process cwd from a
 * process whose own cwd may have been deleted. Prefers ~/.botmux (created early
 * in every botmux install and never deleted — it is also the bot daemons' own
 * pm2 cwd), then the home dir, then tmpdir.
 */
export function safeCwd(): string {
  return firstExistingDir([join(homedir(), '.botmux'), homedir(), tmpdir()]);
}
