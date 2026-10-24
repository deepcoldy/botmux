/**
 * `getSessionUsageWithContext` — the transcript-derived half of `botmux observe`'s
 * `context` block: latest-request prompt size, when it was measured, and how many
 * times the context was compacted, for Claude Code and Codex.
 *
 * Real files, real incremental cache; only the transcript path lookup is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/transcript-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/transcript-resolver.js')>()),
  resolveSessionTranscriptPath: vi.fn(),
}));

import {
  MAX_USAGE_TRANSCRIPT_BYTES,
  __resetSessionUsageCachesForTest,
  getSessionUsageSnapshot,
  getSessionUsageWithContext,
} from '../src/core/cost-calculator.js';
import { resolveSessionTranscriptPath } from '../src/services/transcript-resolver.js';

const T0 = Date.parse('2026-10-21T08:00:00.000Z');
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

let dir: string;
let transcript: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-context-observation-'));
  transcript = join(dir, 'transcript.jsonl');
  __resetSessionUsageCachesForTest();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function pointResolverAt(path: string, kind: 'claude' | 'codex'): void {
  vi.mocked(resolveSessionTranscriptPath).mockReturnValue({ path, kind });
}

function read(cliId: 'claude-code' | 'codex' | 'traex') {
  return getSessionUsageWithContext({ cliId, sessionId: 'botmux-sid', cliSessionId: 'cli-sid', fresh: true });
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

function assistant(id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(0),
    message: { id, model: 'claude-opus-4-1', usage },
    ...extra,
  });
}
const compactBoundary = (offsetSec: number) => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', timestamp: iso(offsetSec), content: 'Conversation compacted',
});

describe('Claude Code context observation', () => {
  beforeEach(() => pointResolverAt(transcript, 'claude'));

  it('reports the latest request prompt size, not the running total', () => {
    writeFileSync(transcript, [
      assistant('m1', { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, output_tokens: 700 }, { timestamp: iso(10) }),
      assistant('m2', { input_tokens: 12, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 3_000, output_tokens: 900 }, { timestamp: iso(20) }),
      '',
    ].join('\n'));

    const { snapshot, contextObservation } = read('claude-code');

    expect(snapshot.context).toEqual({ usedTokens: 12 + 90_000 + 3_000 });
    expect(snapshot.tokens?.in).toBe(10 + 40_000 + 500 + 12 + 90_000 + 3_000);
    expect(contextObservation).toEqual({ measuredAtMs: T0 + 20_000, compactions: 0, source: 'claude-transcript' });
  });

  it('counts compact_boundary markers and keeps the post-compaction request as the measurement', () => {
    writeFileSync(transcript, [
      assistant('m1', { input_tokens: 5, cache_read_input_tokens: 180_000 }, { timestamp: iso(10) }),
      compactBoundary(11),
      assistant('m2', { input_tokens: 5, cache_read_input_tokens: 20_000 }, { timestamp: iso(12) }),
      compactBoundary(30),
      assistant('m3', { input_tokens: 5, cache_read_input_tokens: 25_000 }, { timestamp: iso(31) }),
      '',
    ].join('\n'));

    const { snapshot, contextObservation } = read('claude-code');

    expect(snapshot.context).toEqual({ usedTokens: 25_005 });
    expect(contextObservation).toMatchObject({ compactions: 2, measuredAtMs: T0 + 31_000 });
  });

  it('does not let a subagent (sidechain) request stand in for the main conversation', () => {
    writeFileSync(transcript, [
      assistant('main', { input_tokens: 5, cache_read_input_tokens: 120_000 }, { timestamp: iso(10) }),
      assistant('sub', { input_tokens: 5, cache_read_input_tokens: 3_000 }, { timestamp: iso(20), isSidechain: true }),
      '',
    ].join('\n'));

    const { snapshot, contextObservation } = read('claude-code');

    expect(snapshot.context).toEqual({ usedTokens: 120_005 });
    expect(contextObservation?.measuredAtMs).toBe(T0 + 10_000);
  });

  it('keeps counting across appended lines through the incremental cache', () => {
    writeFileSync(transcript, `${assistant('m1', { input_tokens: 1, cache_read_input_tokens: 1_000 }, { timestamp: iso(1) })}\n`);
    expect(read('claude-code').contextObservation).toMatchObject({ compactions: 0 });

    appendFileSync(transcript, `${compactBoundary(2)}\n${assistant('m2', { input_tokens: 1, cache_read_input_tokens: 300 }, { timestamp: iso(3) })}\n`);
    const { snapshot, contextObservation } = read('claude-code');

    expect(snapshot.context).toEqual({ usedTokens: 301 });
    expect(contextObservation).toMatchObject({ compactions: 1, measuredAtMs: T0 + 3_000 });
  });

  it('reports nothing when no request has been measured yet (compaction marker alone is not a measurement)', () => {
    writeFileSync(transcript, `${compactBoundary(1)}\n`);
    const { snapshot, contextObservation } = read('claude-code');
    expect(snapshot.context).toBeNull();
    expect(contextObservation).toBeUndefined();
  });

  it('reports nothing for an empty transcript or a missing one', () => {
    writeFileSync(transcript, '');
    expect(read('claude-code').contextObservation).toBeUndefined();

    vi.mocked(resolveSessionTranscriptPath).mockReturnValue(null);
    expect(read('claude-code').contextObservation).toBeUndefined();
  });

  it('falls back to the file mtime only when the measured entry carries no timestamp', () => {
    writeFileSync(transcript, `${JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 7, cache_read_input_tokens: 700 } },
    })}\n`);
    const mtime = new Date(T0 + 99_000);
    utimesSync(transcript, mtime, mtime);

    expect(read('claude-code').contextObservation?.measuredAtMs).toBe(T0 + 99_000);
  });

  it('leaves the card-facing snapshot exactly as getSessionUsageSnapshot produced it', () => {
    writeFileSync(transcript, `${assistant('m1', { input_tokens: 1, cache_read_input_tokens: 99, output_tokens: 4 }, { timestamp: iso(1) })}\n`);
    const query = { cliId: 'claude-code' as const, sessionId: 'botmux-sid', cliSessionId: 'cli-sid', fresh: true };
    expect(getSessionUsageWithContext(query).snapshot).toEqual(getSessionUsageSnapshot(query));
    expect(getSessionUsageSnapshot(query)).not.toHaveProperty('contextObservation');
  });
});

// ─── Codex ───────────────────────────────────────────────────────────────────

function tokenCount(used: number | null, window: number | null, offsetSec: number, cumulativeInput = 1000): string {
  return JSON.stringify({
    timestamp: iso(offsetSec),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: cumulativeInput, output_tokens: 10 },
        ...(used === null ? {} : { last_token_usage: { total_tokens: used, input_tokens: used - 10, output_tokens: 10 } }),
        ...(window === null ? {} : { model_context_window: window }),
      },
    },
  });
}
const compacted = (offsetSec: number) => JSON.stringify({
  timestamp: iso(offsetSec), type: 'compacted', payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] },
});
const contextCompacted = (offsetSec: number) => JSON.stringify({
  timestamp: iso(offsetSec), type: 'event_msg', payload: { type: 'context_compacted' },
});

describe('Codex context observation', () => {
  beforeEach(() => pointResolverAt(transcript, 'codex'));

  it('reports last_token_usage.total_tokens with the rollout window, measured at that event', () => {
    writeFileSync(transcript, [
      tokenCount(30_000, 258_400, 10, 5_000),
      tokenCount(61_000, 258_400, 20, 9_000),
      '',
    ].join('\n'));

    const { snapshot, contextObservation } = read('codex');

    expect(snapshot.context).toEqual({ usedTokens: 61_000, windowTokens: 258_400, percentUsed: 24 });
    expect(snapshot.tokens?.in).toBe(9_000);
    expect(contextObservation).toEqual({ measuredAtMs: T0 + 20_000, compactions: 0, source: 'codex-rollout' });
  });

  it('counts compacted entries once, not the context_compacted event written beside each one', () => {
    writeFileSync(transcript, [
      tokenCount(200_000, 258_400, 10),
      compacted(11), contextCompacted(11),
      compacted(40), contextCompacted(40),
      tokenCount(35_000, 258_400, 41),
      '',
    ].join('\n'));

    expect(read('codex').contextObservation).toMatchObject({ compactions: 2 });
  });

  it('does not count a line that merely mentions the word', () => {
    writeFileSync(transcript, [
      tokenCount(1_000, 258_400, 1),
      JSON.stringify({ timestamp: iso(2), type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'the log said "compacted" twice' }] } }),
      '',
    ].join('\n'));

    expect(read('codex').contextObservation).toMatchObject({ compactions: 0 });
  });

  it('adds only the appended compactions on later reads and survives a replaced file', () => {
    writeFileSync(transcript, `${tokenCount(100, 1_000, 1)}\n${compacted(2)}\n`);
    expect(read('codex').contextObservation?.compactions).toBe(1);

    appendFileSync(transcript, `${compacted(3)}\n${tokenCount(80, 1_000, 4)}\n`);
    expect(read('codex').contextObservation?.compactions).toBe(2);

    // Same path, new content (rollout rewritten): the cursor must not carry over.
    rmSync(transcript);
    writeFileSync(transcript, `${tokenCount(55, 1_000, 5)}\n`);
    expect(read('codex').contextObservation).toMatchObject({ compactions: 0 });
  });

  it('previews a complete record still missing its newline without double counting it later', () => {
    writeFileSync(transcript, `${tokenCount(100, 1_000, 1)}\n${compacted(2)}`);
    expect(read('codex').contextObservation?.compactions).toBe(1);

    appendFileSync(transcript, '\n');
    expect(read('codex').contextObservation?.compactions).toBe(1);

    appendFileSync(transcript, `${compacted(3)}\n`);
    expect(read('codex').contextObservation?.compactions).toBe(2);
  });

  it('reports no measurement before the first token_count carries a last-request gauge', () => {
    writeFileSync(transcript, `${tokenCount(null, 258_400, 1)}\n${compacted(2)}\n`);
    const { snapshot, contextObservation } = read('codex');
    expect(snapshot.context).toBeNull();
    expect(contextObservation).toBeUndefined();
  });

  it('keeps the window unknown-but-present rather than guessing when the rollout omits it', () => {
    writeFileSync(transcript, `${tokenCount(1_234, null, 1)}\n`);
    const { snapshot, contextObservation } = read('codex');
    expect(snapshot.context).toEqual({ usedTokens: 1_234 });
    expect(contextObservation).toMatchObject({ source: 'codex-rollout', compactions: 0 });
  });

  it('cannot count an oversized rollout it has never scanned: compactions is null, not 0', () => {
    writeFileSync(transcript, '');
    truncateSync(transcript, MAX_USAGE_TRANSCRIPT_BYTES + 1);
    appendFileSync(transcript, `\n${tokenCount(150_000, 258_400, 1)}\n`);

    const { snapshot, contextObservation } = read('codex');

    expect(snapshot.context).toMatchObject({ usedTokens: 150_000, windowTokens: 258_400 });
    expect(contextObservation).toMatchObject({ compactions: null, source: 'codex-rollout' });
  });
});

describe('other CLIs', () => {
  it('report no observation even when their transcript has a usable gauge', () => {
    pointResolverAt(transcript, 'codex');
    writeFileSync(transcript, `${tokenCount(5_000, 258_400, 1)}\n`);

    const { snapshot, contextObservation } = read('traex');

    expect(snapshot.context).toMatchObject({ usedTokens: 5_000 });
    expect(contextObservation).toBeUndefined();
  });
});
