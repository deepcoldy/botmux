import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { getBotMock, cancelRiffTaskMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelRiffTaskMock: vi.fn(async () => true),
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
    initConfig: { backendType: 'riff' },
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
  sessionStore.init();
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
