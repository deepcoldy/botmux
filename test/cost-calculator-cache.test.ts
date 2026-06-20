/**
 * Cache/incremental-read tests for cost-calculator's transcript reader.
 *
 * These use REAL files (no fs mocks): the cache layer is keyed on stat()
 * results, which the mocked-fs tests in cost-calculator.test.ts bypass.
 *
 * Run:  pnpm vitest run test/cost-calculator-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  readSessionTokenUsageFile,
  __resetSessionUsageCachesForTest,
} from '../src/core/cost-calculator.js';

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

function codexCountLine(input: number, output: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
  });
}

let dir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-cache-'));
  __resetSessionUsageCachesForTest();
  now = 1_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('readSessionTokenUsageFile caching', () => {
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
    writeFileSync(p, `${codexCountLine(100, 20)}\n`);
    expect(readSessionTokenUsageFile(p, 'codex')).toMatchObject({ in: 100, out: 20 });

    now += 20_000;
    appendFileSync(p, `${codexCountLine(150, 30)}\n`);
    // Latest cumulative snapshot wins — not 100+150.
    expect(readSessionTokenUsageFile(p, 'codex')).toMatchObject({ in: 150, out: 30 });
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
