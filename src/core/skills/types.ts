import type { CliId } from '../../adapters/cli/types.js';

export type SkillSource =
  | { type: 'bundled'; packageName: string }
  | { type: 'plugin'; pluginId: string; root: string }
  | { type: 'user'; root: string }
  | { type: 'project'; root: string }
  | { type: 'admin'; root: string }
  | { type: 'local-copy'; originalPath: string }
  | { type: 'local-link'; path: string }
  | { type: 'git'; url: string; path: string; ref?: string; commit?: string }
  | { type: 'github'; owner: string; repo: string; path: string; ref?: string; commit?: string }
  | { type: 'agentbuddy'; identifier: string; protocol?: 'skill' | 'plugin'; collection?: string; group?: string; skill?: string; version?: string };

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

export type SkillSelector = `skill:${string}` | `pack:${string}`;

export interface BotSkillPolicy {
  include?: SkillSelector[];
}

/** A reusable, named collection of `skill:*` references assigned to one or more
 *  bots. Packs are declarative references — they do not copy skill files. At
 *  session resolution time `pack:<id>` selectors are expanded into the member
 *  `skill:*` selectors before the existing dedup / delivery pipeline runs. */
export interface SkillPack {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  /** Only `skill:*` selectors are allowed; packs cannot nest (no `pack:*`). */
  include: Array<`skill:${string}`>;
  /** Monotonically increasing on every content change; used for optimistic
   *  concurrency control between dashboard tabs. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackRegistryFile {
  schemaVersion: 1;
  packs: Record<string, SkillPack>;
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
