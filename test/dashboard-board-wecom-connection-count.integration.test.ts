// Real Dashboard process and HTTP routing for the browser board snapshot (`GET /api/sessions?view=board`):
// it tells the host admin whether WeCom connections exist, and says nothing when there are none.
// The daemon reply is an isolated fixture; HOME is a temp dir, so no real WeCom config is read.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';

async function request(url: string, headers: Record<string, string> = {}) {
  const response = await loopbackFetch(url, { headers, signal: AbortSignal.timeout(2_000) });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}

describe('Dashboard board snapshot and WeCom connections', () => {
  let root = '';
  let child: ChildProcess | undefined;
  let daemon: Server | undefined;

  afterEach(async () => {
    await stopChild(child); child = undefined;
    if (daemon) {
      daemon.closeAllConnections();
      if (daemon.listening) await new Promise<void>(done => daemon!.close(() => done()));
    }
    daemon = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('omits every WeCom field without connections and reports the count to the host admin once one exists', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-board-wecom-count-'));
    const isolatedHome = join(root, 'home');
    const botmuxDir = join(isolatedHome, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsPath = join(botmuxDir, 'bots.json');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'isolated-board-wecom-count-secret', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.env'), '', { mode: 0o600 });
    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli-board-count', larkAppSecret: 'fixture-only', botName: 'Board bot', cliId: 'codex' }]));
    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));

    daemon = createServer((req, res) => {
      const route = req.url ?? '/';
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': fixture stream\n\n');
        return;
      }
      if (req.method === 'GET' && route === '/api/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessions: [{ sessionId: 'live-1', status: 'active', title: 'Live', larkAppId: 'cli-board-count', cliId: 'codex', lastMessageAt: 1 }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"unexpected_route"}');
    });
    daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
    const port = (daemon.address() as import('node:net').AddressInfo).port;
    writeFileSync(join(registryDir, 'cli-board-count.json'), JSON.stringify({ larkAppId: 'cli-board-count',
      botName: 'Board bot', botIndex: 0, ipcPort: port, pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() }));

    child = spawnTsScript(resolve('src/index-dashboard.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath, BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', chunk => { logs += String(chunk); });
    child.stderr?.on('data', chunk => { logs += String(chunk); });
    const admin = { cookie: `botmux_dashboard_token=${token}` };
    let origin = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Dashboard exited early\n${logs}`);
      try {
        const dashboardPort = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8').trim());
        const candidate = `http://127.0.0.1:${dashboardPort}`;
        const snapshot = await request(`${candidate}/api/sessions?view=board`, admin);
        if (snapshot.status === 200 && snapshot.body.sessions?.length === 1) { origin = candidate; break; }
      } catch { /* Wait for the real process and the daemon snapshot. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    expect(origin, logs).not.toBe('');
    const board = (headers: Record<string, string> = admin) => request(`${origin}/api/sessions?view=board`, headers);

    // 没有企业微信连接：响应里没有任何企业微信字段（与企微接入前的响应体同形）。
    const feishuOnly = await board();
    expect(feishuOnly.status).toBe(200);
    expect(feishuOnly.body).not.toHaveProperty('wecomConnectionCount');
    expect(feishuOnly.body).not.toHaveProperty('wecomSessionIds');

    // 配上一个企业微信连接（只要配置文件存在就算，和 /api/wecom/connections 列出的条目一致）。
    const wecomDir = join(botmuxDir, 'wecom');
    mkdirSync(wecomDir, { recursive: true });
    writeFileSync(join(wecomDir, 'config.json'), '{}');
    const withWecom = await board();
    expect(withWecom.status).toBe(200);
    expect(withWecom.body.wecomConnectionCount).toBe(1);

    // 非管理员（公开只读访客）看不到企业微信，也拿不到这个数。
    const visitor = await board({});
    expect(visitor.status).toBe(200);
    expect(visitor.body).not.toHaveProperty('wecomConnectionCount');
  }, 60_000);
});
