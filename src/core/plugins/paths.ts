import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { assertValidPluginId } from './ids.js';

export function botmuxHome(): string {
  return join(homedir(), '.botmux');
}

export function pluginRegistryPath(): string {
  return join(botmuxHome(), 'plugins-registry.json');
}

export function pluginsHome(): string {
  return join(botmuxHome(), 'plugins');
}

export function pluginHome(pluginId: string): string {
  return join(pluginsHome(), assertValidPluginId(pluginId));
}

export function pluginVersionsDir(pluginId: string): string {
  return join(pluginHome(pluginId), 'versions');
}

export function pluginVersionDir(pluginId: string, version: string): string {
  return join(pluginVersionsDir(pluginId), version);
}

export function pluginCurrentDir(pluginId: string): string {
  return join(pluginHome(pluginId), 'current');
}

export function pluginConfigPath(pluginId: string): string {
  return join(pluginHome(pluginId), 'config.json');
}

export function pluginSettingsPath(pluginId: string): string {
  return join(pluginHome(pluginId), 'settings.json');
}

export function pluginServiceStatePath(pluginId: string, serviceName: string): string {
  return join(pluginHome(pluginId), 'services', `${serviceName}.json`);
}

export function ensurePluginHome(pluginId: string): string {
  const dir = pluginHome(pluginId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensurePluginRegistryDir(): void {
  mkdirSync(dirname(pluginRegistryPath()), { recursive: true });
}

export function assertSafePluginRelativePath(path: string, field = 'path'): string {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`invalid_plugin_${field}`);
  const trimmed = path.trim();
  if (isAbsolute(trimmed)) throw new Error(`plugin_${field}_must_be_relative`);
  const normalized = normalize(trimmed);
  if (normalized === '.' || normalized === '..') throw new Error(`plugin_${field}_escapes_root`);
  if (normalized.split(/[\\/]+/).some(part => part === '..')) throw new Error(`plugin_${field}_escapes_root`);
  return normalized;
}

export function resolvePluginPath(rootDir: string, relativePath: string, field = 'path'): string {
  const safe = assertSafePluginRelativePath(relativePath, field);
  const root = existsSync(rootDir) ? realpathSync(rootDir) : resolve(rootDir);
  const target = resolve(root, safe);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`plugin_${field}_escapes_root`);
  return target;
}
