/**
 * owner 工作台内自取常驻链接（`GET /api/workbench/standing-link`）。
 *
 * 背景：飞书卡片按钮只发 30 分钟短票（P2-1 的红线：长期 token 不得进聊天记录），
 * 所以 owner 想把工作台收藏进书签就只能上服务器跑 `botmux dashboard`。这条端点把
 * 「自取常驻链接」搬进工作台页面本身，同时一条也不放宽既有边界：
 *
 *  - **只有本机完整管理身份**（legacy owner cookie —— `?t=` 种的，或短票兑换出的
 *    那一枚）能取。workbench-only（飞书 H5）、平台 owner/teammate/guest、匿名一律
 *    404，且路由级门禁在处理器之前就已经 401：两层各自独立，谁都不依赖对方。
 *  - **同源**才发：跨站页面拿着 owner 的 cookie 打这条 GET 一律 403。
 *  - 响应 `no-store`：常驻链接带着长期 token，任何中间缓存都不该留它。
 *  - **取用必留痕**：每发一次写一条 `auth.standing_link_issued` 审计（含身份、
 *    绝不含 token 本身）；审计写不进去就不发链接（fail closed）。
 *  - token 只有**一个出处**（落盘的活跃 token）：`dashboard rotate` 之后这条端点
 *    自然返回新 token 拼出的链接，不需要任何额外同步。
 *
 * Run: pnpm vitest run test/workbench-standing-link.test.ts
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WORKBENCH_STANDING_LINK_PATH,
  handleWorkbenchStandingLink,
  standingLinkSameOrigin,
  type WorkbenchStandingLinkDeps,
} from '../src/dashboard/standing-link.js';
import {
  decideDashboardAuth,
  decideWorkbenchH5Auth,
  workbenchH5Capability,
} from '../src/dashboard/auth.js';
import { resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import type {
  ControlAuditRecord,
  ControlAuditSink,
} from '../src/dashboard/control-audit.js';
import { workbenchEntryUrl } from '../src/core/dashboard-url.js';

const ACTIVE_TOKEN = 'standing-link-active-token-fixture';

class MemoryAudit implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  throwOnAppend = false;
  append(record: ControlAuditRecord): void {
    if (this.throwOnAppend) throw new Error('audit sink unavailable');
    this.records.push(record);
  }
}

type Identity = { kind: string; userId?: string } | null;

interface Harness {
  base: string;
  audit: MemoryAudit;
  setIdentity(identity: Identity): void;
  setToken(token: string | null): void;
}

const servers: Server[] = [];

async function startServer(options: {
  identity?: Identity;
  token?: string | null;
  url?: (token: string) => string | null;
} = {}): Promise<Harness> {
  const audit = new MemoryAudit();
  // `null` 是「匿名」这一格身份，不能被 ?? 当成缺省值吞掉。
  let identity: Identity = 'identity' in options
    ? options.identity ?? null
    : { kind: 'legacy-dashboard', userId: 'legacy-owner' };
  let token: string | null = options.token === undefined ? ACTIVE_TOKEN : options.token;
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const deps: WorkbenchStandingLinkDeps = {
      identity,
      activeToken: () => token,
      // 与 dashboard.ts 同款：`<base>/?t=<token>` 经 workbenchEntryUrl 变成
      // `<base>/workbench?t=<token>`，base 的解析复用 dashboard-url 那一份。
      standingLinkUrl: options.url ?? (value => workbenchEntryUrl(`${base}/?t=${value}`)),
      audit,
    };
    if (handleWorkbenchStandingLink(req, res, url, deps)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('router fallthrough');
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    audit,
    setIdentity(next) { identity = next; },
    setToken(next) { token = next; },
  };
}

function ownerFetch(harness: Harness, init: RequestInit = {}): Promise<Response> {
  return fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
    headers: { origin: harness.base, ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

beforeEach(() => { servers.length = 0; });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// ─── 身份矩阵 ───────────────────────────────────────────────────────────────

describe('GET /api/workbench/standing-link 身份矩阵', () => {
  it('本机管理身份（legacy owner）：200 + 当前活跃 token 拼出的工作台常驻链接', async () => {
    const harness = await startServer();
    const res = await ownerFetch(harness);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(body.url).toBe(`${harness.base}/workbench?t=${ACTIVE_TOKEN}`);
  });

  it('响应一律 no-store（常驻链接带长期 token，不进任何中间缓存）', async () => {
    const harness = await startServer();
    expect((await ownerFetch(harness)).headers.get('cache-control')).toBe('no-store');
    harness.setIdentity({ kind: 'feishu-h5', userId: 'ou_viewer' });
    expect((await ownerFetch(harness)).headers.get('cache-control')).toBe('no-store');
    harness.setIdentity({ kind: 'legacy-dashboard', userId: 'legacy-owner' });
    const foreign = await ownerFetch(harness, { headers: { origin: 'https://evil.example' } });
    expect(foreign.headers.get('cache-control')).toBe('no-store');
  });

  for (const identity of [
    { name: 'workbench-only 飞书 H5', value: { kind: 'feishu-h5', userId: 'ou_viewer' } },
    { name: '平台 owner', value: { kind: 'platform-dashboard', userId: 'platform:scope:owner' } },
    { name: '平台 teammate', value: { kind: 'platform-dashboard', userId: 'platform:scope:teammate' } },
    { name: '平台 guest', value: { kind: 'platform-dashboard', userId: 'platform:scope:guest' } },
    { name: '匿名', value: null },
  ]) {
    it(`${identity.name}：404，响应里没有 token、没有链接，也不落审计`, async () => {
      const harness = await startServer({ identity: identity.value });
      const res = await ownerFetch(harness);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain(ACTIVE_TOKEN);
      expect(text).not.toContain('/workbench?t=');
      expect(harness.audit.records).toEqual([]);
    });
  }
});

// ─── 路由级门禁（与处理器互不依赖的第二层） ──────────────────────────────────

describe('路由级门禁', () => {
  it('这条路径不在 workbench-only 能力表里，H5/平台身份在进处理器之前就 401', () => {
    expect(workbenchH5Capability('GET', WORKBENCH_STANDING_LINK_PATH)).toBeNull();
    expect(decideWorkbenchH5Auth({ method: 'GET', pathname: WORKBENCH_STANDING_LINK_PATH }).kind)
      .toBe('deny401');
  });

  it('匿名（含 publicReadOnly 打开时）同样 401——它不在公开只读白名单里', () => {
    for (const publicReadOnly of [false, true]) {
      expect(decideDashboardAuth({
        method: 'GET',
        pathname: WORKBENCH_STANDING_LINK_PATH,
        hasTokenParam: false,
        presentedToken: undefined,
        activeToken: ACTIVE_TOKEN,
        publicReadOnly,
      }).kind, `publicReadOnly=${publicReadOnly}`).toBe('deny401');
    }
  });

  it('dashboard.ts 的门禁选择：只有 legacy 管理凭据放行，H5 / 平台身份 deny401', () => {
    const gate = (identity: Parameters<typeof resolveDashboardRequestGate>[0]['identity'], token?: string) =>
      resolveDashboardRequestGate({
        method: 'GET',
        pathname: WORKBENCH_STANDING_LINK_PATH,
        hasTokenParam: false,
        identity,
        tokenFromRequest: token,
        activeToken: ACTIVE_TOKEN,
        publicReadOnly: false,
      });

    const owner = gate({
      kind: 'legacy-dashboard',
      userId: 'legacy-owner',
      authSessionId: 'auth-1',
      expiresAt: Number.MAX_SAFE_INTEGER,
      terminalCapability: 'controlled',
      previewCapability: 'operate',
    }, ACTIVE_TOKEN);
    expect(owner.legacyAuthed).toBe(true);
    expect(owner.decision.kind).toBe('allow');

    for (const kind of ['feishu-h5', 'platform-dashboard'] as const) {
      const denied = gate({
        kind,
        userId: `${kind}-user`,
        authSessionId: 'auth-2',
        expiresAt: Number.MAX_SAFE_INTEGER,
        terminalCapability: 'controlled',
        previewCapability: 'operate',
      });
      expect(denied.workbenchOnlyIdentity, kind).toBe(true);
      expect(denied.decision.kind, kind).toBe('deny401');
    }

    expect(gate(null).decision.kind).toBe('deny401');
  });
});

// ─── 同源校验 ───────────────────────────────────────────────────────────────

describe('同源校验', () => {
  it('跨站 Origin：403 control_origin_forbidden，不发链接也不落审计', async () => {
    const harness = await startServer();
    const res = await ownerFetch(harness, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'control_origin_forbidden' });
    expect(harness.audit.records).toEqual([]);
  });

  it('Sec-Fetch-Site: cross-site 同样 403（即使一个 Origin 都没带）', async () => {
    const harness = await startServer();
    const res = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('Sec-Fetch-Site: same-origin（同源 GET 常常不带 Origin）放行', async () => {
    const harness = await startServer();
    const res = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
  });

  it('两个来源信号都没有时，靠同源 Referer 兜底；跨站 Referer / 全无信号一律 403', async () => {
    const harness = await startServer();
    const same = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
      headers: { referer: `${harness.base}/` },
    });
    expect(same.status).toBe(200);

    const foreign = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
      headers: { referer: 'https://evil.example/attack' },
    });
    expect(foreign.status).toBe(403);

    const naked = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`);
    expect(naked.status).toBe(403);
  });

  it('standingLinkSameOrigin 直接复用 control-csrf 的归一化：端口/大小写/尾点都算同源', () => {
    expect(standingLinkSameOrigin({ origin: 'http://Dash.Example:8080', host: 'dash.example:8080' })).toBe(true);
    expect(standingLinkSameOrigin({ origin: 'https://dash.example', host: 'dash.example:443' })).toBe(true);
    // 同域不同端口是本条要防的攻击面之一。
    expect(standingLinkSameOrigin({ origin: 'http://dash.example:9999', host: 'dash.example:8080' })).toBe(false);
    // 不透明来源（沙箱 iframe）判为跨站，Referer 也救不回来。
    expect(standingLinkSameOrigin({ origin: 'null', host: 'dash.example', referer: 'http://dash.example/' })).toBe(false);
    // 两个来源信号都缺席 + 无 Referer = fail closed。
    expect(standingLinkSameOrigin({ host: 'dash.example' })).toBe(false);
  });
});

// ─── 审计 ───────────────────────────────────────────────────────────────────

describe('审计', () => {
  it('每取一次落一条 auth.standing_link_issued：有身份、无 token、无链接', async () => {
    const harness = await startServer();
    await ownerFetch(harness);
    expect(harness.audit.records).toHaveLength(1);
    const [record] = harness.audit.records;
    expect(record.action).toBe('auth.standing_link_issued');
    expect(record.user).toBe('legacy-owner');
    expect(record.session).toBe('dashboard');
    expect(typeof record.timestamp).toBe('string');
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(ACTIVE_TOKEN);
    expect(serialized).not.toContain('/workbench?t=');

    await ownerFetch(harness);
    expect(harness.audit.records).toHaveLength(2);
  });

  it('审计写不进去就不发链接（取用必留痕，fail closed）', async () => {
    const harness = await startServer();
    harness.audit.throwOnAppend = true;
    const res = await ownerFetch(harness);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'standing_link_unavailable' });
  });
});

// ─── token 单一出处 / 降级 ──────────────────────────────────────────────────

describe('token 单一出处', () => {
  it('rotate 之后同一条端点自然返回新 token 的链接（每次现读活跃 token）', async () => {
    const harness = await startServer();
    const before = await (await ownerFetch(harness)).json() as { url: string };
    expect(before.url).toContain(ACTIVE_TOKEN);

    harness.setToken('rotated-token-fixture');
    const after = await (await ownerFetch(harness)).json() as { url: string };
    expect(after.url).toBe(`${harness.base}/workbench?t=rotated-token-fixture`);
    expect(after.url).not.toContain(ACTIVE_TOKEN);
  });

  it('还没有活跃 token / base 不可解析：503，不拼半截链接', async () => {
    const noToken = await startServer({ token: null });
    const res = await ownerFetch(noToken);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'standing_link_unavailable' });
    expect(noToken.audit.records).toEqual([]);

    const badBase = await startServer({ url: () => null });
    expect((await ownerFetch(badBase)).status).toBe(503);
    expect(badBase.audit.records).toEqual([]);
  });
});

// ─── 方法 / 路径 ────────────────────────────────────────────────────────────

describe('dashboard.ts 接线', () => {
  const read = (relative: string) =>
    readFileSync(join(process.cwd(), relative), 'utf8');

  it('路由走共享处理器；身份、活跃 token、base 解析全都复用既有的唯一出处', () => {
    const dashboard = read('src/dashboard.ts');
    expect(dashboard).toContain('handleWorkbenchStandingLink(req, res, url, {');
    // 身份来自 P1-7 那一处唯一判定，不在这条路由里另算一遍。
    expect(dashboard).toContain('identity: requestIdentity');
    expect(dashboard).toContain('activeToken: () => activeToken');
    // base 复用 dashboard-url 的那一份（远程访问 / 反代翻转跟着一起走），
    // 绝不在这里手拼第二份 host:port。
    expect(dashboard).toContain('standingLinkUrl: token => workbenchEntryUrl(dashboardUrlsFor(token).url)');
    // 审计落在与登录 / 接管同一个 sink 上。
    expect(dashboard).toContain('audit: dashboardControlAudit');
  });

  it('前端入口只对本机完整管理身份渲染（页面把既有的 ui.authed 传下去）', () => {
    for (const relative of [
      'src/dashboard/web/agent-workbench-page.tsx',
      'src/dashboard/web/agent-workbench-dock-page.tsx',
    ]) {
      expect(read(relative), relative).toContain('manageAuthed={ui.authed}');
    }
    const view = read('src/dashboard/web/agent-workbench-view.tsx');
    expect(view).toContain('standingLink={props.manageAuthed === true}');
  });
});

describe('方法与路径', () => {
  it('非 GET、非本路径一律交还路由（fail closed，不自己兜底）', async () => {
    const harness = await startServer();
    const post = await fetch(`${harness.base}${WORKBENCH_STANDING_LINK_PATH}`, {
      method: 'POST',
      headers: { origin: harness.base },
    });
    expect(post.status).toBe(404);
    expect(await post.text()).toBe('router fallthrough');

    const other = await fetch(`${harness.base}/api/workbench/standing-link/extra`, {
      headers: { origin: harness.base },
    });
    expect(other.status).toBe(404);
    expect(await other.text()).toBe('router fallthrough');
  });
});
