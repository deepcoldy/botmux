/**
 * Unit tests for `withFileLock`. The interesting paths:
 *   1. Happy path: lock acquired, fn runs, lock released.
 *   2. Concurrency (same process): N Promise.all'd calls serialize.
 *   3. Stale-break: a lock left behind by a dead PID old enough to be
 *      considered stale gets broken via atomic rename — exactly one waiter
 *      wins, others retry. We can't easily simulate two processes within
 *      vitest, but we CAN verify the rename-based path doesn't break in the
 *      single-waiter case (regression coverage for Codex r2 #2).
 *
 * Run:  pnpm vitest run test/file-lock.test.ts
 */
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { withFileLock } from '../src/utils/file-lock.js';

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
