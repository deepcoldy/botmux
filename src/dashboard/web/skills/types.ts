export interface SkillRow {
  name: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  source?: Record<string, any>;
  rootDir?: string;
}

export interface NativeSkillGroup {
  cliId: string;
  rootDir: string;
  skills: SkillRow[];
  label?: string;
}

export interface BotRow {
  larkAppId: string;
  botName?: string;
  online?: boolean;
  error?: string;
  skills?: SkillPolicy | null;
  cliId?: string;
  skillInjection?: 'global' | 'prompt' | 'off' | null;
  skillInjectionDefault?: 'global' | 'prompt' | 'off' | null;
  skillInjectionSupport?: 'dynamic' | 'global' | 'none' | null;
}

export interface SkillPolicy {
  include?: string[];
}

export interface DashboardRequestError extends Error {
  status?: number;
  body?: any;
}

export interface SkillJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
  skill?: SkillRow;
  skills?: SkillRow[];
}

export interface InstallSkillCandidate {
  name: string;
  path: string;
  description?: string;
}

export type StatusMessage = { text: string; ok: boolean } | null;
export type DeliveryMode = 'auto' | 'prompt' | 'native';
export type ProjectTrustMode = 'off' | 'all';

export interface SkillRemovalReference {
  name: string;
  bots: string[];
}

/** Cross-tab navigation intent: which tab to activate and what context to
 * carry over (search prefill, focused entity, install target). Consumed once
 * by the target tab. Missing skills only ever *prefill* the install entry —
 * never trigger an install. */
export interface SkillsNavIntent {
  tab: 'library' | 'packs' | 'bots';
  /** prefill the installed-library search box */
  librarySearch?: string;
  /** library tab: restrict the list to this exact name set (clearable chip) */
  libraryFilterSkills?: string[];
  /** open the install wizard (library tab) */
  openInstallWizard?: boolean;
  /** preselect this skill among discovered install candidates */
  installTargetSkill?: string;
  /** packs tab: open this pack's editor */
  focusPackId?: string;
  /** packs tab: highlight these pack cards (no editor) */
  focusPackIds?: string[];
  /** bots tab: highlight these bots' rows */
  focusBotIds?: string[];
  /** bots tab: prefill palette search / highlight bots resolving this skill */
  focusSkill?: string;
}

export interface SkillPackRow {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  include: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedSkills?: SkillRow[];
  missingSkills?: string[];
  references?: Array<{ larkAppId: string; botName: string }>;
}
