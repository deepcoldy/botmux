import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardRoutes, findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { safeDashboardH5ReturnTo } from '../src/dashboard/h5-auth.js';

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

  it('allows login continuation only to Workbench routes', () => {
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/s%2F1')).toBe('/#/agent-workbench/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-dock/s%2F1')).toBe('/#/agent-workbench-dock/s%2F1');
    expect(safeDashboardH5ReturnTo('/#/settings')).toBe('/');
    expect(safeDashboardH5ReturnTo('//evil.example/#/agent-workbench')).toBe('/');
  });

  it('projects explicit ownership from terminal mutations and keeps H5 context private', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboard).toContain("result.ok ? { ...result, owned: true }");
    expect(dashboard).toContain("result.ok ? { ...result, owned: false }");
    expect(dashboard).toContain("url.pathname === '/api/workbench/h5-context'");
  });

  it('does not reinterpret a Workbench-only platform cookie as legacy owner authority', () => {
    const dashboard = readFileSync(join(process.cwd(), 'src/dashboard.ts'), 'utf8');
    expect(dashboard).toContain('const presentedToken = workbenchOnlyIdentity ? undefined : authedToken(req, url)');
    expect(dashboard).toContain('decideWorkbenchH5Auth');
    expect(dashboard).toContain("requestIdentity.terminalCapability === 'readonly'");
    expect(dashboard).toContain("requestIdentity.previewCapability === 'readonly'");
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
