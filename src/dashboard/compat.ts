import type { IncomingMessage, ServerResponse } from 'node:http';

import { botmuxInstallRoot, botmuxVersion } from '../utils/install-info.js';
import { resolveEffectiveBotmuxVersion } from '../utils/version-info.js';
import { jsonRes } from './http.js';

export interface DashboardCompatModule {
  supported: boolean;
  route?: string;
}

const DASHBOARD_MODULE_SPECS = {
  overview: {
    supported: true,
    route: '#/',
    capabilities: ['overview.read'],
  },
  sessions: {
    supported: true,
    route: '#/sessions',
    capabilities: ['sessions.read', 'sessions.manage', 'sessions.terminal', 'asks.read', 'asks.answer'],
  },
  groups: { supported: true, route: '#/groups', capabilities: ['groups.read', 'groups.manage'] },
  roles: { supported: true, route: '#/roles', capabilities: ['roles.read', 'roles.manage'] },
  monitoring: { supported: true, route: '#/monitoring', capabilities: ['monitoring.read'] },
  insights: { supported: true, route: '#/insights', capabilities: ['insights.read'] },
  schedules: { supported: true, route: '#/schedules', capabilities: ['schedules.read', 'schedules.manage'] },
  whiteboards: { supported: true, route: '#/whiteboards', capabilities: ['whiteboards.read', 'whiteboards.manage'] },
  office: { supported: true, route: '#/office', capabilities: ['office.read'] },
  bots: { supported: true, route: '#/bot-defaults', capabilities: ['bots.read', 'bots.configure'] },
  skills: { supported: true, route: '#/skills', capabilities: ['skills.read', 'skills.manage'] },
  plugins: { supported: true, route: '#/plugins', capabilities: ['plugins.read', 'plugins.manage'] },
  team: { supported: true, route: '#/team', capabilities: ['team.read', 'team.manage'] },
  connectors: { supported: true, route: '#/connectors', capabilities: ['connectors.read', 'connectors.manage'] },
  settings: {
    supported: true,
    route: '#/settings',
    capabilities: ['settings.read', 'settings.manage', 'updates.read', 'updates.manage'],
  },
  workflow: {
    supported: false,
    capabilities: ['workflow.read', 'workflow.manage'],
  },
} as const satisfies Record<string, {
  supported: boolean;
  route?: string;
  capabilities: readonly string[];
}>;

type DashboardModuleSpec = typeof DASHBOARD_MODULE_SPECS[keyof typeof DASHBOARD_MODULE_SPECS];
export type DashboardCompatCapability = DashboardModuleSpec['capabilities'][number];

export interface DesktopCompatManifest {
  schemaVersion: 1;
  product: 'botmux';
  runtimeVersion: string;
  dashboardProtocolVersion: 2;
  desktopShell: {
    supported: true;
    minAppVersion?: string;
  };
  runtimeIdentity?: {
    source: 'platform-binding';
    machineId: string;
  };
  features: string[];
  routes: string[];
  modules: Record<string, DashboardCompatModule>;
  capabilities: Record<DashboardCompatCapability, boolean>;
}

export interface BuildCompatManifestOptions {
  runtimeVersion?: string;
  /**
   * Override the machine identity used by tests or an embedding host.
   * `null` explicitly means that no reliable machine identity is available.
   */
  machineId?: string | null;
}

const DASHBOARD_COMPAT_FEATURES = [
  'desktop-shell',
  'dashboard-protocol-v1',
  'dashboard-protocol-v2',
  'dashboard-modules',
  'dashboard-capabilities',
] as const;

function buildDashboardModules(): Record<string, DashboardCompatModule> {
  return Object.fromEntries(
    Object.entries(DASHBOARD_MODULE_SPECS).map(([id, spec]) => [
      id,
      {
        supported: spec.supported,
        ...('route' in spec ? { route: spec.route } : {}),
      },
    ]),
  );
}

function buildDashboardCapabilities(): Record<DashboardCompatCapability, boolean> {
  const capabilities: Partial<Record<DashboardCompatCapability, boolean>> = {};
  for (const spec of Object.values(DASHBOARD_MODULE_SPECS)) {
    for (const capability of spec.capabilities) {
      capabilities[capability] = spec.supported;
    }
  }
  return capabilities as Record<DashboardCompatCapability, boolean>;
}

function buildDashboardRoutes(): string[] {
  return Object.values(DASHBOARD_MODULE_SPECS)
    .filter((spec): spec is DashboardModuleSpec & { route: string } =>
      spec.supported && 'route' in spec)
    .map(spec => spec.route);
}

export function buildCompatManifest(options: BuildCompatManifestOptions = {}): DesktopCompatManifest {
  const machineId = normalizeMachineId(options.machineId);

  return {
    schemaVersion: 1,
    product: 'botmux',
    runtimeVersion: options.runtimeVersion ?? resolveEffectiveBotmuxVersion({
      rawVersion: botmuxVersion(),
      rootDir: botmuxInstallRoot(),
    }),
    dashboardProtocolVersion: 2,
    desktopShell: { supported: true },
    ...(machineId
      ? { runtimeIdentity: { source: 'platform-binding' as const, machineId } }
      : {}),
    features: [...DASHBOARD_COMPAT_FEATURES],
    routes: buildDashboardRoutes(),
    modules: buildDashboardModules(),
    capabilities: buildDashboardCapabilities(),
  };
}

function normalizeMachineId(value: string | null | undefined): string | undefined {
  const machineId = value?.trim();
  return machineId ? machineId : undefined;
}

export function compatMachineIdForAuthenticatedRequest(
  presentedToken: string | undefined,
  activeToken: string | null | undefined,
  boundMachineId: string | null | undefined,
): string | null {
  if (!activeToken || presentedToken !== activeToken) return null;
  return normalizeMachineId(boundMachineId) ?? null;
}

export function handleDesktopCompat(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: BuildCompatManifestOptions = {},
): boolean {
  if (req.method !== 'GET' || url.pathname !== '/__desktop/compat') return false;
  jsonRes(res, 200, buildCompatManifest(options));
  return true;
}
