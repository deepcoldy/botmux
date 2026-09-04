import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardRoutes, findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { safeDashboardH5ReturnTo } from '../src/dashboard/h5-auth.js';
import {
  resolveDashboardIdentity,
  resolveDashboardRequestGate,
} from '../src/dashboard/request-identity.js';

describe('Agent Workbench route and surface integration', () => {
  it('registers separate lazy main and Dock modules before prefix collisions', () => {
    expect(findDashboardRoute('#/agent-workbench/s1')?.id).toBe('agent-workbench');
    expect(findDashboardRoute('#/agent-workbench-dock/s1')?.id).toBe('agent-workbench-dock');
    expect(dashboardRoutes.find(route => route.id === 'agent-workbench')?.load).toBeTypeOf('function');
    expect(dashboardRoutes.find(route => route.id === 'agent-workbench-dock')?.load).toBeTypeOf('function');
  });

  it('preserves existing Dashboard and session-group-mode related routes', () => {
    for (const route of ['sessions', 'groups', 'workflows', 'monitor-room', 'settings']) {
      expect(dashboardRoutes.some(candidate => candidate.id === route), route).toBe(true);
    }
  });

  it('uses a chrome-less host for both Workbench surfaces', () => {
    const app = readFileSync(join(process.cwd(), 'src/dashboard/web/app.tsx'), 'utf8');
    expect(app).toContain("activeHash.startsWith('#/agent-workbench-dock')");
    expect(app).toContain('workbench-route-host');
    expect(app).toContain('data-workbench-surface');
  });

  // 工作台是无边框壳（没有 topbar/侧栏），登录态失效时 AuthExpiredOverlay 是它
  // **唯一**的自救出口。普通壳一直传着 loginUrl，工作台壳漏传 → 浮层退化成
  // 「访问链接已失效，知道了」的死胡同，一键登录按钮根本不渲染。两处必须一致。
  it('passes loginUrl to AuthExpiredOverlay on the Workbench shell too', () => {
    const app = readFileSync(join(process.cwd(), 'src/dashboard/web/app.tsx'), 'utf8');
    const overlayProps = app.match(/<AuthExpiredOverlay[\s\S]*?\/>/g) ?? [];
    // 两个壳各一处：工作台壳 + 普通壳。
    expect(overlayProps.length).toBe(2);
    for (const usage of overlayProps) {
      expect(usage).toContain('dashboardLoginHref(authLoginBaseUrl, location.hash)');
    }
  });

  it('allows login continuation only to Workbench routes', () => {
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/s%2F1')).toBe('/#/agent-workbench/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-dock/s%2F1')).toBe('/#/agent-workbench-dock/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/settings')).toBe('/');
    expect(safeDashboardH5ReturnTo('//evil.example/#/agent-workbench')).toBe('/');
  });

  it('projects explicit ownership from terminal mutations and keeps H5 context private', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    // 控制权分发已经收进 dashboard/terminal-control-route.ts（生产与验收脚本共用的
    // 那一份，行为断言在 test/terminal-control-route.test.ts）。这里只钉「接的是同
    // 一根线」——上一轮正是因为脚本各写一份，`?expect=` 条件释放只在脚本里生效。
    expect(dashboard).toContain('resolveTerminalControlAction({');
    expect(dashboard).toContain('matchTerminalControlRoute(url.pathname)');
    const route = readFileSync(join(process.cwd(), 'src/dashboard/terminal-control-route.ts'), 'utf8');
    expect(route).toContain('{ ...result, owned: true }');
    expect(route).toContain('{ ...result, owned: false }');
    expect(dashboard).toContain("url.pathname === '/api/workbench/h5-context'");
  });

  it('does not reinterpret a Workbench-only platform cookie as legacy owner authority', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    // P1-7 之后门禁选择与身份判定共用同一处结论，dashboard.ts 只负责接线；
    // 语义断言在下面，用共享函数直接跑，而不是比对源码字符串。
    expect(dashboard).toContain('resolveDashboardRequestGate({');
    // 只读身份的写入口门禁住在共享路由里（生产与验收脚本同一份）。
    const controlRoute = readFileSync(join(process.cwd(), 'src/dashboard/terminal-control-route.ts'), 'utf8');
    expect(controlRoute).toContain("identity.terminalCapability === 'readonly'");
    // 预览写操作的角色门禁改用共享判据（与 canInteract 投影、guard 壳的解锁按钮
    // 同一个函数），语义矩阵在 test/preview-interaction.test.ts 里逐身份跑。
    expect(dashboard).toContain('!previewInteractionWriteAllowed(requestIdentity)');

    const ACTIVE = 'active-management-token';
    const platformIdentity = resolveDashboardIdentity({
      legacyCookie: ACTIVE,
      activeToken: ACTIVE,
      roleHeader: 'owner',
      actorHeader: undefined,
      scopesHeader: undefined,
      platformMachineId: 'machine-1',
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: null,
    });
    expect(platformIdentity?.kind).toBe('platform-dashboard');
    // 平台跳板注入的那枚 cookie 认证的是机器，不是用户权限：即使它等于活跃
    // token，也不能被重新解读成本机 owner。
    const platformGate = resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/settings',
      hasTokenParam: false,
      identity: platformIdentity,
      tokenFromRequest: ACTIVE,
      activeToken: ACTIVE,
      publicReadOnly: false,
    });
    expect(platformGate.presentedToken).toBeUndefined();
    expect(platformGate.workbenchOnlyIdentity).toBe(true);
    expect(platformGate.legacyAuthed).toBe(false);
    expect(platformGate.decision.kind).toBe('deny401');
  });

  // ── P1-4：能力集投影端点与前端消费链的接线钉死 ────────────────────────────
  // 语义矩阵在 dashboard-auth.test.ts / agent-workbench-components.test.ts；这里
  // 只钉「接的是同一根线」：端点调的是共享投影函数（而不是路由旁边再手写一张
  // 表），前端严格解析后逐能力传给对应入口。
  it('serves the capability projection from the shared projection function', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboard).toContain("url.pathname === '/api/workbench/capabilities'");
    expect(dashboard).toContain('projectWorkbenchOperationCapabilities(requestIdentity)');
  });

  it('the SPA parses the projection strictly and hands each entry its own bit', () => {
    const app = readFileSync(join(process.cwd(), 'src/dashboard/web/app.tsx'), 'utf8');
    // 探测走 origFetch（匿名 401 是预期结果，不该触发全局登录浮层），且任何失败
    // 回落 fail-closed 全 false。
    expect(app).toContain("origFetch('/api/workbench/capabilities'");
    expect(app).toContain('parseWorkbenchCapabilities');
    expect(app).toContain('NO_WORKBENCH_CAPABILITIES');

    const page = readFileSync(join(process.cwd(), 'src/dashboard/web/agent-workbench-page.tsx'), 'utf8');
    expect(page).toContain('capabilities={ui.workbenchCapabilities}');

    const view = readFileSync(join(process.cwd(), 'src/dashboard/web/agent-workbench-view.tsx'), 'utf8');
    expect(view).toContain('props.capabilities.canLocate ? sessionId => api.locateSession(sessionId) : undefined');
    // 行内的接管捷径已按产品决策移除（会话行只剩 聊天 / 终端），所以这里不再有
    // `canControlTerminal` 这条投影——接管入口只剩终端面板标题栏那一个，能力位在
    // 面板里把关（下面 panes 的 `props.capabilities.canControl` 就是那道闸；行为
    // 断言见 agent-workbench-components.test.ts「行内没有『接管』按钮」与
    // agent-workbench-terminal-control.test.ts「会话行只保留『聊天 / 终端』」）。
    expect(view).not.toContain('canControlTerminal');
    expect(view).toContain('onOpenTerminal={openSessionTerminal}');

    const panes = readFileSync(join(process.cwd(), 'src/dashboard/web/agent-workbench-panes.tsx'), 'utf8');
    expect(panes).toContain('props.capabilities.canControl');
    expect(panes).toContain('props.capabilities.canInteract');
  });
});

/** Comments legitimately name the APIs being avoided; only code must be clean. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('chat opens as a real link, never as scripted navigation', () => {
  // Regression guard. Feishu places a chat beside the page when the client
  // receives a genuine link activation; opening it from script instead made the
  // Workbench navigate itself away. `window.open(..., 'noopener')` also returns
  // null on success, so the "did it work?" fallback fired every single time.
  const chatSurfaces = [
    'src/dashboard/web/agent-workbench-session-list.tsx',
    'src/dashboard/web/agent-workbench-dock-view.tsx',
  ];

  for (const file of chatSurfaces) {
    it(`${file} renders an anchor and performs no scripted navigation`, () => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      // The link may be inline or hoisted into a shared const/component, but it
      // must still be feishuChatLink-first and land on a real href attribute.
      expect(source).toMatch(/href=\{[\s\S]{0,120}?(feishuChatLink|ChatAppLink|chatHref)/);
      if (source.includes('chatHref')) {
        expect(source).toMatch(/chatHref = session\.feishuChatLink[\s\S]{0,120}?buildChatAppLink/);
      }
      expect(source).toContain("target=\"_blank\"");
      expect(stripComments(source)).not.toContain('window.open');
      expect(stripComments(source)).not.toContain('location.assign');
    });
  }

  it('keeps the anchor contract out of the JSAPI fallback path', () => {
    const view = stripComments(readFileSync(join(process.cwd(), 'src/dashboard/web/agent-workbench-view.tsx'), 'utf8'));
    expect(view).not.toContain('window.open');
    expect(view).not.toContain('location.assign');
  });
});
