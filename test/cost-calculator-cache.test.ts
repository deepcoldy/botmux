/**
 * Cache/incremental-read tests for cost-calculator's transcript reader.
 *
 * These use REAL files (no fs mocks): the cache layer is keyed on stat()
 * results, which the mocked-fs tests in cost-calculator.test.ts bypass.
 *
 * Run:  pnpm vitest run test/cost-calculator-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('node:fs', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const original = require('node:fs') as typeof import('node:fs');
  return {
    ...original,
    fstatSync: vi.fn(original.fstatSync),
    openSync: vi.fn(original.openSync),
    readFileSync: vi.fn(original.readFileSync),
    readSync: vi.fn(original.readSync),
    statSync: vi.fn(original.statSync),
  };
});

import { closeSync, constants, fstatSync, mkdtempSync, openSync, writeFileSync, appendFileSync, rmSync, readFileSync, readSync, renameSync, statSync, truncateSync, utimesSync, writeSync } from 'node:fs';
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
  CODEX_USAGE_MAX_BACKSCAN_BYTES,
  CODEX_USAGE_TRANSCRIPT_TAIL_BYTES,
  MAX_USAGE_TRANSCRIPT_BYTES,
  getSessionUsageSnapshot,
  readSessionTokenUsageFile,
  __resetSessionUsageCachesForTest,
} from '../src/core/cost-calculator.js';
import { logger } from '../src/utils/logger.js';
import { findCodexRolloutBySessionId } from '../src/services/codex-transcript.js';

const TEST_FRONTIER_BYTES = 64;

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

function codexSnapshotInsideTail(path: string, line: string, leadBytes: number, finalSize: number): { lineOffset: number; finalSize: number } {
  const baseOffset = finalSize - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
  const lineOffset = baseOffset + leadBytes;
  const lineBytes = Buffer.byteLength(line);
  expect(lineBytes + leadBytes).toBeLessThan(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES);
  truncateSync(path, lineOffset - 1);
  appendFileSync(path, '\n');
  appendFileSync(path, line);
  appendFileSync(path, Buffer.alloc(finalSize - lineOffset - lineBytes, 0x20));
  return { lineOffset, finalSize };
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
    CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1,
  );
}

function expectLargeDeltaBoundedTailRead(baseOffset: number): void {
  const calls = vi.mocked(readSync).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === baseOffset - 1)).toBe(true);
  const requestedBytes = calls.reduce((sum, call) => sum + Number(call[3]), 0);
  expect(requestedBytes).toBeLessThanOrEqual(
    1
    + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES,
  );
}

function expectCodexTrackedReplayRead(replayOffset: number, replayBytes: number): void {
  const calls = vi.mocked(readSync).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const requestedBytes = calls.reduce((sum, call) => sum + Number(call[3]), 0);
  if (replayOffset > 0) {
    expect(calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === replayOffset - 1)).toBe(true);
  }
  const positions = calls.map((call) => Number(call[4])).filter(Number.isFinite);
  expect(Math.min(...positions)).toBe(replayOffset > 0 ? replayOffset - 1 : replayOffset);
  expect(calls.some((call) => Number(call[4]) === replayOffset && Number(call[3]) > 1)).toBe(true);
  expect(requestedBytes).toBeLessThanOrEqual(
    (replayOffset > 0 ? 1 : 0)
    + replayBytes,
  );
}

function requestedBytes(): number {
  return vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + Number(call[3]), 0);
}

function fileSize(path: string): number {
  return statSync(path).size;
}

function readBytesAt(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, offset);
    return Buffer.from(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

function writeBytesAt(path: string, offset: number, content: string): void {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.from(content), 0, Buffer.byteLength(content), offset);
  } finally {
    closeSync(fd);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  vi.mocked(statSync).mockClear();
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

  it('keeps normal-size Codex appends incremental instead of rereading from byte zero', () => {
    const p = join(dir, 'codex-normal-size-incremental.jsonl');
    const initialLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    writeFileSync(p, initialLine);
    appendFileSync(p, `${'x'.repeat(2 * 1024 * 1024)}\n`);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 100,
      out: 10,
    });

    vi.mocked(readSync).mockClear();
    const appended = `${codexCountLine(150, 20, 50, { used: 70, window: 1_000 })}\n`;
    appendFileSync(p, appended);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({
      context: { usedTokens: 70, windowTokens: 1_000, percentUsed: 7 },
      tokens: {
        in: 150,
        out: 20,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheCreateTokens: 0,
        model: '',
        turns: 0,
      },
      turnTokens: null,
    });
    expectCodexTrackedReplayRead(0, fileSize(p));
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

  it('ignores non-metric Codex lines while tracking metric source records', () => {
    const p = join(dir, 'codex-lazy-source-hash.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'notice', message: 'ignored' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'other', info: { total_token_usage: { input_tokens: 1 } } } }),
      codexCountLine(100, 10, 20, { used: 30, window: 1_000 }),
      '',
    ].join('\n'));

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 100,
      out: 10,
      inputTokens: 80,
      cacheReadTokens: 20,
    });
    const ignoredOnly = join(dir, 'codex-ignored-only.jsonl');
    writeFileSync(ignoredOnly, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'notice', message: 'ignored' } }),
      JSON.stringify({ type: 'session_meta', payload: { cwd: dir } }),
      '',
    ].join('\n'));

    expect(readSessionTokenUsageFile(ignoredOnly, 'codex', { fresh: true })).toBeNull();
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

  it('recovers usage by widening the back-scan when a large Codex tail has no snapshot', () => {
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

    // A single >4MiB non-snapshot burst (e.g. one huge tool output) pushes the
    // only token_count snapshot out of the first tail window. Rather than
    // collapsing the usage card to null, the reader widens the back-scan until
    // it recovers the true latest usage from the earlier snapshot.
    appendLargeCodexDelta(p, JSON.stringify({ type: 'event_msg', payload: { type: 'notice' } }));
    now += 20_000;
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30, windowTokens: 1_000, percentUsed: 3 },
      tokens: { in: 100, out: 10 },
    });
  });

  it('widens the back-scan to recover a snapshot past the fast-path tail window', () => {
    // Snapshot sits ~10MiB from EOF (outside the 4MiB fast-path window) behind a
    // big non-snapshot burst. The fast path misses, so the reader does one
    // bounded widen to the back-scan budget and recovers it.
    const p = join(dir, 'codex-backscan-multi-window.jsonl');
    const snapshot = `${codexCountLine(321, 32, 100, { used: 210, window: 1_000 })}\n`;
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + 12 * 1024 * 1024;
    const snapshotOffset = finalSize - 10 * 1024 * 1024;
    writeFileSync(p, '');
    truncateSync(p, snapshotOffset - 1);
    appendFileSync(p, '\n');
    appendFileSync(p, snapshot);
    appendFileSync(p, Buffer.alloc(finalSize - fileSize(p), 0x20));
    expect(fileSize(p)).toBe(finalSize);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 210, windowTokens: 1_000, percentUsed: 21 },
      tokens: { in: 321, out: 32, inputTokens: 221, cacheReadTokens: 100 },
    });
  });

  it('widens to recover the model when the cached read had one but the tail window does not', () => {
    // Model rides on turn_context lines. Warm read captured a model, so the
    // session is known to carry one; when a >4MiB burst pushes it (and the last
    // model line) out of the fast tail window, the widen must re-scan far enough
    // to recover the model — not ship "" to the ledger, and not inherit it
    // blindly (see the model-switch test for why inheritance is wrong).
    const p = join(dir, 'codex-model-widen-recover.jsonl');
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1;
    const baseOffset = finalSize - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
    writeFileSync(p, '');
    truncateSync(p, baseOffset - 1);
    appendFileSync(p, '\n');
    appendFileSync(p, `${codexModelLine('gpt-5-codex')}\n`);
    appendFileSync(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    appendFileSync(p, Buffer.alloc(finalSize - fileSize(p), 0x20));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({ tokens: { in: 100, out: 10, model: 'gpt-5-codex' } });

    // >4MiB non-snapshot burst then a new token_count with NO model line.
    appendFileSync(p, Buffer.alloc(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 8192, 0x20));
    appendFileSync(p, `${codexCountLine(500, 60, 200, { used: 240, window: 1_000 })}\n`);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: { in: 500, out: 60, model: 'gpt-5-codex' },
    });
  });

  it('recovers the SWITCHED model (not the stale one) when a burst pushes it out of the tail window', () => {
    // Append-only model switch: old-model → new-model, then a >4MiB burst pushes
    // new-model out of the fast tail window, then EOF token_count with no model.
    // The widen must recover new-model (latest wins); inheriting the cached
    // old-model would mis-price the ledger — worse than "unknown".
    const p = join(dir, 'codex-model-switch.jsonl');
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1;
    const baseOffset = finalSize - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
    writeFileSync(p, '');
    truncateSync(p, baseOffset - 1);
    appendFileSync(p, '\n');
    appendFileSync(p, `${codexModelLine('old-model')}\n`);
    appendFileSync(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    appendFileSync(p, Buffer.alloc(finalSize - fileSize(p), 0x20));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({ tokens: { in: 100, out: 10, model: 'old-model' } });

    appendFileSync(p, `${codexModelLine('new-model')}\n`);
    appendFileSync(p, Buffer.alloc(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 8192, 0x20));
    appendFileSync(p, `${codexCountLine(500, 60, 200, { used: 240, window: 1_000 })}\n`);
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      tokens: { in: 500, out: 60, model: 'new-model' },
    });
  });

  it('bounds the back-scan and does not walk the whole file when no snapshot is within budget', () => {
    // The only snapshot is further from EOF than the back-scan budget. The read
    // must stop widening at CODEX_USAGE_MAX_BACKSCAN_BYTES (never scanning back
    // to the snapshot) and, with no cached value to fall back to, yield null.
    const p = join(dir, 'codex-backscan-budget-exceeded.jsonl');
    const snapshot = `${codexCountLine(777, 70, 50, { used: 300, window: 1_000 })}\n`;
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_MAX_BACKSCAN_BYTES + 8 * 1024 * 1024;
    const snapshotOffset = finalSize - CODEX_USAGE_MAX_BACKSCAN_BYTES - 4 * 1024 * 1024;
    writeFileSync(p, '');
    truncateSync(p, snapshotOffset - 1);
    appendFileSync(p, '\n');
    appendFileSync(p, snapshot);
    appendFileSync(p, Buffer.alloc(finalSize - fileSize(p), 0x20));
    expect(fileSize(p)).toBe(finalSize);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);

    vi.mocked(readSync).mockClear();
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
    // Never reads at or before the snapshot: the deepest read stays within the
    // bounded back-scan budget from EOF.
    const minReadPos = Math.min(
      ...vi.mocked(readSync).mock.calls.map((call) => Number(call[4])).filter(Number.isFinite),
    );
    expect(minReadPos).toBeGreaterThan(snapshotOffset);
    // Worst-case synchronous read is a single fast-path tail window plus ONE
    // bounded widen — NOT a 4/8/.../32 ladder (which would total 144MiB). Pin
    // the ceiling so a future change cannot silently reintroduce cumulative
    // re-scans. Chunk/probe overhead is tiny next to the multi-MiB windows.
    expect(requestedBytes()).toBeLessThanOrEqual(
      CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + CODEX_USAGE_MAX_BACKSCAN_BYTES + 64 * 1024,
    );
  });

  it('does not inherit warm Codex usage across a burst that exceeds the back-scan budget', () => {
    // Warm cache holds in=555. A later burst larger than the whole back-scan
    // budget leaves no snapshot reachable within budget. We must NOT resurrect
    // the stale value across what could be a rewritten generation — the bounded
    // rebuild yields null rather than a possibly-invalid inherited value. (This
    // is the fail-closed boundary; the common warm case is recovered by the
    // back-scan itself, exercised in the widening tests above.)
    const p = join(dir, 'codex-backscan-budget-no-inherit.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(555, 55, 30, { used: 400, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({ tokens: { in: 555, out: 55 } });

    appendFileSync(p, Buffer.alloc(CODEX_USAGE_MAX_BACKSCAN_BYTES + 8 * 1024 * 1024, 0x20));
    now += 20_000;

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
  });

  it('recovers earlier cumulative tokens by widening the back-scan when a large Codex tail only has context', () => {
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

    // The tail window only carries the new context snapshot; the cumulative
    // metric lives on the earlier line, so the reader widens the back-scan and
    // keeps the true latest of BOTH instead of dropping cumulative tokens.
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: { in: 100, out: 10 },
    });
  });

  it('recovers earlier context by widening the back-scan when a large Codex tail only has cumulative tokens', () => {
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

    // The tail window only carries the new cumulative snapshot; the context
    // metric lives on the earlier line, so the reader widens the back-scan and
    // recovers the true latest of BOTH metrics instead of dropping context.
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
    const initialLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    writeOversizedCodexSnapshot(p, initialLine);
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
    const initialLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    writeSparsePrefix(p, MAX_USAGE_TRANSCRIPT_BYTES + 1, '\n');
    appendFileSync(p, initialLine);
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
    const replayOffset = fileSize(p) - Buffer.byteLength(initialLine) - Buffer.byteLength(appended);
    expectCodexTrackedReplayRead(replayOffset, fileSize(p) - replayOffset);
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

  it('does not use unchanged cache when ctime changes after same-size rewrite with restored mtime', () => {
    const p = join(dir, 'codex-ctime-same-size-rewrite.jsonl');
    const oldLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const newLine = oldLine.replace('"input_tokens":100', '"input_tokens":999');
    expect(Buffer.byteLength(newLine)).toBe(Buffer.byteLength(oldLine));
    writeFileSync(p, oldLine);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });
    const firstStat = statSync(p);

    let secondStat = firstStat;
    for (let attempt = 0; attempt < 10 && secondStat.ctimeMs === firstStat.ctimeMs; attempt++) {
      sleepSync(10);
      writeFileSync(p, oldLine);
      writeFileSync(p, newLine);
      utimesSync(p, firstStat.atime, firstStat.mtime);
      secondStat = statSync(p);
    }
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.size).toBe(firstStat.size);
    expect(secondStat.ctimeMs).not.toBe(firstStat.ctimeMs);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 10,
      inputTokens: 979,
      cacheReadTokens: 20,
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

  it('does not merge cached cumulative tokens when the path is replaced between generation validation and scan', () => {
    const p = join(dir, 'codex-toctou-replace-before-scan.jsonl');
    writeOversizedCodexSnapshot(
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

    appendLargeCodexDelta(p, JSON.stringify({ type: 'event_msg', payload: { type: 'notice' } }));
    const replacement = join(dir, 'codex-toctou-replace-before-scan-new.jsonl');
    writeFileSync(replacement, '');
    codexSnapshotAtTailSize(replacement, `${codexContextLine(240, 1_000)}\n`, fileSize(p));

    now += 20_000;
    const realReadSync = vi.mocked(readSync).getMockImplementation()!;
    let replaced = false;
    vi.mocked(readSync).mockImplementation((fd, buffer, offset, length, position) => {
      const bytesRead = (realReadSync as typeof readSync)(fd, buffer, offset, length, position);
      if (!replaced && length > 1) {
        renameSync(replacement, p);
        replaced = true;
      }
      return bytesRead;
    });

    const snapshot = getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    });
    expect(snapshot.tokens).toBeNull();
    expect(snapshot.turnTokens).toBeNull();
    if (snapshot.context) {
      expect(snapshot.context).toEqual({ usedTokens: 240, windowTokens: 1_000, percentUsed: 24 });
    }
    expect(replaced).toBe(true);
  });

  it('does not inherit a cached Codex metric when its source line terminator is overwritten', () => {
    const p = join(dir, 'codex-source-terminator-overwrite.jsonl');
    const line = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const { baseOffset } = writeOversizedCodexSnapshot(p, line);
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

    writeBytesAt(p, baseOffset + Buffer.byteLength(line) - 1, 'x');
    appendLargeCodexDelta(p, codexContextLine(240, 1_000));
    now += 20_000;

    const snapshot = getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    });
    expect(snapshot).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: null,
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

  it('rebuilds Codex usage when only the front of the cached source record changes and its frontier stays unchanged', () => {
    const p = join(dir, 'codex-source-front-rewrite-same-size.jsonl');
    const oldLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const newLine = oldLine.replace('"input_tokens":100', '"input_tokens":999');
    expect(Buffer.from(newLine).subarray(-TEST_FRONTIER_BYTES).equals(
      Buffer.from(oldLine).subarray(-TEST_FRONTIER_BYTES),
    )).toBe(true);
    const { finalSize } = writeOversizedCodexSnapshot(p, oldLine);
    const firstStat = statSync(p);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    codexSnapshotAtTail(p, newLine);
    truncateSync(p, finalSize);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 10,
      inputTokens: 979,
      cacheReadTokens: 20,
    });
  });

  it('replays the scanned Codex interval when a later metric is written between an unchanged source and frontier', () => {
    const p = join(dir, 'codex-middle-rewrite-between-source-and-frontier.jsonl');
    const oldModelLine = codexModelLine('old-model');
    const oldTokenLine = codexCountLine(100, 10, 20, { used: 30, window: 1_000 });
    const newTokenLine = codexCountLine(999, 11, 30, { used: 240, window: 1_000 });
    const newModelLine = codexModelLine('new-model');
    const oldTokenOffset = Buffer.byteLength(`${oldModelLine}\n`, 'utf8');
    const newTokenOffset = Buffer.byteLength(`${oldModelLine}\n${oldTokenLine}\n`, 'utf8');
    const newModelOffset = newTokenOffset + Buffer.byteLength(`${newTokenLine}\n`, 'utf8');
    const inertLineFor = (line: string) => {
      const prefix = '{"x":"';
      const suffix = '"}';
      const targetBytes = Buffer.byteLength(line, 'utf8');
      const fixedBytes = Buffer.byteLength(prefix + suffix, 'utf8');
      expect(targetBytes).toBeGreaterThan(fixedBytes);
      return prefix + 'x'.repeat(targetBytes - fixedBytes) + suffix;
    };
    const inertTokenLine = inertLineFor(newTokenLine);
    const inertModelLine = inertLineFor(newModelLine);
    expect(Buffer.byteLength(inertTokenLine)).toBe(Buffer.byteLength(newTokenLine));
    expect(Buffer.byteLength(inertModelLine)).toBe(Buffer.byteLength(newModelLine));
    writeFileSync(p, [
      oldModelLine,
      oldTokenLine,
      inertTokenLine,
      inertModelLine,
      JSON.stringify({ type: 'event_msg', payload: { type: 'notice', padding: 'stable-tail'.repeat(32) } }),
      '',
    ].join('\n'));
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    const firstStat = statSync(p);
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 30, windowTokens: 1_000, percentUsed: 3 },
      tokens: {
        in: 100,
        out: 10,
        model: 'old-model',
      },
      turnTokens: null,
    });
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 100,
      out: 10,
      model: 'old-model',
    });

    const oldSource = readBytesAt(p, oldTokenOffset, Buffer.byteLength(oldTokenLine));
    const oldFrontier = readBytesAt(
      p,
      fileSize(p) - TEST_FRONTIER_BYTES,
      TEST_FRONTIER_BYTES,
    );
    sleepSync(5);
    writeBytesAt(p, newTokenOffset, newTokenLine);
    writeBytesAt(p, newModelOffset, newModelLine);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.size).toBe(firstStat.size);
    expect(secondStat.ctimeMs).toBeGreaterThanOrEqual(firstStat.ctimeMs);
    expect(readBytesAt(p, oldTokenOffset, Buffer.byteLength(oldTokenLine))).toEqual(oldSource);
    expect(readBytesAt(
      p,
      fileSize(p) - TEST_FRONTIER_BYTES,
      TEST_FRONTIER_BYTES,
    )).toEqual(oldFrontier);
    now += 20_000;

    vi.mocked(readSync).mockClear();
    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toMatchObject({
      context: { usedTokens: 240, windowTokens: 1_000, percentUsed: 24 },
      tokens: {
        in: 999,
        out: 11,
        inputTokens: 969,
        cacheReadTokens: 30,
        model: 'new-model',
      },
      turnTokens: null,
    });
    expectCodexTrackedReplayRead(0, fileSize(p));
    vi.mocked(readSync).mockClear();
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 11,
      inputTokens: 969,
      cacheReadTokens: 30,
      model: 'new-model',
    });
  });

  it('does not return stale Codex usage when a front-rewritten source record grows slightly but keeps its frontier', () => {
    const p = join(dir, 'codex-source-front-rewrite-grow.jsonl');
    const oldLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const newLine = oldLine.replace('"input_tokens":100', '"input_tokens":999');
    expect(Buffer.byteLength(newLine)).toBe(Buffer.byteLength(oldLine));
    expect(Buffer.from(newLine).subarray(-TEST_FRONTIER_BYTES).equals(
      Buffer.from(oldLine).subarray(-TEST_FRONTIER_BYTES),
    )).toBe(true);
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1;
    const leadBytes = 512;
    writeFileSync(p, '');
    const { lineOffset } = codexSnapshotInsideTail(p, oldLine, leadBytes, finalSize);
    const firstStat = statSync(p);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    const frontierOffset = lineOffset + Buffer.byteLength(oldLine) - TEST_FRONTIER_BYTES;
    const oldFrontier = readBytesAt(p, frontierOffset, TEST_FRONTIER_BYTES);
    writeBytesAt(p, lineOffset, newLine);
    appendFileSync(p, Buffer.alloc(128, 0x20));
    expect(readBytesAt(p, frontierOffset, TEST_FRONTIER_BYTES)).toEqual(oldFrontier);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 10,
      inputTokens: 979,
      cacheReadTokens: 20,
    });
  });

  it('replays a tracked Codex interval when a middle rewrite is followed by a small append', () => {
    const p = join(dir, 'codex-middle-rewrite-small-append.jsonl');
    const oldTokenLine = codexCountLine(100, 10, 20, { used: 30, window: 1_000 });
    const newTokenLine = codexCountLine(999, 11, 30, { used: 240, window: 1_000 });
    const inertLine = '{"x":"' + 'x'.repeat(Buffer.byteLength(newTokenLine) - Buffer.byteLength('{"x":""}')) + '"}';
    expect(Buffer.byteLength(inertLine)).toBe(Buffer.byteLength(newTokenLine));
    writeFileSync(p, [
      oldTokenLine,
      inertLine,
      JSON.stringify({ type: 'event_msg', payload: { type: 'notice', padding: 'stable-tail'.repeat(32) } }),
      '',
    ].join('\n'));
    const firstStat = statSync(p);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    const oldFrontier = readBytesAt(
      p,
      fileSize(p) - TEST_FRONTIER_BYTES,
      TEST_FRONTIER_BYTES,
    );
    sleepSync(5);
    const newTokenOffset = Buffer.byteLength(`${oldTokenLine}\n`, 'utf8');
    writeBytesAt(p, newTokenOffset, newTokenLine);
    const appended = `${codexModelLine('new-model')}\n`;
    appendFileSync(p, appended);
    const secondStat = statSync(p);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(secondStat.size).toBe(firstStat.size + Buffer.byteLength(appended));
    expect(readBytesAt(
      p,
      fileSize(p) - Buffer.byteLength(appended) - TEST_FRONTIER_BYTES,
      TEST_FRONTIER_BYTES,
    )).toEqual(oldFrontier);
    now += 20_000;

    vi.mocked(readSync).mockClear();
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 11,
      inputTokens: 969,
      cacheReadTokens: 30,
      model: 'new-model',
    });
    expectCodexTrackedReplayRead(0, fileSize(p));
  });

  it('falls back to a normal rebuild when the tracked replay boundary is rejected', () => {
    const p = join(dir, 'codex-normal-boundary-rejected.jsonl');
    const prefixLine = JSON.stringify({ type: 'event_msg', payload: { type: 'notice', message: 'prefix' } });
    const oldTokenLine = codexCountLine(100, 10, 20, { used: 30, window: 1_000 });
    const newTokenLine = codexCountLine(999, 11, 30, { used: 240, window: 1_000 });
    const oldSourceOffset = Buffer.byteLength(`${prefixLine}\n`, 'utf8');
    writeFileSync(p, `${prefixLine}\n${oldTokenLine}\n`);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    vi.mocked(readSync).mockClear();
    writeBytesAt(p, oldSourceOffset - 1, ' ');
    appendFileSync(p, `\n${newTokenLine}\n`);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 11,
      inputTokens: 969,
      cacheReadTokens: 30,
    });
    expect(requestedBytes()).toBe(fileSize(p) + 1);
  });

  it('falls back to an oversized tail rebuild when the tracked replay boundary is rejected', () => {
    const p = join(dir, 'codex-oversized-boundary-rejected.jsonl');
    const prefixLine = JSON.stringify({ type: 'event_msg', payload: { type: 'notice', padding: 'p'.repeat(1024) } });
    const oldTokenLine = `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`;
    const newTokenLine = codexCountLine(999, 11, 30, { used: 240, window: 1_000 });
    const finalSize = MAX_USAGE_TRANSCRIPT_BYTES + CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 1;
    const baseOffset = finalSize - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
    const oldSourceOffset = baseOffset + Buffer.byteLength(`${prefixLine}\n`, 'utf8');
    writeFileSync(p, '');
    truncateSync(p, baseOffset - 1);
    appendFileSync(p, `\n${prefixLine}\n${oldTokenLine}`);
    appendFileSync(p, Buffer.alloc(finalSize - fileSize(p), 0x20));
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({ in: 100, out: 10 });

    vi.mocked(readSync).mockClear();
    writeBytesAt(p, oldSourceOffset - 1, ' ');
    appendFileSync(p, `\n${newTokenLine}\n`);
    const tailBaseOffset = fileSize(p) - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES;
    expect(fileSize(p) - oldSourceOffset).toBeLessThanOrEqual(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES);
    now += 20_000;

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 999,
      out: 11,
      inputTokens: 969,
      cacheReadTokens: 30,
    });
    expect(vi.mocked(readSync).mock.calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === oldSourceOffset - 1)).toBe(true);
    expect(vi.mocked(readSync).mock.calls.some((call) => Number(call[3]) === 1 && Number(call[4]) === tailBaseOffset - 1)).toBe(true);
    expect(requestedBytes()).toBe(CODEX_USAGE_TRANSCRIPT_TAIL_BYTES + 2);
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

  it('fails closed when the final fd stability check cannot fstat the open transcript', () => {
    const p = join(dir, 'codex-final-fstat-fail.jsonl');
    writeOversizedCodexSnapshot(p, `${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(p);
    const realFstatSync = vi.mocked(fstatSync).getMockImplementation()!;
    let calls = 0;
    vi.mocked(fstatSync).mockImplementation((fd) => {
      calls++;
      if (calls === 2) throw new Error('fstat boom');
      return realFstatSync(fd);
    });

    expect(getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      cliSessionId: 'codex-sid',
      fresh: true,
    })).toEqual({ context: null, tokens: null, turnTokens: null });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('fails closed instead of falling back to a path scan when the initial Codex stat fails', () => {
    const p = join(dir, 'codex-initial-stat-fails.jsonl');
    writeFileSync(p, '');
    truncateSync(p, MAX_USAGE_TRANSCRIPT_BYTES + 128 * 1024);
    appendFileSync(p, `\n${codexCountLine(100, 10, 20, { used: 30, window: 1_000 })}\n`);

    const realStatSync = vi.mocked(statSync).getMockImplementation()!;
    vi.mocked(statSync).mockImplementation((pathLike, options) => {
      if (pathLike === p) throw new Error('stat boom');
      return realStatSync(pathLike, options as any);
    });

    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toBeNull();
    expect(openSync).not.toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();

    vi.mocked(statSync).mockImplementation(realStatSync);
    expect(readSessionTokenUsageFile(p, 'codex', { fresh: true })).toMatchObject({
      in: 100,
      out: 10,
      inputTokens: 80,
      cacheReadTokens: 20,
    });
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
