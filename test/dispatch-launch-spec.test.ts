import { describe, expect, it, vi } from 'vitest';
import { resolveDispatchLaunchSpec } from '../src/core/dispatch-launch-spec.js';

describe('dispatch launch spec validation', () => {
  const target = { cliId: 'codex' as const, model: 'gpt-5.6-sol', reasoningEffort: 'medium' as const };

  it('accepts catalog-verified gpt-6-astra + high', async () => {
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-6-astra', reasoningEffort: 'high' }, target,
      detectModels: async () => ['gpt-6-astra'] })).resolves.toEqual({ ok: true,
      requested: { model: 'gpt-6-astra', reasoningEffort: 'high' }, effective: { model: 'gpt-6-astra', reasoningEffort: 'high' } });
  });

  it('fails closed on an unknown model or unavailable catalog', async () => {
    for (const detectModels of [async () => ['gpt-5.6-sol'], async () => null]) {
      await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-nope', reasoningEffort: 'high' }, target, detectModels }))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining('实时 model catalog') });
    }
  });

  it('rejects an invalid effort before consulting the catalog', async () => {
    const detectModels = vi.fn(async () => ['gpt-6-astra']);
    await expect(resolveDispatchLaunchSpec({ requested: { model: 'gpt-6-astra', reasoningEffort: 'extreme' }, target, detectModels }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('只接受') });
    expect(detectModels).not.toHaveBeenCalled();
  });
});
