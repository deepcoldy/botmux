import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPm2SpawnCommand } from '../../cli/pm2-command.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { pluginCurrentDir, pluginServiceStatePath } from './paths.js';
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
  warning?: string;
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

function pm2AppStatus(opts: PluginPm2Options, pm2Name: string): string | undefined {
  const app = listPm2Apps(opts).find((entry) => entry?.name === pm2Name);
  return app?.pm2_env?.status ? String(app.pm2_env.status) : undefined;
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

function writeServiceState(pluginId: string, serviceName: string, pm2Name: string): void {
  const file = pluginServiceStatePath(pluginId, serviceName);
  mkdirSync(dirname(file), { recursive: true });
  const state: PluginServiceState = {
    pluginId,
    serviceName,
    pm2Name,
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
  const registry = readPluginRegistry();
  const selected = pluginIds ? new Set(pluginIds) : undefined;
  const reports: PluginServiceReport[] = [];
  for (const record of Object.values(registry.plugins)) {
    if (selected && !selected.has(record.id)) continue;
    for (const [serviceName, service] of serviceEntries(record)) {
      const pm2Name = pluginServicePm2Name(record.id, serviceName);
      if (service.mode === 'external') {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'external' });
        continue;
      }
      if (!service.command?.length) {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', warning: 'missing command' });
        continue;
      }
      const current = pluginCurrentDir(record.id);
      if (!existsSync(current)) {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', warning: `missing current dir: ${current}` });
        continue;
      }
      const status = pm2AppStatus(opts, pm2Name);
      if (status === 'online') {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'already-running', status });
        continue;
      }
      try {
        runPm2(opts, ['start', service.command[0], '--name', pm2Name, '--cwd', current, '--', ...service.command.slice(1)], 30_000);
        writeServiceState(record.id, serviceName, pm2Name);
        reports.push({
          pluginId: record.id,
          serviceName,
          pm2Name,
          action: 'started',
          warning: await checkHealth(service.healthUrl),
        });
      } catch (err: any) {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', warning: err?.message ?? String(err) });
      }
    }
  }
  return reports;
}

export function stopManagedHostServices(
  opts: PluginPm2Options,
  pluginIds?: readonly string[],
): PluginServiceReport[] {
  const registry = readPluginRegistry();
  const selected = pluginIds ? new Set(pluginIds) : undefined;
  const reports: PluginServiceReport[] = [];
  for (const record of Object.values(registry.plugins)) {
    if (selected && !selected.has(record.id)) continue;
    for (const [serviceName, service] of serviceEntries(record)) {
      const pm2Name = pluginServicePm2Name(record.id, serviceName);
      if (service.mode !== 'managed') continue;
      const status = pm2AppStatus(opts, pm2Name);
      if (!status) {
        deleteServiceState(record.id, serviceName);
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'not-running' });
        continue;
      }
      try {
        runPm2(opts, ['delete', pm2Name], 20_000);
        deleteServiceState(record.id, serviceName);
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'stopped', status });
      } catch (err: any) {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'failed', status, warning: err?.message ?? String(err) });
      }
    }
  }
  return reports;
}

export function listPluginServiceStatus(opts: PluginPm2Options): PluginServiceReport[] {
  const registry = readPluginRegistry();
  const reports: PluginServiceReport[] = [];
  for (const record of Object.values(registry.plugins)) {
    for (const [serviceName, service] of serviceEntries(record)) {
      const pm2Name = pluginServicePm2Name(record.id, serviceName);
      if (service.mode === 'external') {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'external' });
      } else {
        reports.push({ pluginId: record.id, serviceName, pm2Name, action: 'status', status: pm2AppStatus(opts, pm2Name) ?? 'stopped' });
      }
    }
  }
  return reports;
}
