import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import { readAntigravityTokenUsage, readLatestAntigravityRuntime } from '../src/services/antigravity-usage.js';
import { __resetUsageLedgerMemoryForTest, anchorSessionUsage, recordSessionUsage } from '../src/services/usage-ledger.js';
import { queryUsageLedger } from '../src/services/usage-analytics.js';
import { withCardRuntimeIdentity } from '../src/core/card-runtime-identity.js';
import { buildReplyCardFooter, cardUsageRuntimeSegment } from '../src/im/lark/md-card.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { antigravityModelMetadata } from './helpers/antigravity-metadata.js';
import { estimateCostCny } from '../src/services/model-pricing.js';

const main = 'gemini-pro-orchestrator-argon';
const worker = 'gemini-flash-worker-agy';
const now = new Date('2026-11-16T10:00:00Z');
let root: string;
let db: DatabaseSyncLike;
let idx: number;
beforeEach(() => {
  __resetUsageLedgerMemoryForTest(); idx = 0;
  root = mkdtempSync(join(tmpdir(), 'agy-model-identity-'));
  db = openDatabaseSyncOrThrow(join(root, 'native.db'));
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function add(model: string, inputTokens: number, displayName?: string): void {
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(++idx, antigravityModelMetadata(model, { inputTokens, displayName }));
}
const usage = () => readAntigravityTokenUsage('native', { conversationsDir: root })!.result!;
const args = () => ({ sessionId: 'audit', cliId: 'antigravity', larkAppId: 'test', ledgerDir: join(root, 'ledger'), now });
/** Hand-built cumulative snapshot so per-model rows can diverge from the
 *  monotonic aggregate (vanish/regression), which the additive SQLite fixture
 *  cannot express. */
function mixedSnapshot(rows: Array<[string, number]>): any {
  const models = rows.map(([model, inputTokens]) =>
    ({ model, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }));
  const inputTokens = rows.reduce((sum, [, tokens]) => sum + tokens, 0);
  return { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    model: rows.length === 1 ? rows[0][0] : '', models, in: inputTokens, out: 0, turns: 0 };
}
const query = (model?: string) => queryUsageLedger({ from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z',
  timeZone: 'UTC', ...(model ? { model } : {}) }, { ledgerDir: join(root, 'ledger'), now: new Date('2026-11-16T11:00:00Z') });

describe('Antigravity model identity and accounting', () => {
  it('keeps a known primary display model when an older worker record has no display field', () => {
    add(main, 100, 'Native Orchestrator'); add(worker, 20);
    expect(readLatestAntigravityRuntime('native', { conversationsDir: root }).model).toBe('Native Orchestrator');
    db.exec('DELETE FROM gen_metadata'); add(worker, 1);
    expect(readLatestAntigravityRuntime('native', { conversationsDir: root })).toEqual({});
  });

  it('does not let a zero-token model-only metadata row hide the cost of priced execution', () => {
    add(main, 100); add('unknown-runtime-model', 0);
    // Explicit precision: the default (|diff| < 0.005) also accepts null at this magnitude.
    expect(estimateCostCny(usage(), { usdCny: 1, overrides: { models: { [main]: { input: 2, output: 1 } } } })).toBeCloseTo(0.0002, 12);
  });
  it('shows the native display model on both card kinds while preserving the worker execution ID for usage', () => {
    add(main, 100, 'Gemini Orchestrator');
    add(worker, 20, 'Gemini Orchestrator');
    const runtime = readLatestAntigravityRuntime('native', { conversationsDir: root });
    expect(runtime.model).toBe('Gemini Orchestrator');
    const snapshot = withCardRuntimeIdentity({ session: { cliId: 'antigravity', model: main }, activeModel: runtime.model } as any,
      { context: null, tokens: usage() }, 'antigravity');
    expect(cardUsageRuntimeSegment(snapshot)).toContain('Gemini\u00a0Orchestrator');
    expect(buildReplyCardFooter({ usage: snapshot })?.content).toContain('Gemini\u00a0Orchestrator');
    expect(snapshot.model).not.toBe(worker);
    expect(usage()).toMatchObject({ model: '', inputTokens: 120, models: [
      { model: worker, inputTokens: 20 }, { model: main, inputTokens: 100 },
    ] });
  });

  it('keeps exact model deltas, filters and per-model prices through the ledger and analytics', async () => {
    add(main, 100); add(worker, 20);
    const record = recordSessionUsage({ ...args(), usage: usage(), pricing: { usdCny: 1, overrides: {
      models: { [main]: { input: 2, output: 1 }, [worker]: { input: 1, output: 1 } },
    } } })!;
    expect(record.model).toBe('');
    expect(record.models).toMatchObject([{ model: worker, inputTokens: 20 }, { model: main, inputTokens: 100 }]);
    expect(record.costCny).toBeCloseTo(0.00022, 12);
    expect(record.models?.map(row => row.costCny)).toEqual([expect.closeTo(0.00002, 12), expect.closeTo(0.0002, 12)]);
    const all = await query();
    expect(all.summary.inputTokens).toBe(120);
    expect(all.summary.records).toBe(1);
    expect(all.models.map(row => [row.id, row.inputTokens])).toEqual([[main, 100], [worker, 20]]);
    const filtered = await query(worker);
    expect(filtered.summary.inputTokens).toBe(20);
    expect(filtered.sessions[0].inputTokens).toBe(20);
    expect(filtered.summary.costCny).toBeCloseTo(0.00002, 12);

    add(main, 50);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: main, inputTokens: 50,
      models: [{ model: main, inputTokens: 50 }] });
    expect(recordSessionUsage({ ...args(), usage: usage() })).toBeNull();
  });

  it('recovers model baselines from the appended record when the state file was lost', () => {
    add(main, 100); add(worker, 20);
    recordSessionUsage({ ...args(), usage: usage() });
    unlinkSync(join(args().ledgerDir, 'state-test.json'));
    __resetUsageLedgerMemoryForTest();
    expect(recordSessionUsage({ ...args(), usage: usage() })).toBeNull();
    add(worker, 10);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: worker, inputTokens: 10,
      models: [{ model: worker, inputTokens: 10 }] });
  });

  it('recovers exact model baselines from the ledger when the next snapshot after the lost state already grew', () => {
    add(main, 100); add(worker, 20);
    recordSessionUsage({ ...args(), usage: usage() });
    unlinkSync(join(args().ledgerDir, 'state-test.json'));
    __resetUsageLedgerMemoryForTest();
    add(main, 7); add(worker, 3);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: '', inputTokens: 10,
      models: [{ model: worker, inputTokens: 3 }, { model: main, inputTokens: 7 }] });
  });

  it('classifies the legacy migration interval as unknown instead of assigning old totals to one model', () => {
    add(main, 100); add(worker, 20);
    const { models: _models, ...legacy } = usage();
    recordSessionUsage({ ...args(), usage: { ...legacy, model: worker } });
    add(worker, 10);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: '', inputTokens: 10 });
    add(main, 30);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: main, inputTokens: 30,
      models: [{ model: main, inputTokens: 30 }] });
  });

  it('seeds a legacy model baseline without duplicating usage when migration has no growth', () => {
    add(main, 100);
    const { models: _models, ...legacy } = usage();
    recordSessionUsage({ ...args(), usage: legacy });
    expect(recordSessionUsage({ ...args(), usage: usage() })).toBeNull();
    __resetUsageLedgerMemoryForTest();
    add(worker, 20);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: worker, inputTokens: 20,
      models: [{ model: worker, inputTokens: 20 }] });
  });

  it('anchors history and resets all model baselines when a conversation shrinks', () => {
    add(main, 100); add(worker, 20);
    anchorSessionUsage({ ...args(), usage: usage() });
    add(worker, 10);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: worker, inputTokens: 10,
      models: [{ model: worker, inputTokens: 10 }] });
    db.exec('DELETE FROM gen_metadata'); idx = 0;
    add(main, 10);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toBeNull();
    add(worker, 5);
    expect(recordSessionUsage({ ...args(), usage: usage() })).toMatchObject({ model: worker, inputTokens: 5,
      models: [{ model: worker, inputTokens: 5 }] });
  });

  it('only accepts ACP runtime markers from the exact native conversation and transport', async () => {
    const published: unknown[] = [];
    const scope = { lastInitConfig: { cliId: 'antigravity', cliSessionId: 'exact' }, cliAdapter: { runnerFramedInput: true },
      lastSpawnEffectiveCliSessionId: 'exact', publishActiveRuntime: (r: unknown) => published.push(r),
      rejectCodexAppControlMarker: () => {} };
    const handle = loadWorkerFunction<(kind: string, payload: object) => Promise<boolean>>('handleTrustedCodexAppMarker', scope);
    expect(await handle('runtime', { threadId: 'foreign', model: 'foreign' })).toBe(false);
    expect(await handle('runtime', { threadId: 'exact', model: 'Native Model', reasoningEffort: 'high' })).toBe(true);
    expect(published).toEqual([{ model: 'Native Model', reasoningEffort: 'high' }]);
    scope.cliAdapter.runnerFramedInput = false;
    expect(await handle('runtime', { threadId: 'exact', model: 'untrusted' })).toBe(false);
    expect(published).toHaveLength(1);
  });

  it('leaves a model-vanish interval unclassified while keeping exact cumulative totals', () => {
    recordSessionUsage({ ...args(), usage: mixedSnapshot([['model-a', 100], ['model-b', 50]]) });
    // Aggregate still grows (150→160), so no shrink re-anchor, but model-a
    // vanished: its 100 tokens cannot be subtracted from model-b's delta.
    const record = recordSessionUsage({ ...args(), usage: mixedSnapshot([['model-b', 160]]) })!;
    expect(record.models).toBeUndefined();
    expect(record.model).toBe('');
    expect(record.inputTokens).toBe(10);
    expect(record.modelTotals).toEqual([
      { model: 'model-b', inputTokens: 160, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ]);
  });

  it('leaves a per-model regression interval unclassified instead of billing the new model for all growth', () => {
    recordSessionUsage({ ...args(), usage: mixedSnapshot([['model-a', 100]]) });
    // Aggregate grows 100→110, but model-a alone regressed by 10. Attributing
    // the whole +10 to the new model-b would overstate it by the regression.
    const record = recordSessionUsage({ ...args(), usage: mixedSnapshot([['model-a', 90], ['model-b', 20]]) })!;
    expect(record.models).toBeUndefined();
    expect(record.model).toBe('');
    expect(record.inputTokens).toBe(10);
    expect(record.modelTotals).toHaveLength(2);
  });

  it('rejects persisted model breakdowns that do not conserve the record totals', async () => {
    const dir = join(root, 'ledger'); mkdirSync(dir, { recursive: true });
    const line = (recordId: string, models: unknown) => JSON.stringify({ v: 2, inputTokenSemantics: 'uncached', recordId,
      ts: '2026-11-16T10:00:00.000Z', sessionId: 'audit', larkAppId: 'test', model: '', models,
      inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    const row = (model: string, inputTokens: number) => ({ model, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    appendFileSync(join(dir, 'usage-2026-11-16.jsonl'), [
      line('short', [row(main, 10), row(worker, 10)]),
      line('duplicate', [row(main, 15), row(main, 15)]),
      line('exact', [row(main, 20), row(worker, 10)]),
    ].join('\n') + '\n');
    const report = await query();
    expect(report.coverage.invalidRecords).toBe(2);
    expect(report.summary).toMatchObject({ records: 1, inputTokens: 30 });
    expect(report.models.map(group => [group.id, group.inputTokens])).toEqual([[main, 20], [worker, 10]]);
  });
});
