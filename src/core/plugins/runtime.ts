import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import {
  pluginConfigPath,
  pluginCurrentDir,
  pluginSettingsPath,
  resolvePluginPath,
} from './paths.js';
import { resolveStaticPluginMcpServers, type ResolvedPluginMcpServer, type ResolvePluginMcpInput } from './mcp.js';
import type { BotmuxPluginManifest, InstalledPluginRecord, PluginRuntime } from './types.js';

export interface PluginApplyContext {
  runtime: PluginRuntime;
  pluginId: string;
  pluginDir: string;
  packageName: string;
  version: string;
  manifest: BotmuxPluginManifest;
}

export interface PluginConfigApi {
  path: string;
  get<T = unknown>(key?: string): T | undefined;
  set(key: string, value: unknown): void;
  replace(value: Record<string, unknown>): void;
}

export interface PluginCommandContext extends PluginApplyContext {
  args: string[];
}

export interface PluginCliCommand {
  name: string;
  description?: string;
  run(ctx: PluginCommandContext): void | string | number | Promise<void | string | number>;
}

export interface RegisteredPluginCommand extends PluginCliCommand {
  pluginId: string;
}

type DynamicMcpServer = {
  name: string;
  transport?: 'stdio';
  command: string[];
  env?: Record<string, string>;
};

type WorkerMcpTap = {
  pluginId: string;
  name: string;
  handler(ctx: {
    botId: string;
    sessionId: string;
    pluginIds: readonly string[];
    addMcpServer(name: string, server: Omit<DynamicMcpServer, 'name'>): void;
  }): void | Promise<void>;
};

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

function hasRuntimeHook(record: InstalledPluginRecord, runtime: PluginRuntime): boolean {
  if (!record.manifest.main) return false;
  const hooks = record.manifest.hooks;
  return !hooks || hooks.includes(runtime);
}

function orderedPluginRecords(pluginIds?: readonly string[]): InstalledPluginRecord[] {
  const registry = readPluginRegistry();
  const selected = pluginIds?.length ? [...pluginIds] : Object.keys(registry.plugins);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const out: InstalledPluginRecord[] = [];

  const visit = (id: string, chain: string[]) => {
    const record = registry.plugins[id];
    if (!record) throw new Error(`plugin_not_installed:${id}`);
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`plugin_dependency_cycle:${[...chain, id].join('>')}`);
    visiting.add(id);
    for (const dep of Object.keys(record.manifest.dependencies?.plugins ?? {})) visit(dep, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
    out.push(record);
  };

  for (const id of selected) visit(id, []);
  return out;
}

async function importPluginApply(record: InstalledPluginRecord): Promise<((api: any, ctx: PluginApplyContext) => unknown) | undefined> {
  if (!record.manifest.main) return undefined;
  const pluginDir = pluginCurrentDir(record.id);
  const entry = resolvePluginPath(pluginDir, record.manifest.main, 'main');
  if (!existsSync(entry)) throw new Error(`plugin_main_not_found:${record.id}:${record.manifest.main}`);
  const mod = await import(pathToFileURL(entry).href);
  const exported = mod.default ?? mod;
  if (typeof exported === 'function') return exported;
  if (exported && typeof exported.apply === 'function') return exported.apply.bind(exported);
  throw new Error(`plugin_apply_not_found:${record.id}`);
}

function baseContext(record: InstalledPluginRecord, runtime: PluginRuntime): PluginApplyContext {
  return {
    runtime,
    pluginId: record.id,
    pluginDir: pluginCurrentDir(record.id),
    packageName: record.packageName,
    version: record.version,
    manifest: record.manifest,
  };
}

function baseApi(record: InstalledPluginRecord, runtime: PluginRuntime): Record<string, unknown> {
  const pluginDir = pluginCurrentDir(record.id);
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
    if (!hasRuntimeHook(record, 'cli')) continue;
    const apply = await importPluginApply(record);
    if (!apply) continue;
    const api = {
      ...baseApi(record, 'cli'),
      cli: {
        registerCommand(command: PluginCliCommand): () => void {
          if (!command?.name || !/^[a-z][a-z0-9._:-]{0,63}$/.test(command.name)) {
            throw new Error(`invalid_plugin_cli_command:${record.id}`);
          }
          const registered: RegisteredPluginCommand = { ...command, pluginId: record.id };
          commands.push(registered);
          return () => {
            const idx = commands.indexOf(registered);
            if (idx >= 0) commands.splice(idx, 1);
          };
        },
      },
    };
    await apply(api, baseContext(record, 'cli'));
  }
  return commands;
}

export async function resolvePluginMcpServers(input: ResolvePluginMcpInput): Promise<ResolvedPluginMcpServer[]> {
  const out = resolveStaticPluginMcpServers(input);
  const seen = new Map<string, string>();
  for (const server of out) seen.set(server.name, server.pluginId);

  const taps: WorkerMcpTap[] = [];
  for (const record of orderedPluginRecords(input.pluginIds)) {
    if (!hasRuntimeHook(record, 'worker')) continue;
    const apply = await importPluginApply(record);
    if (!apply) continue;
    const api = {
      ...baseApi(record, 'worker'),
      worker: {
        configureMcp: {
          tap(name: string, handler: WorkerMcpTap['handler']): () => void {
            if (!name || typeof handler !== 'function') throw new Error(`invalid_plugin_mcp_tap:${record.id}`);
            const tap: WorkerMcpTap = { pluginId: record.id, name, handler };
            taps.push(tap);
            return () => {
              const idx = taps.indexOf(tap);
              if (idx >= 0) taps.splice(idx, 1);
            };
          },
        },
      },
    };
    await apply(api, baseContext(record, 'worker'));
  }

  for (const tap of taps) {
    const addMcpServer = (name: string, server: Omit<DynamicMcpServer, 'name'>) => {
      if (!name || seen.has(name)) {
        const previous = seen.get(name);
        throw new Error(`plugin_mcp_name_conflict:${name}:${previous ?? 'dynamic'}:${tap.pluginId}`);
      }
      if (!Array.isArray(server.command) || server.command.length === 0) {
        throw new Error(`plugin_dynamic_mcp_missing_command:${tap.pluginId}:${name}`);
      }
      seen.set(name, tap.pluginId);
      out.push({
        pluginId: tap.pluginId,
        name,
        transport: server.transport ?? 'stdio',
        command: server.command,
        ...(server.env ? { env: server.env } : {}),
        cwd: pluginCurrentDir(tap.pluginId),
      });
    };
    await tap.handler({
      botId: input.botId,
      sessionId: input.sessionId,
      pluginIds: input.pluginIds,
      addMcpServer,
    });
  }

  return out;
}
