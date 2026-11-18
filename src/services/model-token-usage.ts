/** Mutually exclusive token buckets attributed to one execution model. */
export interface ModelTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export const MODEL_TOKEN_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const;

/** Persisted breakdowns are accepted only when they account for the whole
 * snapshot. Partial/legacy evidence stays unclassified rather than guessing. */
export function normalizeModelTokenUsage(raw: unknown, total: Omit<ModelTokenUsage, 'model'>): ModelTokenUsage[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256) return;
  const seen = new Set<string>();
  const rows: ModelTokenUsage[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const r = value as Record<string, unknown>;
    if (typeof r.model !== 'string' || r.model.length > 256 || seen.has(r.model)
      || MODEL_TOKEN_BUCKETS.some(k => !Number.isSafeInteger(r[k]) || (r[k] as number) < 0)) return;
    seen.add(r.model);
    rows.push({ model: r.model, ...Object.fromEntries(MODEL_TOKEN_BUCKETS.map(k => [k, r[k]])) } as ModelTokenUsage);
  }
  if (MODEL_TOKEN_BUCKETS.some(k => rows.reduce((sum, row) => sum + row[k], 0) !== total[k])) return;
  return rows.sort((a, b) => a.model.localeCompare(b.model));
}

export function modelTokenDeltas(current: ModelTokenUsage[], previous: ModelTokenUsage[]): ModelTokenUsage[] | undefined {
  const before = new Map(previous.map(row => [row.model, row]));
  if (previous.some(row => !current.some(next => next.model === row.model))) return;
  const rows: ModelTokenUsage[] = [];
  for (const row of current) {
    const prev = before.get(row.model);
    const delta = { model: row.model } as ModelTokenUsage;
    for (const key of MODEL_TOKEN_BUCKETS) {
      delta[key] = row[key] - (prev?.[key] ?? 0);
      if (delta[key] < 0) return;
    }
    if (MODEL_TOKEN_BUCKETS.some(k => delta[k] > 0)) rows.push(delta);
  }
  return rows;
}
