export type RoleProfileSummaryLike = {
  profileId: string;
  entryCount?: number;
  botEntries?: Array<{ larkAppId: string; hasEntry: boolean }>;
};

export type RoleProfileEntryLike = {
  profileId: string;
  larkAppId: string;
  content: string | null;
};

export type EffectiveRoleSource = 'chat' | 'team' | 'none' | string;

export type EffectiveRoleValue = string | null | {
  content: string | null;
  source?: EffectiveRoleSource | null;
};

export type GroupProfileMatch = {
  profileId: string;
  matched: number;
  total: number;
  chatMatched: number;
  kind: 'full' | 'partial';
};

function normalizeEffectiveRole(value: EffectiveRoleValue | undefined): { content: string | null; source: EffectiveRoleSource } {
  if (value == null || typeof value === 'string') {
    return { content: value ?? null, source: value == null ? 'none' : 'chat' };
  }
  return { content: value.content ?? null, source: value.source ?? 'none' };
}

export function hasExplicitChatRole(rolesByBot: Map<string, EffectiveRoleValue>): boolean {
  for (const value of rolesByBot.values()) {
    const role = normalizeEffectiveRole(value);
    if (role.source === 'chat' && role.content !== null) return true;
  }
  return false;
}

export function summarizeGroupProfileMatches(
  memberBots: Array<{ larkAppId: string; inChat?: boolean }>,
  profiles: RoleProfileSummaryLike[],
  entriesByProfile: Map<string, RoleProfileEntryLike[]>,
  rolesByBot: Map<string, EffectiveRoleValue>,
): GroupProfileMatch[] {
  const inChatBotIds = new Set(
    memberBots
      .filter(bot => bot.inChat)
      .map(bot => String(bot.larkAppId)),
  );
  if (inChatBotIds.size === 0) return [];

  const matches: GroupProfileMatch[] = [];
  for (const profile of profiles) {
    const entries = (entriesByProfile.get(profile.profileId) ?? [])
      .filter(entry => inChatBotIds.has(entry.larkAppId) && typeof entry.content === 'string' && entry.content !== '');
    if (entries.length === 0) continue;

    let matched = 0;
    let chatMatched = 0;
    for (const entry of entries) {
      const role = normalizeEffectiveRole(rolesByBot.get(entry.larkAppId));
      if (role.source !== 'chat') continue;
      if (role.content !== entry.content) continue;
      matched++;
      chatMatched++;
    }

    if (matched === entries.length) {
      matches.push({ profileId: profile.profileId, matched, total: entries.length, chatMatched, kind: 'full' });
    } else if (matched > 0) {
      matches.push({ profileId: profile.profileId, matched, total: entries.length, chatMatched, kind: 'partial' });
    }
  }

  return matches.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    const ratio = (b.matched / b.total) - (a.matched / a.total);
    if (ratio !== 0) return ratio;
    if (b.chatMatched !== a.chatMatched) return b.chatMatched - a.chatMatched;
    if (b.matched !== a.matched) return b.matched - a.matched;
    return a.profileId.localeCompare(b.profileId);
  });
}
