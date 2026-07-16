import type { IncomingMessage, ServerResponse } from 'node:http';

import { botmuxInstallRoot, botmuxVersion } from '../utils/install-info.js';
import { resolveEffectiveBotmuxVersion } from '../utils/version-info.js';
import { jsonRes } from './http.js';

export interface DesktopCompatManifest {
  schemaVersion: 1;
  product: 'botmux';
  runtimeVersion: string;
  dashboardProtocolVersion: 1;
  desktopShell: {
    supported: true;
    minAppVersion?: string;
  };
  features: string[];
  routes: string[];
}

export interface BuildCompatManifestOptions {
  runtimeVersion?: string;
}

const DASHBOARD_CORE_ROUTES = [
  '#/',
  '#/sessions',
  '#/workflows',
  '#/groups',
  '#/schedules',
  '#/settings',
] as const;

const DASHBOARD_COMPAT_FEATURES = [
  'desktop-shell',
  'dashboard-protocol-v1',
] as const;

export function buildCompatManifest(options: BuildCompatManifestOptions = {}): DesktopCompatManifest {
  return {
    schemaVersion: 1,
    product: 'botmux',
    runtimeVersion: options.runtimeVersion ?? resolveEffectiveBotmuxVersion({
      rawVersion: botmuxVersion(),
      rootDir: botmuxInstallRoot(),
    }),
    dashboardProtocolVersion: 1,
    // Keep this v1 manifest static: the desktop shell uses it as a cheap
    // compatibility probe before loading the full dashboard UI.
    desktopShell: { supported: true },
    features: [...DASHBOARD_COMPAT_FEATURES],
    routes: [...DASHBOARD_CORE_ROUTES],
  };
}

export function handleDesktopCompat(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' || url.pathname !== '/__desktop/compat') return false;
  jsonRes(res, 200, buildCompatManifest());
  return true;
}
