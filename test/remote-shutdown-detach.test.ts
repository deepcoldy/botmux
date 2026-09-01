import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  abortRemoteShutdownFleet,
  abortPreparedRemoteShutdown,
  canAbortVerifiedExitedRemotePreparation,
  collectUniqueDaemonShutdownSessions,
  commitPreparedRemoteShutdown,
  detachRemoteWorkerForShutdown,
  persistPreparedRemoteShutdown,
  persistPreparedRemoteShutdownFleet,
  prepareRemoteFleetForShutdown,
  prepareRemoteSessionForShutdown,
  type FencedRemoteShutdownParticipant,
  type PreparedRemoteShutdown,
} from '../src/core/remote-shutdown-detach.js';
import { sendWorkerInput } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { mutatePersistedSessionRow } from './helpers/session-store-disk.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type FakeWorker = EventEmitter & {
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

describe('Remote graceful daemon-shutdown detach coordinator', () => {
  let dataDir: string;
  let previousDataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-riff-shutdown-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.session.dataDir = previousDataDir;
    sessionStore.init();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fixture(
    initialTaskId: string | undefined,
    onSend: (worker: FakeWorker, message: any) => void,
    backendType: 'riff' | 'mojo' = 'riff',
  ): { ds: DaemonSession; worker: FakeWorker; messages: any[] } {
    const session = sessionStore.createSession('oc_riff', 'om_riff', 'riff shutdown', 'group');
    session.larkAppId = 'app';
    session.backendType = backendType;
    session.riffParentTaskId = initialTaskId;
    sessionStore.updateSession(session);
    const messages: any[] = [];
    const worker = new EventEmitter() as FakeWorker;
    worker.killed = false;
    worker.exitCode = null;
    worker.signalCode = null;
    worker.kill = vi.fn();
    worker.send = vi.fn((message: any) => {
      messages.push(message);
      onSend(worker, message);
    });
    const ds = {
      larkAppId: 'app',
      chatId: session.chatId,
      chatType: 'group',
      scope: 'chat',
      session,
      worker,
      workerPort: 4100,
      workerToken: 'write',
      workerViewToken: 'view',
      managedTurnOrigin: { capability: 'cap' },
      initConfig: { backendType },
    } as unknown as DaemonSession;
    return { ds, worker, messages };
  }

  function asPrepared(
    result: Awaited<ReturnType<typeof prepareRemoteSessionForShutdown>>,
  ): PreparedRemoteShutdown {
    if (!result.ok) throw new Error(`expected prepared remote shutdown: ${result.error}`);
    return result;
  }

  function asFenced(
    result: Awaited<ReturnType<typeof prepareRemoteSessionForShutdown>>,
  ): FencedRemoteShutdownParticipant {
    if (result.fence === 'none') throw new Error(`expected fenced remote shutdown: ${result.error}`);
    return result;
  }

  it('transactional lineage persistence rolls back its in-memory field when save throws', () => {
    const session = sessionStore.createSession('oc_txn', 'om_txn', 'txn', 'group');
    session.backendType = 'riff';
    session.riffParentTaskId = 'task-before';
    sessionStore.updateSession(session);
    // SQLite 行写不经过文件路径拼装，失败注入改走 store 的 test-only 钩子。
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('simulated durable lineage write failure'); });

    try {
      expect(() => sessionStore.persistActiveRemoteLineageExact(session.sessionId, 'task-after')).toThrow();
      expect(session.riffParentTaskId).toBe('task-before');
    } finally {
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
    }
    expect(sessionStore.getSessionFresh(session.sessionId)?.riffParentTaskId).toBe('task-before');
  });

  it('deduplicates multiple registry aliases to the exact same daemon session object', () => {
    const f = fixture('task-parent', () => { /* no IPC */ });

    expect(collectUniqueDaemonShutdownSessions([f.ds, f.ds, f.ds])).toEqual({
      ok: true,
      sessions: [f.ds],
    });
  });

  it('fails closed when distinct daemon session objects claim the same session id', () => {
    const f = fixture('task-parent', () => { /* no IPC */ });
    const competing = {
      ...f.ds,
      session: { ...f.ds.session },
    } as DaemonSession;

    expect(collectUniqueDaemonShutdownSessions([f.ds, competing])).toMatchObject({
      ok: false,
      sessionId: f.ds.session.sessionId,
      error: expect.stringContaining('distinct daemon session generations'),
    });
  });

  it('persists and commits a Mojo lineage through the shared remote transaction', async () => {
    const f = fixture(undefined, (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'prepare',
          ok: true,
          taskId: 'mojo-preinit-lineage',
        }));
      }
    }, 'mojo');

    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    expect(prepared.taskId).toBe('mojo-preinit-lineage');
    expect(persistPreparedRemoteShutdown(f.ds, prepared)).toEqual({ ok: true });
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('mojo-preinit-lineage');
    expect(commitPreparedRemoteShutdown(f.ds, prepared)).toBe(true);
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_commit',
    ]);
    expect(f.ds.worker).toBeNull();
  });

  it('retains only the ambiguous session fence and restores an unrelated prepared peer', async () => {
    const first = fixture('task-first', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-first-child',
        }));
      }
    });
    const second = fixture('task-second', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-second-child',
        }));
      } else if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'abort', ok: true, taskId: 'task-second-child',
        }));
      }
    });
    const prepared = await prepareRemoteFleetForShutdown([first.ds, second.ds]);
    const competingFirst = {
      ...first.ds,
      session: { ...first.ds.session },
    } as DaemonSession;
    const current = collectUniqueDaemonShutdownSessions([
      first.ds,
      competingFirst,
      second.ds,
    ]);
    if (current.ok) throw new Error('expected ambiguous daemon session id');

    const restored = await abortRemoteShutdownFleet(prepared
      .filter(({ ds }) => ds.session.sessionId !== current.sessionId)
      .map(({ ds, result }) => ({ ds, result: asFenced(result) })));

    expect(restored).toHaveLength(1);
    expect(restored[0].result.ok).toBe(true);
    expect(first.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(first.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(second.ds.remoteShutdownState).toBeUndefined();
    expect(second.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
  });

  it('refuses an initial durable-read failure before installing any worker fence', async () => {
    vi.spyOn(sessionStore, 'getActiveRemoteShutdownSnapshotsBatch').mockImplementation(() => {
      throw new Error('lock unavailable');
    });
    const f = fixture('task-parent', () => { /* no worker IPC is safe */ });

    await expect(prepareRemoteSessionForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      taskId: 'task-parent',
      error: 'durable_session_read_failed:lock unavailable',
    });
    expect(f.ds.remoteShutdownState).toBeUndefined();
    expect(f.ds.worker).toBe(f.worker);
    expect(f.messages).toEqual([]);
  });

  it('takes one all-owner snapshot before publishing any fleet prepare request', async () => {
    const first = fixture('task-first', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-first-child',
        }));
      }
    });
    const second = fixture('task-second', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-second-child',
        }));
      }
    });
    first.ds.session.pid = 101;
    second.ds.session.pid = 202;
    sessionStore.updateSession(first.ds.session);
    sessionStore.updateSession(second.ds.session);
    const originalSnapshot = sessionStore.getActiveRemoteShutdownSnapshotsBatch;
    const snapshot = vi.spyOn(sessionStore, 'getActiveRemoteShutdownSnapshotsBatch')
      .mockImplementation((sessionIds) => {
        expect(first.messages).toEqual([]);
        expect(second.messages).toEqual([]);
        return originalSnapshot(sessionIds);
      });

    const results = await prepareRemoteFleetForShutdown([first.ds, second.ds]);

    expect(snapshot).toHaveBeenCalledTimes(1);
    // 等待上限现在由 SQLite busy_timeout 决定，批量快照只收 sessionIds 一个参数。
    expect(snapshot).toHaveBeenCalledWith([
      first.ds.session.sessionId,
      second.ds.session.sessionId,
    ]);
    expect(results.every(entry => entry.result.ok)).toBe(true);
    expect(first.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(second.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
  });

  it('does not inline-abort a timed-out prepare and restores all owners in one concurrent wave', async () => {
    let firstAbortRequestId: string | undefined;
    let secondAbortRequestId: string | undefined;
    const first = fixture('task-first', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-first-child',
        }));
      } else if (message.type === 'remote_shutdown_abort') {
        firstAbortRequestId = message.requestId;
      }
    });
    const second = fixture('task-second', (_worker, message) => {
      if (message.type === 'remote_shutdown_abort') secondAbortRequestId = message.requestId;
      // Deliberately never ACK prepare so its fence state is ambiguous.
    });
    first.ds.session.pid = 101;
    second.ds.session.pid = 202;
    sessionStore.updateSession(first.ds.session);
    sessionStore.updateSession(second.ds.session);

    const prepared = await prepareRemoteFleetForShutdown([first.ds, second.ds], {
      drainTimeoutMs: 5,
      abortTimeoutMs: 200,
    });
    expect(prepared[0].result).toMatchObject({ ok: true, fence: 'prepared' });
    expect(prepared[1].result).toMatchObject({ ok: false, fence: 'possible' });
    expect(first.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(second.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);

    const aborting = abortRemoteShutdownFleet(prepared.map(({ ds, result }) => ({
      ds,
      result: asFenced(result),
    })), { abortTimeoutMs: 200 });
    await vi.waitFor(() => {
      expect(firstAbortRequestId).toEqual(expect.any(String));
      expect(secondAbortRequestId).toEqual(expect.any(String));
    });
    expect(first.messages.filter(message => message.type === 'remote_shutdown_abort')).toHaveLength(1);
    expect(second.messages.filter(message => message.type === 'remote_shutdown_abort')).toHaveLength(1);

    first.worker.emit('message', {
      type: 'remote_shutdown_result', requestId: firstAbortRequestId,
      phase: 'abort', ok: true, taskId: 'task-first-child',
    });
    second.worker.emit('message', {
      type: 'remote_shutdown_result', requestId: secondAbortRequestId,
      phase: 'abort', ok: true, taskId: 'task-second',
    });
    await expect(aborting).resolves.toSatisfy(
      (results: Array<{ result: { ok: boolean } }>) => results.every(entry => entry.result.ok),
    );
    expect(first.ds.remoteShutdownState).toBeUndefined();
    expect(second.ds.remoteShutdownState).toBeUndefined();

    // A prepare ACK arriving after the exact abort wave is inert.
    second.worker.emit('message', {
      type: 'remote_shutdown_result', requestId: secondAbortRequestId,
      phase: 'prepare', ok: true, taskId: 'task-late-ack',
    });
    expect(second.ds.remoteShutdownState).toBeUndefined();
    expect(second.messages.some(message => message.type === 'remote_shutdown_commit')).toBe(false);
  });

  it.each(['explicit_close_in_progress', 'not_remote_backend'])(
    'classifies exact pre-fence worker refusal %s without sending abort',
    async (error) => {
      const f = fixture('task-parent', (worker, message) => {
        if (message.type === 'remote_shutdown_prepare') {
          queueMicrotask(() => worker.emit('message', {
            type: 'remote_shutdown_result', requestId: message.requestId,
            phase: 'prepare', ok: false, taskId: null, error,
          }));
        }
      });

      await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
        ok: false,
        fence: 'none',
        error,
      });
      expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
      expect(f.ds.remoteShutdownState).toBeUndefined();
      expect(f.ds.worker).toBe(f.worker);
    },
  );

  it('clears the synthetic daemon fence when prepare IPC throws before it can be queued', async () => {
    const f = fixture('task-parent', () => { /* send is replaced below */ });
    f.worker.send.mockImplementation(() => { throw new Error('IPC channel closed'); });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      fence: 'none',
      error: 'remote_shutdown_prepare_send_failed',
    });
    expect(f.messages).toEqual([]);
    expect(f.ds.remoteShutdownState).toBeUndefined();
    expect(f.ds.worker).toBe(f.worker);
  });

  it('does not misclassify an existing older shutdown fence as a pre-fence refusal', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: false, taskId: null,
          error: 'shutdown detach already prepared as older-request',
        }));
      }
    });

    await expect(prepareRemoteSessionForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      fence: 'possible',
      error: 'shutdown detach already prepared as older-request',
    });
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'preparing' });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
  });

  it('refuses before a worker fence unless phase-2 plus the abort reserve remain', async () => {
    const f = fixture('task-parent', () => { /* no worker IPC is safe */ });
    const now = 10_000;

    await expect(prepareRemoteFleetForShutdown([f.ds], {
      deadlineMs: now + 1_500,
      abortTimeoutMs: 1_000,
      now: () => now,
    })).resolves.toMatchObject([{
      result: {
        ok: false,
        fence: 'none',
        error: 'insufficient_abort_budget_before_fence',
      },
    }]);
    expect(f.messages).toEqual([]);
    expect(f.ds.remoteShutdownState).toBeUndefined();
  });

  it('persists all prepared owners through one phase-2 batch call', async () => {
    const first = fixture('task-first', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-first-child',
        }));
      }
    });
    const second = fixture('task-second', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-second-child',
        }));
      }
    });
    const prepared = await prepareRemoteFleetForShutdown([first.ds, second.ds]);
    const entries = prepared.map(({ ds, result }) => ({ ds, result: asPrepared(result) }));
    const batch = vi.spyOn(sessionStore, 'persistActiveRemoteLineagesExactBatch');

    expect(persistPreparedRemoteShutdownFleet(entries)).toEqual({ ok: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSessionFresh(first.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-first-child');
    expect(sessionStore.getSessionFresh(second.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-second-child');
    expect(entries.every(({ result }) => result.lineageVerified)).toBe(true);
  });

  it('retains every fence when verified phase-2 persistence returns after the absolute deadline', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-child',
        }));
      }
    });
    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    const originalBatch = sessionStore.persistActiveRemoteLineagesExactBatch;
    let now = 10_000;
    const deadlineMs = 10_100;
    vi.spyOn(sessionStore, 'persistActiveRemoteLineagesExactBatch')
      .mockImplementation((updates) => {
        const published = originalBatch(updates);
        now = deadlineMs;
        return published;
      });

    const result = persistPreparedRemoteShutdownFleet(
      [{ ds: f.ds, result: prepared }],
      { deadlineMs, now: () => now },
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'shutdown_deadline_elapsed_after_batch_persist',
      rollbackDisposition: 'retain_fence',
      sessionIds: [f.ds.session.sessionId],
      retainFencedSessionIds: [f.ds.session.sessionId],
    });
    expect(prepared.lineageVerified).toBe(true);
    expect(f.ds.session.riffParentTaskId).toBe('task-child');
    expect(f.ds.remoteShutdownState).toMatchObject({ requestId: prepared.requestId });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
  });

  it.each([
    ['prewrite_ownership', 'affected'] as const,
    ['prewrite_io', 'none'] as const,
    ['postrename_ambiguity', 'all'] as const,
  ])('maps %s batch failure to the exact retain-fence set', async (stage, expected) => {
    const first = fixture('task-first', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-first-child',
        }));
      }
    });
    const second = fixture('task-second', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-second-child',
        }));
      }
    });
    const prepared = await prepareRemoteFleetForShutdown([first.ds, second.ds]);
    const entries = prepared.map(({ ds, result }) => ({ ds, result: asPrepared(result) }));
    const affected = stage === 'postrename_ambiguity'
      ? [first.ds.session.sessionId, second.ds.session.sessionId]
      : [second.ds.session.sessionId];
    vi.spyOn(sessionStore, 'persistActiveRemoteLineagesExactBatch').mockImplementation(() => {
      throw new sessionStore.RemoteLineageBatchError(stage, affected, `forced ${stage}`);
    });

    const result = persistPreparedRemoteShutdownFleet(entries);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected batch failure');
    expect(result.retainFencedSessionIds).toEqual(
      expected === 'all'
        ? [first.ds.session.sessionId, second.ds.session.sessionId]
        : expected === 'affected'
          ? [second.ds.session.sessionId]
          : [],
    );
  });

  it('retains the exact fence without writing when runtime owner changes after prepare', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-child',
        }));
      }
    });
    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    f.ds.session.pid = 999_999;
    const batch = vi.spyOn(sessionStore, 'persistActiveRemoteLineagesExactBatch');

    const result = persistPreparedRemoteShutdownFleet([{ ds: f.ds, result: prepared }]);

    expect(result).toMatchObject({
      ok: false,
      retainFencedSessionIds: [f.ds.session.sessionId],
      error: expect.stringContaining('runtime_owner_changed'),
    });
    expect(batch).not.toHaveBeenCalled();
    expect(f.ds.remoteShutdownState).toMatchObject({ requestId: prepared.requestId });
  });

  it('persists and fresh-verifies the exact late child before commit', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'prepare',
          ok: true,
          taskId: 'task-late-child',
        }));
      }
    });

    const result = await detachRemoteWorkerForShutdown(f.ds);
    expect(result).toMatchObject({
      ok: true,
      taskId: 'task-late-child',
      disposition: 'lineage_persisted',
    });
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_commit',
    ]);
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'task-late-child',
    });
    expect(f.ds.worker).toBeNull();
    expect(f.worker.kill).not.toHaveBeenCalled();
  });

  it('treats null as authoritative and clears a stale durable parent before commit', async () => {
    const f = fixture('task-stale-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'prepare',
          ok: true,
          taskId: null,
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: true,
      taskId: null,
      disposition: 'lineage_persisted',
    });
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_commit',
    ]);
  });

  it('restores the prepared worker without cancellation when durable persistence fails', async () => {
    vi.spyOn(sessionStore, 'persistActiveRemoteLineageExact').mockImplementation(() => {
      throw new Error('disk full');
    });
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'prepare',
          ok: true,
          taskId: 'task-exact-child',
        }));
      }
      if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'abort',
          ok: true,
          taskId: 'task-exact-child',
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      taskId: 'task-exact-child',
      error: expect.stringContaining('lineage_persist_failed:disk full'),
    });
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
    // Persistence never advanced, so the accepted remote task and its exact
    // worker generation remain live with admission restored.
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId).toBe('task-parent');
    expect(f.ds.worker).toBe(f.worker);
    expect(f.ds.remoteShutdownState).toBeUndefined();
    expect(f.messages.some(message => message.type === 'remote_shutdown_commit')).toBe(false);
    expect(f.messages.some(message => message.type === 'remote_shutdown_cancel')).toBe(false);
  });

  it('fails closed without commit or signal when persistence fails and abort is not ACKed', async () => {
    vi.spyOn(sessionStore, 'persistActiveRemoteLineageExact').mockImplementation(() => {
      throw new Error('disk full');
    });
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'prepare',
          ok: true,
          taskId: 'task-uncancellable',
        }));
      }
      if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'abort',
          ok: false,
          taskId: 'task-uncancellable',
          error: 'admission restore refused',
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      taskId: 'task-uncancellable',
      error: expect.stringContaining('admission_restore_failed:admission restore refused'),
    });
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
    expect(f.messages.some(message => message.type === 'remote_shutdown_commit')).toBe(false);
    expect(f.worker.kill).not.toHaveBeenCalled();
    expect(f.ds.worker).toBe(f.worker);
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
  });

  it('keeps the fence when an abort ACK reports a different task lineage', async () => {
    vi.spyOn(sessionStore, 'persistActiveRemoteLineageExact').mockImplementation(() => {
      throw new Error('disk full');
    });
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-prepared-child',
        }));
      }
      if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'abort', ok: true, taskId: 'task-unexpected-child',
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('abort_task_lineage_mismatch'),
    });
    expect(f.ds.worker).toBe(f.worker);
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
  });

  it('prepares and persists workerless runtime lineage before allowing commit', async () => {
    const f = fixture('task-durable-parent', () => { /* workerless: no IPC */ });
    f.ds.worker = null;
    f.ds.workerPort = null;
    f.ds.workerToken = null;
    f.ds.workerViewToken = null;
    // Simulate a prior ordinary riff_task_id save failure: runtime owns the
    // child while the durable row still names its parent.
    f.ds.session.riffParentTaskId = 'task-runtime-child';

    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    expect(prepared.worker).toBeNull();
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-durable-parent');

    expect(persistPreparedRemoteShutdown(f.ds, prepared)).toEqual({ ok: true });
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-runtime-child');
    expect(commitPreparedRemoteShutdown(f.ds, prepared)).toBe(true);
    expect(f.ds.remoteShutdownState).toBeUndefined();
    expect(f.messages).toEqual([]);
  });

  it('aborts every prepared peer and commits none when one workerless lineage write fails', async () => {
    const live = fixture('task-live-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-live-child',
        }));
      }
      if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'abort', ok: true, taskId: 'task-live-child',
        }));
      }
    });
    const workerless = fixture('task-workerless-parent', () => { /* no IPC */ });
    workerless.ds.worker = null;
    workerless.ds.session.riffParentTaskId = 'task-workerless-runtime-child';

    const [livePrepared, workerlessPrepared] = await Promise.all([
      prepareRemoteSessionForShutdown(live.ds),
      prepareRemoteSessionForShutdown(workerless.ds),
    ]).then(results => results.map(asPrepared));
    const originalPersist = sessionStore.persistActiveRemoteLineageExact;
    vi.spyOn(sessionStore, 'persistActiveRemoteLineageExact').mockImplementation(
      (sessionId, taskId) => {
        if (sessionId === workerless.ds.session.sessionId) throw new Error('target disk full');
        return originalPersist(sessionId, taskId);
      },
    );

    const persistence = [
      persistPreparedRemoteShutdown(live.ds, livePrepared!),
      persistPreparedRemoteShutdown(workerless.ds, workerlessPrepared!),
    ];
    expect(persistence[0]).toEqual({ ok: true });
    expect(persistence[1]).toMatchObject({
      ok: false,
      error: expect.stringContaining('target disk full'),
    });

    await Promise.all([
      abortPreparedRemoteShutdown(live.ds, livePrepared!),
      abortPreparedRemoteShutdown(workerless.ds, workerlessPrepared!),
    ]);
    expect(live.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
    expect(live.messages.some(message => message.type === 'remote_shutdown_commit')).toBe(false);
    expect(live.ds.worker).toBe(live.worker);
    expect(live.ds.remoteShutdownState).toBeUndefined();
    expect(workerless.ds.remoteShutdownState).toBeUndefined();
    expect(sessionStore.getSessionFresh(workerless.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-workerless-parent');
  });

  it('retains a fail-closed fence when an unverified prepared worker exits before abort', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-unverified-child',
        }));
      }
    });
    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    f.worker.exitCode = 1;
    // worker-pool clears the exact dead child handle but retains this request's
    // shutdown fence for the coordinator.
    f.ds.worker = null;

    expect(persistPreparedRemoteShutdown(f.ds, prepared)).toMatchObject({
      ok: false,
      error: 'stale_worker_generation',
    });
    await expect(abortPreparedRemoteShutdown(f.ds, prepared)).resolves.toMatchObject({
      ok: false,
      error: 'worker_exited_before_admission_restore',
    });
    expect(f.ds.worker).toBeNull();
    expect(f.ds.remoteShutdownState).toMatchObject({
      phase: 'prepared',
      requestId: prepared.requestId,
    });
    expect(sendWorkerInput(f.ds, 'must stay fenced', 'turn-exited-unverified')).toBe(false);
  });

  it('classifies an unexpected durable lineage as ownership loss and never overwrites it', async () => {
    const f = fixture('task-durable-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => {
          // Simulate a different process advancing the durable owner after
          // prepare, without changing this daemon's runtime generation.
          mutatePersistedSessionRow(dataDir, 'app', f.ds.session.sessionId, (row) => {
            row.riffParentTaskId = 'task-external-owner';
          });
          worker.emit('message', {
            type: 'remote_shutdown_result', requestId: message.requestId,
            phase: 'prepare', ok: true, taskId: 'task-prepared-child',
          });
        });
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('compare-and-set failed'),
      rollbackDisposition: 'retain_fence',
    });
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-external-owner');
    expect(f.ds.remoteShutdownState).toMatchObject({
      phase: 'prepared',
    });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
  });

  it('retains the fence when durable worker ownership changes with the same lineage', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => {
          mutatePersistedSessionRow(dataDir, 'app', f.ds.session.sessionId, (row) => {
            row.pid = 999_999;
          });
          worker.emit('message', {
            type: 'remote_shutdown_result', requestId: message.requestId,
            phase: 'prepare', ok: true, taskId: 'task-prepared-child',
          });
        });
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('owner compare-and-set failed'),
      rollbackDisposition: 'retain_fence',
    });
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)).toMatchObject({
      pid: 999_999,
      riffParentTaskId: 'task-parent',
    });
  });

  it('retains the fence when ownership is replaced after CAS with the same task id', async () => {
    const originalPersist = sessionStore.persistActiveRemoteLineageExact;
    vi.spyOn(sessionStore, 'persistActiveRemoteLineageExact').mockImplementation(
      (sessionId, taskId, options) => {
        const result = originalPersist(sessionId, taskId, options);
        // Exact replacement race: CAS wrote the expected task, then a new
        // durable owner published the same task before the separate readback.
        mutatePersistedSessionRow(dataDir, 'app', sessionId, (row) => {
          row.pid = 888_888;
        });
        return result;
      },
    );
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-same-after-replacement',
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      taskId: 'task-same-after-replacement',
      error: expect.stringContaining('fresh_lineage_verification_failed:'),
      rollbackDisposition: 'retain_fence',
    });
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)).toMatchObject({
      pid: 888_888,
      riffParentTaskId: 'task-same-after-replacement',
    });
  });

  it('retains the fence when the post-write fresh verification cannot be read', async () => {
    const originalFresh = sessionStore.getSessionFresh;
    let reads = 0;
    vi.spyOn(sessionStore, 'getSessionFresh').mockImplementation(sessionId => {
      reads++;
      if (reads === 1) throw new Error('lock unavailable');
      return originalFresh(sessionId);
    });
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-written-not-verified',
        }));
      }
    });

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: 'fresh_lineage_verification_failed:lock unavailable',
      rollbackDisposition: 'retain_fence',
    });
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'prepared' });
    expect(f.messages.map(message => message.type)).toEqual(['remote_shutdown_prepare']);
    expect(originalFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-written-not-verified');
  });

  it('can release an exited prepared generation only after its lineage was durably verified', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-verified-child',
        }));
      }
    });
    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    expect(persistPreparedRemoteShutdown(f.ds, prepared)).toEqual({ ok: true });
    f.worker.exitCode = 0;
    f.ds.worker = null;

    expect(canAbortVerifiedExitedRemotePreparation(f.ds, prepared)).toBe(true);

    await expect(abortPreparedRemoteShutdown(f.ds, prepared)).resolves.toEqual({
      ok: true,
      taskId: 'task-verified-child',
    });
    expect(f.ds.worker).toBeNull();
    expect(f.ds.remoteShutdownState).toBeUndefined();
    expect(sessionStore.getSessionFresh(f.ds.session.sessionId)?.riffParentTaskId)
      .toBe('task-verified-child');
  });

  it('does not bless a replacement generation when the verified prepared worker exits', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_prepare') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result', requestId: message.requestId,
          phase: 'prepare', ok: true, taskId: 'task-verified-before-replacement',
        }));
      }
    });
    const prepared = asPrepared(await prepareRemoteSessionForShutdown(f.ds));
    expect(persistPreparedRemoteShutdown(f.ds, prepared)).toEqual({ ok: true });
    f.worker.exitCode = 0;
    const replacement = new EventEmitter() as FakeWorker;
    replacement.killed = false;
    replacement.exitCode = null;
    replacement.signalCode = null;
    replacement.send = vi.fn();
    replacement.kill = vi.fn();
    f.ds.worker = replacement;

    expect(canAbortVerifiedExitedRemotePreparation(f.ds, prepared)).toBe(false);

    await expect(abortPreparedRemoteShutdown(f.ds, prepared)).resolves.toMatchObject({
      ok: false,
      taskId: 'task-verified-before-replacement',
      error: 'new_worker_generation',
    });
    expect(f.ds.worker).toBe(replacement);
    expect(f.ds.remoteShutdownState).toMatchObject({
      phase: 'prepared',
      requestId: prepared.requestId,
    });
    expect(replacement.send).not.toHaveBeenCalled();
  });

  it('times out boundedly and restores the worker instead of falling through to generic kill', async () => {
    const f = fixture('task-parent', (worker, message) => {
      if (message.type === 'remote_shutdown_abort') {
        queueMicrotask(() => worker.emit('message', {
          type: 'remote_shutdown_result',
          requestId: message.requestId,
          phase: 'abort',
          ok: true,
          taskId: 'task-parent',
        }));
      }
    });
    const result = await detachRemoteWorkerForShutdown(f.ds, {
      drainTimeoutMs: 10,
      abortTimeoutMs: 100,
    });

    expect(result).toMatchObject({ ok: false, error: 'remote_shutdown_prepare_timeout' });
    expect(f.messages.map(message => message.type)).toEqual([
      'remote_shutdown_prepare',
      'remote_shutdown_abort',
    ]);
    expect(f.worker.kill).not.toHaveBeenCalled();
    expect(f.ds.worker).toBe(f.worker);
  });

  it('keeps daemon admission fenced until delayed abort restoration is ACKed', async () => {
    let abortRequestId: string | undefined;
    const f = fixture('task-parent', (_worker, message) => {
      if (message.type === 'remote_shutdown_abort') abortRequestId = message.requestId;
    });
    const detach = detachRemoteWorkerForShutdown(f.ds, {
      drainTimeoutMs: 5,
      abortTimeoutMs: 200,
    });
    await vi.waitFor(() => expect(abortRequestId).toEqual(expect.any(String)));

    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'preparing' });
    expect(sendWorkerInput(f.ds, 'must remain fenced', 'turn-during-abort')).toBe(false);
    expect(f.messages.some(message => message.type === 'remote_shutdown_commit')).toBe(false);
    expect(f.worker.kill).not.toHaveBeenCalled();

    f.worker.emit('message', {
      type: 'remote_shutdown_result',
      requestId: abortRequestId,
      phase: 'abort',
      ok: true,
      taskId: 'task-parent',
    });
    await expect(detach).resolves.toMatchObject({
      ok: false,
      error: 'remote_shutdown_prepare_timeout',
    });
    expect(f.ds.remoteShutdownState).toBeUndefined();
  });

  it('refuses before worker prepare when daemon-owned raw/follow-up input is pending', async () => {
    const f = fixture('task-parent', () => { /* no worker IPC is safe */ });
    f.ds.pendingRawInput = '/goal keep this';
    f.ds.pendingFollowUpInput = {
      userPrompt: 'follow-up',
      cliInput: '<user_message>follow-up</user_message>',
    };

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('daemon_inputs_not_drained:'),
    });
    expect(f.messages).toEqual([]);
    expect(f.worker.kill).not.toHaveBeenCalled();
    expect(f.ds.worker).toBe(f.worker);
  });

  it('refuses before worker prepare while a durable queued backlog is pending', async () => {
    const f = fixture('task-parent', () => { /* no worker IPC is safe */ });
    f.ds.session.queued = true;

    await expect(detachRemoteWorkerForShutdown(f.ds)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('queued=1'),
    });
    expect(f.messages).toEqual([]);
    expect(f.worker.kill).not.toHaveBeenCalled();
    expect(f.ds.worker).toBe(f.worker);
  });

  it('retains the fail-closed fence when abort restoration cannot be confirmed', async () => {
    const f = fixture('task-parent', () => { /* prepare and abort both held */ });
    const result = await detachRemoteWorkerForShutdown(f.ds, {
      drainTimeoutMs: 5,
      abortTimeoutMs: 5,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('admission_restore_failed:remote_shutdown_abort_timeout'),
    });
    expect(f.ds.remoteShutdownState).toMatchObject({ phase: 'preparing' });
    expect(sendWorkerInput(f.ds, 'still blocked', 'turn-fail-closed')).toBe(false);
    expect(f.worker.kill).not.toHaveBeenCalled();
  });
});
