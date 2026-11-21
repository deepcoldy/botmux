/**
 * 工作流侧边栏的鉴权边界（设计 2026-11-03 §11.3，D6）。
 *
 * 服务端按 dashboard.ts 的挂载顺序拼起真实组件：飞书 H5 免登控制器（真实 exchange 端点签发
 * 会话）→ 插件结果页 → 工作流侧栏路由 → 普通 Dashboard 门禁（真实身份解析 + 真实 gate）→
 * v3 运行接口。只有「群成员核对」这一跳（主 Bot daemon 调飞书）用假实现。
 *
 * 钉住：
 *   - 白名单之外的人只能拿到「只能看工作流侧栏」的会话，它在别的接口上等于没登录；
 *   - 管理员看完整视图，本群当前成员看服务端裁好的精简视图，其他人 403，拿不到身份 401；
 *   - 成员资格查不到就拒绝且不缓存，查到的结论短时缓存；
 *   - 只有 bot 执行模式的 run 对成员开放；入口 returnTo 只认站内同类路径。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCookie } from '../src/dashboard/auth.js';
import {
  createDashboardH5AuthController,
  dashboardH5LoginUsable,
  DashboardSessionStore,
  safeDashboardH5ReturnTo,
  type DashboardH5AuthConfig,
} from '../src/dashboard/h5-auth.js';
import { dashboardH5LoginAvailable, publishDashboardH5Presence } from '../src/core/dashboard-h5-presence.js';
import { resolveDashboardIdentity, resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { handleV3RunsApi } from '../src/dashboard/v3-runs-api.js';
import { handlePluginResultAccess, resolvePluginResultViewerIdentity } from '../src/dashboard/plugin-result-access.js';
import { PluginResultArtifactStore } from '../src/core/plugins/mcp/result-artifact-store.js';
import { handleWorkflowSidebar, WORKFLOW_SIDEBAR_DENY_FLOOR_MS } from '../src/dashboard/workflow-sidebar-api.js';
import {
  WorkflowSidebarMembershipCache,
  type WorkflowSidebarMembershipRequest,
  type WorkflowViewerMembership,
} from '../src/core/workflow-sidebar-membership.js';
import { parseWorkflowSidebarHash } from '../src/core/workflow-sidebar-link.js';
import { cleanupBotRuns, trackTempDir } from './helpers/v3-external-harness.js';
import { NODE_GOAL, PENDING_GOAL, SECRET_REASON, SIDEBAR_CHAT, SIDEBAR_MAIN, sidebarRun } from './helpers/workflow-sidebar-fixture.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ACTIVE = 'active-management-token-0123456789';
const H5_APP = 'cli_h5_login_app';

interface World {
  base: string;
  asks: WorkflowSidebarMembershipRequest[];
  /** Verdict per principal key (`u:<union>` / `o:<open>`); default not_member. */
  verdicts: Map<string, WorkflowViewerMembership>;
  clock: { t: number };
  /** Monotonic ms the handler measures its refusal floor with; an ask can
   *  advance it to stand for the time the main bot's daemon took. */
  mono: { t: number; askMs: number; askGate?: Promise<void> };
  /** Every refusal-floor wait the handler requested, in ms. */
  slept: number[];
  resultStore: PluginResultArtifactStore;
}

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await cleanupBotRuns();
});

/** code → identity the fake Feishu exchanger returns. */
const PEOPLE: Record<string, { openId: string; unionId?: string }> = {
  'code-member': { openId: 'ou_h5_member', unionId: 'on_member_union' },
  'code-member2': { openId: 'ou_h5_member', unionId: 'on_member_union' },
  'code-outsider': { openId: 'ou_h5_outsider', unionId: 'on_outsider_union' },
  'code-nounion': { openId: 'ou_h5_nounion' },
  'code-allowed': { openId: 'ou_allowed', unionId: 'on_allowed_union' },
};

async function start(runsDir: string, h5Overrides: Partial<DashboardH5AuthConfig> = {}): Promise<World> {
  const clock = { t: 1_000_000 };
  const config: DashboardH5AuthConfig = {
    enabled: true, brand: 'feishu', appId: H5_APP, appSecret: 'h5-secret', allowedOpenIds: ['ou_allowed'],
    entryPath: '/auth/feishu', sessionTtlMs: 30 * 60_000, secureCookies: false, trustedProxyHops: 0,
    ...h5Overrides,
  };
  let tokens = 0;
  const sessions = new DashboardSessionStore({
    ttlMs: config.sessionTtlMs,
    randomToken: () => `sessiontoken${String(++tokens).padStart(4, '0')}${'B'.repeat(30)}`,
  });
  const h5 = createDashboardH5AuthController({
    config,
    sessions,
    audit: { append: () => {} },
    exchanger: { exchange: async (code) => { const who = PEOPLE[code]; if (!who) throw new Error('bad code'); return who; } },
  });
  const resultRoot = trackTempDir(mkdtempSync(join(tmpdir(), 'wfs-results-')));
  const world: World = {
    base: '', asks: [], verdicts: new Map(), clock, mono: { t: 0, askMs: 0 }, slept: [],
    resultStore: new PluginResultArtifactStore({ dataDir: resultRoot }),
  };
  const membership = new WorkflowSidebarMembershipCache({ now: () => clock.t });
  const identityOf = (req: IncomingMessage) => resolveDashboardIdentity({
    legacyCookie: parseCookie(req.headers.cookie),
    activeToken: ACTIVE,
    roleHeader: req.headers['x-botmux-role'],
    actorHeader: req.headers['x-botmux-actor'],
    scopesHeader: req.headers['x-botmux-scopes'],
    platformMachineId: req.headers['x-test-platform'] ? 'machine-1' : null,
    platformActorScope: (id) => `scope-${id}`,
    legacyAuthSessionId: (token) => `legacy-${token.slice(0, 4)}`,
    h5: h5.resolve(req),
  });
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      if (await h5.handle(req, res, url)) return;
      if (await handlePluginResultAccess(req, res, url, {
        store: world.resultStore,
        identity: (r) => resolvePluginResultViewerIdentity(identityOf(r), h5.resolve(r)),
      })) return;
      if (await handleWorkflowSidebar(req, res, url, {
        runsDir,
        identity: () => identityOf(req),
        h5: () => h5.resolve(req),
        h5Config: config,
        membership,
        askMembership: async (mainLarkAppId, request) => {
          expect(mainLarkAppId).toBe(SIDEBAR_MAIN);
          world.asks.push(request);
          await world.mono.askGate;
          world.mono.t += world.mono.askMs;
          const key = 'unionId' in request.principal ? `u:${request.principal.unionId}` : `o:${request.principal.openId}`;
          return world.verdicts.get(key) ?? 'not_member';
        },
        brand: () => 'feishu',
        botName: (appId) => `bot(${appId})`,
        now: () => clock.t,
        monotonicNow: () => world.mono.t,
        sleep: async (ms) => { world.slept.push(ms); },
      })) return;
      const identity = identityOf(req);
      const cookie = parseCookie(req.headers.cookie);
      const gate = resolveDashboardRequestGate({
        method: req.method ?? 'GET', pathname: url.pathname, hasTokenParam: false, identity,
        tokenFromRequest: cookie === ACTIVE ? cookie : undefined, activeToken: ACTIVE, publicReadOnly: false,
      });
      if (gate.decision.kind === 'deny401') { res.writeHead(401); res.end('denied'); return; }
      if (await handleV3RunsApi(req, res, url, {
        runsDir, proxyToDaemon: async () => new Response('{"ok":true}', { status: 200 }),
      }, gate.canManageHost)) return;
      // Stands for every other Dashboard route behind the ordinary gate.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reached: url.pathname }));
    })().catch((err) => { console.error(err); res.writeHead(500); res.end('internal test error'); });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  world.base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return world;
}

async function login(world: World, code: string, body: Record<string, unknown> = { workflowView: true }): Promise<{ status: number; cookie?: string }> {
  const response = await fetch(`${world.base}/auth/feishu/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...body }),
  });
  const setCookie = response.headers.get('set-cookie');
  return { status: response.status, ...(setCookie ? { cookie: setCookie.split(';')[0] } : {}) };
}

const get = (world: World, path: string, headers: Record<string, string> = {}) =>
  fetch(`${world.base}${path}`, { headers, redirect: 'manual' });
const api = (runId: string, app = SIDEBAR_MAIN) => `/api/workflow-sidebar/${app}/${runId}`;
const admin = { cookie: `botmux_dashboard_token=${ACTIVE}` };

describe('H5 sessions for people outside the allowlist are scoped to the workflow sidebar', () => {
  it('without the workflow scope a stranger still gets no session at all', async () => {
    const world = await start((await sidebarRun('wfs-scope-none')).runsDir);
    expect(await login(world, 'code-outsider', {})).toEqual({ status: 403 });
  });

  it('the scoped session reaches no other Dashboard route, and no owner-bound result', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-scope-walls');
    const world = await start(runsDir);
    world.verdicts.set('u:on_member_union', 'member');
    const { status, cookie } = await login(world, 'code-member');
    expect(status).toBe(200);
    const headers = { cookie: cookie! };
    expect((await get(world, api(runId), headers)).status).toBe(200);
    for (const path of ['/api/sessions', '/events', '/api/settings', '/api/v3/runs', `/api/v3/runs/${runId}`,
      `/api/v3/runs/${runId}/nodes/write/pty-log`, '/api/workbench/h5-context', '/api/decision-board/boards']) {
      expect([path, (await get(world, path, headers)).status]).toEqual([path, 401]);
    }
    const cancel = await fetch(`${world.base}/api/v3/runs/${runId}/cancel`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    expect(cancel.status).toBe(401);
    // An owner-bound result belonging to this very person is still not opened.
    const artifact = world.resultStore.create({
      pluginId: 'reference-reporter',
      delivery: { schemaVersion: 1, deliveryId: 'delivery_wfs_scope_20261103', markdown: 'PRIVATE_RESULT' },
      ownerUnionId: 'on_member_union', larkAppId: 'cli_fixture', sessionId: 'session_fixture', turnId: 'om_fixture',
    });
    for (const path of [`/plugin-result-access/${artifact.viewToken}`, `/plugin-results/${artifact.viewId}`]) {
      const response = await get(world, path, headers);
      expect([path, response.status]).toEqual([path, 401]);
      expect(await response.text()).not.toContain('PRIVATE_RESULT');
    }
  });

  it('the H5 session endpoint answers a workflow-sidebar session exactly like no session', async () => {
    const world = await start((await sidebarRun('wfs-scope-session')).runsDir);
    const { cookie } = await login(world, 'code-member');
    const scoped = await get(world, '/auth/feishu/session', { cookie: cookie! });
    const anonymous = await get(world, '/auth/feishu/session');
    expect([scoped.status, await scoped.text()]).toEqual([anonymous.status, await anonymous.text()]);
    expect(scoped.status).toBe(401);
  });

  it('asking for both narrow scopes at once is refused without minting a session', async () => {
    const world = await start((await sidebarRun('wfs-scope-both')).runsDir);
    expect(await login(world, 'code-member', { workflowView: true, resultOnly: true })).toEqual({ status: 400 });
    expect(await login(world, 'code-allowed', { workflowView: true, resultOnly: true })).toEqual({ status: 400 });
  });

    it('a session scoped to plugin results does not open the sidebar: the entry sends it through H5 login again', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-scope-result');
    const world = await start(runsDir);
    world.verdicts.set('u:on_member_union', 'member');
    const { cookie } = await login(world, 'code-member', { resultOnly: true });
    const response = await get(world, api(runId), { cookie: cookie! });
    expect(response.status).toBe(401);
    const entry = `/workflow/${SIDEBAR_MAIN}/${runId}`;
    expect((await get(world, entry, { cookie: cookie! })).headers.get('location'))
      .toBe(`/auth/feishu?returnTo=${encodeURIComponent(entry)}`);
    expect(world.asks).toEqual([]);
  });

  it('an allowlisted person keeps the ordinary H5 session (and can use the sidebar as a member)', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-scope-allowed');
    const world = await start(runsDir);
    world.verdicts.set('u:on_allowed_union', 'member');
    const { cookie } = await login(world, 'code-allowed');
    expect((await get(world, '/api/sessions', { cookie: cookie! })).status).toBe(200);
    const body = await (await get(world, api(runId), { cookie: cookie! })).json();
    expect(body.audience).toBe('member');
  });
});

describe('who sees what (D6)', () => {
  it('a Dashboard admin gets the full view; a member gets a server-trimmed view without error detail', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-views');
    const world = await start(runsDir);
    world.verdicts.set('u:on_member_union', 'member');

    const full = await (await get(world, api(runId), admin)).json();
    expect(full.audience).toBe('admin');
    expect(full.view.nodes[0]).toMatchObject({ id: 'write', status: 'blocked', errorCode: 'BOT_REPORTED_BLOCKED', hasPtyLog: false });
    expect(world.asks).toEqual([]); // admins are never membership-checked

    const { cookie } = await login(world, 'code-member');
    const memberText = await (await get(world, api(runId), { cookie: cookie! })).text();
    const member = JSON.parse(memberText);
    expect(member.audience).toBe('member');
    const node = member.view.nodes[0];
    expect(node).toMatchObject({ id: 'write', status: 'blocked', goal: NODE_GOAL, bot: { cliId: 'claude-code' } });
    expect(node.landing.url).toContain(encodeURIComponent(SIDEBAR_CHAT));
    expect(Object.keys(node).sort()).toEqual(['attempts', 'bot', 'depends', 'endedAt', 'goal', 'id', 'landing', 'startedAt', 'status']);
    expect(Object.keys(node.attempts[0]).sort()).toEqual(['endedAt', 'outcome', 'startedAt']);
    for (const leaked of [SECRET_REASON, 'BOT_REPORTED_BLOCKED', 'workerError', 'hasPtyLog', 'webTerminal', 'attemptId', 'errorCode']) {
      expect(memberText).not.toContain(leaked);
    }
    expect(world.asks).toEqual([{ chatId: SIDEBAR_CHAT, principal: { unionId: 'on_member_union' } }]);
    // The main bot is named, not identified: its app id is for admins.
    expect(member.run.mainBot).toEqual({ name: `bot(${SIDEBAR_MAIN})` });
    expect(full.run.mainBot).toEqual({ larkAppId: SIDEBAR_MAIN, name: `bot(${SIDEBAR_MAIN})` });
  });

  it('a member sees the goal only of nodes already handed off in the chat; the admin sees every goal', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-pending-goal', { nodeExecutor: 'bot', withPendingNode: true });
    const world = await start(runsDir);
    world.verdicts.set('u:on_member_union', 'member');
    const { cookie } = await login(world, 'code-member');
    const member = await (await get(world, api(runId), { cookie: cookie! })).json();
    const review = member.view.nodes.find((n: { id: string }) => n.id === 'review');
    expect(review).toMatchObject({ id: 'review', status: 'pending', depends: ['write'] });
    expect(review.goal).toBeUndefined();
    expect(JSON.stringify(member)).not.toContain(PENDING_GOAL);
    const full = await (await get(world, api(runId), admin)).json();
    expect(JSON.stringify(full)).toContain(PENDING_GOAL);
  });

  it('someone not in the chat gets 403; nobody signed in gets 401 with the H5 login entry', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-outsider');
    const world = await start(runsDir);
    const { cookie } = await login(world, 'code-outsider');
    expect((await get(world, api(runId), { cookie: cookie! })).status).toBe(403);
    const anon = await get(world, api(runId));
    expect(anon.status).toBe(401);
    expect((await anon.json()).loginUrl).toBe(`/auth/feishu?returnTo=${encodeURIComponent(`/workflow/${SIDEBAR_MAIN}/${runId}`)}`);
  });

  it('without H5 login configured only admins can see it', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-no-h5');
    const world = await start(runsDir, { enabled: false });
    const anon = await get(world, api(runId));
    expect(anon.status).toBe(401);
    expect((await anon.json()).loginUrl).toBeUndefined();
    expect((await get(world, api(runId), admin)).status).toBe(200);
  });

  it('members only see bot-executed runs of the app named in the link', async () => {
    const bot = await sidebarRun('wfs-gate-bot');
    const legacy = await sidebarRun('wfs-gate-legacy', {});
    const runsDir = bot.runsDir;
    // Same runs dir for both runs.
    const { cpSync } = await import('node:fs');
    cpSync(legacy.run.runDir, join(runsDir, legacy.runId), { recursive: true });
    const world = await start(runsDir);
    world.verdicts.set('u:on_member_union', 'member');
    const { cookie } = await login(world, 'code-member');
    const headers = { cookie: cookie! };
    expect((await get(world, api(bot.runId), headers)).status).toBe(200);
    expect((await get(world, api(legacy.runId), headers)).status).toBe(403);
    expect((await get(world, api(bot.runId, 'cli_other_app'), headers)).status).toBe(403);
    expect((await get(world, api('wfs-no-such-run'), headers)).status).toBe(403);
    // The admin's view of the same three.
    expect((await get(world, api(legacy.runId), admin)).status).toBe(200);
    expect((await get(world, api(bot.runId, 'cli_other_app'), admin)).status).toBe(404);
    expect((await get(world, api('wfs-no-such-run'), admin)).status).toBe(404);
  });

  it('a non-member cannot tell a missing / foreign / non-bot run from one they are not allowed into: same body, same time', async () => {
    const bot = await sidebarRun('wfs-oracle-bot');
    const legacy = await sidebarRun('wfs-oracle-legacy', {});
    const { cpSync } = await import('node:fs');
    cpSync(legacy.run.runDir, join(bot.runsDir, legacy.runId), { recursive: true });
    const world = await start(bot.runsDir);
    const { cookie } = await login(world, 'code-member');
    const headers = { cookie: cookie! };
    // Asking the main bot's daemon takes a while; answering "no such run" does not.
    world.mono.askMs = 150;
    const answers: Array<[string, number, string, number]> = [];
    const probe = async (label: string, path: string, verdict?: WorkflowViewerMembership) => {
      if (verdict) world.verdicts.set('u:on_member_union', verdict);
      world.clock.t += 120_000; // past every cached verdict
      const before = world.mono.t;
      world.slept.length = 0;
      const response = await get(world, path, headers);
      const elapsed = world.mono.t - before + world.slept.reduce((sum, ms) => sum + ms, 0);
      answers.push([label, response.status, await response.text(), elapsed]);
    };
    await probe('missing run', api('wfs-oracle-missing'));
    await probe('another main bot', api(bot.runId, 'cli_other_app'));
    await probe('not bot-executed', api(legacy.runId));
    await probe('exists, not a member', api(bot.runId), 'not_member');
    await probe('exists, lookup failed', api(bot.runId), 'unavailable');
    for (const [label, status, body, elapsed] of answers) {
      expect([label, status, body, elapsed]).toEqual([label, 403, '{"ok":false,"error":"forbidden"}', WORKFLOW_SIDEBAR_DENY_FLOOR_MS]);
    }
    // Members are never slowed down.
    world.verdicts.set('u:on_member_union', 'member');
    world.clock.t += 120_000;
    world.slept.length = 0;
    expect((await get(world, api(bot.runId), headers)).status).toBe(200);
    expect(world.slept).toEqual([]);
  });
});

describe('membership is checked in the main bot\'s app, briefly cached, and fails closed', () => {
  it('a failed lookup denies and is remembered for 5s; a definitive verdict is cached for a minute', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-cache');
    const world = await start(runsDir);
    const { cookie } = await login(world, 'code-member');
    const headers = { cookie: cookie! };
    world.verdicts.set('u:on_member_union', 'unavailable');
    expect((await get(world, api(runId), headers)).status).toBe(403);
    world.clock.t += 4_000;
    expect((await get(world, api(runId), headers)).status).toBe(403);
    expect(world.asks).toHaveLength(1);
    world.clock.t += 1_500;
    expect((await get(world, api(runId), headers)).status).toBe(403);
    expect(world.asks).toHaveLength(2);

    world.verdicts.set('u:on_member_union', 'member');
    world.clock.t += 5_000;
    expect((await get(world, api(runId), headers)).status).toBe(200);
    world.verdicts.set('u:on_member_union', 'not_member'); // removed from the chat
    world.clock.t += 30_000;
    expect((await get(world, api(runId), headers)).status).toBe(200);
    expect(world.asks).toHaveLength(3);
    world.clock.t += 31_000;
    expect((await get(world, api(runId), headers)).status).toBe(403);
    expect(world.asks).toHaveLength(4);
  });

  it('a burst of requests from one person shares one lookup', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-burst');
    const world = await start(runsDir);
    const { cookie } = await login(world, 'code-member');
    world.verdicts.set('u:on_member_union', 'member');
    let open!: () => void;
    world.mono.askGate = new Promise<void>((resolve) => { open = resolve; });
    const burst = Array.from({ length: 25 }, () => get(world, api(runId), { cookie: cookie! }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    open();
    const statuses = await Promise.all(burst.map(async (response) => (await response).status));
    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(world.asks).toHaveLength(1);
  });

  it('an open_id issued by another app is never used; the H5 app\'s own open_id is used only when it IS the main bot', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-open-id');
    const other = await start(runsDir);
    const { cookie } = await login(other, 'code-nounion');
    expect((await get(other, api(runId), { cookie: cookie! })).status).toBe(403);
    expect(other.asks).toEqual([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const same = await start(runsDir, { appId: SIDEBAR_MAIN });
    same.verdicts.set('o:ou_h5_nounion', 'member');
    const again = await login(same, 'code-nounion');
    expect((await get(same, api(runId), { cookie: again.cookie! })).status).toBe(200);
    expect(same.asks).toEqual([{ chatId: SIDEBAR_CHAT, principal: { openId: 'ou_h5_nounion' } }]);
  });

  it('a platform identity is checked by the union_id the platform injected', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-platform');
    const world = await start(runsDir);
    world.verdicts.set('u:on_platform_guest', 'member');
    const platform = { ...admin, 'x-test-platform': '1', 'x-botmux-role': 'guest', 'x-botmux-actor': 'on_platform_guest' };
    expect((await (await get(world, api(runId), platform)).json()).audience).toBe('member');
    // A platform visitor without an actor cannot be checked at all.
    const anonymous = { ...admin, 'x-test-platform': '1', 'x-botmux-role': 'guest' };
    expect((await get(world, api(runId), anonymous)).status).toBe(403);
    expect(world.asks).toEqual([{ chatId: SIDEBAR_CHAT, principal: { unionId: 'on_platform_guest' } }]);
  });
});

describe('the /workflow/<app>/<run> entry', () => {
  it('signed in → the sidebar layout; not signed in with H5 → H5 login returning here; otherwise the SPA login layer', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-entry');
    const entry = `/workflow/${SIDEBAR_MAIN}/${runId}`;
    const world = await start(runsDir);
    const signedIn = await get(world, entry, admin);
    expect(signedIn.status).toBe(302);
    const location = signedIn.headers.get('location')!;
    const parsed = new URL(location, world.base);
    expect(parseWorkflowSidebarHash(parsed.search, parsed.hash)).toEqual({ appId: SIDEBAR_MAIN, runId });
    expect(location).not.toContain(ACTIVE);

    const anon = await get(world, entry);
    expect(anon.headers.get('location')).toBe(`/auth/feishu?returnTo=${encodeURIComponent(entry)}`);
    const { cookie } = await login(world, 'code-member');
    expect((await get(world, entry, { cookie: cookie! })).headers.get('location')).toBe(location);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const noH5 = await start(runsDir, { enabled: false });
    expect((await get(noH5, entry)).headers.get('location')).toBe(location);
  });

  it('the H5 entry page asks for the workflow scope exactly when it returns to a workflow entry', async () => {
    const { runsDir, runId } = await sidebarRun('wfs-entry-page');
    const world = await start(runsDir);
    const bodies: Array<Record<string, unknown>> = [];
    for (const returnTo of [`/workflow/${SIDEBAR_MAIN}/${runId}`, '/#/agent-workbench']) {
      const html = await (await get(world, `/auth/feishu?returnTo=${encodeURIComponent(returnTo)}`)).text();
      // Extract the inline script the server itself emitted (plain string
      // bounds, not an HTML filter: the template carries exactly one script).
      const openTag = html.indexOf('<script>');
      const closeTag = html.lastIndexOf('</script>');
      expect(openTag).toBeGreaterThanOrEqual(0);
      expect(closeTag).toBeGreaterThan(openTag);
      const script = html.slice(openTag + '<script>'.length, closeTag);
      const element = () => ({ textContent: '', hidden: false, addEventListener: () => {} });
      await new Promise<void>((resolve) => {
        const window: Record<string, unknown> = {
          tt: { requestAccess: (opts: { success: (r: { code: string }) => void }) => opts.success({ code: 'c' }) },
        };
        runInNewContext(script, {
          window, document: { getElementById: element, createElement: element, head: { appendChild: () => {} } },
          location: { replace: () => {} }, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
          fetch: (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); resolve(); return new Promise(() => {}); },
        });
      });
    }
    expect(bodies).toEqual([
      { code: 'c', resultOnly: false, workflowView: true },
      { code: 'c', resultOnly: false, workflowView: false },
    ]);
  });

  it('returnTo admits only the exact in-site workflow entry shape', () => {
    expect(safeDashboardH5ReturnTo('/workflow/cli_a1/run-1.x')).toBe('/workflow/cli_a1/run-1.x');
    for (const hostile of [
      '//evil.example/workflow/cli_a/r1', 'https://evil.example/workflow/cli_a/r1', '/workflow/cli_a/../../x',
      '/workflow/cli_a/r1?next=https://evil.example', '/workflow/cli_a/r1/extra', '/workflow//r1', '/workflow/cli_a/.hidden',
      '/workflow/cli_a/r1#x', '/\\evil.example/workflow/cli_a/r1',
    ]) expect([hostile, safeDashboardH5ReturnTo(hostile)]).toEqual([hostile, '/']);
  });
});

describe('which link the cards use: the Dashboard publishes whether H5 login can work', () => {
  it('"usable" is exactly when the H5 entry page can start a login', async () => {
    const { runsDir } = await sidebarRun('wfs-h5-usable');
    for (const [overrides, usable] of [
      [{}, true],
      [{ enabled: false }, false],
      [{ appSecret: '' }, false],
      [{ allowedOpenIds: [] }, false],
    ] as Array<[Partial<DashboardH5AuthConfig>, boolean]>) {
      const world = await start(runsDir, overrides);
      const entry = await get(world, '/auth/feishu');
      const config = { enabled: true, appId: H5_APP, appSecret: 'h5-secret', allowedOpenIds: ['ou_allowed'], ...overrides };
      expect([overrides, dashboardH5LoginUsable(config), entry.status === 200]).toEqual([overrides, usable, usable]);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('readers see the published fact; nothing published (or unreadable) means no H5 login', () => {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'wfs-h5-presence-')));
    const path = join(dir, '.dashboard-h5-login');
    expect(dashboardH5LoginAvailable(path)).toBe(false);
    publishDashboardH5Presence(true, path);
    expect(dashboardH5LoginAvailable(path)).toBe(true);
    publishDashboardH5Presence(false, path);
    expect(dashboardH5LoginAvailable(path)).toBe(false);
  });
});
