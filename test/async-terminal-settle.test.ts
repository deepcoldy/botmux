/**
 * Behavioral coverage for the async-HTTP "settle-on-terminal" fix (core-only
 * completion bug #70).
 *
 * A turn the worker's bridge gate suppressed as GENUINE SILENCE (model
 * terminated with a bare nothing-to-send sentinel, no `botmux send`) emits
 * `turn_terminal` but NO `final_output`. Without a settle path the async-trigger
 * result stays `pending` and the HTTP poller hangs `running` until timeout.
 *
 * The fix settles such a turn to completed-with-empty-output — but ONLY on the
 * worker's explicit positive evidence `outputDisposition: 'nothing_to_send'`,
 * never on a bare `completed` terminal (the RPC-hydration timeout path emits a
 * bare `completed` with no final_output while the real answer is still
 * materializing; settling that empty would mask a lost reply).
 *
 * These drive the real worker-pool IPC handler via __testOnly_setupWorkerHandlers
 * + a fake worker (mirrors bridge-final-output-retry.test.ts) so the guards are
 * exercised, not just pinned in source.
 *
 * Run:  pnpm vitest run test/async-terminal-settle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    session: { dataDir: '/tmp/test-sessions' },
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

// Spy the durable store so we assert persistence intent without touching disk.
const sessionReplyMock = vi.fn(async () => 'om_reply');
const recordCompletedMock = vi.fn();
const recordTerminalFailureStrictMock = vi.fn(() => 'written_failed');
vi.mock('../src/services/async-trigger-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/async-trigger-store.js')>();
  return {
    ...actual,
    recordCompleted: (...args: any[]) => recordCompletedMock(...args),
    recordTerminalFailureStrict: (...args: any[]) => recordTerminalFailureStrictMock(...args),
  };
});

import { initWorkerPool, interruptExactWorkerTurn, __testOnly_setupWorkerHandlers, __testOnly_deliverFinalOutput } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import * as sessionStore from '../src/services/session-store.js';
import { EventEmitter } from 'node:events';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-async-settle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'claude-code',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
  return ds;
}

describe('interruptExactWorkerTurn', () => {
  it('waits for the worker acknowledgement rather than treating IPC send as success', async () => {
    const ds = makeDs();
    const pending = interruptExactWorkerTurn(ds, 'turn-exact', 1_000);
    expect((ds.worker as any).send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'interrupt_turn', turnId: 'turn-exact', requestId: expect.any(String),
    }));
    const sent = (ds.worker as any).send.mock.calls[0][0];
    (ds.worker as any).emit('message', {
      type: 'turn_interrupt_result', requestId: sent.requestId, turnId: 'turn-exact',
      delivered: false, reason: 'stale_turn',
    });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale_turn' });
  });

  it('accepts only a matching exact-turn delivery acknowledgement', async () => {
    const ds = makeDs();
    const pending = interruptExactWorkerTurn(ds, 'turn-exact', 1_000);
    const sent = (ds.worker as any).send.mock.calls[0][0];
    (ds.worker as any).emit('message', {
      type: 'turn_interrupt_result', requestId: 'other', turnId: 'turn-exact', delivered: true,
    });
    (ds.worker as any).emit('message', {
      type: 'turn_interrupt_result', requestId: sent.requestId, turnId: 'turn-exact', delivered: true,
    });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

function terminalMsg(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-async-settle',
    turnId,
    status: 'completed',
    ...extra,
  };
}

describe('async-HTTP settle-on-terminal (daemon turn_terminal handler)', () => {
  beforeEach(() => {
    recordCompletedMock.mockReset().mockImplementation((_session, _turn, content, completedAt) => ({
      status: 'completed', content, completedAt, createdAt: completedAt,
    }));
    recordTerminalFailureStrictMock.mockClear();
    recordTerminalFailureStrictMock.mockReturnValue('written_failed');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('settles a pending async result to completed+empty on a nothing_to_send terminal', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-silent', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([['turn-silent', { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-silent', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => {
      const r = ds.asyncTriggerResults!.get('turn-silent')!;
      expect(r.status).toBe('completed');
      expect(r.content).toBe('');
    });
    // Durable persistence with EMPTY content.
    expect(recordCompletedMock).toHaveBeenCalledWith(
      'sid-async-settle', 'turn-silent', '', expect.any(Number), 'app_test',
    );
    // Worker-exit convergence entry dropped (by triggerId) so a later graceful exit can't retro-fail it.
    expect(ds.idempotentAsyncTurns!.get('turn-silent')).toBeUndefined();
  });

  it.each([false, true])('a failed durable write leaves output pending and a same-output retry can settle (failure=%s)', async failure => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['commit-fault', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([['commit-fault', {} as any]]);
    const store = failure ? recordTerminalFailureStrictMock : recordCompletedMock;
    store.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    const msg: Extract<WorkerToDaemon, { type: 'final_output' }> = {
      type: 'final_output', sessionId: ds.session.sessionId, turnId: 'commit-fault',
      lastUuid: 'same-final', content: 'exact original output',
      ...(failure ? { turnFailed: true, turnFailureCode: 'provider_eof' } : {}),
    };
    const receipt = vi.fn();
    __testOnly_deliverFinalOutput(ds, msg, 'fixture', 0, receipt);
    expect(receipt).toHaveBeenLastCalledWith(false);
    expect(ds.asyncTriggerResults.get('commit-fault')?.status).toBe('pending');
    expect(ds.idempotentAsyncTurns.has('commit-fault')).toBe(true);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    __testOnly_deliverFinalOutput(ds, msg, 'fixture', 0, receipt);
    expect(receipt).toHaveBeenLastCalledWith(true);
    expect(ds.asyncTriggerResults.get('commit-fault')?.status).toBe(failure ? 'failed' : 'completed');
    expect(ds.idempotentAsyncTurns.has('commit-fault')).toBe(false);
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('does NOT settle on a bare completed terminal (no disposition) — the RPC-hydration-timeout case', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-bare', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([['turn-bare', { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Bare completed: no outputDisposition. A real answer may still be materializing.
    (ds.worker as any).emit('message', terminalMsg('turn-bare'));

    // Give the async IPC handler a tick to run.
    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-bare')!;
    expect(r.status).toBe('pending');          // untouched — must not fabricate empty output
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(ds.idempotentAsyncTurns!.get('turn-bare')).toBeDefined(); // convergence entry intact
  });

  it.each(['codex', 'traex', 'claude-code'])('settles %s failed fallback as failure, never completed text', async cliId => {
    const ds = makeDs(); ds.session.cliId = cliId;
    ds.asyncTriggerResults = new Map([['failure', { status: 'pending' } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId, turnId: 'failure', lastUuid: 'failure',
      content: 'redacted diagnostic', turnFailed: true, turnFailureCode: 'codex_quota_exceeded',
    });
    await vi.waitFor(() => expect(ds.asyncTriggerResults!.get('failure')?.status).toBe('failed'));
    expect(recordTerminalFailureStrictMock).toHaveBeenCalledWith(ds.session.sessionId, 'failure', expect.any(Number), 'app_test', 'codex_quota_exceeded');
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(ds.failedIdleTurnId).toBe('failure');
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'failure', lastUuid: 'late-output', content: 'late output' });
    await Promise.resolve();
    expect(ds.asyncTriggerResults!.get('failure')?.status).toBe('failed');
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('keeps a failed result closed after its in-process terminal tombstone is evicted', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['old-failure', { status: 'pending' } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg('old-failure', { status: 'failed', errorCode: 'provider_unexpected_eof' }));
    await vi.waitFor(() => expect(ds.asyncTriggerResults!.get('old-failure')?.status).toBe('failed'));
    for (let index = 0; index < 256; index++) {
      const turnId = `later-${index}`;
      ds.asyncTriggerResults.set(turnId, { status: 'pending' } as any);
      (ds.worker as any).emit('message', terminalMsg(turnId, { status: 'failed', errorCode: 'provider_unexpected_eof' }));
    }
    await vi.waitFor(() => expect(ds.settledHttpTerminalTurns?.size).toBe(256));
    expect(ds.settledHttpTerminalTurns?.has('old-failure')).toBe(false);
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'old-failure', lastUuid: 'late-after-eviction', content: 'must never become a successful answer' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ds.asyncTriggerResults.get('old-failure')).toMatchObject({ status: 'failed', terminalErrorCode: 'provider_unexpected_eof' });
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('retains failure semantics for an older worker without a structured failure code', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['legacy-failure', { status: 'pending' } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId, turnId: 'legacy-failure',
      lastUuid: 'legacy-failure', content: 'diagnostic', turnFailed: true,
    });
    await vi.waitFor(() => expect(ds.asyncTriggerResults!.get('legacy-failure')?.status).toBe('failed'));
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(recordTerminalFailureStrictMock).toHaveBeenCalledWith(
      ds.session.sessionId, 'legacy-failure', expect.any(Number), 'app_test', 'worker_turn_failed',
    );
  });

  it('rejects wait-mode failed fallback without returning a successful response', async () => {
    const ds = makeDs(); const resolve = vi.fn(), reject = vi.fn();
    ds.pendingWaitPromises = new Map([['failure', { resolve, reject }]]);
    ds.currentTurnId = 'newer'; ds.replyCardRunningTurnId = 'newer';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'failure', lastUuid: 'failure', content: 'diagnostic', turnFailed: true, turnFailureCode: 'codex_connection_failed' });
    await vi.waitFor(() => expect(reject).toHaveBeenCalled());
    expect(resolve).not.toHaveBeenCalled(); expect(ds.failedIdleTurnId).toBeUndefined();
  });

  it.each([0, 1, 2])('does not leak late output after rejecting an HTTP waiter (%s delayed input ACKs)', async ackCount => {
    const ds = makeDs();
    ds.workerGeneration = ds.session.workerGeneration = 1;
    const reject = vi.fn();
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    ds.pendingWaitPromises = new Map([['wait-failure', { resolve: vi.fn(), reject }]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any, undefined, 1);
    const emit = (msg: any) => (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId, turnId: 'wait-failure', ...msg,
    });
    emit({ lastUuid: 'failure', content: 'diagnostic', turnFailed: true });
    await vi.waitFor(() => expect(reject).toHaveBeenCalledOnce());
    // Codex can acknowledge after the adapter returns, while transcript output
    // has already settled this turn. An input receipt cannot reopen that result.
    for (let i = 0; i < ackCount; i++) {
      (ds.worker as any).emit('message', { type: 'turn_input_committed', turnId: 'wait-failure' });
    }
    emit({ lastUuid: 'late-final', content: 'late model output' });
    emit({ lastUuid: 'late-diagnostic', content: 'diagnostic', turnFailed: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.failedIdleTurnId).toBe('wait-failure');

    const resolveNext = vi.fn();
    ds.pendingWaitPromises.set('next-turn', { resolve: resolveNext });
    (ds.worker as any).emit('message', { type: 'turn_input_committed', turnId: 'next-turn' });
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'next-turn', lastUuid: 'next-output', content: 'next answer' });
    await vi.waitFor(() => expect(resolveNext).toHaveBeenCalledExactlyOnceWith('next answer'));
    expect(ds.failedIdleTurnId).toBeUndefined();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it.each(['completed', 'interrupted'])('preserves an already %s result and its idle label', async status => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['settled', { status } as any]]);
    ds.completedIdleTurnId = status === 'completed' ? 'settled' : undefined;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'settled', lastUuid: 'late-failure', content: 'diagnostic', turnFailed: true });
    await Promise.resolve();
    expect(ds.asyncTriggerResults.get('settled')?.status).toBe(status);
    expect(ds.failedIdleTurnId).toBeUndefined();
    expect(ds.completedIdleTurnId).toBe(status === 'completed' ? 'settled' : undefined);
    expect(recordTerminalFailureStrictMock).not.toHaveBeenCalled();
  });

  it('does not mark a card failed when durable completion won the race', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['settled', { status: 'pending' } as any]]);
    recordTerminalFailureStrictMock.mockReturnValueOnce('already_completed');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'settled', lastUuid: 'late-failure', content: 'diagnostic', turnFailed: true });
    await vi.waitFor(() => expect(recordTerminalFailureStrictMock).toHaveBeenCalled());
    expect(ds.asyncTriggerResults.has('settled')).toBe(false);
    expect(ds.failedIdleTurnId).toBeUndefined();
  });

  it('settles native failed terminals even when no fallback text is emitted', async () => {
    const ds = makeDs(); ds.session.cliId = 'codex';
    ds.asyncTriggerResults = new Map([['native-failed', { status: 'pending' } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg('native-failed', { status: 'failed', errorCode: 'codex_quota_exceeded' }));
    await vi.waitFor(() => expect(ds.asyncTriggerResults!.get('native-failed')?.status).toBe('failed'));
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('settles a failed terminal immediately and persists its provider code', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-failed', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurns = new Map([[
      'turn-failed',
      { ownerLarkAppId: 'app_test', key: 'k', kind: 'turn', workerGeneration: 1 } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-failed', {
      status: 'failed', errorCode: 'provider_unexpected_eof', retryable: true,
    }));

    await vi.waitFor(() => {
      expect(ds.asyncTriggerResults!.get('turn-failed')).toMatchObject({
        status: 'failed',
        errorCode: 'trigger_failed',
        terminalErrorCode: 'provider_unexpected_eof',
      });
    });
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(recordTerminalFailureStrictMock).toHaveBeenCalledWith(
      'sid-async-settle',
      'turn-failed',
      expect.any(Number),
      'app_test',
      'provider_unexpected_eof',
    );
    expect(ds.idempotentAsyncTurns!.has('turn-failed')).toBe(false);
  });

  it('rejects an HTTP wait immediately with the structured provider failure', async () => {
    const ds = makeDs();
    ds.chatId = 'http_wait_fixture';
    const resolve = vi.fn();
    const reject = vi.fn();
    ds.pendingWaitPromises = new Map([['turn-wait', { resolve, reject }]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-wait', {
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    }));

    await vi.waitFor(() => expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Claude turn failed: provider_server_error' }),
    ));
    expect(resolve).not.toHaveBeenCalled();
    expect(ds.pendingWaitPromises.has('turn-wait')).toBe(false);
  });

  it('does NOT clobber a final_output-completed result (pending-only guard)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([[
      'turn-done', { status: 'completed', content: 'real answer' } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-done', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-done')!;
    expect(r.status).toBe('completed');
    expect(r.content).toBe('real answer');       // NOT overwritten with ''
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('keeps final_output completion stronger than a later failed terminal', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([[
      'turn-output-won',
      { status: 'completed', content: 'real answer', completedAt: Date.now() } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-output-won', {
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults.get('turn-output-won')).toMatchObject({
      status: 'completed',
      content: 'real answer',
    });
    expect(recordTerminalFailureStrictMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a Feishu turn (no asyncTriggerResults entry)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map();          // Feishu turn: no async entry
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-feishu', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults!.has('turn-feishu')).toBe(false);
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });
});

describe('serial native turn commit barrier', () => {
  let durable: typeof import('../src/services/async-trigger-store.js');
  let fs: typeof import('node:fs');
  let dataDir: string;
  let previousDataDir: string;
  const terminalConsumer = vi.fn(async () => {});
  const serialDs = () => {
    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-a', turnId: 'serial-a', executionPolicy: 'serial', state: 'prepared',
        content: 'first', deliverySink: 'http_async', origin: {} },
      { dispatchId: 'dispatch-b', turnId: 'serial-b', executionPolicy: 'serial', state: 'accepted',
        content: 'second', deliverySink: 'http_async', origin: {} },
    ];
    durable.recordPending(ds.session.sessionId, 'serial-a', Date.now(), ds.larkAppId);
    durable.recordPending(ds.session.sessionId, 'serial-b', Date.now(), ds.larkAppId);
    ds.asyncTriggerResults = new Map([['serial-a', { status: 'pending', createdAt: Date.now() } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    return ds;
  };
  const output = (): Extract<WorkerToDaemon, { type: 'final_output' }> => ({
    type: 'final_output', sessionId: 'sid-async-settle', turnId: 'serial-a',
    serialDispatchId: 'dispatch-a', lastUuid: 'native-final-a', content: 'exact result',
  });
  const terminal = () => terminalMsg('serial-a', { serialDispatchId: 'dispatch-a' });
  const emit = (ds: DaemonSession, msg: WorkerToDaemon) => (ds.worker as any).emit('message', msg);
  const commits = (ds: DaemonSession) => (ds.worker as any).send.mock.calls
    .map(([msg]: any[]) => msg).filter((msg: any) => msg.type === 'turn_terminal_committed');
  beforeEach(async () => {
    vi.clearAllMocks();
    fs = await import('node:fs');
    const { config } = await import('../src/config.js');
    previousDataDir = config.session.dataDir;
    dataDir = fs.mkdtempSync('/tmp/botmux-serial-result-');
    config.session.dataDir = dataDir;
    durable = await vi.importActual('../src/services/async-trigger-store.js');
    terminalConsumer.mockReset().mockResolvedValue(undefined);
    recordCompletedMock.mockReset().mockImplementation(durable.recordCompleted);
    recordTerminalFailureStrictMock.mockReset().mockImplementation(durable.recordTerminalFailureStrict);
    initWorkerPool({ sessionReply: sessionReplyMock, getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1, closeSession: vi.fn(), onTurnTerminal: terminalConsumer } as any);
  });
  afterEach(async () => {
    const { config } = await import('../src/config.js');
    config.session.dataDir = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  it.each([false, true])('restores conversation delivery and commits once (terminalFirst=%s)', async terminalFirst => {
    const ds = serialDs();
    durable.recordPending(ds.session.sessionId, 'serial-a', Date.now(), ds.larkAppId, false, 'conversation');
    ds.asyncTriggerResults = undefined;
    if (terminalFirst) emit(ds, terminal());
    emit(ds, output());
    if (!terminalFirst) emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(durable.lookupStrict(ds.session.sessionId, 'serial-a')?.result).toMatchObject({
      status: 'completed', content: 'exact result', resultDelivery: 'conversation',
    });
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    ds.asyncTriggerResults = undefined;
    emit(ds, output()); emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds).length).toBeGreaterThan(1));
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
  });
  it('repairs a missing HTTP start projection from the original ledger before retiring a recovered result', async () => {
    const ds = serialDs();
    durable.recordInputCommit(ds.session.sessionId, 'serial-a', ds.larkAppId, 1);
    const start = { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', startedAtMs: 1234,
      proofKind: 'codex_rpc_turn_start' as const, workerGeneration: 2 };
    ds.session.codexAppDispatchLedger![0].serialNativeStart = start;
    ds.asyncTriggerResults = undefined;
    emit(ds, output()); emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(durable.lookupStrict(ds.session.sessionId, 'serial-a')?.result).toMatchObject({
      status: 'completed', inputCommit: { workerGeneration: 1 }, executionStarted: start,
    });
  });
  it.each(['oc_real_group_route', 'headless_canary'])('restores the original async recipient on %s', async chatId => {
    const ds = serialDs();
    ds.chatId = chatId;
    ds.asyncTriggerResults = undefined;
    emit(ds, terminal());
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0].serialResult?.terminal).toBeDefined());
    // Recreate the volatile loss between observations, as on a second restart.
    ds.asyncTriggerResults = undefined;
    emit(ds, output());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(durable.lookupStrict(ds.session.sessionId, 'serial-a')?.result).toMatchObject({
      status: 'completed', content: 'exact result',
    });
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
  it.each(['absent', 'foreign', 'unstamped', 'corrupt'])('retains the raw result when its recipient is %s', async state => {
    const ds = serialDs();
    ds.asyncTriggerResults = undefined;
    const path = `${dataDir}/async-triggers/${ds.session.sessionId}.json`;
    if (state === 'absent') fs.unlinkSync(path);
    else if (state === 'corrupt') fs.writeFileSync(path, '{broken');
    else {
      const stored = JSON.parse(fs.readFileSync(path, 'utf8'));
      stored.ownerLarkAppId = state === 'foreign' ? 'other-bot' : undefined;
      fs.writeFileSync(path, JSON.stringify(stored));
    }
    emit(ds, output());
    emit(ds, terminal());
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0].serialResult?.output).toBeDefined());
    expect(commits(ds)).toEqual([]);
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(terminalConsumer).not.toHaveBeenCalled();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
  it('refuses a recovered wait result without its original caller', async () => {
    const ds = serialDs();
    ds.session.codexAppDispatchLedger![0].deliverySink = 'http_wait';
    ds.asyncTriggerResults = undefined;
    emit(ds, output());
    emit(ds, terminal());
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0].serialResult?.output).toBeDefined());
    expect(commits(ds)).toEqual([]);
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
  it('reconciles a result already durably committed before daemon death', async () => {
    const ds = serialDs();
    durable.recordCompleted(ds.session.sessionId, 'serial-a', output().content, Date.now(), ds.larkAppId);
    ds.asyncTriggerResults = undefined;
    emit(ds, output()); emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
  it('does not retire from an output flag without the durable recipient receipt', async () => {
    const ds = serialDs();
    ds.session.codexAppDispatchLedger![0].serialResult = { output: output(), outputCommitted: true };
    ds.asyncTriggerResults = undefined;
    emit(ds, terminal());
    await vi.waitFor(() => expect(terminalConsumer).toHaveBeenCalled());
    expect(commits(ds)).toEqual([]);
    expect(ds.session.codexAppDispatchLedger?.[0].turnId).toBe('serial-a');
  });
  it.each(['nothing_to_send', 'failed'])('settles a recovered %s terminal into the original store', async kind => {
    const ds = serialDs();
    ds.asyncTriggerResults = undefined;
    emit(ds, { ...terminal(), ...(kind === 'failed'
      ? { status: 'failed' as const, errorCode: 'provider_error' }
      : { outputDisposition: 'nothing_to_send' as const }) });
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(durable.lookupStrict(ds.session.sessionId, 'serial-a')?.result.status)
      .toBe(kind === 'failed' ? 'failed' : 'completed');
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
  it.each([false, true])('holds the successor until both raw result and terminal commit (terminalFirst=%s)', async terminalFirst => {
    const ds = serialDs();
    emit(ds, terminalFirst ? terminal() : output());
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0].serialResult).toBeDefined());
    expect(commits(ds)).toEqual([]);
    expect(ds.session.codexAppDispatchLedger?.[1].state).toBe('accepted');
    emit(ds, terminalFirst ? output() : terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect(ds.session.codexAppDispatchLedger?.map(x => x.turnId)).toEqual(['serial-b']);
    expect(ds.asyncTriggerResults?.get('serial-a')?.content).toBe('exact result');
    expect(ds.session.serialDispatchCommits?.[0].dispatchId).toBe('dispatch-a');
    expect(sessionReplyMock).not.toHaveBeenCalled();
    // An ACK lost after durable retirement cannot redeliver output or pop B.
    const writes = recordCompletedMock.mock.calls.length;
    emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(2));
    expect(recordCompletedMock).toHaveBeenCalledTimes(writes);
    expect(ds.session.codexAppDispatchLedger?.[0].turnId).toBe('serial-b');
  });
  it('preserves raw output on consumer disk failure and replays without another native input', async () => {
    const ds = serialDs();
    recordCompletedMock.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    emit(ds, output());
    await vi.waitFor(() => expect(recordCompletedMock).toHaveBeenCalledTimes(1));
    emit(ds, terminal());
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0].serialResult?.terminal).toBeDefined());
    expect(terminalConsumer).not.toHaveBeenCalled();
    expect(commits(ds)).toEqual([]);
    expect(ds.asyncTriggerResults?.get('serial-a')?.status).toBe('pending');
    const raw = ds.session.codexAppDispatchLedger?.[0].serialResult?.output;
    expect(raw?.content).toBe('exact result');
    emit(ds, raw!);
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
    expect((ds.worker as any).send.mock.calls.some(([msg]: any[]) => msg.type === 'message')).toBe(false);
  });
  it('retains native ownership when terminal persistence rejects', async () => {
    const ds = serialDs();
    terminalConsumer.mockRejectedValueOnce(new Error('SQLITE_BUSY exhausted'));
    emit(ds, output());
    await vi.waitFor(() => expect(recordCompletedMock).toHaveBeenCalled());
    emit(ds, terminal());
    await vi.waitFor(() => expect(terminalConsumer).toHaveBeenCalledTimes(1));
    expect(commits(ds)).toEqual([]);
    expect(ds.session.codexAppDispatchLedger?.[0].serialResult?.terminalCommitted).toBeUndefined();
    emit(ds, terminal());
    await vi.waitFor(() => expect(commits(ds)).toHaveLength(1));
  });
  it('does not ACK when raw journal persistence itself fails', async () => {
    const ds = serialDs();
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => { throw new Error('EIO'); });
    emit(ds, output());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(commits(ds)).toEqual([]);
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger?.[0].serialResult).toBeUndefined();
  });
  it('commits no_output after the original deadline and releases the successor without model replay', async () => {
    vi.useFakeTimers();
    try {
      const ds = serialDs();
      emit(ds, terminal());
      await vi.advanceTimersByTimeAsync(29_999);
      expect(commits(ds)).toEqual([]);
      expect(terminalConsumer).not.toHaveBeenCalled();
      const deadline = ds.session.codexAppDispatchLedger![0].serialResult!.outputDrainUntil;
      // Repeated terminal cannot extend the first observed deadline.
      emit(ds, terminal());
      expect(ds.session.codexAppDispatchLedger![0].serialResult!.outputDrainUntil).toBe(deadline);
      await vi.advanceTimersByTimeAsync(1);
      expect(terminalConsumer).toHaveBeenCalledWith(ds,
        expect.objectContaining({ status: 'ambiguous', errorCode: 'no_output', retryable: false }), expect.anything());
      expect(ds.asyncTriggerResults?.get('serial-a')?.status).toBe('failed');
      expect(commits(ds)).toHaveLength(1);
      expect(ds.session.codexAppDispatchLedger?.[0].turnId).toBe('serial-b');
      // Once no_output is committed a delayed result cannot reopen that attempt.
      emit(ds, output());
      await vi.advanceTimersByTimeAsync(1);
      expect(recordCompletedMock).not.toHaveBeenCalled();
      expect(ds.asyncTriggerResults?.get('serial-a')?.status).toBe('failed');
      expect((ds.worker as any).send.mock.calls.some(([msg]: any[]) => msg.type === 'message')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('reopens the persisted drain deadline and retries failed terminal storage without inventing success', async () => {
    vi.useFakeTimers();
    try {
      const ds = serialDs();
      const original = terminal();
      ds.session.codexAppDispatchLedger![0].serialResult = {
        terminal: original, outputDrainUntil: Date.now() - 1,
      };
      terminalConsumer.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      emit(ds, original);
      await vi.advanceTimersByTimeAsync(1);
      expect(commits(ds)).toEqual([]);
      expect(ds.session.codexAppDispatchLedger![0].serialResult!.outputAbsentAt).toBeDefined();
      expect(ds.session.codexAppDispatchLedger![0].serialResult!.terminal!.status).toBe('completed');
      emit(ds, original);
      await vi.advanceTimersByTimeAsync(1);
      expect(commits(ds)).toHaveLength(1);
      expect(recordCompletedMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('rejects a tail result, wrong dispatch identity and stale worker', async () => {
    const ds = serialDs();
    emit(ds, { ...output(), turnId: 'serial-b', serialDispatchId: 'dispatch-b' });
    emit(ds, { ...output(), serialDispatchId: 'other' });
    const old = ds.worker as any;
    ds.worker = undefined;
    old.emit('message', output());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(old.send.mock.calls.some(([msg]: any[]) => msg.type === 'turn_terminal_committed')).toBe(false);
  });
});
