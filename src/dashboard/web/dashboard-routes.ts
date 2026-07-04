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

export const dashboardRoutes: DashboardRoute[] = [
  {
    id: 'legacy-workflow',
    routePrefix: '#/legacy-workflow',
    load: async () => {
      const mod = await import('./workflows.js');
      return root => mod.renderWorkflowsPage(root);
    },
  },
  {
    id: 'workflows',
    routePrefix: '#/workflows',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./v3-page.js');
      return root => mod.renderV3RunsPage(root);
    },
  },
  {
    id: 'groups',
    routePrefix: '#/groups',
    // Groups is currently a render-once React scaffold around the existing
    // imperative matrix/dialog controller, so locale/theme changes full-remount
    // it until those controller-owned subtrees become React components.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./groups-page.js');
      return root => mod.renderGroupsPage(root);
    },
  },
  {
    id: 'settings',
    routePrefix: '#/settings',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./settings-page.js');
      return root => mod.renderSettingsPage(root);
    },
  },
  {
    id: 'bot-defaults',
    routePrefix: '#/bot-defaults',
    // Bot defaults is currently a render-once React scaffold around the
    // imperative settings controller, so ui changes still full-remount it to
    // refresh translations without partial React renders fighting innerHTML.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./bot-defaults-page.js');
      return root => mod.renderBotDefaultsPage(root);
    },
  },
  {
    id: 'skills',
    routePrefix: '#/skills',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./skills-page.js');
      return root => mod.renderSkillsPage(root);
    },
  },
  {
    id: 'connectors',
    routePrefix: '#/connectors',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./connectors.js');
      return root => mod.renderConnectorsPage(root);
    },
  },
  {
    id: 'team-manage',
    routePrefix: '#/team/manage',
    // Team pages are render-once React scaffolds around the existing
    // federation controller, so ui changes full-remount translated subtrees.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./team-federation-page.js');
      return root => mod.renderTeamManagePage(root);
    },
  },
  {
    id: 'team',
    routePrefix: '#/team',
    // Team pages are render-once React scaffolds around the existing
    // federation controller, so ui changes full-remount translated subtrees.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./team-federation-page.js');
      return root => mod.renderTeamFederationPage(root);
    },
  },
  {
    id: 'roles-profile',
    routePrefix: '#/roles/profile',
    // Roles still uses a render-once React scaffold around the imperative
    // editor/profile controller, so ui changes full-remount it until the
    // controller-owned subtrees become reactive components.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./roles-page.js');
      return root => mod.renderRoleProfilesPage(root);
    },
  },
  {
    id: 'roles',
    routePrefix: '#/roles',
    // Roles still uses a render-once React scaffold around the imperative
    // editor/profile controller, so ui changes full-remount it until the
    // controller-owned subtrees become reactive components.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./roles-page.js');
      return root => mod.renderRolesPage(root);
    },
  },
  {
    id: 'schedules',
    routePrefix: '#/schedules',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./schedules.js');
      return root => mod.renderSchedulesPage(root);
    },
  },
  {
    id: 'whiteboards',
    routePrefix: '#/whiteboards',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./whiteboards-page.js');
      return root => mod.renderWhiteboardsPage(root);
    },
  },
  {
    id: 'sessions',
    routePrefix: '#/sessions',
    // Sessions is a render-once React scaffold around the legacy imperative
    // controller. Keep full remounts on locale/theme changes until the
    // controller is split into reactive components, so translated scaffold text
    // and command-owned DOM stay in sync without partial React re-renders.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./sessions-page.js');
      return root => mod.renderSessionsPage(root);
    },
  },
  {
    id: 'office',
    routePrefix: '#/office',
    rerenderOnUiChange: false,
    load: async () => {
      const mod = await import('./office-page.js');
      return root => mod.renderOfficePage(root);
    },
  },
  {
    id: 'insights',
    routePrefix: '#/insights',
    // Insights is a render-once React scaffold around a large imperative
    // workbench controller; remount on ui changes until that controller is
    // split into reactive components.
    rerenderOnUiChange: true,
    load: async () => {
      const mod = await import('./insights-page.js');
      return root => mod.renderInsightsPage(root);
    },
  },
];

export function findDashboardRoute(hash: string): DashboardRoute | undefined {
  return dashboardRoutes.find(route => route.exact ? hash === route.routePrefix : hash.startsWith(route.routePrefix));
}

export async function loadOverviewPage(): Promise<DashboardRouteRenderer> {
  const mod = await import('./overview-page.js');
  return root => mod.renderOverviewPage(root);
}
