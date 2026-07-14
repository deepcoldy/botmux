import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import {
  pluginConfigPath,
  pluginRuntimeDir,
  pluginSettingsPath,
  resolvePluginPath,
} from './paths.js';
import type { BotmuxPluginManifest, InstalledPluginRecord, PluginRuntime } from './types.js';

export interface PluginApplyContext {
  runtime: PluginRuntime;
  pluginId: string;
  pluginDir: string;
  packageName: string;
  version: string;
  manifest: BotmuxPluginManifest;
}

export interface PluginServiceDefinition {
  mode?: 'manual' | 'auto';
  port?: number;
  pm2: {
    script: string;
    cwd?: string;
    args?: string[];
    env?: Record<string, string>;
    autorestart?: boolean;
  };
  urls?(ctx: { host: string; env: Record<string, string>; port?: number }): {
    openUrl?: string;
    healthUrl?: string;
  };
}

export interface PluginConfigApi {
  path: string;
  get<T = unknown>(key?: string): T | undefined;
  set(key: string, value: unknown): void;
  replace(value: Record<string, unknown>): void;
}

export interface PluginCommandContext extends PluginApplyContext {
  args: string[];
  api?: Record<string, unknown>;
}

export interface PluginCliCommand {
  name: string;
  description?: string;
  run(ctx: PluginCommandContext): void | string | number | Promise<void | string | number>;
}

export interface RegisteredPluginCommand extends PluginCliCommand {
  pluginId: string;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function createConfigApi(pluginId: string): PluginConfigApi {
  const path = pluginConfigPath(pluginId);
  const write = (value: Record<string, unknown>) => {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  };
  return {
    path,
    get<T = unknown>(key?: string): T | undefined {
      const value = readJsonObject(path);
      return (key ? getPath(value, key) : value) as T | undefined;
    },
    set(key: string, value: unknown): void {
      const current = readJsonObject(path);
      setPath(current, key, value);
      write(current);
    },
    replace(value: Record<string, unknown>): void {
      write(value);
    },
  };
}

function orderedPluginRecords(pluginIds?: readonly string[]): InstalledPluginRecord[] {
  const registry = readPluginRegistry();
  const selected = pluginIds?.length ? [...pluginIds] : Object.keys(registry.plugins);
  const out: InstalledPluginRecord[] = [];
  const seen = new Set<string>();
  for (const id of selected) {
    if (seen.has(id)) continue;
    const record = registry.plugins[id];
    if (!record) throw new Error(`plugin_not_installed:${id}`);
    seen.add(id);
    out.push(record);
  }
  return out;
}

export async function loadPluginServiceDefinition(record: InstalledPluginRecord): Promise<PluginServiceDefinition | undefined> {
  if (!record.manifest.service) return undefined;
  const pluginDir = pluginRuntimeDir(record.id);
  const entrypoint = record.contributions?.service?.entry;
  if (!entrypoint) throw new Error(`plugin_service_entry_not_found:${record.id}`);
  const entry = resolvePluginPath(pluginDir, entrypoint, 'service_entry');
  if (!existsSync(entry)) throw new Error(`plugin_service_entry_not_found:${record.id}:${entrypoint}`);
  const mod = await import(pathToFileURL(entry).href);
  const exported = mod.default ?? mod;
  const definition = typeof exported === 'function'
    ? await exported(baseApi(record, 'service'), baseContext(record, 'service'))
    : exported;
  if (!definition || typeof definition !== 'object') throw new Error(`plugin_service_definition_not_found:${record.id}`);
  const service = definition as PluginServiceDefinition;
  if (!service.pm2 || typeof service.pm2 !== 'object') throw new Error(`plugin_service_pm2_missing:${record.id}`);
  if (typeof service.pm2.script !== 'string' || !service.pm2.script.trim()) throw new Error(`plugin_service_pm2_script_missing:${record.id}`);
  if (service.mode && service.mode !== record.manifest.service.mode) throw new Error(`plugin_service_mode_mismatch:${record.id}`);
  return service;
}

function baseContext(record: InstalledPluginRecord, runtime: PluginRuntime): PluginApplyContext {
  return {
    runtime,
    pluginId: record.id,
    pluginDir: pluginRuntimeDir(record.id),
    packageName: record.packageName,
    version: record.version,
    manifest: record.manifest,
  };
}

function baseApi(record: InstalledPluginRecord, runtime: PluginRuntime): Record<string, unknown> {
  const pluginDir = pluginRuntimeDir(record.id);
  return {
    runtime,
    logger: console,
    resolve: (path: string) => resolvePluginPath(pluginDir, path),
    config: createConfigApi(record.id),
    settingsPath: pluginSettingsPath(record.id),
  };
}

export async function collectPluginCliCommands(pluginIds?: readonly string[]): Promise<RegisteredPluginCommand[]> {
  const commands: RegisteredPluginCommand[] = [];
  for (const record of orderedPluginRecords(pluginIds)) {
    const contribution = record.contributions?.cli;
    if (!contribution) continue;
    for (const command of contribution.commands) {
      commands.push({
        pluginId: record.id,
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        async run(ctx: PluginCommandContext) {
          const entry = resolvePluginPath(pluginRuntimeDir(record.id), contribution.entry, 'cli_entry');
          if (!existsSync(entry)) throw new Error(`plugin_cli_entry_not_found:${record.id}`);
          const mod = await import(pathToFileURL(entry).href);
          const exported = mod.default ?? mod;
          const handler = exported?.[command.name];
          const api = baseApi(record, 'cli');
          const handlerCtx = { ...ctx, api };
          if (typeof handler === 'function') return handler(handlerCtx, api);
          if (handler && typeof handler.run === 'function') return handler.run(handlerCtx, api);
          throw new Error(`plugin_cli_handler_not_found:${record.id}:${command.name}`);
        },
      });
    }
  }
  return commands;
}
