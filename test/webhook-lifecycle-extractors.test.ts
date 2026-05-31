import { describe, expect, it } from 'vitest';
import { extractWebhookLifecycle, getJsonPathValue } from '../src/services/webhook-lifecycle-extractors.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

const extractors: ConnectorDefinition['lifecycleExtractors'] = {
  dedupKey: '$.alert.fingerprint',
  status: '$.alert.state',
  statusMap: { recovered: 'resolved' },
};

describe('webhook-lifecycle-extractors', () => {
  it('reads simple JSONPath-style dotted fields', () => {
    const payload = { alert: { fingerprint: 'abc', state: 'firing' } };
    expect(getJsonPathValue(payload, '$.alert.fingerprint')).toBe('abc');
    expect(extractWebhookLifecycle(payload, extractors)).toEqual({
      ok: true,
      lifecycle: { dedupKey: 'abc', status: 'firing' },
    });
  });

  it('normalizes mapped resolved statuses', () => {
    const payload = { alert: { fingerprint: 'abc', state: 'recovered' } };
    expect(extractWebhookLifecycle(payload, extractors)).toEqual({
      ok: true,
      lifecycle: { dedupKey: 'abc', status: 'resolved' },
    });
  });

  it('fails closed when the dedup key is missing', () => {
    const payload = { alert: { state: 'firing' } };
    const out = extractWebhookLifecycle(payload, extractors);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('dedup_key_not_found');
  });
});
