/**
 * 工作流侧边栏在真实 Dashboard 进程里的接线（设计 2026-11-03 §11.3）：独立 HOME 起一个真的
 * index-dashboard，一个假的主 Bot daemon 回答群成员核对。
 *
 *   - 本机管理 cookie（管理员）：入口跳到侧栏版式，数据接口给完整视图，不问群成员；
 *   - 平台透传的非管理身份（guest + union_id）：经主 Bot daemon 核对在群后拿到精简视图，
 *     发给 daemon 的核对请求只带 run 的群和这个 union_id；不在群 403；
 *   - 没有身份：数据接口 401，入口落到 SPA 登录层（未配 H5）；同一个窄身份照旧进不了
 *     `/api/v3/runs/*`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { cleanupBotRuns } from './helpers/v3-external-harness.js';
import { copyRunInto, SIDEBAR_CHAT, SIDEBAR_MAIN, SECRET_REASON, sidebarRun } from './helpers/workflow-sidebar-fixture.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function request(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const response = await loopbackFetch(url, { headers, signal: controller.signal, redirect: 'manual' });
    const location = response.headers.get('location') ?? undefined;
    return { status: response.status, body: await response.text(), ...(location ? { location } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10_000);
  timer.unref();
  await closed;
  clearTimeout(timer);
}

describe('workflow sidebar inside the real dashboard', () => {
  let rootDir = '';
  let fakeDaemon: Server | undefined;
  let dashboard: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboard);
    dashboard = undefined;
    if (fakeDaemon?.listening) await new Promise<void>((done) => fakeDaemon!.close(() => done()));
    fakeDaemon = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
    cleanupBotRuns();
  });

  it('admin full view, platform member trimmed view via the main bot\'s daemon, everyone else refused', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-wfs-dashboard-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-wfs-test', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(join(botmuxDir, 'bots.json'), JSON.stringify([{
      larkAppId: SIDEBAR_MAIN, larkAppSecret: 'secret', botName: 'main bot', cliId: 'claude-code',
    }]));
    // A bound platform with an unreachable URL: identities injected by the
    // platform proxy are accepted, the tunnel just keeps failing to connect.
    writeFileSync(join(botmuxDir, 'platform.json'), JSON.stringify({
      platformUrl: 'http://127.0.0.1:9', machineToken: 'machine-token', machineId: 'machine-wfs',
    }), { mode: 0o600 });
    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
    const runsDir = join(botmuxDir, 'v3-runs');
    mkdirSync(runsDir, { recursive: true });
    const { run, runId } = await sidebarRun('wfs-live-run');
    copyRunInto(run, runsDir);

    const asked: unknown[] = [];
    fakeDaemon = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (req.method === 'POST' && req.url === '/api/workflow-sidebar/chat-membership') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        asked.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, member: body.unionId === 'on_platform_member' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    });
    const daemonPort = await listen(fakeDaemon);
    writeFileSync(join(registryDir, `${SIDEBAR_MAIN}.json`), JSON.stringify({
      larkAppId: SIDEBAR_MAIN, botName: 'main bot', botIndex: 0, ipcPort: daemonPort,
      pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now(),
    }));

    dashboard = spawnTsScript(DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir, USERPROFILE: homeDir, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(botmuxDir, 'bots.json'),
        BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
        BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    dashboard.stdout?.on('data', (chunk) => { logs += String(chunk); });
    dashboard.stderr?.on('data', (chunk) => { logs += String(chunk); });
    let port = 0;
    const deadline = Date.now() + 20_000;
    while (!port && Date.now() < deadline) {
      if (dashboard.exitCode !== null) throw new Error(`dashboard exited\n${logs}`);
      try {
        const candidate = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8').trim());
        if (candidate > 0 && (await request(`http://127.0.0.1:${candidate}/__health`)).status === 200) port = candidate;
      } catch { /* booting */ }
      if (!port) await new Promise((done) => setTimeout(done, 100));
    }
    expect(port, logs).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;
    const entry = `${base}/workflow/${SIDEBAR_MAIN}/${runId}`;
    const data = `${base}/api/workflow-sidebar/${SIDEBAR_MAIN}/${runId}`;
    const adminCookie = { cookie: `botmux_dashboard_token=${token}` };

    // Admin.
    const adminEntry = await request(entry, adminCookie);
    expect(adminEntry.status, logs).toBe(302);
    expect(adminEntry.location).toBe(`/#/workflows/${runId}?app=${SIDEBAR_MAIN}&botmuxWorkbenchShell=immersive`);
    const adminData = await request(data, adminCookie);
    expect(adminData.status, logs).toBe(200);
    expect(JSON.parse(adminData.body)).toMatchObject({ audience: 'admin', view: { nodes: [{ id: 'write', errorCode: 'BOT_REPORTED_BLOCKED' }] } });
    expect(asked).toEqual([]);

    // Platform-forwarded identities (the platform proxy injects the active cookie).
    const platform = (actor: string) => ({ ...adminCookie, 'x-botmux-role': 'guest', 'x-botmux-actor': actor });
    const member = await request(data, platform('on_platform_member'));
    expect(member.status, logs).toBe(200);
    expect(JSON.parse(member.body).audience).toBe('member');
    expect(member.body).not.toContain(SECRET_REASON);
    expect(member.body).not.toContain('BOT_REPORTED_BLOCKED');
    expect(asked).toEqual([{ chatId: SIDEBAR_CHAT, unionId: 'on_platform_member' }]);
    expect((await request(data, platform('on_platform_outsider'))).status).toBe(403);
    // The same identity is still not an admin anywhere else.
    expect((await request(`${base}/api/v3/runs/${runId}`, platform('on_platform_member'))).status).toBe(401);

    // Nobody.
    expect((await request(data)).status).toBe(401);
    expect((await request(entry)).location).toBe(`/#/workflows/${runId}?app=${SIDEBAR_MAIN}&botmuxWorkbenchShell=immersive`);
  }, 40_000);
});
