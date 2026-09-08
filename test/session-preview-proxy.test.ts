import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from './helpers/node-ws.js';
import {
  PREVIEW_SANDBOX_TOKENS,
  PREVIEW_UPGRADE_REJECTION_TIMEOUT_MS,
  createSessionPreviewProxy,
  previewRequestHeaders,
  type PreviewProxyResolution,
} from '../src/dashboard/preview-proxy.js';
import {
  PREVIEW_CONTENT_SEGMENT,
  sameSessionPreviewTarget,
  type SessionPreviewTarget,
} from '../src/core/session-preview.js';
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

/** P1-12：注册时留下的 listener 归属证明。代理侧只把它当不透明数据透传，真实
 *  procfs 复核由 dashboard.ts 的 resolve 负责（见 session-preview-ownership 测试）。 */
const TARGET_OWNER = { pid: 424242, procStart: '918273', inode: '556677' } as const;

function okTarget(port: number): PreviewProxyResolution {
  return {
    ok: true,
    target: {
      host: '127.0.0.1', port, registeredAt: TARGET_TIME,
      owner: { ...TARGET_OWNER }, workerGeneration: 7,
    },
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
    const target = {
      host: '127.0.0.1' as const, port: 3000, registeredAt: TARGET_TIME,
      owner: { ...TARGET_OWNER }, workerGeneration: 7,
    };
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
      // 第三个参数是 P1-13 的会话索引：身份没结束、但预览目标失效时靠它定点断流。
      bindStream: (_req, ctx, close) => registry.register(
        ctx.contentCapability ? 'capability-auth-session' : 'cookie-auth-session',
        close,
        ctx.sessionId,
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

  // ─── P1-13：身份还在，但预览目标失效（换代 / 关闭 / 端口易主）──────────────
  it('closes this session preview WebSocket when its target is retired, leaving other sessions alone', async () => {
    const { port, registry } = await startRevocable();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${contentBase('s1')}/socket`, { origin: 'null' });
    liveSockets.add(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('message', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('preview WebSocket never opened')), 4_000).unref();
    });
    // 同一个登录身份下、另一个会话的预览流：不能被误伤。
    const other = await fetch(`http://127.0.0.1:${port}/preview/s2/stream`, {
      headers: { cookie: managementCookie() },
    });
    const otherReader = other.body!.getReader();
    expect(new TextDecoder().decode((await otherReader.read()).value)).toContain('event: hello');
    expect(registry.countSessionStreams('s1')).toBe(1);
    expect(registry.countSessionStreams('s2')).toBe(1);

    const closed = new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      setTimeout(() => reject(new Error('preview WebSocket survived target retirement')), 4_000).unref();
    });
    expect(registry.closeSessionStreams('s1')).toBe(1);
    await closed;
    liveSockets.delete(ws);
    expect(registry.countSessionStreams('s1')).toBe(0);
    // 两个索引不漂移：会话索引关掉的连接，也从 authSession 索引里摘干净了。
    expect(registry.count('capability-auth-session')).toBe(0);
    expect(registry.countSessionStreams('s2')).toBe(1);
    expect(registry.count('cookie-auth-session')).toBe(1);
    // 收尾：这条 SSE 永不自结束，留着会挂住 afterEach 的 server.close()。
    expect(registry.closeSessionStreams('s2')).toBe(1);
    await otherReader.cancel().catch(() => { /* 已被服务端销毁 */ });
  });

  it('closes an in-flight preview SSE when the session target is retired', async () => {
    const { port, registry } = await startRevocable();
    const response = await fetch(`http://127.0.0.1:${port}/preview/s1/stream`, {
      headers: { cookie: managementCookie() },
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: hello');

    expect(registry.closeSessionStreams('s1')).toBe(1);
    await expect(Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('preview SSE survived target retirement')), 4_000).unref()),
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

// ─── P1-4：拨号 → upstream 101/headers 之间的撤销竞态 ─────────────────────────
//
// 预览这条路上的授权（`authenticated` / `verifyContentCapability`）只在**拨号之前**
// 说一次话，而 dev server 的握手最长可以拖 45 秒（PREVIEW_UPSTREAM_RESPONSE_TIMEOUT_MS）。
// 登出若落在这段窗口里：撤销扫描遍历索引时这条流还没登记进去，一条都关不到；等上游
// 握完手再补登记，等于把一条正在流的预览挂到一个已经死掉的认证会话名下——而预览侧
// 连「能力到期自己断」这层兜底都没有，它会一直把 agent 页面的内容送给已登出的浏览器。
//
// 所以 `bindStream` 既是登记点、也是最后一次判定点：它返回 false 时代理必须销毁上游、
// 不登记、不回 101/200。
describe('P1-4 preview streams refuse to register under an auth session that died mid-handshake', () => {
  const CAPABILITY_AUTH_SESSION = 'capability-auth-session';
  const COOKIE_AUTH_SESSION = 'cookie-auth-session';
  const LEAKED_PREVIEW = 'preview-bytes-after-logout';
  const rawClients = new Set<Socket>();

  afterEach(() => {
    for (const socket of rawClients) socket.destroy();
    rawClients.clear();
  });

  /** 上游 dev server：HTTP 响应与 WebSocket 握手都停在半路，由测试放行。 */
  async function startRacingPreview(): Promise<{
    port: number;
    live: Set<string>;
    registry: AuthSessionConnectionRegistry;
    dialed: Promise<void>;
    completeUpgrade: (payload?: string) => void;
    completeResponse: (payload?: string) => void;
  }> {
    let markDialed!: () => void;
    const dialed = new Promise<void>(resolve => { markDialed = resolve; });
    let pausedSocket: Duplex | undefined;
    let pausedResponse: ServerResponse | undefined;
    upstream = createServer((_req, res) => { pausedResponse = res; markDialed(); });
    upstream.on('upgrade', (_req, socket) => {
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      pausedSocket = socket;
      markDialed();
    });
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const live = new Set([CAPABILITY_AUTH_SESSION, COOKIE_AUTH_SESSION]);
    const registry = new AuthSessionConnectionRegistry();
    const manager = createSessionPreviewProxy({
      authenticated: req => req.headers.cookie?.split(';').some(part => part.trim() === managementCookie()) === true,
      resolve: () => okTarget(upstreamPort),
      verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
      // dashboard.ts 的同款接线：登记之前把归属重新解一遍并复核存活，已经结束的
      // 认证会话一律 fail closed。
      bindStream: (_req, ctx, close) => {
        const authSessionId = ctx.contentCapability ? CAPABILITY_AUTH_SESSION : COOKIE_AUTH_SESSION;
        if (!live.has(authSessionId)) return false;
        return registry.register(authSessionId, close, ctx.sessionId);
      },
    });
    front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      void manager.handleHttp(req, res, url).then(handled => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    front.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => front!.listen(0, '127.0.0.1', resolve));
    return {
      port: (front.address() as { port: number }).port,
      live,
      registry,
      dialed,
      completeUpgrade: (payload = '') => {
        pausedSocket?.write(
          'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
          + payload,
        );
      },
      completeResponse: (payload = '') => {
        pausedResponse?.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        pausedResponse?.write(payload);
      },
    };
  }

  /** 裸 socket：只关心到底收到了 101 还是错误，以及有没有收到预览字节。 */
  function rawUpgrade(port: number, path: string): {
    raw: () => string;
    closed: Promise<void>;
    waitFor: (needle: string, label: string) => Promise<void>;
  } {
    const socket = connect(port, '127.0.0.1');
    rawClients.add(socket);
    let raw = '';
    const waiters = new Set<{ needle: string; resolve: () => void }>();
    socket.on('data', chunk => {
      raw += chunk.toString();
      for (const waiter of [...waiters]) {
        if (!raw.includes(waiter.needle)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    });
    socket.on('error', () => { /* 断开本身就是断言对象 */ });
    const closed = new Promise<void>(resolve => socket.on('close', () => resolve()));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: dashboard.test\r\nOrigin: null\r\n`
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    return {
      raw: () => raw,
      closed,
      waitFor: (needle, label) => new Promise<void>((resolve, reject) => {
        if (raw.includes(needle)) { resolve(); return; }
        waiters.add({ needle, resolve });
        setTimeout(() => reject(new Error(`${label}\n---received---\n${raw}`)), 4_000).unref();
      }),
    };
  }

  it('refuses the sandboxed preview WebSocket when its auth session died during the dev-server handshake', async () => {
    const ctx = await startRacingPreview();
    const client = rawUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    // 拨号已发出，dev server 还没回 101：竞态窗口现在真的开着。
    await ctx.dialed;

    // 就在这一刻登出。此时索引里空无一物——扫描关不到任何东西。
    ctx.live.delete(CAPABILITY_AUTH_SESSION);
    expect(ctx.registry.closeAuthSession(CAPABILITY_AUTH_SESSION)).toBe(0);

    // dev server 现在才握完手，并且已经开始吐页面内容。
    ctx.completeUpgrade(LEAKED_PREVIEW);
    await client.waitFor('403', '拨号中被撤销的预览升级请求没有被拒');
    await client.closed;
    expect(client.raw()).not.toContain('101');
    expect(client.raw()).not.toContain(LEAKED_PREVIEW);
    expect(client.raw()).toContain('authentication_revoked');
    // 也没有被补登记到已经死掉的认证会话名下。
    expect(ctx.registry.count(CAPABILITY_AUTH_SESSION)).toBe(0);
  });

  it('still bridges a live preview WebSocket, and that bridge still dies with its auth session', async () => {
    const ctx = await startRacingPreview();
    const client = rawUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    await ctx.dialed;
    ctx.completeUpgrade('preview-frame-bytes');
    await client.waitFor('101', '活着的预览连接没有拿到 101');
    await client.waitFor('preview-frame-bytes', '桥接建立后预览字节没有透传');
    expect(ctx.registry.count(CAPABILITY_AUTH_SESSION)).toBe(1);

    // 登记确实发生了：P1-8 的关闭器照样能一把掐断。
    const closed = client.closed;
    expect(ctx.registry.closeAuthSession(CAPABILITY_AUTH_SESSION)).toBe(1);
    await closed;
  });

  it('refuses an in-flight preview response whose auth session died before the upstream headers came back', async () => {
    const ctx = await startRacingPreview();
    const pending = fetch(`http://127.0.0.1:${ctx.port}/preview/s1/stream`, {
      headers: { cookie: managementCookie() },
    });
    await ctx.dialed;
    ctx.live.delete(COOKIE_AUTH_SESSION);
    ctx.completeResponse(`event: hello\ndata: ${LEAKED_PREVIEW}\n\n`);

    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'authentication_revoked' });
    expect(ctx.registry.count(COOKIE_AUTH_SESSION)).toBe(0);
  });

  it('leaves a live cookie-authenticated preview response streaming as before', async () => {
    const ctx = await startRacingPreview();
    const pending = fetch(`http://127.0.0.1:${ctx.port}/preview/s1/stream`, {
      headers: { cookie: managementCookie() },
    });
    await ctx.dialed;
    ctx.completeResponse('event: hello\ndata: live-preview-payload\n\n');
    const response = await pending;
    expect(response.status).toBe(200);
    expect(ctx.registry.count(COOKIE_AUTH_SESSION)).toBe(1);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('live-preview-payload');

    // 登记确实发生了：这条流照旧随认证结束一起断。
    expect(ctx.registry.closeAuthSession(COOKIE_AUTH_SESSION)).toBe(1);
    await reader.read().catch(() => { /* 断流即预期 */ });
  });
});

// ─── P1-2：客户端先走 / 非 101 拒绝路径上的上游连接回收 ──────────────────────
//
// `bindStream` 返回的只是索引里的注销闭包（一次 `Set.delete`），而 `up.pipe(res)`
// 在 dest 关闭时走的是 unpipe，**不会 destroy source**。所以在补这条防护之前，浏览
// 器一关标签页这条上游就永远挂着：注销之后撤销扫描再也够不到它，而 headers 到达时
// 又把 45s 的前置超时拆掉了，于是没有任何超时会回收这个 FD。预览页常见的 SSE / 长
// 轮询每关一次页面漏一个，且没有任何并发配额兜底。
//
// 非 101 那条路更糟：代理攒完 body 才写回浏览器，上游只要不 end，两条 socket 一起
// 挂死，而浏览器一个字节都收不到。
describe('P1-2 preview 代理在客户端断开与非 101 拒绝路径上回收上游连接', () => {
  let probeFront: Server | null = null;
  let probeUpstream: Server | null = null;
  const probeClients = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();

  afterEach(async () => {
    for (const socket of probeClients) socket.destroy();
    probeClients.clear();
    // 泄漏用例失败时上游 socket 还挂着，server.close() 会一直等——先强拆再关。
    for (const socket of upstreamSockets) socket.destroy();
    upstreamSockets.clear();
    if (probeFront) await new Promise<void>(resolve => probeFront!.close(() => resolve()));
    probeFront = null;
    if (probeUpstream) await new Promise<void>(resolve => probeUpstream!.close(() => resolve()));
    probeUpstream = null;
  });

  async function startReclaimProbe(): Promise<{
    port: number;
    registry: AuthSessionConnectionRegistry;
    liveUpstream: () => number;
    upstreamClosed: Promise<void>;
    dialed: Promise<void>;
  }> {
    let markDialed!: () => void;
    const dialed = new Promise<void>(resolve => { markDialed = resolve; });
    let markUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { markUpstreamClosed = resolve; });
    probeUpstream = createServer((req, res) => {
      if (req.url?.startsWith('/short')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('short-preview-body');
        markDialed();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: hello\ndata: open\n\n');
      markDialed();
      // 故意不 end：这正是「握手后长期流」的形状。
    });
    // 非 101 拒绝：回 200 + chunked，然后一个 chunk 都不发、永不 end。
    probeUpstream.on('upgrade', (_req, socket) => {
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n');
      markDialed();
    });
    probeUpstream.on('connection', socket => {
      upstreamSockets.add(socket);
      socket.on('close', () => { upstreamSockets.delete(socket); markUpstreamClosed(); });
    });
    await new Promise<void>(resolve => probeUpstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (probeUpstream.address() as { port: number }).port;

    const registry = new AuthSessionConnectionRegistry();
    const manager = createSessionPreviewProxy({
      authenticated: req => req.headers.cookie?.split(';').some(part => part.trim() === managementCookie()) === true,
      resolve: () => okTarget(upstreamPort),
      verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
      bindStream: (_req, ctx, close) => registry.register('cookie-auth-session', close, ctx.sessionId),
    });
    probeFront = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      void manager.handleHttp(req, res, url).then(handled => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    probeFront.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => probeFront!.listen(0, '127.0.0.1', resolve));
    return {
      port: (probeFront.address() as { port: number }).port,
      registry,
      liveUpstream: () => upstreamSockets.size,
      upstreamClosed,
      dialed,
    };
  }

  /** 裸客户端：拿到首包后由测试决定何时（以及怎样）断开。 */
  function rawClient(port: number, request: string): {
    socket: Socket;
    raw: () => string;
    waitFor: (needle: string, label: string) => Promise<void>;
  } {
    const socket = connect(port, '127.0.0.1');
    probeClients.add(socket);
    let raw = '';
    const waiters = new Set<{ needle: string; resolve: () => void }>();
    socket.on('data', chunk => {
      raw += chunk.toString();
      for (const waiter of [...waiters]) {
        if (!raw.includes(waiter.needle)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    });
    socket.on('error', () => { /* 断开本身就是断言对象 */ });
    socket.write(request);
    return {
      socket,
      raw: () => raw,
      waitFor: (needle, label) => new Promise<void>((resolve, reject) => {
        if (raw.includes(needle)) { resolve(); return; }
        waiters.add({ needle, resolve });
        setTimeout(() => reject(new Error(`${label}\n---received---\n${raw}`)), 4_000).unref();
      }),
    };
  }

  function previewGet(port: number, path: string): ReturnType<typeof rawClient> {
    return rawClient(
      port,
      `GET ${path} HTTP/1.1\r\nHost: dashboard.test\r\nCookie: ${managementCookie()}\r\n\r\n`,
    );
  }

  function previewUpgrade(port: number, path: string): ReturnType<typeof rawClient> {
    return rawClient(
      port,
      `GET ${path} HTTP/1.1\r\nHost: dashboard.test\r\nOrigin: null\r\n`
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  }

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(label);
      await new Promise<void>(resolve => { setTimeout(resolve, 10).unref(); });
    }
  }

  it('浏览器中途关掉预览 SSE 时，上游连接跟着销毁而不是留下一个 FD', async () => {
    const ctx = await startReclaimProbe();
    const client = previewGet(ctx.port, '/preview/s1/stream');
    await client.waitFor('event: hello', '预览 SSE 首包没有透传');
    expect(ctx.liveUpstream()).toBe(1);
    expect(ctx.registry.countSessionStreams('s1')).toBe(1);

    // 浏览器关标签页。注销会发生，但在补防护之前没有任何东西会关掉上游。
    client.socket.destroy();

    await ctx.upstreamClosed;
    expect(ctx.liveUpstream()).toBe(0);
    // 注销照旧发生，两个索引都不留残留。
    expect(ctx.registry.countSessionStreams('s1')).toBe(0);
    expect(ctx.registry.count('cookie-auth-session')).toBe(0);
  });

  it('自然结束的短响应照常完整送达，也不会被误当成断开', async () => {
    const ctx = await startReclaimProbe();
    const client = previewGet(ctx.port, '/preview/s1/short');
    await client.waitFor('short-preview-body', '短响应没有完整送达');
    expect(client.raw()).toContain('200 OK');
    await waitUntil(
      () => ctx.registry.countSessionStreams('s1') === 0,
      '短响应自然结束后索引仍有残留',
    );
  });

  it('非 101 拒绝还没读完时浏览器断开，上游连接立刻回收', async () => {
    const ctx = await startReclaimProbe();
    const client = previewUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    await ctx.dialed;
    // 上游回了 200 + chunked 却一个 chunk 都不发：代理攒完 body 才写回，所以浏览器
    // 此刻一个字节都没有——挂死的不只是两条 socket，还有这个浏览器请求。
    expect(client.raw()).toBe('');
    expect(ctx.liveUpstream()).toBe(1);

    // 干净 FIN（真实浏览器关页面的样子），不是 RST——这条路上没有 'error' 兜底。
    client.socket.end();

    await ctx.upstreamClosed;
    expect(ctx.liveUpstream()).toBe(0);
  });

  it('非 101 拒绝体超过总时限还没读完时，上游与浏览器两端一起销毁', async () => {
    // Real timers: bun's fake clock does not fire this production setTimeout
    // (CI hung until FILE_WALL SIGKILL). 15s + buffer is well under the
    // per-test ceiling on both runners.
    const ctx = await startReclaimProbe();
    const client = previewUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    const clientClosed = new Promise<void>(resolve => client.socket.on('close', () => resolve()));
    await ctx.dialed;

    await Promise.race([
      ctx.upstreamClosed,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('upstream was not reclaimed before the rejection timeout')),
          PREVIEW_UPGRADE_REJECTION_TIMEOUT_MS + 3_000,
        );
      }),
    ]);
    await clientClosed;
    expect(ctx.liveUpstream()).toBe(0);
    expect(client.raw()).toBe('');
  });
});

// ─── P1-1：拨号 → upstream 101/headers 之间的**换靶**竞态 ────────────────────
//
// 授权与目标解析都发生在拨号之前，dev server 的握手最长可以拖 45 秒。这段窗口里
// worker 换代 / 切 CLI / 端口易主 / 目标被清空，daemon 会广播出来、dashboard 会
// teardown——但 teardown 扫的是索引，而这条流此刻还没进索引，一条都关不到。等上游握完
// 手，旧的 bindStream 只查身份（身份没变，依然合法），于是它拿到 200/101 并被**重新
// 登记**，继续把一个已经不属于这个会话的进程的内容送进浏览器。
//
// 所以 bindStream 拿到拨号时用的 target，登记前把目标重解一遍比指纹：不是同一次注册
// 就返回 false，由现成分支销毁上游、不写 200/101、不登记。
describe('P1-1 preview 流在握手完成前复核 target 指纹', () => {
  const COOKIE_AUTH_SESSION = 'cookie-auth-session';
  const LEAKED_PREVIEW = 'preview-bytes-from-retired-target';
  const rawClients = new Set<Socket>();

  afterEach(() => {
    for (const socket of rawClients) socket.destroy();
    rawClients.clear();
  });

  async function startSwappablePreview(): Promise<{
    port: number;
    registry: AuthSessionConnectionRegistry;
    dialed: Promise<void>;
    swapTarget: (next: SessionPreviewTarget | null) => void;
    reregisterSameTarget: () => void;
    completeUpgrade: (payload?: string) => void;
    completeResponse: (payload?: string) => void;
  }> {
    let markDialed!: () => void;
    const dialed = new Promise<void>(resolve => { markDialed = resolve; });
    let pausedSocket: Duplex | undefined;
    let pausedResponse: ServerResponse | undefined;
    upstream = createServer((_req, res) => { pausedResponse = res; markDialed(); });
    upstream.on('upgrade', (_req, socket) => {
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      pausedSocket = socket;
      markDialed();
    });
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    let current: SessionPreviewTarget | null = {
      host: '127.0.0.1', port: upstreamPort, registeredAt: TARGET_TIME,
      owner: { ...TARGET_OWNER }, workerGeneration: 7,
    };
    const registry = new AuthSessionConnectionRegistry();
    const manager = createSessionPreviewProxy({
      authenticated: req => req.headers.cookie?.split(';').some(part => part.trim() === managementCookie()) === true,
      resolve: () => (current
        ? { ok: true, target: current }
        : { ok: false, status: 404, error: 'preview_not_registered' }),
      verifyContentCapability: (capability, sessionId) => capability === CAPABILITY && sessionId === 's1',
      // dashboard.ts 的同款接线：身份复核之外，再把目标重解一遍与拨号时那个比指纹。
      bindStream: (_req, ctx, close) => {
        if (!current || !sameSessionPreviewTarget(current, ctx.target)) return false;
        return registry.register(COOKIE_AUTH_SESSION, close, ctx.sessionId);
      },
    });
    front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      void manager.handleHttp(req, res, url).then(handled => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    front.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => front!.listen(0, '127.0.0.1', resolve));
    return {
      port: (front.address() as { port: number }).port,
      registry,
      dialed,
      swapTarget: next => { current = next; },
      // 换代后在**同一个端口**重注册：host:port 一模一样，但那是另一次注册。
      reregisterSameTarget: () => {
        current = {
          host: '127.0.0.1', port: upstreamPort, registeredAt: '2026-08-11T12:00:05.000Z',
          owner: { ...TARGET_OWNER, pid: TARGET_OWNER.pid + 1 }, workerGeneration: 8,
        };
      },
      completeUpgrade: (payload = '') => {
        pausedSocket?.write(
          'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
          + payload,
        );
      },
      completeResponse: (payload = '') => {
        pausedResponse?.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        pausedResponse?.write(payload);
      },
    };
  }

  function rawUpgrade(port: number, path: string): {
    raw: () => string;
    closed: Promise<void>;
    waitFor: (needle: string, label: string) => Promise<void>;
  } {
    const socket = connect(port, '127.0.0.1');
    rawClients.add(socket);
    let raw = '';
    const waiters = new Set<{ needle: string; resolve: () => void }>();
    socket.on('data', chunk => {
      raw += chunk.toString();
      for (const waiter of [...waiters]) {
        if (!raw.includes(waiter.needle)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    });
    socket.on('error', () => { /* 断开本身就是断言对象 */ });
    const closed = new Promise<void>(resolve => socket.on('close', () => resolve()));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: dashboard.test\r\nOrigin: null\r\n`
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    return {
      raw: () => raw,
      closed,
      waitFor: (needle, label) => new Promise<void>((resolve, reject) => {
        if (raw.includes(needle)) { resolve(); return; }
        waiters.add({ needle, resolve });
        setTimeout(() => reject(new Error(`${label}\n---received---\n${raw}`)), 4_000).unref();
      }),
    };
  }

  it('握手期间换代后在同一端口重注册：旧升级请求拿不到 101，也不会被重新登记', async () => {
    const ctx = await startSwappablePreview();
    const client = rawUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    await ctx.dialed;

    // 换靶就发生在这一刻。索引里空无一物——teardown 一条都关不到。
    ctx.reregisterSameTarget();
    expect(ctx.registry.closeSessionStreams('s1')).toBe(0);

    ctx.completeUpgrade(LEAKED_PREVIEW);
    await client.waitFor('403', '换靶后的旧升级请求没有被拒');
    await client.closed;
    expect(client.raw()).not.toContain('101');
    expect(client.raw()).not.toContain(LEAKED_PREVIEW);
    expect(ctx.registry.countSessionStreams('s1')).toBe(0);
    expect(ctx.registry.count(COOKIE_AUTH_SESSION)).toBe(0);
  });

  it('握手期间目标被清空：旧升级请求同样拒绝', async () => {
    const ctx = await startSwappablePreview();
    const client = rawUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    await ctx.dialed;
    ctx.swapTarget(null);
    ctx.completeUpgrade(LEAKED_PREVIEW);
    await client.waitFor('403', '目标清空后的旧升级请求没有被拒');
    await client.closed;
    expect(client.raw()).not.toContain('101');
    expect(client.raw()).not.toContain(LEAKED_PREVIEW);
    expect(ctx.registry.countSessionStreams('s1')).toBe(0);
  });

  it('握手期间换代：在途的 HTTP 预览响应拿不到 200，也不会被重新登记', async () => {
    const ctx = await startSwappablePreview();
    const pending = fetch(`http://127.0.0.1:${ctx.port}/preview/s1/stream`, {
      headers: { cookie: managementCookie() },
    });
    await ctx.dialed;
    ctx.reregisterSameTarget();
    ctx.completeResponse(`event: hello\ndata: ${LEAKED_PREVIEW}\n\n`);

    const response = await pending;
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain(LEAKED_PREVIEW);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'authentication_revoked' });
    expect(ctx.registry.countSessionStreams('s1')).toBe(0);
  });

  it('目标没变时照常放行，并且依旧随身份/目标失效一起断', async () => {
    const ctx = await startSwappablePreview();
    const client = rawUpgrade(ctx.port, `${contentBase('s1')}/socket`);
    await ctx.dialed;
    ctx.completeUpgrade('preview-frame-bytes');
    await client.waitFor('101', '没换靶的预览升级请求被误拒');
    await client.waitFor('preview-frame-bytes', '桥接建立后预览字节没有透传');
    expect(ctx.registry.countSessionStreams('s1')).toBe(1);

    const closed = client.closed;
    expect(ctx.registry.closeSessionStreams('s1')).toBe(1);
    await closed;
  });
});
