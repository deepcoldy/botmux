import { describe, expect, it } from 'vitest';
import { ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES } from '../src/im/lark/ask-option-layout.js';
import { proxyRouteFor, runProxyRoute } from './helpers/daemon-proxy-harness.js';

const URL_PATH = '/api/bots/cli_a/ask-option-layout';

describe('dashboard ask-option-layout proxy', () => {
  it('forwards the PUT payload to the exact daemon route', async () => {
    expect(ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES).toBe(1024);
    expect(proxyRouteFor('PUT', URL_PATH)?.body).toEqual({ kind: 'json', maxBytes: ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES });
    const out = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: '{"layout":"vertical"}' });
    expect(out.proxyCalls).toEqual([{
      appId: 'cli_a',
      path: '/api/bot-ask-option-layout',
      init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"layout":"vertical"}' },
    }]);
  });

  it('maps malformed JSON to 400 and an oversized body to 413', async () => {
    const malformed = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: '{oops' });
    expect(malformed.head?.[0]).toBe(400);
    expect(JSON.parse(malformed.body!)).toEqual({ ok: false, error: 'bad_json' });

    const oversized = await runProxyRoute({
      method: 'PUT',
      url: URL_PATH,
      body: JSON.stringify({ layout: 'x'.repeat(ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES) }),
    });
    expect(oversized.head?.[0]).toBe(413);
    expect(JSON.parse(oversized.body!)).toEqual({ ok: false, error: 'body_too_large' });
    expect(oversized.proxyCalls).toEqual([]);
  });
});
