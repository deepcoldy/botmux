import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryUsageLedger, validateUsageQuery } from '../src/services/usage-analytics.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-usage-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const query = { from: '2026-11-09T16:00:00.000Z', to: '2026-11-11T16:00:00.000Z', timeZone: 'Asia/Shanghai' };
function record(overrides: Record<string, unknown> = {}) {
  return { v: 2, inputTokenSemantics: 'uncached', recordId: 'r1', ts: '2026-11-10T15:59:59Z',
    larkAppId: 'bot-a', model: 'model-a', sessionId: 'session-a', title: 'Session A',
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreateTokens: 40,
    totalInputTokens: 1000000, totalOutputTokens: 2000000, ...overrides };
}
function ledger(day: string, records: unknown[]) { writeFileSync(join(dir, `usage-${day}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n'); }

describe('usage ledger analytics', () => {
  it('sums deltas once, keeps all four buckets and preserves separate bot partitions', async () => {
    const rows = [record(), record(), record({ larkAppId: 'bot-b', title: 'Other bot' }),
      record({ kind: 'ownership' }), record({ recordId: 'r2', costCny: 0, inputTokens: 5 })];
    ledger('2026-11-10', rows);
    const before = readFileSync(join(dir, 'usage-2026-11-10.jsonl'), 'utf8');
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.summary).toEqual({ inputTokens: 25, outputTokens: 60, cacheReadTokens: 90,
      cacheCreateTokens: 120, totalTokens: 295, records: 3, costCny: 0, pricedRecords: 1 });
    expect(result.coverage.duplicateRecords).toBe(1);
    expect(result.sessions).toHaveLength(2);
    expect(result.bots.map(r => [r.id, r.totalTokens])).toEqual([['bot-a', 195], ['bot-b', 100]]);
    expect(readFileSync(join(dir, 'usage-2026-11-10.jsonl'), 'utf8')).toBe(before);
  });

  it('migrates legacy cache-inclusive inputs without double counting cache tokens', async () => {
    ledger('2026-11-10', [record({ v: 1, inputTokenSemantics: undefined, cliId: 'traex', inputTokens: 100 }),
      record({ v: 1, inputTokenSemantics: undefined, cliId: 'claude', recordId: 'r2', inputTokens: 100 })]);
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.summary.inputTokens).toBe(130);
    expect(result.summary.totalTokens).toBe(310);
    expect(result.summary.costCny).toBeNull();
  });

  it('uses [from,to), fills local days and keeps filter choices independent of applied filters', async () => {
    ledger('2026-11-09', [record({ ts: query.from, recordId: 'start' })]);
    ledger('2026-11-10', [record({ ts: '2026-11-10T16:00:00Z', recordId: 'next-day' }),
      record({ recordId: 'other', larkAppId: 'bot-b', model: 'model-b' })]);
    ledger('2026-11-11', [record({ ts: query.to, recordId: 'end' })]);
    const result = await queryUsageLedger({ ...query, bot: 'bot-a', model: 'model-a' }, { ledgerDir: dir });
    expect(result.summary.records).toBe(2);
    expect(result.trend.map(r => [r.id, r.totalTokens])).toEqual([['2026-11-10', 100], ['2026-11-11', 100]]);
    expect(result.options).toEqual({ bots: ['bot-a', 'bot-b'], models: ['model-a', 'model-b'] });
    expect(result.coverage.firstRecordAt).toBe(query.from);
    expect(result.coverage.lastRecordAt).toBe('2026-11-10T16:00:00.000Z');
  });

  it('labels malformed, future-schema and inconsistent records without treating them as valid zeros', async () => {
    ledger('2026-11-10', [record(), record({ v: 3, recordId: 'future' }), record({ recordId: 'negative', outputTokens: -1 }),
      record({ recordId: 'fraction', inputTokens: 1.5 }), record({ v: 1, inputTokenSemantics: 'includes_cache', inputTokens: 1 })]);
    const path = join(dir, 'usage-2026-11-10.jsonl'); writeFileSync(path, readFileSync(path, 'utf8') + '{"partial":');
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.summary.records).toBe(1);
    expect(result.coverage.invalidRecords).toBe(5);
  });

  it('keeps a 25-hour daylight-saving day in one local trend bucket', async () => {
    ledger('2026-11-01', [record({ ts: '2026-11-01T04:00:00Z', recordId: 'start' })]);
    ledger('2026-11-02', [record({ ts: '2026-11-02T04:59:59Z', recordId: 'last' }), record({ ts: '2026-11-02T05:00:00Z', recordId: 'outside' })]);
    const result = await queryUsageLedger({ from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z', timeZone: 'America/New_York' }, { ledgerDir: dir });
    expect(result.summary.records).toBe(2);
    expect(result.trend.map(r => [r.id, r.totalTokens])).toEqual([['2026-11-01', 200]]);
  });

  it('distinguishes a missing ledger from a readable ledger with no matching consumption', async () => {
    const missing = await queryUsageLedger(query, { ledgerDir: join(dir, 'missing') });
    expect(missing.coverage.ledgerMissing).toBe(true);
    const empty = await queryUsageLedger(query, { ledgerDir: dir });
    expect(empty.coverage.ledgerMissing).toBe(false);
    expect(empty.trend).toHaveLength(2);
    expect(empty.summary.costCny).toBeNull();
  });

  it('rejects unreadable and oversized sources instead of returning partial totals', async () => {
    mkdirSync(join(dir, 'usage-2026-11-10.jsonl'));
    await expect(queryUsageLedger(query, { ledgerDir: dir })).rejects.toMatchObject({ status: 503 });
    rmSync(join(dir, 'usage-2026-11-10.jsonl'), { recursive: true });
    writeFileSync(join(dir, 'usage-2026-11-10.jsonl'), '');
    truncateSync(join(dir, 'usage-2026-11-10.jsonl'), 64 * 1024 * 1024 + 1);
    await expect(queryUsageLedger(query, { ledgerDir: dir })).rejects.toMatchObject({ code: 'usage_ledger_too_large' });
  });

  it('rejects ambiguous dates, impossible dates, reversed ranges and invalid zones', () => {
    for (const from of ['2026-11-10', '2026-02-30T00:00:00Z', query.to]) {
      expect(() => validateUsageQuery({ ...query, from })).toThrow();
    }
    expect(() => validateUsageQuery({ ...query, from: '2020-01-01T00:00:00Z' })).toThrow('usage_range_too_large');
    expect(() => validateUsageQuery({ ...query, timeZone: 'Mars/Phobos' })).toThrow('usage_invalid_timezone');
  });
});
