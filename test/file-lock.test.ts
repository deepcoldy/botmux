/**
 * Unit tests for `withFileLock`. The interesting paths:
 *   1. Happy path: lock acquired, fn runs, lock released.
 *   2. Concurrency (same process): N Promise.all'd calls serialize.
 *   3. Stale-break: a lock left behind by a dead PID old enough to be
 *      considered stale gets broken through a hard-link claim.
 *   4. Breaker recovery: a breaker that crashes after publishing its claim
 *      and owner epoch is taken over by the next append-only epoch.
 *
 * Run:  pnpm vitest run test/file-lock.test.ts
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../src/core/session-marker.js';
import { withFileLock, withFileLockSync } from '../src/utils/file-lock.js';

function staleClaimPathForTest(lockPath: string): string {
  const observed = statSync(lockPath);
  const generation = createHash('sha256')
    .update([
      String(observed.dev),
      String(observed.ino),
      String(observed.birthtimeMs),
    ].join('\0'))
    .digest('hex')
    .slice(0, 24);
  return join(dirname(lockPath), `.botmux-stale-claim-${generation}`);
}

describe('withFileLock', () => {
  let target: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-file-lock-'));
    target = join(dir, 'data.json');
    writeFileSync(target, '{}', 'utf-8');
  });

  it('runs fn and releases the lock', async () => {
    const result = await withFileLock(target, async () => 'ok');
    expect(result).toBe('ok');
    expect(existsSync(target + '.lock')).toBe(false);
  });

  it('binds a newly-written Linux holder to the current boot', async () => {
    const bootId = readLinuxBootIdentity();
    if (!bootId) return;
    await withFileLock(target, async () => {
      const payload = JSON.parse(readFileSync(target + '.lock', 'utf8')) as { bootId?: string };
      expect(payload.bootId).toBe(bootId);
    });
  });

  it('runs sync fn and releases the lock', () => {
    const result = withFileLockSync(target, () => 'ok-sync');
    expect(result).toBe('ok-sync');
    expect(existsSync(target + '.lock')).toBe(false);
  });

  it('propagates an async callback EEXIST exactly once', async () => {
    const callbackError = Object.assign(new Error('callback EEXIST'), { code: 'EEXIST' });
    let calls = 0;

    await expect(withFileLock(target, async () => {
      calls++;
      throw callbackError;
    })).rejects.toBe(callbackError);

    expect(calls).toBe(1);
    expect(existsSync(target + '.lock')).toBe(false);
  });

  it('propagates a sync callback EEXIST exactly once', () => {
    const callbackError = Object.assign(new Error('callback EEXIST'), { code: 'EEXIST' });
    let calls = 0;
    let caught: unknown;
    try {
      withFileLockSync(target, () => {
        calls++;
        throw callbackError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(callbackError);
    expect(calls).toBe(1);
    expect(existsSync(target + '.lock')).toBe(false);
  });

  it('serializes concurrent same-process callers (no interleave inside fn)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const work = (id: number) => withFileLock(target, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return id;
    });
    const results = await Promise.all([work(1), work(2), work(3), work(4), work(5)]);
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(1); // strict mutual exclusion
  });

  it('breaks a stale lock left by a dead PID and recovers', async () => {
    // Plant a lock with an invented dead PID. PID 99999999 is virtually
    // guaranteed not to be a live process; isPidAlive will return false.
    // mtime is set to "old enough" implicitly by writing now then sleeping
    // briefly to clear MIN_STALE_AGE_MS.
    writeFileSync(target + '.lock', '99999999', 'utf-8');
    await new Promise(r => setTimeout(r, 200)); // exceed MIN_STALE_AGE_MS (100ms)

    const result = await withFileLock(target, async () => 'recovered');

    expect(result).toBe('recovered');
    expect(existsSync(target + '.lock')).toBe(false);
  });

  it('recovers an old empty lock left by a crash before the holder PID write', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '', 'utf-8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    await expect(withFileLock(target, async () => 'recovered-empty')).resolves.toBe('recovered-empty');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('recovers an old invalid sync lock left before a valid holder PID write', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, 'not-a-pid', 'utf-8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    expect(withFileLockSync(target, () => 'recovered-invalid')).toBe('recovered-invalid');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks a stale identity-bound lock after its PID was reused', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, procStart: 'stale-process-birth' }), 'utf-8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    await expect(withFileLock(target, async () => 'recovered-reused-pid')).resolves.toBe('recovered-reused-pid');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks an async holder from a previous Linux boot despite PID/start reuse', async () => {
    const bootId = readLinuxBootIdentity();
    const procStart = readProcessStartIdentity(process.pid);
    if (!bootId || !procStart) return;
    const mismatchedBootId = `${bootId[0] === '0' ? '1' : '0'}${bootId.slice(1)}`;
    const lockPath = target + '.lock';
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      procStart,
      bootId: mismatchedBootId,
    }), 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    await expect(withFileLock(target, async () => 'previous-boot', { minStaleAgeMs: 0 }))
      .resolves.toBe('previous-boot');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks a sync holder from a previous Linux boot despite PID/start reuse', () => {
    const bootId = readLinuxBootIdentity();
    const procStart = readProcessStartIdentity(process.pid);
    if (!bootId || !procStart) return;
    const mismatchedBootId = `${bootId[0] === '0' ? '1' : '0'}${bootId.slice(1)}`;
    const lockPath = target + '.lock';
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      procStart,
      bootId: mismatchedBootId,
    }), 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);

    expect(withFileLockSync(target, () => 'previous-boot-sync', { minStaleAgeMs: 0 }))
      .toBe('previous-boot-sync');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('recovers asynchronously after a stale-break owner crashes before unlink', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const claimPath = staleClaimPathForTest(lockPath);
    linkSync(lockPath, claimPath);
    const owner0 = `${claimPath}.owner-000000000000`;
    writeFileSync(owner0, '99999998', 'utf8');
    utimesSync(owner0, old, old);

    await expect(withFileLock(target, async () => 'replayed', { minStaleAgeMs: 0 }))
      .resolves.toBe('replayed');

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect(readdirSync(dirname(claimPath)).some(name => name.startsWith(`${basename(claimPath)}.owner-`)))
      .toBe(false);
  });

  it('elects one stale breaker while concurrent waiters remain serialized', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withFileLock(target, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
        return index;
      }, { minStaleAgeMs: 0 })));

    expect(results.sort((left, right) => left - right)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(maxInFlight).toBe(1);
  });

  it('recovers synchronously after a stale-break owner crashes before unlink', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const claimPath = staleClaimPathForTest(lockPath);
    linkSync(lockPath, claimPath);
    const owner0 = `${claimPath}.owner-000000000000`;
    writeFileSync(owner0, '99999998', 'utf8');
    utimesSync(owner0, old, old);

    expect(withFileLockSync(target, () => 'replayed-sync', { minStaleAgeMs: 0 }))
      .toBe('replayed-sync');

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });

  it('cleans an async mismatched claim without unlinking its live inode', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const claimPath = staleClaimPathForTest(lockPath);
    const newerInode = target + '.newer-lock-inode';
    writeFileSync(newerInode, 'live-new-inode', 'utf8');
    linkSync(newerInode, claimPath);
    const owner0 = `${claimPath}.owner-000000000000`;
    writeFileSync(owner0, '99999998', 'utf8');
    utimesSync(owner0, old, old);

    await expect(withFileLock(target, async () => 'mismatch-recovered', { minStaleAgeMs: 0 }))
      .resolves.toBe('mismatch-recovered');

    expect(readFileSync(newerInode, 'utf8')).toBe('live-new-inode');
    expect(existsSync(claimPath)).toBe(false);
  });

  it('cleans a sync mismatched claim without unlinking its live inode', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const claimPath = staleClaimPathForTest(lockPath);
    const newerInode = target + '.newer-lock-inode';
    writeFileSync(newerInode, 'live-new-inode', 'utf8');
    linkSync(newerInode, claimPath);
    const owner0 = `${claimPath}.owner-000000000000`;
    writeFileSync(owner0, '99999998', 'utf8');
    utimesSync(owner0, old, old);

    expect(withFileLockSync(target, () => 'mismatch-recovered-sync', { minStaleAgeMs: 0 }))
      .toBe('mismatch-recovered-sync');

    expect(readFileSync(newerInode, 'utf8')).toBe('live-new-inode');
    expect(existsSync(claimPath)).toBe(false);
  });

  it('is not wedged by a fixed legacy stale-claim hard link', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    linkSync(lockPath, `${lockPath}.stale-claim`);

    await expect(withFileLock(target, async () => 'legacy-recovered', { minStaleAgeMs: 0 }))
      .resolves.toBe('legacy-recovered');
    expect(existsSync(lockPath)).toBe(false);
    // The old generation is no longer a synchronization primitive. Leaving
    // its inode in place is safer than racing a still-running old binary.
    expect(lstatSync(`${lockPath}.stale-claim`).isFile()).toBe(true);
  });

  it('does not break a lock held by a live PID', async () => {
    // Plant a lock that claims to be held by the current process. isPidAlive
    // will return true → the stale-break branch refuses to fire. Acquisition
    // should time out instead of stealing the lock.
    writeFileSync(target + '.lock', String(process.pid), 'utf-8');

    let threw: Error | null = null;
    try {
      // The behavior under test (refuse to steal a live lock, then time out)
      // is independent of the timeout length, so use a short maxWaitMs instead
      // of waiting the full 5s default — keeps this from being the slowest
      // unit-test in the suite.
      await withFileLock(target, async () => 'unreachable', { maxWaitMs: 500 });
    } catch (e: any) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(threw?.message).toMatch(/file-lock timeout/);
    // The lock file is still there — we never claimed it (rightly, since
    // a live holder may still be working).
    expect(existsSync(target + '.lock')).toBe(true);
  }, 10_000);
});
