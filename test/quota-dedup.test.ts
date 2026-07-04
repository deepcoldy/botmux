/**
 * quota-dedup：消息额度扣费去重的 fresh/pending/done 三态机。
 * Run: pnpm vitest run test/quota-dedup.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { beginCharge, commitCharge, abortCharge, _resetForTest } from '../src/services/quota-dedup.js';

beforeEach(() => _resetForTest());

describe('quota-dedup', () => {
  it('first sight → fresh; in-flight redelivery → pending (fail-closed); committed → done', () => {
    expect(beginCharge('a1', 'om_1')).toBe('fresh');
    expect(beginCharge('a1', 'om_1')).toBe('pending');   // 扣费 in-flight，第二投不放行
    commitCharge('a1', 'om_1');
    expect(beginCharge('a1', 'om_1')).toBe('done');       // 成功定论 → 后续重投放行(跳过扣费)
  });

  it('abort after a failed/denied charge lets a redelivery re-evaluate (no fail-open)', () => {
    expect(beginCharge('a1', 'om_2')).toBe('fresh');      // pending
    abortCharge('a1', 'om_2');                            // consume 失败 / 被拒 → 释放
    expect(beginCharge('a1', 'om_2')).toBe('fresh');      // 重投重新判定(NOT done/放行)
    commitCharge('a1', 'om_2');
    expect(beginCharge('a1', 'om_2')).toBe('done');       // 这次成功才定论
  });

  it('a denied id must NOT become done — redelivery re-charges instead of being skipped', () => {
    // 模拟 enforce 对 allow=false 的处理：beginCharge → abortCharge（不 commit）。
    expect(beginCharge('a1', 'om_denied')).toBe('fresh');
    abortCharge('a1', 'om_denied');                       // 被拒：abort，不留 done
    expect(beginCharge('a1', 'om_denied')).toBe('fresh'); // 重投仍需重新扣费判定，不会被放行
  });

  it('keys are scoped per bot', () => {
    expect(beginCharge('a1', 'om_3')).toBe('fresh');
    expect(beginCharge('a2', 'om_3')).toBe('fresh');      // 不同 bot，同 message id
  });

  it('empty messageId is never deduped (always fresh; commit/abort no-op)', () => {
    expect(beginCharge('a1', '')).toBe('fresh');
    expect(beginCharge('a1', '')).toBe('fresh');
    expect(() => { commitCharge('a1', ''); abortCharge('a1', ''); }).not.toThrow();
  });
});
