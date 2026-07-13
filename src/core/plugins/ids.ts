const PLUGIN_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export function isValidPluginId(value: unknown): value is string {
  return typeof value === 'string'
    && PLUGIN_ID_RE.test(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('/');
}

export function assertValidPluginId(value: unknown, field = 'plugin id'): string {
  if (!isValidPluginId(value)) throw new Error(`invalid_${field.replace(/\W+/g, '_')}`);
  return value;
}

export function normalizePluginIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!isValidPluginId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : undefined;
}
