import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
import { upsertInstalledPlugin } from '../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

export interface InstallPluginOptions {
  source?: 'auto' | 'npm' | 'local';
  link?: boolean;
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

function replacePluginRuntime(pluginId: string, stagedDir: string): string {
  const targetDir = pluginRuntimeDir(pluginId);
  const backupDir = join(pluginHome(pluginId), `.dist-previous-${process.pid}-${Date.now()}`);
  rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(targetDir)) renameSync(targetDir, backupDir);
  try {
    renameSync(stagedDir, targetDir);
  } catch (err) {
    if (existsSync(backupDir)) renameSync(backupDir, targetDir);
    throw err;
  }
  rmSync(backupDir, { recursive: true, force: true });
  return targetDir;
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

function makeRecord(pkg: PluginPackageManifest, source: InstalledPluginRecord['source'], runtimeDir: string): InstalledPluginRecord {
  const now = new Date().toISOString();
  const contributions = scanPluginContributions(runtimeDir, pkg.botmux);
  return {
    id: pkg.botmux.id,
    packageName: pkg.name,
    version: pkg.version,
    source,
    manifest: pkg.botmux,
    ...(contributions ? { contributions } : {}),
    installedAt: now,
    updatedAt: now,
  };
}

export function installLocalPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const sourceDir = resolveLocalSpec(spec);
  const pkg = readPackageManifest(sourceDir);
  const sourceRuntimeDir = requireRuntimeDir(sourceDir);
  const stagedRecord = makeRecord(pkg, { type: 'local', spec: sourceDir }, sourceRuntimeDir);
  const stagedDir = stageRuntime(pkg.botmux.id, sourceRuntimeDir, opts.link === true);
  let runtimeDir: string;
  try {
    ensurePluginStateFiles(pkg.botmux.id);
    runtimeDir = replacePluginRuntime(pkg.botmux.id, stagedDir);
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }
  const record = upsertInstalledPlugin(stagedRecord);
  return { record, runtimeDir };
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

export function installNpmPlugin(spec: string): InstallPluginResult {
  mkdirSync(pluginsHome(), { recursive: true });
  const tmpRoot = join(pluginsHome(), `.install-${process.pid}-${Date.now()}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  try {
    execFileSync('npm', ['install', '--omit=dev', '--omit=peer', '--prefix', tmpRoot, spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      timeout: 120_000,
    });
    const tmpPackageDir = findBotmuxPackageUnderNodeModules(tmpRoot);
    const pkg = readPackageManifest(tmpPackageDir);
    const tmpRuntimeDir = requireRuntimeDir(tmpPackageDir);
    const stagedRecord = makeRecord(pkg, { type: 'npm', spec }, tmpRuntimeDir);
    const stagedDir = stageRuntime(pkg.botmux.id, tmpRuntimeDir, false);
    let runtimeDir: string;
    try {
      ensurePluginStateFiles(pkg.botmux.id);
      runtimeDir = replacePluginRuntime(pkg.botmux.id, stagedDir);
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
    }
    const record = upsertInstalledPlugin(stagedRecord);
    return { record, runtimeDir };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function installPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const source = opts.source ?? 'auto';
  if (source === 'local' || (source === 'auto' && isLocalSpec(spec))) return installLocalPlugin(spec, opts);
  return installNpmPlugin(spec);
}

export function installedPluginRuntimeDir(pluginId: string): string {
  return pluginRuntimeDir(pluginId);
}
