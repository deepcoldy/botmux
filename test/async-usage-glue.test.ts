/**
 * Glue test: the daemon's final_output handler persists per-turn usage all the
 * way into the durable async-trigger store (memory + disk), and it survives a
 * "restart" (a fresh store lookup with no in-memory Map). This is the hop the
 * unit tests can't cover — deleting the `msg.usage` spread at the recording site
 * makes this go red.
 *
 * Run: pnpm vitest run test/async-usage-glue.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

const linkRefRuntime = vi.hoisted(() => ({ current: undefined as any }));
vi.mock('../src/services/link-ref-runtime.js', () => ({
  getLinkRefRuntime: () => linkRefRuntime.current,
}));

import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { __testOnly_deliverFinalOutput } from '../src/core/worker-pool.js';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

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
afterEach(() => {
  linkRefRuntime.current = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('final_output → durable usage persistence (memory + disk + restart)', () => {
  it.each(['turn_budget_exhausted', 'execution_failed'])('persists %s instead of a completed diagnostic', errorCode => {
    const ds = armedDs('sess-native-failure', 'trg_failure');
    asyncTriggerStore.recordPending('sess-native-failure', 'trg_failure', 1, 'cli_test');
    __testOnly_deliverFinalOutput(ds, {
      ...finalMsg('trg_failure', false), turnFailed: true, turnFailureCode: errorCode,
    }, 'tag', 0);
    expect(ds.asyncTriggerResults.get('trg_failure')).toMatchObject({ status: 'failed', terminalErrorCode: errorCode });
    expect(asyncTriggerStore.lookup('sess-native-failure', 'trg_failure')?.result).toMatchObject({
      status: 'failed', terminalErrorCode: errorCode,
    });
    expect(asyncTriggerStore.lookup('sess-native-failure', 'trg_failure')?.result.content).toBeUndefined();
  });
  it('expands an enabled LinkRef before resolving an HTTP wait sink and clears its draft', () => {
    const resolve = vi.fn();
    const clearPendingDraft = vi.fn();
    const prepareFinalDraft = vi.fn(() => ({ content: 'AUTH_FULL', draftPending: true }));
    linkRefRuntime.current = { prepareFinalDraft, clearPendingDraft };
    const ds: any = {
      session: { sessionId: 'sess-wait' },
      larkAppId: 'cli_test',
      pendingWaitPromises: new Map([['trg_wait', { resolve }]]),
    };
    const msg = {
      ...finalMsg('trg_wait', false),
      content: '{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}',
      linkRefMode: 'enabled' as const,
      dispatchAttempt: 3,
    };

    __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);

    expect(prepareFinalDraft).toHaveBeenCalledWith({
      key: {
        appId: 'cli_test', sessionId: 'sess-wait', turnId: 'trg_wait', dispatchAttempt: 3,
      },
      mode: 'enabled',
      content: msg.content,
    });
    expect(resolve).toHaveBeenCalledWith('AUTH_FULL');
    expect(clearPendingDraft).toHaveBeenCalledWith({
      appId: 'cli_test', sessionId: 'sess-wait', turnId: 'trg_wait', dispatchAttempt: 3,
    });
    expect(msg.content).toBe('{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}');
  });

  it('persists expanded LinkRef content in the async result before clearing its draft', () => {
    const clearPendingDraft = vi.fn();
    linkRefRuntime.current = {
      prepareFinalDraft: vi.fn(() => ({ content: 'ASYNC_AUTH_FULL', draftPending: true })),
      clearPendingDraft,
    };
    const ds = armedDs('sess-link-ref', 'trg_link_ref');
    asyncTriggerStore.recordPending('sess-link-ref', 'trg_link_ref', 1, 'cli_test');

    __testOnly_deliverFinalOutput(ds, {
      ...finalMsg('trg_link_ref', false),
      content: '{{botmux_link:lr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}}',
      linkRefMode: 'enabled',
    }, 'tag', 0);

    expect(ds.asyncTriggerResults.get('trg_link_ref').content).toBe('ASYNC_AUTH_FULL');
    expect(asyncTriggerStore.lookup('sess-link-ref', 'trg_link_ref')?.result.content)
      .toBe('ASYNC_AUTH_FULL');
    expect(clearPendingDraft).toHaveBeenCalledOnce();
  });

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

describe('GET trigger-result carries the turn usage (live session + durable store)', () => {
  // The lookup composition (buildAsyncTriggerLookupResponse) is module private;
  // drive it through the real IPC route so dropping either hop — the live
  // memResult.usage OR the persisted result.usage — makes the response lose it.
  let handle: IpcServerHandle | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle) { await handle.close(); handle = null; }
  });

  async function pollTriggerResult(sessionId: string, triggerId: string): Promise<any> {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${sessionId}/trigger-result?triggerId=${triggerId}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  it('reports usage from the live in-memory completed result', async () => {
    setLarkAppId('cli_test');
    const ds = armedDs('sess-glue-3', 'trg_c');
    ds.chatId = 'http_async_x';
    ds.asyncTriggerResults.set('trg_c', { status: 'completed', content: 'LIVE_OK', completedAt: 5, usage: USAGE });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);

    const body = await pollTriggerResult('sess-glue-3', 'trg_c');
    expect(body.state).toBe('completed');
    expect(body.usage).toEqual(USAGE);
  });

  it('reports usage from the durable store when no live session holds the turn', async () => {
    setLarkAppId('cli_test');
    asyncTriggerStore.recordPending('sess-glue-4', 'trg_d', 1, 'cli_test');
    asyncTriggerStore.recordCompleted('sess-glue-4', 'trg_d', 'DISK_OK', 5, 'cli_test', USAGE);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    const body = await pollTriggerResult('sess-glue-4', 'trg_d');
    expect(body.state).toBe('completed');
    expect(body.usage).toEqual(USAGE);
  });
});
