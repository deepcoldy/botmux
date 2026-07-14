import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafePluginRelativePath, resolvePluginPath } from './paths.js';
import { loadSkillPackage } from '../skills/package.js';
import type {
  BotmuxPluginManifest,
  PluginCliCommandIndexEntry,
  PluginContributions,
  PluginMcpServer,
  PluginServiceMode,
} from './types.js';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${field}`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readCommand(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`invalid_${field}`);
  const command = raw.map(part => typeof part === 'string' ? part.trim() : '').filter(Boolean);
  if (command.length !== raw.length || command.length === 0) throw new Error(`invalid_${field}`);
  return command.map((part) => {
    if (part.startsWith('./')) {
      const normalized = assertSafePluginRelativePath(part, field).replace(/\\/g, '/');
      return `./${normalized}`;
    }
    if (/^\.\.[\\/]/.test(part)) assertSafePluginRelativePath(part, field);
    return part;
  });
}

function readEnv(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const record = optionalRecord(raw, field);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid_plugin_env_key:${key}`);
    if (typeof value !== 'string') throw new Error(`invalid_plugin_env_value:${key}`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readHeaders(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const record = optionalRecord(raw, field);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error(`invalid_plugin_mcp_header:${key}`);
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`invalid_plugin_mcp_header_value:${key}`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readMcpServer(raw: unknown, source: string, runtimeDir: string, name: string): PluginMcpServer {
  const record = optionalRecord(raw, `mcp_${source}`);
  const transport = record.transport === undefined ? 'stdio' : record.transport;
  if (transport === 'streamable-http') {
    const url = optionalString(record.url);
    if (!url) throw new Error(`invalid_plugin_mcp_url:${name}`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`invalid_plugin_mcp_url:${name}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`invalid_plugin_mcp_url_protocol:${name}`);
    }
    const headers = readHeaders(record.headers, `mcp_headers_${name}`);
    return { name, transport, url: parsed.toString(), ...(headers ? { headers } : {}) };
  }
  if (transport !== 'stdio') throw new Error(`invalid_plugin_mcp_transport:${name}`);
  const command = readCommand(record.command, `mcp_command_${name}`);
  const env = readEnv(record.env, `mcp_env_${name}`);
  const templated = [...command, ...Object.values(env ?? {})].find(value => /\$\{[^}]+\}/.test(value));
  if (templated) throw new Error(`unsupported_plugin_mcp_runtime_template:${name}`);
  for (const part of command) {
    if (!part.startsWith('./')) continue;
    const target = resolvePluginPath(runtimeDir, part, `mcp_command_${name}`);
    if (!existsSync(target)) throw new Error(`plugin_mcp_command_path_not_found:${name}:${part}`);
  }
  return { name, transport, command, ...(env ? { env } : {}) };
}

function readCliCommands(raw: unknown): PluginCliCommandIndexEntry[] {
  const record = optionalRecord(raw, 'cli_commands');
  if (record.schemaVersion !== 1) throw new Error('invalid_plugin_cli_commands_schema');
  if (!Array.isArray(record.commands)) throw new Error('invalid_plugin_cli_commands');
  const commands: PluginCliCommandIndexEntry[] = [];
  const seen = new Set<string>();
  for (const rawCommand of record.commands) {
    const command = optionalRecord(rawCommand, 'cli_command');
    const name = optionalString(command.name);
    if (!name || !/^[a-z][a-z0-9._:-]{0,63}$/.test(name)) throw new Error('invalid_plugin_cli_command_name');
    if (seen.has(name)) throw new Error(`duplicate_plugin_cli_command:${name}`);
    seen.add(name);
    const description = optionalString(command.description);
    commands.push({ name, ...(description ? { description } : {}) });
  }
  return commands;
}

function scanSkills(runtimeDir: string, pluginId: string): PluginContributions['skills'] {
  const root = join(runtimeDir, 'skills');
  if (!isDirectory(root)) return undefined;
  const skills = readdirSync(root)
    .filter(name => isDirectory(join(root, name)) && isFile(join(root, name, 'SKILL.md')))
    .sort()
    .map((name) => {
      const path = `skills/${name}`;
      const skill = loadSkillPackage(join(runtimeDir, path), {
        source: { type: 'plugin', pluginId, root: runtimeDir },
      });
      return { name: skill.name, path };
    });
  return skills.length > 0 ? skills : undefined;
}

function scanMcp(runtimeDir: string, pluginId: string): PluginContributions['mcp'] {
  const rel = 'mcp/index.json';
  if (!isFile(join(runtimeDir, rel))) return undefined;
  const file = resolvePluginPath(runtimeDir, rel, 'mcp_entry');
  return readMcpServer(JSON.parse(readFileSync(file, 'utf-8')), rel, runtimeDir, pluginId);
}

function scanDashboard(runtimeDir: string, pluginId: string): PluginContributions['dashboard'] {
  const entry = 'dashboard/index.js';
  if (!isFile(join(runtimeDir, entry))) return undefined;
  return [{ id: pluginId, route: `#/plugins/${pluginId}`, entry }];
}

function scanCli(runtimeDir: string): PluginContributions['cli'] {
  const entry = 'cli/index.js';
  const commandsPath = 'cli/commands.json';
  const hasEntry = isFile(join(runtimeDir, entry));
  const hasCommands = isFile(join(runtimeDir, commandsPath));
  if (!hasEntry && !hasCommands) return undefined;
  if (!hasEntry) throw new Error('plugin_cli_entry_not_found');
  if (!hasCommands) throw new Error('plugin_cli_commands_not_found');
  const commands = readCliCommands(JSON.parse(readFileSync(join(runtimeDir, commandsPath), 'utf-8')));
  return { entry, commandsPath, commands };
}

function scanService(runtimeDir: string, mode: PluginServiceMode | undefined): PluginContributions['service'] {
  const entry = 'service/index.js';
  const exists = isFile(join(runtimeDir, entry));
  if (!exists && !mode) return undefined;
  if (exists && !mode) throw new Error('plugin_service_missing_manifest');
  if (!exists && mode) throw new Error('plugin_service_entry_not_found');
  return { entry, mode: mode! };
}

export function scanPluginContributions(runtimeDir: string, manifest: BotmuxPluginManifest): PluginContributions | undefined {
  const skills = scanSkills(runtimeDir, manifest.id);
  const mcp = scanMcp(runtimeDir, manifest.id);
  const dashboard = scanDashboard(runtimeDir, manifest.id);
  const cli = scanCli(runtimeDir);
  const service = scanService(runtimeDir, manifest.service?.mode);
  const contributions: PluginContributions = {
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(cli ? { cli } : {}),
    ...(service ? { service } : {}),
  };
  return Object.keys(contributions).length > 0 ? contributions : undefined;
}

export function contributionSkills(contributions: PluginContributions | undefined): string[] {
  return contributions?.skills?.map(entry => entry.path) ?? [];
}
