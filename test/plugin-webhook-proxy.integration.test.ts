import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomInt } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch, type LoopbackFetchInit } from '../src/core/loopback-fetch.js';
import { CONTROL_CSRF_HEADER } from '../src/dashboard/control-csrf.js';
import { PLUGIN_SERVICE_PROXY_HEADER } from '../src/dashboard/plugin-service-proxy.js';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>(r => server.close(() => r()));
}

async function waitForDashboardPort(
  portPath: string,
  child: ChildProcess,
  logs: () => string,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dashboard exited early\n${logs()}`);
    }
    try {
      const port = Number(readFileSync(portPath, 'utf8').trim());
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        const res = await loopbackFetch(`http://127.0.0.1:${port}/__health`);
        if (res.status === 200) return port;
      }
    } catch {
      // still booting
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for dashboard\n${logs()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closePromise = once(child, 'close');
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      new Promise<'timeout'>(r => {
        timer = setTimeout(() => r('timeout'), 2_500);
        timer.unref();
      }),
    ]);
    if (outcome === 'timeout' && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closePromise;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendRawHttp(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => sock.write(rawRequest));
    const chunks: Buffer[] = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

describe('live Dashboard integration: plugin webhooks + authenticated service proxy', () => {
  let rootDir = '';
  let pluginServer: Server | undefined;
  let dashboardChild: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboardChild);
    dashboardChild = undefined;
    await closeServer(pluginServer);
    pluginServer = undefined;
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = '';
    }
  });

  it('routes pre-auth raw webhooks and post-auth CSRF-checked service proxy calls end-to-end through src/index-dashboard.ts', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dash-plugin-proxy-e2e-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const botsConfigPath = join(botmuxDir, 'bots.json');
    writeFileSync(botsConfigPath, '[]', 'utf8');
    writeFileSync(join(botmuxDir, '.env'), '', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'b'.repeat(64), { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), dataDir, { mode: 0o600 });
    const dashboardToken = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));

    const pluginId = 'live-proxy-plugin';
    const cardToken = 'C'.repeat(43);
    const webhookToken = 'W'.repeat(43);
    const hmacSecret = 'live-hmac-secret';
    const received: Array<{ method: string; url: string; headers: IncomingMessage['headers']; rawBody: Buffer }> = [];
    const openSseRes: ServerResponse[] = [];

    pluginServer = createServer((req, res) => {
      if (req.url === '/sse') {
        if (req.headers.authorization !== `Bearer ${cardToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad_token' }));
          return;
        }
        openSseRes.push(res);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: open\n\n');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, rawBody });
        const expectedToken = req.url?.startsWith('/events') ? webhookToken : cardToken;
        if (req.headers.authorization !== `Bearer ${expectedToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad_loopback_token' }));
          return;
        }
        if (req.url === '/upstream-401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'upstream_token_expired' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: req.url, bytes: rawBody.byteLength }));
      });
    });
    const pluginPort = await listen(pluginServer);
    const selfProcessStart = readDurableProcessIdentity(process.pid);
    expect(selfProcessStart).toBeTruthy();

    // Seed installed plugin registry, service.json (with processStart), and isolated 0600 private tokens
    const pluginDir = join(botmuxDir, 'plugins', pluginId);
    mkdirSync(join(pluginDir, 'dist', 'service'), { recursive: true });
    mkdirSync(join(pluginDir, 'private'), { recursive: true, mode: 0o700 });
    const cardTokenPath = join(pluginDir, 'private', 'card-actions.token');
    const webhookTokenPath = join(pluginDir, 'private', 'webhooks.token');
    writeFileSync(cardTokenPath, `${cardToken}\n`, { mode: 0o600 });
    writeFileSync(webhookTokenPath, `${webhookToken}\n`, { mode: 0o600 });
    const serviceJsonPath = join(pluginDir, 'service.json');
    const writeSvcState = (port: number) => {
      writeFileSync(serviceJsonPath, JSON.stringify({
        pluginId,
        updatedAt: new Date().toISOString(),
        status: 'online',
        pid: process.pid,
        processStart: selfProcessStart,
        port,
      }), { mode: 0o600 });
    };
    writeSvcState(pluginPort);

    writeFileSync(join(botmuxDir, 'plugins-registry.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      plugins: {
        [pluginId]: {
          id: pluginId,
          packageName: `botmux-plugin-${pluginId}`,
          version: '1.0.0',
          source: { type: 'local', spec: pluginDir },
          manifest: { schemaVersion: 1, id: pluginId, service: { mode: 'manual' } },
          contributions: {
            service: { entry: 'service/index.js', mode: 'manual' },
            webhooks: {
              schemaVersion: 1,
              maxBodyBytes: 128,
              routes: [{ path: '/events' }],
            },
          },
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }), { mode: 0o600 });

    const shellHtmlPath = join(rootDir, 'index.html');
    writeFileSync(shellHtmlPath, '<!doctype html><html><head></head><body>ok</body></html>', 'utf8');

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key === 'BOTMUX_PUBLIC_URL' || key === 'BOTMUX_CORE_ONLY' || key.startsWith('BOTMUX_DASHBOARD_')) {
        delete childEnv[key];
      }
    }
    let desiredDashPort = randomInt(20_000, 55_000);
    while (pluginPort >= desiredDashPort && pluginPort <= desiredDashPort + 25) {
      desiredDashPort = randomInt(20_000, 55_000);
    }

    const portPath = join(botmuxDir, '.dashboard-port');
    const outputChunks: string[] = [];
    dashboardChild = spawnTsEvalWithRepoImports(
      `globalThis.__BOTMUX_DASHBOARD_ASSETS__ = { 'index.html': ${JSON.stringify(shellHtmlPath)} };
       await import(${JSON.stringify(DASHBOARD_ENTRY)});`,
      {
        env: {
          ...childEnv,
          HOME: homeDir,
          USERPROFILE: homeDir,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: botsConfigPath,
          BOTMUX_NO_CLAIM: '1',
          BOTMUX_DASHBOARD_HOST: '127.0.0.1',
          BOTMUX_DASHBOARD_PORT: String(desiredDashPort),
          BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    dashboardChild.stdout?.on('data', c => outputChunks.push(c.toString()));
    dashboardChild.stderr?.on('data', c => outputChunks.push(c.toString()));

    const dashPort = await waitForDashboardPort(portPath, dashboardChild, () => outputChunks.join(''));
    const base = `http://127.0.0.1:${dashPort}`;
    const cookieHeader = `botmux_dashboard_token=${dashboardToken}`;

    // 1. Pre-auth webhook works without Dashboard cookie, uses isolated webhook token, and preserves exact raw bytes for HMAC
    const rawPayload = Buffer.from('{  "event":  "push",  "id": 7 }\n', 'utf8');
    const sig = `sha256=${createHmac('sha256', hmacSecret).update(rawPayload).digest('hex')}`;
    const hookRes = await loopbackFetch(`${base}/webhook/plugin/${pluginId}/events?source=ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-256': sig },
      body: rawPayload,
    } as LoopbackFetchInit);
    expect(hookRes.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].rawBody.equals(rawPayload)).toBe(true);
    expect(createHmac('sha256', hmacSecret).update(received[0].rawBody).digest('hex'))
      .toBe(sig.replace('sha256=', ''));
    expect(received[0].headers.authorization).toBe(`Bearer ${webhookToken}`);

    // Undeclared route -> 404, oversized -> 413, 4-level traversal to /__health and /__selfcheck -> 400
    const undeclared = await loopbackFetch(`${base}/webhook/plugin/${pluginId}/unknown`, { method: 'POST', body: '{}' });
    expect(undeclared.status).toBe(404);
    expect(await undeclared.json()).toEqual({ ok: false, error: 'webhook_route_not_found' });

    const oversized = await loopbackFetch(`${base}/webhook/plugin/${pluginId}/events`, {
      method: 'POST',
      body: Buffer.alloc(256, 0x78),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ ok: false, error: 'body_too_large', maxBodyBytes: 128 });

    const webhookHealthTrav = await sendRawHttp(
      dashPort,
      `POST /webhook/plugin/${pluginId}/events/../../../../__health HTTP/1.1\r\nHost: 127.0.0.1:${dashPort}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(webhookHealthTrav).toMatch(/^HTTP\/1\.1 400 /);
    const webhookSelfcheckTrav = await sendRawHttp(
      dashPort,
      `GET /webhook/plugin/${pluginId}/events/../../../../__selfcheck HTTP/1.1\r\nHost: 127.0.0.1:${dashPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(webhookSelfcheckTrav).toMatch(/^HTTP\/1\.1 400 /);
    expect(received).toHaveLength(1);

    // 2. Dashboard service proxy requires auth (401 without cookie, no plugin-proxy marker)
    const unauthSvc = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/status`);
    expect(unauthSvc.status).toBe(401);
    expect(unauthSvc.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBeNull();

    // Early traversal guard blocks /api/plugins/:id/service/../../../../__health BEFORE hitting /__health
    const svcTraversal = await sendRawHttp(
      dashPort,
      `GET /api/plugins/${pluginId}/service/../../../../__health HTTP/1.1\r\nHost: 127.0.0.1:${dashPort}\r\nCookie: ${cookieHeader}\r\nConnection: close\r\n\r\n`,
    );
    expect(svcTraversal).toMatch(/^HTTP\/1\.1 400 /);

    // Authenticated GET succeeds using cardToken (isolated from webhookToken) and returns x-botmux-plugin-proxy: 1
    const authGet = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/status?q=1`, {
      headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    });
    expect(authGet.status).toBe(200);
    expect(authGet.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBe('1');
    expect(await authGet.json()).toEqual({ ok: true, url: '/status?q=1', bytes: 0 });
    expect(received[1].headers.authorization).toBe(`Bearer ${cardToken}`);

    // Upstream 401 carries x-botmux-plugin-proxy: 1
    const upstream401 = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/upstream-401`, {
      headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    });
    expect(upstream401.status).toBe(401);
    expect(upstream401.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBe('1');

    // Authenticated POST without CSRF -> 403 control_csrf_invalid
    const noCsrfPost = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/mutate`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: base,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: '{"ok":true}',
    });
    expect(noCsrfPost.status).toBe(403);
    expect(noCsrfPost.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBeNull();
    expect(await noCsrfPost.json()).toEqual({ ok: false, error: 'control_csrf_invalid' });
    expect(received).toHaveLength(3);

    // Fetch live CSRF token from authenticated Dashboard shell HTML <meta name="botmux-csrf">
    const shellRes = await loopbackFetch(`${base}/`, { headers: { cookie: cookieHeader } });
    expect(shellRes.status).toBe(200);
    const html = await shellRes.text();
    const csrfMatch = html.match(/<meta name="botmux-csrf" content="([^"]+)"/);
    expect(csrfMatch?.[1]).toBeTruthy();

    // Authenticated POST with live CSRF token + same-origin -> 200
    const csrfPost = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/mutate`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: base,
        'sec-fetch-site': 'same-origin',
        [CONTROL_CSRF_HEADER]: csrfMatch![1],
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'ping' }),
    });
    expect(csrfPost.status).toBe(200);
    expect(csrfPost.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBe('1');
    expect(await csrfPost.json()).toEqual({ ok: true, url: '/mutate', bytes: 17 });

    // 3. Live SSE stream is torn down when POST /api/plugins/:id/services/stop is called
    let sseOpened = false;
    let stoppingSse = false;
    let stopReqPromise: Promise<Response> | undefined;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let done = false;
      const finish = (err?: unknown) => {
        if (done) return;
        done = true;
        if (err) rejectPromise(err);
        else resolvePromise();
      };
      const req = httpRequest({
        host: '127.0.0.1',
        port: dashPort,
        method: 'GET',
        path: `/api/plugins/${pluginId}/service/sse`,
        headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin', accept: 'text/event-stream' },
        agent: false,
      }, (res) => {
        res.on('data', (chunk) => {
          if (!sseOpened && chunk.toString('utf8').includes('data: open')) {
            sseOpened = true;
            stoppingSse = true;
            stopReqPromise = loopbackFetch(`${base}/api/plugins/${pluginId}/services/stop`, {
              method: 'POST',
              headers: { cookie: cookieHeader, origin: base, 'sec-fetch-site': 'same-origin' },
            });
          }
        });
        res.on('close', () => finish());
        res.on('error', () => finish());
      });
      req.on('error', (err) => finish(stoppingSse ? undefined : err));
      req.end();
    });
    expect(sseOpened).toBe(true);
    expect(stopReqPromise).toBeDefined();
    const stopRes = await stopReqPromise!;
    expect(stopRes.status).toBe(200);
    for (const r of openSseRes) { try { r.end(); } catch { /* ignore */ } }

    // 4. pluginProxyForbiddenPorts blocks self-proxy to Dashboard's own port on both routes
    writeSvcState(dashPort);
    const selfWebhook = await loopbackFetch(`${base}/webhook/plugin/${pluginId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(selfWebhook.status).toBe(503);
    expect(await selfWebhook.json()).toEqual({ ok: false, error: 'plugin_service_unavailable' });

    const selfService = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/__health`, {
      headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    });
    expect(selfService.status).toBe(503);
    expect(selfService.headers.get(PLUGIN_SERVICE_PROXY_HEADER)).toBeNull();
    expect(await selfService.json()).toEqual({ ok: false, error: 'plugin_service_unavailable' });

    // 5. Removing private token files fails closed with 503 without minting replacement tokens
    writeSvcState(pluginPort);
    rmSync(webhookTokenPath);
    rmSync(cardTokenPath);
    const receivedBefore = received.length;

    const missingTokHook = await loopbackFetch(`${base}/webhook/plugin/${pluginId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missingTokHook.status).toBe(503);
    expect(await missingTokHook.json()).toEqual({ ok: false, error: 'plugin_service_token_unavailable' });
    expect(existsSync(webhookTokenPath)).toBe(false);

    const missingTokSvc = await loopbackFetch(`${base}/api/plugins/${pluginId}/service/status`, {
      headers: { cookie: cookieHeader, 'sec-fetch-site': 'same-origin' },
    });
    expect(missingTokSvc.status).toBe(503);
    expect(await missingTokSvc.json()).toEqual({ ok: false, error: 'plugin_service_token_unavailable' });
    expect(existsSync(cardTokenPath)).toBe(false);
    expect(received).toHaveLength(receivedBefore);
  }, 30_000);
});
