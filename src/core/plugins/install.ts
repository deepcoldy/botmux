import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parsePluginPackageManifest } from './manifest.js';
import {
  ensurePluginHome,
  pluginCurrentDir,
  pluginHome,
  pluginsHome,
  pluginSettingsPath,
  pluginConfigPath,
  pluginVersionDir,
  resolvePluginPath,
} from './paths.js';
import type { InstalledPluginRecord, PluginPackageManifest, PluginSettingsFile } from './types.js';
import { upsertInstalledPlugin } from '../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { installLocalSkillLinks } from '../../services/skill-registry-store.js';

export interface InstallPluginOptions {
  source?: 'auto' | 'npm' | 'local';
  link?: boolean;
}

export interface InstallPluginResult {
  record: InstalledPluginRecord;
  packageDir: string;
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

function replaceCurrentSymlink(pluginId: string, targetDir: string): void {
  const current = pluginCurrentDir(pluginId);
  rmSync(current, { recursive: true, force: true });
  symlinkSync(targetDir, current, 'dir');
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec) || existsSync(resolve(spec));
}

function resolveLocalSpec(spec: string): string {
  if (spec.startsWith('~/')) return join(process.env.HOME ?? '', spec.slice(2));
  return resolve(spec);
}

function copyLocalPackage(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = basename(src);
      return base !== 'node_modules' && base !== '.git';
    },
  });
}

function makeRecord(pkg: PluginPackageManifest, source: InstalledPluginRecord['source']): InstalledPluginRecord {
  const now = new Date().toISOString();
  return {
    id: pkg.botmux.id,
    packageName: pkg.name,
    version: pkg.version,
    source,
    manifest: pkg.botmux,
    installedAt: now,
    updatedAt: now,
  };
}

function registerStaticPluginSkills(pkg: PluginPackageManifest, packageDir: string): void {
  const dirs = (pkg.botmux.skills ?? [])
    .map(entry => resolvePluginPath(packageDir, entry.path, 'skill_path'))
    .filter(dir => existsSync(dir));
  if (dirs.length > 0) installLocalSkillLinks(dirs);
}

export function installLocalPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const sourceDir = resolveLocalSpec(spec);
  const pkg = readPackageManifest(sourceDir);
  ensurePluginStateFiles(pkg.botmux.id);
  const targetDir = join(pluginVersionDir(pkg.botmux.id, pkg.version), 'package');
  if (opts.link) {
    mkdirSync(dirname(targetDir), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    symlinkSync(sourceDir, targetDir, 'dir');
  } else {
    copyLocalPackage(sourceDir, targetDir);
  }
  replaceCurrentSymlink(pkg.botmux.id, targetDir);
  const record = upsertInstalledPlugin(makeRecord(pkg, { type: 'local', spec: sourceDir }));
  registerStaticPluginSkills(pkg, targetDir);
  return { record, packageDir: targetDir };
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
    execFileSync('npm', ['install', '--omit=dev', '--prefix', tmpRoot, spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      timeout: 120_000,
    });
    const tmpPackageDir = findBotmuxPackageUnderNodeModules(tmpRoot);
    const pkg = readPackageManifest(tmpPackageDir);
    ensurePluginStateFiles(pkg.botmux.id);
    const finalRoot = pluginVersionDir(pkg.botmux.id, pkg.version);
    rmSync(finalRoot, { recursive: true, force: true });
    mkdirSync(dirname(finalRoot), { recursive: true });
    cpSync(tmpRoot, finalRoot, { recursive: true });
    const packageDir = join(finalRoot, 'node_modules', pkg.name);
    replaceCurrentSymlink(pkg.botmux.id, packageDir);
    const record = upsertInstalledPlugin(makeRecord(pkg, { type: 'npm', spec }));
    registerStaticPluginSkills(pkg, packageDir);
    return { record, packageDir };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function installPlugin(spec: string, opts: InstallPluginOptions = {}): InstallPluginResult {
  const source = opts.source ?? 'auto';
  if (source === 'local' || (source === 'auto' && isLocalSpec(spec))) return installLocalPlugin(spec, opts);
  return installNpmPlugin(spec);
}

export function installedPluginPackageDir(pluginId: string): string {
  return pluginCurrentDir(pluginId);
}
