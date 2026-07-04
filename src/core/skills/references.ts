import type { BotSkillPolicy, SkillSelector } from './types.js';

export interface SkillReferenceBotInput {
  larkAppId: string;
  name?: string;
  botName?: string;
  skills?: BotSkillPolicy | null;
}

export interface SkillReferenceBot {
  larkAppId: string;
  botName: string;
  direct: boolean;
}

export interface SkillReferenceSummary {
  bots: SkillReferenceBot[];
}

function directSkillSelector(skillName: string): SkillSelector {
  return `skill:${skillName}` as SkillSelector;
}

export function directSkillNames(policy: BotSkillPolicy | null | undefined): string[] {
  return (policy?.include ?? [])
    .filter((item) => item.startsWith('skill:'))
    .map((item) => item.slice('skill:'.length));
}

export function policyIncludesDirectSkill(
  policy: BotSkillPolicy | null | undefined,
  skillName: string,
): boolean {
  return Array.isArray(policy?.include) && policy.include.includes(directSkillSelector(skillName));
}

export function analyzeSkillReferences(
  skillName: string,
  opts: {
    bots: SkillReferenceBotInput[];
  },
): SkillReferenceSummary {
  const bots: SkillReferenceBot[] = [];
  for (const bot of opts.bots) {
    const direct = policyIncludesDirectSkill(bot.skills, skillName);
    if (!direct) continue;
    bots.push({
      larkAppId: bot.larkAppId,
      botName: bot.botName ?? bot.name ?? bot.larkAppId,
      direct,
    });
  }
  bots.sort((a, b) => a.botName.localeCompare(b.botName));
  return { bots };
}
