import { describe, expect, it } from 'vitest';
import {
  codexModelSupportsReasoningEffort,
  codexReasoningEffortsForModel,
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
