/**
 * grant-pending：nonce 防重放 + deny 冷却节流。
 * Run: pnpm vitest run test/grant-pending.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openPending, checkNonce, clearPending, markDenied, isThrottled, getPendingReplay, _resetForTest } from '../src/im/lark/grant-pending.js';

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

  it('stores replay only while pending', () => {
    const replay = {
      data: { message: { message_id: 'om_1', content: '{"text":"hi"}' } },
      ctx: {
        chatId: 'oc_1',
        messageId: 'om_1',
        chatType: 'group' as const,
        scope: 'thread' as const,
        anchor: 'om_1',
        larkAppId: 'a1',
        ownsSession: false,
      },
    };
    openPending('a1', 'oc_1', 'ou_g', undefined, replay);
    expect(getPendingReplay('a1', 'oc_1', 'ou_g')).toBe(replay);
    clearPending('a1', 'oc_1', 'ou_g');
    expect(getPendingReplay('a1', 'oc_1', 'ou_g')).toBeUndefined();
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
});
