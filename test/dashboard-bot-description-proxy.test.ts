import { describe, expect, it } from 'vitest';
import { proxyRouteFor, runProxyRoute } from './helpers/daemon-proxy-harness.js';

const URL_PATH = '/api/bots/cli_a/description';

describe('dashboard bot-description proxy', () => {
  it('forwards GET and bounded PUT to the exact daemon path', async () => {
    expect(proxyRouteFor('GET', URL_PATH)?.body).toEqual({ kind: 'none' });
    expect(proxyRouteFor('PUT', URL_PATH)?.body).toEqual({
      kind: 'raw',
      cap: { maxBytes: 64 * 1024, error: 'body_too_large' },
    });

    const get = await runProxyRoute({ method: 'GET', url: URL_PATH });
    expect(get.proxyCalls).toEqual([{ appId: 'cli_a', path: '/api/bot-description', init: { method: 'GET' } }]);

    const put = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: '{"descriptions":{"zh_cn":"hi"}}' });
    expect(put.proxyCalls).toEqual([{
      appId: 'cli_a',
      path: '/api/bot-description',
      init: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"descriptions":{"zh_cn":"hi"}}',
      },
    }]);
  });

  it('rejects a PUT body over 64KiB with 413 before anything reaches the daemon', async () => {
    const over = await runProxyRoute({ method: 'PUT', url: URL_PATH, body: Buffer.alloc(64 * 1024 + 1, 0x61) });
    expect(over.head?.[0]).toBe(413);
    expect(JSON.parse(over.body!)).toEqual({ ok: false, error: 'body_too_large' });
    expect(over.proxyCalls).toEqual([]);
  });
});
