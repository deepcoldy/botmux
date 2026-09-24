import { describe, expect, it } from 'vitest';
import {
  normalizeNativeSubagentRuntimePolicy,
  rewriteNativeSubagentSpawnInput,
  type NativeSubagentRuntimePolicy,
} from '../src/services/native-subagent-runtime-policy.js';

describe('normalizeNativeSubagentRuntimePolicy', () => {
  it.each([undefined, {}])('canonicalizes an absent or empty policy to undefined', (raw) => {
    expect(normalizeNativeSubagentRuntimePolicy(raw)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    [{ model: { mode: 'custom', value: '  GPT-5.6-Sol  ' } }, { model: { mode: 'custom', value: 'GPT-5.6-Sol' } }],
    [{ reasoningEffort: { mode: 'custom', value: 'ultra' } }, { reasoningEffort: { mode: 'custom', value: 'ultra' } }],
  ])('accepts and defensively copies one independent configured dimension', (raw, value) => {
    const result = normalizeNativeSubagentRuntimePolicy(raw);
    expect(result).toEqual({ ok: true, value });
    if (result.ok) expect(result.value).not.toBe(raw);
  });

  it.each([
    [null, 'policy object'],
    [[], 'policy object'],
    [{ extra: true }, 'unknown'],
    [{ model: null }, 'model'],
    [{ model: { mode: 'passthrough' } }, 'model.mode must be custom'],
    [{ model: { mode: 'inherit' } }, 'model.mode must be custom'],
    [{ model: { mode: 'inherit', value: 'GPT-5.4' } }, 'model.mode must be custom'],
    [{ model: { mode: 'custom' } }, 'model.value'],
    [{ model: { mode: 'custom', value: '   ' } }, 'model.value'],
    [{ model: { mode: 'custom', value: 'x'.repeat(257) } }, 'model.value'],
    [{ model: { mode: 'custom', value: 'GPT-5.4', extra: true } }, 'unknown'],
    [{ reasoningEffort: null }, 'reasoningEffort'],
    [{ reasoningEffort: { mode: 'passthrough' } }, 'reasoningEffort.mode must be custom'],
    [{ reasoningEffort: { mode: 'inherit' } }, 'reasoningEffort.mode must be custom'],
    [{ reasoningEffort: { mode: 'inherit', value: 'high' } }, 'reasoningEffort.mode must be custom'],
    [{ reasoningEffort: { mode: 'custom' } }, 'reasoningEffort.value'],
    [{ reasoningEffort: { mode: 'custom', value: 'extreme' } }, 'reasoningEffort.value'],
    [{ reasoningEffort: { mode: 'custom', value: 'high', extra: true } }, 'unknown'],
  ])('rejects malformed persisted state %# with a diagnostic', (raw, expectedError) => {
    const result = normalizeNativeSubagentRuntimePolicy(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(expectedError);
  });
});

describe('rewriteNativeSubagentSpawnInput', () => {
  const original = {
    task_name: 'inspect-api',
    message: 'Inspect the API boundary',
    agent_type: 'explorer',
    fork_turns: 'all',
    service_tier: 'priority',
    run_in_background: true,
    model_provider: 'openrouter',
    model: 'parent-selected-model',
    reasoning_effort: 'low',
    metadata: { trace: 'keep-the-same-reference' },
  };
  const modelPolicies = [
    ['passthrough', undefined, 'openrouter', 'parent-selected-model'],
    ['custom', { mode: 'custom', value: 'GPT-5.4' }, 'trae', 'GPT-5.4'],
  ] as const;
  const effortPolicies = [
    ['passthrough', undefined, 'low'],
    ['custom', { mode: 'custom', value: 'xhigh' }, 'xhigh'],
  ] as const;

  it.each(modelPolicies.flatMap(([modelMode, model, expectedProvider, expectedModel]) =>
    effortPolicies.map(([effortMode, reasoningEffort, expectedEffort]) => ({
      name: `${modelMode}/${effortMode}`,
      policy: { model, reasoningEffort } as NativeSubagentRuntimePolicy,
      expectedProvider,
      expectedModel,
      expectedEffort,
    })),
  ))('applies the independent $name policy combination', ({ policy, expectedProvider, expectedModel, expectedEffort }) => {
    const snapshot = structuredClone(original);
    const result = rewriteNativeSubagentSpawnInput(original, policy);

    expect(result.kind).toBe(policy.model || policy.reasoningEffort ? 'rewritten' : 'unchanged');
    expect(result.input).not.toBe(original);
    expect(result.input).toEqual({
      ...original,
      model_provider: expectedProvider,
      model: expectedModel,
      reasoning_effort: expectedEffort,
    });
    expect(result.input.metadata).toBe(original.metadata);
    expect(original).toEqual(snapshot);
  });

  it('replaces model and provider atomically while preserving unrelated and absent effort fields', () => {
    const input = { task_name: 'build', model_provider: 'anthropic', model: 'claude-opus', role: 'worker' };
    const result = rewriteNativeSubagentSpawnInput(
      input,
      { model: { mode: 'custom', value: 'GPT-5.5' } },
    );

    expect(result).toEqual({
      kind: 'rewritten',
      input: { task_name: 'build', model_provider: 'trae', model: 'GPT-5.5', role: 'worker' },
    });
    expect(input).toEqual({ task_name: 'build', model_provider: 'anthropic', model: 'claude-opus', role: 'worker' });
  });

});
