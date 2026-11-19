import { describe, expect, it } from 'vitest';
import { parseTraexModelLoads, parseTraexModelLoadSnapshot } from '../src/services/traex-model-load.js';

describe('native TraeX model load snapshot', () => {
  it('reads public identities, accepts overload above 100%, and ignores missing or invalid values', () => {
    const result = parseTraexModelLoads({ data: [
      { id: 'gpt-5.6-sol', model: 'GPT-5.6-Sol', businessMetadata: { load: { load_percent: 102 } } },
      { id: 'missing', businessMetadata: { load: null } },
      { id: 'invalid', businessMetadata: { load: { load_percent: -1 } } },
      { id: 'string', businessMetadata: { load: { load_percent: '0' } } },
    ] });
    expect([...result]).toEqual([['gpt-5.6-sol', 102]]);
    expect(parseTraexModelLoads(null).size).toBe(0);
  });

  it('reads the model-native reasoning ladder from the same side-effect-free catalog page', () => {
    const snapshot = parseTraexModelLoadSnapshot({ data: [
      { id: 'max-model', model: 'MAX-MODEL', businessMetadata: { load: { load_percent: 101 } },
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }] },
      { id: 'extra-high', businessMetadata: { load: { load_percent: 100 } },
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }, { effort: 'invalid' }] },
    ] });
    expect(snapshot.loads.get('max-model')).toBe(101);
    expect(snapshot.reasoningEfforts.get('max-model')).toEqual(['low', 'xhigh', 'max']);
    expect(snapshot.reasoningEfforts.get('extra-high')).toEqual(['high', 'xhigh']);
  });
});
