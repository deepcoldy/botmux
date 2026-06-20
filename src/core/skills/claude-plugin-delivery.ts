import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import type { SessionSkillManifest } from './types.js';

export interface ClaudeSkillPluginPrepared {
  pluginDir: string;
}

export function prepareClaudeSkillPlugin(manifest: SessionSkillManifest): ClaudeSkillPluginPrepared {
  const pluginDir = join(config.session.dataDir, 'runtime-skills', manifest.sessionId, 'claude-plugin');
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'skills'), { recursive: true });
  atomicWriteFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'botmux-session-skills',
    description: 'botmux per-session priority skills',
    version: '1.0.0',
    author: { name: 'botmux' },
  }, null, 2) + '\n');
  for (const skill of manifest.prioritySkills) {
    cpSync(skill.rootDir, join(pluginDir, 'skills', skill.name), { recursive: true });
  }
  return { pluginDir };
}
