import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import {
  pluginHome,
  pluginRuntimeDir,
  pluginServicePm2ConfigPath,
  pluginServiceStatePath,
  pluginsHome,
} from './paths.js';
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

export type PluginLifecycleOperation = 'install' | 'update' | 'uninstall';

export class PluginServiceRunningError extends Error {
  readonly code = 'plugin_service_running';

  constructor(
    readonly pluginId: string,
    readonly operation: PluginLifecycleOperation,
    readonly serviceStatus: string,
    readonly pid?: number,
  ) {
    super(`plugin_service_running:${pluginId}:${operation}:${serviceStatus}${pid ? `:${pid}` : ''}`);
    this.name = 'PluginServiceRunningError';
  }
}

interface Pm2AppInfo {
  name: string;
  pid?: number;
  status?: string;
  pm2Env?: Record<string, unknown>;
}

const DEFAULT_LINK_WATCH_DELAY_MS = 2_000;

function serviceLockTarget(): string {
  mkdirSync(pluginsHome(), { recursive: true });
  return `${pluginsHome()}/service-manager`;
}

export function withPluginServiceLockSync<T>(fn: () => T): T {
  return withFileLockSync(serviceLockTarget(), fn, { maxWaitMs: 30_000 });
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

function isLinkedPlugin(record: InstalledPluginRecord): boolean {
  if (record.source.type !== 'local') return false;
  if (record.source.link === true) return true;
  try {
    return lstatSync(pluginRuntimeDir(record.id)).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkedWatchPath(record: InstalledPluginRecord): string {
  if (record.source.type === 'local' && record.source.spec) {
    const runtimeDir = resolve(record.source.spec, 'dist');
    const buildWatchDir = resolve(runtimeDir, 'botmux-build');
    return existsSync(buildWatchDir) ? buildWatchDir : runtimeDir;
  }
  return pluginRuntimeDir(record.id);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function serviceConfigHash(
  record: InstalledPluginRecord,
  definition: PluginServiceDefinition,
  linked: boolean,
): string {
  return createHash('sha256').update(stableJson({
    script: definitionScript(record, definition),
    cwd: definitionCwd(record, definition),
    args: definition.pm2.args ?? [],
    env: definitionEnv(record, definition),
    autorestart: definition.pm2.autorestart !== false,
    killTimeoutMs: definition.pm2.killTimeoutMs ?? null,
    watch: linked ? linkedWatchPath(record) : false,
    watchDelayMs: linked ? definition.pm2.watchDelayMs ?? DEFAULT_LINK_WATCH_DELAY_MS : null,
  })).digest('hex').slice(0, 16);
}

function pm2ConfigHash(app: Pm2AppInfo): string | undefined {
  const direct = app.pm2Env?.BOTMUX_PLUGIN_SERVICE_CONFIG_HASH;
  if (typeof direct === 'string') return direct;
  const nested = app.pm2Env?.env;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>).BOTMUX_PLUGIN_SERVICE_CONFIG_HASH;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function writePm2Config(
  record: InstalledPluginRecord,
  definition: PluginServiceDefinition,
  env: Record<string, string>,
  linked: boolean,
): string {
  const watchDelayMs = Number.isFinite(definition.pm2.watchDelayMs)
    ? Math.max(0, Number(definition.pm2.watchDelayMs))
    : DEFAULT_LINK_WATCH_DELAY_MS;
  const killTimeoutMs = Number.isFinite(definition.pm2.killTimeoutMs)
    ? Math.max(0, Number(definition.pm2.killTimeoutMs))
    : undefined;
  const app = {
    name: pluginPm2AppName(record.id),
    script: definitionScript(record, definition),
    cwd: definitionCwd(record, definition),
    time: true,
    autorestart: definition.pm2.autorestart !== false,
    ...(definition.pm2.args?.length ? { args: definition.pm2.args } : {}),
    ...(killTimeoutMs !== undefined ? { kill_timeout: killTimeoutMs } : {}),
    watch: linked ? [linkedWatchPath(record)] : false,
    ...(linked ? { watch_delay: watchDelayMs } : {}),
    env,
  };
  const file = pluginServicePm2ConfigPath(record.id);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ apps: [app] }, null, 2) + '\n', { mode: 0o600 });
  return file;
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

function isStoppedPm2App(app: Pm2AppInfo): boolean {
  return app.pid === undefined && (app.status === 'stopped' || app.status === 'errored');
}

export function assertPluginServiceStopped(pluginId: string, operation: PluginLifecycleOperation): void {
  const app = findPm2App(pluginPm2AppName(pluginId));
  if (!app || isStoppedPm2App(app)) return;
  throw new PluginServiceRunningError(pluginId, operation, app.status ?? 'unknown', app.pid);
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

function startPm2(record: InstalledPluginRecord, definition: PluginServiceDefinition): 'started' | 'already-running' {
  const name = pluginPm2AppName(record.id);
  const linked = isLinkedPlugin(record);
  const configHash = serviceConfigHash(record, definition, linked);
  const env = {
    ...definitionEnv(record, definition),
    BOTMUX_PLUGIN_LINKED: linked ? '1' : '0',
    BOTMUX_PLUGIN_SERVICE_CONFIG_HASH: configHash,
  };
  const pm2Config = writePm2Config(record, definition, env, linked);
  let existing = findPm2App(name);
  if (existing) {
    const currentHash = pm2ConfigHash(existing);
    const needsDefinitionRefresh = currentHash
      ? currentHash !== configHash || (linked && existing.status !== 'online')
      : linked || existing.status !== 'online';
    if (needsDefinitionRefresh) {
      runPluginPm2(['delete', name], { inherit: false, timeoutMs: 30_000 });
      existing = undefined;
    }
  }
  if (existing) {
    if (existing.status === 'online') return 'already-running';
    runPluginPm2(['start', name, '--update-env'], { inherit: false, env, timeoutMs: 30_000 });
    return 'started';
  }
  runPluginPm2(['start', pm2Config, '--only', name, '--update-env'], {
    inherit: false,
    env,
    timeoutMs: 30_000,
  });
  return 'started';
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
        const action = startPm2(record, definition);
        const app = findPm2App(pluginPm2AppName(record.id));
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, action, state));
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
