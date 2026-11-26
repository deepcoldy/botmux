import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import type { InstalledPluginRecord } from '../src/core/plugins/types.js';
import { ControlCsrfTokens, CONTROL_CSRF_HEADER } from '../src/dashboard/control-csrf.js';
import { AuthSessionConnectionRegistry } from '../src/dashboard/auth-session-connections.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';
import {
  createPluginServiceProxyHandler,
  PLUGIN_SERVICE_PROXY_HEADER,
  rewritePluginServiceLocation,
} from '../src/dashboard/plugin-service-proxy.js';
import { earlyGuardPluginProxyRequest } from '../src/dashboard/plugin-webhook-routes.js';
import type { PluginLoopbackTargetResult } from '../src/core/plugins/webhooks/service-target.js';

async function listenServer(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function sendHttp(port: number, opts: {
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
}): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

function sendRawHttpLine(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => sock.write(rawRequest));
    const chunks: Buffer[] = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

function makePlugin(
  id: string,
  withService = true,
  extraContributions?: Partial<NonNullable<InstalledPluginRecord['contributions']>>,
): InstalledPluginRecord {
  return {
    id,
    packageName: `botmux-plugin-${id}`,
    version: '1.0.0',
    source: { type: 'local', spec: '/tmp/plugin' },
    manifest: { schemaVersion: 1, id, ...(withService ? { service: { mode: 'manual' } } : {}) },
    contributions: withService
      ? { service: { entry: 'service/index.js', mode: 'manual' }, ...(extraContributions ?? {}) }
      : undefined,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const ADMIN_IDENTITY: DashboardRequestIdentity = {
  kind: 'legacy-dashboard',
  authSessionId: 'legacy:admin-session',
  canManageHost: true,
  legacyAuthed: true,
  allowOwnerActor: true,
  workbenchOnly: false,
};

const WORKBENCH_ONLY_IDENTITY: DashboardRequestIdentity = {
  kind: 'feishu-h5',
  authSessionId: 'h5:user-1',
  canManageHost: false,
  legacyAuthed: false,
  allowOwnerActor: false,
  workbenchOnly: true,
  actorUnionId: 'on_test',
};

describe('Dashboard authenticated plugin service proxy (/api/plugins/:id/service/*)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    while (servers.length > 0) {
      await closeServer(servers.pop());
    }
  });

  async function startFixture(opts: {
    plugins?: Record<string, InstalledPluginRecord>;
    identity?: DashboardRequestIdentity | null;
    activeToken?: string;
    resolveTarget?: (id: string) => PluginLoopbackTargetResult;
    upstreamHandler?: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;
    rawUpstreamHandler?: (req: IncomingMessage, res: ServerResponse) => void;
    liveSession?: () => boolean;
    headerTimeoutMs?: number;
    uploadIdleTimeoutMs?: number;
    uploadTotalTimeoutMs?: number;
    maxUploadBytes?: number;
  } = {}) {
    const recorded: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
    const upstream = createServer((req, res) => {
      if (opts.rawUpstreamHandler) {
        opts.rawUpstreamHandler(req, res);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body });
        if (opts.upstreamHandler) {
          opts.upstreamHandler(req, body, res);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'botmux_dashboard_token=hijack; Path=/',
          'access-control-allow-origin': 'https://evil.example',
          'x-botmux-login-url': 'https://phish.example',
        });
        res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, bodyLen: body.byteLength }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listenServer(upstream);
    const loopbackToken = 'T'.repeat(43);

    const csrfTokens = new ControlCsrfTokens();
    const csrfToken = csrfTokens.mint(ADMIN_IDENTITY.authSessionId);
    const connections = new AuthSessionConnectionRegistry();
    let currentIdentity: DashboardRequestIdentity | null = opts.identity === undefined ? ADMIN_IDENTITY : opts.identity;

    const pluginsMap = opts.plugins ?? {
      demo: makePlugin('demo', true, {
        cardActions: { schemaVersion: 1, endpoint: '/cb/cards', actions: ['demo.ok'] },
        commands: { schemaVersion: 1, endpoint: '/cb/commands', commands: [{ name: '/demo-cmd' }] },
      }),
    };

    const proxy = createPluginServiceProxyHandler({
      csrfTokens,
      getInstalledPlugin: id => (Object.hasOwn(pluginsMap, id) ? pluginsMap[id] : undefined),
      resolveTarget: opts.resolveTarget ?? (() => ({
        ok: true, host: '127.0.0.1', port: upstreamPort, token: loopbackToken, pid: process.pid, processStart: 'boot-1',
      })),
      isAuthSessionLive: () => (opts.liveSession ? opts.liveSession() : true),
      bindStream: (authSessionId, pluginId, close) => {
        if (opts.liveSession && !opts.liveSession()) return false;
        return connections.register(authSessionId, close, `plugin:${pluginId}`);
      },
      headerTimeoutMs: opts.headerTimeoutMs,
      uploadIdleTimeoutMs: opts.uploadIdleTimeoutMs,
      uploadTotalTimeoutMs: opts.uploadTotalTimeoutMs,
      maxUploadBytes: opts.maxUploadBytes,
    });

    const front = createServer(async (req, res) => {
      if (earlyGuardPluginProxyRequest(req, res)) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/__health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (await proxy.handle(req, res, url, { identity: currentIdentity, activeToken: opts.activeToken ?? 'dash-secret' })) {
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'fell_through' }));
    });
    servers.push(front);
    const frontPort = await listenServer(front);

    return {
      frontPort,
      upstreamPort,
      loopbackToken,
      csrfToken,
      csrfTokens,
      connections,
      recorded,
      setIdentity: (next: DashboardRequestIdentity | null) => { currentIdentity = next; },
    };
  }

  it('rejects unauthenticated and non-admin (workbench-only) requests with 401 and no plugin-proxy header', async () => {
    const { frontPort, recorded, setIdentity } = await startFixture({ identity: null });
    const anon = await sendHttp(frontPort, { method: 'GET', path: '/api/plugins/demo/service/status' });
    expect(anon.status).toBe(401);
    expect(anon.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBeUndefined();

    setIdentity(WORKBENCH_ONLY_IDENTITY);
    const h5 = await sendHttp(frontPort, { method: 'GET', path: '/api/plugins/demo/service/status' });
    expect(h5.status).toBe(401);
    expect(h5.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });

  it('blocks confused-deputy calls to reserved internal host-callback endpoints (/botmux/*, cardActions, commands) with 403', async () => {
    const { frontPort, csrfToken, recorded } = await startFixture();

    for (const blockedPath of [
      '/api/plugins/demo/service/botmux/inputs/v1',
      '/api/plugins/demo/service/%62otmux/inputs/v1',
      '/api/plugins/demo/service/BOTMUX/commands/v1',
      '/api/plugins/demo/service/cb/cards',
      '/api/plugins/demo/service/CB/CARDS/',
      '/api/plugins/demo/service/cb/cards/sub',
      '/api/plugins/demo/service/cb/%63ommands',
    ]) {
      const res = await sendHttp(frontPort, {
        method: 'POST',
        path: blockedPath,
        headers: {
          origin: `http://127.0.0.1:${frontPort}`,
          'sec-fetch-site': 'same-origin',
          [CONTROL_CSRF_HEADER]: csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ privileges: { canOperate: true } }),
      });
      expect(res.status).toBe(403);
      expect(res.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBeUndefined();
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_internal_endpoint_forbidden' });
    }
    expect(recorded).toHaveLength(0);
  });

  it('enforces CSRF + origin on POST/PUT/PATCH/DELETE, same-site/Referer checks on GET, individual nav headers, and Allow on 405', async () => {
    const { frontPort, csrfToken, csrfTokens, recorded } = await startFixture();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const noCsrf = await sendHttp(frontPort, {
        method,
        path: '/api/plugins/demo/service/items',
        headers: { origin: `http://127.0.0.1:${frontPort}`, 'sec-fetch-site': 'same-origin' },
        body: method === 'DELETE' ? undefined : '{}',
      });
      expect(noCsrf.status).toBe(403);
      expect(JSON.parse(noCsrf.body.toString('utf8')).error).toBe('control_csrf_invalid');

      const foreign = await sendHttp(frontPort, {
        method,
        path: '/api/plugins/demo/service/items',
        headers: { origin: 'https://evil.example', [CONTROL_CSRF_HEADER]: csrfToken },
        body: method === 'DELETE' ? undefined : '{}',
      });
      expect(foreign.status).toBe(403);
      expect(JSON.parse(foreign.body.toString('utf8')).error).toBe('control_origin_forbidden');
    }

    const otherCsrf = csrfTokens.mint('legacy:other-session');
    const wrongCsrf = await sendHttp(frontPort, {
      method: 'POST',
      path: '/api/plugins/demo/service/items',
      headers: {
        origin: `http://127.0.0.1:${frontPort}`,
        'sec-fetch-site': 'same-origin',
        [CONTROL_CSRF_HEADER]: otherCsrf,
      },
      body: '{}',
    });
    expect(wrongCsrf.status).toBe(403);
    expect(JSON.parse(wrongCsrf.body.toString('utf8')).error).toBe('control_csrf_invalid');

    const missingOrigin = await sendHttp(frontPort, {
      method: 'POST',
      path: '/api/plugins/demo/service/items',
      headers: { [CONTROL_CSRF_HEADER]: csrfToken },
      body: '{}',
    });
    expect(missingOrigin.status).toBe(403);
    expect(JSON.parse(missingOrigin.body.toString('utf8')).error).toBe('control_origin_forbidden');

    // GET with Sec-Fetch-Site: same-site -> 403
    const sameSiteGet = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/status',
      headers: { 'sec-fetch-site': 'same-site' },
    });
    expect(sameSiteGet.status).toBe(403);
    expect(JSON.parse(sameSiteGet.body.toString('utf8')).error).toBe('control_origin_forbidden');

    // GET with unknown origin + foreign Referer -> 403
    const foreignRefererGet = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/status',
      headers: { referer: 'https://evil.example/page' },
    });
    expect(foreignRefererGet.status).toBe(403);
    expect(JSON.parse(foreignRefererGet.body.toString('utf8')).error).toBe('control_origin_forbidden');

    // Individual navigation guards (mode alone, and each blocked dest alone)
    const navModeOnly = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/status',
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    });
    expect(navModeOnly.status).toBe(403);
    expect(JSON.parse(navModeOnly.body.toString('utf8')).error).toBe('plugin_service_navigation_forbidden');

    for (const dest of ['document', 'iframe', 'frame', 'object', 'embed']) {
      const navDest = await sendHttp(frontPort, {
        method: 'GET',
        path: '/api/plugins/demo/service/status',
        headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': dest },
      });
      expect(navDest.status).toBe(403);
      expect(JSON.parse(navDest.body.toString('utf8')).error).toBe('plugin_service_navigation_forbidden');
    }

    // OPTIONS -> 405 with Allow header
    const optionsRes = await sendHttp(frontPort, { method: 'OPTIONS', path: '/api/plugins/demo/service/status' });
    expect(optionsRes.status).toBe(405);
    expect(optionsRes.headers.allow).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(JSON.parse(optionsRes.body.toString('utf8')).error).toBe('method_not_allowed');
    expect(recorded).toHaveLength(0);
  });

  it('forwards authenticated GET/HEAD/POST/PUT/PATCH/DELETE with loopback token, strips sensitive headers, and bypasses $http_proxy/global fetch', async () => {
    vi.stubEnv('http_proxy', 'http://127.0.0.1:1');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    const globalFetch = vi.fn(async () => {
      throw new Error('service proxy must not use global fetch');
    });
    vi.stubGlobal('fetch', globalFetch);

    const { frontPort, loopbackToken, csrfToken, recorded } = await startFixture();

    // GET with same-origin Referer and no Origin/Sec-Fetch-Site succeeds (older browser fallback) and strips Referer
    const refGet = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/items/123?url=https://example.com&diff=a..b',
      headers: {
        cookie: 'botmux_dashboard_token=super-secret',
        referer: `http://127.0.0.1:${frontPort}/#/plugins/demo`,
        'x-forwarded-for': '203.0.113.10',
        'x-botmux-role': 'owner',
      },
    });
    expect(refGet.status).toBe(200);
    expect(refGet.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBe('1');
    expect(refGet.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(refGet.headers['x-content-type-options']).toBe('nosniff');
    expect(refGet.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(refGet.headers['set-cookie']).toBeUndefined();
    expect(refGet.headers['access-control-allow-origin']).toBeUndefined();
    expect(refGet.headers['x-botmux-login-url']).toBeUndefined();
    expect(recorded[0].url).toBe('/items/123?url=https://example.com&diff=a..b');
    expect(recorded[0].headers.authorization).toBe(`Bearer ${loopbackToken}`);
    expect(recorded[0].headers.cookie).toBeUndefined();
    expect(recorded[0].headers.referer).toBeUndefined();
    expect(recorded[0].headers['x-forwarded-for']).toBeUndefined();
    expect(recorded[0].headers['x-botmux-role']).toBeUndefined();
    expect(recorded[0].headers['x-botmux-plugin-id']).toBe('demo');
    expect(recorded[0].headers['x-botmux-proxy-source']).toBe('dashboard');

    // HEAD succeeds with empty body
    const headRes = await sendHttp(frontPort, {
      method: 'HEAD',
      path: '/api/plugins/demo/service/items/123',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBe('1');
    expect(headRes.body.byteLength).toBe(0);

    // POST, PUT, PATCH, DELETE with valid CSRF
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const payload = method === 'DELETE' ? undefined : JSON.stringify({ method });
      const res = await sendHttp(frontPort, {
        method,
        path: `/api/plugins/demo/service/tasks/${method.toLowerCase()}`,
        headers: {
          origin: `http://127.0.0.1:${frontPort}`,
          'sec-fetch-site': 'same-origin',
          [CONTROL_CSRF_HEADER]: csrfToken,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
      const last = recorded[recorded.length - 1];
      expect(last.method).toBe(method);
      expect(last.headers[CONTROL_CSRF_HEADER]).toBeUndefined();
      expect(last.headers.authorization).toBe(`Bearer ${loopbackToken}`);
      if (payload) expect(last.body.toString('utf8')).toBe(payload);
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('blocks path traversal, framing smuggling, GET/HEAD bodies, and single/multi ?t= dashboard token smuggling', async () => {
    const { frontPort, csrfToken, recorded } = await startFixture({ activeToken: 'live-dash-token' });

    for (const rawTarget of [
      '/api/plugins/demo/service/../../../bots',
      '/api/plugins/demo/service/../../../../__health',
      '/api/plugins/demo/service/%2e%2e/settings',
      '/api/plugins/demo/service/a%2fb',
      '/api/plugins/demo/%73ervice/status',
      '/./api/plugins/demo/%73ervice/status',
      '/api/plugins//demo/service/../../../../../__health',
      '//evil.example/api/plugins/demo/service/status',
    ]) {
      const rawRes = await sendRawHttpLine(
        frontPort,
        `GET ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nConnection: close\r\n\r\n`,
      );
      expect(rawRes).toMatch(/^HTTP\/1\.1 400 /);
    }

    // Framing smuggling with valid CSRF -> 501 / 400
    const badTe = await sendRawHttpLine(
      frontPort,
      `POST /api/plugins/demo/service/tasks HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nOrigin: http://127.0.0.1:${frontPort}\r\nSec-Fetch-Site: same-origin\r\n${CONTROL_CSRF_HEADER}: ${csrfToken}\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    );
    expect(badTe).toMatch(/^HTTP\/1\.1 501 /);
    expect(JSON.parse(badTe.slice(badTe.indexOf('\r\n\r\n') + 4))).toEqual({
      ok: false, error: 'unsupported_transfer_encoding',
    });

    // GET & HEAD with body -> 400 body_not_allowed
    for (const rawReq of [
      `GET /api/plugins/demo/service/status HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nSec-Fetch-Site: same-origin\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest`,
      `GET /api/plugins/demo/service/status HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nSec-Fetch-Site: same-origin\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n`,
      `HEAD /api/plugins/demo/service/status HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nSec-Fetch-Site: same-origin\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest`,
    ]) {
      const r = await sendRawHttpLine(frontPort, rawReq);
      expect(r).toMatch(/^HTTP\/1\.1 400 /);
      const body = r.slice(r.indexOf('\r\n\r\n') + 4).trim();
      if (!rawReq.startsWith('HEAD')) expect(JSON.parse(body)).toEqual({ ok: false, error: 'body_not_allowed' });
    }

    // Single and multi-?t= token smuggling blocked; benign ?t= allowed
    for (const badTokenPath of [
      '/api/plugins/demo/service/status?t=live-dash-token',
      '/api/plugins/demo/service/status?t=decoy&t=live-dash-token',
    ]) {
      const r = await sendHttp(frontPort, {
        method: 'GET',
        path: badTokenPath,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body.toString('utf8')).error).toBe('dashboard_token_param_forbidden');
    }
    expect(recorded).toHaveLength(0);

    const benignT = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/status?t=unrelated',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(benignT.status).toBe(200);
    expect(recorded[0].url).toBe('/status?t=unrelated');
  });

  it('rewrites safe Location redirects and strips dangerous/duplicate Location headers both in unit helper and live HTTP pipeline', async () => {
    expect(rewritePluginServiceLocation('/items/2?x=1', 'demo', 9000)).toBe('/api/plugins/demo/service/items/2?x=1');
    expect(rewritePluginServiceLocation('/api/plugins/demo/service', 'demo', 9000)).toBe('/api/plugins/demo/service');
    expect(rewritePluginServiceLocation('http://127.0.0.1:9000/items/3', 'demo', 9000)).toBe('/api/plugins/demo/service/items/3');
    expect(rewritePluginServiceLocation('http://localhost:9000/items/4?a=1', 'demo', 9000)).toBe('/api/plugins/demo/service/items/4?a=1');
    expect(rewritePluginServiceLocation('https://attacker.example/steal', 'demo', 9000)).toBeNull();
    expect(rewritePluginServiceLocation('http://127.0.0.1:9999/other-port', 'demo', 9000)).toBeNull();
    expect(rewritePluginServiceLocation('http://user:pass@127.0.0.1:9000/items', 'demo', 9000)).toBeNull();
    expect(rewritePluginServiceLocation('http://127.0.0.1:9000/items#frag', 'demo', 9000)).toBeNull();
    expect(rewritePluginServiceLocation('/items#frag', 'demo', 9000)).toBeNull();
    expect(rewritePluginServiceLocation('/../../api/host-terminal', 'demo', 9000)).toBeNull();

    let upPort = 0;
    const { frontPort, upstreamPort } = await startFixture({
      upstreamHandler: (req, _body, res) => {
        if (req.url === '/r-safe') res.writeHead(302, { location: '/items/2?x=1' });
        else if (req.url === '/r-self') res.writeHead(302, { location: `http://127.0.0.1:${upPort}/items/3` });
        else if (req.url === '/r-host') res.writeHead(302, { location: '/api/host-terminal' });
        else if (req.url === '/r-ext') res.writeHead(302, { location: 'https://attacker.example/steal' });
        else if (req.url === '/r-trav') res.writeHead(302, { location: '/../../api/host-terminal' });
        else if (req.url === '/r-dup') res.writeHead(302, ['Location', '/items/1', 'Location', '/items/2']);
        else res.writeHead(404);
        res.end();
      },
    });
    upPort = upstreamPort;

    const get = (p: string) => sendHttp(frontPort, {
      method: 'GET',
      path: `/api/plugins/demo/service${p}`,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect((await get('/r-safe')).headers.location).toBe('/api/plugins/demo/service/items/2?x=1');
    expect((await get('/r-self')).headers.location).toBe('/api/plugins/demo/service/items/3');
    expect((await get('/r-host')).headers.location).toBe('/api/plugins/demo/service/api/host-terminal');
    expect((await get('/r-ext')).headers.location).toBeUndefined();
    expect((await get('/r-trav')).headers.location).toBeUndefined();
    expect((await get('/r-dup')).headers.location).toBeUndefined();
  });

  it('streams SSE past headerTimeoutMs and tears down open streams on auth revocation and plugin stop', async () => {
    // 1. SSE survives past headerTimeoutMs/uploadIdleTimeoutMs once headers arrive
    const { frontPort: sseLivePort } = await startFixture({
      headerTimeoutMs: 80,
      uploadIdleTimeoutMs: 80,
      upstreamHandler: (_req, _body, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: first\n\n');
        setTimeout(() => {
          res.write('data: second\n\n');
          res.end();
        }, 140);
      },
    });
    const sseOk = await sendHttp(sseLivePort, {
      method: 'GET',
      path: '/api/plugins/demo/service/stream',
      headers: { 'sec-fetch-site': 'same-origin', accept: 'text/event-stream' },
    });
    expect(sseOk.status).toBe(200);
    expect(sseOk.body.toString('utf8')).toContain('data: first');
    expect(sseOk.body.toString('utf8')).toContain('data: second');

    // 2. Active SSE torn down by auth revocation AND by plugin-scoped closeSessionStreams
    let upstreamResRef: ServerResponse | undefined;
    const { frontPort, connections, recorded } = await startFixture({
      upstreamHandler: (_req, _body, res) => {
        upstreamResRef = res;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: hello\n\n');
      },
    });

    for (const revokeBy of ['auth', 'plugin'] as const) {
      let sawFirstChunk = false;
      let revoking = false;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: unknown) => {
            if (settled) return;
            settled = true;
            upstreamResRef?.end();
            if (err) reject(err);
            else resolve();
          };
          const req = httpRequest({
            host: '127.0.0.1',
            port: frontPort,
            method: 'GET',
            path: '/api/plugins/demo/service/stream',
            headers: {
              'sec-fetch-site': 'same-origin',
              accept: 'text/event-stream',
              'accept-encoding': 'gzip, deflate, br',
            },
            agent: false,
          }, (res) => {
            try {
              expect(res.statusCode).toBe(200);
              expect(res.headers['x-accel-buffering']).toBe('no');
              expect(res.headers['cache-control']).toContain('no-transform');
              expect(res.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBe('1');
              expect(recorded[recorded.length - 1].headers['accept-encoding']).toBe('identity');
            } catch (err) {
              req.destroy();
              finish(err);
              return;
            }
            res.on('data', (chunk) => {
              try {
                if (!sawFirstChunk) {
                  sawFirstChunk = true;
                  expect(chunk.toString('utf8')).toContain('data: hello');
                  revoking = true;
                  const closed = revokeBy === 'auth'
                    ? connections.closeAuthSession(ADMIN_IDENTITY.authSessionId)
                    : connections.closeSessionStreams('plugin:demo');
                  expect(closed).toBe(1);
                }
              } catch (err) {
                req.destroy();
                finish(err);
              }
            });
            res.on('close', () => finish());
            res.on('error', () => finish());
          });
          req.on('error', (err) => finish(revoking ? undefined : err));
          req.end();
        });
      } finally {
        upstreamResRef?.end();
      }
      expect(sawFirstChunk).toBe(true);
    }
  });

  it('aborts in-flight pre-header dial and mid-upload mutations immediately on auth revocation and target swap', async () => {
    // 1. Mid-dial session revocation (before upstream sends headers) -> 403 authentication_revoked
    let sessionLive = true;
    let releaseUpstream!: () => void;
    const { frontPort } = await startFixture({
      liveSession: () => sessionLive,
      upstreamHandler: (_req, _body, res) => {
        releaseUpstream = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"secret":"should-not-leak"}');
        };
      },
    });
    const reqPromise = sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/secret',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    await new Promise(r => setTimeout(r, 40));
    sessionLive = false;
    releaseUpstream();
    const res = await reqPromise;
    expect(res.status).toBe(403);
    expect(res.headers[PLUGIN_SERVICE_PROXY_HEADER]).toBeUndefined();
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: false, error: 'authentication_revoked' });

    // 2. Active revocation during streaming upload tears down before upload completes
    let upstreamSawEnd = false;
    const { frontPort: upFront, csrfToken, connections } = await startFixture({
      rawUpstreamHandler: (req, res) => {
        req.on('end', () => {
          upstreamSawEnd = true;
          res.writeHead(200);
          res.end('mutated');
        });
        req.resume();
      },
    });

    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: upFront,
        method: 'POST',
        path: '/api/plugins/demo/service/mutate',
        headers: {
          origin: `http://127.0.0.1:${upFront}`,
          'sec-fetch-site': 'same-origin',
          [CONTROL_CSRF_HEADER]: csrfToken,
          'transfer-encoding': 'chunked',
        },
        agent: false,
      }, (r) => {
        r.resume();
        r.on('end', () => resolve());
        r.on('close', () => resolve());
      });
      req.on('error', () => resolve());
      req.write('{"step":1}');
      setTimeout(() => {
        expect(connections.closeAuthSession(ADMIN_IDENTITY.authSessionId)).toBe(1);
      }, 40);
    });
    expect(upstreamSawEnd).toBe(false);
  });

  it('handles early upstream 413 on incomplete streaming upload cleanly with Connection: close, 205 zero-length framing, uploadIdleTimeoutMs < headerTimeoutMs, 101/504/503, and FIN truncation', async () => {
    // 1. uploadIdleTimeoutMs (80ms) < headerTimeoutMs (400ms) with 160ms upstream delay must SUCCEED
    const { frontPort: timerFront } = await startFixture({
      uploadIdleTimeoutMs: 80,
      headerTimeoutMs: 400,
      upstreamHandler: (_req, _body, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"slow":true}');
        }, 160);
      },
    });
    const slowRes = await sendHttp(timerFront, {
      method: 'GET',
      path: '/api/plugins/demo/service/slow',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(slowRes.status).toBe(200);

    // 2. Early upstream 413 on incomplete streaming POST returns full 413 JSON with Connection: close
    const { frontPort: earlyFront, csrfToken } = await startFixture({
      rawUpstreamHandler: (req, res) => {
        req.once('data', () => {
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          res.write('{"error":"too_la');
          setTimeout(() => res.end('rge","limit":16}'), 15);
        });
      },
    });
    const earlyRes = await new Promise<{ status: number; conn?: string; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: earlyFront,
        method: 'POST',
        path: '/api/plugins/demo/service/upload',
        headers: {
          origin: `http://127.0.0.1:${earlyFront}`,
          'sec-fetch-site': 'same-origin',
          [CONTROL_CSRF_HEADER]: csrfToken,
          'content-length': '100000',
        },
        agent: false,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          conn: res.headers.connection,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.write('initial-chunk-only');
    });
    expect(earlyRes.status).toBe(413);
    expect(earlyRes.conn).toBe('close');
    expect(JSON.parse(earlyRes.body)).toEqual({ error: 'too_large', limit: 16 });

    // 3. 205 Reset Content normalizes content-length to '0', 101 -> 502, timeout -> 504, ECONNREFUSED -> 503
    const { frontPort: edgeFront } = await startFixture({
      headerTimeoutMs: 120,
      upstreamHandler: (req, _body, res) => {
        if (req.url === '/205') {
          res.writeHead(205, { 'content-length': '5' });
          res.end('hello');
        } else if (req.url === '/101') {
          res.socket?.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        } else if (req.url === '/hang') {
          // never respond
        }
      },
    });
    const r205 = await sendHttp(edgeFront, { method: 'GET', path: '/api/plugins/demo/service/205', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r205.status).toBe(205);
    expect(r205.headers['content-length']).toBe('0');
    expect(r205.body.byteLength).toBe(0);

    const r101 = await sendHttp(edgeFront, { method: 'GET', path: '/api/plugins/demo/service/101', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r101.status).toBe(502);
    expect(JSON.parse(r101.body.toString('utf8')).error).toBe('plugin_service_upgrade_unsupported');

    const rHang = await sendHttp(edgeFront, { method: 'GET', path: '/api/plugins/demo/service/hang', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(rHang.status).toBe(504);
    expect(JSON.parse(rHang.body.toString('utf8')).error).toBe('plugin_service_timeout');

    // ECONNREFUSED -> 503 plugin_service_unreachable
    const deadServer = createServer();
    const deadPort = await listenServer(deadServer);
    await closeServer(deadServer);
    const { frontPort: deadFront } = await startFixture({
      resolveTarget: () => ({ ok: true, host: '127.0.0.1', port: deadPort, token: 'T'.repeat(43), pid: 1, processStart: 'x' }),
    });
    const deadRes = await sendHttp(deadFront, { method: 'GET', path: '/api/plugins/demo/service/status', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(deadRes.status).toBe(503);
    expect(JSON.parse(deadRes.body.toString('utf8')).error).toBe('plugin_service_unreachable');

    // 4. Premature TCP FIN truncation destroys downstream after 200 + 'partial'
    const rawUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.write('partial');
      res.socket?.end();
    });
    servers.push(rawUpstream);
    const upPort = await listenServer(rawUpstream);
    const { frontPort: finFront } = await startFixture({
      resolveTarget: () => ({ ok: true, host: '127.0.0.1', port: upPort, token: 'Z'.repeat(43), pid: 1, processStart: 'x' }),
    });

    let finStatus = 0;
    const finChunks: Buffer[] = [];
    const finOutcome = await new Promise<'aborted' | 'clean-end'>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: finFront,
        method: 'GET',
        path: '/api/plugins/demo/service/partial',
        headers: { 'sec-fetch-site': 'same-origin' },
        agent: false,
      }, (res) => {
        finStatus = res.statusCode ?? 0;
        res.on('data', c => finChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('aborted', () => resolve('aborted'));
        res.on('error', () => resolve('aborted'));
        res.on('end', () => resolve(res.complete ? 'clean-end' : 'aborted'));
        res.on('close', () => { if (!res.complete) resolve('aborted'); });
      });
      req.on('error', (err) => { if (finStatus === 200) resolve('aborted'); else reject(err); });
      req.end();
    });
    expect(finStatus).toBe(200);
    expect(Buffer.concat(finChunks).toString('utf8')).toBe('partial');
    expect(finOutcome).toBe('aborted');
  });

  it('fails closed with 404 (unknown/constructor/no-service) and 503 (missing token)', async () => {
    const { frontPort } = await startFixture({
      plugins: {
        demo: makePlugin('demo', true),
        'no-svc': makePlugin('no-svc', false),
      },
      resolveTarget: () => ({ ok: false, status: 503, error: 'plugin_service_token_unavailable' }),
    });

    const noSvc = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/no-svc/service/status',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(noSvc.status).toBe(404);
    expect(JSON.parse(noSvc.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_service_not_configured' });

    for (const missingId of ['unknown', 'constructor']) {
      const r = await sendHttp(frontPort, {
        method: 'GET',
        path: `/api/plugins/${missingId}/service/status`,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_not_found' });
    }

    const noTok = await sendHttp(frontPort, {
      method: 'GET',
      path: '/api/plugins/demo/service/status',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(noTok.status).toBe(503);
    expect(JSON.parse(noTok.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_service_token_unavailable' });
  });
});
