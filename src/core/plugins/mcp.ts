import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { pluginConfigPath, pluginCurrentDir, pluginSettingsPath } from './paths.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import type { PluginMcpServer, PluginSettingsFile } from './types.js';

export interface ResolvedPluginMcpServer {
  pluginId: string;
  name: string;
  transport: 'stdio';
  command: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface ResolvePluginMcpInput {
  pluginIds: readonly string[];
  botId: string;
  sessionId: string;
}

function readPluginSettings(pluginId: string): PluginSettingsFile {
  const path = pluginSettingsPath(pluginId);
  if (!existsSync(path)) return { schemaVersion: 1, defaults: {}, bots: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const defaults = parsed?.defaults && typeof parsed.defaults === 'object' && !Array.isArray(parsed.defaults)
      ? parsed.defaults as Record<string, unknown>
      : {};
    const bots = parsed?.bots && typeof parsed.bots === 'object' && !Array.isArray(parsed.bots)
      ? parsed.bots as Record<string, Record<string, unknown>>
      : {};
    return { schemaVersion: 1, defaults, bots };
  } catch {
    return { schemaVersion: 1, defaults: {}, bots: {} };
  }
}

function readPluginConfig(pluginId: string): Record<string, unknown> {
  const path = pluginConfigPath(pluginId);
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

function effectiveSettings(pluginId: string, botId: string): Record<string, unknown> {
  const settings = readPluginSettings(pluginId);
  return { ...settings.defaults, ...(settings.bots[botId] ?? {}) };
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function interpolate(value: string, ctx: { sessionId: string; botId: string; settings: Record<string, unknown>; config: Record<string, unknown> }): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const key = expr.trim();
    if (key === 'sessionId') return ctx.sessionId;
    if (key === 'botId') return ctx.botId;
    if (key.startsWith('plugin.settings.')) {
      const raw = getPath(ctx.settings, key.slice('plugin.settings.'.length));
      return raw === undefined || raw === null ? '' : String(raw);
    }
    if (key.startsWith('plugin.config.')) {
      const raw = getPath(ctx.config, key.slice('plugin.config.'.length));
      return raw === undefined || raw === null ? '' : String(raw);
    }
    return '';
  });
}

function resolveOne(pluginId: string, server: PluginMcpServer, botId: string, sessionId: string): ResolvedPluginMcpServer {
  const settings = effectiveSettings(pluginId, botId);
  const config = readPluginConfig(pluginId);
  const ctx = { sessionId, botId, settings, config };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env ?? {})) env[key] = interpolate(value, ctx);
  return {
    pluginId,
    name: server.name,
    transport: server.transport ?? 'stdio',
    command: server.command.map(part => interpolate(part, ctx)),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    cwd: pluginCurrentDir(pluginId),
  };
}

export function resolveStaticPluginMcpServers(input: ResolvePluginMcpInput): ResolvedPluginMcpServer[] {
  const registry = readPluginRegistry();
  const out: ResolvedPluginMcpServer[] = [];
  const seen = new Map<string, string>();
  for (const pluginId of input.pluginIds) {
    const record = registry.plugins[pluginId];
    if (!record?.manifest.mcp?.length) continue;
    for (const server of record.manifest.mcp) {
      const previous = seen.get(server.name);
      if (previous) throw new Error(`plugin_mcp_name_conflict:${server.name}:${previous}:${pluginId}`);
      seen.set(server.name, pluginId);
      out.push(resolveOne(pluginId, server, input.botId, input.sessionId));
    }
  }
  return out;
}

export function pluginMcpConfigPath(sessionId: string): string {
  return join(homedir(), '.botmux', 'data', 'plugin-mcp', `${sessionId}.json`);
}

export function writePluginMcpConfig(sessionId: string, servers: readonly ResolvedPluginMcpServer[]): string | undefined {
  if (servers.length === 0) return undefined;
  const path = pluginMcpConfigPath(sessionId);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command[0],
      args: server.command.slice(1),
      cwd: server.cwd,
      ...(server.env ? { env: server.env } : {}),
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 });
  return path;
}
