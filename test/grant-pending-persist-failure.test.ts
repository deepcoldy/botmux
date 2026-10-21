/**
 * grant-pending 落盘失败时的 fail-closed：已处置的卡在 daemon 重启后不能复活。
 *  - 写失败（ENOSPC 等，用 mock 注入）→ 删掉整个文件兜底，处置照常生效；
 *  - 写和删都失败（目标路径被一个非空目录占住）→ 回滚、拒绝本次处置。
 * Run: pnpm vitest run test/grant-pending-persist-failure.test.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const io = vi.hoisted(() => ({ failWrites: false, failUnlink: false, durable: [] as boolean[] }));
// 只拦 unlink：模拟「写不进、文件也删不掉」时旧内容仍留在盘上（目录占位法会把旧内容一起抹掉）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (io.failUnlink) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return actual.unlinkSync(...args);
    },
  };
});
vi.mock('../src/utils/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      io.durable.push(args[2]?.durable === true);
      if (io.failWrites) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return actual.atomicWriteFileSync(...args);
    },
  };
});

import {
  openPending,
  openPendingMulti,
  markPendingDelivered,
  getPendingMessage,
  checkNonce,
  claimPendingGrant,
  denyPending,
  updatePendingGrantLimits,
  getPendingGrantLimits,
  throttleReason,
  _resetForTest,
  _simulateRestartForTest,
  _filePathForTest,
} from '../src/im/lark/grant-pending.js';

const HOUR = 60 * 60 * 1000;

function deliveredCard(chatId = 'oc_1', target = 'ou_g'): string {
  const nonce = openPending('a1', chatId, target, 3, undefined, HOUR);
  markPendingDelivered('a1', chatId, [target], nonce);
  return nonce;
}

/** 让目标路径既写不进（rename 撞上非空目录）也删不掉（unlink 目录）。 */
function blockFile(): void {
  const path = _filePathForTest('a1');
  rmSync(path, { force: true });
  mkdirSync(path);
  writeFileSync(join(path, 'occupied'), '');
}

beforeEach(() => {
  io.failWrites = false;
  io.failUnlink = false;
  io.durable = [];
  rmSync(_filePathForTest('a1'), { recursive: true, force: true });
  _resetForTest();
});

describe('grant-pending — revocation write fails, file can be removed', () => {
  it('a granted card does not revive after a restart', () => {
    const nonce = deliveredCard();
    io.failWrites = true;
    const claim = claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce);
    expect(claim.ok).toBe(true);
    expect(existsSync(_filePathForTest('a1'))).toBe(false);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });

  it('a denied card does not revive after a restart', () => {
    const nonce = deliveredCard();
    io.failWrites = true;
    expect(denyPending('a1', 'oc_1', ['ou_g'])).toBe(true);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });

  it('staged limits never fall back to the (possibly wider) persisted ones', () => {
    const nonce = openPending('a1', 'oc_1', 'ou_g', undefined, undefined, undefined);
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: null, durationMs: null })).toBe('ok');
    markPendingDelivered('a1', 'oc_1', ['ou_g'], nonce);
    io.failWrites = true;
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: 2, durationMs: HOUR })).toBe('ok');
    _simulateRestartForTest();
    // 磁盘上那份「不限额 / 永久」已随文件删掉，不会在重启后顶替刚收紧的限制
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toBeUndefined();
  });

  it('a failed write while adding a card keeps the existing file (nothing revocable is lost)', () => {
    const kept = deliveredCard('oc_1', 'ou_kept');
    io.failWrites = true;
    const unsent = deliveredCard('oc_2', 'ou_new');
    io.failWrites = false;
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_kept', kept)).toBe(true);
    expect(checkNonce('a1', 'oc_2', 'ou_new', unsent)).toBe(false);
  });
});

describe('grant-pending — revocation can be neither written nor removed', () => {
  it('claim is refused and rolled back (the card stays actionable)', () => {
    const nonce = deliveredCard();
    blockFile();
    const claim = claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce);
    expect(claim).toEqual({ ok: false, reason: 'unsaved' });
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
  });

  it('deny is refused and rolled back', () => {
    const nonce = deliveredCard();
    blockFile();
    expect(denyPending('a1', 'oc_1', ['ou_g'])).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
    expect(throttleReason('a1', 'oc_1', 'ou_g')).toBe('pending');
  });

  it('limit staging is refused and rolled back', () => {
    const nonce = deliveredCard();
    blockFile();
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: null, durationMs: null })).toBe('unsaved');
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: 3, durationMs: HOUR });
  });

  it('an unpersisted (undelivered) card can still be handled — there is nothing on disk to revive', () => {
    blockFile();
    const nonce = openPending('a1', 'oc_1', 'ou_g', 3, undefined, HOUR);
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce).ok).toBe(true);
  });
});

describe('grant-pending — claim', () => {
  it('rejects a stale nonce without touching the card', () => {
    const nonce = deliveredCard();
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], 'wrong')).toEqual({ ok: false, reason: 'stale' });
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
  });

  it('restore puts the card back (and on disk) when every grant failed', () => {
    const nonce = deliveredCard();
    const claim = claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce);
    if (!claim.ok) throw new Error('expected claim');
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
    claim.restore();
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
  });

  it('restore does not overwrite a newer card opened while the grant was in flight', () => {
    const nonce = deliveredCard();
    const claim = claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce);
    if (!claim.ok) throw new Error('expected claim');
    const newer = openPending('a1', 'oc_1', 'ou_g', 3, undefined, HOUR);
    claim.restore();
    expect(checkNonce('a1', 'oc_1', 'ou_g', newer)).toBe(true);
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });
});

describe('grant-pending — durability and leftover revocations', () => {
  it('revocations are fsynced; adding a delivered card is not', () => {
    const nonce = deliveredCard();
    expect(io.durable).toEqual([false]);
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], nonce).ok).toBe(true);
    deliveredCard('oc_2', 'ou_h');
    expect(denyPending('a1', 'oc_2', ['ou_h'])).toBe(true);
    expect(io.durable).toEqual([false, true, false, true]);
  });

  it('denying a target with nothing on disk is a plain write and never refused (only a cooldown is at stake)', () => {
    expect(denyPending('a1', 'oc_9', ['ou_z'])).toBe(true);
    expect(io.durable).toEqual([false]);
    io.failWrites = true;
    expect(denyPending('a1', 'oc_9', ['ou_y'])).toBe(true);
    expect(throttleReason('a1', 'oc_9', 'ou_y')).toBe('denied');
  });

  it('replacing a delivered card when the old one cannot be revoked fences the new card until the disk is fixed', () => {
    const oldNonce = deliveredCard();
    blockFile();
    const newNonce = openPending('a1', 'oc_1', 'ou_g', 3, undefined, HOUR);
    // 新卡还没落盘，但盘上可能还留着旧 nonce：处置新卡也得先把核销落盘
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], newNonce)).toEqual({ ok: false, reason: 'unsaved' });
    expect(denyPending('a1', 'oc_1', ['ou_g'])).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_g', newNonce)).toBe(true);
    // 磁盘恢复后第一次写成功即解除
    rmSync(_filePathForTest('a1'), { recursive: true, force: true });
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], newNonce).ok).toBe(true);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', oldNonce)).toBe(false);
  });

  it('replacing a delivered card when the write fails removes the file, so the old card cannot revive', () => {
    const oldNonce = deliveredCard();
    io.failWrites = true;
    openPendingMulti('a1', 'oc_1', ['ou_g'], 3, undefined, HOUR);
    expect(existsSync(_filePathForTest('a1'))).toBe(false);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', oldNonce)).toBe(false);
  });

  it('a replay payload that cannot be serialized is dropped, the card itself still persists', () => {
    const nonce = openPending('a1', 'oc_1', 'ou_g', 3, { message: { id: 1n } }, HOUR);
    markPendingDelivered('a1', 'oc_1', ['ou_g'], nonce);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
    expect(getPendingMessage('a1', 'oc_1', 'ou_g')).toBeUndefined();
  });
});

describe('grant-pending — the leftover-revocation fence is only lifted by a durable revocation', () => {
  /** 新卡顶掉已落盘的旧卡时，写和删都失败：旧 nonce 原样留在盘上，围栏置位。 */
  function leaveOldNonceOnDisk(): { oldNonce: string; newNonce: string } {
    const oldNonce = deliveredCard();
    io.failWrites = true;
    io.failUnlink = true;
    const newNonce = openPending('a1', 'oc_1', 'ou_g', 3, undefined, HOUR);
    io.failWrites = false;
    io.failUnlink = false;
    return { oldNonce, newNonce };
  }

  it('opening any other card rewrites the file durably, so the old nonce cannot revive after a restart', () => {
    const { oldNonce } = leaveOldNonceOnDisk();
    io.durable = [];
    openPending('a1', 'oc_3', 'ou_x', 3, undefined, HOUR);
    expect(io.durable).toEqual([true]);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', oldNonce)).toBe(false);
  });

  it('a plain (non-fsynced) delivery write does not lift the fence', () => {
    const other = openPending('a1', 'oc_2', 'ou_h', 3, undefined, HOUR);
    const { newNonce } = leaveOldNonceOnDisk();
    markPendingDelivered('a1', 'oc_2', ['ou_h'], other);
    io.durable = [];
    // 送达写没 fsync，掉电后旧文件可能回来：处置新卡时仍要做一次 fsync 过的核销写
    expect(claimPendingGrant('a1', 'oc_1', ['ou_g'], newNonce).ok).toBe(true);
    expect(io.durable).toEqual([true]);
  });
});
