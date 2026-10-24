import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOT_PROXY_ROUTES,
  type ProxyMethod,
  type ProxyRoute,
} from '../src/dashboard/daemon-proxy-routes.js';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from '../src/dashboard/reply-style.js';
import { ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES } from '../src/im/lark/ask-option-layout.js';
import { proxyRouteFor, resolveUpstream, runProxyRoute } from './helpers/daemon-proxy-harness.js';

const JSON_HEAD = { 'content-type': 'application/json' };

/** 按值钉住整张表：method、示例 pathname、实际转发到的上游路径、body 模式。 */
const EXPECTED: ReadonlyArray<readonly [ProxyMethod, string, string, string]> = [
  ['PUT', '/api/bots/cli_a/working-dir-mode', '/api/bot-working-dir-mode', 'raw'],
  ['PUT', '/api/bots/cli_a/agent', '/api/bot-agent', 'raw'],
  ['PUT', '/api/bots/cli_a/skills', '/api/bot-skills', 'raw'],
  ['PUT', '/api/bots/cli_a/brand-label', '/api/bot-brand-label', 'raw'],
  ['PUT', '/api/bots/cli_a/reply-style', '/api/bot-reply-style', 'json'],
  ['PUT', '/api/bots/cli_a/ask-option-layout', '/api/bot-ask-option-layout', 'json'],
  ['PUT', '/api/bots/cli_a/startup-commands', '/api/bot-startup-commands', 'raw'],
  ['PUT', '/api/bots/cli_a/custom-passthrough', '/api/bot-custom-passthrough', 'raw'],
  ['PUT', '/api/bots/cli_a/cantalk-daemon-commands', '/api/bot-cantalk-daemon-commands', 'raw'],
  ['PUT', '/api/bots/cli_a/launch-shell', '/api/bot-launch-shell', 'raw'],
  ['PUT', '/api/bots/cli_a/oncall-group', '/api/bot-oncall-group', 'raw'],
  ['PUT', '/api/bots/cli_a/steward', '/api/bot-steward', 'json'],
  ['PUT', '/api/bots/cli_a/actor-owner-bindings', '/api/bot-actor-owner-bindings', 'raw'],
  ['PUT', '/api/bots/cli_a/feedback', '/api/bot-feedback', 'raw'],
  ['PUT', '/api/bots/cli_a/chats/oc_1/feedback', '/api/chat-feedback/oc_1', 'raw'],
  ['GET', '/api/bots/cli_a/feedback/effective', '/api/feedback-effective', 'none'],
  ['PUT', '/api/bots/cli_a/env', '/api/bot-env', 'raw'],
  ['PUT', '/api/bots/cli_a/env-policy', '/api/bot-env-policy', 'raw'],
  ['PUT', '/api/bots/cli_a/codex-auth-sync', '/api/bot-codex-auth-sync', 'raw'],
  ['PUT', '/api/bots/cli_a/trigger-user-auth', '/api/bot-trigger-user-auth', 'raw'],
  ['PUT', '/api/bots/cli_a/lark-tool-binding', '/api/bot-lark-tool-binding', 'raw'],
  ['GET', '/api/bots/cli_a/trigger-user-auth-status', '/api/bot-trigger-user-auth-status', 'none'],
  ['PUT', '/api/bots/cli_a/riff', '/api/bot-riff', 'raw'],
  ['PUT', '/api/bots/cli_a/herdr', '/api/bot-herdr', 'raw'],
  ['PUT', '/api/bots/cli_a/sandbox-network-policy', '/api/bot-sandbox-network-policy', 'raw'],
  ['PUT', '/api/bots/cli_a/sandbox-paths', '/api/bot-sandbox-paths', 'raw'],
  ['PUT', '/api/bots/cli_a/sandbox', '/api/bot-sandbox', 'raw'],
  ['PUT', '/api/bots/cli_a/read-isolation', '/api/bot-read-isolation', 'raw'],
  ['PUT', '/api/bots/cli_a/backend-type', '/api/bot-backend-type', 'raw'],
  ['PUT', '/api/bots/cli_a/card-prefs', '/api/bot-card-prefs', 'raw'],
  ['PUT', '/api/bots/cli_a/substitute-mode', '/api/bot-substitute-mode', 'raw'],
  ['POST', '/api/bots/cli_a/substitute-targets/resolve', '/api/bot-substitute-targets/resolve', 'raw'],
  ['PUT', '/api/bots/cli_a/summary-range', '/api/bot-summary-range', 'raw'],
  ['GET', '/api/bots/cli_a/session-group-tag-status', '/api/session-group-tag-status', 'none'],
  ['POST', '/api/bots/cli_a/session-group-tag-auth', '/api/session-group-tag-auth', 'raw'],
  ['PUT', '/api/bots/cli_a/session-group-tag-config', '/api/session-group-tag-config', 'raw'],
  ['PUT', '/api/bots/cli_a/p2p-mode', '/api/bot-p2p-mode', 'raw'],
  ['PUT', '/api/bots/cli_a/envelope-injection', '/api/bot-envelope-injection', 'raw'],
  ['PUT', '/api/bots/cli_a/prompt-injection', '/api/bot-prompt-injection', 'raw'],
  ['PUT', '/api/bots/cli_a/topic-unavailable-policy', '/api/bot-topic-unavailable-policy', 'raw'],
  ['PUT', '/api/bots/cli_a/reply-delivery', '/api/bot-reply-delivery', 'raw'],
  ['PUT', '/api/bots/cli_a/skill-injection', '/api/bot-skill-injection', 'raw'],
  ['PUT', '/api/bots/cli_a/grant-prefs', '/api/bot-grant-prefs', 'raw'],
  ['PUT', '/api/bots/cli_a/rename', '/api/bot-rename', 'raw'],
  ['GET', '/api/bots/cli_a/description', '/api/bot-description', 'none'],
  ['PUT', '/api/bots/cli_a/description', '/api/bot-description', 'raw'],
  ['PUT', '/api/bots/cli_a/avatar', '/api/bot-avatar', 'raw'],
  ['PUT', '/api/bots/cli_a/max-live-workers', '/api/bot-max-live-workers', 'raw'],
  ['PUT', '/api/bots/cli_a/no-progress-notify', '/api/bot-no-progress-notify', 'raw'],
  ['PUT', '/api/bots/cli_a/prompt-cache', '/api/bot-prompt-cache', 'raw'],
  ['PUT', '/api/bots/cli_a/idle-suspend-minutes', '/api/bot-idle-suspend-minutes', 'raw'],
  ['PUT', '/api/bots/cli_a/session-owner-reminder', '/api/bot-session-owner-reminder', 'raw'],
  ['GET', '/api/bots/cli_a/blocked-users', '/api/blocked-users', 'none'],
  ['PUT', '/api/bots/cli_a/blocked-users', '/api/blocked-users', 'raw'],
  ['POST', '/api/bots/cli_a/grants/chat', '/api/grants/chat', 'raw'],
  ['PUT', '/api/bots/cli_a/chat-group-grant', '/api/chat-group-grant', 'raw'],
];

/** 把 path 正则里的捕获组换成示例值，得到能命中它的 pathname。 */
function samplePathname(route: ProxyRoute): string {
  let n = 0;
  return route.path.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\[\^\/\]\+\)/g, () => (n++ === 0 ? 'cli_a' : 'oc_1'));
}

describe('BOT_PROXY_ROUTES table', () => {
  it('pins every entry by value (method, upstream path, body mode)', () => {
    expect(BOT_PROXY_ROUTES).toHaveLength(EXPECTED.length);
    for (const [method, pathname, upstream, kind] of EXPECTED) {
      const route = proxyRouteFor(method, pathname);
      expect(route, `${method} ${pathname}`).toBeDefined();
      expect(resolveUpstream(route!, pathname), `${method} ${pathname}`).toBe(upstream);
      expect(route!.body.kind, `${method} ${pathname}`).toBe(kind);
    }
  });

  it('keeps entries mutually exclusive, so table order never decides a match', () => {
    for (const route of BOT_PROXY_ROUTES) {
      const sample = samplePathname(route);
      const hits = BOT_PROXY_ROUTES.filter(other => other.method === route.method && other.path.test(sample));
      expect(hits, `${route.method} ${sample}`).toEqual([route]);
    }
  });

  it('anchors every path and captures the bot appId as group 1', () => {
    for (const route of BOT_PROXY_ROUTES) {
      expect(route.path.source.startsWith('^'), route.path.source).toBe(true);
      expect(route.path.source.endsWith('$'), route.path.source).toBe(true);
      expect(route.path.exec(samplePathname(route))?.[1], route.path.source).toBe('cli_a');
    }
  });

  it('expresses the historically inconsistent body handling as per-route fields', () => {
    const bodyOf = (method: ProxyMethod, pathname: string) => proxyRouteFor(method, pathname)!.body;
    expect(bodyOf('PUT', '/api/bots/a/sandbox-network-policy')).toEqual({ kind: 'raw', emptyAs: '' });
    expect(bodyOf('PUT', '/api/bots/a/description')).toEqual({
      kind: 'raw',
      cap: { maxBytes: 64 * 1024, error: 'body_too_large' },
    });
    expect(bodyOf('PUT', '/api/bots/a/avatar')).toEqual({
      kind: 'raw',
      cap: { maxBytes: 4_000_000, error: 'image_too_large' },
    });
    expect(bodyOf('PUT', '/api/bots/a/reply-style')).toEqual({ kind: 'json', maxBytes: REPLY_STYLE_REQUEST_MAX_BYTES });
    expect(bodyOf('PUT', '/api/bots/a/ask-option-layout')).toEqual({
      kind: 'json',
      maxBytes: ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES,
    });
    expect(bodyOf('GET', '/api/bots/a/session-group-tag-status')).toEqual({ kind: 'none', jsonHeader: true });
    expect(bodyOf('GET', '/api/bots/a/description')).toEqual({ kind: 'none' });
  });
});

describe('handleDaemonProxyRoute: raw body routes', () => {
  it('forwards the body verbatim and writes back the upstream status and text untouched', async () => {
    const out = await runProxyRoute({
      method: 'PUT',
      url: '/api/bots/cli_a/backend-type',
      body: '{"backendType":"tmux"}',
      upstream: new Response('{"ok":false,"error":"nope"}', { status: 422 }),
    });
    expect(out.handled).toBe(true);
    expect(out.proxyCalls).toEqual([{
      appId: 'cli_a',
      path: '/api/bot-backend-type',
      init: { method: 'PUT', headers: JSON_HEAD, body: '{"backendType":"tmux"}' },
    }]);
    expect(out.head).toEqual([422, JSON_HEAD]);
    expect(out.body).toBe('{"ok":false,"error":"nope"}');
  });

  it('defaults an empty body to "{}" but does not trim or validate a non-empty one', async () => {
    const empty = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/card-prefs' });
    expect(empty.proxyCalls[0]!.init.body).toBe('{}');
    const blank = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/card-prefs', body: '  ' });
    expect(blank.proxyCalls[0]!.init.body).toBe('  ');
    const garbage = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/card-prefs', body: '{not json' });
    expect(garbage.proxyCalls[0]!.init.body).toBe('{not json');
  });

  it('joins chunks before decoding, so a multi-byte character split across chunks survives', async () => {
    const text = Buffer.from('{"name":"机器人😀"}');
    const out = await runProxyRoute({
      method: 'PUT',
      url: '/api/bots/cli_a/rename',
      body: [text.subarray(0, 10), text.subarray(10)],
    });
    expect(out.proxyCalls[0]!.init.body).toBe('{"name":"机器人😀"}');
  });

  it('keeps an empty sandbox-network-policy body empty (no "{}" fallback)', async () => {
    const out = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/sandbox-network-policy' });
    expect(out.proxyCalls[0]!.init.body).toBe('');
  });

  it('url-decodes the appId and forwards POST routes with their own method', async () => {
    const out = await runProxyRoute({
      method: 'POST',
      url: '/api/bots/cli%2Fa%40x/substitute-targets/resolve',
      body: '{"target":"x"}',
    });
    expect(out.proxyCalls).toHaveLength(1);
    expect(out.proxyCalls[0]!.appId).toBe('cli/a@x');
    expect(out.proxyCalls[0]!.path).toBe('/api/bot-substitute-targets/resolve');
    expect(out.proxyCalls[0]!.init.method).toBe('POST');
  });

  it('surfaces a proxyToDaemon failure to the caller without writing a response', async () => {
    const out = await runProxyRoute({
      method: 'PUT',
      url: '/api/bots/cli_a/agent',
      body: '{}',
      upstream: () => { throw new Error('daemon_down'); },
    });
    expect((out.error as Error).message).toBe('daemon_down');
    expect(out.head).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  it('writes the status line before it has the upstream text (order kept from the hand-written blocks)', async () => {
    const broken = { status: 207, text: async () => { throw new Error('text_failed'); } } as unknown as Response;
    const out = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/agent', body: '{}', upstream: () => broken });
    expect((out.error as Error).message).toBe('text_failed');
    expect(out.head).toEqual([207, JSON_HEAD]);
    expect(out.body).toBeUndefined();
  });
});

describe('handleDaemonProxyRoute: bodies with a byte cap', () => {
  it('bounds PUT description at 64KiB: the boundary passes, one byte more is 413 and never forwarded', async () => {
    const ok = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/description', body: Buffer.alloc(64 * 1024, 0x61) });
    expect(ok.proxyCalls).toHaveLength(1);
    const over = await runProxyRoute({
      method: 'PUT',
      url: '/api/bots/cli_a/description',
      body: [Buffer.alloc(40_000, 0x61), Buffer.alloc(25_537, 0x61)],
    });
    expect(over.handled).toBe(true);
    expect(over.proxyCalls).toEqual([]);
    expect(over.head).toEqual([413, JSON_HEAD]);
    expect(JSON.parse(over.body!)).toEqual({ ok: false, error: 'body_too_large' });
  });

  it('bounds PUT avatar at 4,000,000 bytes and reports image_too_large', async () => {
    const ok = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/avatar', body: Buffer.alloc(4_000_000, 0x61) });
    expect(ok.proxyCalls).toHaveLength(1);
    const over = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/avatar', body: Buffer.alloc(4_000_001, 0x61) });
    expect(over.proxyCalls).toEqual([]);
    expect(over.head).toEqual([413, JSON_HEAD]);
    expect(JSON.parse(over.body!)).toEqual({ ok: false, error: 'image_too_large' });
  });

  it('leaves unbounded routes unbounded', async () => {
    const out = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/skills', body: Buffer.alloc(5_000_000, 0x61) });
    expect(out.proxyCalls).toHaveLength(1);
  });
});

describe('handleDaemonProxyRoute: JSON-validated routes', () => {
  it.each([
    ['reply-style', '/api/bot-reply-style', REPLY_STYLE_REQUEST_MAX_BYTES],
    ['ask-option-layout', '/api/bot-ask-option-layout', ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES],
  ])('%s: forwards the re-serialised JSON to the exact daemon route', async (segment, upstream) => {
    const out = await runProxyRoute({ method: 'PUT', url: `/api/bots/cli_a/${segment}`, body: ' { "a" : [1, 2] } ' });
    expect(out.proxyCalls).toEqual([{
      appId: 'cli_a',
      path: upstream,
      init: { method: 'PUT', headers: JSON_HEAD, body: '{"a":[1,2]}' },
    }]);
  });

  it.each([
    ['reply-style', REPLY_STYLE_REQUEST_MAX_BYTES],
    ['ask-option-layout', ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES],
  ])('%s: maps malformed JSON to 400 bad_json and an oversized body to 413 body_too_large', async (segment, maxBytes) => {
    const malformed = await runProxyRoute({ method: 'PUT', url: `/api/bots/cli_a/${segment}`, body: '{oops' });
    expect(malformed.head).toEqual([400, JSON_HEAD]);
    expect(JSON.parse(malformed.body!)).toEqual({ ok: false, error: 'bad_json' });
    expect(malformed.proxyCalls).toEqual([]);

    const big = await runProxyRoute({
      method: 'PUT',
      url: `/api/bots/cli_a/${segment}`,
      body: `"${'a'.repeat(maxBytes)}"`,
    });
    expect(big.head).toEqual([413, JSON_HEAD]);
    expect(JSON.parse(big.body!)).toEqual({ ok: false, error: 'body_too_large' });
    expect(big.proxyCalls).toEqual([]);
  });

  it('empty body validates as {} and is forwarded as "{}"', async () => {
    const out = await runProxyRoute({ method: 'PUT', url: '/api/bots/cli_a/reply-style' });
    expect(out.proxyCalls[0]!.init.body).toBe('{}');
  });
});

describe('handleDaemonProxyRoute: body-less and path-rewriting routes', () => {
  it('forwards GET description and trigger-user-auth-status as bare { method } without reading the request', async () => {
    for (const [pathname, upstream] of [
      ['/api/bots/cli_a/description', '/api/bot-description'],
      ['/api/bots/cli_a/trigger-user-auth-status', '/api/bot-trigger-user-auth-status'],
    ] as const) {
      const out = await runProxyRoute({ method: 'GET', url: pathname, body: 'ignored' });
      expect(out.proxyCalls).toEqual([{ appId: 'cli_a', path: upstream, init: { method: 'GET' } }]);
      expect(out.bodyConsumed).toBe(false);
    }
  });

  it('session-group-tag-status keeps the content-type header on GET, the other GETs do not', async () => {
    const out = await runProxyRoute({ method: 'GET', url: '/api/bots/cli_a/session-group-tag-status' });
    expect(out.proxyCalls[0]!.init).toEqual({ method: 'GET', headers: JSON_HEAD });
    expect('body' in out.proxyCalls[0]!.init).toBe(false);
  });

  it('feedback/effective passes the query string through verbatim', async () => {
    const out = await runProxyRoute({ method: 'GET', url: '/api/bots/cli_a/feedback/effective?chatId=oc_1&x=%E4' });
    expect(out.proxyCalls[0]!.path).toBe('/api/feedback-effective?chatId=oc_1&x=%E4');
    const bare = await runProxyRoute({ method: 'GET', url: '/api/bots/cli_a/feedback/effective' });
    expect(bare.proxyCalls[0]!.path).toBe('/api/feedback-effective');
  });

  it('chat-feedback decodes then re-encodes the chat id into the upstream path', async () => {
    const out = await runProxyRoute({
      method: 'PUT',
      url: '/api/bots/cli%2Fa/chats/oc%2F1%20x/feedback',
      body: '{"feedback":null}',
    });
    expect(out.proxyCalls).toEqual([{
      appId: 'cli/a',
      path: '/api/chat-feedback/oc%2F1%20x',
      init: { method: 'PUT', headers: JSON_HEAD, body: '{"feedback":null}' },
    }]);
  });
});

describe('handleDaemonProxyRoute: matching and fall-through', () => {
  it('returns false and leaves the request untouched for a non-matching path', async () => {
    for (const url of ['/api/bots/cli_a', '/api/bots/cli_a/unknown', '/api/bots//agent', '/api/bots/cli_a/agent/extra', '/api/other']) {
      const out = await runProxyRoute({ method: 'PUT', url, body: '{}' });
      expect(out.handled, url).toBe(false);
      expect(out.proxyCalls, url).toEqual([]);
      expect(out.head, url).toBeUndefined();
      expect(out.bodyConsumed, url).toBe(false);
    }
  });

  it('falls through on a method the path has no entry for, without consuming the body', async () => {
    const methods: ProxyMethod[] = ['GET', 'PUT', 'POST'];
    for (const route of BOT_PROXY_ROUTES) {
      const pathname = samplePathname(route);
      for (const method of [...methods, 'DELETE', 'PATCH']) {
        if (BOT_PROXY_ROUTES.some(r => r.method === method && r.path.test(pathname))) continue;
        const out = await runProxyRoute({ method, url: pathname, body: '{}' });
        expect(out.handled, `${method} ${pathname}`).toBe(false);
        expect(out.proxyCalls, `${method} ${pathname}`).toEqual([]);
        expect(out.bodyConsumed, `${method} ${pathname}`).toBe(false);
      }
    }
  });

  it('only matches the exact path: a longer or prefixed segment is not swallowed', async () => {
    for (const url of ['/api/bots/cli_a/sandbox-paths', '/api/bots/cli_a/sandbox', '/api/bots/cli_a/sandbox-network-policy']) {
      const out = await runProxyRoute({ method: 'PUT', url, body: '{}' });
      expect(out.proxyCalls).toHaveLength(1);
      expect(out.proxyCalls[0]!.path).toBe(`/api/bot-${url.split('/').pop()}`);
    }
  });
});

describe('handleDaemonProxyRoute: when the appId is url-decoded', () => {
  const BAD = '%E0%A4%A';

  it('default routes decode after method+path match and before reading the body', async () => {
    const out = await runProxyRoute({ method: 'PUT', url: `/api/bots/${BAD}/agent`, body: '{}' });
    expect(out.error).toBeInstanceOf(URIError);
    expect(out.bodyConsumed).toBe(false);
    expect(out.proxyCalls).toEqual([]);
    // 方法不符时不解码，直接 fall through。
    const miss = await runProxyRoute({ method: 'GET', url: `/api/bots/${BAD}/agent` });
    expect(miss.error).toBeUndefined();
    expect(miss.handled).toBe(false);
  });

  it.each([
    'oncall-group',
    'sandbox-network-policy',
    'chats/oc_1/feedback',
  ])('PUT %s decodes only after the whole body has been read', async (tail) => {
    const out = await runProxyRoute({ method: 'PUT', url: `/api/bots/${BAD}/${tail}`, body: '{}' });
    expect(out.error).toBeInstanceOf(URIError);
    expect(out.bodyConsumed).toBe(true);
    expect(out.proxyCalls).toEqual([]);
  });

  it('multi-method routes (blocked-users, session-group-tag-*) decode as soon as the path matches', async () => {
    // 原先共用一个正则的手写块：方法不符的请求也会因非法 % 抛 URIError，而不是 fall through。
    for (const [method, tail] of [
      ['DELETE', 'blocked-users'],
      ['POST', 'session-group-tag-status'],
      ['GET', 'session-group-tag-auth'],
      ['DELETE', 'session-group-tag-config'],
    ]) {
      const out = await runProxyRoute({ method, url: `/api/bots/${BAD}/${tail}` });
      expect(out.error, `${method} ${tail}`).toBeInstanceOf(URIError);
      expect(out.bodyConsumed).toBe(false);
    }
    const ok = await runProxyRoute({ method: 'DELETE', url: '/api/bots/cli_a/blocked-users' });
    expect(ok.error).toBeUndefined();
    expect(ok.handled).toBe(false);
  });
});

describe('dashboard.ts hand-written /api/bots routes', () => {
  const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

  // 源码结构护栏(K4)：dashboard.ts 请求闭包里仍手写（未导出）的 /api/bots 路由必须与
  // BOT_PROXY_ROUTES 表互斥，表的分发位置才不影响匹配结果；quota-fallback 带 daemon 离线时的
  // 本地 bots.json 兜底，不能并进纯转发表。一份事实只存在于闭包源码，无法 import 双方比较。
  // 来源：#1902 把纯转发路由改为表驱动时的等价前提。
  it('stay disjoint from the proxy table, and quota-fallback stays out of the table', () => {
    const handWritten = [...source.matchAll(/url\.pathname\.match\((\/\^\\\/api\\\/bots\\\/[^\n]*?\$\/)\)/g)]
      .map(m => m[1]);
    const exact = [...source.matchAll(/url\.pathname === '(\/api\/bots[^']*)'/g)].map(m => m[1]);
    // 非空：提取正则一旦失配，下面的互斥循环会空转变绿。
    expect(handWritten.length).toBeGreaterThan(0);
    for (const literal of handWritten) {
      const re = new RegExp(literal.slice(1, literal.lastIndexOf('/')));
      for (const route of BOT_PROXY_ROUTES) {
        expect(re.test(samplePathname(route)), `${literal} vs ${route.path.source}`).toBe(false);
      }
    }
    for (const route of BOT_PROXY_ROUTES) expect(exact).not.toContain(samplePathname(route));
    expect(BOT_PROXY_ROUTES.some(route => route.path.test('/api/bots/cli_a/quota-fallback'))).toBe(false);
  });
});
