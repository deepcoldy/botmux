/** Real IPC → memory + durable store + HTTP projection cancellation regressions. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

let tempDir: string;
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));


import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import * as store from '../src/services/async-trigger-store.js';
import { resolveAsyncTriggerState } from '../src/services/async-trigger-state.js';

const turnId = 'turn-cancel';
const sessionReply = vi.fn(async () => 'om_reply');

function fixture(chatId = 'http_async_cancel', cliId = 'minimax') {
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 99999,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: {
      sessionId: 'sid-cancel', rootMessageId: 'om_root', chatId, title: 'fixture',
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null,
      chatType: 'group', cliId,
    },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId,
    chatType: 'group', spawnedAt: Date.now(), cliVersion: '1',
    lastMessageAt: Date.now(), hasHistory: false,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker as any);
  // Await the installed IPC listener itself: no sleep or assumed event-loop
  // timing, including the no-result case where there is no state to wait for.
  const listeners = worker.listeners('message');
  expect(listeners).toHaveLength(1);
  const ipc = async (msg: WorkerToDaemon) => { await listeners[0](msg); };
  const terminal = (status: 'cancelled' | 'failed' | 'ambiguous' = 'cancelled', errorCode = 'cancelled') => ipc({
    type: 'turn_terminal', sessionId: ds.session.sessionId, turnId, status, errorCode,
  });
  return { ds, ipc, terminal };
}

function arm(ds: DaemonSession) {
  ds.asyncTriggerResults = new Map([[turnId, { status: 'pending', createdAt: 1 }]]);
  ds.idempotentAsyncTurns = new Map([[turnId, { workerGeneration: 1 } as any]]);
  store.recordPending(ds.session.sessionId, turnId, 1, ds.larkAppId);
}

// Compare each surface explicitly. Checking only the poller would miss memory
// versus disk divergence because the resolver gives interrupted precedence.
function projection(ds: DaemonSession) {
  const memory = ds.asyncTriggerResults?.get(turnId);
  const durable = store.lookupStrict(ds.session.sessionId, turnId);
  const inputs = {
    sessionId: ds.session.sessionId, liveActive: true, storedStatus: 'open' as const,
    requestedTriggerId: turnId, persisted: durable,
  };
  const summarize = (result: any) => result && ({
    status: result.status ?? result.state,
    errorCode: result.errorCode,
    terminalErrorCode: result.terminalErrorCode,
    content: result.content ?? result.output?.content,
  });
  return {
    memory: summarize(memory), durable: summarize(durable?.result),
    live: summarize(resolveAsyncTriggerState({ ...inputs, memResult: memory, memTriggerId: turnId })),
    restarted: summarize(resolveAsyncTriggerState({ ...inputs, liveActive: false })),
  };
}
function expectedProjection(status: string, terminalErrorCode?: string) {
  const result = { status, terminalErrorCode, errorCode: status === 'failed' ? 'trigger_failed' : undefined, content: undefined };
  return { memory: result, durable: result, live: result, restarted: result };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'async-cancel-'));
  vi.clearAllMocks();
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => tempDir,
    getActiveCount: () => 1, closeSession: vi.fn() } as any);
});
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('cancelled terminal state across real IPC, store and HTTP projection', () => {
  it('settles a pending MiniMax bare cancellation as interrupted and keeps it terminal', async () => {
    const { ds, ipc, terminal } = fixture();
    arm(ds);
    await terminal();
    expect(projection(ds)).toEqual(expectedProjection('interrupted'));
    expect(ds.asyncTriggerResults!.get(turnId)?.interruptedAt).toEqual(expect.any(Number));
    expect(store.lookupStrict(ds.session.sessionId, turnId)?.result.interruptedAt)
      .toBe(ds.asyncTriggerResults!.get(turnId)?.interruptedAt);
    expect(ds.idempotentAsyncTurns!.has(turnId)).toBe(false);
    await terminal();
    await ipc({ type: 'final_output', turnId, lastUuid: turnId, content: 'late output' });
    expect(projection(ds)).toEqual(expectedProjection('interrupted'));
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('retains provider failure and upgrades the generic code after the real remote-runner sequence', async () => {
    const { ds, ipc, terminal } = fixture('http_async_provider', 'claude-code');
    arm(ds);
    // backend.onTurnFailure emits this diagnostic WITHOUT turnFailureCode.
    await ipc({ type: 'final_output', turnId, lastUuid: turnId, content: 'provider stopped', turnFailed: true });
    await vi.waitFor(() => expect(projection(ds)).toEqual(expectedProjection('failed', 'worker_turn_failed')));
    await terminal('cancelled', 'provider_cancelled');
    expect(projection(ds)).toEqual(expectedProjection('failed', 'provider_cancelled'));
    expect(ds.idempotentAsyncTurns!.has(turnId)).toBe(false);
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not create a headless trigger or replace latest (existing sibling: %s)', async existing => {
    const { ds, terminal } = fixture('headless_cancel', 'claude-code');
    if (existing) store.recordPending(ds.session.sessionId, 'sibling', 1, ds.larkAppId);
    await terminal('cancelled', 'provider_cancelled');
    const missing = { status: undefined, errorCode: 'bad_request', terminalErrorCode: undefined, content: undefined };
    expect(projection(ds)).toEqual({ memory: undefined, durable: undefined, live: missing, restarted: missing });
    expect(store.lookupStrict(ds.session.sessionId)?.triggerId).toBe(existing ? 'sibling' : undefined);
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('still rejects a MiniMax bare cancellation in HTTP wait mode without creating an async result', async () => {
    const { ds, terminal } = fixture('http_wait_cancel');
    const reject = vi.fn();
    const resolve = vi.fn();
    ds.pendingWaitPromises = new Map([[turnId, { reject, resolve } as any]]);
    await terminal();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cancelled') }));
    expect(resolve).not.toHaveBeenCalled();
    expect(ds.pendingWaitPromises.has(turnId)).toBe(false);
    expect(store.lookupStrict(ds.session.sessionId)).toBeUndefined();
  });

  it.each([false, true])('preserves completed output over cancellation (stale pending memory: %s)', async stale => {
    const { ds, terminal } = fixture();
    arm(ds);
    store.recordCompleted(ds.session.sessionId, turnId, 'answer', 2, ds.larkAppId);
    if (!stale) ds.asyncTriggerResults!.set(turnId, { status: 'completed', content: 'answer', createdAt: 1, completedAt: 2 });
    await terminal();
    const completed = { status: 'completed', errorCode: undefined, terminalErrorCode: undefined, content: 'answer' };
    expect(projection(ds)).toEqual({ memory: stale ? undefined : completed, durable: completed, live: completed, restarted: completed });
  });

  it.each(['failed', 'ambiguous'] as const)('keeps existing headless %s persistence behavior', async status => {
    const { ds, terminal } = fixture('headless_failure', 'codex');
    await terminal(status, 'backend_unavailable');
    expect(projection(ds)).toEqual({ ...expectedProjection('failed', 'backend_unavailable'), memory: undefined });
  });
});
