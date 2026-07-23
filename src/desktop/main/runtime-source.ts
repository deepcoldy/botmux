import { resolve } from 'node:path';

export interface Pm2AppSummary {
  name: string;
  script?: string;
  status?: string;
  version?: string;
}

export interface RuntimeSourceInput {
  pm2Apps: Pm2AppSummary[];
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
  const botmuxApps = activeBotmuxApps(input.pm2Apps);
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

export function countActiveBotmuxDaemonApps(pm2Apps: Pm2AppSummary[]): number {
  return pm2Apps.filter(isBotmuxDaemonApp).filter(isActivePm2App).length;
}

export function parsePm2Apps(stdout: string): Pm2AppSummary[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(app => {
      if (!app || typeof app !== 'object') return [];
      const record = app as { name?: unknown; script?: unknown; pm2_env?: { pm_exec_path?: unknown; status?: unknown; version?: unknown } };
      if (typeof record.name !== 'string') return [];
      const script = typeof record.script === 'string'
        ? record.script
        : typeof record.pm2_env?.pm_exec_path === 'string'
          ? record.pm2_env.pm_exec_path
          : undefined;
      const status = typeof record.pm2_env?.status === 'string' ? record.pm2_env.status : undefined;
      const version = typeof record.pm2_env?.version === 'string' ? record.pm2_env.version : undefined;
      return [{ name: record.name, script, status, version }];
    });
  } catch {
    return [];
  }
}

function activeBotmuxApps(pm2Apps: Pm2AppSummary[]): Pm2AppSummary[] {
  return pm2Apps.filter(isBotmuxApp).filter(isActivePm2App);
}

function isBotmuxApp(app: Pm2AppSummary): boolean {
  return app.name === 'botmux-dashboard'
    || app.name === 'botmux'
    || (app.name.startsWith('botmux-') && !app.name.startsWith('botmux-plugin-'));
}

function isBotmuxDaemonApp(app: Pm2AppSummary): boolean {
  return app.name !== 'botmux-dashboard'
    && !app.name.startsWith('botmux-plugin-')
    && (app.name === 'botmux' || app.name.startsWith('botmux-'));
}

function isActivePm2App(app: Pm2AppSummary): boolean {
  // PM2 keeps stopped processes in jlist, so only live-ish statuses should hold
  // the desktop UI in the running state. Missing status preserves old callers.
  return !app.status || app.status === 'online' || app.status === 'launching';
}

function normalizeRuntimePath(path: string, normalizePath?: (path: string) => string): string {
  const resolved = resolve(path);
  return normalizePath ? normalizePath(resolved) : resolved;
}
