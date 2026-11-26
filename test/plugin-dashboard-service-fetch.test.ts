import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginDashboardApi,
  resolvePluginServiceProxyUrl,
} from '../src/dashboard/web/plugin-page.js';
import { classifyFetchUnauthorized } from '../src/dashboard/web/fetch-auth-guard.js';

describe('pluginDashboardApi.serviceFetch, resolvePluginServiceProxyUrl, and SPA 401 guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes valid relative paths and preserves query strings verbatim', () => {
    expect(resolvePluginServiceProxyUrl('my-plugin', '')).toBe('/api/plugins/my-plugin/service');
    expect(resolvePluginServiceProxyUrl('my-plugin', '/')).toBe('/api/plugins/my-plugin/service/');
    expect(resolvePluginServiceProxyUrl('my-plugin', 'status')).toBe('/api/plugins/my-plugin/service/status');
    expect(resolvePluginServiceProxyUrl('my-plugin', '/status')).toBe('/api/plugins/my-plugin/service/status');
    expect(resolvePluginServiceProxyUrl('my-plugin', '?a=1&b=2')).toBe('/api/plugins/my-plugin/service?a=1&b=2');
    expect(resolvePluginServiceProxyUrl('my-plugin', '/?a=1')).toBe('/api/plugins/my-plugin/service/?a=1');
    expect(resolvePluginServiceProxyUrl('my-plugin', '/v1.0/items/')).toBe('/api/plugins/my-plugin/service/v1.0/items/');
    expect(resolvePluginServiceProxyUrl(
      'my-plugin',
      '/fetch?url=https://example.com/a/b&repo=org%2Fproj&diff=main..dev',
    )).toBe('/api/plugins/my-plugin/service/fetch?url=https://example.com/a/b&repo=org%2Fproj&diff=main..dev');
  });

  it.each([
    ['absolute https URL', 'https://evil.example/steal'],
    ['absolute http URL', 'http://127.0.0.1:9999/secret'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['leading space before scheme', ' javascript:alert(1)'],
    ['protocol-relative', '//evil.example/steal'],
    ['leading backslash', '\\evil'],
    ['slash backslash', '/\\evil'],
    ['interior backslash', '/a\\b'],
    ['interior double slash', '/a//b'],
    ['dot-dot traversal', '../other'],
    ['leading slash dot-dot', '/a/../../bots'],
    ['trailing space after dot-dot', '/v1/users/.. '],
    ['trailing space after encoded dot-dot', '/v1/users/%2e%2e '],
    ['trailing space after single dot', '/v1/users/. '],
    ['trailing space after encoded single dot', '/v1/users/%2e '],
    ['whitespace-only path', '   '],
    ['single dot segment', '/a/./b'],
    ['encoded dot-dot', '/%2e%2e/bots'],
    ['mixed encoded dot-dot', '/.%2e/bots'],
    ['encoded slash', '/a%2fb'],
    ['uppercase encoded slash', '/a%2Fb'],
    ['encoded backslash', '/a%5cb'],
    ['encoded NUL control char', '/a%00b'],
    ['encoded CR control char', '/a%0db'],
    ['fragment', '/status#hash'],
    ['control char', '/status\r\nX-Injected: 1'],
    ['malformed percent encoding', '/%E0%A4%A'],
  ])('rejects unsafe path: %s', (_label, badPath) => {
    expect(() => resolvePluginServiceProxyUrl('my-plugin', badPath)).toThrow(TypeError);
  });

  it('rejects non-string path and invalid pluginId', () => {
    expect(() => resolvePluginServiceProxyUrl('my-plugin', null as unknown as string)).toThrow(TypeError);
    expect(() => resolvePluginServiceProxyUrl('../evil', '/status')).toThrow(TypeError);
    expect(() => resolvePluginServiceProxyUrl('BAD_ID', '/status')).toThrow(TypeError);
  });

  it('returns a rejected Promise (never throws synchronously) on unsafe paths or invalid headers without calling fetch', async () => {
    vi.stubGlobal('document', {
      querySelector: (selector: string) => (
        selector === 'meta[name="botmux-csrf"]'
          ? { getAttribute: (name: string) => (name === 'content' ? 'csrf-ticket-123' : null) }
          : null
      ),
    });
    const calls: unknown[] = [];
    const mockFetch = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response('ok');
    }) as typeof fetch;
    const api = createPluginDashboardApi('my-plugin', mockFetch);

    for (const badPath of ['https://evil.example/steal', '../bots', '/a%00b', '/v1/users/.. ']) {
      const promise = api.serviceFetch(badPath);
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).rejects.toThrow(TypeError);
    }
    const badHeaderPromise = api.serviceFetch('/ok', { headers: { 'bad header': 'value' } });
    expect(badHeaderPromise).toBeInstanceOf(Promise);
    await expect(badHeaderPromise).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('injects x-botmux-csrf, forces same-origin credentials and manual redirect, and supports record, tuple, iterable, Headers, FormData, and omitted init', async () => {
    vi.stubGlobal('document', {
      querySelector: (selector: string) => (
        selector === 'meta[name="botmux-csrf"]'
          ? { getAttribute: (name: string) => (name === 'content' ? 'csrf-ticket-123' : null) }
          : null
      ),
    });

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = createPluginDashboardApi('my-plugin', mockFetch);
    const controller = new AbortController();
    const res = await api.serviceFetch('/tasks?mode=sync', {
      method: 'POST',
      headers: {
        'x-custom': 'val',
        'x-botmux-csrf': 'caller-spoofed',
        'x-optional': undefined as unknown as string,
      },
      body: JSON.stringify({ title: 'demo' }),
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });

    expect(res.status).toBe(201);
    expect(calls[0].url).toBe('/api/plugins/my-plugin/service/tasks?mode=sync');
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(calls[0].init?.redirect).toBe('manual');
    expect(calls[0].init?.signal).toBe(controller.signal);
    const h0 = calls[0].init?.headers as Headers;
    expect(h0.get('x-botmux-csrf')).toBe('csrf-ticket-123');
    expect(h0.get('x-custom')).toBe('val');
    expect(h0.has('x-optional')).toBe(false);
    expect(h0.has('content-type')).toBe(false);

    // FormData body passthrough (no forced content-type)
    const formData = new FormData();
    formData.set('file', 'hello');
    await api.serviceFetch('/upload', { method: 'POST', body: formData });
    expect(calls[1].init?.body).toBe(formData);
    expect((calls[1].init?.headers as Headers).has('content-type')).toBe(false);
    expect((calls[1].init?.headers as Headers).get('x-botmux-csrf')).toBe('csrf-ticket-123');

    // Tuple-array HeadersInit
    await api.serviceFetch('/tuple', {
      headers: [['x-a', '1'], ['x-b', '2'], ['x-botmux-csrf', 'spoofed']],
    });
    const h2 = calls[2].init?.headers as Headers;
    expect(h2.get('x-a')).toBe('1');
    expect(h2.get('x-b')).toBe('2');
    expect(h2.get('x-botmux-csrf')).toBe('csrf-ticket-123');

    // Generic iterable HeadersInit (Map / cross-realm iterable)
    const iterableHeaders = new Map<string, string>([['x-iter', 'ok'], ['x-botmux-csrf', 'spoof']]);
    await api.serviceFetch('/iter', { headers: iterableHeaders as unknown as HeadersInit });
    const h3 = calls[3].init?.headers as Headers;
    expect(h3.get('x-iter')).toBe('ok');
    expect(h3.get('x-botmux-csrf')).toBe('csrf-ticket-123');

    // Omitted init
    await api.serviceFetch('/status');
    expect(calls[4].url).toBe('/api/plugins/my-plugin/service/status');
    expect(calls[4].init?.credentials).toBe('same-origin');
    expect(calls[4].init?.redirect).toBe('manual');
    expect((calls[4].init?.headers as Headers).get('x-botmux-csrf')).toBe('csrf-ticket-123');
  });

  it('strips caller-supplied x-botmux-csrf when meta tag is absent and does not mutate caller Headers', async () => {
    vi.stubGlobal('document', { querySelector: () => null });
    let captured: Headers | undefined;
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.headers as Headers;
      return new Response('ok');
    }) as typeof fetch;

    const api = createPluginDashboardApi('my-plugin', mockFetch);
    const callerHeaders = new Headers({ 'x-botmux-csrf': 'stale', accept: 'text/event-stream' });
    await api.serviceFetch('/events', { headers: callerHeaders });

    expect(captured?.has('x-botmux-csrf')).toBe(false);
    expect(captured?.get('accept')).toBe('text/event-stream');
    expect(callerHeaders.get('x-botmux-csrf')).toBe('stale');
  });

  it('classifies 401 responses accurately in classifyFetchUnauthorized without suppressing genuine Dashboard auth expiry', () => {
    const base = 'https://m-123.example.test/#/plugins/my-plugin';
    const makeRes = (headers: Record<string, string> = {}) => ({
      status: 401,
      headers: new Headers(headers),
    });

    // Marked upstream 401 on /api/plugins/:id/service* is ignored (passed to plugin caller)
    expect(classifyFetchUnauthorized({
      input: '/api/plugins/my-plugin/service',
      response: makeRes({ 'x-botmux-plugin-proxy': '1' }),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'ignore' });
    expect(classifyFetchUnauthorized({
      input: '/api/plugins/my-plugin/service/status',
      response: makeRes({ 'x-botmux-plugin-proxy': '1' }),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'ignore' });

    // Unmarked 401 on /api/plugins/:id/service/* STILL triggers Dashboard auth-expired overlay
    expect(classifyFetchUnauthorized({
      input: '/api/plugins/my-plugin/service/status',
      response: makeRes(),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'auth-expired' });

    // Marked 401 on non-service paths is NOT suppressed
    expect(classifyFetchUnauthorized({
      input: '/api/plugins/my-plugin/services/start',
      response: makeRes({ 'x-botmux-plugin-proxy': '1' }),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'auth-expired' });

    // Cross-origin 401 (string, URL, Request) is ignored (prevents phishing loginUrl hijack)
    expect(classifyFetchUnauthorized({
      input: 'https://other.example/api/settings',
      response: makeRes({ 'x-botmux-login-url': 'https://phish.example' }),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'ignore' });
    expect(classifyFetchUnauthorized({
      input: new URL('https://other.example/api/settings'),
      response: makeRes(),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'ignore' });

    // Workbench scope 401 is ignored
    expect(classifyFetchUnauthorized({
      input: '/api/settings',
      response: makeRes({ 'x-botmux-auth-scope': 'workbench' }),
      locationHref: base,
      publicReadOnly: false,
    })).toEqual({ kind: 'ignore' });

    // Request method extraction and publicReadOnly behavior
    expect(classifyFetchUnauthorized({
      input: new Request('https://m-123.example.test/api/foo', { method: 'POST' }),
      response: makeRes(),
      locationHref: base,
      publicReadOnly: true,
    })).toEqual({ kind: 'readonly-toast' });
    expect(classifyFetchUnauthorized({
      input: new Request('https://m-123.example.test/api/foo', { method: 'POST' }),
      init: { method: 'GET' },
      response: makeRes({ 'x-botmux-login-url': 'https://auth.example.test/login' }),
      locationHref: base,
      publicReadOnly: true,
    })).toEqual({ kind: 'auth-expired', loginUrl: 'https://auth.example.test/login' });
  });
});
