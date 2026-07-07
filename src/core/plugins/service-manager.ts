import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { pluginCurrentDir, pluginServiceStatePath, pluginsHome } from './paths.js';
import { loadPluginServiceController, type PluginServiceRuntimeInfo } from './runtime.js';
import type { InstalledPluginRecord, PluginServiceState } from './types.js';

export interface PluginServiceReport {
  pluginId: string;
  action: 'started' | 'already-running' | 'stopped' | 'not-running' | 'failed' | 'status';
  mode?: 'manual' | 'lifecycle';
  status?: string;
  pid?: number;
  port?: number;
  openUrl?: string;
  healthUrl?: string;
  warning?: string;
}

function serviceLockTarget(): string {
  mkdirSync(pluginsHome(), { recursive: true });
  return join(pluginsHome(), 'service-manager');
}

function processCwdRealpath(pid: number | undefined): string | undefined {
  if (!pid || process.platform !== 'linux') return undefined;
  try {
    return realpathSync(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return undefined;
  }
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

function publicServiceInfo(info: PluginServiceRuntimeInfo | undefined): PluginServiceRuntimeInfo {
  const out: PluginServiceRuntimeInfo = { ...(info ?? {}) };
  if (typeof out.openUrl === 'string') out.openUrl = rewriteLoopbackServiceUrl(out.openUrl);
  if (typeof out.healthUrl === 'string') out.healthUrl = rewriteLoopbackServiceUrl(out.healthUrl);
  if (!out.openUrl && typeof out.port === 'number') {
    out.openUrl = `http://${config.dashboard.externalHost}:${out.port}/`;
  }
  return out;
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

function writeServiceState(record: InstalledPluginRecord, info: PluginServiceRuntimeInfo): PluginServiceState {
  const currentDir = pluginCurrentDir(record.id);
  const currentRealpath = existsSync(currentDir) ? realpathSync(currentDir) : undefined;
  const state: PluginServiceState = {
    ...publicServiceInfo(info),
    pluginId: record.id,
    version: record.version,
    currentDir,
    ...(currentRealpath ? { currentRealpath } : {}),
    updatedAt: new Date().toISOString(),
  };
  const file = pluginServiceStatePath(record.id);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return state;
}

function deleteServiceState(pluginId: string): void {
  rmSync(pluginServiceStatePath(pluginId), { force: true });
}

function selectedRecords(pluginIds?: readonly string[], lifecycleOnly = false): InstalledPluginRecord[] {
  const registry = readPluginRegistry();
  const selected = pluginIds ? new Set(pluginIds) : undefined;
  return Object.values(registry.plugins)
    .filter(record => !selected || selected.has(record.id))
    .filter(record => !!record.manifest.service)
    .filter(record => !lifecycleOnly || record.manifest.service?.mode === 'lifecycle')
    .sort((a, b) => a.id.localeCompare(b.id));
}

function reportFromInfo(
  record: InstalledPluginRecord,
  action: PluginServiceReport['action'],
  info?: PluginServiceRuntimeInfo,
  warning?: string,
): PluginServiceReport {
  const publicInfo = publicServiceInfo(info);
  const status = typeof publicInfo.status === 'string'
    ? publicInfo.status
    : action === 'started' || action === 'already-running'
      ? 'online'
      : action === 'stopped' || action === 'not-running'
        ? 'stopped'
        : undefined;
  return {
    pluginId: record.id,
    action,
    mode: record.manifest.service?.mode,
    ...(status ? { status } : {}),
    ...(typeof publicInfo.pid === 'number' ? { pid: publicInfo.pid } : {}),
    ...(typeof publicInfo.port === 'number' ? { port: publicInfo.port } : {}),
    ...(typeof publicInfo.openUrl === 'string' ? { openUrl: publicInfo.openUrl } : {}),
    ...(typeof publicInfo.healthUrl === 'string' ? { healthUrl: publicInfo.healthUrl } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function readControllerStatus(record: InstalledPluginRecord, previousState?: PluginServiceRuntimeInfo): Promise<PluginServiceRuntimeInfo | undefined> {
  const controller = await loadPluginServiceController(record);
  if (controller?.status) return publicServiceInfo(await controller.status({ runtime: 'service', pluginId: record.id, pluginDir: pluginCurrentDir(record.id), packageName: record.packageName, version: record.version, manifest: record.manifest }, previousState));
  return previousState ? publicServiceInfo(previousState) : undefined;
}

function currentStateLooksAlive(state: PluginServiceRuntimeInfo | undefined): boolean {
  if (!state) return false;
  if (state.status === 'online' || state.status === 'running') return true;
  if (typeof state.pid !== 'number') return false;
  try {
    process.kill(state.pid, 0);
  } catch {
    return false;
  }
  const currentDir = typeof state.currentRealpath === 'string' ? state.currentRealpath : undefined;
  return !currentDir || processCwdRealpath(state.pid) === currentDir;
}

async function waitForControllerOnline(
  controller: NonNullable<Awaited<ReturnType<typeof loadPluginServiceController>>>,
  record: InstalledPluginRecord,
  initial: PluginServiceRuntimeInfo,
): Promise<PluginServiceRuntimeInfo> {
  if (!controller.status) return initial;
  let latest = initial;
  const ctx = { runtime: 'service' as const, pluginId: record.id, pluginDir: pluginCurrentDir(record.id), packageName: record.packageName, version: record.version, manifest: record.manifest };
  const deadline = Date.now() + 5_000;
  do {
    await new Promise(resolve => setTimeout(resolve, 250));
    latest = publicServiceInfo(await controller.status(ctx, latest));
  } while (!currentStateLooksAlive(latest) && Date.now() < deadline);
  return latest;
}

export async function startPluginServices(
  pluginIds?: readonly string[],
  options: { lifecycleOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.lifecycleOnly === true)) {
      const previous = readServiceState(record.id);
      try {
        const controller = await loadPluginServiceController(record);
        if (!controller?.start) {
          reports.push(reportFromInfo(record, 'failed', previous, 'service controller has no start()'));
          continue;
        }
        const before = await readControllerStatus(record, previous);
        if (currentStateLooksAlive(before)) {
          writeServiceState(record, before ?? {});
          reports.push(reportFromInfo(record, 'already-running', before));
          continue;
        }
        const started = publicServiceInfo(await controller.start({ runtime: 'service', pluginId: record.id, pluginDir: pluginCurrentDir(record.id), packageName: record.packageName, version: record.version, manifest: record.manifest }, previous));
        const finalInfo = await waitForControllerOnline(controller, record, { status: 'online', ...started });
        const state = writeServiceState(record, finalInfo);
        reports.push(reportFromInfo(record, 'started', state));
      } catch (err: any) {
        reports.push(reportFromInfo(record, 'failed', previous, err?.message ?? String(err)));
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export async function stopPluginServices(
  pluginIds?: readonly string[],
  options: { lifecycleOnly?: boolean } = {},
): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const reports: PluginServiceReport[] = [];
    for (const record of selectedRecords(pluginIds, options.lifecycleOnly === true)) {
      const previous = readServiceState(record.id);
      try {
        const controller = await loadPluginServiceController(record);
        const before = await readControllerStatus(record, previous);
        if (!currentStateLooksAlive(before) && !previous) {
          reports.push(reportFromInfo(record, 'not-running', before));
          continue;
        }
        if (controller?.stop) await controller.stop({ runtime: 'service', pluginId: record.id, pluginDir: pluginCurrentDir(record.id), packageName: record.packageName, version: record.version, manifest: record.manifest }, previous ?? before);
        deleteServiceState(record.id);
        reports.push(reportFromInfo(record, 'stopped', before));
      } catch (err: any) {
        reports.push(reportFromInfo(record, 'failed', previous, err?.message ?? String(err)));
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export async function listPluginServiceStatus(): Promise<PluginServiceReport[]> {
  const reports: PluginServiceReport[] = [];
  for (const record of selectedRecords()) {
    const previous = readServiceState(record.id);
    try {
      const info = await readControllerStatus(record, previous);
      reports.push(reportFromInfo(record, 'status', { ...info, status: currentStateLooksAlive(info) ? 'online' : 'stopped' }));
    } catch (err: any) {
      reports.push(reportFromInfo(record, 'failed', previous, err?.message ?? String(err)));
    }
  }
  return reports;
}
