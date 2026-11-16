import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { defaultLedgerDir } from './usage-ledger.js';
import { emptyUsageMetrics, usageBreakdown, UsageMetricsAccumulator } from './usage-metrics.js';
import type { UsageGroup, UsageQuery, UsageReport, UsageSession, UsageTotals } from '../dashboard/usage-types.js';

const DAY = 86400000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_QUERY_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 500_000;

export class UsageQueryError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

/** Only ISO instants are accepted; Date.parse's permissive local dates are not. */
function instant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new UsageQueryError('usage_invalid_range');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new UsageQueryError('usage_invalid_range');
  }
  return ms;
}

export function validateUsageQuery(query: UsageQuery): UsageQuery {
  const from = instant(query.from);
  const to = instant(query.to);
  if (from >= to) throw new UsageQueryError('usage_invalid_range');
  // A year of local calendar days can include a daylight-saving transition.
  if (to - from > 366 * DAY + 2 * 3600000) throw new UsageQueryError('usage_range_too_large');
  try { new Intl.DateTimeFormat('en', { timeZone: query.timeZone }).format(from); }
  catch { throw new UsageQueryError('usage_invalid_timezone'); }
  if (!query.timeZone || query.timeZone.length > 100
    || (query.bot?.length ?? 0) > 256 || (query.model?.length ?? 0) > 256) {
    throw new UsageQueryError('usage_invalid_filter');
  }
  return { ...query };
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    totalTokens: 0, records: 0, costCny: null, pricedRecords: 0 };
}

type RecordDelta = Omit<UsageTotals, 'totalTokens' | 'records' | 'pricedRecords'> & {
  recordId: string;
  ts: number;
  bot: string;
  model: string;
  sessionId: string;
  title: string;
};

/** Four mutually exclusive buckets. v1 Codex/TraeX/Aiden input included caches. */
function normalizeRecord(raw: unknown): RecordDelta | 'ownership' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'ownership') return 'ownership';
  if (r.kind !== undefined || (r.v !== 1 && r.v !== 2)
    || typeof r.recordId !== 'string' || !r.recordId || r.recordId.length > 256
    || typeof r.sessionId !== 'string' || !r.sessionId
    || typeof r.ts !== 'string') return null;
  let ts: number;
  try { ts = instant(r.ts); } catch { return null; }
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const;
  if (keys.some(k => !Number.isSafeInteger(r[k]) || (r[k] as number) < 0)) return null;
  let inputTokens = r.inputTokens as number;
  const outputTokens = r.outputTokens as number;
  const cacheReadTokens = r.cacheReadTokens as number;
  const cacheCreateTokens = r.cacheCreateTokens as number;
  const semantics = r.inputTokenSemantics;
  if (semantics !== undefined && semantics !== 'uncached' && semantics !== 'includes_cache') return null;
  if (r.v === 2 && semantics !== 'uncached') return null;
  const includesCache = semantics === 'includes_cache'
    || (r.v === 1 && semantics === undefined && ['codex', 'traex', 'aiden'].includes(String(r.cliId)));
  if (includesCache) {
    if (cacheReadTokens + cacheCreateTokens > inputTokens) return null;
    inputTokens -= cacheReadTokens + cacheCreateTokens;
  }
  if (!Number.isSafeInteger(inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens)) return null;
  const costCny = typeof r.costCny === 'number' && Number.isFinite(r.costCny) && r.costCny >= 0 ? r.costCny : null;
  return { recordId: r.recordId, ts, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costCny,
    bot: typeof r.larkAppId === 'string' ? r.larkAppId : '',
    model: typeof r.model === 'string' ? r.model : '', sessionId: r.sessionId,
    title: typeof r.title === 'string' ? r.title.slice(0, 500) : '' };
}

function add(target: UsageTotals, delta: RecordDelta): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheCreateTokens += delta.cacheCreateTokens;
  target.totalTokens += delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheCreateTokens;
  if (!Number.isSafeInteger(target.totalTokens)) throw new UsageQueryError('usage_totals_overflow', 503);
  target.records++;
  if (delta.costCny !== null) {
    target.costCny = (target.costCny ?? 0) + delta.costCny;
    if (!Number.isFinite(target.costCny)) throw new UsageQueryError('usage_totals_overflow', 503);
    target.pricedRecords++;
  }
}

function group(map: Map<string, UsageGroup>, id: string): UsageGroup {
  let row = map.get(id);
  if (!row) { row = { id, ...emptyUsageTotals() }; map.set(id, row); }
  return row;
}

function dateBucket(formatter: Intl.DateTimeFormat, ms: number): string {
  const p = formatter.formatToParts(ms);
  const get = (key: string) => p.find(x => x.type === key)!.value.padStart(key === 'year' ? 4 : 2, '0');
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function queryUsageLedger(queryInput: UsageQuery, options: { ledgerDir?: string; now?: Date } = {}): Promise<UsageReport> {
  const query = validateUsageQuery(queryInput);
  const from = instant(query.from), to = instant(query.to);
  const snapshotAt = (options.now ?? new Date()).getTime();
  const rateEnd = Math.min(to, snapshotAt);
  const metrics = new UsageMetricsAccumulator();
  const dir = options.ledgerDir ?? defaultLedgerDir();
  const report: UsageReport = { query, generatedAt: new Date(snapshotAt).toISOString(),
    summary: emptyUsageTotals(), metrics: emptyUsageMetrics(new Date(rateEnd).toISOString()), trend: [], bots: [], models: [], sessions: [], sessionCount: 0,
    options: { bots: [], models: [] }, coverage: { ledgerMissing: false, filesRead: 0, invalidRecords: 0,
      duplicateRecords: 0, futureRecords: 0, firstRecordAt: null, lastRecordAt: null } };
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { report.coverage.ledgerMissing = true; return report; }
    throw new UsageQueryError('usage_ledger_unavailable', 503);
  }
  const fromDay = new Date(from).toISOString().slice(0, 10);
  const toDay = new Date(to - 1).toISOString().slice(0, 10);
  const files = names.filter(n => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)
    && n.slice(6, 16) >= fromDay && n.slice(6, 16) <= toDay).sort();
  const formatter = new Intl.DateTimeFormat('en', { timeZone: query.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const trend = new Map<string, UsageGroup>(), bots = new Map<string, UsageGroup>(), models = new Map<string, UsageGroup>();
  const sessions = new Map<string, UsageSession>();
  const botOptions = new Set<string>(), modelOptions = new Set<string>(), seen = new Set<string>();
  let bytes = 0, lines = 0, first: number | null = null, last: number | null = null;
  const deadline = Date.now() + 15000;
  for (const name of files) {
    const path = join(dir, name);
    let size: number;
    try { const info = await stat(path); if (!info.isFile()) throw new Error('not_file'); size = info.size; }
    catch { throw new UsageQueryError('usage_ledger_unavailable', 503); }
    bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_QUERY_BYTES) throw new UsageQueryError('usage_ledger_too_large', 503);
    report.coverage.filesRead++;
    if (!size) continue;
    // Bound each read to its initial size, even while the daemon appends.
    const input = createReadStream(path, { end: size - 1 });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (++lines > MAX_RECORDS || Date.now() > deadline) throw new UsageQueryError('usage_ledger_too_large', 503);
        if (!line.trim()) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { report.coverage.invalidRecords++; continue; }
        const delta = normalizeRecord(raw);
        if (delta === 'ownership') continue;
        if (!delta) { report.coverage.invalidRecords++; continue; }
        if (delta.ts < from || delta.ts >= to) continue;
        if (delta.ts > snapshotAt) { report.coverage.futureRecords++; continue; }
        // Include bot in the dedup key to preserve independent daemon partitions.
        const key = `${delta.bot}\0${delta.recordId}`;
        if (seen.has(key)) { report.coverage.duplicateRecords++; continue; }
        seen.add(key);
        if (delta.bot) botOptions.add(delta.bot);
        if (delta.model) modelOptions.add(delta.model);
        if ((query.bot && delta.bot !== query.bot) || (query.model && delta.model !== query.model)) continue;
        add(report.summary, delta);
        metrics.add(delta);
        add(group(trend, dateBucket(formatter, delta.ts)), delta);
        add(group(bots, delta.bot), delta);
        add(group(models, delta.model), delta);
        const sessionKey = `${delta.bot}\0${delta.sessionId}`;
        let session = sessions.get(sessionKey);
        if (!session) { session = { id: delta.sessionId, bot: delta.bot, title: delta.title, ...emptyUsageTotals() }; sessions.set(sessionKey, session); }
        if (delta.title) session.title = delta.title;
        add(session, delta);
        first = first === null ? delta.ts : Math.min(first, delta.ts);
        last = last === null ? delta.ts : Math.max(last, delta.ts);
      }
    } catch (error) {
      if (error instanceof UsageQueryError) throw error;
      throw new UsageQueryError('usage_ledger_unavailable', 503);
    } finally { reader.close(); input.destroy(); }
  }
  // Fill calendar-day gaps without assuming a day is always 24 hours locally.
  const firstDay = dateBucket(formatter, from), lastDay = dateBucket(formatter, to - 1);
  for (let ms = Date.parse(`${firstDay}T00:00:00Z`); new Date(ms).toISOString().slice(0, 10) <= lastDay; ms += DAY) {
    const key = new Date(ms).toISOString().slice(0, 10);
    group(trend, key);
  }
  const ranked = <T extends UsageGroup>(values: Iterable<T>): T[] => [...values].sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));
  report.trend = [...trend.values()].sort((a, b) => a.id.localeCompare(b.id));
  const elapsedMinutes = Math.max(0, (rateEnd - from) / 60000);
  report.bots = ranked(bots.values()).map(row => usageBreakdown(row, elapsedMinutes));
  report.models = ranked(models.values()).map(row => usageBreakdown(row, elapsedMinutes));
  report.sessions = ranked(sessions.values()).slice(0, 100); report.sessionCount = sessions.size;
  report.metrics = metrics.finish(report.summary, report.sessionCount, from, rateEnd);
  report.options = { bots: [...botOptions].sort(), models: [...modelOptions].sort() };
  report.coverage.firstRecordAt = first === null ? null : new Date(first).toISOString();
  report.coverage.lastRecordAt = last === null ? null : new Date(last).toISOString();
  return report;
}

/** Coalesce refreshes and cap cached filter variants; never mutate the ledger. */
export function createUsageAnalytics(ledgerDir?: string): (query: UsageQuery) => Promise<UsageReport> {
  const cache = new Map<string, { expires: number; result: Promise<UsageReport> }>();
  return queryInput => {
    const query = validateUsageQuery(queryInput), key = JSON.stringify(query);
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return old.result;
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    const result = queryUsageLedger(query, { ledgerDir }).catch(error => { cache.delete(key); throw error; });
    cache.set(key, { expires: Date.now() + 5000, result });
    return result;
  };
}
