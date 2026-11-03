import { resolve } from 'node:path';

export interface FleetAppSummary {
  name: string;
  script?: string;
  status?: string;
  version?: string;
}

export interface RuntimeSourceInput {
  apps: FleetAppSummary[];
  normalizePath?: (path: string) => string;
}

export interface RuntimeSource {
  running: boolean;
  sourcePath: string | null;
  sourceVersion: string | null;
}

export function classifyRuntimeSource(input: RuntimeSourceInput): RuntimeSource {
  // The source path decides whether Desktop already owns the fleet or must
  // replace an older/global installation with its bundled runtime.
  const botmuxApps = activeBotmuxApps(input.apps);
  if (botmuxApps.length === 0) return { running: false, sourcePath: null, sourceVersion: null };

  const sourcePaths = botmuxApps
    .map(app => app.script ? normalizeRuntimePath(app.script, input.normalizePath) : null)
    .filter((path): path is string => path !== null);
  return {
    running: true,
    sourcePath: sourcePaths[0] ?? null,
    sourceVersion: botmuxApps.find(app => app.version)?.version ?? null,
  };
}

export function countActiveBotmuxDaemonApps(apps: FleetAppSummary[]): number {
  return apps.filter(isBotmuxDaemonApp).filter(isActiveApp).length;
}

function activeBotmuxApps(apps: FleetAppSummary[]): FleetAppSummary[] {
  return apps.filter(isBotmuxApp).filter(isActiveApp);
}

function isBotmuxApp(app: FleetAppSummary): boolean {
  return app.name === 'botmux-dashboard'
    || app.name === 'botmux'
    || (app.name.startsWith('botmux-') && !app.name.startsWith('botmux-plugin-'));
}

function isBotmuxDaemonApp(app: FleetAppSummary): boolean {
  return app.name !== 'botmux-dashboard'
    && !app.name.startsWith('botmux-plugin-')
    && (app.name === 'botmux' || app.name.startsWith('botmux-'));
}

function isActiveApp(app: FleetAppSummary): boolean {
  // The fleet record keeps stopped processes, so only live-ish statuses should
  // hold the desktop UI in the running state. Missing status preserves old callers.
  return !app.status || app.status === 'online' || app.status === 'launching';
}

function normalizeRuntimePath(path: string, normalizePath?: (path: string) => string): string {
  const resolved = resolve(path);
  return normalizePath ? normalizePath(resolved) : resolved;
}
