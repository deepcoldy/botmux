import { describe, expect, it } from 'vitest';
import {
  GROK_COMMON_REASONING_EFFORTS,
  GROK_REASONING_EFFORTS,
  cliModelSupportsReasoningEffort,
  codexModelSupportsReasoningEffort,
  codexReasoningEffortsForModel,
  isConfigurableReasoningCliId,
  reasoningEffortsForCliModel,
} from '../src/services/codex-reasoning-effort.js';

describe('Codex model-aware reasoning efforts', () => {
  it('exposes six levels only for sol and terra', () => {
    expect(codexReasoningEffortsForModel('gpt-5.6-sol')).toContain('ultra');
    expect(codexReasoningEffortsForModel('gpt-5.6-terra')).toContain('ultra');
  });

  it('allows max but not ultra for luna', () => {
    expect(codexModelSupportsReasoningEffort('gpt-5.6-luna', 'max')).toBe(true);
    expect(codexModelSupportsReasoningEffort('gpt-5.6-luna', 'ultra')).toBe(false);
  });

  it('fails closed to the four-level common intersection for unknown models', () => {
    expect(codexReasoningEffortsForModel('custom-model')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(codexModelSupportsReasoningEffort('', 'max')).toBe(false);
  });
});
describe('Grok model-aware reasoning efforts', () => {
  it('treats grok as a configurable reasoning CLI', () => {
    expect(isConfigurableReasoningCliId('grok')).toBe(true);
    expect(isConfigurableReasoningCliId('codex')).toBe(true);
    expect(isConfigurableReasoningCliId('traex')).toBe(true);
    expect(isConfigurableReasoningCliId('claude-code')).toBe(false);
  });

  it('exposes xhigh only for grok-4.6', () => {
    expect(reasoningEffortsForCliModel('grok', 'grok-4.6')).toEqual(GROK_REASONING_EFFORTS);
    expect(cliModelSupportsReasoningEffort('grok', 'grok-4.6', 'xhigh')).toBe(true);
  });

  it('fails closed to the three-level intersection for grok-4.5 and unknown models', () => {
    expect(reasoningEffortsForCliModel('grok', 'grok-4.5')).toEqual(GROK_COMMON_REASONING_EFFORTS);
    expect(reasoningEffortsForCliModel('grok', 'custom-model')).toEqual(GROK_COMMON_REASONING_EFFORTS);
    expect(cliModelSupportsReasoningEffort('grok', 'grok-4.5', 'xhigh')).toBe(false);
    expect(cliModelSupportsReasoningEffort('grok', 'grok-4.6', 'high')).toBe(true);
  });
});

describe('TraeX model-aware reasoning efforts', () => {
  it('uses the TraeX catalog levels for known models and a conservative fallback', () => {
    expect(reasoningEffortsForCliModel('traex', 'GPT-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(cliModelSupportsReasoningEffort('traex', 'GPT-5.5', 'xhigh')).toBe(true);
    expect(cliModelSupportsReasoningEffort('traex', 'GPT-5.5', 'max')).toBe(false);
    expect(cliModelSupportsReasoningEffort('traex', 'DeepSeek-V4-Pro', 'xhigh')).toBe(false);
    expect(cliModelSupportsReasoningEffort('traex', undefined, 'medium')).toBe(true);
  });
});
