/**
 * Glue test: the daemon's final_output handler persists per-turn usage all the
 * way into the durable async-trigger store (memory + disk), and it survives a
 * "restart" (a fresh store lookup with no in-memory Map). This is the hop the
 * unit tests can't cover — deleting the `msg.usage` spread at the recording site
 * makes this go red.
 *
 * Run: pnpm vitest run test/async-usage-glue.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

// Real async-trigger-store, but its dataDir points at a temp dir so we assert
// actual on-disk persistence. config is the only dep the async branch needs.
vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { __testOnly_deliverFinalOutput } from '../src/core/worker-pool.js';

const USAGE = { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 };

function armedDs(sessionId: string, turnId: string): any {
  // Minimal DaemonSession shape the async branch of deliverFinalOutput reads.
  return {
    session: { sessionId },
    larkAppId: 'cli_test',
    asyncTriggerResults: new Map([[turnId, { status: 'pending', createdAt: 1 }]]),
  };
}

function finalMsg(turnId: string, withUsage: boolean): any {
  return {
    type: 'final_output',
    content: 'ASYNC_OK',
    lastUuid: turnId,
    turnId,
    ...(withUsage ? { usage: USAGE } : {}),
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'async-usage-glue-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('final_output → durable usage persistence (memory + disk + restart)', () => {
  it('persists usage into the async store and it survives a fresh (restart) lookup', () => {
    const ds = armedDs('sess-glue-1', 'trg_a');
    asyncTriggerStore.recordPending('sess-glue-1', 'trg_a', 1, 'cli_test');

    __testOnly_deliverFinalOutput(ds, finalMsg('trg_a', true), 'tag', 0);

    // in-memory result carries usage
    expect(ds.asyncTriggerResults.get('trg_a').usage).toEqual(USAGE);
    // durable store (fresh read = post-restart, no in-memory Map) carries usage
    expect(asyncTriggerStore.lookup('sess-glue-1', 'trg_a')?.result.usage).toEqual(USAGE);
    expect(asyncTriggerStore.lookup('sess-glue-1', 'trg_a')?.result.status).toBe('completed');
  });

  it('omits usage end-to-end when the final marker had none (never fabricates zeros)', () => {
    const ds = armedDs('sess-glue-2', 'trg_b');
    asyncTriggerStore.recordPending('sess-glue-2', 'trg_b', 1, 'cli_test');

    __testOnly_deliverFinalOutput(ds, finalMsg('trg_b', false), 'tag', 0);

    expect(ds.asyncTriggerResults.get('trg_b').usage).toBeUndefined();
    expect(asyncTriggerStore.lookup('sess-glue-2', 'trg_b')?.result.usage).toBeUndefined();
  });
});

describe('trigger-result wrapper wires usage from both mem and persisted (source lock)', () => {
  // The trigger-result composition (buildAsyncTriggerLookupResponse) is module
  // private and behind the daemon registry, so unit-testing it live needs a heavy
  // harness. Lock the two spreads that carry usage into resolveAsyncTriggerState —
  // deleting either (live memResult.usage OR persisted result.usage) fails here,
  // guarding the exact hop codex flagged. resolveAsyncTriggerState's own mem+disk
  // usage emission is covered in async-trigger-state.test.ts.
  it('passes memResult.usage (live path) into the resolver', () => {
    const src = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
    const call = src.indexOf('resolveAsyncTriggerState({');
    expect(call).toBeGreaterThan(0);
    const body = src.slice(call, src.indexOf('});', call));
    // live in-memory result must forward usage
    expect(body).toMatch(/memResult\?\.usage|usage: memResult\.usage/);
    // persisted result is passed whole (its `result.usage` reaches the resolver)
    expect(body).toContain('persisted');
  });
});
