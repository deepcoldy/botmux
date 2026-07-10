import type { PageDisposer } from './react-mount.js';

export type DashboardRouteRenderer = (root: HTMLElement) => void | PageDisposer;
export type DashboardRouteLoadResult = DashboardRouteRenderer | Promise<DashboardRouteRenderer>;

export interface DashboardRoute {
  id: string;
  routePrefix: string;
  exact?: boolean;
  rerenderOnUiChange?: boolean;
  load(): DashboardRouteLoadResult;
}

function pageRoute<T extends Record<K, DashboardRouteRenderer>, K extends keyof T & string>(
  id: string,
  routePrefix: string,
  importer: () => Promise<T>,
  renderName: K,
  rerenderOnUiChange = false,
): DashboardRoute {
  return {
    id,
    routePrefix,
    rerenderOnUiChange,
    load: async () => {
      const mod = await importer();
      return mod[renderName];
    },
  };
}

export const dashboardRoutes: DashboardRoute[] = [
  pageRoute('legacy-workflow', '#/legacy-workflow', () => import('./legacy-workflow-page.js'), 'renderLegacyWorkflowPage'),
  pageRoute('workflows', '#/workflows', () => import('./v3-page.js'), 'renderV3RunsPage'),
  pageRoute('groups', '#/groups', () => import('./groups-page.js'), 'renderGroupsPage'),
  pageRoute('settings', '#/settings', () => import('./settings-page.js'), 'renderSettingsPage'),
  pageRoute('bot-defaults', '#/bot-defaults', () => import('./bot-defaults-page.js'), 'renderBotDefaultsPage'),
  pageRoute('skills', '#/skills', () => import('./skills-page.js'), 'renderSkillsPage'),
  pageRoute('connectors', '#/connectors', () => import('./connectors-page.js'), 'renderConnectorsPage'),
  pageRoute('team-manage', '#/team/manage', () => import('./team-federation-page.js'), 'renderTeamManagePage'),
  pageRoute('team', '#/team', () => import('./team-federation-page.js'), 'renderTeamFederationPage'),
  pageRoute('roles-profile', '#/roles/profile', () => import('./roles-page.js'), 'renderRoleProfilesPage'),
  pageRoute('roles', '#/roles', () => import('./roles-page.js'), 'renderRolesPage'),
  pageRoute('schedules', '#/schedules', () => import('./schedules-page.js'), 'renderSchedulesPage'),
  pageRoute('whiteboards', '#/whiteboards', () => import('./whiteboards-page.js'), 'renderWhiteboardsPage'),
  pageRoute('monitoring', '#/monitoring', () => import('./monitoring-page.js'), 'renderMonitoringPage'),
  pageRoute('sessions', '#/sessions', () => import('./sessions-page.js'), 'renderSessionsPage'),
  pageRoute('monitor-room', '#/monitor-room', () => import('./monitor-room.js'), 'renderMonitorRoomPage', true),
  pageRoute('office', '#/office', () => import('./office-page.js'), 'renderOfficePage'),
  pageRoute('insights', '#/insights', () => import('./insights-page.js'), 'renderInsightsPage'),
];

export function findDashboardRoute(hash: string): DashboardRoute | undefined {
  return dashboardRoutes.find(route => route.exact ? hash === route.routePrefix : hash.startsWith(route.routePrefix));
}

export async function loadOverviewPage(): Promise<DashboardRouteRenderer> {
  const mod = await import('./overview-page.js');
  return root => mod.renderOverviewPage(root);
}
