import { describe, expect, it } from 'vitest';
import { platformRefusalReason } from '../src/core/platform-credential-source.js';

describe('platformRefusalReason', () => {
  it.each([
    [{ state: 'unbound' }, 'platform_unbound'],
    [{ state: 'not_authorized', consent: false }, 'platform_not_authorized'],
    [{ state: 'not_authorized', consent: true }, 'platform_consent_missing'],
    [{ state: 'denied', reason: 'not_teammate', detail: '' }, 'platform_not_teammate'],
    [{ state: 'denied', reason: 'forbidden', detail: 'forbidden (403 x)' }, 'platform_forbidden'],
    [{ state: 'unavailable', detail: 'sender union_id unresolved' }, 'union_id_unresolved'],
    [{ state: 'unavailable', detail: 'network: 连接超时（5000ms） (after retry)' }, 'platform_timeout'],
    [{ state: 'unavailable', detail: 'network: connect ETIMEDOUT 10.0.0.1:443' }, 'platform_timeout'],
    [{ state: 'unavailable', detail: 'platform unavailable (504 gateway timeout)' }, 'platform_timeout'],
    [{ state: 'unavailable', detail: 'network: ECONNREFUSED' }, 'platform_unreachable'],
    [{ state: 'unavailable', detail: 'rate limited (429)' }, 'platform_rate_limited'],
    [{ state: 'unavailable', detail: 'platform unavailable (503 store_unavailable)' }, 'platform_unavailable'],
  ] as const)('%j → %s', (resolution, reason) => {
    expect(platformRefusalReason(resolution as any)).toBe(reason);
  });
});
