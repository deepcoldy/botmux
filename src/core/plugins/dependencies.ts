import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import type { InstalledPluginRecord, PluginRegistryFile } from './types.js';

function dependencyIds(record: InstalledPluginRecord): string[] {
  return record.manifest.dependencies?.plugins ?? [];
}

export function assertPluginBindingTransition(
  pluginId: string,
  enabled: boolean,
  enabledPluginIds: readonly string[],
  registry: PluginRegistryFile = readPluginRegistry(),
): void {
  const record = registry.plugins[pluginId];
  if (!record) throw new Error(`plugin_not_installed:${pluginId}`);
  const enabledSet = new Set(enabledPluginIds);

  if (enabled) {
    for (const dependencyId of dependencyIds(record)) {
      if (!registry.plugins[dependencyId]) {
        throw new Error(`plugin_dependency_not_installed:${pluginId}:${dependencyId}`);
      }
      if (!enabledSet.has(dependencyId)) {
        throw new Error(`plugin_dependency_not_enabled:${pluginId}:${dependencyId}`);
      }
    }
    return;
  }

  if (!enabledSet.has(pluginId)) return;
  const dependents = enabledPluginDependents(pluginId, enabledPluginIds, registry);
  if (dependents.length > 0) {
    throw new Error(`plugin_has_enabled_dependents:${pluginId}:${dependents.join(',')}`);
  }
}

export function enabledPluginDependents(
  pluginId: string,
  enabledPluginIds: readonly string[],
  registry: PluginRegistryFile = readPluginRegistry(),
): string[] {
  const enabledSet = new Set(enabledPluginIds);
  return Object.values(registry.plugins)
    .filter(record => record.id !== pluginId
      && enabledSet.has(record.id)
      && dependencyIds(record).includes(pluginId))
    .map(record => record.id)
    .sort();
}

export function describePluginDependencyError(error: unknown): string | undefined {
  const value = error instanceof Error ? error.message : String(error);
  let match = value.match(/^plugin_dependency_not_installed:([^:]+):([^:]+)$/);
  if (match) return `插件 ${match[1]} 依赖 ${match[2]}，但该依赖尚未安装。`;
  match = value.match(/^plugin_dependency_not_enabled:([^:]+):([^:]+)$/);
  if (match) return `启用 ${match[1]} 前，必须先在同一作用域启用依赖 ${match[2]}。`;
  match = value.match(/^plugin_has_enabled_dependents:([^:]+):(.+)$/);
  if (match) return `不能禁用或卸载 ${match[1]}，以下已启用插件依赖它：${match[2].split(',').join('、')}。`;
  return undefined;
}
