/**
 * 工作流侧边栏在真实 Dashboard 进程里的接线（设计 2026-11-03 §11.3）：独立 HOME 起一个真的
 * index-dashboard，一个假的主 Bot daemon 回答群成员核对。
 *
 * 没配 H5 免登时：
 *   - 本机管理 cookie（管理员）：入口跳到侧栏版式，数据接口给完整视图，不问群成员；
 *   - 平台透传的非管理身份（guest + union_id）：经主 Bot daemon 核对在群后拿到精简视图，
 *     发给 daemon 的核对请求只带 run 的群和这个 union_id；不在群 403；
 *   - 没有身份：数据接口 401，入口落到 SPA 登录层；同一个窄身份照旧进不了 `/api/v3/runs/*`；
 *   - Dashboard 记下「没有可用的 H5 免登」，卡片据此用浏览器链接。
 * 配了 H5 免登时（飞书换码在 Dashboard 进程内伪造，外部请求一律拒绝）：
 *   - Dashboard 记下「H5 免登可用」；
 *   - H5 白名单用户在 Dashboard 里本来就打不开 v3 运行详情，侧栏也不给他完整视图，照样走
 *     群成员核对（不比现有 Dashboard 放得更宽）；
 *   - 只能看侧栏的窄会话在 `/auth/feishu/session` 上与没登录一样；不存在的 run 与不在群对外
 *     一模一样。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { dashboardH5LoginAvailable, dashboardH5PresencePath } from '../src/core/dashboard-h5-presence.js';
import { cleanupBotRuns } from './helpers/v3-external-harness.js';
import { copyRunInto, SIDEBAR_CHAT, SIDEBAR_MAIN, SECRET_REASON, sidebarRun } from './helpers/workflow-sidebar-fixture.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');
const FAKE_FEISHU_ENTRY = resolve('test/helpers/dashboard-with-fake-feishu.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

interface Answer { status: number; body: string; location?: string }

async function request(url: string, init: { headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<Answer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref();
  try {
    const response = await loopbackFetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
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
    await cleanupBotRuns();
  });

  /** Isolated HOME, one bot-executed run, a fake main-bot daemon, the real dashboard. */
  async function boot(opts: {
    platform?: boolean;
    h5?: { allowed: string; codes: Record<string, { open_id: string; union_id?: string }> };
    members: string[];
  }) {
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
    if (opts.platform) {
      // A bound platform with an unreachable URL: identities injected by the
      // platform proxy are accepted, the tunnel just keeps failing to connect.
      writeFileSync(join(botmuxDir, 'platform.json'), JSON.stringify({
        platformUrl: 'http://127.0.0.1:9', machineToken: 'machine-token', machineId: 'machine-wfs',
      }), { mode: 0o600 });
    }
    // A stale marker from an earlier dashboard must be replaced at boot.
    writeFileSync(dashboardH5PresencePath(homeDir), '1\n');
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
        res.end(JSON.stringify({ ok: true, member: opts.members.includes(body.unionId) }));
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

    dashboard = spawnTsScript(opts.h5 ? FAKE_FEISHU_ENTRY : DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir, USERPROFILE: homeDir, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(botmuxDir, 'bots.json'),
        BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
        ...(opts.h5 ? {
          BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'true',
          BOTMUX_DASHBOARD_FEISHU_H5_APP_ID: 'cli_h5_login_app',
          BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'fake-h5-secret',
          BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS: opts.h5.allowed,
          BOTMUX_TEST_FAKE_FEISHU_CODES: JSON.stringify(opts.h5.codes),
          BOTMUX_TEST_DASHBOARD_ENTRY: DASHBOARD_ENTRY,
        } : { BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'false' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    dashboard.stdout?.on('data', (chunk) => { logs += String(chunk); });
    dashboard.stderr?.on('data', (chunk) => { logs += String(chunk); });
    let port = 0;
    const deadline = Date.now() + 25_000;
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
    return {
      base, runId, asked, homeDir, logs: () => logs,
      adminCookie: { cookie: `botmux_dashboard_token=${token}` },
      entry: `${base}/workflow/${SIDEBAR_MAIN}/${runId}`,
      data: (id = runId) => `${base}/api/workflow-sidebar/${SIDEBAR_MAIN}/${id}`,
    };
  }

  it('admin full view, platform member trimmed view via the main bot\'s daemon, everyone else refused', async () => {
    const { base, runId, asked, homeDir, logs, adminCookie, entry, data } = await boot({ platform: true, members: ['on_platform_member'] });
    // No H5 login here: the stale marker is gone, cards link to the browser.
    expect(existsSync(dashboardH5PresencePath(homeDir)), logs()).toBe(false);

    // Admin.
    const adminEntry = await request(entry, { headers: adminCookie });
    expect(adminEntry.status, logs()).toBe(302);
    expect(adminEntry.location).toBe(`/#/workflows/${runId}?app=${SIDEBAR_MAIN}&botmuxWorkbenchShell=immersive`);
    const adminData = await request(data(), { headers: adminCookie });
    expect(adminData.status, logs()).toBe(200);
    expect(JSON.parse(adminData.body)).toMatchObject({ audience: 'admin', view: { nodes: [{ id: 'write', errorCode: 'BOT_REPORTED_BLOCKED' }] } });
    expect(asked).toEqual([]);

    // Platform-forwarded identities (the platform proxy injects the active cookie).
    const platform = (actor: string) => ({ ...adminCookie, 'x-botmux-role': 'guest', 'x-botmux-actor': actor });
    const member = await request(data(), { headers: platform('on_platform_member') });
    expect(member.status, logs()).toBe(200);
    expect(JSON.parse(member.body).audience).toBe('member');
    expect(member.body).not.toContain(SECRET_REASON);
    expect(member.body).not.toContain('BOT_REPORTED_BLOCKED');
    expect(asked).toEqual([{ chatId: SIDEBAR_CHAT, unionId: 'on_platform_member' }]);
    expect((await request(data(), { headers: platform('on_platform_outsider') })).status).toBe(403);
    // The same identity is still not an admin anywhere else.
    expect((await request(`${base}/api/v3/runs/${runId}`, { headers: platform('on_platform_member') })).status).toBe(401);

    // Nobody.
    expect((await request(data())).status).toBe(401);
    expect((await request(entry)).location).toBe(`/#/workflows/${runId}?app=${SIDEBAR_MAIN}&botmuxWorkbenchShell=immersive`);
  }, 40_000);

  it('with H5 login: an allowlisted person sees no more than in the Dashboard; a sidebar session is no login elsewhere', async () => {
    const codes = {
      'code-allowed-1': { open_id: 'ou_allowed_user', union_id: 'on_allowed_user' },
      'code-allowed-2': { open_id: 'ou_allowed_user', union_id: 'on_allowed_user' },
      'code-member': { open_id: 'ou_h5_member', union_id: 'on_member_union' },
      'code-outsider': { open_id: 'ou_h5_outsider', union_id: 'on_outsider_union' },
    };
    const { base, runId, asked, homeDir, logs, data } = await boot({
      h5: { allowed: 'ou_allowed_user', codes }, members: ['on_allowed_user', 'on_member_union'],
    });
    expect(dashboardH5LoginAvailable(dashboardH5PresencePath(homeDir)), logs()).toBe(true);
    // node:http, not fetch: the loopback fetch does not expose Set-Cookie.
    const login = (code: string, body: Record<string, unknown> = {}) => new Promise<{ cookie: string }>((done, fail) => {
      const payload = JSON.stringify({ code, ...body });
      const { port } = new URL(base);
      const req = httpRequest({
        host: '127.0.0.1', port: Number(port), path: '/auth/feishu/exchange', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        res.on('end', () => {
          const setCookie = res.headers['set-cookie']?.[0];
          if (res.statusCode !== 200 || !setCookie) fail(new Error(`${code}: ${res.statusCode}\n${logs()}`));
          else done({ cookie: setCookie.split(';')[0]! });
        });
      });
      req.on('error', fail);
      req.end(payload);
    });

    // An allowlisted H5 person, signed in the ordinary way (as from the Workbench) and via the sidebar entry.
    for (const allowed of [await login('code-allowed-1'), await login('code-allowed-2', { workflowView: true })]) {
      expect((await request(`${base}/api/sessions`, { headers: allowed })).status, logs()).toBe(200);
      // The Dashboard itself does not show them v3 runs…
      expect((await request(`${base}/api/v3/runs`, { headers: allowed })).status).toBe(401);
      expect((await request(`${base}/api/v3/runs/${runId}`, { headers: allowed })).status).toBe(401);
      expect((await request(`${base}/api/v3/runs/${runId}/nodes/write/pty-log`, { headers: allowed })).status).toBe(401);
      // …so the sidebar gives them the member view, after the membership check.
      const view = await request(data(), { headers: allowed });
      expect(view.status).toBe(200);
      expect(JSON.parse(view.body).audience).toBe('member');
      expect(view.body).not.toContain(SECRET_REASON);
    }
    expect(asked).toContainEqual({ chatId: SIDEBAR_CHAT, unionId: 'on_allowed_user' });

    // A sidebar-only session for someone outside the allowlist.
    const member = await login('code-member', { workflowView: true });
    expect(JSON.parse((await request(data(), { headers: member })).body).audience).toBe('member');
    const session = await request(`${base}/auth/feishu/session`, { headers: member });
    const anonymous = await request(`${base}/auth/feishu/session`);
    expect([session.status, session.body]).toEqual([anonymous.status, anonymous.body]);

    // Not in the chat, and no such run: the same answer.
    const outsider = await login('code-outsider', { workflowView: true });
    const notMember = await request(data(), { headers: outsider });
    const missing = await request(data('wfs-no-such-run'), { headers: outsider });
    expect([notMember.status, notMember.body]).toEqual([403, '{"ok":false,"error":"forbidden"}']);
    expect([missing.status, missing.body]).toEqual([notMember.status, notMember.body]);
  }, 60_000);
});
