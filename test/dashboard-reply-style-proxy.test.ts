import { describe, expect, it } from 'vitest';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from '../src/dashboard/reply-style.js';
import { proxyRouteFor, runProxyRoute } from './helpers/daemon-proxy-harness.js';

const URL_PATH = '/api/bots/cli_a/reply-style';

describe('dashboard reply-style proxy', () => {
  it('forwards a bounded PUT payload to the exact daemon route', async () => {
    expect(REPLY_STYLE_REQUEST_MAX_BYTES).toBe(32 * 1024);
    expect(proxyRouteFor('PUT', URL_PATH)?.body).toEqual({ kind: 'json', maxBytes: REPLY_STYLE_REQUEST_MAX_BYTES });
    const out = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: '{"theme":"default"}' });
    expect(out.proxyCalls).toEqual([{
      appId: 'cli_a',
      path: '/api/bot-reply-style',
      init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"theme":"default"}' },
    }]);
  });

  it('maps malformed JSON to 400 and an oversized body to 413', async () => {
    const malformed = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: '{oops' });
    expect(malformed.head?.[0]).toBe(400);
    expect(JSON.parse(malformed.body!)).toEqual({ ok: false, error: 'bad_json' });

    const oversized = await runProxyRoute({
      method: 'PUT',
      url: URL_PATH,
      body: JSON.stringify({ prompt: 'x'.repeat(REPLY_STYLE_REQUEST_MAX_BYTES) }),
    });
    expect(oversized.head?.[0]).toBe(413);
    expect(JSON.parse(oversized.body!)).toEqual({ ok: false, error: 'body_too_large' });
    expect(oversized.proxyCalls).toEqual([]);
  });
});
