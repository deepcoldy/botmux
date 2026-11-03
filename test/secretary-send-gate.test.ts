import { describe, it, expect } from 'vitest';
import { validateSecretaryAction } from '../src/services/send-policy.js';

describe('validateSecretaryAction', () => {
  it('refuses a send without an action inside a secretary turn', () => {
    const r = validateSecretaryAction({ turnId: 'secretary:cli_x:oc_y:1:1' });
    expect(r.ok).toBe(false);
  });
  it('accepts a declared action inside a secretary turn (case-insensitive)', () => {
    expect(validateSecretaryAction({ turnId: 'secretary:cli_x:oc_y:1:1', action: 'Nudge' })).toEqual({ ok: true, action: 'nudge' });
  });
  it('does not gate ordinary turns, but still rejects a misspelled action', () => {
    expect(validateSecretaryAction({ turnId: 'om_abc' }).ok).toBe(true);
    expect(validateSecretaryAction({ turnId: undefined }).ok).toBe(true);
    expect(validateSecretaryAction({ turnId: 'om_abc', action: 'status' }).ok).toBe(false);
    expect(validateSecretaryAction({ turnId: 'secretary:x', action: 'none' }).ok).toBe(false);
  });
});
