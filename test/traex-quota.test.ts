import { describe, expect, it } from 'vitest';
import { isTraexQuotaError, parseTraexModelQuotas } from '../src/services/traex-quota.js';
import { TraexAutoModelController, normalizeTraexAutoModelConfig, validTraexAutoModelRuntime } from '../src/services/traex-auto-model.js';

describe('TraeX explicit quota evidence', () => {
  it.each(['usageLimitExceeded', 'usage_limit_exceeded'])("recognizes native code %s", code => {
    expect(isTraexQuotaError({ codex_error_info: code })).toBe(true);
    expect(isTraexQuotaError({ message: JSON.stringify({ error: { codexErrorInfo: code } }) })).toBe(true);
  });
  it.each([
    { code: 429, message: 'Too many requests' },
    { codex_error_info: 'rateLimitExceeded' },
    { codex_error_info: 'sessionBudgetExceeded' },
    { codex_error_info: 'unauthorized' },
    { message: 'usage_limit_exceeded in a tool result' },
    { message: 'network timeout' },
  ])('does not infer depleted quota from %j', error => {
    expect(isTraexQuotaError(error)).toBe(false);
  });
  it('uses authoritative depletion, not rounded percent; missing remains unknown', () => {
    const result = parseTraexModelQuotas({ models: [
      { slug: 'first', business_metadata: { internal_daily_usage: { isDepleted: false, usagePercent: 100, resetTime: 300 } } },
      { slug: 'second', business_metadata: { internal_daily_usage: { isDepleted: true, resetTime: 300 } } },
      { slug: 'last', business_metadata: {} },
    ] }, 100_000);
    expect(result.get('first')).toMatchObject({ depleted: false });
    expect(result.get('second')).toEqual({ depleted: true, resetAtMs: 300_000 });
    expect(result.get('last')).toBeUndefined();
  });
  it('waits for every depleted quota window and never infers a reset', () => {
    const result = parseTraexModelQuotas({ models: [
      { slug: 'both', business_metadata: {
        internal_daily_usage: { isDepleted: true, resetTime: 300 },
        internal_usage: { is_depleted: true, reset_time: 600 },
      } },
      { slug: 'unknown', business_metadata: { internal_usage: { is_depleted: true } } },
      { slug: 'stale', business_metadata: { internal_daily_usage: { isDepleted: true, resetTime: 50 } } },
    ] }, 100_000);
    expect(result.get('both')).toEqual({ depleted: true, resetAtMs: 600_000 });
    expect(result.get('unknown')).toEqual({ depleted: true });
    expect(result.get('stale')).toBeUndefined();
  });
  it('cannot clear daily exhaustion from a weekly-only partial catalog', () => {
    expect(parseTraexModelQuotas({ models: [{ slug: 'first', business_metadata: {
      internal_daily_quota_key: 'daily', internal_daily_usage: null,
      is_internal_usage_limit: true, internal_usage: { is_depleted: false, reset_time: 600 },
    } }] }, 100_000).has('first')).toBe(false);
  });
  it.each([false, true])('keeps expired daily evidence unknown while current weekly depleted=%s', weeklyDepleted => {
    const config = { enabled: true as const, trigger: 'quota' as const,
      models: ['first', 'second'], queueTimeoutMs: 5000 };
    const pool = new TraexAutoModelController(config);
    pool.beginTurn('turn');
    pool.observeQuotaFailure('turn', null);
    const evidence = parseTraexModelQuotas({ models: [{ slug: 'first', business_metadata: {
      internal_daily_quota_key: 'daily', internal_daily_usage: { isDepleted: true, resetTime: 50 },
      is_internal_usage_limit: true, internal_usage: { is_depleted: weeklyDepleted, reset_time: 600 },
    } }] }, 100_000);
    expect(evidence.get('first')).toEqual(weeklyDepleted ? { depleted: true, resetAtMs: 600_000 } : undefined);
    pool.refreshQuotaEvidence(evidence, 100_000);
    expect(pool.runtimeState('native').quotaBlocks).toEqual([
      { model: 'first', ...(weeklyDepleted ? { resetAtMs: 600_000 } : {}) },
    ]);
  });
});

describe('quota-only model pool', () => {
  const config = { enabled: true as const, trigger: 'quota' as const,
    models: ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'DeepSeek-V4-Flash'], queueTimeoutMs: 5000 };
  it('preserves opt-in through normalization and rejects misspellings', () => {
    expect(normalizeTraexAutoModelConfig(config).config).toEqual(config);
    expect(normalizeTraexAutoModelConfig({ ...config, trigger: 'quotas' }).error).toBeDefined();
  });
  it('does not switch on sustained capacity queues', () => {
    const pool = new TraexAutoModelController(config);
    pool.beginTurn('t');
    for (const nowMs of [0, 6000, 600000]) {
      expect(pool.observeCapacityQueue({ turnId: 't', queued: true, nowMs })).toEqual({ kind: 'none' });
    }
  });
  it('tries unknown quotas in exact order, stops at the end and persists blocks', () => {
    const pool = new TraexAutoModelController(config);
    pool.beginTurn('t');
    for (const expected of config.models.slice(1)) {
      const action = pool.observeQuotaFailure('t', null);
      expect(action).toMatchObject({ kind: 'switch', toModel: expected, reason: 'quota_exhausted' });
      if (action.kind === 'switch') expect(pool.commitSwitch(action)).toBe(true);
    }
    expect(pool.observeQuotaFailure('t', null).kind).toBe('exhausted');
    const state = pool.runtimeState('native');
    expect(validTraexAutoModelRuntime(config, state, 'other')).toBe(false);
    const restored = new TraexAutoModelController(config, state);
    expect(restored.beginTurn('next').kind).toBe('exhausted');
  });
  it('skips confirmed depleted backups but restores preference only after server reset', () => {
    const pool = new TraexAutoModelController(config);
    pool.beginTurn('t');
    const reset = Date.now() + 60000;
    const action = pool.observeQuotaFailure('t', new Map([
      ['gpt-6.1-sol', { depleted: true, resetAtMs: reset }],
      ['gpt-5.6-sol', { depleted: true, resetAtMs: reset }],
    ]));
    expect(action).toMatchObject({ kind: 'switch', toModel: 'DeepSeek-V4-Flash' });
    if (action.kind === 'switch') pool.commitSwitch(action);
    pool.endTurn('t');
    expect(pool.beginTurn('before-reset')).toEqual({ kind: 'none' });
    const state = pool.runtimeState('native');
    state.quotaBlocks!.forEach(block => { block.resetAtMs = Date.now() - 1; });
    const restored = new TraexAutoModelController(config, state);
    expect(restored.beginTurn('after-reset')).toMatchObject({ kind: 'switch', toModel: 'GPT-6.1-Sol' });
  });
});
