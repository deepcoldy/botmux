/**
 * Unit tests for killWorker's orphaned-backing-session teardown (worker-pool.ts).
 *
 * Bug: clicking 「关闭会话」/close does not kill the CLI running in tmux when the
 * session has no live worker. A persistent backend (tmux/herdr/zellij) keeps its
 * backing session + CLI alive across a worker exit BY DESIGN (idle-suspend and
 * lazy-restore resume into it later). killWorker used to early-return when
 * `ds.worker` was null, so the 'close' IPC — and the worker-side destroySession()
 * that tears the backing session down — never ran. The orphaned CLI kept living
 * in tmux and still replied after /close.
 *
 * Fix: when there is no live worker, killWorker destroys the backing session
 * directly via the deterministic session name. Adopt sessions are skipped (the
 * user's own pane must never be killed).
 *
 * Run:  pnpm vitest run test/kill-worker-orphaned-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { tmuxKill, herdrKill, zellijKill, getBotMock, cancelRiffTaskMock } = vi.hoisted(() => ({
  tmuxKill: vi.fn(),
  herdrKill: vi.fn(),
  zellijKill: vi.fn(),
  getBotMock: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  cancelRiffTaskMock: vi.fn(async () => true),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: tmuxKill },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: herdrKill },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: zellijKill },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
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

import {
  __testOnly_setupWorkerHandlers,
  closeSession,
  initWorkerPool,
  killWorker,
  sendWorkerInput,
  setActiveSessionSafe,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { config } from '../src/config.js';

const SID = 'abcd1234-0000-0000-0000-000000000000';
const EXPECTED_NAME = 'bmx-abcd1234';
let sessionReplyMock: ReturnType<typeof vi.fn>;

// All stream-card fields left unset on both ds and ds.session so
// persistStreamCardState() early-returns (no disk write) during clearUsageLimitState.
const ds = (over: Partial<DaemonSession> = {}, initOver: any = {}): DaemonSession => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  scope: 'chat',
  worker: null,
  session: { sessionId: SID },
  initConfig: { backendType: 'tmux', ...initOver },
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  vi.clearAllMocks();
  getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: {} } as any);
  cancelRiffTaskMock.mockResolvedValue(true);
  sessionReplyMock = vi.fn(async () => 'om_reply');
  initWorkerPool({
    sessionReply: sessionReplyMock,
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

describe('closeSession — worker-less Riff cancellation is an awaited close precondition', () => {
  async function fixture(
    cancelled: boolean,
    liveWorker = false,
    registered = true,
    options: { resultTaskId?: string; exitAfterResult?: boolean; holdAbortAck?: boolean } = {},
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-riff-close-'));
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app');
    const session = sessionStore.createSession('oc_riff', 'om_riff', 'riff close', 'group');
    session.larkAppId = 'app';
    session.scope = 'chat';
    session.backendType = 'riff';
    session.riffParentTaskId = 'task-riff-123';
    sessionStore.updateSession(session);
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { riff: { baseUrl: 'https://riff.invalid', jwt: 'test' } },
    } as any);
    cancelRiffTaskMock.mockResolvedValue(cancelled);

    const worker = liveWorker ? new EventEmitter() as any : null;
    if (worker) {
      worker.killed = false;
      worker.exitCode = null;
      worker.signalCode = null;
      worker.kill = vi.fn();
      worker.send = vi.fn((message: any) => {
        if (message.type === 'close_abort' && message.requestId) {
          if (!options.holdAbortAck) {
            queueMicrotask(() => worker.emit('message', {
              type: 'close_abort_result',
              requestId: message.requestId,
              ok: true,
            }));
          }
          return;
        }
        if (message.type !== 'close' || !message.requestId) return;
        queueMicrotask(() => worker.emit('message', {
          type: 'close_result',
          requestId: message.requestId,
          ok: cancelled,
          ...(options.resultTaskId ? { taskId: options.resultTaskId } : {}),
          ...(!cancelled ? {
            taskId: options.resultTaskId ?? 'task-riff-123',
            error: 'task-cancel HTTP 500',
          } : {}),
        }));
        if (options.exitAfterResult) {
          queueMicrotask(() => worker.emit('exit', 0, null));
        }
      });
    }
    const d = ds({
      chatId: session.chatId,
      scope: 'chat',
      session,
      initConfig: { backendType: 'riff' } as any,
      worker,
    });
    if (worker) __testOnly_setupWorkerHandlers(d, worker);
    const registry = registered
      ? new Map([[activeSessionKey(d), d]])
      : new Map<string, DaemonSession>();
    setActiveSessionsRegistry(registry);
    return {
      session,
      d,
      registry,
      cleanup() {
        worker?.removeAllListeners();
        setActiveSessionsRegistry(new Map());
        config.session.dataDir = previousDataDir;
        sessionStore.init();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }

  it('awaits a confirmed cancel, then clears the task id and closes the row', async () => {
    const f = await fixture(true);
    try {
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({ ok: true, alreadyClosed: false });
      expect(cancelRiffTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
        'task-riff-123',
      );
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
      expect(sessionStore.getSession(f.session.sessionId)?.riffParentTaskId).toBeUndefined();
      expect(f.registry.size).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it('refuses close on cancel failure and preserves the active row + retry task id', async () => {
    const f = await fixture(false);
    try {
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_cancel_failed',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
      expect(f.registry.get(activeSessionKey(f.d))).toBe(f.d);
    } finally {
      f.cleanup();
    }
  });

  it('refuses worker-less close before cancellation when runtime and durable Riff lineage differ', async () => {
    const f = await fixture(true);
    try {
      f.d.session = {
        ...f.session,
        riffParentTaskId: 'task-runtime-stale',
      };

      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_task_changed',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
      expect(f.registry.get(activeSessionKey(f.d))).toBe(f.d);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
    } finally {
      f.cleanup();
    }
  });

  it.each([
    { label: 'exact task', stateTaskId: 'task-fenced-child', expectedTaskId: 'task-fenced-child' },
    { label: 'authoritative null', stateTaskId: null, expectedTaskId: undefined },
  ])('refuses worker-less close during a retained shutdown fence ($label)', async ({
    stateTaskId,
    expectedTaskId,
  }) => {
    const f = await fixture(true);
    try {
      f.d.riffShutdownState = {
        phase: 'prepared',
        requestId: 'shutdown-fence-close',
        taskId: stateTaskId,
      };
      const routeKey = activeSessionKey(f.d);

      const result = await closeSession(f.session.sessionId);

      expect(result).toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_shutdown_fence_in_progress',
        retryable: true,
        ...(expectedTaskId ? { taskId: expectedTaskId } : {}),
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
      expect(f.registry.get(routeKey)).toBe(f.d);
      expect(f.d.riffShutdownState).toMatchObject({ requestId: 'shutdown-fence-close' });
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
    } finally {
      f.cleanup();
    }
  });

  it('refuses a live-worker close when its prepare handshake reports remote cancel failure', async () => {
    const f = await fixture(false, true);
    try {
      const worker = f.d.worker as any;
      const result = await closeSession(f.session.sessionId);
      expect(result).toMatchObject({
        ok: false,
        error: 'riff_worker_close_failed',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(worker.send).toHaveBeenCalledWith({
        type: 'close',
        requestId: expect.any(String),
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
      expect(f.d.worker).toBe(worker);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
    } finally {
      f.cleanup();
    }
  });

  it('commits a successful live-worker close only after the row is durably closed', async () => {
    const f = await fixture(true, true);
    try {
      const worker = f.d.worker as any;
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({ ok: true, alreadyClosed: false });

      const closeRequest = worker.send.mock.calls[0]?.[0];
      expect(closeRequest).toEqual({
        type: 'close',
        requestId: expect.any(String),
      });
      expect(worker.send.mock.calls[1]?.[0]).toEqual({
        type: 'close_commit',
        requestId: closeRequest.requestId,
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
      expect(f.d.worker).toBeNull();
      expect(f.registry.size).toBe(0);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
      expect(sessionStore.getSession(f.session.sessionId)?.riffParentTaskId).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it('cancels an open persisted Riff row even when it is absent from the active registry', async () => {
    const f = await fixture(true, false, false);
    try {
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({ ok: true, alreadyClosed: false });
      expect(cancelRiffTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://riff.invalid' }),
        'task-riff-123',
      );
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
      expect(sessionStore.getSession(f.session.sessionId)?.riffParentTaskId).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it('rejects a message explicitly during prepare, then restores admission after close failure', async () => {
    const f = await fixture(false, true);
    try {
      const worker = f.d.worker as any;
      worker.send = vi.fn(); // hold close_result so the prepare phase is observable
      const closeP = closeSession(f.session.sessionId);
      await Promise.resolve();
      const closeRequest = worker.send.mock.calls[0]?.[0];
      expect(closeRequest).toMatchObject({ type: 'close', requestId: expect.any(String) });
      expect(f.d.riffCloseState).toMatchObject({ phase: 'preparing', requestId: closeRequest.requestId });

      expect(sendWorkerInput(f.d, 'racing message', 'om_race')).toBe(false);
      await Promise.resolve();
      expect(worker.send.mock.calls.some(([message]: any[]) => message.type === 'message')).toBe(false);
      expect(sessionReplyMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Riff'),
        'text',
        'app',
        'om_race',
      );

      worker.emit('message', {
        type: 'close_result',
        requestId: closeRequest.requestId,
        ok: false,
        taskId: 'task-riff-123',
        error: 'task-cancel HTTP 500',
      });
      await vi.waitFor(() => expect(worker.send).toHaveBeenCalledWith({
        type: 'close_abort',
        requestId: closeRequest.requestId,
      }));
      // The failed prepare's backend abort may already have completed, but the
      // daemon must keep its admission fence until the exact worker ACK lands.
      expect(f.d.riffCloseState).toMatchObject({ requestId: closeRequest.requestId });
      expect(sendWorkerInput(f.d, 'during abort ACK wait', 'om_abort_wait')).toBe(false);
      worker.emit('message', {
        type: 'close_abort_result',
        requestId: closeRequest.requestId,
        ok: true,
      });
      await expect(closeP).resolves.toMatchObject({ ok: false, retryable: true });
      expect(worker.send).toHaveBeenCalledWith({
        type: 'close_abort',
        requestId: closeRequest.requestId,
      });
      expect(f.d.riffCloseState).toBeUndefined();

      expect(sendWorkerInput(f.d, 'after failed close', 'om_after')).toBe(true);
      expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message',
        content: 'after failed close',
        turnId: 'om_after',
      }));
    } finally {
      f.cleanup();
    }
  });

  it('retains an uncertain close fence when the exact worker exits before close_result', async () => {
    const f = await fixture(true, true);
    try {
      const worker = f.d.worker as any;
      worker.send = vi.fn(); // hold close_result: final remote lineage is unknown
      const closeP = closeSession(f.session.sessionId);
      await vi.waitFor(() => expect(f.d.riffCloseState).toMatchObject({
        phase: 'preparing',
        requestId: expect.any(String),
      }));

      worker.emit('exit', 1, null);
      await expect(closeP).resolves.toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_worker_close_failed',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(f.d.worker).toBeNull();
      expect(f.d.riffCloseState).toMatchObject({
        phase: 'uncertain',
        requestId: expect.any(String),
        taskId: 'task-riff-123',
      });
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();

      // Neither a normal turn nor a second /close may reuse/cancel the stale
      // persisted parent while an unreported late child may exist remotely.
      expect(sendWorkerInput(f.d, 'must remain fenced', 'om_uncertain')).toBe(false);
      await expect(closeSession(f.session.sessionId)).resolves.toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_close_reconciliation_required',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it('aborts a successful prepare when durable close throws, preserves lineage, and retries', async () => {
    const f = await fixture(true, true, true, { holdAbortAck: true });
    const closeSpy = vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    try {
      const worker = f.d.worker as any;
      const firstPromise = closeSession(f.session.sessionId);
      await vi.waitFor(() => expect(worker.send.mock.calls.some(
        ([message]: any[]) => message.type === 'close_abort',
      )).toBe(true));
      const closeRequest = worker.send.mock.calls.find(([m]: any[]) => m.type === 'close')?.[0];
      expect(f.d.riffCloseState).toMatchObject({
        phase: 'prepared',
        requestId: closeRequest.requestId,
      });
      expect(sendWorkerInput(f.d, 'must wait for abort ACK', 'om_abort_race')).toBe(false);
      worker.emit('message', {
        type: 'close_abort_result',
        requestId: closeRequest.requestId,
        ok: true,
      });
      const first = await firstPromise;
      expect(first).toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_durable_close_failed',
        retryable: true,
        taskId: 'task-riff-123',
      });
      expect(worker.send).toHaveBeenCalledWith({ type: 'close_abort', requestId: closeRequest.requestId });
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
      expect(f.registry.get(activeSessionKey(f.d))).toBe(f.d);
      expect(sendWorkerInput(f.d, 'after abort', 'om_after_abort')).toBe(true);

      // The retry uses a new request and may ACK normally.
      const originalSend = worker.send.getMockImplementation();
      worker.send.mockImplementation((message: any) => {
        if (message.type === 'close_abort') {
          queueMicrotask(() => worker.emit('message', {
            type: 'close_abort_result',
            requestId: message.requestId,
            ok: true,
          }));
          return;
        }
        originalSend?.(message);
      });
      const retried = await closeSession(f.session.sessionId);
      expect(retried).toEqual({ ok: true, alreadyClosed: false });
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
    } finally {
      closeSpy.mockRestore();
      f.cleanup();
    }
  });

  it('aborts when prepared lineage update throws and keeps the new task retryable', async () => {
    const f = await fixture(true, true, true, { resultTaskId: 'task-riff-new' });
    const updateSpy = vi.spyOn(sessionStore, 'updateSession')
      .mockImplementationOnce(() => { throw new Error('lineage save failed'); });
    try {
      const worker = f.d.worker as any;
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({
        ok: false,
        alreadyClosed: false,
        error: 'riff_durable_close_failed',
        retryable: true,
        taskId: 'task-riff-new',
      });
      const closeRequest = worker.send.mock.calls.find(([m]: any[]) => m.type === 'close')?.[0];
      expect(worker.send).toHaveBeenCalledWith({ type: 'close_abort', requestId: closeRequest.requestId });
      expect(f.d.session.riffParentTaskId).toBe('task-riff-new');
      expect(f.d.riffCloseState).toBeUndefined();
      expect(sendWorkerInput(f.d, 'after lineage failure', 'om_lineage')).toBe(true);
    } finally {
      updateSpy.mockRestore();
      f.cleanup();
    }
  });

  it('commits the durable close safely when the worker exits after prepare ACK', async () => {
    const f = await fixture(true, true, true, { exitAfterResult: true });
    try {
      const worker = f.d.worker as any;
      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({ ok: true, alreadyClosed: false });
      expect(f.d.worker).toBeNull();
      expect(f.d.riffCloseState).toBeUndefined();
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
      expect(f.registry.size).toBe(0);
      expect(worker.send.mock.calls.some(([message]: any[]) => message.type === 'close_commit')).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it('removes every exact-object alias while preserving a same-key successor', async () => {
    const f = await fixture(true);
    try {
      const successorSession = sessionStore.createSession('oc_riff', 'om_successor', 'successor', 'group');
      successorSession.larkAppId = 'app';
      successorSession.scope = 'chat';
      sessionStore.updateSession(successorSession);
      const successor = ds({
        chatId: successorSession.chatId,
        scope: 'chat',
        session: successorSession,
        initConfig: { backendType: 'pty' } as any,
      });
      f.registry.clear();
      f.registry.set('legacy-alias-a', f.d);
      f.registry.set('legacy-alias-b', f.d);
      f.registry.set(activeSessionKey(f.d), successor);

      const result = await closeSession(f.session.sessionId);
      expect(result).toEqual({ ok: true, alreadyClosed: false });
      expect(f.registry.get(activeSessionKey(f.d))).toBe(successor);
      expect([...f.registry.values()]).toEqual([successor]);
    } finally {
      f.cleanup();
    }
  });

  it('fails closed on a worker-less same-key Riff collision and preserves route + task id', async () => {
    const f = await fixture(false);
    try {
      const incomingSession = sessionStore.createSession('oc_riff', 'om_incoming', 'incoming', 'group');
      incomingSession.larkAppId = 'app';
      incomingSession.scope = 'chat';
      sessionStore.updateSession(incomingSession);
      const incoming = ds({
        chatId: incomingSession.chatId,
        scope: 'chat',
        session: incomingSession,
        initConfig: { backendType: 'pty' } as any,
      });
      const key = activeSessionKey(f.d);

      const result = await setActiveSessionSafe(f.registry, key, incoming);
      expect(result).toMatchObject({
        accepted: false,
        reason: 'cleanup_failed',
        keptSessionId: f.session.sessionId,
        preservedIncomingSessionId: incomingSession.sessionId,
        cleanupSessionId: f.session.sessionId,
        error: 'riff_cancel_failed',
        taskId: 'task-riff-123',
      });
      expect(f.registry.get(key)).toBe(f.d);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
      expect(sessionStore.getSession(incomingSession.sessionId)).toMatchObject({ status: 'active' });
    } finally {
      f.cleanup();
    }
  });

  it('uses the live Riff prepare/commit handshake before replacing a collision owner', async () => {
    const f = await fixture(true, true);
    try {
      const worker = f.d.worker as any;
      const incomingSession = sessionStore.createSession('oc_riff', 'om_incoming_live', 'incoming', 'group');
      incomingSession.larkAppId = 'app';
      incomingSession.scope = 'chat';
      sessionStore.updateSession(incomingSession);
      const incoming = ds({
        chatId: incomingSession.chatId,
        scope: 'chat',
        session: incomingSession,
        initConfig: { backendType: 'pty' } as any,
      });
      const key = activeSessionKey(f.d);

      const result = await setActiveSessionSafe(f.registry, key, incoming);
      expect(result).toEqual({ accepted: true, closedSessionId: f.session.sessionId });
      const closeRequest = worker.send.mock.calls.find(([m]: any[]) => m.type === 'close')?.[0];
      expect(worker.send).toHaveBeenCalledWith({ type: 'close_commit', requestId: closeRequest.requestId });
      expect(f.registry.get(key)).toBe(incoming);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({ status: 'closed' });
    } finally {
      f.cleanup();
    }
  });

  it('preserves a live Riff collision owner when prepare cancellation fails', async () => {
    const f = await fixture(false, true);
    try {
      const incomingSession = sessionStore.createSession('oc_riff', 'om_incoming_live_fail', 'incoming', 'group');
      incomingSession.larkAppId = 'app';
      incomingSession.scope = 'chat';
      sessionStore.updateSession(incomingSession);
      const incoming = ds({
        chatId: incomingSession.chatId,
        scope: 'chat',
        session: incomingSession,
        initConfig: { backendType: 'pty' } as any,
      });
      const key = activeSessionKey(f.d);

      const result = await setActiveSessionSafe(f.registry, key, incoming);
      expect(result).toMatchObject({
        accepted: false,
        reason: 'cleanup_failed',
        cleanupSessionId: f.session.sessionId,
        taskId: 'task-riff-123',
      });
      expect(f.registry.get(key)).toBe(f.d);
      expect(f.d.worker).not.toBeNull();
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
    } finally {
      f.cleanup();
    }
  });

  it('refuses distinct owners of the same durable session id without cancelling or closing it', async () => {
    const f = await fixture(true);
    try {
      const incoming = ds({
        chatId: f.session.chatId,
        scope: 'chat',
        session: { ...f.session },
        initConfig: { backendType: 'riff' } as any,
      });
      const key = activeSessionKey(f.d);

      const result = await setActiveSessionSafe(f.registry, key, incoming);
      expect(result).toEqual({
        accepted: false,
        reason: 'cleanup_failed',
        keptSessionId: f.session.sessionId,
        preservedIncomingSessionId: f.session.sessionId,
        cleanupSessionId: f.session.sessionId,
        error: 'ambiguous_session_id',
      });
      expect(cancelRiffTaskMock).not.toHaveBeenCalled();
      expect(f.registry.get(key)).toBe(f.d);
      expect(sessionStore.getSession(f.session.sessionId)).toMatchObject({
        status: 'active',
        riffParentTaskId: 'task-riff-123',
      });
    } finally {
      f.cleanup();
    }
  });
});

describe('killWorker — orphaned backing session teardown (no live worker)', () => {
  it('destroys the tmux backing session by deterministic name', () => {
    const d = ds({ managedTurnOrigin: { capability: 'cap-stale', turnId: 'om-stale' } }, { backendType: 'tmux' });
    killWorker(d);
    expect(tmuxKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
    expect(d.managedTurnOrigin).toBeUndefined();
  });

  it('destroys the herdr backing session', () => {
    killWorker(ds({}, { backendType: 'herdr' }));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('destroys the zellij backing session', () => {
    killWorker(ds({}, { backendType: 'zellij' }));
    expect(zellijKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('does nothing for a non-persistent pty backend', () => {
    killWorker(ds({}, { backendType: 'pty' }));
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (initConfig.adoptMode) — never kills the user\'s own pane', () => {
    killWorker(ds({}, { backendType: 'tmux', adoptMode: true }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (ds.adoptedFrom set)', () => {
    killWorker(ds({ adoptedFrom: { source: 'tmux' } as any }, { backendType: 'tmux' }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('falls back to the bot config backendType when initConfig is absent (lazy-restored session)', () => {
    getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: { backendType: 'herdr' } } as any);
    killWorker(ds({ initConfig: undefined } as any, {}));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });
});

describe('killWorker — with a live worker (unchanged path)', () => {
  it('sends the close IPC to the worker and does NOT kill the backing session directly', () => {
    const send = vi.fn();
    const d = ds({
      worker: { killed: false, send, once: vi.fn() } as any,
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
    }, { backendType: 'tmux' });
    killWorker(d);
    expect(send).toHaveBeenCalledWith({ type: 'close' });
    // The live worker's own destroySession() handles teardown — daemon must not
    // double-kill here.
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(d.worker).toBeNull();
    expect(d.managedTurnOrigin).toBeUndefined();
  });

  it('refuses an unprepared live Riff retirement without mutating worker authority or lineage', () => {
    const send = vi.fn();
    const worker = { killed: false, send, once: vi.fn() } as any;
    const d = ds({
      worker,
      managedTurnOrigin: { capability: 'cap-riff-live', turnId: 'om-riff-live' },
      session: { sessionId: SID, backendType: 'riff', riffParentTaskId: 'task-live-riff' } as any,
    }, { backendType: 'riff' });

    killWorker(d);

    expect(send).not.toHaveBeenCalled();
    expect(cancelRiffTaskMock).not.toHaveBeenCalled();
    expect(d.session.riffParentTaskId).toBe('task-live-riff');
    expect(d.worker).toBe(worker);
    expect(d.managedTurnOrigin).toEqual({ capability: 'cap-riff-live', turnId: 'om-riff-live' });
  });
});
