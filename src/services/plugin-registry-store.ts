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

function parsePluginRegistryText(text: string): PluginRegistryFile {
  try {
    const parsed = JSON.parse(text);
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

function parsePluginRegistry(): PluginRegistryFile {
  const file = pluginRegistryPath();
  if (!existsSync(file)) return { schemaVersion: 1, plugins: {} };
  try {
    return parsePluginRegistryText(readFileSync(file, 'utf-8'));
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

/** The lock could not be CREATED because this process has no write authority
 *  over `~/.botmux` — the sandboxed-bot case: its fs policy exposes
 *  `plugins-registry.json` read-only, so `open('<registry>.lock', 'wx')` (or the
 *  `ensurePluginRegistryDir` mkdir before it) fails outright. Deliberately does
 *  NOT include EEXIST (another holder — `withFileLockSync` waits that out) or
 *  `FILE_LOCK_TIMEOUT` (busy): both keep their current behaviour, because both
 *  mean a writer exists and retrying is the right answer. */
function isUnwritableLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

/** Read for a caller that cannot take the lock. Two deliberate differences from
 *  `readPluginRegistryUnlocked()`:
 *
 *  - It does NOT run the lazy legacy migration. That migration WRITES (moves an
 *    inline MCP descriptor into the plugin's private file and rewrites the
 *    registry), which is exactly what this caller has no authority to do. Legacy
 *    records are projected to their public shape instead — a reader that cannot
 *    perform the migration must not be handed the `command`/`env`/`url`/`headers`
 *    fields the migration exists to move OUT of the registry. Validation stays
 *    identical to the migrating path, so an invalid record still throws rather
 *    than being served in a shape no consumer expects.
 *  - It does NOT reuse `parsePluginRegistry`'s `existsSync` probe, which returns
 *    false for an UNREADABLE file too: that would report a denied registry as
 *    "no plugins installed" — byte-identical to a clean host, and silence is the
 *    worst answer for a bot asking which plugins it is running. Only ENOENT is
 *    empty; every other read failure propagates. */
function readPluginRegistryReadOnly(): PluginRegistryFile {
  let text: string;
  try {
    text = readFileSync(pluginRegistryPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, plugins: {} };
    throw error;
  }
  const registry = parsePluginRegistryText(text);
  for (const record of Object.values(registry.plugins)) {
    const mcp = (record.contributions as { mcp?: unknown } | undefined)?.mcp;
    if (mcp === undefined) continue;
    if (isPluginMcpServer(mcp)) {
      if (mcp.name !== record.id) throw new Error(`invalid_legacy_plugin_mcp_descriptor:${record.id}`);
      record.contributions = { ...record.contributions, mcp: publicPluginMcpContribution(mcp) };
      continue;
    }
    if (!isPluginMcpContribution(mcp) || hasPrivateMcpFields(mcp)) {
      throw new Error(`invalid_plugin_mcp_contribution:${record.id}`);
    }
  }
  return registry;
}

/** The lock was created fine, but the LAZY MIGRATION inside it could not write.
 *  This is the Linux/bwrap shape: `~/.botmux` is a fresh tmpfs (the ro-bind of the
 *  registry auto-creates its parent), so `open(lock,'wx')` SUCCEEDS and the
 *  migrating path runs — then `atomicWriteFileSync`'s rename onto the read-only
 *  bind fails with EBUSY. Same for a private descriptor write under a read-only
 *  plugin dir (EACCES/EPERM). Without this, a sandboxed bot with a legacy registry
 *  gets an EBUSY instead of an answer.
 *
 *  `migrateLegacyPluginMcpDescriptors` re-wraps everything it catches, so the errno
 *  is on `.cause`, NOT on the top level — checking `error.code` here would match
 *  nothing. Requiring `cause.code` is also exactly what separates "we cannot write"
 *  from "this record is invalid": `invalid_plugin_mcp_contribution` /
 *  `invalid_legacy_plugin_mcp_descriptor` arrive wrapped in the same prefix but
 *  carry no errno, so they keep propagating — swallowing those would destroy the
 *  one check that stops private descriptor fields reaching a caller. */
function isUnwritableMigrationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!error.message.startsWith('plugin_mcp_registry_migration_failed:')) return false;
  const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

export function readPluginRegistry(): PluginRegistryFile {
  try {
    return withFileLockSync(registryLockTarget(), () => readPluginRegistryUnlocked(), { maxWaitMs: 30_000 });
  } catch (error) {
    // A reader with no write authority degrades to the non-migrating read above —
    // whether it was the LOCK it could not create (seatbelt: `~/.botmux` denied)
    // or the MIGRATION it could not write (bwrap: lock fine, registry read-only).
    // Writers (`writePluginRegistry` / `upsertInstalledPlugin` /
    // `removeInstalledPlugin`) deliberately keep throwing: they genuinely cannot
    // do their job here, and a silent no-op write is far worse than an EPERM.
    if (!isUnwritableLockError(error) && !isUnwritableMigrationError(error)) throw error;
    return readPluginRegistryReadOnly();
  }
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
