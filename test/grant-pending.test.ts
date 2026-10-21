/**
 * grant-pending：nonce 防重放 + deny 冷却节流。
 * Run: pnpm vitest run test/grant-pending.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  openPending,
  openPendingMulti,
  checkNonce,
  clearPending,
  getPendingGrantLimits,
  getPendingMessage,
  markDenied,
  markPendingDelivered,
  isThrottled,
  throttleReason,
  updatePendingGrantLimits,
  tryReserveOwnerDmSlot,
  releaseOwnerDmSlot,
  OWNER_DM_MAX_PER_WINDOW,
  _resetForTest,
  _simulateRestartForTest,
  _tableSizeForTest,
  _filePathForTest,
  _ownerDmKeyCountForTest,
} from '../src/im/lark/grant-pending.js';

beforeEach(() => { _resetForTest(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('grant-pending', () => {
  it('openPending issues nonce, throttles repeats, checkNonce validates', () => {
    const n = openPending('a1', 'oc_1', 'ou_g');
    expect(typeof n).toBe('string');
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(true);
    expect(checkNonce('a1', 'oc_1', 'ou_g', n)).toBe(true);
    expect(checkNonce('a1', 'oc_1', 'ou_g', 'wrong')).toBe(false);
  });

  it('no entry → not throttled, nonce invalid', () => {
    expect(isThrottled('a1', 'oc_x', 'ou_g')).toBe(false);
    expect(checkNonce('a1', 'oc_x', 'ou_g', 'whatever')).toBe(false);
  });

  it('defaults to one hour + three messages and stages both limits under the nonce', () => {
    const nonce = openPending('a1', 'oc_1', 'ou_g');
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({
      quota: 3,
      durationMs: 60 * 60 * 1000,
    });
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: 10, durationMs: 8 * 60 * 60 * 1000 })).toBe('ok');
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({
      quota: 10,
      durationMs: 8 * 60 * 60 * 1000,
    });
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: null, durationMs: null })).toBe('ok');
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: undefined, durationMs: undefined });
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], 'wrong', { quota: 20 })).toBe('stale');
  });

  it('clearPending lifts throttle', () => {
    openPending('a1', 'oc_1', 'ou_g');
    clearPending('a1', 'oc_1', 'ou_g');
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
  });

  it('markDenied invalidates nonce and keeps 10min cooldown', () => {
    const n = openPending('a1', 'oc_1', 'ou_g');
    markDenied('a1', 'oc_1', 'ou_g');
    expect(checkNonce('a1', 'oc_1', 'ou_g', n)).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(true);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
  });

  it('keys are isolated per bot/chat/target', () => {
    openPending('a1', 'oc_1', 'ou_g');
    expect(isThrottled('a1', 'oc_1', 'ou_other')).toBe(false);
    expect(isThrottled('a2', 'oc_1', 'ou_g')).toBe(false);
    expect(isThrottled('a1', 'oc_2', 'ou_g')).toBe(false);
  });

  // ─── 内存回收（防止 denied/废弃 pending 永久占位）────────────────────────
  describe('eviction (no unbounded growth)', () => {
    it('isThrottled deletes a denied entry once its cooldown passes (immediate reclaim)', () => {
      markDenied('a1', 'oc_1', 'ou_x');
      expect(_tableSizeForTest()).toBe(1);
      vi.advanceTimersByTime(10 * 60 * 1000 + 1); // past DENY_COOLDOWN_MS
      expect(isThrottled('a1', 'oc_1', 'ou_x')).toBe(false); // cooldown over…
      expect(_tableSizeForTest()).toBe(0);                    // …and the entry is gone
    });

    it('a flood of denied users does not grow the table without bound', () => {
      // 1000 distinct unauthorized users get denied across the cooldown window.
      for (let i = 0; i < 1000; i++) markDenied('a1', 'oc_1', `ou_${i}`);
      expect(_tableSizeForTest()).toBe(1000);
      // Cooldown elapses; the next write triggers the periodic sweep (>1min gap).
      vi.advanceTimersByTime(11 * 60 * 1000);
      markDenied('a1', 'oc_1', 'ou_new'); // triggers pruneStale → reclaims the 1000 stale ones
      expect(_tableSizeForTest()).toBe(1); // only the fresh denial remains
    });

    it('the periodic sweep reclaims abandoned pending cards (owner never clicked)', () => {
      openPending('a1', 'oc_1', 'ou_g');
      expect(_tableSizeForTest()).toBe(1);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1); // past STALE_PENDING_MS
      openPending('a1', 'oc_2', 'ou_h'); // a new card → triggers the sweep
      // The abandoned pending was reclaimed; only the fresh one remains.
      expect(_tableSizeForTest()).toBe(1);
      expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
    });

    it('isThrottled reclaims a stale pending on its own key (no cross-key sweep needed)', () => {
      openPending('a1', 'oc_1', 'ou_g');
      expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(true); // fresh → throttled
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1); // past STALE_PENDING_MS
      // No other openPending/markDenied fired, so the periodic full-table sweep never ran.
      // isThrottled itself must reclaim the abandoned pending — otherwise a lone repeat
      // sender (or a card whose send failed) stays silently throttled until daemon restart.
      expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
      expect(_tableSizeForTest()).toBe(0);
    });

    it('a still-fresh pending is NOT reclaimed by the sweep', () => {
      const n = openPending('a1', 'oc_1', 'ou_g');
      vi.advanceTimersByTime(2 * 60 * 1000); // 2 min — well within STALE_PENDING_MS
      openPending('a1', 'oc_2', 'ou_h');     // triggers a sweep
      expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(true); // still throttled
      expect(checkNonce('a1', 'oc_1', 'ou_g', n)).toBe(true); // nonce still valid
    });
  });
});

describe('grant-pending — owner DM request-card cap', () => {
  it('allows up to the cap per (bot, owner) within the window, then refuses', () => {
    for (let i = 0; i < OWNER_DM_MAX_PER_WINDOW; i++) {
      expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(true);
    }
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(false);
    // 别的 owner / 别的 bot 各自独立计数
    expect(tryReserveOwnerDmSlot('a1', 'ou_other_owner')).toBe(true);
    expect(tryReserveOwnerDmSlot('a2', 'ou_owner')).toBe(true);
  });

  it('slots free up once the window slides past', () => {
    for (let i = 0; i < OWNER_DM_MAX_PER_WINDOW; i++) tryReserveOwnerDmSlot('a1', 'ou_owner');
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(true);
  });

  it('releaseOwnerDmSlot hands back the slot of a failed send', () => {
    const t0 = Date.now();
    for (let i = 0; i < OWNER_DM_MAX_PER_WINDOW; i++) tryReserveOwnerDmSlot('a1', 'ou_owner', t0 + i);
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(false);
    releaseOwnerDmSlot('a1', 'ou_owner', t0 + 3);
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(true);
    // 未记过的时间戳 / 别的 owner：不产生副作用
    releaseOwnerDmSlot('a1', 'ou_owner', t0 - 1);
    releaseOwnerDmSlot('a1', 'ou_nobody', t0);
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(false);
  });

  it('periodic prune drops owner DM counters once their window has passed', () => {
    tryReserveOwnerDmSlot('a1', 'ou_owner');
    expect(_ownerDmKeyCountForTest()).toBe(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    openPending('a1', 'oc_1', 'ou_g'); // 触发 pruneStale
    expect(_ownerDmKeyCountForTest()).toBe(0);
  });

  it('_resetForTest clears the owner DM counters', () => {
    for (let i = 0; i < OWNER_DM_MAX_PER_WINDOW; i++) tryReserveOwnerDmSlot('a1', 'ou_owner');
    _resetForTest();
    expect(tryReserveOwnerDmSlot('a1', 'ou_owner')).toBe(true);
  });
});

// ─── 落盘：daemon 重启后旧授权卡仍可用 ─────────────────────────────────────────
describe('grant-pending — survives daemon restart', () => {
  const HOUR = 60 * 60 * 1000;
  const msg = { message: { message_id: 'om_trigger', chat_id: 'oc_1', content: '{"text":"@bot 帮我看下"}' }, sender: { sender_id: { open_id: 'ou_g' } } };

  function deliveredCard(appId = 'a1', chatId = 'oc_1', target = 'ou_g', messageData: any = msg): string {
    const nonce = openPending(appId, chatId, target, 3, messageData, HOUR);
    markPendingDelivered(appId, chatId, [target], nonce);
    return nonce;
  }

  function writeRaw(appId: string, body: unknown): void {
    writeFileSync(_filePathForTest(appId), typeof body === 'string' ? body : JSON.stringify(body));
  }

  it('a delivered card keeps its nonce, staged limits and replay message across a restart', () => {
    const nonce = deliveredCard();
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: 3, durationMs: HOUR });
    expect(getPendingMessage('a1', 'oc_1', 'ou_g')).toEqual(msg);
    expect(throttleReason('a1', 'oc_1', 'ou_g')).toBe('pending');
  });

  it('a card that was never confirmed delivered is not persisted (no 24h phantom throttle)', () => {
    const nonce = openPending('a1', 'oc_1', 'ou_g', 3, msg, HOUR);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
  });

  it('a multi-target /grant card survives as one card', () => {
    const nonce = openPendingMulti('a1', 'oc_1', ['ou_a', 'ou_b'], 5, undefined, 24 * HOUR);
    markPendingDelivered('a1', 'oc_1', ['ou_a', 'ou_b'], nonce);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_a', nonce)).toBe(true);
    expect(checkNonce('a1', 'oc_1', 'ou_b', nonce)).toBe(true);
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_b')).toEqual({ quota: 5, durationMs: 24 * HOUR });
    expect(getPendingMessage('a1', 'oc_1', 'ou_a')).toBeUndefined();
  });

  it('limits staged after delivery are persisted (including clearing to unlimited / permanent)', () => {
    const nonce = deliveredCard();
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: 10, durationMs: 8 * HOUR })).toBe('ok');
    _simulateRestartForTest();
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: 10, durationMs: 8 * HOUR });
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: null, durationMs: null })).toBe('ok');
    _simulateRestartForTest();
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: undefined, durationMs: undefined });
  });

  it('limits staged before the delivery ack lands are persisted once it does', () => {
    const nonce = openPending('a1', 'oc_1', 'ou_g', 3, msg, HOUR);
    expect(updatePendingGrantLimits('a1', 'oc_1', ['ou_g'], nonce, { quota: 7 })).toBe('ok');
    markPendingDelivered('a1', 'oc_1', ['ou_g'], nonce);
    _simulateRestartForTest();
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_g')).toEqual({ quota: 7, durationMs: HOUR });
  });

  it('a granted (cleared) card stays dead after a restart', () => {
    const nonce = deliveredCard();
    clearPending('a1', 'oc_1', 'ou_g');
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
  });

  it('a denied card stays dead and the deny cooldown survives a restart', () => {
    const nonce = deliveredCard();
    markDenied('a1', 'oc_1', 'ou_g');
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
    expect(throttleReason('a1', 'oc_1', 'ou_g')).toBe('denied');
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    _simulateRestartForTest();
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
  });

  it('re-opening a card retires the persisted old nonce even before the new card is delivered', () => {
    const oldNonce = deliveredCard();
    const newNonce = openPending('a1', 'oc_1', 'ou_g', 3, msg, HOUR);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', oldNonce)).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_g', newNonce)).toBe(false);
  });

  it('a late delivery ack for a superseded or already-handled card resurrects nothing', () => {
    const superseded = openPending('a1', 'oc_1', 'ou_g', 3, msg, HOUR);
    const current = openPending('a1', 'oc_1', 'ou_g', 3, msg, HOUR);
    markPendingDelivered('a1', 'oc_1', ['ou_g'], superseded);
    const handled = openPending('a1', 'oc_2', 'ou_h', 3, msg, HOUR);
    clearPending('a1', 'oc_2', 'ou_h');
    markPendingDelivered('a1', 'oc_2', ['ou_h'], handled);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', current)).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(false);
    expect(checkNonce('a1', 'oc_2', 'ou_h', handled)).toBe(false);
  });

  it('expired entries are dropped on load (abandoned pending past 24h)', () => {
    const nonce = deliveredCard();
    vi.advanceTimersByTime(24 * HOUR + 1);
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(false);
    expect(_tableSizeForTest()).toBe(0);
  });

  it('keeps one file per bot and writes it 0600 (it carries message content)', () => {
    const n1 = deliveredCard('a1');
    const n2 = deliveredCard('a2');
    expect(_filePathForTest('a1')).not.toBe(_filePathForTest('a2'));
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', n1)).toBe(true);
    expect(checkNonce('a2', 'oc_1', 'ou_g', n2)).toBe(true);
    expect(checkNonce('a1', 'oc_1', 'ou_g', n2)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(_filePathForTest('a1')).mode & 0o777).toBe(0o600);
    }
  });

  it('an app id cannot escape the data dir through the file name', () => {
    expect(dirname(_filePathForTest('../../etc/x'))).toBe(dirname(_filePathForTest('a1')));
  });

  it('drops malformed entries instead of widening them (bad limits never become unlimited)', () => {
    const now = Date.now();
    writeRaw('a1', {
      version: 1,
      entries: {
        'oc_1:ou_ok': { state: 'pending', nonce: 'n_ok', ts: now, quota: 5, durationMs: HOUR },
        'oc_1:ou_neg_quota': { state: 'pending', nonce: 'n1', ts: now, quota: -1 },
        'oc_1:ou_str_quota': { state: 'pending', nonce: 'n2', ts: now, quota: '5' },
        'oc_1:ou_bad_duration': { state: 'pending', nonce: 'n3', ts: now, durationMs: 0 },
        'oc_1:ou_no_nonce': { state: 'pending', ts: now },
        'oc_1:ou_bad_state': { state: 'granted', nonce: 'n4', ts: now },
        'oc_1:ou_bad_ts': { state: 'denied', ts: 'yesterday' },
        'oc_1:ou_bad_msg': { state: 'pending', nonce: 'n5', ts: now, messageData: 'not-an-event' },
      },
    });
    expect(checkNonce('a1', 'oc_1', 'ou_ok', 'n_ok')).toBe(true);
    expect(getPendingGrantLimits('a1', 'oc_1', 'ou_ok')).toEqual({ quota: 5, durationMs: HOUR });
    expect(checkNonce('a1', 'oc_1', 'ou_neg_quota', 'n1')).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_str_quota', 'n2')).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_bad_duration', 'n3')).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_no_nonce')).toBe(false);
    expect(checkNonce('a1', 'oc_1', 'ou_bad_state', 'n4')).toBe(false);
    expect(isThrottled('a1', 'oc_1', 'ou_bad_ts')).toBe(false);
    // 重放载荷坏了只是不重放，卡片照样能点
    expect(checkNonce('a1', 'oc_1', 'ou_bad_msg', 'n5')).toBe(true);
    expect(getPendingMessage('a1', 'oc_1', 'ou_bad_msg')).toBeUndefined();
  });

  it('a corrupt file is quarantined and treated as empty (old cards expire, nobody is let in)', () => {
    writeRaw('a1', '{not json');
    expect(checkNonce('a1', 'oc_1', 'ou_g', 'whatever')).toBe(false);
    const dir = dirname(_filePathForTest('a1'));
    expect(readdirSync(dir).some(n => n.startsWith('grant-pending-a1.json.corrupt-'))).toBe(true);
    // 隔离后照常工作，新卡能落盘
    const nonce = deliveredCard();
    _simulateRestartForTest();
    expect(checkNonce('a1', 'oc_1', 'ou_g', nonce)).toBe(true);
  });

  it('ignores a file written by an unknown future version', () => {
    writeRaw('a1', { version: 2, entries: { 'oc_1:ou_g': { state: 'pending', nonce: 'n', ts: Date.now() } } });
    expect(checkNonce('a1', 'oc_1', 'ou_g', 'n')).toBe(false);
  });

  it('_resetForTest also wipes the persisted files', () => {
    deliveredCard();
    expect(existsSync(_filePathForTest('a1'))).toBe(true);
    _resetForTest();
    expect(existsSync(_filePathForTest('a1'))).toBe(false);
  });

  it('the persisted file does not contain undelivered cards', () => {
    deliveredCard('a1', 'oc_1', 'ou_sent');
    openPending('a1', 'oc_1', 'ou_unsent', 3, msg, HOUR);
    markDenied('a1', 'oc_1', 'ou_denied');
    const persisted = JSON.parse(readFileSync(_filePathForTest('a1'), 'utf-8'));
    expect(Object.keys(persisted.entries).sort()).toEqual(['oc_1:ou_denied', 'oc_1:ou_sent']);
  });
});
