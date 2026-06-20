import type {
  BotSkillPolicy,
  ResolvedSkill,
  SkillDiagnostic,
  SkillPackage,
  SkillSelector,
} from './types.js';

export interface SkillPolicyInput {
  registrySkills: SkillPackage[];
  projectSkills: SkillPackage[];
  globalProjectSkills?: 'off' | 'trusted' | 'all';
  globalDelivery?: 'auto' | 'prompt' | 'native';
  botPolicy: BotSkillPolicy | undefined;
  workingDir: string;
}

export interface SkillPolicyResult {
  enabled: boolean;
  mode: 'priority';
  delivery: 'auto' | 'prompt' | 'native';
  prioritySkills: ResolvedSkill[];
  diagnostics: SkillDiagnostic[];
}

function matchesSelector(skill: SkillPackage, selector: SkillSelector): boolean {
  const [kind, ...rest] = selector.split(':');
  const value = rest.join(':');
  if (kind === 'skill') return skill.name === value;
  return false;
}

function appendMatches(out: ResolvedSkill[], skills: SkillPackage[], selector: SkillSelector, reason: string): void {
  for (const skill of skills) {
    if (matchesSelector(skill, selector)) out.push({ ...skill, priorityReason: reason });
  }
}

export function resolveSkillPolicy(input: SkillPolicyInput): SkillPolicyResult {
  const policy = input.botPolicy;
  if (!policy) {
    return { enabled: false, mode: 'priority', delivery: 'auto', prioritySkills: [], diagnostics: [] };
  }

  const diagnostics: SkillDiagnostic[] = [];
  const candidates = [...input.registrySkills];
  const projectMode = input.globalProjectSkills ?? 'off';
  if (projectMode === 'trusted') {
    diagnostics.push({
      level: 'warn',
      code: 'project_skills_trusted_deprecated',
      message: 'projectSkills:"trusted" is kept as a compatibility alias for "all"; no separate trust boundary is enforced',
    });
    candidates.push(...input.projectSkills);
  } else if (projectMode === 'all') {
    candidates.push(...input.projectSkills);
  }

  const raw: ResolvedSkill[] = [];
  for (const selector of policy.include ?? []) {
    if (!selector.startsWith('skill:')) continue;
    appendMatches(raw, candidates, selector, 'bot:include');
  }

  const seen = new Set<string>();
  const prioritySkills: ResolvedSkill[] = [];
  for (const skill of raw) {
    if (seen.has(skill.name)) {
      diagnostics.push({
        level: 'warn',
        code: 'duplicate_skill_shadowed',
        message: `Duplicate skill shadowed: ${skill.name}`,
        skillName: skill.name,
      });
      continue;
    }
    seen.add(skill.name);
    prioritySkills.push(skill);
  }

  if (prioritySkills.length === 0) {
    diagnostics.push({
      level: 'warn',
      code: 'empty_priority_skill_set',
      message: 'No skills matched bot skill policy',
    });
  }

  return {
    enabled: true,
    mode: 'priority',
    delivery: input.globalDelivery ?? 'auto',
    prioritySkills,
    diagnostics,
  };
}
