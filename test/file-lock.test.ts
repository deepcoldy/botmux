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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../src/core/session-marker.js';
import {
  __testOnly_setFileLockHooks,
  withFileLock,
  withFileLockSync,
} from '../src/utils/file-lock.js';

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

function plantStaleClaimOwner(
  target: string,
  ownerPayload: string,
): { lockPath: string; claimPath: string; ownerPath: string; old: Date } {
  const lockPath = target + '.lock';
  writeFileSync(lockPath, '99999999', 'utf8');
  const old = new Date(Date.now() - 5_000);
  utimesSync(lockPath, old, old);
  const claimPath = staleClaimPathForTest(lockPath);
  linkSync(lockPath, claimPath);
  const ownerPath = `${claimPath}.owner-000000000000`;
  writeFileSync(ownerPath, ownerPayload, 'utf8');
  utimesSync(ownerPath, old, old);
  return { lockPath, claimPath, ownerPath, old };
}

describe('withFileLock', () => {
  let target: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-file-lock-'));
    target = join(dir, 'data.json');
    writeFileSync(target, '{}', 'utf-8');
  });

  afterEach(() => {
    __testOnly_setFileLockHooks();
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

  it('does not sleep before timing out a sync zero-wait lock attempt', () => {
    writeFileSync(target + '.lock', String(process.pid), 'utf8');
    let nowMs = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_view, _index, _value, timeout) => {
      nowMs += Number(timeout ?? 0);
      return 'timed-out';
    });

    try {
      expect(() => withFileLockSync(target, () => 'unreachable', { maxWaitMs: 0 }))
        .toThrow(/file-lock timeout/);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      now.mockRestore();
    }
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

  it('retries when an async owner pathname is cleaned after the first pinned stat', async () => {
    const { lockPath, claimPath, ownerPath } = plantStaleClaimOwner(target, '99999998');
    let cleaned = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStat: path => {
        if (path !== ownerPath || cleaned) return;
        cleaned = true;
        unlinkSync(lockPath);
        unlinkSync(claimPath);
        unlinkSync(ownerPath);
      },
    });

    await expect(withFileLock(target, async () => 'lost-race-retried', { minStaleAgeMs: 0 }))
      .resolves.toBe('lost-race-retried');
    expect(cleaned).toBe(true);
  });

  it('retries when a sync owner pathname is cleaned after the first pinned stat', () => {
    const { lockPath, claimPath, ownerPath } = plantStaleClaimOwner(target, '99999998');
    let cleaned = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStatSync: path => {
        if (path !== ownerPath || cleaned) return;
        cleaned = true;
        unlinkSync(lockPath);
        unlinkSync(claimPath);
        unlinkSync(ownerPath);
      },
    });

    expect(withFileLockSync(target, () => 'lost-race-retried-sync', { minStaleAgeMs: 0 }))
      .toBe('lost-race-retried-sync');
    expect(cleaned).toBe(true);
  });

  it('retries an async owner observed while its empty payload is being published', async () => {
    const { ownerPath, old } = plantStaleClaimOwner(target, '');
    let published = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStat: path => {
        if (path !== ownerPath || published) return;
        published = true;
        writeFileSync(ownerPath, '99999998', 'utf8');
        utimesSync(ownerPath, old, old);
      },
    });

    await expect(withFileLock(target, async () => 'partial-owner-retried', { minStaleAgeMs: 0 }))
      .resolves.toBe('partial-owner-retried');
    expect(published).toBe(true);
  });

  it('retries a sync owner observed while its empty payload is being published', () => {
    const { ownerPath, old } = plantStaleClaimOwner(target, '');
    let published = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStatSync: path => {
        if (path !== ownerPath || published) return;
        published = true;
        writeFileSync(ownerPath, '99999998', 'utf8');
        utimesSync(ownerPath, old, old);
      },
    });

    expect(withFileLockSync(target, () => 'partial-owner-retried-sync', { minStaleAgeMs: 0 }))
      .toBe('partial-owner-retried-sync');
    expect(published).toBe(true);
  });

  it('publishes a complete async owner payload before making its pathname visible', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    let ownerAtPublish: { visible: boolean; payload?: string } | undefined;
    __testOnly_setFileLockHooks({
      beforeStaleClaimOwnerPublish: ownerPath => {
        const visible = existsSync(ownerPath);
        ownerAtPublish = {
          visible,
          ...(visible ? { payload: readFileSync(ownerPath, 'utf8') } : {}),
        };
      },
    });

    await expect(withFileLock(target, async () => 'atomically-published', { minStaleAgeMs: 0 }))
      .resolves.toBe('atomically-published');
    expect(ownerAtPublish).toEqual({ visible: false });
  });

  it('publishes a complete sync owner payload before making its pathname visible', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    let ownerAtPublish: { visible: boolean; payload?: string } | undefined;
    __testOnly_setFileLockHooks({
      beforeStaleClaimOwnerPublishSync: ownerPath => {
        const visible = existsSync(ownerPath);
        ownerAtPublish = {
          visible,
          ...(visible ? { payload: readFileSync(ownerPath, 'utf8') } : {}),
        };
      },
    });

    expect(withFileLockSync(target, () => 'atomically-published-sync', { minStaleAgeMs: 0 }))
      .toBe('atomically-published-sync');
    expect(ownerAtPublish).toEqual({ visible: false });
  });

  it('cleans an orphaned owner publication candidate after stale recovery', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const claimPath = staleClaimPathForTest(lockPath);
    const orphanCandidate =
      `${claimPath}.owner-000000000000.candidate-99999998-550e8400-e29b-41d4-a716-446655440000`;
    writeFileSync(orphanCandidate, '99999998', 'utf8');

    await expect(withFileLock(target, async () => 'candidate-cleaned', { minStaleAgeMs: 0 }))
      .resolves.toBe('candidate-cleaned');
    expect(existsSync(orphanCandidate)).toBe(false);
  });

  it('does not let an async stale waiter unlink a replacement public lock inode', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    let replacement: ReturnType<typeof lstatSync> | undefined;
    let callbackCalls = 0;
    __testOnly_setFileLockHooks({
      beforeStalePublicLockUnlink: path => {
        if (replacement) return;
        unlinkSync(path);
        writeFileSync(path, String(process.pid), 'utf8');
        replacement = lstatSync(path);
      },
    });

    await expect(withFileLock(target, async () => {
      callbackCalls++;
      return 'stolen';
    }, { minStaleAgeMs: 0, maxWaitMs: 150 })).rejects.toThrow(/file-lock timeout/);
    expect(callbackCalls).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(lstatSync(lockPath).ino).toBe(replacement?.ino);
  });

  it('does not let a sync stale waiter unlink a replacement public lock inode', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    let replacement: ReturnType<typeof lstatSync> | undefined;
    let callbackCalls = 0;
    __testOnly_setFileLockHooks({
      beforeStalePublicLockUnlinkSync: path => {
        if (replacement) return;
        unlinkSync(path);
        writeFileSync(path, String(process.pid), 'utf8');
        replacement = lstatSync(path);
      },
    });

    expect(() => withFileLockSync(target, () => {
      callbackCalls++;
      return 'stolen-sync';
    }, { minStaleAgeMs: 0, maxWaitMs: 150 })).toThrow(/file-lock timeout/);
    expect(callbackCalls).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(lstatSync(lockPath).ino).toBe(replacement?.ino);
  });

  it('does not steal an async lock that publishes a live holder before stale unlink', async () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const staleInode = lstatSync(lockPath).ino;
    let published = false;
    let callbackCalls = 0;
    __testOnly_setFileLockHooks({
      beforeStalePublicLockUnlink: path => {
        if (published) return;
        published = true;
        writeFileSync(path, String(process.pid), 'utf8');
      },
    });

    await expect(withFileLock(target, async () => {
      callbackCalls++;
      return 'stolen';
    }, { minStaleAgeMs: 0, maxWaitMs: 150 })).rejects.toThrow(/file-lock timeout/);
    expect(callbackCalls).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(lstatSync(lockPath).ino).toBe(staleInode);
  });

  it('does not steal a sync lock that publishes a live holder before stale unlink', () => {
    const lockPath = target + '.lock';
    writeFileSync(lockPath, '99999999', 'utf8');
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    const staleInode = lstatSync(lockPath).ino;
    let published = false;
    let callbackCalls = 0;
    __testOnly_setFileLockHooks({
      beforeStalePublicLockUnlinkSync: path => {
        if (published) return;
        published = true;
        writeFileSync(path, String(process.pid), 'utf8');
      },
    });

    expect(() => withFileLockSync(target, () => {
      callbackCalls++;
      return 'stolen-sync';
    }, { minStaleAgeMs: 0, maxWaitMs: 150 })).toThrow(/file-lock timeout/);
    expect(callbackCalls).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(lstatSync(lockPath).ino).toBe(staleInode);
  });

  // A same-length in-flight rewrite of the owner payload is caught via mtime
  // moving off the planted age. We deliberately do NOT restore mtime here:
  // relying on ctime to advance is not portable (ext4's ms-resolution ctime
  // frequently does not tick within a same-size+same-mtime rewrite, so that
  // assertion was ~64% flaky on Linux). mtime advancing off `old` is a
  // deterministic, cross-platform signal for the untrusted fail-closed path.
  it('fails closed when async owner content is rewritten in flight', async () => {
    const { ownerPath } = plantStaleClaimOwner(target, '99999998');
    let changed = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStat: path => {
        if (path !== ownerPath || changed) return;
        changed = true;
        writeFileSync(ownerPath, '99999997', 'utf8');
      },
    });

    await expect(withFileLock(target, async () => 'unreachable', { minStaleAgeMs: 0 }))
      .rejects.toThrow('file-lock stale-claim owner changed while reading');
    expect(changed).toBe(true);
  });

  it('fails closed when sync owner content is rewritten in flight', () => {
    const { ownerPath } = plantStaleClaimOwner(target, '99999998');
    let changed = false;
    __testOnly_setFileLockHooks({
      afterPinnedHolderFirstStatSync: path => {
        if (path !== ownerPath || changed) return;
        changed = true;
        writeFileSync(ownerPath, '99999997', 'utf8');
      },
    });

    expect(() => withFileLockSync(target, () => 'unreachable-sync', { minStaleAgeMs: 0 }))
      .toThrow('file-lock stale-claim owner changed while reading');
    expect(changed).toBe(true);
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
