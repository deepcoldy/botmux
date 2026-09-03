/**
 * Model pricing tests — 内置价格表 sanity、宽松解析、模型名匹配与金额估算。
 *
 * Run:  pnpm vitest run test/model-pricing.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_MODEL_PRICES,
  DEFAULT_USD_CNY,
  estimateCostCny,
  normalizeModelId,
  normalizePricingOverrides,
  resolveModelPrice,
  type PricingOverrides,
  type TokenUsagePricingInput,
} from '../src/services/model-pricing.js';

function usage(overrides: Partial<TokenUsagePricingInput> = {}): TokenUsagePricingInput {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    model: 'claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

describe('BUILT_IN_MODEL_PRICES', () => {
  it('every entry has positive input/output and non-negative cache prices', () => {
    expect(Object.keys(BUILT_IN_MODEL_PRICES).length).toBeGreaterThan(0);
    for (const [key, price] of Object.entries(BUILT_IN_MODEL_PRICES)) {
      expect(Number.isFinite(price.input) && price.input > 0, `${key}.input`).toBe(true);
      expect(Number.isFinite(price.output) && price.output > 0, `${key}.output`).toBe(true);
      if (price.cacheRead !== undefined) {
        expect(Number.isFinite(price.cacheRead) && price.cacheRead >= 0, `${key}.cacheRead`).toBe(true);
      }
      if (price.cacheWrite !== undefined) {
        expect(Number.isFinite(price.cacheWrite) && price.cacheWrite >= 0, `${key}.cacheWrite`).toBe(true);
      }
    }
  });

  it('defaults the USD→CNY rate to a finite positive number', () => {
    expect(DEFAULT_USD_CNY).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_USD_CNY)).toBe(true);
  });
});

describe('normalizePricingOverrides', () => {
  it('passes through a valid block', () => {
    expect(normalizePricingOverrides({
      usdCny: 7.5,
      models: { 'my-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } },
    })).toEqual({
      usdCny: 7.5,
      models: { 'my-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } },
    });
  });

  // Tuple-wrapped rows: a bare `[]` row spreads to zero arguments, so a callback with a
  // declared parameter reads as wanting a `done` callback and `bun test` hangs until the
  // timeout. See the note in test/bun-test-shim.ts under KNOWN BUN DEFECTS.
  it.each([[null], [undefined], ['string'], [42], [true], [[]]])('returns undefined for non-object input %j', (raw) => {
    expect(normalizePricingOverrides(raw)).toBeUndefined();
  });

  it('returns undefined when no field is valid', () => {
    expect(normalizePricingOverrides({})).toBeUndefined();
    expect(normalizePricingOverrides({ usdCny: -1 })).toBeUndefined();
    expect(normalizePricingOverrides({ usdCny: NaN })).toBeUndefined();
    expect(normalizePricingOverrides({ usdCny: '7.2' })).toBeUndefined();
    expect(normalizePricingOverrides({ models: [] })).toBeUndefined();
    expect(normalizePricingOverrides({ models: { bad: 'nope' } })).toBeUndefined();
  });

  it('drops invalid model entries while keeping valid ones', () => {
    expect(normalizePricingOverrides({
      models: {
        good: { input: 1, output: 2 },
        zeroInput: { input: 0, output: 2 },
        negativeOutput: { input: 1, output: -2 },
        stringPrice: { input: '1', output: 2 },
        arrayPrice: [1, 2],
      },
    })).toEqual({ models: { good: { input: 1, output: 2 } } });
  });

  it('drops invalid cache fields without rejecting the entry', () => {
    expect(normalizePricingOverrides({
      models: { m: { input: 1, output: 2, cacheRead: -3, cacheWrite: 'x' } },
    })).toEqual({ models: { m: { input: 1, output: 2 } } });
  });

  it('keeps a valid usdCny even when all models are invalid', () => {
    expect(normalizePricingOverrides({ usdCny: 6.9, models: { bad: 1 } })).toEqual({ usdCny: 6.9 });
  });
});

describe('normalizeModelId', () => {
  it('strips a provider prefix', () => {
    expect(normalizeModelId('model_hub/claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
  });

  it('strips a date suffix', () => {
    expect(normalizeModelId('claude-haiku-4-20261001')).toBe('claude-haiku-4');
  });

  it('strips both prefix and suffix', () => {
    expect(normalizeModelId('provider/gpt-5-codex-20251001')).toBe('gpt-5-codex');
  });

  it('leaves ordinary ids untouched', () => {
    expect(normalizeModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('gpt-4o')).toBe('gpt-4o');
  });
});

describe('resolveModelPrice', () => {
  it('matches built-in family keys by longest prefix', () => {
    expect(resolveModelPrice('claude-sonnet-4-5-20250929')).toEqual({
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    });
    expect(resolveModelPrice('claude-opus-4-1')).toMatchObject({ input: 15, output: 75 });
    expect(resolveModelPrice('gpt-5.1-codex')).toMatchObject({ input: 2, output: 15 });
    expect(resolveModelPrice('gemini-2.5-flash')).toMatchObject({ input: 0.3, output: 2.5 });
  });

  it('does not let a shorter prefix hijack a longer exact key (gpt-5.1-codex vs gpt-5.1)', () => {
    const overrides: PricingOverrides = {
      models: {
        'gpt-5.1': { input: 1, output: 1 },
        'gpt-5.1-codex': { input: 2, output: 2 },
      },
    };
    // 精确命中更长的键，不被前缀抢。
    expect(resolveModelPrice('gpt-5.1-codex', overrides)).toEqual({ input: 2, output: 2 });
    // 非精确时最长前缀胜。
    expect(resolveModelPrice('gpt-5.1-xyz', overrides)).toEqual({ input: 1, output: 1 });
  });

  it('prefers overrides over the built-in table', () => {
    const overrides: PricingOverrides = {
      models: { 'claude-sonnet-4': { input: 99, output: 99 } },
    };
    expect(resolveModelPrice('claude-sonnet-4-5', overrides)).toEqual({ input: 99, output: 99 });
    // 未覆盖的键仍走内置表。
    expect(resolveModelPrice('claude-opus-4-1', overrides)).toMatchObject({ input: 15 });
  });

  it('matches override prefixes with a - or . boundary', () => {
    const overrides: PricingOverrides = {
      models: {
        'gpt-5': { input: 1, output: 1 },
        'gpt-5.1': { input: 3, output: 3 },
      },
    };
    expect(resolveModelPrice('gpt-5.1-something', overrides)).toEqual({ input: 3, output: 3 });
    expect(resolveModelPrice('gpt-5-xyz', overrides)).toEqual({ input: 1, output: 1 });
  });

  it('does not match across a non-boundary character', () => {
    // 'claude-sonnet-4' 不得匹配 'claude-sonnet-40'（边界必须是 - 或 .）。
    expect(resolveModelPrice('claude-sonnet-40')).toBeNull();
  });

  it('returns null for unknown or empty model ids (fail-closed)', () => {
    expect(resolveModelPrice('grok-3')).toBeNull();
    expect(resolveModelPrice('')).toBeNull();
    expect(resolveModelPrice('model_hub/relay-code')).toBeNull();
  });
});

describe('estimateCostCny', () => {
  const pricing = { usdCny: DEFAULT_USD_CNY };

  it('prices all four token buckets correctly', () => {
    // claude-sonnet-4: input 3 / output 15 / cacheRead 0.3 / cacheWrite 3.75 USD per 1M
    const cost = estimateCostCny(usage({
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 200_000,
      cacheCreateTokens: 10_000,
    }), pricing);
    // (100000*3 + 50000*15 + 200000*0.3 + 10000*3.75) / 1e6 * 7.2 = 8.262
    expect(cost).toBeCloseTo(8.262, 6);
  });

  it('falls back to the input price for missing cache buckets', () => {
    // o3 只有 input/output（2/8），cacheRead/cacheWrite 回退 input 价。
    const cost = estimateCostCny({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
      model: 'o3',
    }, pricing);
    // (2 + 2 + 2) / 1e6 * 1e6 * 7.2 = 43.2
    expect(cost).toBeCloseTo(43.2, 6);
  });

  it('uses the resolved fx rate and override model prices', () => {
    // ResolvedModelPricing.usdCny 是生效汇率（wiring 层已把 overrides.usdCny
    // 与默认值合并）；estimateCostCny 只认顶层 usdCny。
    const cost = estimateCostCny(usage({ inputTokens: 1_000_000 }), {
      usdCny: 10,
      overrides: { models: { 'claude-sonnet-4': { input: 5, output: 5 } } },
    });
    // 5 USD * 10 = 50 CNY
    expect(cost).toBeCloseTo(50, 6);
  });

  it('returns null without pricing', () => {
    expect(estimateCostCny(usage({ inputTokens: 1000 }))).toBeNull();
  });

  it('returns null for an unpriced model', () => {
    expect(estimateCostCny(usage({ model: 'grok-3', inputTokens: 1000 }), pricing)).toBeNull();
  });

  it('prices zero usage as 0 CNY when the model is priced', () => {
    expect(estimateCostCny(usage(), pricing)).toBeCloseTo(0, 9);
  });
});
