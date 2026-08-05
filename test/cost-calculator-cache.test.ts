/**
 * Cache/incremental-read tests for cost-calculator's transcript reader.
 *
 * These use REAL files (no fs mocks): the cache layer is keyed on stat()
 * results, which the mocked-fs tests in cost-calculator.test.ts bypass.
 *
 * Run:  pnpm vitest run test/cost-calculator-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    fstatSync: vi.fn(original.fstatSync),
    openSync: vi.fn(original.openSync),
    readFileSync: vi.fn(original.readFileSync),
    readSync: vi.fn(original.readSync),
  };
});

import { constants, fstatSync, mkdtempSync, openSync, writeFileSync, appendFileSync, rmSync, readFileSync, readSync, renameSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/codex-transcript.js', () => ({
  findCodexRolloutBySessionId: vi.fn(),
  findCodexSessionIdByBotmuxSessionId: vi.fn(),
}));

import {
  CODEX_USAGE_TRANSCRIPT_TAIL_BYTES,
  MAX_USAGE_TRANSCRIPT_BYTES,
  USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES,
  getSessionUsageSnapshot,
  readSessionTokenUsageFile,
  __resetSessionUsageCachesForTest,
} from '../src/core/cost-calculator.js';
import { logger } from '../src/utils/logger.js';
import { findCodexRolloutBySessionId } from '../src/services/codex-transcript.js';

function claudeLine(id: string | null, input: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      ...(id ? { id } : {}),
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: input, output_tokens: output },
    },
  });
}

function codexCountLine(
  input: number,
  output: number,
  cacheRead = 0,
  context?: { used: number; window: number },
): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cacheRead },
        ...(context
          ? {
              last_token_usage: { total_tokens: context.used, input_tokens: context.used - output, output_tokens: output },
              model_context_window: context.window,
            }
          : {}),
      },
    },
  });
}

function codexModelLine(model: string): string {
  return JSON.stringify({ type: 'turn_context', payload: { model } });
}

function codexContextLine(used: number, window: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: used, input_tokens: used - 1, output_tokens: 1 },
        model_context_window: window,
      },
    },
  });
}

function writeSparsePrefix(path: string, size: number, lastByte: string): void {
  writeFileSync(path, '');
  truncateSync(path, size - 1);
  appendFileSync(path, lastByte);
}

function codexSnapshotAtTailSize(path: string, line: string, finalSize: number): { baseOffset: number; finalSize: number } {
  const baseOffset = finalSize - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
  const lineBytes = Buffer.byteLength(line);
  expect(lineBytes).toBeLessThan(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES);
  truncateSync(path, baseOffset - 1);
  appendFileSync(path, '\n');
  appendFileSync(path, line);
  appendFileSync(path, Buffer.alloc(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES - lineBytes, 0x20));
  return { baseOffset, finalSize };
}

function codexSnapshotAtTail(path: string, line: string): { baseOffset: number; finalSize: number } {
  return codexSnapshotAtTailSize(path, line, MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1);
}

function writeOversizedCodexSnapshot(path: string, line: string): { baseOffset: number; finalSize: number } {
  writeFileSync(path, '');
  return codexSnapshotAtTail(path, line);
}

function appendLargeCodexDelta(path: string, line: string): void {
  appendFileSync(path, Buffer.alloc(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 128, 0x20));
  appendFileSync(path, `\n${line}\n`);
}

function expectBoundedTailRead(baseOffset: number): void {
  const calls = vi.mocked(readSync).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const positions = calls.map((call) => Number(call[4])).filter(Number.isFinite);
  expect(Math.min(...positions)).toBe(baseOffset - 1);
  expect(calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === baseOffset - 1)).toBe(true);
  const requestedBytes = calls.reduce((sum, call) => sum + Number(call[3]), 0);
  expect(requestedBytes).toBeLessThanOrEqual(
    CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1 + USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES,
  );
}

function expectLargeDeltaBoundedTailRead(baseOffset: number): void {
  const calls = vi.mocked(readSync).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === baseOffset - 1)).toBe(true);
  const requestedBytes = calls.reduce((sum, call) => sum + Number(call[3]), 0);
  expect(requestedBytes).toBeLessThanOrEqual(
    USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES
    + 1
    + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES
    + USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES,
  );
}

function fileSize(path: string): number {
  return statSync(path).size;
}

let dir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-cache-'));
  __resetSessionUsageCachesForTest();
  now = 1_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(fstatSync).mockClear();
  vi.mocked(openSync).mockClear();
  vi.mocked(readFileSync).mockClear();
  vi.mocked(readSync).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(findCodexRolloutBySessionId).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('readSessionTokenUsageFile caching', () => {
  it('cold reads avoid readFileSync whole-file fallback for large transcripts', () => {
    const p = join(dir, 'large.jsonl');
    const hugeId = 'msg_' + 'x'.repeat(70_000);
    writeFileSync(p, `${claudeLine(hugeId, 123, 45)}\n`);

    const usage = readSessionTokenUsageFile(p, 'claude');

    expect(usage).toMatchObject({ inputTokens: 123, outputTokens: 45, turns: 1 });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('returns the cached result object while the file is unchanged', () => {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);

    const first = readSessionTokenUsageFile(p, 'claude');
    const second = readSessionTokenUsageFile(p, 'claude');

    expect(first).toMatchObject({ in: 100, out: 10, turns: 1 });
    // Identity equality ⇒ the second call hit the cache, no reparse.
    expect(second).toBe(first);
  });

  it('folds appended lines incrementally without rereading old bytes', () => {
    const p = join(dir, 's.jsonl');
    const original = `${claudeLine('msg_a', 100, 10)}\n`;
    writeFileSync(p, original);
    readSessionTokenUsageFile(p, 'claude');

    // Rewrite the already-parsed prefix in place, byte length preserved
    // (100→999). An incremental reader must never see this; a full reparse
    // would. Then append a new line so the file grows.
    const tampered = original.replace('"input_tokens":100', '"input_tokens":999');
    expect(tampered.length).toBe(original.length);
    writeFileSync(p, tampered + `${claudeLine('msg_b', 200, 20)}\n`);

    now += 20_000; // get past the reparse throttle
    const second = readSessionTokenUsageFile(p, 'claude');

    expect(second).toMatchObject({ inputTokens: 300, outputTokens: 30, turns: 2 });
  });

  it('does not add a frontier fingerprint store probe to non-Codex incremental cache writes', () => {
    const p = join(dir, 'claude-no-fingerprint-probe.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);
    readSessionTokenUsageFile(p, 'claude');

    vi.mocked(readSync).mockClear();
    const appended = `${claudeLine('msg_b', 200, 20)}\n`;
    appendFileSync(p, appended);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'claude', { fresh: true })).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      turns: 2,
    });
    const requestedBytes = vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + Number(call[3]), 0);
    expect(requestedBytes).toBe(Buffer.byteLength(appended));
  });

  it('throttles reparsing of a file that keeps changing', () => {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);
    const first = readSessionTokenUsageFile(p, 'claude');

    appendFileSync(p, `${claudeLine('msg_b', 200, 20)}\n`);
    now += 5_000; // still inside the throttle window
    expect(readSessionTokenUsageFile(p, 'claude')).toBe(first);

    now += 11_000; // past the throttle window
    expect(readSessionTokenUsageFile(p, 'claude')).toMatchObject({ turns: 2, inputTokens: 300 });
  });

  it('reparses from scratch when the file shrinks (rotation/truncation)', () => {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n${claudeLine('msg_b', 200, 20)}\n`);
    expect(readSessionTokenUsageFile(p, 'claude')).toMatchObject({ turns: 2 });

    now += 20_000;
    writeFileSync(p, `${claudeLine('msg_c', 7, 3)}\n`);
    expect(readSessionTokenUsageFile(p, 'claude')).toMatchObject({ turns: 1, inputTokens: 7, outputTokens: 3 });
  });

  it('counts an unterminated tail line once, not twice after it is terminated', () => {
    const p = join(dir, 's.jsonl');
    // msg_b is complete JSON but has no trailing newline yet — and no id, so
    // a double fold would visibly double count it.
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n${claudeLine(null, 200, 20)}`);
    const first = readSessionTokenUsageFile(p, 'claude');
    expect(first).toMatchObject({ turns: 2, inputTokens: 300, outputTokens: 30 });

    now += 20_000;
    appendFileSync(p, `\n${claudeLine('msg_c', 1, 1)}\n`);
    const second = readSessionTokenUsageFile(p, 'claude');
    expect(second).toMatchObject({ turns: 3, inputTokens: 301, outputTokens: 31 });
  });

  it('handles a large unterminated tail line without rereading the whole transcript', () => {
    const p = join(dir, 'tail.jsonl');
    const hugeId = 'msg_' + 'y'.repeat(70_000);
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n${claudeLine(hugeId, 200, 20)}`);

    const first = readSessionTokenUsageFile(p, 'claude');
    expect(first).toMatchObject({ turns: 2, inputTokens: 300, outputTokens: 30 });

    now += 20_000;
    appendFileSync(p, `\n${claudeLine('msg_c', 1, 1)}\n`);
    const second = readSessionTokenUsageFile(p, 'claude');
    expect(second).toMatchObject({ turns: 3, inputTokens: 301, outputTokens: 31 });
  });

  it('fresh:true bypasses the reparse throttle but keeps incremental folding', () => {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);
    const first = readSessionTokenUsageFile(p, 'claude');
    expect(first).toMatchObject({ turns: 1 });

    appendFileSync(p, `${claudeLine('msg_b', 200, 20)}\n`);
    now += 5_000; // inside the throttle window
    // Default read serves the stale cache; a fresh read must not.
    expect(readSessionTokenUsageFile(p, 'claude')).toBe(first);
    expect(readSessionTokenUsageFile(p, 'claude', { fresh: true })).toMatchObject({
      turns: 2,
      inputTokens: 300,
    });
  });

  it('keeps codex cumulative semantics across incremental reads', () => {
    const p = join(dir, 'rollout.jsonl');
    writeFileSync(p, `${codexCountLine(100, 20, 40)}\n`);
    expect(readSessionTokenUsageFile(p, 'codex')).toMatchObject({
      in: 100,
      inputTokens: 60,
      cacheReadTokens: 40,
      out: 20,
    });

    now += 20_000;
    appendFileSync(p, `${codexCountLine(150, 30, 60)}\n`);
    // Latest cumulative snapshot wins — not 100+150.
    expect(readSessionTokenUsageFile(p, 'codex')).toMatchObject({
      in: 150,
      inputTokens: 90,
      cacheReadTokens: 60,
      out: 30,
    });
  });

  it('cold reads an oversized Codex transcript from a bounded tail window', () => {
    const p = join(dir, 'oversized-codex.jsonl');
    writeFileSync(p, '');
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 1);
    appendFileSync(p, [
      '',
      codexModelLine('gpt-5.5-codex'),
      codexCountLine(3_739_570, 23_299, 3_563_008, { used: 160_240, window: 258_400 }),
      '',
    ].join('\n'));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({
      context: { usedTokens: 160_240, windowTokens: 258_400, percentUsed: 62 },
      tokens: {
        in: 3_739_570,
        out: 23_299,
        inputTokens: 176_562,
        outputTokens: 23_299,
        cacheReadTokens: 3_563_008,
        cacheCreateTokens: 0,
        model: 'gpt-5.5-codex',
        turns: 0,
      },
      turnTokens: null,
    });
    expect(readFileSync).not.toHaveBeenCalled();
    expectBoundedTailRead(fileSize(p) - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES);
  });

  it('keeps the first Codex tail record when the bounded start is on a line boundary', () => {
    const p = join(dir, 'codex-tail-line-boundary.jsonl');
    const firstTailLine = `${codexCountLine(400, 50, 25, { used: 120, window: 1_000 })}\n`;
    const paddingBytes = CODEX_USAGE_TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(firstTailLine);
    expect(paddingBytes).toBeGreaterThan(0);
    writeSparsePrefix(p, MAX_USAGE_TRANSCRIPT_BYTES + 1, '\n');
    appendFileSync(p, firstTailLine);
    appendFileSync(p, Buffer.alloc(paddingBytes, 0x20));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 120, windowTokens: 1_000, percentUsed: 12 },
      tokens: { in: 400, out: 50, inputTokens: 375, cacheReadTokens: 25 },
      turnTokens: null,
    });
  });

  it('drops the first Codex tail record when the bounded start is inside a line', () => {
    const p = join(dir, 'codex-tail-mid-line.jsonl');
    const residualLine = `${codexCountLine(999_999, 999, 0, { used: 999, window: 1_000 })}\n`;
    const paddingBytes = CODEX_USAGE_TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(residualLine);
    expect(paddingBytes).toBeGreaterThan(0);
    writeSparsePrefix(p, MAX_USAGE_TRANSCRIPT_BYTES + 1, 'x');
    appendFileSync(p, residualLine);
    appendFileSync(p, Buffer.alloc(paddingBytes, 0x20));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
  });

  it('does not turn an unterminated initial residual tail into a Codex snapshot after only a newline append', () => {
    const p = join(dir, 'codex-tail-unterminated-residual.jsonl');
    const residualJson = codexCountLine(999_999, 999, 0, { used: 999, window: 1_000 });
    const paddingBytes = CODEX_USAGE_TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(residualJson);
    expect(paddingBytes).toBeGreaterThan(0);
    writeSparsePrefix(p, MAX_USAGE_TRANSCRIPT_BYTES + 1, 'x');
    appendFileSync(p, residualJson);
    appendFileSync(p, Buffer.alloc(paddingBytes, 0x20));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });

    vi.mocked(readSync).mockClear();
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();

    appendFileSync(p, '\n');
    now += 20_000;
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
  });

  it('caches a no-snapshot Codex tail over an existing snapshot without enabling incremental reuse', () => {
    const p = join(dir, 'codex-large-delta-no-snapshot.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    appendLargeCodexDelta(p, JSON.stringify({ type: 'event_msg', payload: { type: 'notice' } }));
    now += 20_000;
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    vi.mocked(readSync).mockClear();
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });

  it('preserves cached cumulative tokens when a large Codex tail only has context', () => {
    const p = join(dir, 'codex-context-only-large-delta.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    appendLargeCodexDelta(p, codexContextLine(240, 1_000));
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: { in: 100, out: 10, inputTokens: 80, cacheReadTokens: 20 },
    });
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 100,
      out: 10,
    });
  });

  it('preserves cached context when a large Codex tail only has cumulative tokens', () => {
    const p = join(dir, 'codex-cumulative-only-large-delta.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30, windowTokens: 1_000, percentUsed: 3 },
      tokens: { in: 100, out: 10 },
    });

    appendLargeCodexDelta(p, codexCountLine(500, 60, 200));
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30, windowTokens: 1_000, percentUsed: 3 },
      tokens: { in: 500, out: 60, inputTokens: 300, cacheReadTokens: 200 },
    });
  });

  it('does not inherit Codex metrics from an offset-zero cache after the file becomes oversized', () => {
    const p = join(dir, 'codex-offset-zero-to-oversized.jsonl');
    writeFileSync(p, codexCountLine(100, 10, 20, { used: 30, window: 1_000 }));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    writeOversizedCodexSnapshot(p, `${codexContextLine(240, 1_000)}\n`);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: null,
      turnTokens: null,
    });
  });

  it('re-bootstraps oversized Codex transcripts when the unread cache delta exceeds the tail budget', () => {
    const p = join(dir, 'codex-cache-large-delta.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    vi.mocked(readSync).mockClear();
    appendLargeCodexDelta(p, codexCountLine(500, 60, 200, { used: 240, window: 1_000 }));
    const baseOffset = fileSize(p) - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: { in: 500, out: 60, inputTokens: 300, cacheReadTokens: 200 },
    });
    expectLargeDeltaBoundedTailRead(baseOffset);
  });

  it('continues incrementally after an oversized Codex cold tail bootstrap when the append is small', () => {
    const p = join(dir, 'codex-small-append-after-tail.jsonl');
    writeSparsePrefix(p, MAX_USAGE_TRANSCRIPT_BYTES + 1, '\n');
    appendFileSync(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    vi.mocked(readSync).mockClear();
    const appended = `${codexCountLine(150, 20, 50, { used: 70, window: 1_000 })}\n`;
    appendFileSync(p, appended);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 70, windowTokens: 1_000, percentUsed: 7 },
      tokens: { in: 150, out: 20, inputTokens: 100, cacheReadTokens: 50 },
    });
    const requestedBytes = vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + Number(call[3]), 0);
    expect(requestedBytes).toBeLessThanOrEqual(
      USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES
      + Buffer.byteLength(appended)
      + USAGE_TRANSCRIPT_FRONTIER_FINGERPRINT_BYTES,
    );
  });

  it('rebuilds Codex usage when a same-size transcript is rename-replaced', () => {
    const p = join(dir, 'codex-rename-replace.jsonl');
    const firstLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const { finalSize } = writeOversizedCodexSnapshot(p, firstLine);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    const replacement = join(dir, 'codex-rename-replace-new.jsonl');
    writeOversizedCodexSnapshot(replacement, `${codexCountLine(999, 90, 300, { used: 400, window: 1_000 })}\n`);
    truncateSync(replacement, finalSize);
    renameSync(replacement, p);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 90,
      inputTokens: 699,
      cacheReadTokens: 300,
    });
  });

  it('does not inherit old cumulative tokens when a replacement Codex generation only has context', () => {
    const p = join(dir, 'codex-replace-context-only.jsonl');
    const { finalSize } = writeOversizedCodexSnapshot(
      p,
      `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`,
    );
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    const replacement = join(dir, 'codex-replace-context-only-new.jsonl');
    writeOversizedCodexSnapshot(replacement, `${codexContextLine(240, 1_000)}\n`);
    truncateSync(replacement, finalSize);
    renameSync(replacement, p);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: null,
      turnTokens: null,
    });
  });

  it('does not inherit old context when a replacement Codex generation only has cumulative tokens', () => {
    const p = join(dir, 'codex-replace-cumulative-only.jsonl');
    const { finalSize } = writeOversizedCodexSnapshot(
      p,
      `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`,
    );
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30 },
      tokens: { in: 100, out: 10 },
    });

    const replacement = join(dir, 'codex-replace-cumulative-only-new.jsonl');
    writeOversizedCodexSnapshot(replacement, `${codexCountLine(500, 60, 200)}\n`);
    truncateSync(replacement, finalSize);
    renameSync(replacement, p);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({
      context: null,
      tokens: {
        in: 500,
        out: 60,
        inputTokens: 300,
        outputTokens: 60,
        cacheReadTokens: 200,
        cacheCreateTokens: 0,
        model: '',
        turns: 0,
      },
      turnTokens: null,
    });
  });

  it('rebuilds Codex usage when the same inode is rewritten to the same size', () => {
    const p = join(dir, 'codex-same-inode-same-size.jsonl');
    const firstLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const { finalSize } = writeOversizedCodexSnapshot(p, firstLine);
    const firstStat = statSync(p);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    codexSnapshotAtTail(p, `${codexCountLine(777, 70, 300, { used: 400, window: 1_000 })}\n`);
    truncateSync(p, finalSize);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 777,
      out: 70,
      inputTokens: 477,
      cacheReadTokens: 300,
    });
  });

  it('rebuilds Codex usage when the same inode is rewritten and grows slightly', () => {
    const p = join(dir, 'codex-same-inode-grows.jsonl');
    const firstLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const { finalSize } = writeOversizedCodexSnapshot(p, firstLine);
    const firstStat = statSync(p);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    codexSnapshotAtTailSize(p, `${codexCountLine(888, 80, 300, { used: 400, window: 1_000 })}\n`, finalSize + 128);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 888,
      out: 80,
      inputTokens: 588,
      cacheReadTokens: 300,
    });
  });

  it('uses nonblocking regular-file checks for the Codex tail boundary probe and fails closed on non-regular fds', () => {
    const p = join(dir, 'codex-boundary-probe-fail-closed.jsonl');
    const firstTailLine = `${codexCountLine(400, 50, 25, { used: 120, window: 1_000 })}\n`;
    writeOversizedCodexSnapshot(p, firstTailLine);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 120, windowTokens: 1_000, percentUsed: 12 },
      tokens: { in: 400, out: 50, inputTokens: 375, cacheReadTokens: 25 },
      turnTokens: null,
    });

    __resetSessionUsageCachesForTest();
    vi.mocked(fstatSync).mockImplementationOnce(() => ({ isFile: () => false }) as any);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
    expect(vi.mocked(openSync).mock.calls.some(([, flags]) => {
      return typeof flags === 'number' && (flags & constants.O_NONBLOCK) === constants.O_NONBLOCK;
    })).toBe(true);
  });

  it('skips oversized transcripts instead of scanning them from byte zero', () => {
    const p = join(dir, 'oversized.jsonl');
    writeFileSync(p, '');
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 1);

    expect(readSessionTokenUsageFile(p, 'coco')).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping token usage scan for oversized transcript'));
  });

  it('keeps the cached usage if a transcript grows past the scan cap', () => {
    const p = join(dir, 'grows-too-large.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);
    const first = readSessionTokenUsageFile(p, 'claude');
    expect(first).toMatchObject({ turns: 1, inputTokens: 100 });

    now += 20_000;
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 1);

    expect(readSessionTokenUsageFile(p, 'claude', { fresh: true })).toBe(first);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping token usage scan for oversized transcript'));
  });

  it('warns once per oversized transcript even as it keeps growing', () => {
    const p = join(dir, 'still-growing.jsonl');
    writeFileSync(p, '');
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 1);
    expect(readSessionTokenUsageFile(p, 'coco')).toBeNull();

    now += 20_000;
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 4096);
    expect(readSessionTokenUsageFile(p, 'coco', { fresh: true })).toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not evict unrelated cached entries for a new non-Codex oversized transcript', () => {
    const firstPath = join(dir, 'cached-0.jsonl');
    writeFileSync(firstPath, `${claudeLine('msg_0', 1, 1)}\n`);
    const first = readSessionTokenUsageFile(firstPath, 'claude');
    expect(first).toMatchObject({ turns: 1, inputTokens: 1 });

    for (let i = 1; i < 512; i++) {
      const p = join(dir, `cached-${i}.jsonl`);
      writeFileSync(p, `${claudeLine(`msg_${i}`, i + 1, 1)}\n`);
      expect(readSessionTokenUsageFile(p, 'claude')).toMatchObject({ turns: 1 });
    }

    const oversized = join(dir, 'new-oversized-coco.jsonl');
    writeFileSync(oversized, '');
    truncateSync(oversized, MAX_USAGE_TRANSCRIPT_BYTES + 1);
    expect(readSessionTokenUsageFile(oversized, 'coco')).toBeNull();

    expect(readSessionTokenUsageFile(firstPath, 'claude')).toBe(first);
  });

  it('returns null and drops the cache entry when the file disappears', () => {
    const p = join(dir, 's.jsonl');
    writeFileSync(p, `${claudeLine('msg_a', 100, 10)}\n`);
    expect(readSessionTokenUsageFile(p, 'claude')).toMatchObject({ turns: 1 });

    now += 20_000;
    rmSync(p);
    expect(readSessionTokenUsageFile(p, 'claude')).toBeNull();
  });
});
