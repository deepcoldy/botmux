/** Shared history read grammar for the local CLI and structured host relays. */
export interface HistoryReadOptions {
  view: 'full' | 'index';
  query?: string;
  types: string[];
  since?: number;
  until?: number;
}

export interface HistoryReadFilterOptions {
  view?: 'full' | 'index';
  query?: string;
  types?: string[];
  since?: string;
  until?: string;
  withCardJson?: boolean;
}

/** Values remain single argv entries, including queries beginning with --. */
export function historyReadFilterArgs(options: HistoryReadFilterOptions): string[] {
  return [
    ...(options.view !== undefined ? ['--view', options.view] : []),
    ...(options.query !== undefined ? [`--query=${options.query}`] : []),
    ...(options.types !== undefined ? ['--type', options.types.join(',')] : []),
    ...(options.since !== undefined ? [`--since=${options.since}`] : []),
    ...(options.until !== undefined ? [`--until=${options.until}`] : []),
    ...(options.withCardJson ? ['--with-card-json'] : []),
  ];
}

export function normalizeHistoryReadFilters(raw: Record<string, unknown>): HistoryReadFilterOptions | undefined {
  if (raw.view !== undefined && raw.view !== 'full' && raw.view !== 'index') return undefined;
  if (raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 4096)) return undefined;
  if (raw.types !== undefined && (!Array.isArray(raw.types) || !raw.types.length || raw.types.length > 32
    || !raw.types.every(type => typeof type === 'string' && /^[a-z_]+$/.test(type)))) return undefined;
  for (const key of ['since', 'until'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 128)) return undefined;
  }
  if (raw.withCardJson !== undefined && typeof raw.withCardJson !== 'boolean') return undefined;
  const options: HistoryReadFilterOptions = {
    ...(raw.view !== undefined ? { view: raw.view } : {}),
    ...(raw.query !== undefined ? { query: raw.query as string } : {}),
    ...(raw.types !== undefined ? { types: [...raw.types as string[]] } : {}),
    ...(raw.since !== undefined ? { since: raw.since as string } : {}),
    ...(raw.until !== undefined ? { until: raw.until as string } : {}),
    ...(raw.withCardJson !== undefined ? { withCardJson: raw.withCardJson } : {}),
  };
  try { parseHistoryReadOptions(historyReadFilterArgs(options)); }
  catch { return undefined; }
  return options;
}

export function parseHistoryReadOptions(args: string[]): HistoryReadOptions {
  // Same two spellings unknownFlags() admits: `--flag value` and `--flag=value`.
  // An admitted spelling that is not read here would silently fall back to the
  // unfiltered full view.
  const value = (flag: string): string | undefined => {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg.startsWith(`${flag}=`)) {
        const inline = arg.slice(flag.length + 1);
        if (!inline) throw new Error(`${flag} requires a value`);
        return inline;
      }
      if (arg !== flag) continue;
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    }
    return undefined;
  };
  const view = value('--view') ?? 'full';
  if (view !== 'full' && view !== 'index') throw new Error('--view must be full or index');
  if (view === 'index' && args.includes('--with-card-json')) throw new Error('--with-card-json requires --view full');
  const query = value('--query')?.trim();
  if (query === '') throw new Error('--query must not be empty');
  const rawTypes = value('--type');
  const types = (rawTypes ?? '').split(',').map(type => type.trim()).filter(Boolean);
  if (rawTypes !== undefined && (!types.length || types.some(type => !/^[a-z_]+$/.test(type)))) {
    throw new Error('--type requires comma-separated message types');
  }
  const timestamp = (flag: string): number | undefined => {
    const text = value(flag);
    if (text === undefined) return undefined;
    const parsed = Date.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || !Number.isFinite(parsed)) throw new Error(`${flag} requires an ISO date or timestamp`);
    return parsed;
  };
  const since = timestamp('--since');
  const until = timestamp('--until');
  if (since !== undefined && until !== undefined && since >= until) throw new Error('--since must be earlier than --until');
  return { view, ...(query ? { query } : {}), types, ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) };
}
