/** Text and mentioned-user keywords share the same any/all matching mode. */
export interface ListenerContentPolicy {
  includeKeywords?: string[];
  /** Real @mention targets. open_id is scoped to the current bot application. */
  includeMentionedOpenIds?: string[];
  matchMode?: 'any' | 'all';
  /** Resolve titles with the bot identity, only after local text matching misses. */
  resolveDocumentTitles?: boolean;
}

/** Shared by config loading, dashboard saves and browser drafts. */
export function normalizeListenerContentPolicy(raw: unknown): ListenerContentPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const includeKeywords = Array.isArray(entry.includeKeywords)
    ? [...new Set(entry.includeKeywords.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
    : [];
  const hasIdentities = entry.includeMentionedOpenIds !== undefined;
  let includeMentionedOpenIds: string[] = [];
  if (hasIdentities && Array.isArray(entry.includeMentionedOpenIds)) {
    const values = entry.includeMentionedOpenIds;
    // Do not partially discard invalid identities: dropping an ALL term would
    // widen the rule. An invalid/empty identity list remains a fail-closed rule.
    if (values.every(value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value.trim()))) {
      includeMentionedOpenIds = [...new Set(values.map(value => (value as string).trim()))];
    }
  }
  if (includeKeywords.length === 0 && !hasIdentities) return undefined;
  return {
    ...(includeKeywords.length ? { includeKeywords } : {}),
    ...(hasIdentities ? { includeMentionedOpenIds } : {}),
    ...(entry.matchMode === 'all' ? { matchMode: 'all' } : {}),
    ...(includeKeywords.length && entry.resolveDocumentTitles === true ? { resolveDocumentTitles: true } : {}),
  };
}
