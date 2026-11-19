/**
 * Who sees a failed turn's raw error and screen tail (kept in memory only, on
 * the live session's async result): the workflow draft's in-process clarifier
 * does; the public GET /api/sessions/:id/trigger-result route never does —
 * its response is byte for byte what it was before they existed. Driven
 * through the real IPC server and the production clarifier wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

// The real async-trigger store under a temp dataDir: the durable record a
// restarted daemon reads.
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
import * as workerPool from '../src/core/worker-pool.js';
import {
  productionWorkflowDraftClarifier,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';

const APP = 'cli_test';
const SESSION = 'sess-diag';
const TRIGGER = 'trg_diag';
const FAILED = {
  status: 'failed' as const,
  createdAt: 1,
  failedAt: 5000,
  errorCode: 'trigger_failed' as const,
  terminalErrorCode: 'provider_authentication_failed',
};
const DIAGNOSTICS = {
  terminalErrorDetail: 'API Error: 403 Access denied for model RAW_DETAIL_MARK',
  terminalScreenTail: '  ⎿  API Error: 403 RAW_SCREEN_MARK\n❯',
};

/** A live session whose latest async turn failed, with or without the two. */
function liveSession(withDiagnostics: boolean): any {
  return {
    session: { sessionId: SESSION, larkAppId: APP, status: 'active', chatId: 'http_async_x' },
    larkAppId: APP,
    chatId: 'http_async_x',
    latestAsyncTriggerId: TRIGGER,
    asyncTriggerResults: new Map([[TRIGGER, withDiagnostics ? { ...FAILED, ...DIAGNOSTICS } : { ...FAILED }]]),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trigger-result-diag-'));
  setLarkAppId(APP);
  // The durable record of the same failure: the code only.
  asyncTriggerStore.recordPending(SESSION, TRIGGER, 1, APP);
  asyncTriggerStore.recordTerminalFailureStrict(SESSION, TRIGGER, 5000, APP, FAILED.terminalErrorCode);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET trigger-result never carries a failure\'s raw error or screen', () => {
  let handle: IpcServerHandle | null = null;
  afterEach(async () => {
    if (handle) { await handle.close(); handle = null; }
  });

  async function poll(query: string): Promise<string> {
    handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${SESSION}/trigger-result${query}`);
    return `${res.status} ${await res.text()}`;
  }

  it.each([
    ['the turn asked for', `?triggerId=${TRIGGER}`],
    ['the latest turn', ''],
  ])('%s: the same bytes whether memory holds them or not', async (_name, query) => {
    const live = vi.spyOn(workerPool, 'findActiveBySessionId');
    live.mockReturnValue(liveSession(true));
    const withThem = await poll(query);
    live.mockReturnValue(liveSession(false));
    const without = await poll(query);

    expect(withThem).toBe(without);
    expect(withThem).not.toMatch(/RAW_DETAIL_MARK|RAW_SCREEN_MARK/);
    expect(JSON.parse(withThem.slice(withThem.indexOf(' ') + 1))).toMatchObject({
      state: 'failed', terminalErrorCode: FAILED.terminalErrorCode,
    });
  });
});

describe('the draft\'s clarifier (production wiring) reads them from the live session', () => {
  it('live: the raw error and the screen tail come with the code', () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(liveSession(true));
    expect(productionWorkflowDraftClarifier().result(SESSION, TRIGGER)).toMatchObject({
      state: 'failed',
      errorCode: FAILED.terminalErrorCode,
      errorDetail: DIAGNOSTICS.terminalErrorDetail,
      terminalTail: DIAGNOSTICS.terminalScreenTail,
    });
  });

  it('after a daemon restart (no live session): the durable record\'s code only', () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const result = productionWorkflowDraftClarifier().result(SESSION, TRIGGER);
    expect(result).toMatchObject({ state: 'failed', errorCode: FAILED.terminalErrorCode });
    expect('errorDetail' in result).toBe(false);
    expect('terminalTail' in result).toBe(false);
  });
});
