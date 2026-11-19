import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeSessionKey,
  remoteRetirementAdmissionPhase,
  type DaemonSession,
} from '../src/core/types.js';

const { getBotMock, cancelRiffTaskMock, queryRiffThreadTasksMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelRiffTaskMock: vi.fn(async () => true),
  queryRiffThreadTasksMock: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/adapters/backend/riff-backend.js', () => ({
  hashUrlForLog: vi.fn(() => 'riffhash'),
  cancelRiffTaskById: cancelRiffTaskMock,
  queryRiffThreadTasks: queryRiffThreadTasksMock,
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageChatId: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import {
  __testOnly_setupWorkerHandlers,
  closeSession,
  initWorkerPool,
  killWorker,
  sendWorkerInput,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { readPersistedSessionRows } from './helpers/session-store-disk.js';

let dataDir: string;
let previousDataDir: string;
const sessionReplyMock = vi.fn(async () => 'om_reply');

function createFixture(options: {
  liveWorker?: boolean;
  closeOk?: boolean;
  resultTaskId?: string;
} = {}) {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_riff', 'om_riff', 'riff close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'riff';
  session.riffParentTaskId = 'task-riff-123';
  sessionStore.updateSession(session);

  const worker = options.liveWorker ? new EventEmitter() as any : null;
  if (worker) {
    worker.killed = false;
    worker.exitCode = null;
    worker.signalCode = null;
    worker.kill = vi.fn();
    worker.send = vi.fn((message: any) => {
      if (message.type === 'close_commit') {
        queueMicrotask(() => {
          worker.exitCode = 0;
          worker.emit('exit', 0, null);
        });
        return;
      }
      if (message.type === 'close_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'close_abort_result',
          requestId: message.requestId,
          ok: true,
        }));
        return;
      }
      if (message.type !== 'close' || !message.requestId) return;
      queueMicrotask(() => worker.emit('message', {
        type: 'close_result',
        requestId: message.requestId,
        ok: options.closeOk ?? true,
        taskId: options.resultTaskId ?? 'task-riff-123',
        ...((options.closeOk ?? true) ? {} : { error: 'task-cancel HTTP 500' }),
      }));
    });
  }

  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    session,
    // What the worker was forked with (the bot's riff block at the time).
    initConfig: { backendType: 'riff', backendConfig: { baseUrl: 'https://riff.invalid', jwt: 'test' } },
  } as unknown as DaemonSession;
  if (worker) __testOnly_setupWorkerHandlers(ds, worker);
  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  return { session, ds, worker, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-riff-close-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'test' } },
  });
  cancelRiffTaskMock.mockResolvedValue(true);
  queryRiffThreadTasksMock.mockResolvedValue({
    ok: true,
    tasks: [{ id: 'task-riff-123', status: 'cancelled', terminal: true }],
  });
  initWorkerPool({
    sessionReply: sessionReplyMock,
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Riff explicit close', () => {
  it('awaits worker-less cancellation before atomically clearing lineage and closing', async () => {
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelRiffTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
      'task-riff-123',
    );
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(fixture.registry.size).toBe(0);
  });

  it('preserves the active row, route and retry lineage when cancellation fails', async () => {
    cancelRiffTaskMock.mockResolvedValue(false);
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'riff_cancel_failed',
      retryable: true,
      taskId: 'task-riff-123',
    });
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });
    expect(fixture.registry.get(activeSessionKey(fixture.ds))).toBe(fixture.ds);
  });

  it('commits a live worker close only after its matching prepare result', async () => {
    const fixture = createFixture({ liveWorker: true, resultTaskId: 'task-riff-child' });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close',
      requestId: expect.any(String),
    }));
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_commit',
      requestId: expect.any(String),
    }));
    expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('aborts a failed live prepare and keeps the session retryable', async () => {
    const fixture = createFixture({ liveWorker: true, closeOk: false });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'riff_worker_close_failed',
      retryable: true,
      taskId: 'task-riff-123',
    });
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_abort',
      requestId: expect.any(String),
    }));
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });
    expect(fixture.ds.remoteCloseState).toBeUndefined();
  });

  it('refuses an unprepared generic retirement of a live Riff worker', () => {
    const fixture = createFixture({ liveWorker: true });

    killWorker(fixture.ds);

    expect(fixture.ds.worker).toBe(fixture.worker);
    expect(fixture.worker.send).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });
  });

  it('refuses explicit close while the daemon shutdown fence owns the Riff worker', async () => {
    const fixture = createFixture({ liveWorker: true });
    fixture.ds.remoteShutdownState = {
      phase: 'preparing',
      requestId: 'shutdown-riff',
      taskId: 'task-riff-123',
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_shutdown_fence_in_progress',
      retryable: true,
      taskId: 'task-riff-123',
    });
    expect(fixture.worker.send).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });
  });

  it('shows a localized close-in-progress notice instead of leaking the i18n key', async () => {
    const fixture = createFixture({ liveWorker: true });
    fixture.ds.remoteCloseState = {
      phase: 'preparing',
      requestId: 'close-riff',
      taskId: 'task-riff-123',
    };

    expect(sendWorkerInput(fixture.ds, 'late turn', 'om_late_turn')).toBe(false);
    await new Promise(resolve => setImmediate(resolve));

    expect(fixture.worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'oc_riff',
      expect.stringMatching(/Riff.*正在关闭/),
      'text',
      'app',
      'om_late_turn',
    );
    expect(sessionReplyMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'worker.remote_close_in_progress',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the newest runtime lineage when its durable save fails', async () => {
    const fixture = createFixture({ liveWorker: true });
    vi.spyOn(sessionStore, 'updateSession').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    fixture.worker.emit('message', {
      type: 'riff_task_id',
      taskId: 'task-riff-child',
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(fixture.session.riffParentTaskId).toBe('task-riff-child');
    const durable = readPersistedSessionRows(dataDir, 'app');
    expect(durable[fixture.session.sessionId].riffParentTaskId).toBe('task-riff-123');
  });

  it('restores the prior runtime lineage when clearing its durable row fails', async () => {
    const fixture = createFixture({ liveWorker: true });
    vi.spyOn(sessionStore, 'updateSession').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    fixture.worker.emit('message', {
      type: 'riff_task_id',
      taskId: null,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(fixture.session.riffParentTaskId).toBe('task-riff-123');
    const durable = readPersistedSessionRows(dataDir, 'app');
    expect(durable[fixture.session.sessionId].riffParentTaskId).toBe('task-riff-123');
  });
});


type CloseReply = 'silent' | { ok: boolean; taskId?: string; error?: string };
type AbortReply = 'restored' | 'not_active' | 'refused' | 'silent';

/**
 * Drive the live fixture worker request by request. Every `close` consumes the
 * next scripted reply ('silent' = never answers, so the daemon's own deadline
 * decides); every `close_abort` answers per `abortReply`. All IPC the daemon
 * sends is recorded in order.
 */
function scriptWorker(
  fixture: ReturnType<typeof createFixture>,
  closeReplies: CloseReply[],
  abortReply: AbortReply = 'restored',
): any[] {
  const sent: any[] = [];
  const worker = fixture.worker;
  worker.send = vi.fn((message: any) => {
    sent.push(message);
    if (message.type === 'close_commit') {
      queueMicrotask(() => {
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
      return;
    }
    if (message.type === 'close_abort') {
      if (abortReply === 'silent') return;
      queueMicrotask(() => worker.emit('message', {
        type: 'close_abort_result',
        requestId: message.requestId,
        ...(abortReply === 'restored'
          ? { ok: true, admissionRestored: true }
          : abortReply === 'not_active'
            ? { ok: false, error: 'close_abort_not_active' }
            : { ok: true, admissionRestored: false, fenceReason: 'still_fenced' }),
      }));
      return;
    }
    if (message.type !== 'close') return;
    const reply = closeReplies.shift() ?? 'silent';
    if (reply === 'silent') return;
    queueMicrotask(() => worker.emit('message', {
      type: 'close_result',
      requestId: message.requestId,
      ...reply,
    }));
  });
  return sent;
}

const sentTypes = (sent: any[]): string[] => sent.map(message => message.type);

/** First close whose close_result never arrives: the daemon's handshake
 * deadline expires and leaves the `uncertain` fence under that request. */
async function timeOutFirstClose(fixture: ReturnType<typeof createFixture>, sent: any[]) {
  const pending = closeSession(fixture.session.sessionId);
  await vi.advanceTimersByTimeAsync(23_000);
  const result = await pending;
  expect(result).toMatchObject({
    ok: false,
    error: 'riff_worker_close_failed',
    recovery: 'uncertain',
  });
  expect(fixture.ds.remoteCloseState).toMatchObject({
    phase: 'uncertain',
    requestId: sent[0].requestId,
  });
  expect(sentTypes(sent)).toEqual(['close']);
  return sent[0].requestId as string;
}

async function settleIpc(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Let the dead worker's possible in-flight requests run out, so the next
 * worker-less close is decided by the thread state alone. */
async function outlastOrphanRequests(): Promise<void> {
  await vi.advanceTimersByTimeAsync(80_000);
}

describe('Riff close after an uncertain (timed-out) close result', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the sender how to clear the fence instead of asking them to wait', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);

    expect(sendWorkerInput(fixture.ds, 'late turn', 'om_late_turn')).toBe(false);
    await settleIpc();

    expect(sentTypes(sent)).toEqual(['close']);
    const notice = (sessionReplyMock.mock.calls.at(-1) as unknown[] | undefined)?.[1];
    expect(notice).toEqual(expect.stringContaining('/close'));
    expect(notice).not.toMatch(/正在关闭/);
  });

  it.each(['restored', 'not_active'] as const)(
    'a second close releases the timed-out request, re-runs the cancel and commits (worker abort: %s)',
    async (abortReply) => {
      const fixture = createFixture({ liveWorker: true });
      const sent = scriptWorker(fixture, ['silent', { ok: true, taskId: 'task-riff-123' }], abortReply);
      const firstRequestId = await timeOutFirstClose(fixture, sent);

      expect(await closeSession(fixture.session.sessionId)).toEqual({
        ok: true,
        outcome: 'closed',
        alreadyClosed: false,
        known: true,
      });
      expect(sentTypes(sent)).toEqual(['close', 'close_abort', 'close', 'close_commit']);
      expect(sent[1].requestId).toBe(firstRequestId);
      expect(sent[2].requestId).not.toBe(firstRequestId);
      expect(sent[3].requestId).toBe(sent[2].requestId);
      expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
      expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
      expect(fixture.registry.size).toBe(0);
    },
  );

  it('a failed reconciliation keeps the fence without rolling back, and the next close converges', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, [
      'silent',
      { ok: false, taskId: 'task-riff-123', error: 'task-cancel HTTP 500' },
      { ok: true, taskId: 'task-riff-123' },
    ]);
    await timeOutFirstClose(fixture, sent);

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
      taskId: 'task-riff-123',
    });
    const reconcileRequestId = sent[2].requestId;
    // No rollback of the failed reconcile: an abort would reopen admission on a
    // remote nobody has proven stopped.
    expect(sentTypes(sent)).toEqual(['close', 'close_abort', 'close']);
    expect(fixture.ds.remoteCloseState).toMatchObject({
      phase: 'uncertain',
      requestId: reconcileRequestId,
    });
    expect(sendWorkerInput(fixture.ds, 'late turn', 'om_late_turn')).toBe(false);
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(sentTypes(sent)).toEqual([
      'close', 'close_abort', 'close', 'close_abort', 'close', 'close_commit',
    ]);
    expect(sent[3].requestId).toBe(reconcileRequestId);
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
  });

  it('keeps the fence when the worker refuses to release the timed-out request', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent', { ok: true }], 'refused');
    const firstRequestId = await timeOutFirstClose(fixture, sent);

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
    });
    expect(sentTypes(sent)).toEqual(['close', 'close_abort']);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'uncertain', requestId: firstRequestId });
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
  });

  it('a late ok close_result for the fenced request lifts the fence once the worker rolls back', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    const firstRequestId = await timeOutFirstClose(fixture, sent);

    fixture.worker.emit('message', {
      type: 'close_result',
      requestId: firstRequestId,
      ok: true,
      taskId: 'task-riff-123',
    });
    await settleIpc();

    expect(sentTypes(sent)).toEqual(['close', 'close_abort']);
    expect(sent[1].requestId).toBe(firstRequestId);
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(remoteRetirementAdmissionPhase(fixture.ds)).toBeNull();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
    // The user last saw this close fail; the topic is told the session is back.
    expect(sessionReplyMock).toHaveBeenLastCalledWith(
      'oc_riff',
      expect.stringMatching(/已确认 Riff 远端任务已停止.*会话已恢复/),
      'text',
      'app',
    );
  });

  it('a late ok close_result keeps the fence when the worker will not confirm its rollback', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent'], 'refused');
    const firstRequestId = await timeOutFirstClose(fixture, sent);

    fixture.worker.emit('message', {
      type: 'close_result',
      requestId: firstRequestId,
      ok: true,
      taskId: 'task-riff-123',
    });
    await settleIpc();

    expect(sentTypes(sent)).toEqual(['close', 'close_abort']);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'uncertain', requestId: firstRequestId });
  });

  it.each([
    ['an ok:false result', { ok: false, taskId: 'task-riff-123', error: 'close_timeout' }, undefined],
    ['an ok result for a lineage the session has since moved past', { ok: true, taskId: 'task-riff-123' }, 'task-riff-child'],
  ] as const)('a late close_result that is not proof keeps the fence: %s', async (_label, late, newerLineage) => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    const firstRequestId = await timeOutFirstClose(fixture, sent);
    if (newerLineage) {
      fixture.worker.emit('message', { type: 'riff_task_id', taskId: newerLineage });
      await settleIpc();
      expect(fixture.ds.session.riffParentTaskId).toBe(newerLineage);
    }

    fixture.worker.emit('message', { type: 'close_result', requestId: firstRequestId, ...late });
    await settleIpc();

    expect(sentTypes(sent)).toEqual(['close']);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'uncertain', requestId: firstRequestId });
  });

  it('ignores a late result for a request the fence no longer names', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, [
      'silent',
      { ok: false, taskId: 'task-riff-123', error: 'task-cancel HTTP 500' },
    ]);
    const firstRequestId = await timeOutFirstClose(fixture, sent);
    await closeSession(fixture.session.sessionId);
    const reconcileRequestId = sent[2].requestId;

    fixture.worker.emit('message', {
      type: 'close_result',
      requestId: firstRequestId,
      ok: true,
      taskId: 'task-riff-123',
    });
    await settleIpc();

    expect(sentTypes(sent)).toEqual(['close', 'close_abort', 'close']);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'uncertain', requestId: reconcileRequestId });
  });

  it('without a worker, reconciles through the direct idempotent cancel and survives a failed commit', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    expect(fixture.ds.worker).toBeNull();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    await outlastOrphanRequests();

    // 1) Cancel not proven: nothing is published and the fence stays.
    cancelRiffTaskMock.mockResolvedValueOnce(false);
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_cancel_failed',
      retryable: true,
      taskId: 'task-riff-123',
    });
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });

    // 2) Cancel proven, but the durable close fails: the row stays retryable
    //    and the fence comes back as `uncertain`, not cleared.
    const closeSpy = vi.spyOn(sessionStore, 'closeSession').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_durable_close_failed',
      retryable: true,
    });
    closeSpy.mockRestore();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });

    // 3) The next close converges.
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(cancelRiffTaskMock).toHaveBeenCalledTimes(3);
    expect(cancelRiffTaskMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
      'task-riff-123',
    );
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(fixture.registry.size).toBe(0);
    // Never through the dead worker.
    expect(sentTypes(sent)).toEqual(['close']);
  });

  it.each([
    ['with', 'task-riff-123'],
    ['without', undefined],
  ] as const)('without a worker (%s a recorded lineage), cancels a task the session never recorded before closing', async (_label, lineage) => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    if (!lineage) {
      // The worker died while its first create was still in flight.
      fixture.session.riffParentTaskId = undefined;
      sessionStore.updateSession(fixture.session);
    }
    const recorded = lineage ? [{ id: lineage, status: 'cancelled', terminal: true }] : [];
    queryRiffThreadTasksMock
      .mockResolvedValueOnce({ ok: true, tasks: [...recorded, { id: 'task-late', status: 'running', terminal: false }] })
      .mockResolvedValueOnce({ ok: true, tasks: [...recorded, { id: 'task-late', status: 'cancelled', terminal: true }] });

    await outlastOrphanRequests();
    const pending = closeSession(fixture.session.sessionId);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ ok: true, outcome: 'closed' });

    expect(cancelRiffTaskMock.mock.calls.map(call => call[1]))
      .toEqual(lineage ? [lineage, 'task-late'] : ['task-late']);
    expect(queryRiffThreadTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
      fixture.session.sessionId,
    );
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
  });

  it('without a worker, keeps the fence while the thread cannot be proven stopped, then converges', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    const firstRequestId = await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();

    await outlastOrphanRequests();
    queryRiffThreadTasksMock.mockResolvedValueOnce({ ok: false, error: 'tasks query HTTP 503' });
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
    });
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'uncertain', requestId: firstRequestId });
    expect(sendWorkerInput(fixture.ds, 'late turn', 'om_late_turn')).toBe(false);
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-riff-123',
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
  });

  it('without a worker, does not take a thread listing that is missing the session lineage as proof', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    await outlastOrphanRequests();
    // Owner-scoped: asked under another identity, the thread reads as empty.
    queryRiffThreadTasksMock.mockResolvedValueOnce({ ok: true, tasks: [] });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
      taskId: 'task-riff-123',
    });
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
  });

  /** A fenced session whose worker died before it ever learned a task id: the
   *  thread listing has nothing known to anchor its identity to. */
  async function crashedWithoutLineage() {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.session.riffParentTaskId = undefined;
    sessionStore.updateSession(fixture.session);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    await outlastOrphanRequests();
    queryRiffThreadTasksMock.mockResolvedValue({ ok: true, tasks: [] });
    return fixture;
  }

  it.each([
    ['the identity', { baseUrl: 'https://riff.invalid', jwt: 'someone-else' }],
    ['the endpoint', { baseUrl: 'https://riff-other.invalid', jwt: 'test' }],
  ] as const)('without a worker or a known lineage, refuses to trust the thread once the bot changed %s since the worker ran', async (_label, edited) => {
    const fixture = await crashedWithoutLineage();
    getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: { riff: edited } });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_config_changed',
      retryable: true,
    });
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });

    // Restoring the configuration the worker ran with lets the close converge.
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'test' } },
    });
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(queryRiffThreadTasksMock).toHaveBeenCalledWith(
      { baseUrl: 'https://riff.invalid', jwt: 'test' },
      fixture.session.sessionId,
    );
  });

  it('without a worker or a known lineage, a bot edit that does not touch the endpoint or identity lists with the config the worker ran with', async () => {
    const fixture = await crashedWithoutLineage();
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'test', model: 'some-new-model' } },
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(queryRiffThreadTasksMock).toHaveBeenCalledWith(
      { baseUrl: 'https://riff.invalid', jwt: 'test' },
      fixture.session.sessionId,
    );
  });

  it('without a worker or a known lineage, refuses when the worker could not see the lane header the daemon would send', async () => {
    const previous = process.env.BOTMUX_RIFF_EXTRA_HEADERS;
    process.env.BOTMUX_RIFF_EXTRA_HEADERS = '{"x-tt-env":"ppe_lane"}';
    try {
      const fixture = await crashedWithoutLineage();
      // A strict env policy keeps BOTMUX_* host variables away from workers.
      getBotMock.mockReturnValue({
        resolvedAllowedUsers: [],
        config: { envPolicy: { mode: 'strict' }, riff: { baseUrl: 'https://riff.invalid', jwt: 'test' } },
      });
      expect(await closeSession(fixture.session.sessionId)).toMatchObject({
        ok: false,
        error: 'riff_config_changed',
      });
      expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_RIFF_EXTRA_HEADERS;
      else process.env.BOTMUX_RIFF_EXTRA_HEADERS = previous;
    }
  });

  it('with a known lineage, a rotated token for the same owner still converges (the lineage anchors the identity)', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    await outlastOrphanRequests();
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'rotated' } },
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(queryRiffThreadTasksMock).toHaveBeenCalledWith(
      { baseUrl: 'https://riff.invalid', jwt: 'rotated' },
      fixture.session.sessionId,
    );
  });

  it('with a known lineage, a listing under another owner (lineage missing from it) is still refused', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    await outlastOrphanRequests();
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'someone-else' } },
    });
    queryRiffThreadTasksMock.mockResolvedValueOnce({ ok: true, tasks: [] });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      taskId: 'task-riff-123',
    });
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
  });

  it('a reconciliation that throws midway leaves the fence reconcilable, not stuck in preparing', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();
    await outlastOrphanRequests();
    queryRiffThreadTasksMock.mockRejectedValueOnce(new Error('unexpected'));

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
    });
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sendWorkerInput(fixture.ds, 'late turn', 'om_late_turn')).toBe(false);

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
  });

  it('retires a worker that does not answer the release, then reconciles without it', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent'], 'silent');
    await timeOutFirstClose(fixture, sent);

    const pending = closeSession(fixture.session.sessionId);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fixture.worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fixture.ds.worker).toBeNull();
    // Still fenced while the hung worker is on its way out.
    expect(remoteRetirementAdmissionPhase(fixture.ds)).toBe('close-preparing');
    expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    fixture.worker.signalCode = 'SIGTERM';
    fixture.worker.emit('exit', null, 'SIGTERM');
    // It just exited: a request it sent may still land, so this close does not
    // trust the thread yet (and never sat on the full window).
    expect(await pending).toMatchObject({ ok: false, error: 'riff_close_reconcile_wait', retryable: true });
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');

    await outlastOrphanRequests();
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(sentTypes(sent)).toEqual(['close', 'close_abort']);
    expect(cancelRiffTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
      'task-riff-123',
    );
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
  });

  it('keeps the fence while a retired hung worker has not exited, and converges once it has', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent'], 'silent');
    await timeOutFirstClose(fixture, sent);

    const pending = closeSession(fixture.session.sessionId);
    await vi.advanceTimersByTimeAsync(11_000 + 10_000);
    expect(await pending).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
      retryable: true,
    });
    // Escalated, and nothing remote was touched while the process lived on.
    expect(fixture.worker.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });

    fixture.worker.signalCode = 'SIGKILL';
    fixture.worker.emit('exit', null, 'SIGKILL');
    await outlastOrphanRequests();
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
  });

  it('a second close that lands while a crash has the fence reading uncertain mid-reconcile is refused, not run twice', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent'], 'silent');
    await timeOutFirstClose(fixture, sent);
    await outlastOrphanRequests();

    const first = closeSession(fixture.session.sessionId);
    await settleIpc();
    expect(sentTypes(sent)).toEqual(['close', 'close_abort']);
    // The worker dies while the first close waits for its release: the exit
    // handler turns the fence back to `uncertain` under the same request.
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    const second = closeSession(fixture.session.sessionId);

    expect(await second).toMatchObject({ ok: false, error: 'riff_close_reconciliation_required' });
    // The first one continues worker-less on its own; the worker only just
    // died, so it stops at the quiet window. One cancel, not two.
    expect(await first).toMatchObject({ ok: false, error: 'riff_close_reconcile_wait' });
    expect(cancelRiffTaskMock).toHaveBeenCalledTimes(1);
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();

    await outlastOrphanRequests();
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
  });

  it('a retained, already-killed worker is waited out before the thread is checked, and a second close stays out', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    // A retained, already-killed generation: not usable, but still running.
    fixture.worker.killed = true;

    const first = closeSession(fixture.session.sessionId);
    await settleIpc();
    expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    expect(remoteRetirementAdmissionPhase(fixture.ds)).toBe('close-preparing');

    // A second close while the first one is waiting is refused, not run twice.
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'riff_close_reconciliation_required',
    });

    fixture.worker.exitCode = 0;
    fixture.worker.emit('exit', 0, null);
    expect(await first).toMatchObject({ ok: false, error: 'riff_close_reconcile_wait' });
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();

    await outlastOrphanRequests();
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
  });

  it('right after the worker died, waits out a request it may still have in flight before trusting the thread', async () => {
    const fixture = createFixture({ liveWorker: true });
    const sent = scriptWorker(fixture, ['silent']);
    await timeOutFirstClose(fixture, sent);
    fixture.worker.exitCode = 1;
    fixture.worker.emit('exit', 1, null);
    await settleIpc();

    // The thread looks clean now, but the dead worker's follow-up may still be
    // accepted by Riff within its request budget.
    const tooEarly = closeSession(fixture.session.sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(await tooEarly).toMatchObject({
      ok: false,
      error: 'riff_close_reconcile_wait',
      retryable: true,
    });
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    expect(fixture.ds.remoteCloseState?.phase).toBe('uncertain');
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });

    // Within the bounded wait: the close sleeps through the rest of the window.
    await vi.advanceTimersByTimeAsync(60_000);
    const inWindow = closeSession(fixture.session.sessionId);
    queryRiffThreadTasksMock.mockResolvedValueOnce({ ok: true, tasks: [
      { id: 'task-riff-123', status: 'cancelled', terminal: true },
      { id: 'task-late', status: 'running', terminal: false },
    ] }).mockResolvedValueOnce({ ok: true, tasks: [
      { id: 'task-riff-123', status: 'cancelled', terminal: true },
      { id: 'task-late', status: 'cancelled', terminal: true },
    ] });
    await vi.advanceTimersByTimeAsync(0);
    expect(queryRiffThreadTasksMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await inWindow).toMatchObject({ ok: true, outcome: 'closed' });
    expect(cancelRiffTaskMock.mock.calls.map(call => call[1])).toEqual(['task-riff-123', 'task-riff-123', 'task-late']);
  });
});
