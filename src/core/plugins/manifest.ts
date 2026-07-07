import { assertValidPluginId, isValidPluginId } from './ids.js';
import { assertSafePluginRelativePath } from './paths.js';
import type {
  BotmuxPluginManifest,
  PluginDashboardEntry,
  PluginHook,
  PluginHostService,
  PluginMcpServer,
  PluginPackageManifest,
  PluginSkillEntry,
} from './types.js';

const VALID_HOOKS = new Set<PluginHook>(['cli', 'daemon', 'worker', 'dashboard', 'adapters']);
const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${field}`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`invalid_${field}`);
  const out = raw
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function readHooks(raw: unknown): PluginHook[] | undefined {
  const hooks = readStringArray(raw, 'botmux_hooks') as PluginHook[] | undefined;
  if (!hooks) return undefined;
  for (const hook of hooks) {
    if (!VALID_HOOKS.has(hook)) throw new Error(`invalid_plugin_hook:${hook}`);
  }
  return hooks;
}

function readDependencies(raw: unknown): BotmuxPluginManifest['dependencies'] {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, 'botmux_dependencies');
  const out: BotmuxPluginManifest['dependencies'] = {};
  if (record.plugins !== undefined) {
    const plugins = asRecord(record.plugins, 'botmux_dependencies_plugins');
    const deps: Record<string, string> = {};
    for (const [id, range] of Object.entries(plugins)) {
      if (!isValidPluginId(id)) throw new Error(`invalid_plugin_dependency:${id}`);
      if (typeof range !== 'string' || !range.trim()) throw new Error(`invalid_plugin_dependency_range:${id}`);
      deps[id] = range.trim();
    }
    if (Object.keys(deps).length > 0) out.plugins = deps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSkills(raw: unknown): PluginSkillEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('invalid_botmux_skills');
  const out: PluginSkillEntry[] = [];
  for (const entry of raw) {
    const record = asRecord(entry, 'botmux_skill');
    const path = optionalString(record.path);
    if (!path) throw new Error('invalid_plugin_skill_path');
    out.push({ path: assertSafePluginRelativePath(path, 'skill_path') });
  }
  return out.length > 0 ? out : undefined;
}

function readDashboard(raw: unknown): PluginDashboardEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('invalid_botmux_dashboard');
  const out: PluginDashboardEntry[] = [];
  for (const entry of raw) {
    const record = asRecord(entry, 'botmux_dashboard_entry');
    const id = optionalString(record.id);
    const route = optionalString(record.route);
    const dashboardEntry = optionalString(record.entry);
    if (!id || !isValidPluginId(id)) throw new Error('invalid_plugin_dashboard_id');
    if (!route || !route.startsWith('#/')) throw new Error(`invalid_plugin_dashboard_route:${id}`);
    if (!dashboardEntry) throw new Error(`invalid_plugin_dashboard_entry:${id}`);
    out.push({ id, route, entry: assertSafePluginRelativePath(dashboardEntry, 'dashboard_entry') });
  }
  return out.length > 0 ? out : undefined;
}

function readCommand(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`invalid_${field}`);
  const command = raw.map(part => typeof part === 'string' ? part.trim() : '').filter(Boolean);
  if (command.length !== raw.length || command.length === 0) throw new Error(`invalid_${field}`);
  return command.map(part => part.startsWith('./') || part.startsWith('../')
    ? assertSafePluginRelativePath(part, field)
    : part);
}

function readServices(raw: unknown): Record<string, PluginHostService> | undefined {
  if (raw === undefined) return undefined;
  const services = asRecord(raw, 'botmux_services');
  const out: Record<string, PluginHostService> = {};
  for (const [name, value] of Object.entries(services)) {
    if (!SAFE_KEY_RE.test(name)) throw new Error(`invalid_plugin_service_name:${name}`);
    const record = asRecord(value, 'botmux_service');
    const scope = record.scope === undefined ? 'host' : record.scope;
    const mode = record.mode === undefined ? 'external' : record.mode;
    if (scope !== 'host') throw new Error(`invalid_plugin_service_scope:${name}`);
    if (mode !== 'managed' && mode !== 'external') throw new Error(`invalid_plugin_service_mode:${name}`);
    const command = readCommand(record.command, `service_command_${name}`);
    if (mode === 'managed' && !command) throw new Error(`plugin_managed_service_missing_command:${name}`);
    const port = typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
      ? record.port
      : undefined;
    const healthUrl = optionalString(record.healthUrl);
    const openUrl = optionalString(record.openUrl);
    const description = optionalString(record.description);
    out[name] = {
      scope: 'host',
      mode,
      ...(command ? { command } : {}),
      ...(port ? { port } : {}),
      ...(healthUrl ? { healthUrl } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(description ? { description } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readEnv(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, field);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid_plugin_env_key:${key}`);
    if (typeof value !== 'string') throw new Error(`invalid_plugin_env_value:${key}`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readMcp(raw: unknown): PluginMcpServer[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('invalid_botmux_mcp');
  const out: PluginMcpServer[] = [];
  for (const entry of raw) {
    const record = asRecord(entry, 'botmux_mcp_entry');
    const name = optionalString(record.name);
    if (!name || !isValidPluginId(name)) throw new Error('invalid_plugin_mcp_name');
    const transport = record.transport === undefined ? 'stdio' : record.transport;
    if (transport !== 'stdio') throw new Error(`invalid_plugin_mcp_transport:${name}`);
    const command = readCommand(record.command, `mcp_command_${name}`);
    if (!command) throw new Error(`plugin_mcp_missing_command:${name}`);
    const env = readEnv(record.env, `mcp_env_${name}`);
    out.push({ name, transport, command, ...(env ? { env } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

export function parseBotmuxManifest(raw: unknown): BotmuxPluginManifest {
  const record = asRecord(raw, 'botmux_manifest');
  if (record.schemaVersion !== 1) throw new Error('unsupported_botmux_plugin_schema');
  const id = assertValidPluginId(record.id, 'botmux_plugin_id');
  const displayName = optionalString(record.displayName);
  const rawMain = optionalString(record.main);
  const main = rawMain ? assertSafePluginRelativePath(rawMain, 'main') : undefined;
  const hooks = readHooks(record.hooks);
  const capabilities = readStringArray(record.capabilities, 'botmux_capabilities');
  const dependencies = readDependencies(record.dependencies);
  const skills = readSkills(record.skills);
  const dashboard = readDashboard(record.dashboard);
  const services = readServices(record.services);
  const mcp = readMcp(record.mcp);
  return {
    schemaVersion: 1,
    id,
    ...(displayName ? { displayName } : {}),
    ...(main ? { main } : {}),
    ...(hooks ? { hooks } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(skills ? { skills } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(services ? { services } : {}),
    ...(mcp ? { mcp } : {}),
  };
}

export function parsePluginPackageManifest(raw: unknown): PluginPackageManifest {
  const record = asRecord(raw, 'package_json');
  const name = optionalString(record.name);
  const version = optionalString(record.version);
  if (!name) throw new Error('plugin_package_missing_name');
  if (!version) throw new Error('plugin_package_missing_version');
  const botmux = parseBotmuxManifest(record.botmux);
  const keywords = Array.isArray(record.keywords)
    ? record.keywords.filter((value): value is string => typeof value === 'string')
    : undefined;
  if (!keywords?.includes('botmux-plugin')) throw new Error('plugin_package_missing_keyword');
  return {
    name,
    version,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    keywords,
    ...(record.peerDependencies && typeof record.peerDependencies === 'object' && !Array.isArray(record.peerDependencies)
      ? { peerDependencies: record.peerDependencies as Record<string, string> }
      : {}),
    botmux,
  };
}
