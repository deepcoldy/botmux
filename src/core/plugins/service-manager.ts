import { existsSync, mkdirSync, readlinkSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPm2SpawnCommand } from '../../cli/pm2-command.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { pluginCurrentDir, pluginServiceStatePath, pluginsHome } from './paths.js';
import type { InstalledPluginRecord, PluginHostService, PluginServiceState } from './types.js';

export interface PluginPm2Options {
  pm2Bin: string;
  pm2Home: string;
  nodePath?: string;
}

export interface PluginServiceReport {
  pluginId: string;
  serviceName: string;
  pm2Name: string;
  action: 'started' | 'already-running' | 'stopped' | 'not-running' | 'external' | 'failed' | 'status';
  status?: string;
  openUrl?: string;
  warning?: string;
}

interface Pm2AppInfo {
  name: string;
  pid?: number;
  status?: string;
  cwd?: string;
}

export function pluginServicePm2Name(pluginId: string, serviceName: string): string {
  return `botmux-plugin-${pluginId}-${serviceName}`;
}

function pm2Env(opts: PluginPm2Options): NodeJS.ProcessEnv {
  return { ...process.env, PM2_HOME: opts.pm2Home };
}

function runPm2(opts: PluginPm2Options, args: string[], timeoutMs = 20_000): { stdout: string; stderr: string } {
  const cmd = buildPm2SpawnCommand(opts.pm2Bin, args, process.platform, opts.nodePath ?? process.execPath);
  const result = spawnSync(cmd.command, cmd.args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: pm2Env(opts),
    shell: cmd.shell ?? false,
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? (String(result.stderr ?? '').trim() || `status ${result.status}`);
    throw new Error(`pm2 ${args.join(' ')} failed: ${detail}`);
  }
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function listPm2Apps(opts: PluginPm2Options): any[] {
  try {
    const out = runPm2(opts, ['jlist'], 10_000).stdout;
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPm2AppInfo(entry: any): Pm2AppInfo | undefined {
  const name = typeof entry?.name === 'string' ? entry.name : undefined;
  if (!name) return undefined;
  const status = entry?.pm2_env?.status ? String(entry.pm2_env.status) : undefined;
  const cwd = entry?.pm2_env?.pm_cwd ? String(entry.pm2_env.pm_cwd) : undefined;
  const pid = Number(entry?.pid) || undefined;
  return { name, ...(pid ? { pid } : {}), ...(status ? { status } : {}), ...(cwd ? { cwd } : {}) };
}

function pm2AppsByName(opts: PluginPm2Options): Map<string, Pm2AppInfo> {
  const out = new Map<string, Pm2AppInfo>();
  for (const entry of listPm2Apps(opts)) {
    const app = toPm2AppInfo(entry);
    if (app) out.set(app.name, app);
  }
  return out;
}

function pm2AppStatus(opts: PluginPm2Options, pm2Name: string): string | undefined {
  return pm2AppsByName(opts).get(pm2Name)?.status;
}

async function checkHealth(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  const deadline = Date.now() + 5_000;
  let lastError = '';
  try {
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.ok) return undefined;
        lastError = `health ${url} returned ${response.status}`;
      } catch (err: any) {
        lastError = `health ${url} failed: ${err?.message ?? String(err)}`;
      } finally {
        clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (err: any) {
    return `health ${url} failed: ${err?.message ?? String(err)}`;
  }
  return lastError || `health ${url} timed out`;
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

function appMatchesCurrent(app: Pm2AppInfo, currentDir: string, currentRealpath: string): boolean {
  const procCwd = processCwdRealpath(app.pid);
  if (procCwd) return procCwd === currentRealpath;
  if (!app.cwd) return false;
  if (app.cwd === currentDir || app.cwd === currentRealpath) return true;
  try {
    return realpathSync(app.cwd) === currentRealpath;
  } catch {
    return false;
  }
}

function serviceOpenUrl(service: PluginHostService): string | undefined {
  if (service.openUrl) return service.openUrl;
  return service.port ? `http://127.0.0.1:${service.port}/` : undefined;
}

function writeServiceState(
  pluginId: string,
  serviceName: string,
  pm2Name: string,
  record: InstalledPluginRecord,
  currentDir: string,
  currentRealpath: string,
): void {
  const file = pluginServiceStatePath(pluginId, serviceName);
  mkdirSync(dirname(file), { recursive: true });
  const state: PluginServiceState = {
    pluginId,
    serviceName,
    pm2Name,
    version: record.version,
    currentDir,
    currentRealpath,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function deleteServiceState(pluginId: string, serviceName: string): void {
  rmSync(pluginServiceStatePath(pluginId, serviceName), { force: true });
}

function serviceEntries(record: InstalledPluginRecord): Array<[string, PluginHostService]> {
  return Object.entries(record.manifest.services ?? {})
    .filter(([, service]) => service.scope === 'host');
}

export async function ensureManagedHostServices(
  opts: PluginPm2Options,
  pluginIds?: readonly string[],
): Promise<PluginServiceReport[]> {
  return withFileLock(serviceLockTarget(), async () => {
    const registry = readPluginRegistry();
    const selected = pluginIds ? new Set(pluginIds) : undefined;
    const reports: PluginServiceReport[] = [];
    const apps = pm2AppsByName(opts);
    for (const record of Object.values(registry.plugins)) {
      if (selected && !selected.has(record.id)) continue;
      for (const [serviceName, service] of serviceEntries(record)) {
        const pm2Name = pluginServicePm2Name(record.id, serviceName);
        const openUrl = serviceOpenUrl(service);
        if (service.mode === 'external') {
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'external', ...(openUrl ? { openUrl } : {}) });
          continue;
        }
        if (!service.command?.length) {
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', ...(openUrl ? { openUrl } : {}), warning: 'missing command' });
          continue;
        }
        const current = pluginCurrentDir(record.id);
        if (!existsSync(current)) {
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', ...(openUrl ? { openUrl } : {}), warning: `missing current dir: ${current}` });
          continue;
        }
        const currentRealpath = realpathSync(current);
        const app = apps.get(pm2Name);
        if (app?.status === 'online' && appMatchesCurrent(app, current, currentRealpath)) {
          writeServiceState(record.id, serviceName, pm2Name, record, current, currentRealpath);
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'already-running', status: app.status, ...(openUrl ? { openUrl } : {}) });
          continue;
        }
        try {
          if (app) runPm2(opts, ['delete', pm2Name], 20_000);
          runPm2(opts, ['start', service.command[0], '--name', pm2Name, '--cwd', current, '--', ...service.command.slice(1)], 30_000);
          writeServiceState(record.id, serviceName, pm2Name, record, current, currentRealpath);
          const reason = app
            ? app.status === 'online'
              ? 'recreated because process cwd/version did not match current plugin'
              : `recreated from pm2 status ${app.status ?? 'unknown'}`
            : undefined;
          const healthWarning = await checkHealth(service.healthUrl);
          reports.push({
            pluginId: record.id,
            serviceName,
            pm2Name,
            action: 'started',
            ...(openUrl ? { openUrl } : {}),
            ...(reason || healthWarning ? { warning: [reason, healthWarning].filter(Boolean).join('; ') } : {}),
          });
        } catch (err: any) {
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', status: app?.status, ...(openUrl ? { openUrl } : {}), warning: err?.message ?? String(err) });
        }
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export function stopManagedHostServices(
  opts: PluginPm2Options,
  pluginIds?: readonly string[],
): PluginServiceReport[] {
  return withFileLockSync(serviceLockTarget(), () => {
    const registry = readPluginRegistry();
    const selected = pluginIds ? new Set(pluginIds) : undefined;
    const reports: PluginServiceReport[] = [];
    const apps = pm2AppsByName(opts);
    for (const record of Object.values(registry.plugins)) {
      if (selected && !selected.has(record.id)) continue;
      for (const [serviceName, service] of serviceEntries(record)) {
        const pm2Name = pluginServicePm2Name(record.id, serviceName);
        const openUrl = serviceOpenUrl(service);
        if (service.mode !== 'managed') continue;
        const status = apps.get(pm2Name)?.status;
        if (!status) {
          deleteServiceState(record.id, serviceName);
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'not-running', ...(openUrl ? { openUrl } : {}) });
          continue;
        }
        try {
          runPm2(opts, ['delete', pm2Name], 20_000);
          deleteServiceState(record.id, serviceName);
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'stopped', status, ...(openUrl ? { openUrl } : {}) });
        } catch (err: any) {
          reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', status, ...(openUrl ? { openUrl } : {}), warning: err?.message ?? String(err) });
        }
      }
    }
    return reports;
  }, { maxWaitMs: 30_000 });
}

export function listPluginServiceStatus(opts: PluginPm2Options): PluginServiceReport[] {
  const registry = readPluginRegistry();
  const reports: PluginServiceReport[] = [];
  for (const record of Object.values(registry.plugins)) {
    for (const [serviceName, service] of serviceEntries(record)) {
      const pm2Name = pluginServicePm2Name(record.id, serviceName);
      const openUrl = serviceOpenUrl(service);
      if (service.mode === 'external') {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'external', ...(openUrl ? { openUrl } : {}) });
      } else {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'status', status: pm2AppStatus(opts, pm2Name) ?? 'stopped', ...(openUrl ? { openUrl } : {}) });
      }
    }
  }
  return reports;
}
