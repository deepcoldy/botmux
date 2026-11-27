import './helpers/require-fenced-data-dir.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { cancelPreReadyScheduledWorkers, hasRecoverableActivationHead, retryCancelledActivationPersistence } from '../src/core/deferred-schedule-settlement.js';

const root = mkdtempSync(join(tmpdir(), 'botmux-cancel-wal-restart-'));
const APP = 'cli_cancel_wal_restart';
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scheduled cancellation write-ahead recovery', () => {
  it('filters an old tail after the cleanup write fails and the daemon restarts', async () => {
    config.session.dataDir = join(root, 'data');
    registerBot({ larkAppId: APP, larkAppSecret: '', apiOnly: true, cliId: 'pi', workingDir: root, allowedUsers: [] } as any);
    sessionStore.init(APP);
    workerPool.initWorkerPool({
      sessionReply: async () => 'om_reply', getSessionWorkingDir: () => root,
      getActiveCount: () => 1, closeSession: async () => {},
    } as any);
    const runId = 'run-cancel-wal';
    const turnId = 'schedule:cancel-wal';
    const session = sessionStore.createSession('oc_cancel_wal', 'om_cancel_wal', 'cancel wal');
    Object.assign(session, {
      larkAppId: APP, scope: 'thread', cliId: 'pi', cliSessionId: 'human-native', workingDir: root,
      creationSource: 'schedule', backendType: 'pty',
      scheduledRuns: { [turnId]: { taskId: 'task-cancel-wal', runId, turnId } },
      queuedActivationTail: [{ id: 'tail-cancel-wal', order: 1, userPrompt: 'CANCELLED_MARKER', cliInput: { content: 'CANCELLED_MARKER' }, turnId }],
      queuedActivationTailNextOrder: 2,
    });
    sessionStore.updateSession(session);
    const ds = { session, worker: { killed: false }, workerReady: false, hasHistory: true } as any;
    let writes = 0;
    cancelPreReadyScheduledWorkers([ds], runId, async () => {}, {
      updateSession: row => {
        writes += 1;
        if (writes === 1) sessionStore.updateSession(row);
        else throw new Error('controlled cleanup write failure');
      },
    });
    await Promise.resolve();

    sessionStore.init(APP);
    const fresh = sessionStore.getSession(session.sessionId)!;
    expect(fresh.queuedActivationTail?.map(entry => entry.turnId)).toEqual([turnId]);
    expect(fresh.cancelledActivationTurnIds).toContain(turnId);
    const restored = {
      session: fresh, worker: null, hasHistory: true, initialStartPending: true,
      larkAppId: APP, chatId: fresh.chatId, chatType: 'group', scope: 'thread', workingDir: root,
    } as any;
    expect(workerPool.promoteQueuedActivationTail(restored, { send: false })).toBe(false);
    expect(restored.session.queuedActivationTurnId).toBeUndefined();
    expect(restored.session.queuedActivationPending).toBeUndefined();
  });

  it('preserves cancellation state across a real store rollback and a later successful retry', () => {
    config.session.dataDir = join(root, 'data');
    sessionStore.init(APP);
    const runId = 'run-retry-rollback';
    const turnId = 'schedule:retry-rollback';
    const session = sessionStore.createSession('oc_retry_rollback', 'om_retry_rollback', 'retry rollback');
    Object.assign(session, {
      larkAppId: APP, scope: 'thread', cliId: 'pi', cliSessionId: 'human-native', workingDir: root,
      creationSource: 'schedule', backendType: 'pty',
      scheduledRuns: { [turnId]: { taskId: 'task-retry-rollback', runId, turnId } },
      queuedActivationTail: [{ id: 'tail-retry-rollback', order: 1, userPrompt: 'CANCELLED_RETRY', cliInput: { content: 'CANCELLED_RETRY' }, turnId }],
    });
    sessionStore.updateSession(session);
    const ds = { session, worker: null, hasHistory: true, initialStartPending: true, initialStartClaimToken: 'claim-retry' } as any;
    let writes = 0;
    cancelPreReadyScheduledWorkers([ds], runId, () => {}, {
      updateSession: () => { writes += 1; throw new Error(`initial write ${writes}`); },
    });
    expect(writes).toBe(2);
    expect(ds.activationCancellationPending).toBe(true);
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.cancelledActivationTurnIds).toEqual([turnId]);

    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('real rollback on retry'); });
    try {
      expect(retryCancelledActivationPersistence(ds, sessionStore.updateSession)).toBe(false);
    } finally {
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
    }
    // The real store has now restored its durable pre-cancel row into session.
    // The retry guard must put the cancellation-owned snapshot back.
    expect(ds.activationCancellationPending).toBe(true);
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.cancelledActivationTurnIds).toEqual([turnId]);

    expect(retryCancelledActivationPersistence(ds, sessionStore.updateSession)).toBe(true);
    const durable = sessionStore.getSessionFresh(session.sessionId)!;
    expect(durable.queuedActivationTail).toBeUndefined();
    expect(durable.cancelledActivationTurnIds).toEqual([turnId]);
    expect(workerPool.promoteQueuedActivationTail(ds, { send: false })).toBe(false);
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedActivationTurnId).not.toBe(turnId);
  });

  it('refuses a tombstoned activation head at the final recovery boundary', () => {
    const head = {
      queuedActivationPending: true as const,
      queuedActivationTurnId: 'schedule:cancelled-head',
    };
    expect(hasRecoverableActivationHead({ ...head, cancelledActivationTurnIds: [head.queuedActivationTurnId] })).toBe(false);
    expect(hasRecoverableActivationHead({ ...head, cancelledActivationTurnIds: [] })).toBe(true);
  });
});
