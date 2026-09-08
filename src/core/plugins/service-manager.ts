import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { config } from '../../config.js';
import { formatUrlHost } from '../dashboard-url.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import {
  pluginHome,
  pluginRuntimeDir,
  pluginServiceStatePath,
  pluginsHome,
} from './paths.js';
import { getOrCreatePluginCardActionToken } from './card-actions/auth.js';
import {
  PLUGIN_CARD_ACTION_ENDPOINT_ENV,
  PLUGIN_CARD_ACTION_TOKEN_ENV,
} from './card-actions/protocol.js';
import { loadPluginServiceDefinition, type PluginServiceDefinition } from './runtime.js';
import { changePluginService, readPluginProcesses, type PluginProcessInfo } from './supervisor-client.js';
import { ensurePluginServicePreload, pluginServiceName, type PluginServiceSpec } from './supervisor-store.js';
import { isStandaloneBinary } from '../self-spawn.js';
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

export class PluginServiceDeleteError extends Error {
  readonly code = 'plugin_service_delete_failed';
  readonly failures: PluginServiceReport[];

  constructor(readonly reports: PluginServiceReport[]) {
    const failures = reports.filter(report => report.action === 'failed');
    super(`plugin_service_delete_failed:${failures.map(report => report.pluginId).join(',')}`);
    this.name = 'PluginServiceDeleteError';
    this.failures = failures;
  }
}

const DEFAULT_LINK_WATCH_DELAY_MS = 2_000;

function serviceLockTarget(): string {
  mkdirSync(pluginsHome(), { recursive: true });
  return `${pluginsHome()}/service-manager`;
}

/**
 * Serializes every plugin service lifecycle mutation on one file lock so a
 * concurrent plugin start/stop/delete can't interleave. The lock covers both
 * desired-state publication and acknowledgement before lifecycle file changes.
 */
export function withPluginServiceLockSync<T>(fn: () => T): T {
  return withFileLockSync(serviceLockTarget(), fn, { maxWaitMs: 30_000 });
}

export function withPluginServiceLock<T>(fn: () => Promise<T> | T): Promise<T> {
  return withFileLock(serviceLockTarget(), async () => fn(), { maxWaitMs: 30_000 });
}

const assertCardActionServicePort = (
  record: InstalledPluginRecord,
  definition: PluginServiceDefinition,
): number | undefined => {
  if (!record.contributions?.cardActions) return undefined;
  if (!Number.isInteger(definition.port) || definition.port! < 1 || definition.port! > 65_535) {
    throw new Error(`plugin_card_actions_fixed_port_required:${record.id}`);
  }
  return definition.port;
};

const publicDefinitionEnv = (record: InstalledPluginRecord, definition: PluginServiceDefinition): Record<string, string> => {
  const cardActionPort = assertCardActionServicePort(record, definition);
  const env: Record<string, string> = {
    ...(definition.pm2.env ?? {}),
    BOTMUX_PLUGIN_ID: record.id,
    BOTMUX_PLUGIN_DIR: pluginRuntimeDir(record.id),
    BOTMUX_PLUGIN_HOME: pluginHome(record.id),
  };
  if (record.contributions?.cardActions) {
    env[PLUGIN_CARD_ACTION_ENDPOINT_ENV] = record.contributions.cardActions.endpoint;
    env.PORT = String(cardActionPort);
  }
  return env;
};

const definitionEnv = (record: InstalledPluginRecord, definition: PluginServiceDefinition): Record<string, string> => {
  const env = publicDefinitionEnv(record, definition);
  return record.contributions?.cardActions
    ? {
        ...env,
        [PLUGIN_CARD_ACTION_TOKEN_ENV]: getOrCreatePluginCardActionToken(record.id),
      }
    : env;
};

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

export function resolvePluginServiceSpec(
  record: InstalledPluginRecord,
  definition: PluginServiceDefinition,
): PluginServiceSpec {
  const linked = isLinkedPlugin(record);
  const script = definitionScript(record, definition);
  const javascript = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].includes(extname(script));
  const env: Record<string, string> = {
    ...definitionEnv(record, definition),
    BOTMUX_PLUGIN_LINKED: linked ? '1' : '0',
  };
  // A standalone botmux executable contains the Bun runtime. BUN_BE_BUN runs
  // the installed JS service with that runtime instead of entering botmux CLI.
  // https://bun.sh/docs/bundler/executables#act-as-the-bun-cli
  delete env.BUN_BE_BUN;
  const runtimeArgs: string[] = [];
  if (javascript && isStandaloneBinary()) {
    env.BUN_BE_BUN = '1';
    runtimeArgs.push('--preload', ensurePluginServicePreload());
  }
  const watchDelayMs = Number.isFinite(definition.pm2.watchDelayMs)
    ? Math.max(0, Number(definition.pm2.watchDelayMs))
    : DEFAULT_LINK_WATCH_DELAY_MS;
  const killTimeoutMs = Number.isFinite(definition.pm2.killTimeoutMs)
    ? Math.max(0, Number(definition.pm2.killTimeoutMs))
    : undefined;
  return {
    name: pluginServiceName(record.id), appId: '', botIndex: -1,
    logBaseName: record.id,
    external: {
      command: javascript ? process.execPath : script,
      args: [...runtimeArgs, ...(javascript ? [script] : []), ...(definition.pm2.args ?? [])],
      cwd: definitionCwd(record, definition), env,
      autorestart: definition.pm2.autorestart !== false,
      ...(killTimeoutMs !== undefined ? { killTimeoutMs } : {}),
      configHash: serviceConfigHash(record, definition, linked),
    },
    ...(linked ? { watch: { path: linkedWatchPath(record), delayMs: watchDelayMs } } : {}),
  };
}

function findService(name: string): PluginProcessInfo | undefined {
  return readPluginProcesses().find(app => app.name === name);
}

function isStoppedService(app: PluginProcessInfo): boolean {
  return app.pid === undefined && (app.status === 'stopped' || app.status === 'errored');
}

export function assertPluginServiceStopped(pluginId: string, operation: PluginLifecycleOperation): void {
  const app = findService(pluginServiceName(pluginId));
  if (!app || isStoppedService(app)) return;
  throw new PluginServiceRunningError(pluginId, operation, app.status ?? 'unknown', app.pid);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

export function rewriteLoopbackServiceUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    // The WHATWG hostname setter silently drops a bare IPv6 literal (`::1`), so
    // pass the bracketed form or the loopback rewrite would no-op.
    if (isLoopbackHost(url.hostname)) {
      url.hostname = formatUrlHost(config.dashboard.externalHost);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function serviceUrls(record: InstalledPluginRecord, definition: PluginServiceDefinition): Pick<PluginServiceState, 'port' | 'openUrl' | 'healthUrl'> {
  const env = publicDefinitionEnv(record, definition);
  const port = definition.port ?? (env.PORT ? Number(env.PORT) : undefined);
  const host = formatUrlHost(config.dashboard.externalHost);
  const urls = definition.urls?.({ host, env, ...(Number.isFinite(port) ? { port } : {}) }) ?? {};
  return {
    ...(Number.isFinite(port) ? { port } : {}),
    ...(urls.openUrl ? { openUrl: rewriteLoopbackServiceUrl(urls.openUrl) } : Number.isFinite(port) ? { openUrl: `http://${host}:${port}/` } : {}),
    ...(urls.healthUrl ? { healthUrl: rewriteLoopbackServiceUrl(urls.healthUrl) } : {}),
  };
}

export function readPluginServiceState(pluginId: string): PluginServiceState | undefined {
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

function writeServiceState(record: InstalledPluginRecord, definition: PluginServiceDefinition, app: PluginProcessInfo | undefined): PluginServiceState {
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
    processName: pluginServiceName(record.id),
    supervisor: 'builtin',
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

/** Capture manually started services when planning an explicit service restart. */
export async function snapshotRunningManualPluginServiceIds(): Promise<string[]> {
  return withPluginServiceLock(async () => {
    return selectRunningManualPluginServiceIds(selectedRecords(), readPluginProcesses());
  });
}

export function selectRunningManualPluginServiceIds(
  records: readonly InstalledPluginRecord[],
  processes: readonly PluginProcessInfo[],
): string[] {
  const apps = new Map(processes.map(app => [app.name, app]));
  return records
    .filter(record => record.manifest.service?.mode === 'manual')
    .filter(record => {
      const app = apps.get(pluginServiceName(record.id));
      return !!app
        && app.status !== 'stopped'
        && app.status !== 'errored'
        && ((typeof app.pid === 'number' && app.pid > 1)
          || app.status === 'online'
          || app.status === 'launching');
    })
    .map(record => record.id);
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

async function startService(record: InstalledPluginRecord, definition: PluginServiceDefinition): Promise<'started' | 'already-running'> {
  const spec = resolvePluginServiceSpec(record, definition);
  const existing = findService(spec.name);
  const alreadyRunning = existing?.status === 'online' && existing.configHash === spec.external.configHash;
  await changePluginService(record.id, 'start', spec);
  if (alreadyRunning) return 'already-running';
  return 'started';
}

export async function startPluginServices(
  pluginIds?: readonly string[],
  options: { autoOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withPluginServiceLock(async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.autoOnly === true)) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const action = await startService(record, definition);
        const app = findService(pluginServiceName(record.id));
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, action, state));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readPluginServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  });
}

export async function stopPluginServices(
  pluginIds?: readonly string[],
  options: { autoOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withPluginServiceLock(async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.autoOnly === true)) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const name = pluginServiceName(record.id);
        const before = findService(name);
        if (!before) {
          const state = writeServiceState(record, definition, before);
          reports.push(reportFromState(record, 'not-running', state));
          continue;
        }
        await changePluginService(record.id, 'stop');
        const app = findService(name);
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, isStoppedService(before) ? 'not-running' : 'stopped', state));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readPluginServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  });
}

export async function deletePluginServicesUnlocked(pluginIds?: readonly string[]): Promise<PluginServiceReport[]> {
  const reports: PluginServiceReport[] = [];
  for (const record of selectedRecords(pluginIds)) {
    try {
      const name = pluginServiceName(record.id);
      if (findService(name)) {
        await changePluginService(record.id, 'remove');
        const remaining = findService(name);
        if (remaining) {
          throw new Error(`plugin_delete_not_applied:${name}:${remaining.status ?? 'unknown'}`);
        }
      }
      deleteServiceState(record.id);
      reports.push(reportFromState(record, 'deleted', undefined));
    } catch (err: any) {
      reports.push(reportFromState(record, 'failed', readPluginServiceState(record.id), err?.message ?? String(err)));
    }
  }
  return reports;
}

/** Destructive lifecycle callers use the strict variant so a supervisor failure
 * aborts before registry/runtime/binding cleanup can begin. */
export async function deletePluginServicesOrThrowUnlocked(
  pluginIds?: readonly string[],
): Promise<PluginServiceReport[]> {
  const reports = await deletePluginServicesUnlocked(pluginIds);
  if (reports.some(report => report.action === 'failed')) {
    throw new PluginServiceDeleteError(reports);
  }
  return reports;
}

export async function deletePluginServices(pluginIds?: readonly string[]): Promise<PluginServiceReport[]> {
  return withPluginServiceLock(() => deletePluginServicesUnlocked(pluginIds));
}

export async function listPluginServiceStatus(): Promise<PluginServiceReport[]> {
  // Keep each status snapshot ordered against lifecycle mutations. Reading it
  // never starts a supervisor or a service.
  return withPluginServiceLock(async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords()) {
      try {
        const definition = await loadPluginServiceDefinition(record);
        if (!definition) continue;
        const app = findService(pluginServiceName(record.id));
        const state = writeServiceState(record, definition, app);
        reports.push(reportFromState(record, 'status', state));
      } catch (err: any) {
        reports.push(reportFromState(record, 'failed', readPluginServiceState(record.id), err?.message ?? String(err)));
      }
    }
    return reports;
  });
}
