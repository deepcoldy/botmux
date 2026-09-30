/**
 * card-usage-normalize — `botmux send` 读回 daemon /usage 响应的白名单式规范化，
 * 重点是 statusline 配额段 `quota` 的逐字段放行 / 丢弃。
 */
import { describe, expect, it } from 'vitest';
import { normalizeCardUsageQuota, normalizeCardUsageSnapshot } from '../src/cli/card-usage-normalize.js';

describe('normalizeCardUsageSnapshot — quota 白名单', () => {
  it('合法字段原样放行', () => {
    const out = normalizeCardUsageSnapshot({
      context: { usedTokens: 100, windowTokens: 1000, percentUsed: 10 },
      tokens: { in: 1, out: 2 },
      quota: {
        contextPercent: 23,
        contextWindowTokens: 1_000_000,
        fiveHourPercent: 18,
        fiveHourResetsAtMs: 1_788_000_000_000,
        sevenDayPercent: 5,
        sevenDayResetsAtMs: 1_788_086_400_000,
      },
    });
    expect(out).toEqual({
      context: { usedTokens: 100, windowTokens: 1000, percentUsed: 10 },
      tokens: { in: 1, out: 2 },
      quota: {
        contextPercent: 23,
        contextWindowTokens: 1_000_000,
        fiveHourPercent: 18,
        fiveHourResetsAtMs: 1_788_000_000_000,
        sevenDayPercent: 5,
        sevenDayResetsAtMs: 1_788_086_400_000,
      },
    });
  });

  it('>100 / 负数 / NaN / 字符串逐字段丢弃，其它字段保留', () => {
    const out = normalizeCardUsageSnapshot({
      context: null,
      tokens: null,
      quota: {
        contextPercent: 101,             // >100 ⇒ 丢
        fiveHourPercent: -1,             // 负数 ⇒ 丢
        sevenDayPercent: 7,              // 合法
        fiveHourResetsAtMs: Number.NaN,  // NaN ⇒ 丢
        sevenDayResetsAtMs: '123',       // 字符串 ⇒ 丢
        contextWindowTokens: 0,          // 必须 > 0 ⇒ 丢
      },
    });
    expect(out).toEqual({ context: null, tokens: null, quota: { sevenDayPercent: 7 } });
  });

  it('边界：0% 与 100% 合法，resetsAtMs 必须 > 0', () => {
    expect(normalizeCardUsageQuota({ contextPercent: 0, fiveHourPercent: 100, fiveHourResetsAtMs: 0 }))
      .toEqual({ contextPercent: 0, fiveHourPercent: 100 });
  });

  it('没有任何合法字段 ⇒ 不带 quota key（与无 statusline 时逐字节相同）', () => {
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null, quota: { contextPercent: 'x' } }))
      .toEqual({ context: null, tokens: null });
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null, quota: {} }))
      .toEqual({ context: null, tokens: null });
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null, quota: null }))
      .toEqual({ context: null, tokens: null });
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null, quota: [1] }))
      .toEqual({ context: null, tokens: null });
    expect(normalizeCardUsageSnapshot({ context: null, tokens: null }))
      .toEqual({ context: null, tokens: null });
  });

  it('既有 context / tokens 校验行为不变', () => {
    expect(normalizeCardUsageSnapshot({
      context: { usedTokens: -1 },
      tokens: { in: 1, out: 'x' },
    })).toEqual({ context: null, tokens: null });
    expect(normalizeCardUsageSnapshot(null)).toBeNull();
    expect(normalizeCardUsageSnapshot([])).toBeNull();
  });
});
