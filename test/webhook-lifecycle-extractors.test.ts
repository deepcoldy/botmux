import { describe, expect, it } from 'vitest';
import { extractDedupKey, getJsonPathValue } from '../src/services/webhook-lifecycle-extractors.js';

describe('webhook-lifecycle-extractors', () => {
  it('reads simple JSONPath-style dotted fields', () => {
    const payload = { alert: { fingerprint: 'abc', state: 'firing' } };
    expect(getJsonPathValue(payload, '$.alert.fingerprint')).toBe('abc');
    expect(getJsonPathValue(payload, 'alert.fingerprint')).toBe('abc');
  });

  it('extracts the dedup key as a string (coercing numbers)', () => {
    expect(extractDedupKey({ alert: { id: 'cpu-high' } }, 'alert.id')).toBe('cpu-high');
    expect(extractDedupKey({ id: 42 }, 'id')).toBe('42');
  });

  it('returns undefined when the dedup path is missing', () => {
    expect(extractDedupKey({ alert: { state: 'firing' } }, 'alert.id')).toBeUndefined();
    expect(extractDedupKey({}, 'alert.id')).toBeUndefined();
  });
});
