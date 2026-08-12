export interface GoalDecisionOption {
  key: string;
  label: string;
  recommended?: boolean;
}

export function normalizeGoalDecisionOptions(raw: unknown): GoalDecisionOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: GoalDecisionOption[] = [];
  const seen = new Set<string>();
  let recommendedSeen = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const recommended = rec.recommended === true && !recommendedSeen;
    if (recommended) recommendedSeen = true;
    out.push({ key, label, recommended: recommended || undefined });
    if (out.length >= 6) break;
  }
  return out.length ? out : undefined;
}
