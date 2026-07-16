import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { pluginHome, pluginRuntimeDir, pluginServiceStatePath, pluginsHome } from './paths.js';
import { loadPluginServiceDefinition, type PluginServiceDefinition } from './runtime.js';
import { capturePluginPm2, pluginPm2AppName, runPluginPm2 } from './pm2.js';
import type { InstalledPluginRecord, PluginServiceMode, PluginServiceState } from './types.js';

export interface PluginServiceReport {
  pluginId: string;
  action: 'started' | 'already-running' | 'stopped' | 'not-running' | 'failed' | 'status' | 'deleted';
  mode?: PluginServiceMode;
  status?: string;
  pid?: number;
  port?: number;
  openUrl?: string;
  healthUrl?: string;
  warning?: string;
}

interface Pm2AppInfo {
  name: string;
  pid?: number;
  status?: string;
  pm2Env?: Record<string, unknown>;
}

function serviceLockTarget(): string {
  mkdirSync(pluginsHome(), { recursive: true });
  return `${pluginsHome()}/service-manager`;
}

function definitionEnv(record: InstalledPluginRecord, definition: PluginServiceDefinition): Record<string, string> {
  return {
    ...(definition.pm2.env ?? {}),
    BOTMUX_PLUGIN_ID: record.id,
    BOTMUX_PLUGIN_DIR: pluginRuntimeDir(record.id),
    BOTMUX_PLUGIN_HOME: pluginHome(record.id),
  };
}

function definitionCwd(record: InstalledPluginRecord, definition: PluginServiceDefinition): string {
  const cwd = definition.pm2.cwd || pluginRuntimeDir(record.id);
  return isAbsolute(cwd) ? cwd : resolve(pluginRuntimeDir(record.id), cwd);
}

function definitionScript(record: InstalledPluginRecord, definition: PluginServiceDefinition): string {
  const script = definition.pm2.script;
  return isAbsolute(script) ? script : resolve(definitionCwd(record, definition), script);
}

function parsePm2JlistOutput(output: string): any[] {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    for (let start = output.lastIndexOf('['); start >= 0; start = output.lastIndexOf('[', start - 1)) {
      try {
        const parsed = JSON.parse(output.slice(start).trim());
        if (Array.isArray(parsed)) return parsed;
      } catch { /* try an earlier '['; pm2 may prefix stdout with [PM2] logs */ }
    }
    throw new Error('pm2_jlist_json_not_found');
  }
}

function readPm2Apps(): Pm2AppInfo[] {
  const raw = capturePluginPm2(['jlist'], { timeoutMs: 10_000 });
  const parsed = parsePm2JlistOutput(raw);
  return (Array.isArray(parsed) ? parsed : []).map(app => ({
    name: String(app?.name ?? ''),
    pid: typeof app?.pid === 'number' && app.pid > 0 ? app.pid : undefined,
    status: typeof app?.pm2_env?.status === 'string' ? app.pm2_env.status : undefined,
    pm2Env: app?.pm2_env && typeof app.pm2_env === 'object' ? app.pm2_env : undefined,
  })).filter(app => app.name);
}

function findPm2App(name: string): Pm2AppInfo | undefined {
  return readPm2Apps().find(app => app.name === name);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function rewriteLoopbackServiceUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (isLoopbackHost(url.hostname)) url.hostname = config.dashboard.externalHost;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function serviceUrls(record: InstalledPluginRecord, definition: PluginServiceDefinition): Pick<PluginServiceState, 'port' | 'openUrl' | 'healthUrl'> {
  const env = definitionEnv(record, definition);
  const port = definition.port ?? (env.PORT ? Number(env.PORT) : undefined);
  const urls = definition.urls?.({ host: config.dashboard.externalHost, env, ...(Number.isFinite(port) ? { port } : {}) }) ?? {};
  return {
    ...(Number.isFinite(port) ? { port } : {}),
    ...(urls.openUrl ? { openUrl: rewriteLoopbackServiceUrl(urls.openUrl) } : Number.isFinite(port) ? { openUrl: `http://${config.dashboard.externalHost}:${port}/` } : {}),
    ...(urls.healthUrl ? { healthUrl: rewriteLoopbackServiceUrl(urls.healthUrl) } : {}),
  };
}

function readServiceState(pluginId: string): PluginServiceState | undefined {
  const file = pluginServiceStatePath(pluginId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PluginServiceState
      : undefined;
  } catch {
    return undefined;
  }
}

function writeServiceState(record: InstalledPluginRecord, definition: PluginServiceDefinition, app: Pm2AppInfo | undefined): PluginServiceState {
  const runtimeDir = pluginRuntimeDir(record.id);
  const runtimeRealpath = existsSync(runtimeDir) ? realpathSync(runtimeDir) : undefined;
  const state: PluginServiceState = {
    pluginId: record.id,
    version: record.version,
    runtimeDir,
    ...(runtimeRealpath ? { runtimeRealpath } : {}),
    updatedAt: new Date().toISOString(),
    status: app?.status ?? 'stopped',
    ...(typeof app?.pid === 'number' ? { pid: app.pid } : {}),
    ...serviceUrls(record, definition),
    pm2Name: pluginPm2AppName(record.id),
  };
  const file = pluginServiceStatePath(record.id);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return state;
}

function deleteServiceState(pluginId: string): void {
  rmSync(pluginServiceStatePath(pluginId), { force: true });
}

function selectedRecords(pluginIds?: readonly string[], autoOnly = false): InstalledPluginRecord[] {
  const registry = readPluginRegistry();
  const selected = pluginIds ? new Set(pluginIds) : undefined;
  return Object.values(registry.plugins)
    .filter(record => !selected || selected.has(record.id))
    .filter(record => !!record.manifest.service)
    .filter(record => !autoOnly || record.manifest.service?.mode === 'auto')
    .sort((a, b) => a.id.localeCompare(b.id));
}

function reportFromState(
  record: InstalledPluginRecord,
  action: PluginServiceReport['action'],
  state?: PluginServiceState,
  warning?: string,
): PluginServiceReport {
  return {
    pluginId: record.id,
    action,
    mode: record.manifest.service?.mode,
    ...(state?.status ? { status: state.status } : {}),
    ...(typeof state?.pid === 'number' ? { pid: state.pid } : {}),
    ...(typeof state?.port === 'number' ? { port: state.port } : {}),
    ...(typeof state?.openUrl === 'string' ? { openUrl: state.openUrl } : {}),
    ...(typeof state?.healthUrl === 'string' ? { healthUrl: state.healthUrl } : {}),
    ...(warning ? { warning } : {}),
  };
}

function startPm2(record: InstalledPluginRecord, definition: PluginServiceDefinition): void {
  const name = pluginPm2AppName(record.id);
  const env = definitionEnv(record, definition);
  const existing = findPm2App(name);
  if (existing) {
    if (existing.status === 'online') return;
    runPluginPm2(['start', name, '--update-env'], { inherit: false, env, timeoutMs: 30_000 });
    return;
  }
  const args = [
    'start',
    definitionScript(record, definition),
    '--name',
    name,
    '--cwd',
    definitionCwd(record, definition),
    '--time',
    '--update-env',
  ];
  if (definition.pm2.autorestart === false) args.push('--no-autorestart');
  if (definition.pm2.args?.length) args.push('--', ...definition.pm2.args);
  runPluginPm2(args, { inherit: false, env, timeoutMs: 30_000 });
}

export async function startPluginServices(
  pluginIds?: readonly string[],
  options: { autoOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.autoOnly === true)) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const before = findPm2App(pluginPm2AppName(record.id));
        if (before?.status === 'online') {
          const state = writeServiceState(record, definition, before);
          reports.push(reportFromState(record, 'already-running', state));
          continue;
        }
        startPm2(record, definition);
        const app = findPm2App(pluginPm2AppName(record.id));
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, 'started', state));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export async function stopPluginServices(
  pluginIds?: readonly string[],
  options: { autoOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.autoOnly === true)) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const name = pluginPm2AppName(record.id);
        const before = findPm2App(name);
        if (!before || before.status === 'stopped') {
          const state = writeServiceState(record, definition, before);
          reports.push(reportFromState(record, 'not-running', state));
          continue;
        }
        runPluginPm2(['stop', name], { inherit: false, timeoutMs: 30_000 });
        const app = findPm2App(name);
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, 'stopped', state));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export async function deletePluginServices(pluginIds?: readonly string[]): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds)) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const name = pluginPm2AppName(record.id);
        if (findPm2App(name)) runPluginPm2(['delete', name], { inherit: false, timeoutMs: 30_000 });
        deleteServiceState(record.id);
        reports.push(reportFromState(record, 'deleted', undefined));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export async function listPluginServiceStatus(): Promise<PluginServiceReport[]> {
  const reports: PluginServiceReport[] = [];
  for (const record of selectedRecords()) {
    try {
      const definition = await loadPluginServiceDefinition(record);
      if (!definition) continue;
      const app = findPm2App(pluginPm2AppName(record.id));
      const state = writeServiceState(record, definition, app);
      reports.push(reportFromState(record, 'status', state));
    } catch (err: any) {
      reports.push(reportFromState(record, 'failed', readServiceState(record.id), err?.message ?? String(err)));
    }
  }
  return reports;
}
