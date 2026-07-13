import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { resolvePluginSkillPackages } from './skills.js';
import { pluginMaterializedPath } from './paths.js';
import type { InstalledPluginRecord, PluginMaterializedFile } from './types.js';

type CliCapabilityState = 'supported' | 'adapter-required' | 'unsupported';

export const CLI_CAPABILITY_MATRIX: Record<string, { skills: CliCapabilityState; mcpGateway: CliCapabilityState }> = {
  codex: { skills: 'supported', mcpGateway: 'supported' },
  'claude-code': { skills: 'supported', mcpGateway: 'supported' },
  opencode: { skills: 'supported', mcpGateway: 'adapter-required' },
};

export function readMaterializedPlugin(pluginId: string): PluginMaterializedFile | undefined {
  const path = pluginMaterializedPath(pluginId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PluginMaterializedFile
      : undefined;
  } catch {
    return undefined;
  }
}

function writeMaterialized(value: PluginMaterializedFile): void {
  const path = pluginMaterializedPath(value.pluginId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function requireInstalledPlugin(pluginId: string): InstalledPluginRecord {
  const record = readPluginRegistry().plugins[pluginId];
  if (!record) throw new Error(`plugin_not_installed:${pluginId}`);
  return record;
}

/**
 * Validate the installed contributions and record what the enabled plugin
 * exposes. Skills and MCP remain in the plugin directory; session startup is
 * the only place that resolves and delivers them.
 */
export function materializePlugin(pluginId: string): PluginMaterializedFile {
  const record = requireInstalledPlugin(pluginId);
  const resolvedSkills = resolvePluginSkillPackages([record.id]);
  if (resolvedSkills.diagnostics.length > 0) {
    throw new Error(resolvedSkills.diagnostics.join(','));
  }

  const mcpServer = record.contributions?.mcp;
  const materialized: PluginMaterializedFile = {
    schemaVersion: 1,
    pluginId: record.id,
    updatedAt: new Date().toISOString(),
    ...(resolvedSkills.skills.length > 0
      ? { skills: resolvedSkills.skills.map(skill => ({ name: skill.name, path: skill.rootDir })) }
      : {}),
    ...(mcpServer
      ? { mcp: [{ cliId: 'botmux-gateway', name: mcpServer.name, path: 'mcp/index.json' }] }
      : {}),
    ...(record.contributions?.cli?.commands?.length
      ? { cli: record.contributions.cli.commands.map(command => ({ name: command.name })) }
      : {}),
    ...(record.contributions?.dashboard?.length
      ? { dashboard: record.contributions.dashboard.map(entry => ({ id: entry.id, entry: entry.entry })) }
      : {}),
    ...(record.contributions?.service ? { service: [{ name: record.id }] } : {}),
  };
  writeMaterialized(materialized);
  return materialized;
}

export function dematerializePlugin(pluginId: string): void {
  rmSync(pluginMaterializedPath(pluginId), { force: true });
}
