import { describe, expect, it, vi } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { resolveDispatchLaunchSpec } from '../src/core/dispatch-launch-spec.js';

describe('dispatch launch spec validation', () => {
  const target = { cliId: 'codex' as const, model: 'gpt-5.6-sol', reasoningEffort: 'medium' as const };

  it('accepts catalog-verified gpt-6-astra + high', async () => {
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-6-astra', reasoningEffort: 'high' }, target,
      detectModels: async () => ['gpt-6-astra'] })).resolves.toEqual({ ok: true,
      requested: { model: 'gpt-6-astra', reasoningEffort: 'high' }, effective: { model: 'gpt-6-astra', reasoningEffort: 'high' } });
  });

  it.each([
    { model: 'DeepSeek-V4-Pro', reasoningEffort: 'xhigh' },
    { model: 'auto', reasoningEffort: 'ultra', traexAutoModel: { enabled: true, models: ['DeepSeek-V4-Pro'] } },
  ])('retains parse-loaded TraeX $reasoningEffort on a catalog-verified model override', async config => {
    const target = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'dispatch_test', larkAppSecret: 'fixture', cliId: 'traex', ...config,
    }]))[0]!;
    expect(target.reasoningEffort).toBe(config.reasoningEffort);
    const detectModels = vi.fn(async () => ['future-live-model']);
    const result = await resolveDispatchLaunchSpec({ requested: { model: 'future-live-model' }, target, detectModels });
    expect(result).toEqual({ ok: true, requested: { model: 'future-live-model' },
      effective: { model: 'future-live-model', reasoningEffort: config.reasoningEffort } });
    expect(detectModels).toHaveBeenCalledOnce();
  });

  it('rejects a catalog-verified Codex model incompatible with inherited effort', async () => {
    const target = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'dispatch_codex', larkAppSecret: 'fixture', cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra',
    }]))[0]!;
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-5.4' }, target,
      detectModels: async () => ['gpt-5.4'] })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不支持') });
  });

  it('fails closed on an unknown model or unavailable catalog', async () => {
    for (const detectModels of [async () => ['gpt-5.6-sol'], async () => null]) {
      await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-nope', reasoningEffort: 'high' }, target, detectModels }))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining('实时 model catalog') });
    }
  });

  it('rejects an invalid effort before consulting the catalog', async () => {
    const detectModels = vi.fn(async () => ['gpt-6-astra']);
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-6-astra', reasoningEffort: 'extreme' },
      target: { cliId: 'traex', model: 'DeepSeek-V4-Pro' }, detectModels }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('只接受') });
    expect(detectModels).not.toHaveBeenCalled();
  });
});
