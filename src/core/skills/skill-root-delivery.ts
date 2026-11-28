import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
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

export interface SkillRootPrepared {
  skillDir: string;
  deliveredSkills: string[];
  skippedSkills: UnavailableSkillEntry[];
  diagnostics: string[];
}

export function prepareSkillRootDelivery(manifest: SessionSkillManifest): SkillRootPrepared {
  const skillDir = join(config.session.dataDir, 'runtime-skills', manifest.sessionId, 'skills');
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });

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
    const targetDir = join(skillDir, skill.name);
    try {
      copySkillDirectoryForDelivery(skill.rootDir, targetDir);
      deliveredSkills.push(skill.name);
    } catch (err) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* best effort */ }
      const sourceIssue = classifyMaterializationCopyError(err, skill, skillDir);
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

  return { skillDir, deliveredSkills, skippedSkills, diagnostics };
}
