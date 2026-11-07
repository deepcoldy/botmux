import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePluginPackageManifest } from './manifest.js';
import { scanPluginContributions } from './convention-scanner.js';
import {
  ensurePluginHome,
  pluginHome,
  pluginRuntimeDir,
  pluginsHome,
  pluginSettingsPath,
  pluginConfigPath,
} from './paths.js';
import type { InstalledPluginRecord, PluginPackageManifest, PluginSettingsFile } from './types.js';
import { isPluginRegistryCompleteForCleanup, readPluginRegistry, upsertInstalledPlugin } from '../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { assertPluginServiceStopped, withPluginServiceLockSync } from './service-manager.js';
import {
  capturePluginMcpPrivateSnapshot,
  publicPluginMcpContribution,
  removePluginMcpDescriptor,
  restorePluginMcpPrivateSnapshot,
  writePluginMcpDescriptor,
} from './mcp/private-store.js';
import type { PluginMcpServer } from './types.js';
import { createHash } from 'node:crypto';
import { assertPluginMutationGuard, type PluginMutationGuard } from './mutation-guard.js';

export interface InstallPluginOptions {
  source?: 'auto' | 'npm' | 'local';
  link?: boolean;
  guard?: PluginMutationGuard;
}

export interface InstallPluginResult {
  record: InstalledPluginRecord;
  runtimeDir: string;
}

function readPackageManifest(packageDir: string): PluginPackageManifest {
  const file = join(packageDir, 'package.json');
  if (!existsSync(file)) throw new Error(`plugin_package_json_not_found:${packageDir}`);
  return parsePluginPackageManifest(JSON.parse(readFileSync(file, 'utf-8')));
}

function ensurePluginStateFiles(pluginId: string): void {
  ensurePluginHome(pluginId);
  if (!existsSync(pluginConfigPath(pluginId))) {
    atomicWriteFileSync(pluginConfigPath(pluginId), JSON.stringify({}, null, 2) + '\n', { mode: 0o600 });
  }
  if (!existsSync(pluginSettingsPath(pluginId))) {
    const settings: PluginSettingsFile = { schemaVersion: 1, defaults: {}, bots: {} };
    atomicWriteFileSync(pluginSettingsPath(pluginId), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  }
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec) || existsSync(resolve(spec));
}

function resolveLocalSpec(spec: string): string {
  if (spec.startsWith('~/')) return join(process.env.HOME ?? '', spec.slice(2));
  return resolve(spec);
}

function requireRuntimeDir(packageDir: string): string {
  const runtimeDir = join(packageDir, 'dist');
  if (!existsSync(runtimeDir)) throw new Error(`plugin_dist_not_found:${packageDir}`);
  if (!statSync(runtimeDir).isDirectory()) throw new Error(`plugin_dist_not_directory:${packageDir}`);
  return runtimeDir;
}

function copyRuntime(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

interface PluginRuntimeReplacement {
  runtimeDir: string;
  commit(): void;
  rollback(): void;
}

function replacePluginRuntime(pluginId: string, stagedDir: string): PluginRuntimeReplacement {
  const targetDir = pluginRuntimeDir(pluginId);
  const backupDir = join(pluginHome(pluginId), `.dist-previous-${process.pid}-${Date.now()}`);
  rmSync(backupDir, { recursive: true, force: true });
  const hadPrevious = existsSync(targetDir);
  if (hadPrevious) renameSync(targetDir, backupDir);
  try {
    renameSync(stagedDir, targetDir);
  } catch (err) {
    if (hadPrevious && existsSync(backupDir)) renameSync(backupDir, targetDir);
    throw err;
  }
  return {
    runtimeDir: targetDir,
    commit() {
      try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* stale backup is recoverable */ }
    },
    rollback() {
      rmSync(targetDir, { recursive: true, force: true });
      if (hadPrevious && existsSync(backupDir)) renameSync(backupDir, targetDir);
    },
  };
}

function stageRuntime(pluginId: string, sourceDir: string, link: boolean): string {
  mkdirSync(pluginsHome(), { recursive: true });
  const stagedDir = join(pluginsHome(), `.${pluginId}-dist-next-${process.pid}-${Date.now()}`);
  rmSync(stagedDir, { recursive: true, force: true });
  if (link) {
    symlinkSync(sourceDir, stagedDir, 'dir');
  } else {
    copyRuntime(sourceDir, stagedDir);
  }
  return stagedDir;
}

interface StagedPluginRecord {
  record: InstalledPluginRecord;
  mcpServer?: PluginMcpServer;
}

function makeRecord(
  pkg: PluginPackageManifest,
  source: InstalledPluginRecord['source'],
  runtimeDir: string,
): StagedPluginRecord {
  const now = new Date().toISOString();
  const scanned = scanPluginContributions(runtimeDir, pkg.botmux);
  const { mcp: mcpServer, ...publicContributions } = scanned ?? {};
  const contributions = scanned ? {
    ...publicContributions,
    ...(mcpServer ? { mcp: publicPluginMcpContribution(mcpServer) } : {}),
  } : undefined;
  return {
    record: {
      id: pkg.botmux.id,
      packageName: pkg.name,
      version: pkg.version,
      ...(pkg.description ? { description: pkg.description } : {}),
      source,
      manifest: pkg.botmux,
      ...(contributions ? { contributions } : {}),
      installedAt: now,
      updatedAt: now,
    },
    ...(mcpServer ? { mcpServer } : {}),
  };
}

function commitPluginInstall(staged: StagedPluginRecord, stagedDir: string): InstallPluginResult {
  const pluginId = staged.record.id;
  const privateSnapshot = capturePluginMcpPrivateSnapshot(pluginId);
  const replacement = replacePluginRuntime(pluginId, stagedDir);
  try {
    if (staged.mcpServer) writePluginMcpDescriptor(pluginId, staged.mcpServer);
    else removePluginMcpDescriptor(pluginId);
    const record = upsertInstalledPlugin(staged.record);
    replacement.commit();
    return { record, runtimeDir: replacement.runtimeDir };
  } catch (error) {
    try { restorePluginMcpPrivateSnapshot(pluginId, privateSnapshot); } catch { /* preserve the original error */ }
    try { replacement.rollback(); } catch { /* preserve the original error */ }
    throw error;
  }
}

function assertExistingPluginServiceStopped(pluginId: string): void {
  const existing = readPluginRegistry().plugins[pluginId];
  if (existing?.manifest.service) assertPluginServiceStopped(pluginId, 'update');
}

function runtimeHasSymlinks(root: string): boolean {
  if (lstatSync(root).isSymbolicLink()) return true;
  const pending = [root];
  let inspected = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++inspected > 10_000) throw new Error('plugin_retired_scan_limit');
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) pending.push(join(dir, entry.name));
    }
  }
  return false;
}

/** Called only under the lifecycle lock, after confirmation and before creating the new home. */
function cleanupRetiredPluginHomes(pluginId: string, stagedDir: string, sourceDir?: string): void {
  try {
    if (!isPluginRegistryCompleteForCleanup()) return;
    const registry = readPluginRegistry();
    // A failed registry commit may still need the retired home for recovery.
    if (registry.plugins[pluginId]) return;
    const root = realpathSync(pluginsHome());
    const prefix = `${pluginId}.removed-`;
    const candidates = readdirSync(root, { withFileTypes: true }).filter(entry =>
      entry.isDirectory() && entry.name.startsWith(prefix)
      && /^\d+-\d+$/.test(entry.name.slice(prefix.length)) && !registry.plugins[entry.name]);
    if (candidates.length === 0 || runtimeHasSymlinks(stagedDir)) return;
    const sourcePaths = sourceDir ? [sourceDir, join(sourceDir, 'dist')] : [];
    for (const record of Object.values(registry.plugins)) {
      // Copy mode preserves interior symlinks too; do not break another runtime's dependencies.
      if (runtimeHasSymlinks(pluginRuntimeDir(record.id))) return;
      if (record.source?.type === 'local') {
        // Linked runtimes can depend on intermediate symlinks, not only their realpath.
        if (record.source.link) return;
        sourcePaths.push(record.source.spec, join(record.source.spec, 'dist'));
      } else if (record.source?.type !== 'npm') return;
    }
    const sources = sourcePaths.map(path => realpathSync(path));
    for (const entry of candidates) {
      const retired = join(root, entry.name);
      if (sources.some(source => {
        const rel = relative(retired, source);
        return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      })) continue;
      try { rmSync(retired, { recursive: true, force: true }); }
      catch { console.warn(`plugin_retired_cleanup_failed:${entry.name}`); }
    }
  } catch (error) {
    // Garbage collection must not prevent a valid reinstall.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`plugin_retired_cleanup_failed:${pluginId}`);
  }
}

export function installLocalPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const sourceDir = resolveLocalSpec(spec);
  const pkg = readPackageManifest(sourceDir);
  const sourceRuntimeDir = requireRuntimeDir(sourceDir);
  const linked = opts.link === true;
  const stagedRecord = makeRecord(pkg, {
    type: 'local',
    spec: sourceDir,
    ...(linked ? { link: true } : {}),
  }, sourceRuntimeDir);
  const stagedDir = stageRuntime(pkg.botmux.id, sourceRuntimeDir, linked);
  try {
    return withPluginServiceLockSync(() => {
      const cleanupAllowed = isPluginRegistryCompleteForCleanup();
      if (opts.guard) assertPluginMutationGuard(opts.guard, readPluginRegistry().plugins[opts.guard.id], stagedRecord.record);
      assertExistingPluginServiceStopped(pkg.botmux.id);
      if (!linked && cleanupAllowed) cleanupRetiredPluginHomes(pkg.botmux.id, stagedDir, sourceDir);
      // Recursive cleanup may take long enough for an operator to revoke confirmation.
      if (opts.guard) assertPluginMutationGuard(opts.guard, readPluginRegistry().plugins[opts.guard.id], stagedRecord.record);
      ensurePluginStateFiles(pkg.botmux.id);
      return commitPluginInstall(stagedRecord, stagedDir);
    });
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }
}

function findBotmuxPackageUnderNodeModules(root: string): string {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error('npm_install_missing_node_modules');
  const candidates: string[] = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModules, entry);
      for (const scoped of readdirSync(scopeDir)) candidates.push(join(scopeDir, scoped));
    } else {
      candidates.push(join(nodeModules, entry));
    }
  }
  const botmuxPackages = candidates.filter((dir) => {
    try {
      readPackageManifest(dir);
      return true;
    } catch {
      return false;
    }
  });
  if (botmuxPackages.length !== 1) throw new Error(`npm_install_expected_one_botmux_plugin_found_${botmuxPackages.length}`);
  return botmuxPackages[0];
}

export function installNpmPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  mkdirSync(pluginsHome(), { recursive: true });
  const tmpRoot = join(pluginsHome(), `.install-${process.pid}-${Date.now()}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  try {
    if (opts.guard?.integrity) {
      if (!spec.startsWith('file:')) throw new Error('plugin_confirmed_archive_required');
      const actual = `sha512-${createHash('sha512').update(readFileSync(spec.slice(5))).digest('base64')}`;
      if (actual !== opts.guard.integrity) throw new Error('plugin_confirmed_archive_mismatch');
    }
    execFileSync('npm', ['install', '--omit=dev', '--omit=peer', ...(opts.guard ? ['--ignore-scripts'] : []), '--prefix', tmpRoot, spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      timeout: 120_000,
    });
    const tmpPackageDir = findBotmuxPackageUnderNodeModules(tmpRoot);
    const pkg = readPackageManifest(tmpPackageDir);
    const tmpRuntimeDir = requireRuntimeDir(tmpPackageDir);
    const confirmedIntegrity = opts.guard?.integrity;
    // The confirmed archive is a temporary download that is deleted after install.
    const recordedSpec = confirmedIntegrity ? `${pkg.name}@${pkg.version}` : spec;
    const stagedRecord = makeRecord(pkg, { type: 'npm', spec: recordedSpec }, tmpRuntimeDir);
    if (confirmedIntegrity) stagedRecord.record.integrity = confirmedIntegrity;
    const stagedDir = stageRuntime(pkg.botmux.id, tmpRuntimeDir, false);
    try {
      return withPluginServiceLockSync(() => {
        const cleanupAllowed = isPluginRegistryCompleteForCleanup();
        if (opts.guard) assertPluginMutationGuard(opts.guard, readPluginRegistry().plugins[opts.guard.id], stagedRecord.record);
        assertExistingPluginServiceStopped(pkg.botmux.id);
        if (cleanupAllowed) cleanupRetiredPluginHomes(pkg.botmux.id, stagedDir);
        if (opts.guard) assertPluginMutationGuard(opts.guard, readPluginRegistry().plugins[opts.guard.id], stagedRecord.record);
        ensurePluginStateFiles(pkg.botmux.id);
        return commitPluginInstall(stagedRecord, stagedDir);
      });
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function installPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const source = opts.source ?? 'auto';
  if (source === 'local' || (source === 'auto' && isLocalSpec(spec))) return installLocalPlugin(spec, opts);
  return installNpmPlugin(spec, opts);
}

export function installedPluginRuntimeDir(pluginId: string): string {
  return pluginRuntimeDir(pluginId);
}
