/**
 * Cross-process advisory lock for a single file. Used to serialize
 * read-modify-write of shared JSON config (e.g. `bots.json` from multiple
 * daemon processes + the dashboard).
 *
 * Acquisition: atomic `open(path + '.lock', 'wx')`. The filesystem makes
 * O_CREAT|O_EXCL atomic, so exactly one waiter wins.
 *
 * Stale-break: a holder that crashes mid-section leaves the lock file
 * behind with its dead PID. To reclaim it we use the atomic POSIX
 * `rename(lock, lock.stale-<random>)`: rename succeeds for exactly ONE
 * caller (the source has to exist), so only ONE waiter is the rightful
 * stale-breaker. Everyone else gets ENOENT and loops back to acquire.
 * This avoids the classic "two waiters both unlink, one deletes the other's
 * just-acquired live lock" race that read+unlink-based schemes have.
 *
 * Not reentrant. Don't nest `withFileLock` calls on the same path within
 * the same process — the inner call would wait MAX_WAIT_MS and then time
 * out. (We could allow reentrancy via PID-equal check, but our callers
 * don't need it and the equality check would re-open the stale-break race.)
 */
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

const MAX_WAIT_MS = 5_000;
const RETRY_BASE_MS = 25;
// Minimum age before we'll consider stale-breaking a lock with a dead PID.
// Prevents racing on freshly-acquired locks where the holder might not have
// finished writing its PID file yet.
const MIN_STALE_AGE_MS = 100;

async function isPidAlive(pid: number): Promise<boolean> {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing (default MAX_WAIT_MS). */
  maxWaitMs?: number;
  /** Min lock age before a dead-PID lock is stale-breakable (default MIN_STALE_AGE_MS). */
  minStaleAgeMs?: number;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const minStaleAgeMs = opts.minStaleAgeMs ?? MIN_STALE_AGE_MS;
  const lockPath = targetPath + '.lock';
  const start = Date.now();
  while (true) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      try {
        return await fn();
      } finally {
        try { await fsp.unlink(lockPath); } catch { /* already gone, tolerate */ }
      }
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;

      // EEXIST: someone holds the lock. Check whether it's stale (dead PID
      // + old enough). If so, attempt an atomic rename — POSIX guarantees
      // exactly one caller succeeds.
      let holder = 0;
      let lockAgeMs = Infinity;
      try {
        const [raw, stat] = await Promise.all([
          fsp.readFile(lockPath, 'utf-8'),
          fsp.stat(lockPath),
        ]);
        holder = parseInt(raw, 10) || 0;
        lockAgeMs = Date.now() - stat.mtimeMs;
      } catch (re: any) {
        if (re.code === 'ENOENT') continue; // released between EEXIST and read
        throw re;
      }

      const breakable = holder
        && lockAgeMs >= minStaleAgeMs
        && !(await isPidAlive(holder));
      if (breakable) {
        // Atomic rename: only ONE caller wins. The winner is responsible
        // for cleaning up the stale carcass; losers get ENOENT and retry
        // the lock acquisition on the next iteration.
        const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          await fsp.rename(lockPath, stalePath);
          logger.warn(`[file-lock] broke stale lock at ${lockPath} (dead pid ${holder}, age ${lockAgeMs}ms)`);
          try { await fsp.unlink(stalePath); } catch { /* tolerate */ }
          continue;
        } catch (renameErr: any) {
          if (renameErr.code === 'ENOENT') continue; // another waiter beat us
          throw renameErr;
        }
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `file-lock timeout waiting for ${lockPath} ` +
          `(held by pid ${holder || '?'}, age ${Math.round(lockAgeMs)}ms)`,
        );
      }
      await new Promise(r => setTimeout(r, RETRY_BASE_MS + Math.random() * RETRY_BASE_MS));
    }
  }
}
