import type { CliId } from '../../adapters/cli/types.js';

export type SkillSource =
  | { type: 'bundled'; packageName: string }
  | { type: 'user'; root: string }
  | { type: 'project'; root: string }
  | { type: 'admin'; root: string }
  | { type: 'local-copy'; originalPath: string }
  | { type: 'local-link'; path: string }
  | { type: 'git'; url: string; path: string; ref?: string; commit?: string }
  | { type: 'github'; owner: string; repo: string; path: string; ref?: string; commit?: string };

export interface SkillPackage {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  tags: string[];
  rootDir: string;
  entrypoint: string;
  source: SkillSource;
  checksum?: string;
  installedAt?: string;
  updatedAt?: string;
}

export type SkillSelector = `skill:${string}`;

export interface BotSkillPolicy {
  include?: SkillSelector[];
}

export interface ResolvedSkill extends SkillPackage {
  priorityReason: string;
}

export interface SkillDiagnostic {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  skillName?: string;
}

export interface SessionSkillManifest {
  sessionId: string;
  cliId: CliId;
  workingDir: string;
  policyMode: 'priority';
  delivery?: 'auto' | 'prompt' | 'native';
  prioritySkills: ResolvedSkill[];
  diagnostics: SkillDiagnostic[];
  generatedAt: string;
}
