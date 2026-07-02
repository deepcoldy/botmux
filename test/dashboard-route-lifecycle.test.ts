import { describe, expect, it, vi } from 'vitest';
import {
  beginDashboardRoute,
  createDashboardRouteState,
  loadAndRenderDashboardRoute,
} from '../src/dashboard/web/route-lifecycle.js';
import type { DashboardRouteRenderer } from '../src/dashboard/web/dashboard-routes.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('dashboard route lifecycle', () => {
  it('does not run a stale lazy route renderer after a newer route commits', async () => {
    const state = createDashboardRouteState();
    const root = { textContent: '' } as unknown as HTMLElement;
    const slow = deferred<DashboardRouteRenderer>();
    const staleRender = vi.fn((host: HTMLElement) => { host.textContent = 'stale'; });
    const latestRender = vi.fn((host: HTMLElement) => { host.textContent = 'latest'; });

    const seqA = beginDashboardRoute(state);
    const routeA = loadAndRenderDashboardRoute(state, seqA, root, () => slow.promise);

    const seqB = beginDashboardRoute(state);
    const routeB = loadAndRenderDashboardRoute(
      state,
      seqB,
      root,
      () => latestRender,
      { rerenderOnUiChange: false },
    );
    await expect(routeB).resolves.toBe(true);
    expect(latestRender).toHaveBeenCalledTimes(1);
    expect(root.textContent).toBe('latest');
    expect(state.rerenderOnUiChange).toBe(false);

    slow.resolve(staleRender);
    await expect(routeA).resolves.toBe(false);
    expect(staleRender).not.toHaveBeenCalled();
    expect(root.textContent).toBe('latest');
  });

  it('disposes the previously committed route before starting the next route', async () => {
    const state = createDashboardRouteState();
    const root = { textContent: '' } as unknown as HTMLElement;
    const dispose = vi.fn();

    const seqA = beginDashboardRoute(state);
    await expect(loadAndRenderDashboardRoute(
      state,
      seqA,
      root,
      () => host => { host.textContent = 'first'; return dispose; },
    )).resolves.toBe(true);
    expect(state.pageDispose).toBe(dispose);

    const seqB = beginDashboardRoute(state);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(loadAndRenderDashboardRoute(
      state,
      seqB,
      root,
      () => host => { host.textContent = 'second'; },
    )).resolves.toBe(true);
    expect(root.textContent).toBe('second');
    expect(state.pageDispose).toBeNull();
  });

  it('dashboard route registry preserves React page disposers', async () => {
    vi.resetModules();
    const overviewDispose = vi.fn();
    const whiteboardsDispose = vi.fn();
    const settingsDispose = vi.fn();
    const skillsDispose = vi.fn();
    const groupsDispose = vi.fn();
    const rolesDispose = vi.fn();
    const roleProfilesDispose = vi.fn();
    const teamDispose = vi.fn();
    const teamManageDispose = vi.fn();
    const v3Dispose = vi.fn();
    const insightsDispose = vi.fn();

    vi.doMock('../src/dashboard/web/overview-page.js', () => ({
      renderOverviewPage: vi.fn(() => overviewDispose),
    }));
    vi.doMock('../src/dashboard/web/whiteboards-page.js', () => ({
      renderWhiteboardsPage: vi.fn(() => whiteboardsDispose),
    }));
    vi.doMock('../src/dashboard/web/settings-page.js', () => ({
      renderSettingsPage: vi.fn(() => settingsDispose),
    }));
    vi.doMock('../src/dashboard/web/skills-page.js', () => ({
      renderSkillsPage: vi.fn(() => skillsDispose),
    }));
    vi.doMock('../src/dashboard/web/groups-page.js', () => ({
      renderGroupsPage: vi.fn(() => groupsDispose),
    }));
    vi.doMock('../src/dashboard/web/roles-page.js', () => ({
      renderRolesPage: vi.fn(() => rolesDispose),
      renderRoleProfilesPage: vi.fn(() => roleProfilesDispose),
    }));
    vi.doMock('../src/dashboard/web/team-federation-page.js', () => ({
      renderTeamFederationPage: vi.fn(() => teamDispose),
      renderTeamManagePage: vi.fn(() => teamManageDispose),
    }));
    vi.doMock('../src/dashboard/web/v3-page.js', () => ({
      renderV3RunsPage: vi.fn(() => v3Dispose),
    }));
    vi.doMock('../src/dashboard/web/insights-page.js', () => ({
      renderInsightsPage: vi.fn(() => insightsDispose),
    }));

    const routes = await import('../src/dashboard/web/dashboard-routes.js');
    const root = {} as HTMLElement;

    const overviewRender = await routes.loadOverviewPage();
    expect(overviewRender(root)).toBe(overviewDispose);

    const whiteboardsRender = await routes.findDashboardRoute('#/whiteboards')!.load();
    expect(whiteboardsRender(root)).toBe(whiteboardsDispose);

    const settingsRender = await routes.findDashboardRoute('#/settings')!.load();
    expect(settingsRender(root)).toBe(settingsDispose);

    const skillsRender = await routes.findDashboardRoute('#/skills')!.load();
    expect(skillsRender(root)).toBe(skillsDispose);

    const groupsRender = await routes.findDashboardRoute('#/groups')!.load();
    expect(groupsRender(root)).toBe(groupsDispose);

    const rolesRender = await routes.findDashboardRoute('#/roles')!.load();
    expect(rolesRender(root)).toBe(rolesDispose);

    const roleProfilesRender = await routes.findDashboardRoute('#/roles/profile')!.load();
    expect(roleProfilesRender(root)).toBe(roleProfilesDispose);

    const teamRender = await routes.findDashboardRoute('#/team')!.load();
    expect(teamRender(root)).toBe(teamDispose);

    const teamManageRender = await routes.findDashboardRoute('#/team/manage')!.load();
    expect(teamManageRender(root)).toBe(teamManageDispose);

    const v3Render = await routes.findDashboardRoute('#/workflows')!.load();
    expect(v3Render(root)).toBe(v3Dispose);

    const insightsRender = await routes.findDashboardRoute('#/insights')!.load();
    expect(insightsRender(root)).toBe(insightsDispose);

    vi.doUnmock('../src/dashboard/web/overview-page.js');
    vi.doUnmock('../src/dashboard/web/whiteboards-page.js');
    vi.doUnmock('../src/dashboard/web/settings-page.js');
    vi.doUnmock('../src/dashboard/web/skills-page.js');
    vi.doUnmock('../src/dashboard/web/groups-page.js');
    vi.doUnmock('../src/dashboard/web/roles-page.js');
    vi.doUnmock('../src/dashboard/web/team-federation-page.js');
    vi.doUnmock('../src/dashboard/web/v3-page.js');
    vi.doUnmock('../src/dashboard/web/insights-page.js');
  });
});
