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

/** 当前 hash 路由上的查询参数（`#/page?key=value`）；无参数或非浏览器环境返回 null。 */
export function hashQueryParam(name: string, hash = typeof location === 'undefined' ? '' : location.hash): string | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get(name) || null;
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
  pageRoute(
    'agent-workbench-dock',
    '#/agent-workbench-dock',
    () => import('./agent-workbench-dock-page.js'),
    'renderAgentWorkbenchDockPage',
  ),
  pageRoute(
    'agent-workbench',
    '#/agent-workbench',
    () => import('./agent-workbench-page.js'),
    'renderAgentWorkbenchPage',
  ),
  {
    id: 'plugins',
    routePrefix: '#/plugins',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./plugin-page.js');
      return root => mod.renderPluginPage(root);
    },
  },
  pageRoute('workflows', '#/workflows', () => import('./v3-page.js'), 'renderV3RunsPage'),
  pageRoute('groups', '#/groups', () => import('./groups-page.js'), 'renderGroupsPage'),
  pageRoute('settings', '#/settings', () => import('./settings-page.js'), 'renderSettingsPage'),
  pageRoute('bot-defaults', '#/bot-defaults', () => import('./bot-defaults-page.js'), 'renderBotDefaultsPage'),
  // `#/agents`（复数）：`#/agent` 会被 startsWith 匹配吞掉 `#/agent-workbench`。
  pageRoute('agents', '#/agents', () => import('./agents-page.js'), 'renderAgentsPage'),
  pageRoute('skills', '#/skills', () => import('./skills-page.js'), 'renderSkillsPage'),
  pageRoute('customization', '#/customization', () => import('./customization-page.js'), 'renderCustomizationPage'),
  pageRoute('message-listeners', '#/message-listeners', () => import('./message-listeners-page.js'), 'renderMessageListenersPage'),
  pageRoute('connectors-logs', '#/connectors/logs', () => import('./connectors-page.js'), 'renderConnectorsLogsPage'),
  pageRoute('webhook-logs', '#/webhook-logs', () => import('./connectors-page.js'), 'renderConnectorsLogsPage'),
  pageRoute('connectors', '#/connectors', () => import('./connectors-page.js'), 'renderConnectorsPage'),
  pageRoute('team-manage', '#/team/manage', () => import('./team-federation-page.js'), 'renderTeamManagePage'),
  pageRoute('team', '#/team', () => import('./team-federation-page.js'), 'renderTeamFederationPage'),
  pageRoute('roles-profile', '#/roles/profile', () => import('./roles-page.js'), 'renderRoleProfilesPage'),
  pageRoute('roles', '#/roles', () => import('./roles-page.js'), 'renderRolesPage'),
  pageRoute('schedules', '#/schedules', () => import('./schedules-page.js'), 'renderSchedulesPage'),
  pageRoute('whiteboards', '#/whiteboards', () => import('./whiteboards-page.js'), 'renderWhiteboardsPage'),
  pageRoute('doc-watches', '#/doc-watches', () => import('./doc-watches-page.js'), 'renderDocWatchesPage'),
  pageRoute('monitoring', '#/monitoring', () => import('./monitoring-page.js'), 'renderMonitoringPage'),
  pageRoute('sessions', '#/sessions', () => import('./sessions-page.js'), 'renderSessionsPage'),
  pageRoute('monitor-room', '#/monitor-room', () => import('./monitor-room.js'), 'renderMonitorRoomPage', true),
  pageRoute('insights', '#/insights', () => import('./insights-page.js'), 'renderInsightsPage'),
  pageRoute('feedback', '#/feedback', () => import('./feedback-page.js'), 'renderFeedbackPage'),
  pageRoute('terminal', '#/terminal', () => import('./terminal-page.js'), 'renderTerminalPage'),
];

export function findDashboardRoute(hash: string): DashboardRoute | undefined {
  return dashboardRoutes.find(route => route.exact ? hash === route.routePrefix : hash.startsWith(route.routePrefix));
}

export async function loadOverviewPage(): Promise<DashboardRouteRenderer> {
  const mod = await import('./overview-page.js');
  return root => mod.renderOverviewPage(root);
}
