import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { assertValidPluginId } from '../core/plugins/ids.js';
import { ensurePluginRegistryDir, pluginRegistryPath } from '../core/plugins/paths.js';
import type { InstalledPluginRecord, PluginRegistryFile } from '../core/plugins/types.js';
import {
  capturePluginMcpPrivateSnapshot,
  isPluginMcpContribution,
  isPluginMcpServer,
  publicPluginMcpContribution,
  restorePluginMcpPrivateSnapshot,
  writePluginMcpDescriptor,
} from '../core/plugins/mcp/private-store.js';

function registryLockTarget(): string {
  ensurePluginRegistryDir();
  return pluginRegistryPath();
}

function parsePluginRegistry(): PluginRegistryFile {
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

function hasPrivateMcpFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['command', 'env', 'url', 'headers'].some(key => Object.hasOwn(value, key));
}

function assertPublicPluginRegistry(registry: PluginRegistryFile): void {
  for (const record of Object.values(registry.plugins)) {
    const mcp = (record.contributions as { mcp?: unknown } | undefined)?.mcp;
    if (mcp === undefined) continue;
    if (!isPluginMcpContribution(mcp) || hasPrivateMcpFields(mcp)) {
      throw new Error(`invalid_public_plugin_mcp_contribution:${record.id}`);
    }
  }
}

function writePluginRegistryUnlocked(registry: PluginRegistryFile): void {
  assertPublicPluginRegistry(registry);
  mkdirSync(dirname(pluginRegistryPath()), { recursive: true });
  atomicWriteFileSync(pluginRegistryPath(), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

/** Atomically migrates legacy registry-embedded MCP descriptors into protected
 * per-plugin files. Private writes are rolled back if the public registry swap
 * fails, so readers never observe a half-migrated configuration. */
function migrateLegacyPluginMcpDescriptors(registry: PluginRegistryFile): PluginRegistryFile {
  const snapshots = new Map<string, ReturnType<typeof capturePluginMcpPrivateSnapshot>>();
  try {
    const legacy: InstalledPluginRecord[] = [];
    for (const record of Object.values(registry.plugins)) {
      const mcp = (record.contributions as { mcp?: unknown } | undefined)?.mcp;
      if (mcp === undefined) continue;
      if (isPluginMcpServer(mcp)) {
        if (mcp.name !== record.id) throw new Error(`invalid_legacy_plugin_mcp_descriptor:${record.id}`);
        legacy.push(record);
        continue;
      }
      if (!isPluginMcpContribution(mcp) || hasPrivateMcpFields(mcp)) {
        throw new Error(`invalid_plugin_mcp_contribution:${record.id}`);
      }
    }
    if (legacy.length === 0) return registry;

    for (const record of legacy) {
      const mcp = (record.contributions as unknown as { mcp: unknown }).mcp;
      if (!isPluginMcpServer(mcp)) throw new Error(`invalid_legacy_plugin_mcp_descriptor:${record.id}`);
      snapshots.set(record.id, capturePluginMcpPrivateSnapshot(record.id));
      writePluginMcpDescriptor(record.id, mcp);
      record.contributions = {
        ...record.contributions,
        mcp: publicPluginMcpContribution(mcp),
      };
    }
    writePluginRegistryUnlocked(registry);
    return registry;
  } catch (error) {
    for (const [pluginId, snapshot] of [...snapshots.entries()].reverse()) {
      try { restorePluginMcpPrivateSnapshot(pluginId, snapshot); } catch { /* preserve migration failure */ }
    }
    throw new Error(
      `plugin_mcp_registry_migration_failed:${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readPluginRegistryUnlocked(): PluginRegistryFile {
  return migrateLegacyPluginMcpDescriptors(parsePluginRegistry());
}

export function readPluginRegistry(): PluginRegistryFile {
  return withFileLockSync(registryLockTarget(), () => readPluginRegistryUnlocked(), { maxWaitMs: 30_000 });
}

export function writePluginRegistry(registry: PluginRegistryFile): void {
  withFileLockSync(registryLockTarget(), () => writePluginRegistryUnlocked(registry), { maxWaitMs: 30_000 });
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
  return withFileLockSync(registryLockTarget(), () => {
    const registry = readPluginRegistryUnlocked();
    const now = new Date().toISOString();
    const previous = registry.plugins[record.id];
    registry.plugins[record.id] = {
      ...record,
      installedAt: previous?.installedAt ?? record.installedAt ?? now,
      updatedAt: now,
    };
    writePluginRegistryUnlocked(registry);
    return registry.plugins[record.id];
  }, { maxWaitMs: 30_000 });
}

export function removeInstalledPlugin(id: string): InstalledPluginRecord | undefined {
  const pluginId = assertValidPluginId(id);
  return withFileLockSync(registryLockTarget(), () => {
    const registry = readPluginRegistryUnlocked();
    const previous = registry.plugins[pluginId];
    delete registry.plugins[pluginId];
    writePluginRegistryUnlocked(registry);
    return previous;
  }, { maxWaitMs: 30_000 });
}
