/**
 * grant-pending：nonce 防重放 + deny 冷却节流。
 * Run: pnpm vitest run test/grant-pending.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openPending, checkNonce, clearPending, markDenied, isThrottled, _resetForTest, _tableSizeForTest } from '../src/im/lark/grant-pending.js';

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

    it('a still-fresh pending is NOT reclaimed by the sweep', () => {
      const n = openPending('a1', 'oc_1', 'ou_g');
      vi.advanceTimersByTime(2 * 60 * 1000); // 2 min — well within STALE_PENDING_MS
      openPending('a1', 'oc_2', 'ou_h');     // triggers a sweep
      expect(isThrottled('a1', 'oc_1', 'ou_g')).toBe(true); // still throttled
      expect(checkNonce('a1', 'oc_1', 'ou_g', n)).toBe(true); // nonce still valid
    });
  });
});
