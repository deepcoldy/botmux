import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { copySkillDirectoryForDelivery } from './materialization-copy.js';
import {
  buildUnavailableSkillEntry,
  classifyMaterializationCopyError,
  formatSkillMaterializationError,
  formatUnavailableSkillDiagnostic,
  inspectSkillSourceHealth,
  type UnavailableSkillEntry,
} from './source-health.js';
import type { SessionSkillManifest } from './types.js';

export interface ClaudeSkillPluginPrepared {
  pluginDir: string;
  deliveredSkills: string[];
  skippedSkills: UnavailableSkillEntry[];
  diagnostics: string[];
}

export function prepareClaudeSkillPlugin(manifest: SessionSkillManifest): ClaudeSkillPluginPrepared {
  const pluginDir = join(config.session.dataDir, 'runtime-skills', manifest.sessionId, 'claude-plugin');
  const skillsDir = join(pluginDir, 'skills');
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  atomicWriteFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'botmux-session-skills',
    description: 'botmux per-session priority skills',
    version: '1.0.0',
    author: { name: 'botmux' },
  }, null, 2) + '\n');

  const deliveredSkills: string[] = [];
  const skippedSkills: UnavailableSkillEntry[] = [];
  const diagnostics: string[] = [];

  for (const skill of manifest.prioritySkills) {
    const health = inspectSkillSourceHealth(skill);
    if (!health.ok) {
      const entry = buildUnavailableSkillEntry(skill, health.reason, health.detail);
      skippedSkills.push(entry);
      diagnostics.push(formatUnavailableSkillDiagnostic(entry));
      continue;
    }
    const targetDir = join(skillsDir, skill.name);
    try {
      copySkillDirectoryForDelivery(skill.rootDir, targetDir);
      deliveredSkills.push(skill.name);
    } catch (err) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* best effort */ }
      const sourceIssue = classifyMaterializationCopyError(err, skill, skillsDir);
      if (sourceIssue) {
        const detail = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : (err instanceof Error ? err.message : String(err));
        const entry = buildUnavailableSkillEntry(skill, sourceIssue, detail);
        skippedSkills.push(entry);
        diagnostics.push(formatUnavailableSkillDiagnostic(entry));
        continue;
      }
      throw formatSkillMaterializationError(skill, err);
    }
  }

  return { pluginDir, deliveredSkills, skippedSkills, diagnostics };
}
