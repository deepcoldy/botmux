import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import type { SessionSkillManifest } from './types.js';

export interface SkillRootPrepared {
  skillDir: string;
}

export function prepareSkillRootDelivery(manifest: SessionSkillManifest): SkillRootPrepared {
  const skillDir = join(config.session.dataDir, 'runtime-skills', manifest.sessionId, 'skills');
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  for (const skill of manifest.prioritySkills) {
    cpSync(skill.rootDir, join(skillDir, skill.name), { recursive: true });
  }
  return { skillDir };
}
