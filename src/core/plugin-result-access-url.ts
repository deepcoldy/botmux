import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { config, getDashboardExternalHost } from '../config.js';
import { buildDashboardUrls } from './dashboard-url.js';

export function resolvePluginResultAccessUrl(viewToken: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(viewToken)) return undefined;
  try {
    const portFile = join(homedir(), '.botmux', '.dashboard-port');
    const port = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
      || String(config.dashboard.port);
    const { url } = buildDashboardUrls({ host: getDashboardExternalHost(), port });
    const parsed = new URL(url);
    parsed.pathname = `/plugin-result-access/${encodeURIComponent(viewToken)}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}
