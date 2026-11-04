// Real Dashboard process and HTTP routing; daemon replies are isolated fixtures.
// No real worker, business session, or external service is started or stopped.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { spawnTsScript } from './helpers/ts-runner.js';
import { cliAuthBind, loadOrCreatePersistedToken, verifyHmac } from '../src/dashboard/auth.js';
import { loopbackFetch, type LoopbackFetchInit } from '../src/core/loopback-fetch.js';

async function request(url: string, init: LoopbackFetchInit = {}) {
  const response = await loopbackFetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}

describe('Dashboard session stop HTTP integration', () => {
  let root = '';
  let child: ChildProcess | undefined;
  const daemons: Server[] = [];

  afterEach(async () => {
    await stopChild(child); child = undefined;
    for (const daemon of daemons.splice(0)) {
      daemon.closeAllConnections();
      if (daemon.listening) await new Promise<void>(done => daemon.close(() => done()));
    }
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('authenticates, routes suspend and exact interrupt to the owner, and preserves daemon outcomes', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-session-stop-http-'));
    const isolatedHome = join(root, 'home');
    const botmuxDir = join(isolatedHome, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsPath = join(botmuxDir, 'bots.json');
    mkdirSync(registryDir, { recursive: true });
    const secret = 'isolated-session-stop-test-secret';
    writeFileSync(join(botmuxDir, '.dashboard-secret'), secret, { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.env'), '', { mode: 0o600 });
    writeFileSync(botsPath, JSON.stringify(['owner', 'decoy'].map(id => ({
      larkAppId: `cli-stop-${id}`, larkAppSecret: 'fixture-only', botName: id, cliId: 'codex',
    }))));
    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
    const sessionId = 'session one/encoded';
    const triggerId = 'turn one/encoded';
    const suspendPath = `/api/sessions/${encodeURIComponent(sessionId)}/suspend`;
    const interruptPath = `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(triggerId)}/interrupt`;
    const writes: Array<{ owner: string; path: string; body: string; authenticated: boolean }> = [];
    let suspendReply = { status: 200, body: { ok: true, sessionId, suspended: false, reason: 'deferred' } as object };
    let interruptReply = { status: 409, body: { ok: false, errorCode: 'trigger_failed', error: 'stale_turn' } as object };

    for (const [index, owner] of ['owner', 'decoy'].entries()) {
      const appId = `cli-stop-${owner}`;
      const daemon = createServer(async (req, res) => {
        const route = req.url ?? '/';
        if (req.method === 'GET' && route === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': fixture stream\n\n');
          return;
        }
        if (req.method === 'GET' && route === '/api/sessions') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ sessions: [{ sessionId: owner === 'owner' ? sessionId : 'decoy-session',
            larkAppId: appId, status: 'active', workingDir: root, cliId: 'codex' }] }));
          return;
        }
        if (req.method === 'GET' && route === '/api/schedules') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"schedules":[]}'); return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const verified = verifyHmac(secret, {
            ts: String(req.headers['x-botmux-cli-ts'] ?? ''),
            nonce: String(req.headers['x-botmux-cli-nonce'] ?? ''),
            sig: String(req.headers['x-botmux-cli-auth'] ?? ''),
          }, req.socket.remoteAddress ?? '', cliAuthBind('POST', route, req.socket.localPort!));
          writes.push({ owner, path: route, body: Buffer.concat(chunks).toString('utf8'), authenticated: verified.ok });
          const reply = route === suspendPath ? suspendReply : route === interruptPath ? interruptReply : null;
          res.writeHead(!verified.ok ? 401 : reply?.status ?? 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(!verified.ok ? { ok: false, error: 'invalid_fixture_ipc_auth' }
            : reply?.body ?? { ok: false, error: 'unexpected_route' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"unexpected_route"}');
      });
      daemons.push(daemon);
      daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
      const port = (daemon.address() as import('node:net').AddressInfo).port;
      writeFileSync(join(registryDir, `${appId}.json`), JSON.stringify({ larkAppId: appId,
        botName: owner, botIndex: index, ipcPort: port, pid: process.pid,
        startedAt: Date.now(), lastHeartbeat: Date.now() }));
    }

    child = spawnTsScript(resolve('src/index-dashboard.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath, BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', chunk => { logs += String(chunk); });
    child.stderr?.on('data', chunk => { logs += String(chunk); });
    let base = '';
    const auth = { cookie: `botmux_dashboard_token=${token}`, 'content-type': 'application/json' };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Dashboard exited early\n${logs}`);
      try {
        const port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8').trim());
        const candidate = `http://127.0.0.1:${port}`;
        const snapshot = await request(`${candidate}/api/sessions`, { headers: auth });
        if (snapshot.status === 200 && snapshot.body.sessions?.some((row: { sessionId: string }) => row.sessionId === sessionId)) {
          base = candidate; break;
        }
      } catch { /* Wait for the real process and owner snapshot. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    expect(base, logs).not.toBe('');
    const post = (route: string, authenticated = true) => request(base + route,
      { method: 'POST', headers: authenticated ? auth : { 'content-type': 'application/json' }, body: '{}' });

    for (const route of [suspendPath, interruptPath]) expect((await post(route, false)).status).toBe(401);
    expect(writes).toEqual([]);
    expect(await post(suspendPath), logs).toEqual(suspendReply);
    expect(writes).toEqual([{ owner: 'owner', path: suspendPath, body: '{}', authenticated: true }]);
    expect(await post(interruptPath)).toEqual(interruptReply);
    expect(writes.at(-1)).toEqual({ owner: 'owner', path: interruptPath, body: '{}', authenticated: true });

    for (const reply of [
      { status: 200, body: { ok: true, sessionId, suspended: false, reason: 'no_live_worker' } },
      { status: 200, body: { ok: true, sessionId, suspended: true } },
      { status: 409, body: { ok: false, error: 'backend_not_suspendable' } },
      { status: 404, body: { ok: false, error: 'session_not_active' } },
    ]) { suspendReply = reply; expect(await post(suspendPath)).toEqual(reply); }
    interruptReply = { status: 200, body: { ok: true, action: 'interrupted', sessionId, triggerId } };
    expect(await post(interruptPath)).toEqual(interruptReply);
    expect(writes.every(write => write.owner === 'owner' && write.authenticated)).toBe(true);

    const beforeRejected = writes.length;
    expect(await post('/api/sessions/unknown/suspend')).toEqual({ status: 404, body: { ok: false, error: 'unknown_session' } });
    expect((await post('/api/sessions/%ZZ/suspend')).status).toBe(400);
    expect((await request(base + suspendPath, { headers: auth })).status).toBe(404);
    expect((await post(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`)).status).toBe(404);
    expect(writes.length).toBe(beforeRejected);

    expect((await request(`${base}/api/settings`, { method: 'PUT', headers: auth,
      body: '{"publicReadOnly":true}' })).status).toBe(200);
    for (const route of [suspendPath, interruptPath]) expect((await post(route, false)).status).toBe(401);
    expect(writes.length).toBe(beforeRejected);
  }, 25_000);
});
