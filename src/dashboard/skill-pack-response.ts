import { redactGitUrlCredentials } from '../core/skills/sources.js';
import type { SkillPack, SkillPackage } from '../core/skills/types.js';

export interface SkillPackDashboardReference {
  larkAppId: string;
  botName: string;
}

export type DashboardSkillPack = SkillPack & {
  resolvedSkills: SkillPackage[];
  missingSkills: string[];
  references: SkillPackDashboardReference[];
};

/** Keep every Dashboard response carrying a SkillPackage behind one redaction boundary. */
export function sanitizeSkillForDashboard(skill: SkillPackage): SkillPackage {
  if (skill.source.type !== 'git') return { ...skill, source: { ...skill.source } };
  return {
    ...skill,
    source: { ...skill.source, url: redactGitUrlCredentials(skill.source.url) },
  };
}

export function enrichPackForDashboard(
  pack: SkillPack,
  registrySkills: Record<string, SkillPackage>,
  references: SkillPackDashboardReference[] = [],
): DashboardSkillPack {
  const resolvedSkills: SkillPackage[] = [];
  const missingSkills: string[] = [];
  for (const selector of pack.include) {
    const name = selector.slice('skill:'.length);
    const skill = Object.hasOwn(registrySkills, name) ? registrySkills[name] : undefined;
    if (skill) resolvedSkills.push(sanitizeSkillForDashboard(skill));
    else missingSkills.push(name);
  }
  return {
    ...pack,
    resolvedSkills,
    missingSkills,
    references,
  };
}

export function enrichPacksForDashboard(
  packs: SkillPack[],
  registrySkills: Record<string, SkillPackage>,
  referencesForPack: (packId: string) => SkillPackDashboardReference[] = () => [],
): DashboardSkillPack[] {
  return packs.map((pack) => enrichPackForDashboard(pack, registrySkills, referencesForPack(pack.id)));
}
