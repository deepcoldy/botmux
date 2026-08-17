import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PREVIEW_SANDBOX_TOKENS,
  createSessionPreviewProxy,
  previewRequestHeaders,
  type PreviewProxyResolution,
} from '../src/dashboard/preview-proxy.js';
import { PREVIEW_CONTENT_SEGMENT } from '../src/core/session-preview.js';
import { AuthSessionConnectionRegistry } from '../src/dashboard/auth-session-connections.js';
import { managementUpgradeOrigin } from '../src/dashboard/control-csrf.js';

const DASHBOARD_TOKEN = 'management-token-must-not-leak';
const TARGET_TIME = '2026-08-11T12:00:00.000Z';
/** Stand-in for a minted capability; the proxy only sees an opaque string. */
const CAPABILITY = 'bmxpv1.valid-capability-for-s1';
const contentBase = (sessionId: string, capability = CAPABILITY): string =>
  `/preview/${sessionId}/${PREVIEW_CONTENT_SEGMENT}/${capability}`;
let front: Server | null = null;
let upstream: Server | null = null;
let upstreamWss: WebSocketServer | null = null;
const openSockets = new Set<WebSocket>();

afterEach(async () => {
  for (const ws of openSockets) ws.terminate();
  openSockets.clear();
  if (upstreamWss) await new Promise<void>(resolve => upstreamWss!.close(() => resolve()));
  upstreamWss = null;
  if (front) await new Promise<void>(resolve => front!.close(() => resolve()));
  front = null;
  if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()));
  upstream = null;
});

function managementCookie(): string {
  return `botmux_dashboard_token=${DASHBOARD_TOKEN}`;
}

async function startFront(resolveTarget: (sessionId: string) => PreviewProxyResolution): Promise<number> {
  const manager = createSessionPreviewProxy({
    authenticated: req => req.headers.cookie?.split(';').some(part => part.trim() === managementCookie()) === true,
    resolve: resolveTarget,
    verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
  });
  front = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    void manager.handleHttp(req, res, url).then(handled => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end('not preview'); }
    });
  });
  front.on('upgrade', (req, socket, head) => {
    if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(resolve => front!.listen(0, '127.0.0.1', resolve));
  return (front.address() as { port: number }).port;
}

async function startUpstream(): Promise<{
  port: number;
  httpRequests: Array<{ url: string; headers: IncomingMessage['headers'] }>;
  wsRequests: Array<{ url: string; headers: IncomingMessage['headers'] }>;
}> {
  const httpRequests: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
  const wsRequests: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
  upstream = createServer((req, res) => {
    httpRequests.push({ url: req.url ?? '', headers: { ...req.headers } });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, {
        location: '/login?from=preview',
        'set-cookie': 'preview_session=should-be-dropped; Path=/',
        'clear-site-data': '"cookies"',
      });
      res.end();
      return;
    }
    if (req.url?.startsWith('/wide-cors')) {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
      });
      res.end('app cors');
      return;
    }
    if (req.url?.startsWith('/with-csp')) {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'",
      });
      res.end('app policy');
      return;
    }
    if (req.url?.startsWith('/absolute-redirect')) {
      const localPort = (upstream!.address() as { port: number }).port;
      res.writeHead(302, { location: `http://localhost:${localPort}/signed-in` });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': 'preview_session=should-be-dropped; Path=/',
    });
    res.end(`upstream:${req.url}`);
  });
  upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (ws, req) => {
    wsRequests.push({ url: req.url ?? '', headers: { ...req.headers } });
    ws.send(`path:${req.url}`);
    ws.on('message', data => ws.send(`echo:${data.toString()}`));
  });
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
  return {
    port: (upstream.address() as { port: number }).port,
    httpRequests,
    wsRequests,
  };
}

function okTarget(port: number): PreviewProxyResolution {
  return {
    ok: true,
    target: { host: '127.0.0.1', port, registeredAt: TARGET_TIME },
  };
}

function websocketStatus(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('unexpected WebSocket open')); });
    ws.once('error', () => { /* unexpected-response is authoritative */ });
    setTimeout(() => reject(new Error('WebSocket status timeout')), 4_000).unref();
  });
}

describe('session preview same-origin reverse proxy', () => {
  it('attaches a client error handler synchronously on validation/auth failures', () => {
    const manager = createSessionPreviewProxy({
      authenticated: () => false,
      resolve: () => ({ ok: false, status: 404, error: 'unknown_session' }),
      verifyContentCapability: () => false,
    });
    const socket = new PassThrough();
    const req = { url: '/preview/s1/ws', method: 'GET', headers: {} } as IncomingMessage;
    expect(manager.handleUpgrade(req, socket, Buffer.alloc(0))).toBe(true);
    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(() => socket.emit('error', new Error('browser disconnected'))).not.toThrow();
  });

  it('drops hop-by-hop and Connection-nominated headers while preserving a WS upgrade', () => {
    const target = { host: '127.0.0.1' as const, port: 3000, registeredAt: TARGET_TIME };
    const headers = previewRequestHeaders({
      host: 'dashboard.example',
      connection: 'keep-alive, x-hop-secret',
      'x-hop-secret': 'must-not-cross',
      'proxy-connection': 'keep-alive',
      te: 'trailers',
      trailer: 'x-checksum',
      upgrade: 'websocket',
      'sec-websocket-key': 'public-handshake-value',
    }, target, { upgrade: true });
    expect(headers).toEqual({
      host: '127.0.0.1:3000',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'public-handshake-value',
    });
  });

  it('proxies HTTP path/query while stripping all dashboard credentials', async () => {
    const target = await startUpstream();
    const port = await startFront(sessionId => sessionId === 's1'
      ? okTarget(target.port)
      : { ok: false, status: 404, error: 'unknown_session' });

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/api/data?q=1`, {
      headers: {
        cookie: `${managementCookie()}; unrelated=also-sensitive`,
        authorization: 'Bearer should-not-leak',
        'proxy-authorization': 'Basic should-not-leak',
        'x-botmux-cli-auth': 'should-not-leak',
        'x-forwarded-host': 'attacker.example',
        referer: `http://dashboard.test/?t=${DASHBOARD_TOKEN}`,
        origin: 'http://dashboard.test',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream:/api/data?q=1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(target.httpRequests).toHaveLength(1);
    const seen = target.httpRequests[0];
    expect(seen.url).toBe('/api/data?q=1');
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-botmux-cli-auth', 'x-forwarded-host', 'referer']) {
      expect(seen.headers[name], name).toBeUndefined();
    }
    expect(seen.headers.host).toBe(`127.0.0.1:${target.port}`);
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${target.port}`);
    expect(JSON.stringify(seen.headers)).not.toContain(DASHBOARD_TOKEN);
  });

  it('P0: serves the sandboxed content stream on its capability path with no cookie at all', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    // Exactly what the opaque-origin frame sends for a relative subresource:
    // no Cookie (its site-for-cookies is null) and no Origin (no-cors fetch).
    const subresource = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/app.js?v=1`);
    expect(subresource.status).toBe(200);
    expect(await subresource.text()).toBe('upstream:/app.js?v=1');

    // …and what it sends for a CORS fetch or a WebSocket handshake.
    const corsStyle = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/data`, {
      headers: { origin: 'null' },
    });
    expect(corsStyle.status).toBe(200);
    expect(target.httpRequests.map(entry => entry.url)).toEqual(['/app.js?v=1', '/data']);
    for (const seen of target.httpRequests) expect(seen.headers.cookie).toBeUndefined();
  });

  it('P0: refuses the content path without a valid capability and from any real web origin', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    const forged = await fetch(`http://127.0.0.1:${port}${contentBase('s1', 'bmxpv1.forged')}/app.js`);
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ ok: false, error: 'preview_capability_invalid' });

    // A capability minted for one session must not open another's dev server.
    const otherSession = await fetch(`http://127.0.0.1:${port}${contentBase('s2')}/app.js`);
    expect(otherSession.status).toBe(401);

    // The management cookie is NOT an alternative credential here: the content
    // path exists only for the opaque-origin frame.
    const withCookie = await fetch(`http://127.0.0.1:${port}${contentBase('s1', 'bmxpv1.forged')}/app.js`, {
      headers: { cookie: managementCookie() },
    });
    expect(withCookie.status).toBe(401);

    // A leaked capability replayed from a page context (any real origin) is
    // refused before the target is even resolved.
    for (const origin of ['http://dashboard.test', 'https://evil.example', 'http://127.0.0.1:1']) {
      const replay = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/app.js`, {
        headers: { origin },
      });
      expect(replay.status, origin).toBe(403);
      expect(await replay.json()).toEqual({ ok: false, error: 'preview_origin_forbidden' });
    }

    const bareSegment = await fetch(`http://127.0.0.1:${port}/preview/s1/${PREVIEW_CONTENT_SEGMENT}`, {
      headers: { cookie: managementCookie() },
    });
    expect(bareSegment.status).toBe(400);
    expect(await bareSegment.json()).toEqual({ ok: false, error: 'invalid_preview_path' });

    expect(target.httpRequests).toHaveLength(0);
  });

  it('P0: forces every proxied document into an opaque origin via CSP sandbox', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    for (const path of [`${contentBase('s1')}/`, '/preview/s1/lure.html']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { cookie: managementCookie() },
      });
      expect(response.status, path).toBe(200);
      // Even a lured top-level navigation to agent HTML must not land on a
      // usable dashboard origin.
      expect(response.headers.get('content-security-policy'), path)
        .toContain(`sandbox ${PREVIEW_SANDBOX_TOKENS}`);
      expect(response.headers.get('content-security-policy'), path).not.toContain('allow-same-origin');
    }

    const withUpstreamPolicy = await fetch(`http://127.0.0.1:${port}/preview/s1/with-csp`, {
      headers: { cookie: managementCookie() },
    });
    // The app's own policy survives; ours is appended, never replaced by it.
    const policies = withUpstreamPolicy.headers.get('content-security-policy') ?? '';
    expect(policies).toContain("default-src 'self'");
    expect(policies).toContain(`sandbox ${PREVIEW_SANDBOX_TOKENS}`);
  });

  it('lets the opaque-origin app read its OWN dev server without ever allowing credentials', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    const response = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/api/me`, {
      headers: { origin: 'null' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toContain('Origin');

    // Preflights are answered by the proxy so a dev server that never
    // implemented OPTIONS is not the reason its own SPA cannot call it.
    const preflight = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/api/me`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('null');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    // The preflight never touched the app.
    expect(target.httpRequests.map(entry => entry.url)).toEqual(['/api/me']);

    // Bare (cookie-authenticated) preview paths get no CORS grant at all.
    const bare = await fetch(`http://127.0.0.1:${port}/preview/s1/api/me`, {
      headers: { cookie: managementCookie() },
    });
    expect(bare.headers.get('access-control-allow-origin')).toBeNull();

    // An app that ships a wide-open CORS policy does not get to widen the
    // dashboard's boundary: the proxy's answer is the only one that survives.
    const wide = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/wide-cors`, {
      headers: { origin: 'null' },
    });
    expect(wide.headers.get('access-control-allow-origin')).toBe('null');
    expect(wide.headers.get('access-control-allow-credentials')).toBeNull();
    const wideOnBare = await fetch(`http://127.0.0.1:${port}/preview/s1/wide-cors`, {
      headers: { cookie: managementCookie() },
    });
    expect(wideOnBare.headers.get('access-control-allow-origin')).toBeNull();
    expect(wideOnBare.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('keeps app redirects inside the capability path so the frame cannot climb back to the shell', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));
    const response = await fetch(`http://127.0.0.1:${port}${contentBase('s1')}/redirect`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${contentBase('s1')}/login?from=preview`);
    expect(target.httpRequests[0].url).toBe('/redirect');
  });

  it('keeps local redirects inside the same preview prefix and blocks cookie/storage writes', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/redirect`, {
      redirect: 'manual',
      headers: { cookie: managementCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/preview/s1/login?from=preview');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();

    const absolute = await fetch(`http://127.0.0.1:${port}/preview/s1/absolute-redirect`, {
      redirect: 'manual',
      headers: { cookie: managementCookie() },
    });
    expect(absolute.headers.get('location')).toBe('/preview/s1/signed-in');
  });

  it('proxies WebSocket upgrades and strips credentials from the handshake', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/preview/s1/socket?room=alpha`, {
      headers: {
        Cookie: `${managementCookie()}; unrelated=sensitive`,
        Authorization: 'Bearer should-not-leak',
        'X-Botmux-Write-Token': 'should-not-leak',
        Origin: 'http://dashboard.test',
      },
    });
    openSockets.add(ws);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', data => {
        messages.push(data.toString());
        if (messages.length === 2) resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WebSocket proxy timeout')), 4_000).unref();
    });
    await new Promise<void>(resolve => {
      ws.once('close', () => resolve());
      ws.close();
    });
    openSockets.delete(ws);

    expect(messages).toEqual(['path:/socket?room=alpha', 'echo:ping']);
    expect(target.wsRequests).toHaveLength(1);
    const seen = target.wsRequests[0];
    expect(seen.url).toBe('/socket?room=alpha');
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers['x-botmux-write-token']).toBeUndefined();
    expect(seen.headers.origin).toBe(`http://127.0.0.1:${target.port}`);
  });

  it('P0: bridges the sandboxed frame WebSocket on Origin: null but never without the capability', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    const ws = new WebSocket(`ws://127.0.0.1:${port}${contentBase('s1')}/socket?room=hmr`, {
      origin: 'null',
    });
    openSockets.add(ws);
    const first = await new Promise<string>((resolve, reject) => {
      ws.on('message', data => resolve(data.toString()));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WebSocket proxy timeout')), 4_000).unref();
    });
    expect(first).toBe('path:/socket?room=hmr');
    expect(target.wsRequests[0].headers.cookie).toBeUndefined();
    ws.terminate();
    openSockets.delete(ws);

    expect(await websocketStatus(`ws://127.0.0.1:${port}${contentBase('s1', 'bmxpv1.forged')}/socket`, {
      Origin: 'null',
    })).toBe(401);
    // Origin: null is not a credential — a real origin replaying a leaked
    // capability over WebSocket is refused too.
    expect(await websocketStatus(`ws://127.0.0.1:${port}${contentBase('s1')}/socket`, {
      Origin: 'https://evil.example',
    })).toBe(403);
    expect(target.wsRequests).toHaveLength(1);
  });

  it('P0: claims only preview paths, so Origin: null never reaches management or terminal routes', async () => {
    const manager = createSessionPreviewProxy({
      authenticated: () => true,
      resolve: () => okTarget(1),
      verifyContentCapability: () => true,
    });
    const foreign = [
      '/api/sessions',
      '/api/debug-terminal',
      '/debug-terminal/abc/ws',
      '/events',
      '/s/sess-1/ws',
      '/previewer/s1/',
    ];
    for (const pathname of foreign) {
      const url = new URL(pathname, 'http://dashboard.test');
      const res = { writeHead: () => { throw new Error(`claimed ${pathname}`); } } as unknown as never;
      expect(await manager.handleHttp(
        { method: 'GET', headers: { origin: 'null' }, url: pathname } as unknown as IncomingMessage,
        res,
        url,
      ), pathname).toBe(false);
      const socket = new PassThrough();
      expect(manager.handleUpgrade(
        { url: pathname, method: 'GET', headers: { origin: 'null' } } as unknown as IncomingMessage,
        socket,
        Buffer.alloc(0),
      ), pathname).toBe(false);
    }
  });

  it('requires the management cookie for both HTTP and WebSocket', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'authentication_required' });
    expect(await websocketStatus(`ws://127.0.0.1:${port}/preview/s1/ws`)).toBe(401);
    expect(target.httpRequests).toHaveLength(0);
    expect(target.wsRequests).toHaveLength(0);
  });

  it('returns explicit ownership, registration, and closed-session failures', async () => {
    const target = await startUpstream();
    const port = await startFront(sessionId => {
      if (sessionId === 'foreign') return { ok: false, status: 404, error: 'session_owner_mismatch' };
      if (sessionId === 'unregistered') return { ok: false, status: 404, error: 'preview_not_registered' };
      if (sessionId === 'closed') return { ok: false, status: 409, error: 'session_not_active' };
      return okTarget(target.port);
    });
    const headers = { cookie: managementCookie() };

    for (const [sessionId, status, error] of [
      ['foreign', 404, 'session_owner_mismatch'],
      ['unregistered', 404, 'preview_not_registered'],
      ['closed', 409, 'session_not_active'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/preview/${sessionId}/`, { headers });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error });
    }
    expect(target.httpRequests).toHaveLength(0);
  });

  it('revalidates resolver output and refuses remote hosts (SSRF defense in depth)', async () => {
    const port = await startFront(() => ({
      ok: true,
      target: {
        host: '169.254.169.254',
        port: 80,
        registeredAt: TARGET_TIME,
      },
    } as unknown as PreviewProxyResolution));

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/`, {
      headers: { cookie: managementCookie() },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'remote_host_forbidden' });
  });

  it('rejects an invalid persisted port distinctly from an unregistered target', async () => {
    const port = await startFront(() => ({
      ok: true,
      target: {
        host: '127.0.0.1',
        port: 0,
        registeredAt: TARGET_TIME,
      },
    } as unknown as PreviewProxyResolution));

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/`, {
      headers: { cookie: managementCookie() },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_preview_target' });
  });

  it('returns a bounded 502 for unreachable HTTP and WebSocket targets without target details', async () => {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const unreachablePort = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const port = await startFront(() => okTarget(unreachablePort));
    const headers = { cookie: managementCookie() };

    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/`, { headers });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'preview_unreachable' });
    expect(text).not.toContain(String(unreachablePort));
    expect(text).not.toContain('127.0.0.1');
    expect(await websocketStatus(`ws://127.0.0.1:${port}/preview/s1/ws`, {
      Cookie: managementCookie(),
    })).toBe(502);
  });

  it('rejects malformed paths and dashboard query tokens before proxying', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));
    const headers = { cookie: managementCookie() };

    const badPath = await fetch(`http://127.0.0.1:${port}/preview/%2Fother/`, { headers });
    expect(badPath.status).toBe(400);
    expect(await badPath.json()).toEqual({ ok: false, error: 'invalid_preview_path' });

    const tokenUrl = await fetch(`http://127.0.0.1:${port}/preview/s1/?t=${DASHBOARD_TOKEN}`, { headers });
    expect(tokenUrl.status).toBe(400);
    const body = await tokenUrl.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'query_token_forbidden' });
    expect(body).not.toContain(DASHBOARD_TOKEN);
    expect(target.httpRequests).toHaveLength(0);
  });
});

// ─── P1-8：预览长连接随认证结束一起关闭 ───────────────────────────────────────
//
// 授权只在握手那一刻说话，而预览的 WebSocket 与 SSE 一握手就能流几个小时。登出
// 之后短请求立刻 401，这些流却还在把 agent 页面的内容送给已经登出的浏览器。
// `bindStream` 把每条流挂到签发它的认证会话下，吊销时由索引统一 destroy。
describe('P1-8 preview streams die with the auth session that opened them', () => {
  let revocable: Server | null = null;
  let streamUpstream: Server | null = null;
  let streamWss: WebSocketServer | null = null;
  const liveSockets = new Set<WebSocket>();

  afterEach(async () => {
    for (const ws of liveSockets) ws.terminate();
    liveSockets.clear();
    if (streamWss) await new Promise<void>(resolve => streamWss!.close(() => resolve()));
    streamWss = null;
    if (revocable) await new Promise<void>(resolve => revocable!.close(() => resolve()));
    revocable = null;
    if (streamUpstream) await new Promise<void>(resolve => streamUpstream!.close(() => resolve()));
    streamUpstream = null;
  });

  async function startRevocable(): Promise<{ port: number; registry: AuthSessionConnectionRegistry }> {
    // 上游：一条永不结束的 SSE + 一个 echo WebSocket，模拟真实 dev server。
    streamUpstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`event: hello\ndata: ${req.url}\n\n`);
      // 故意不 end：这正是「握手后长期流」的形状。
    });
    streamWss = new WebSocketServer({ server: streamUpstream });
    streamWss.on('connection', ws => { ws.send('upstream-open'); });
    await new Promise<void>(resolve => streamUpstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (streamUpstream.address() as { port: number }).port;

    const registry = new AuthSessionConnectionRegistry();
    const manager = createSessionPreviewProxy({
      authenticated: req => req.headers.cookie?.split(';').some(part => part.trim() === managementCookie()) === true,
      resolve: () => okTarget(upstreamPort),
      verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
      // dashboard.ts 的同款接线：content 路径归属凭据里的 authSession，
      // cookie 路径归属当前请求身份。
      bindStream: (_req, ctx, close) => registry.register(
        ctx.contentCapability ? 'capability-auth-session' : 'cookie-auth-session',
        close,
      ),
    });
    revocable = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      void manager.handleHttp(req, res, url).then(handled => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    revocable.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => revocable!.listen(0, '127.0.0.1', resolve));
    return { port: (revocable.address() as { port: number }).port, registry };
  }

  it('closes the sandboxed preview WebSocket the moment its auth session ends', async () => {
    const { port, registry } = await startRevocable();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${contentBase('s1')}/socket`, { origin: 'null' });
    liveSockets.add(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('message', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('preview WebSocket never opened')), 4_000).unref();
    });
    expect(registry.count('capability-auth-session')).toBe(1);

    const closed = new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      setTimeout(() => reject(new Error('preview WebSocket survived revocation')), 4_000).unref();
    });
    expect(registry.closeAuthSession('capability-auth-session')).toBe(1);
    await closed;
    liveSockets.delete(ws);
    // 索引在关闭后不留残留（连接自然关闭也会注销）。
    expect(registry.count('capability-auth-session')).toBe(0);
  });

  it('closes an in-flight preview SSE response on revocation without touching other sessions', async () => {
    const { port, registry } = await startRevocable();
    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/stream`, {
      headers: { cookie: managementCookie() },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: hello');
    expect(registry.count('cookie-auth-session')).toBe(1);

    // 别的认证会话被吊销时，这条流一点不受影响。
    expect(registry.closeAuthSession('someone-else')).toBe(0);
    expect(registry.count('cookie-auth-session')).toBe(1);

    expect(registry.closeAuthSession('cookie-auth-session')).toBe(1);
    // 真实断流：读取端要么拿到 done，要么拿到网络错误——两者都证明流已终止。
    await expect(Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('preview SSE survived revocation')), 4_000).unref()),
    ])).rejects.toThrow(/terminated|aborted|socket|network|closed/i);
  });
});

// ─── P1-11：管理类 WS 校验 Origin，预览自身的不透明来源 WS 不被误杀 ──────────
describe('P1-11 management WebSocket upgrades check Origin (preview stays exempt)', () => {
  let chain: Server | null = null;
  let chainUpstream: Server | null = null;
  let chainUpstreamWss: WebSocketServer | null = null;
  let managementWss: WebSocketServer | null = null;
  const liveSockets = new Set<WebSocket>();

  afterEach(async () => {
    for (const ws of liveSockets) ws.terminate();
    liveSockets.clear();
    if (managementWss) await new Promise<void>(resolve => managementWss!.close(() => resolve()));
    managementWss = null;
    if (chainUpstreamWss) await new Promise<void>(resolve => chainUpstreamWss!.close(() => resolve()));
    chainUpstreamWss = null;
    if (chain) await new Promise<void>(resolve => chain!.close(() => resolve()));
    chain = null;
    if (chainUpstream) await new Promise<void>(resolve => chainUpstream!.close(() => resolve()));
    chainUpstream = null;
  });

  /** 与 dashboard.ts 的 `server.on('upgrade')` 同序：预览先判，再管理 Origin 门禁。 */
  async function startChain(): Promise<{ port: number }> {
    chainUpstream = createServer();
    chainUpstreamWss = new WebSocketServer({ server: chainUpstream });
    chainUpstreamWss.on('connection', ws => ws.send('preview-upstream'));
    await new Promise<void>(resolve => chainUpstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (chainUpstream.address() as { port: number }).port;

    const manager = createSessionPreviewProxy({
      authenticated: () => false,
      resolve: () => okTarget(upstreamPort),
      verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
    });
    chain = createServer((_req, res) => { res.writeHead(404); res.end(); });
    managementWss = new WebSocketServer({ noServer: true });
    managementWss.on('connection', ws => ws.send('management-terminal'));
    chain.on('upgrade', (req, socket, head) => {
      if (manager.handleUpgrade(req, socket, head)) return;
      const verdict = managementUpgradeOrigin(req.headers);
      if (!verdict.ok) {
        const body = JSON.stringify({ ok: false, error: verdict.error });
        socket.end([
          'HTTP/1.1 403 Forbidden',
          'content-type: application/json; charset=utf-8',
          'connection: close',
          `content-length: ${Buffer.byteLength(body)}`,
          '',
          body,
        ].join('\r\n'));
        return;
      }
      managementWss!.handleUpgrade(req, socket as never, head, ws => {
        managementWss!.emit('connection', ws, req);
      });
    });
    await new Promise<void>(resolve => chain!.listen(0, '127.0.0.1', resolve));
    return { port: (chain.address() as { port: number }).port };
  }

  async function firstMessage(ws: WebSocket): Promise<string> {
    liveSockets.add(ws);
    return new Promise<string>((resolve, reject) => {
      ws.on('message', data => resolve(data.toString()));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WebSocket never delivered a frame')), 4_000).unref();
    });
  }

  it('rejects a foreign-origin terminal upgrade and admits the same-origin one', async () => {
    const { port } = await startChain();
    // 同站兄弟子域 / 别的 localhost 端口 / 跨站页面 / 不透明来源：全部拒。
    for (const origin of [
      'https://evil.example',
      `http://evil.127.0.0.1:${port}`,
      `http://127.0.0.1:${port + 1}`,
      'null',
    ]) {
      expect(await websocketStatus(`ws://127.0.0.1:${port}/s/sess-1/ws`, { Origin: origin }), origin).toBe(403);
    }
    // 真正同源的工作台页面照常连上。
    const ok = new WebSocket(`ws://127.0.0.1:${port}/s/sess-1/ws`, { origin: `http://127.0.0.1:${port}` });
    expect(await firstMessage(ok)).toBe('management-terminal');
    ok.terminate();
    liveSockets.delete(ok);
  });

  it('never applies the management Origin gate to the sandboxed preview WebSocket', async () => {
    const { port } = await startChain();
    // 预览自身的 WS 是不透明来源（Origin: null），凭据在路径里；它必须在管理
    // Origin 门禁之前被认领，否则同一个 `null` 会被上面那条规则误杀。
    const ws = new WebSocket(`ws://127.0.0.1:${port}${contentBase('s1')}/socket`, { origin: 'null' });
    expect(await firstMessage(ws)).toBe('preview-upstream');
    ws.terminate();
    liveSockets.delete(ws);
  });
});
