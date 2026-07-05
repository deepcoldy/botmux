import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { assertValidPluginId } from '../core/plugins/ids.js';
import { pluginRegistryPath } from '../core/plugins/paths.js';
import type { InstalledPluginRecord, PluginRegistryFile } from '../core/plugins/types.js';

export function readPluginRegistry(): PluginRegistryFile {
  const file = pluginRegistryPath();
  if (!existsSync(file)) return { schemaVersion: 1, plugins: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const rawPlugins = parsed?.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
      ? parsed.plugins as Record<string, unknown>
      : {};
    const plugins: Record<string, InstalledPluginRecord> = {};
    for (const [id, raw] of Object.entries(rawPlugins)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as InstalledPluginRecord;
      if (record.id !== id) continue;
      try { assertValidPluginId(id); } catch { continue; }
      if (!record.packageName || !record.version || !record.manifest) continue;
      plugins[id] = record;
    }
    return { schemaVersion: 1, plugins };
  } catch {
    return { schemaVersion: 1, plugins: {} };
  }
}

export function writePluginRegistry(registry: PluginRegistryFile): void {
  mkdirSync(dirname(pluginRegistryPath()), { recursive: true });
  atomicWriteFileSync(pluginRegistryPath(), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

export function listInstalledPlugins(): InstalledPluginRecord[] {
  return Object.values(readPluginRegistry().plugins).sort((a, b) => a.id.localeCompare(b.id));
}

export function getInstalledPlugin(id: string): InstalledPluginRecord | undefined {
  return readPluginRegistry().plugins[assertValidPluginId(id)];
}

export function upsertInstalledPlugin(record: InstalledPluginRecord): InstalledPluginRecord {
  assertValidPluginId(record.id);
  if (record.manifest.id !== record.id) throw new Error('plugin_manifest_id_mismatch');
  const registry = readPluginRegistry();
  const now = new Date().toISOString();
  const previous = registry.plugins[record.id];
  registry.plugins[record.id] = {
    ...record,
    installedAt: previous?.installedAt ?? record.installedAt ?? now,
    updatedAt: now,
  };
  writePluginRegistry(registry);
  return registry.plugins[record.id];
}

export function removeInstalledPlugin(id: string): InstalledPluginRecord | undefined {
  const pluginId = assertValidPluginId(id);
  const registry = readPluginRegistry();
  const previous = registry.plugins[pluginId];
  delete registry.plugins[pluginId];
  writePluginRegistry(registry);
  return previous;
}
