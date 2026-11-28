import './helpers/require-fenced-data-dir.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { cancelPreReadyScheduledWorkers, hasRecoverableActivationHead, retryCancelledActivationPersistence, clearTombstonedActivationHeadForRelease, releaseCancelledActivationWork } from '../src/core/deferred-schedule-settlement.js';

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
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes += 1;
      throw new Error(`real store rollback ${writes}`);
    });
    try {
      cancelPreReadyScheduledWorkers([ds], runId, () => {});
      expect(writes).toBe(2);
      expect(ds.activationCancellationPending).toBe(true);
      expect(ds.session.queuedActivationTail).toBeUndefined();
      expect(ds.session.cancelledActivationTurnIds).toEqual([turnId]);

      expect(retryCancelledActivationPersistence(ds, sessionStore.updateSession)).toBe(false);
      expect(writes).toBe(3);
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

  it('keeps a cancelled journal head unexecutable when the cleanup write rolls back', async () => {
    config.session.dataDir = join(root, 'data');
    sessionStore.init(APP);
    const runId = 'run-journal-rollback';
    const turnId = 'schedule:journal-rollback';
    const humanTurnId = 'om_human_after_journal_rollback';
    const session = sessionStore.createSession('oc_journal_rollback', 'om_journal_rollback', 'journal rollback');
    Object.assign(session, {
      larkAppId: APP, scope: 'thread', cliId: 'pi', cliSessionId: 'human-native', workingDir: root,
      creationSource: 'schedule', backendType: 'pty', hasHistory: true,
      scheduledRuns: { [turnId]: { taskId: 'task-journal-rollback', runId, turnId } },
      queuedActivationPending: true, queuedActivationToken: 'tok-journal-rollback',
      queuedActivationInput: { content: 'CANCELLED_JOURNAL' }, queuedActivationTurnId: turnId,
      queuedActivationTail: [{
        id: 'tail-human-journal-rollback', order: 1, userPrompt: 'HUMAN_AFTER_CANCEL',
        cliInput: { content: 'HUMAN_AFTER_CANCEL' }, turnId: humanTurnId,
      }],
    });
    sessionStore.updateSession(session);
    const ds = { session, worker: null, hasHistory: true, initialStartPending: true,
      larkAppId: APP, chatId: session.chatId, chatType: 'group', scope: 'thread', workingDir: root,
    } as any;
    let writes = 0;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes += 1;
      if (writes === 2) throw new Error('cleanup write rollback');
    });
    try {
      cancelPreReadyScheduledWorkers([ds], runId, () => {});
    } finally {
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
    }
    expect(writes).toBe(2);
    expect(ds.activationCancellationPending).toBe(true);
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedActivationTurnId).toBeUndefined();
    expect(ds.session.queuedActivationTail?.map((entry: any) => entry.turnId)).toEqual([humanTurnId]);

    // Legacy/dirty states with a tombstoned journal must never reach startJournal.
    Object.assign(ds.session, {
      queuedActivationPending: true, queuedActivationToken: 'tok-legacy-cancelled',
      queuedActivationInput: { content: 'CANCELLED_JOURNAL' }, queuedActivationTurnId: turnId,
    });
    ds.activationCancellationPending = undefined;
    let started = 0;
    let retries = 0;
    await releaseCancelledActivationWork(ds, {
      release: async () => false,
      startJournal: () => { started += 1; },
      scheduleRetry: () => { retries += 1; },
    });
    expect(started).toBe(0);
    expect(retries).toBe(1);

    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('clear head rollback'); });
    try {
      expect(clearTombstonedActivationHeadForRelease(ds, sessionStore.updateSession)).toBe(false);
    } finally {
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
    }
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe(turnId);
    expect(ds.session.cancelledActivationTurnIds).toContain(turnId);

    expect(clearTombstonedActivationHeadForRelease(ds, sessionStore.updateSession)).toBe(true);
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(workerPool.promoteQueuedActivationTail(ds, { send: false })).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe(humanTurnId);
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
