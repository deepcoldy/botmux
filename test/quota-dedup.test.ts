/**
 * quota-dedup：消息额度扣费去重的 pending/done 状态机。
 * Run: pnpm vitest run test/quota-dedup.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { markChargedOnce, commitCharge, abortCharge, _resetForTest } from '../src/services/quota-dedup.js';

beforeEach(() => _resetForTest());

describe('quota-dedup', () => {
  it('first sight → true (proceed); same id again → false (skip)', () => {
    expect(markChargedOnce('a1', 'om_1')).toBe(true);
    expect(markChargedOnce('a1', 'om_1')).toBe(false);   // pending → skip
    commitCharge('a1', 'om_1');
    expect(markChargedOnce('a1', 'om_1')).toBe(false);   // done → skip
  });

  it('abort after a failed charge lets a redelivery retry (no fail-open)', () => {
    expect(markChargedOnce('a1', 'om_2')).toBe(true);    // pending
    abortCharge('a1', 'om_2');                            // consume failed → release
    expect(markChargedOnce('a1', 'om_2')).toBe(true);    // redelivery re-charges (NOT skipped)
    commitCharge('a1', 'om_2');
    expect(markChargedOnce('a1', 'om_2')).toBe(false);   // now committed → skip
  });

  it('keys are scoped per bot', () => {
    expect(markChargedOnce('a1', 'om_3')).toBe(true);
    expect(markChargedOnce('a2', 'om_3')).toBe(true);    // different bot, same message id
  });

  it('empty messageId is never deduped (always proceed; commit/abort no-op)', () => {
    expect(markChargedOnce('a1', '')).toBe(true);
    expect(markChargedOnce('a1', '')).toBe(true);
    expect(() => { commitCharge('a1', ''); abortCharge('a1', ''); }).not.toThrow();
  });
});
