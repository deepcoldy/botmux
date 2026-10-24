import { describe, expect, it } from 'vitest';
import { parseTraexModelLoads } from '../src/services/traex-model-load.js';

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
});
