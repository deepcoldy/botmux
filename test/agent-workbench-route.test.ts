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

  it('allows login continuation only to Workbench routes', () => {
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/s%2F1')).toBe('/#/agent-workbench/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-dock/s%2F1')).toBe('/#/agent-workbench-dock/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/settings')).toBe('/');
    expect(safeDashboardH5ReturnTo('//evil.example/#/agent-workbench')).toBe('/');
  });

  it('does not reinterpret a Workbench-only platform cookie as legacy owner authority', () => {
    // P1-7 之后门禁选择与身份判定共用同一处结论（resolveDashboardRequestGate），这里直接跑共享函数。
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

  it('rejects a result-only H5 session from Workbench identity and API gates', () => {
    const identity = resolveDashboardIdentity({
      legacyCookie: undefined,
      activeToken: 'active-management-token',
      roleHeader: undefined,
      actorHeader: undefined,
      scopesHeader: undefined,
      platformMachineId: null,
      platformActorScope: machineId => `scope-${machineId}`,
      legacyAuthSessionId: token => `legacy-${token}`,
      h5: {
        kind: 'feishu-h5',
        userId: 'ou_result_viewer',
        unionId: 'on_result_viewer',
        resultOnly: true,
        authSessionId: 'result-only-session',
        issuedAt: 1,
        expiresAt: 60_001,
      },
    });
    expect(identity).toBeNull();
    const gate = resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      identity,
      tokenFromRequest: undefined,
      activeToken: 'active-management-token',
      publicReadOnly: false,
    });
    expect(gate.workbenchOnlyIdentity).toBe(false);
    expect(gate.decision.kind).toBe('deny401');
  });

  // 源码结构护栏(K2)：预览交互的 unlock / activity / lock 分发在 dashboard.ts 的巨型请求处理里，
  // 没有可单独驱动的 HTTP seam；previewInteractionWriteAllowed 是这条写入口唯一权威的角色门禁
  // （前端按 canInteract 隐藏按钮只是省掉一次必然 403 的点击）。删掉或挪到写调用之后，只读身份
  // 就能静默解锁预览写。判据本身的身份矩阵见 test/preview-interaction.test.ts。
  it('gates every preview-interaction write behind the shared role check', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    const gate = dashboard.search(/!\s*previewInteractionWriteAllowed\s*\(\s*requestIdentity\s*\)/);
    expect(gate, 'dashboard.ts 里找不到预览写门禁').toBeGreaterThan(-1);
    for (const write of ['unlock', 'activity', 'lock']) {
      const calls = [...dashboard.matchAll(new RegExp(`previewInteraction\\.${write}\\(`, 'g'))].map(match => match.index!);
      expect(calls.length, write).toBeGreaterThan(0);
      for (const call of calls) expect(call, `previewInteraction.${write}( 先于门禁`).toBeGreaterThan(gate);
    }
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
});
