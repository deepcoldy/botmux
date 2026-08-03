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
