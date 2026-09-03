/**
 * Usage ledger cost tests — costCny on positive-delta records (priced models
 * only, fail-closed) plus the pricing-resolver / record-sink seams that wire
 * the ledger into cost governance.
 *
 * Run:  pnpm vitest run test/usage-ledger-cost.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
}));

import {
  recordSessionUsage,
  recordSessionOwnership,
  setUsageLedgerPricingResolver,
  setUsageLedgerRecordSink,
  __resetUsageLedgerMemoryForTest,
  type UsageLedgerRecord,
} from '../src/services/usage-ledger.js';
import type { SessionTokenUsage } from '../src/core/cost-calculator.js';

function cumulative(input: number, output: number, cacheRead = 0, cacheCreate = 0, model = 'claude-sonnet-4'): SessionTokenUsage {
  return {
    in: input + cacheRead + cacheCreate,
    out: output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    model,
    turns: 1,
  };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'cli_app',
    sessionId: 'sess-1',
    cliId: 'claude-code',
    cliSessionId: 'cli-sess-1',
    now: new Date('2026-08-21T12:00:00Z'),
    ...overrides,
  };
}

function ledgerLines(dir: string): UsageLedgerRecord[] {
  const content = readFileSync(join(dir, 'usage-2026-08-21.jsonl'), 'utf8');
  return content.trim().split('\n').map((l) => JSON.parse(l));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-ledger-cost-'));
  __resetUsageLedgerMemoryForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('costCny on records', () => {
  it('prices a delta record with explicit pricing (claude-sonnet-4 built-in table)', () => {
    // (1e6*$3 + 5e5*$15)/1M = $10.5 → *7.2 = ¥75.6
    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    expect(rec!.costCny).toBeCloseTo(75.6, 6);
    // Persisted to the ledger line as well.
    expect(ledgerLines(dir)[0].costCny).toBeCloseTo(75.6, 6);
  });

  it('prices cache buckets with their own rates', () => {
    // cacheRead $0.3/1M → 1e6 * 0.3/1M * 7.2 = ¥2.16
    const read = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(0, 0, 1_000_000),
      pricing: { usdCny: 7.2 },
    });
    expect(read!.costCny).toBeCloseTo(2.16, 6);

    // cacheWrite $3.75/1M → 1e6 * 3.75/1M * 7.2 = ¥27
    // 必须单调累计：cacheRead 缩量会触发 shrink 守卫返回 null
    const write = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(0, 0, 1_000_000, 1_000_000),
      pricing: { usdCny: 7.2 },
    });
    expect(write!.costCny).toBeCloseTo(27, 6);
  });

  it('prices each record by delta, not cumulative snapshot', () => {
    // 第一条：(1e6*$3 + 5e5*$15)/1M = $10.5 → ¥75.6
    recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    // 第二条累计 (2e6, 6e5)，delta 为 (1e6, 1e5)：
    // (1e6*$3 + 1e5*$15)/1M = $4.5 → ¥32.4（而非累计口径的 ¥108）
    const second = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(2_000_000, 600_000),
      pricing: { usdCny: 7.2 },
    });
    expect(second!.costCny).toBeCloseTo(32.4, 6);
    expect(ledgerLines(dir)[1].costCny).toBeCloseTo(32.4, 6);
  });

  it('omits costCny without pricing or resolver', () => {
    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
    });
    expect(rec!.costCny).toBeUndefined();
    expect(ledgerLines(dir)[0].costCny).toBeUndefined();
  });

  it('omits costCny for an unpriced model even with pricing', () => {
    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000, 0, 0, 'grok-2-unknown'),
      pricing: { usdCny: 7.2 },
    });
    expect(rec!.costCny).toBeUndefined();
  });

  it('resolves pricing via the process-level resolver and passes larkAppId', () => {
    const resolver = vi.fn(() => ({ usdCny: 7.2 }));
    setUsageLedgerPricingResolver(resolver);

    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
    });
    expect(resolver).toHaveBeenCalledWith('cli_app');
    expect(rec!.costCny).toBeCloseTo(75.6, 6);
  });

  it('explicit args.pricing wins over the resolver', () => {
    const resolver = vi.fn(() => ({ usdCny: 99 }));
    setUsageLedgerPricingResolver(resolver);

    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(rec!.costCny).toBeCloseTo(75.6, 6);
  });
});

describe('record sink', () => {
  it('fires exactly once per positive-delta record with the full record', () => {
    const sink = vi.fn();
    setUsageLedgerRecordSink(sink);

    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(rec);
    expect(sink.mock.calls[0][0].costCny).toBeCloseTo(75.6, 6);

    // Zero-delta record → no sink call.
    expect(recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    })).toBeNull();
    expect(sink).toHaveBeenCalledTimes(1);

    // Next positive delta → one more call.
    recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(2_000_000, 600_000),
      pricing: { usdCny: 7.2 },
    });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('does not fire for ownership markers', () => {
    const sink = vi.fn();
    setUsageLedgerRecordSink(sink);

    recordSessionOwnership({ ...baseArgs(), ledgerDir: dir });
    expect(sink).not.toHaveBeenCalled();
  });

  it('survives a throwing sink: the record still lands', () => {
    const sink = vi.fn(() => { throw new Error('boom'); });
    setUsageLedgerRecordSink(sink);

    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    expect(rec).not.toBeNull();
    expect(ledgerLines(dir)).toHaveLength(1);
    expect(ledgerLines(dir)[0].costCny).toBeCloseTo(75.6, 6);
  });

  it('can be disabled with null', () => {
    const sink = vi.fn();
    setUsageLedgerRecordSink(sink);
    setUsageLedgerRecordSink(null);

    recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
      pricing: { usdCny: 7.2 },
    });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('__resetUsageLedgerMemoryForTest', () => {
  it('clears both the resolver and the sink', () => {
    const resolver = vi.fn(() => ({ usdCny: 7.2 }));
    const sink = vi.fn();
    setUsageLedgerPricingResolver(resolver);
    setUsageLedgerRecordSink(sink);

    __resetUsageLedgerMemoryForTest();

    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(1_000_000, 500_000),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(rec!.costCny).toBeUndefined();
  });
});
