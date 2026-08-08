import type { BotSkillPolicy, SkillPack, SkillSelector } from './types.js';

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
  /** Packs that contain the skill (directly). Empty when no pack registry is
   *  supplied to the analyzer. */
  packs: string[];
}

function directSkillSelector(skillName: string): `skill:${string}` {
  return `skill:${skillName}`;
}

export function directSkillNames(policy: BotSkillPolicy | null | undefined): string[] {
  return (policy?.include ?? [])
    .filter((item) => item.startsWith('skill:'))
    .map((item) => item.slice('skill:'.length));
}

/** Returns the `pack:<id>` ids referenced by a bot policy, in policy order. */
export function packIdsInPolicy(policy: BotSkillPolicy | null | undefined): string[] {
  return (policy?.include ?? [])
    .filter((item) => item.startsWith('pack:'))
    .map((item) => item.slice('pack:'.length));
}

export function policyIncludesDirectSkill(
  policy: BotSkillPolicy | null | undefined,
  skillName: string,
): boolean {
  return Array.isArray(policy?.include) && policy.include.includes(directSkillSelector(skillName));
}

/** True when any pack in `packs` that is referenced by `policy` contains the
 *  given skill. Used for indirect (via-pack) impact analysis. */
function policyReferencesSkillViaPack(
  policy: BotSkillPolicy | null | undefined,
  skillName: string,
  packs: Record<string, SkillPack> | undefined,
): boolean {
  if (!packs) return false;
  const selector = directSkillSelector(skillName);
  for (const packId of packIdsInPolicy(policy)) {
    const pack = Object.hasOwn(packs, packId) ? packs[packId] : undefined;
    if (pack && Array.isArray(pack.include) && pack.include.includes(selector)) return true;
  }
  return false;
}

/** Returns the ids of packs that directly contain the given skill. */
export function packsContainingSkill(
  skillName: string,
  packs: Record<string, SkillPack> | undefined,
): string[] {
  if (!packs) return [];
  const selector = directSkillSelector(skillName);
  return Object.values(packs)
    .filter((pack) => Array.isArray(pack.include) && pack.include.includes(selector))
    .map((pack) => pack.id)
    .sort();
}

export function analyzeSkillReferences(
  skillName: string,
  opts: {
    bots: SkillReferenceBotInput[];
    packs?: Record<string, SkillPack>;
  },
): SkillReferenceSummary {
  const bots: SkillReferenceBot[] = [];
  for (const bot of opts.bots) {
    const direct = policyIncludesDirectSkill(bot.skills, skillName);
    const viaPack = !direct && policyReferencesSkillViaPack(bot.skills, skillName, opts.packs);
    if (!direct && !viaPack) continue;
    bots.push({
      larkAppId: bot.larkAppId,
      botName: bot.botName ?? bot.name ?? bot.larkAppId,
      direct,
    });
  }
  bots.sort((a, b) => a.botName.localeCompare(b.botName));
  return {
    bots,
    packs: packsContainingSkill(skillName, opts.packs),
  };
}
