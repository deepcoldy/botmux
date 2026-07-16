import { existsSync } from 'node:fs';
import { loadSkillPackage } from '../skills/package.js';
import type { SkillPackage } from '../skills/types.js';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { pluginRuntimeDir, resolvePluginPath } from './paths.js';

export interface PluginSkillResolution {
  skills: SkillPackage[];
  diagnostics: string[];
}

export function resolvePluginSkillPackages(pluginIds: readonly string[]): PluginSkillResolution {
  const registry = readPluginRegistry();
  const skills: SkillPackage[] = [];
  const diagnostics: string[] = [];

  for (const pluginId of [...new Set(pluginIds)]) {
    const record = registry.plugins[pluginId];
    if (!record) {
      diagnostics.push(`enabled_plugin_not_installed:${pluginId}`);
      continue;
    }
    const pluginDir = pluginRuntimeDir(pluginId);
    for (const entry of record.contributions?.skills ?? []) {
      try {
        const skillDir = resolvePluginPath(pluginDir, entry.path, 'skill_path');
        if (!existsSync(skillDir)) {
          diagnostics.push(`plugin_skill_not_found:${pluginId}:${entry.path}`);
          continue;
        }
        const skill = loadSkillPackage(skillDir, {
          source: { type: 'plugin', pluginId, root: pluginDir },
        });
        skills.push({ ...skill, id: `plugin:${pluginId}:${skill.name}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.push(`plugin_skill_invalid:${pluginId}:${entry.path}:${message}`);
      }
    }
  }

  return { skills, diagnostics };
}
