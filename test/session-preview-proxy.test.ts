import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createSessionPreviewProxy,
  previewRequestHeaders,
  type PreviewProxyResolution,
} from '../src/dashboard/preview-proxy.js';
import { PREVIEW_CONTENT_QUERY } from '../src/core/session-preview.js';

const DASHBOARD_TOKEN = 'management-token-must-not-leak';
const TARGET_TIME = '2026-08-11T12:00:00.000Z';
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

  it('strips the private guard-shell content marker before reaching the app', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));
    const response = await fetch(
      `http://127.0.0.1:${port}/preview/s1/?${PREVIEW_CONTENT_QUERY}=1&q=kept`,
      { headers: { cookie: managementCookie() } },
    );
    expect(response.status).toBe(200);
    expect(target.httpRequests[0].url).toBe('/?q=kept');
  });

  it('preserves the private content marker across app redirects to prevent a nested guard shell', async () => {
    const target = await startUpstream();
    const port = await startFront(() => okTarget(target.port));
    const response = await fetch(
      `http://127.0.0.1:${port}/preview/s1/redirect?${PREVIEW_CONTENT_QUERY}=1`,
      { redirect: 'manual', headers: { cookie: managementCookie() } },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/preview/s1/login?from=preview&${PREVIEW_CONTENT_QUERY}=1`,
    );
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
