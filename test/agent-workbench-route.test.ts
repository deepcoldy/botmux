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
});
