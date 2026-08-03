import type {
  BotSkillPolicy,
  ResolvedSkill,
  SkillDiagnostic,
  SkillPackage,
  SkillPack,
  SkillSelector,
} from './types.js';

export interface SkillPolicyInput {
  registrySkills: SkillPackage[];
  projectSkills: SkillPackage[];
  pluginSkills?: SkillPackage[];
  globalProjectSkills?: 'off' | 'trusted' | 'all';
  globalDelivery?: 'auto' | 'prompt' | 'native';
  botPolicy: BotSkillPolicy | undefined;
  workingDir: string;
  /** Skill pack registry used to expand `pack:<id>` selectors. When absent,
   *  `pack:*` selectors resolve to nothing and emit a `pack_not_found`
   *  diagnostic, so callers that don't know about packs still behave safely. */
  packs?: Record<string, SkillPack>;
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

function skillNameFromSelector(selector: SkillSelector): string {
  return selector.slice('skill:'.length);
}

export function resolveSkillPolicy(input: SkillPolicyInput): SkillPolicyResult {
  const policy = input.botPolicy;
  const pluginSkills = input.pluginSkills ?? [];
  if (!policy && pluginSkills.length === 0) {
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

  const candidateByName = new Map(candidates.map((skill) => [skill.name, skill]));
  const raw: ResolvedSkill[] = [];

  // Partition the include array so direct `skill:*` references are ALWAYS
  // expanded before `pack:*` references, regardless of the order the user wrote
  // them in. This guarantees "direct always wins": a skill explicitly attached
  // to a bot shadows the same skill pulled in via a pack, even if the pack
  // selector appears first in the array. Within each partition the original
  // policy order is preserved for stable, predictable resolution.
  const include = policy?.include ?? [];
  const directSelectors = include.filter((s) => s.startsWith('skill:'));
  const packSelectors = include.filter((s) => s.startsWith('pack:'));

  for (const selector of directSelectors) {
    appendMatches(raw, candidates, selector, 'bot:include');
  }
  for (const selector of packSelectors) {
    const packId = selector.slice('pack:'.length);
    const pack = input.packs?.[packId];
    if (!pack) {
      diagnostics.push({
        level: 'warn',
        code: 'pack_not_found',
        message: `Skill pack not found: ${packId}`,
      });
      continue;
    }
    if (!Array.isArray(pack.include)) {
      diagnostics.push({
        level: 'warn',
        code: 'pack_invalid',
        message: `Skill pack "${packId}" has no valid include list`,
      });
      continue;
    }
    for (const member of pack.include) {
      if (!member.startsWith('skill:')) {
        diagnostics.push({
            level: 'warn',
            code: 'pack_invalid',
            message: `Skill pack "${packId}" contains a non-skill selector: ${member}`,
          });
          continue;
        }
        const skillName = skillNameFromSelector(member);
        const skill = candidateByName.get(skillName);
        if (!skill) {
          diagnostics.push({
            level: 'warn',
            code: 'pack_skill_missing',
            message: `Skill pack "${packId}" references missing skill: ${skillName}`,
            skillName,
          });
          continue;
        }
        raw.push({ ...skill, priorityReason: `bot:pack:${packId}` });
      }
    }

  for (const skill of pluginSkills) {
    const reason = skill.source.type === 'plugin' ? `plugin:${skill.source.pluginId}` : 'plugin';
    raw.push({ ...skill, priorityReason: reason });
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
