import type { BotRow, SkillRow, SkillPolicy } from './types.js';

export function nativeLibraryLabel(path: string | undefined, tr: (key: string) => string): string | null {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (p.includes('/.codex/skills/')) return tr('skills.sourceCodex');
  if (p.includes('/.claude/skills/')) return tr('skills.sourceClaude');
  if (p.includes('/.trae/skills/')) return tr('skills.sourceTrae');
  if (p.includes('/.cursor/skills/')) return tr('skills.sourceCursor');
  if (p.includes('/.gemini/skills/')) return tr('skills.sourceGemini');
  if (p.includes('/.config/opencode/skills/')) return tr('skills.sourceOpenCode');
  return null;
}

export function sourceLabel(skill: SkillRow, tr: (key: string) => string): string {
  const source = skill.source ?? {};
  if (source.type === 'github') return `github:${source.owner}/${source.repo}/${source.path ?? ''}`;
  if (source.type === 'git') return `${source.url ?? 'git'}#${source.path ?? ''}`;
  if (source.type === 'local-link') return nativeLibraryLabel(source.path, tr) ?? tr('skills.sourceLocalLink');
  if (source.type === 'local-copy') return tr('skills.sourceBotmuxCopy');
  return String(source.type ?? 'unknown');
}

export function priorityNames(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('skill:'))
    .map(item => item.slice('skill:'.length));
}

export function packIds(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('pack:'))
    .map(item => item.slice('pack:'.length));
}

/** Build one complete Bot assignment payload. The editor owns both direct
 * Skills and Skill Packs, so they must be saved in a single request; two
 * independent full-policy writes race and can silently overwrite each other.
 * Unknown selectors are retained for forward/downgrade compatibility. */
export function mergeBotAssignmentSelectors(
  current: SkillPolicy | null | undefined,
  skillNames: string[],
  packIdsList: string[],
): string[] {
  const unmanaged = (current?.include ?? []).filter(
    selector => !selector.startsWith('skill:') && !selector.startsWith('pack:'),
  );
  const direct = [...new Set(skillNames.map(name => name.trim()).filter(Boolean))]
    .map(name => `skill:${name}`);
  const packs = [...new Set(packIdsList.map(id => id.trim()).filter(Boolean))]
    .map(id => `pack:${id}`);
  return [...direct, ...packs, ...unmanaged];
}

export function policyReferenceCount(policy?: SkillPolicy | null): number {
  return priorityNames(policy).length;
}

export function policyConfigured(policy?: SkillPolicy | null): boolean {
  return (policy?.include?.length ?? 0) > 0;
}

export function discoveryGroupKey(group: { cliId: string; rootDir: string }): string {
  return `${group.cliId}\n${group.rootDir}`;
}

/* ------------------------------------------------------------------ */
/* Skill ↔ Pack ↔ Bot relationship graph                              */
/* ------------------------------------------------------------------ */

/** Minimal pack shape the graph needs — both the thin `{id,name,include}`
 * summaries and full SkillPackRow objects satisfy it. */
export interface GraphPackInput {
  id: string;
  name?: string;
  include: string[];
}

export interface SkillUsageInfo {
  name: string;
  /** false = referenced by a pack or bot but not installed */
  installed: boolean;
  /** ids of packs whose include lists contain this skill */
  packIds: string[];
  /** larkAppIds of bots referencing this skill via `skill:` directly */
  directBotIds: string[];
  /** larkAppIds of bots that get this skill through an assigned pack */
  viaPackBotIds: string[];
}

export interface PackGraphInfo {
  id: string;
  /** member skill names that are installed */
  resolved: string[];
  /** member skill names referenced but not installed */
  missing: string[];
  /** larkAppIds of bots referencing this pack */
  botIds: string[];
}

export type BotHealthLevel = 'ok' | 'default' | 'missing' | 'pack_missing';

export interface BotGraphInfo {
  larkAppId: string;
  /** deduped effective skills with provenance; only installed skills count */
  resolved: Array<{ name: string; source: 'direct' | `pack:${string}` }>;
  /** referenced skill names (direct or via pack) that are not installed */
  missingSkills: string[];
  /** referenced pack ids that do not exist */
  missingPacks: string[];
  finalCount: number;
  health: BotHealthLevel;
}

export interface SkillGraph {
  /** keyed by skill name; includes referenced-but-not-installed skills */
  skills: Map<string, SkillUsageInfo>;
  packs: Map<string, PackGraphInfo>;
  bots: Map<string, BotGraphInfo>;
}

/** Build the single relationship model all three skill tables derive from.
 * Referenced-but-not-installed skills get graph nodes with installed=false so
 * the UI can surface them (and link into the install flow) instead of
 * silently dropping them. */
export function buildSkillGraph(
  installedSkills: Array<Pick<SkillRow, 'name'>>,
  packs: GraphPackInput[],
  bots: Array<Pick<BotRow, 'larkAppId' | 'skills'>>,
): SkillGraph {
  const installed = new Set(installedSkills.map(skill => skill.name));
  const skillNodes = new Map<string, SkillUsageInfo>();
  const skillNode = (name: string): SkillUsageInfo => {
    let node = skillNodes.get(name);
    if (!node) {
      node = { name, installed: installed.has(name), packIds: [], directBotIds: [], viaPackBotIds: [] };
      skillNodes.set(name, node);
    }
    return node;
  };
  for (const name of installed) skillNode(name);

  const packNodes = new Map<string, PackGraphInfo>();
  const packById = new Map<string, GraphPackInput>();
  for (const pack of packs) {
    packById.set(pack.id, pack);
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const selector of pack.include) {
      if (!selector.startsWith('skill:')) continue;
      const name = selector.slice('skill:'.length);
      const node = skillNode(name);
      if (!node.packIds.includes(pack.id)) node.packIds.push(pack.id);
      (installed.has(name) ? resolved : missing).push(name);
    }
    packNodes.set(pack.id, { id: pack.id, resolved, missing, botIds: [] });
  }

  const botNodes = new Map<string, BotGraphInfo>();
  for (const bot of bots) {
    const include = bot.skills?.include ?? [];
    const resolved = new Map<string, 'direct' | `pack:${string}`>();
    const missingSkills = new Set<string>();
    const missingPacks: string[] = [];
    for (const selector of include) {
      if (selector.startsWith('skill:')) {
        const name = selector.slice('skill:'.length);
        const node = skillNode(name);
        if (!node.directBotIds.includes(bot.larkAppId)) node.directBotIds.push(bot.larkAppId);
        if (installed.has(name)) resolved.set(name, 'direct');
        else missingSkills.add(name);
      } else if (selector.startsWith('pack:')) {
        const packId = selector.slice('pack:'.length);
        const pack = packById.get(packId);
        if (!pack) {
          missingPacks.push(packId);
          continue;
        }
        const packNode = packNodes.get(packId)!;
        if (!packNode.botIds.includes(bot.larkAppId)) packNode.botIds.push(bot.larkAppId);
        for (const memberSelector of pack.include) {
          if (!memberSelector.startsWith('skill:')) continue;
          const name = memberSelector.slice('skill:'.length);
          const node = skillNode(name);
          if (!node.viaPackBotIds.includes(bot.larkAppId)) node.viaPackBotIds.push(bot.larkAppId);
          if (installed.has(name)) {
            if (!resolved.has(name)) resolved.set(name, `pack:${packId}`);
          } else {
            missingSkills.add(name);
          }
        }
      }
      // unknown selector prefixes are retained in policy but not graphed
    }
    const health: BotHealthLevel = missingPacks.length > 0 ? 'pack_missing'
      : missingSkills.size > 0 ? 'missing'
      : include.length === 0 ? 'default'
      : 'ok';
    botNodes.set(bot.larkAppId, {
      larkAppId: bot.larkAppId,
      resolved: [...resolved.entries()].map(([name, source]) => ({ name, source })),
      missingSkills: [...missingSkills],
      missingPacks,
      finalCount: resolved.size,
      health,
    });
  }

  return { skills: skillNodes, packs: packNodes, bots: botNodes };
}

/** All skill names referenced anywhere (packs or bot policies) but not installed. */
export function danglingSkillNames(graph: SkillGraph): string[] {
  return [...graph.skills.values()].filter(node => !node.installed).map(node => node.name).sort();
}
