import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsageAnalytics, queryUsageLedger, validateUsageQuery } from '../src/services/usage-analytics.js';

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
    // Ownership markers are expected bookkeeping, not "incomplete" records.
    expect(result.coverage.invalidRecords).toBe(0);
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
      record({ recordId: 'fraction', inputTokens: 1.5 }), record({ v: 1, inputTokenSemantics: 'includes_cache', inputTokens: 1 }),
      record({ recordId: 'v2-cache-inclusive', inputTokenSemantics: 'includes_cache', inputTokens: 100 })]);
    const path = join(dir, 'usage-2026-11-10.jsonl'); writeFileSync(path, readFileSync(path, 'utf8') + '{"partial":');
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.summary.records).toBe(1);
    expect(result.coverage.invalidRecords).toBe(6);
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

  it('reuses an identical query for five seconds without caching failures', async () => {
    let now = Date.parse('2026-11-13T00:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const usage = createUsageAnalytics(dir);
      ledger('2026-11-10', [record()]);
      expect((await usage(query)).summary.records).toBe(1);
      ledger('2026-11-10', [record(), record({ recordId: 'r2' })]);
      expect((await usage(query)).summary.records).toBe(1);
      expect((await usage({ ...query, bot: 'bot-a' })).summary.records).toBe(2);
      now += 5001;
      expect((await usage(query)).summary.records).toBe(2);

      const path = join(dir, 'usage-2026-11-10.jsonl');
      rmSync(path); mkdirSync(path); now += 5001;
      await expect(usage(query)).rejects.toMatchObject({ status: 503 });
      rmSync(path, { recursive: true }); ledger('2026-11-10', [record()]);
      expect((await usage(query)).summary.records).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('rejects ambiguous dates, impossible dates, reversed ranges and invalid zones', () => {
    for (const from of ['2026-11-10', '2026-02-30T00:00:00Z', query.to]) {
      expect(() => validateUsageQuery({ ...query, from })).toThrow();
    }
    expect(() => validateUsageQuery({ ...query, from: '2020-01-01T00:00:00Z' })).toThrow('usage_range_too_large');
    expect(() => validateUsageQuery({ ...query, timeZone: 'Mars/Phobos' })).toThrow('usage_invalid_timezone');
  });

  it('computes minute peaks, rates, quantiles and priced-token costs from one deduplicated cohort', async () => {
    const rows = [
      record({ recordId: 'b', ts: '2026-11-10T00:01:01Z', larkAppId: 'bot-b', model: 'model-b', sessionId: 'session-b', inputTokens: 30, outputTokens: 70, cacheReadTokens: 20, cacheCreateTokens: 30, costCny: .3 }),
      record({ recordId: 'a1', ts: '2026-11-10T00:00:05Z', inputTokens: 10, outputTokens: 20, cacheReadTokens: 10, cacheCreateTokens: 10, costCny: .5 }),
      record({ recordId: 'a2', ts: '2026-11-10T00:00:45Z', inputTokens: 20, outputTokens: 30, cacheReadTokens: 30, cacheCreateTokens: 20 }),
    ];
    ledger('2026-11-10', [...rows, rows[1], record({ kind: 'ownership' })]);
    const range = { from: '2026-11-10T00:00:00Z', to: '2026-11-10T00:02:00Z', timeZone: 'Asia/Shanghai' };
    const result = await queryUsageLedger(range, { ledgerDir: dir, now: new Date('2026-11-10T01:00:00Z') });
    const m = result.metrics;
    expect(m).toMatchObject({ elapsedMinutes: 2, activeMinutes: 2, averageTpm: 150, averageOutputTpm: 60,
      activeMinuteAverageTpm: 150, peakMinuteTpm: 150, peakMinuteAt: '2026-11-10T00:00:00.000Z',
      tokensPerRecordMean: 100, tokensPerRecordP50: 100, tokensPerRecordP95: 150, tokensPerRecordMax: 150, tokensPerSessionMean: 150 });
    expect(m.cacheReadShare).toBeCloseTo(1 / 3); expect(m.outputInputRatio).toBeCloseTo(2 / 3);
    expect(m.pricedTokenShare).toBeCloseTo(2 / 3); expect(m.costPerMillionTokens).toBeCloseTo(4000);
    expect(result.bots.map(b => b.averageTpm)).toEqual([75, 75]);
    // 分组行的缓存读取占比以该组全部输入（含缓存读写）为分母，与全局指标同口径。
    expect(result.bots[0]!.cacheReadShare).toBeCloseTo(.4);
    expect(result.bots[1]!.cacheReadShare).toBeCloseTo(.25);
    expect(result.models[0]!.cacheReadShare).toBeCloseTo(.4);
    expect(result.models[1]!.cacheReadShare).toBeCloseTo(.25);
    const filtered = await queryUsageLedger({ ...range, bot: 'bot-a' }, { ledgerDir: dir, now: new Date('2026-11-10T01:00:00Z') });
    expect(filtered.metrics).toMatchObject({ averageTpm: 75, activeMinutes: 1, activeMinuteAverageTpm: 150,
      tokensPerRecordMean: 75, tokensPerRecordP50: 75, tokensPerRecordP95: 100, tokensPerSessionMean: 150 });
    expect(filtered.metrics.cacheReadShare).toBeCloseTo(.4);
    expect(filtered.metrics.costPerMillionTokens).toBeCloseTo(10000);
    // 定价覆盖按 Token 加权：已定价 50 / 共 150 Token；按记录数会得到 1/2。
    expect(filtered.metrics.pricedTokenShare).toBeCloseTo(1 / 3);
  });

  it('uses elapsed time today, includes the snapshot instant, and excludes future-dated records', async () => {
    ledger('2026-11-10', [record({ recordId: 'early', ts: '2026-11-10T11:59:00Z' }),
      record({ recordId: 'snapshot', ts: '2026-11-10T12:00:00Z' }), record({ recordId: 'future', ts: '2026-11-10T13:00:00Z' })]);
    const result = await queryUsageLedger({ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timeZone: 'UTC' }, { ledgerDir: dir, now: new Date('2026-11-10T12:00:00Z') });
    expect(result.summary.records).toBe(2); expect(result.coverage.futureRecords).toBe(1);
    expect(result.metrics.elapsedMinutes).toBe(720); expect(result.metrics.averageTpm).toBeCloseTo(200 / 720);
    expect(result.metrics.activeMinuteAverageTpm).toBe(100); expect(result.metrics.rateWindowEnd).toBe('2026-11-10T12:00:00.000Z');
    // 分组行与总览同口径：今天只按已过的 720 分钟摊，而不是整天 1440 分钟。
    expect(result.bots[0]!.averageTpm).toBeCloseTo(200 / 720); expect(result.models[0]!.averageTpm).toBeCloseTo(200 / 720);
    const future = await queryUsageLedger({ from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z', timeZone: 'UTC' }, { ledgerDir: dir, now: new Date('2026-11-10T12:00:00Z') });
    expect(future.metrics.elapsedMinutes).toBe(0); expect(future.metrics.averageTpm).toBeNull();
  });

  it('treats the repeated DST hour as distinct UTC minutes and averages a 25-hour day', async () => {
    ledger('2026-11-01', [record({ ts: '2026-11-01T05:30:00Z', recordId: 'first-hour' }), record({ ts: '2026-11-01T06:30:00Z', recordId: 'repeated-hour' })]);
    const result = await queryUsageLedger({ from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z', timeZone: 'America/New_York' }, { ledgerDir: dir });
    expect(result.metrics.elapsedMinutes).toBe(1500); expect(result.metrics.activeMinutes).toBe(2);
    expect(result.metrics.peakMinuteTpm).toBe(100); expect(result.metrics.averageTpm).toBeCloseTo(200 / 1500);
  });

  it('uses the nearest-rank P95 and the arithmetic median, while keeping zero denominators unknown', async () => {
    ledger('2026-11-10', Array.from({ length: 20 }, (_, i) => record({ recordId: String(i), ts: '2026-11-10T00:00:00Z', inputTokens: (i + 1) * 100, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })));
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.metrics.tokensPerRecordP50).toBe(1050); expect(result.metrics.tokensPerRecordP95).toBe(1900); expect(result.metrics.tokensPerRecordMax).toBe(2000);
    expect(result.metrics.costPerMillionTokens).toBeNull(); expect(result.metrics.pricedTokenShare).toBe(0);
    ledger('2026-11-10', [record({ ts: '2026-11-10T00:00:00Z', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costCny: 0 })]);
    const zero = await queryUsageLedger(query, { ledgerDir: dir });
    expect(zero.metrics.tokensPerRecordP50).toBe(0); expect(zero.metrics.activeMinutes).toBe(0); expect(zero.metrics.activeMinuteAverageTpm).toBeNull();
    expect(zero.metrics.cacheReadShare).toBeNull(); expect(zero.metrics.outputInputRatio).toBeNull(); expect(zero.metrics.costPerMillionTokens).toBeNull();
    const missing = await queryUsageLedger(query, { ledgerDir: dir + '/missing' });
    expect(missing.metrics.averageTpm).toBeNull(); expect(missing.metrics.elapsedMinutes).toBeNull();
  });

  it('keeps an overflowing derived unit price unknown instead of returning Infinity', async () => {
    ledger('2026-11-10', [record({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costCny: 1e308 })]);
    const result = await queryUsageLedger(query, { ledgerDir: dir });
    expect(result.metrics.costPerMillionTokens).toBeNull();
  });
});
