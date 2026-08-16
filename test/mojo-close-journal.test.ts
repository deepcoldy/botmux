/**
 * The daemon's DURABLE close journal must record what actually happened.
 *
 * A non-rollbackable prepare (`uncertain` / `irreversible`) used to leave the
 * journal at `preparing` carrying the PRE-prepare task id, and reported itself as
 * an ordinary `retryable: true` cancel failure. Three separate lies came out of
 * that single row:
 *   - a restart could not tell "reconcile me" from "only the local commit left";
 *   - the exact lineage the worker returned (it may be the FIRST to know it, the
 *     pre-init window) was dropped, so a retry addressed a session that never
 *     existed;
 *   - an irreversible teardown was advertised as retryable, so callers looped on
 *     a cancel that can never run again — while the row could never be closed.
 *
 * Every case here drives the real worker -> IPC -> daemon path and was verified
 * to go red when its production line is reverted (see task result for the
 * mutation log).
 *
 * Run:  pnpm vitest run test/mojo-close-journal.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { getBotMock, cancelMojoMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelMojoMock: vi.fn(async () => ({ kind: 'cancelled' as const })),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/adapters/backend/mojo-backend.js', () => ({
  cancelMojoSessionById: cancelMojoMock,
  MojoBackend: class {},
}));

vi.mock('../src/adapters/backend/riff-backend.js', () => ({
  hashUrlForLog: vi.fn(() => 'riffhash'),
  cancelRiffTaskById: vi.fn(async () => true),
  RiffBackend: class {},
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
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

function createFixture(options: {
  closeRecovery?: 'retryable' | 'uncertain' | 'irreversible';
  /** Sent verbatim; the daemon must not re-derive it from `closeRecovery`. */
  closeAdmission?: 'restorable' | 'fenced';
  resultTaskId?: string;
  /** Restore-time quarantine / pre-init rows carry no active lineage yet. */
  noActiveLineage?: boolean;
  /**
   * The worker handles close_abort but REFUSES to restore admission (a latched
   * local fence). `ok` stays true; only `admissionRestored` says otherwise.
   */
  abortRefused?: boolean;
} = {}) {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_mojo', 'om_mojo', 'mojo journal', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'mojo';
  session.riffParentTaskId = options.noActiveLineage ? undefined : 'mojo-sid-123';
  session.mojoIdentity = { cloud: true };
  sessionStore.updateSession(session);

  const worker = new EventEmitter() as any;
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
        // Handled successfully...
        ok: true,
        // ...but the backend kept its fence latched.
        ...(options.abortRefused
          ? { admissionRestored: false, fenceReason: 'local_termination_unproven' }
          : {}),
      }));
      return;
    }
    if (message.type !== 'close' || !message.requestId) return;
    queueMicrotask(() => worker.emit('message', {
      type: 'close_result',
      requestId: message.requestId,
      ok: false,
      taskId: options.resultTaskId ?? 'mojo-sid-123',
      error: 'mojo cancel HTTP 500',
      ...(options.closeRecovery ? { recovery: options.closeRecovery } : {}),
      ...(options.closeAdmission ? { admission: options.closeAdmission } : {}),
    }));
  });

  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    session,
    initConfig: { backendType: 'mojo' },
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  return { session, ds, worker, registry };
}

function sentTypes(worker: any): string[] {
  return (worker.send as { mock: { calls: Array<[{ type: string }]> } })
    .mock.calls.map(([message]) => message.type);
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-mojo-journal-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { mojo: { cloud: true } },
  });
  cancelMojoMock.mockResolvedValue({ kind: 'cancelled' });
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
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

describe('durable Mojo close journal records the exact verdict', () => {
  it('persists an uncertain prepare as uncertain + fenced, not as a bare preparing row', async () => {
    const fixture = createFixture({ closeRecovery: 'uncertain' });

    await closeSession(fixture.session.sessionId, fixture.registry);

    // Read the STORE, not the runtime copy: this is the row a restart sees.
    const journal = sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal;
    expect(journal).toMatchObject({
      phase: 'uncertain',
      recovery: 'uncertain',
      // Stored SEPARATELY from `recovery`: one durable field for both answers is
      // how a fenced state got re-derived as retryable on restore.
      admission: 'fenced',
      taskId: 'mojo-sid-123',
    });
    // Not commit-only: nobody may treat this as proof the remote side is gone.
    expect(journal?.commitOnly).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('journals the EXACT taskId the worker returned, not the pre-prepare guess', async () => {
    // The pre-init window: the row had no lineage yet, and destroySession is the
    // first thing to learn it. Persisting the old (absent) value made the retry
    // and any manual reconciliation address nothing at all.
    const fixture = createFixture({
      closeRecovery: 'uncertain',
      noActiveLineage: true,
      resultTaskId: 'mojo-sid-discovered-late',
    });

    await closeSession(fixture.session.sessionId, fixture.registry);

    const stored = sessionStore.getSession(fixture.session.sessionId);
    expect(stored?.mojoCloseJournal?.taskId).toBe('mojo-sid-discovered-late');
    // And the lineage anchor itself must carry it, or the retry has no target.
    expect(stored?.riffParentTaskId).toBe('mojo-sid-discovered-late');
  });

  it('does not advertise an uncertain close as retryable', async () => {
    const fixture = createFixture({ closeRecovery: 'uncertain' });

    const result = await closeSession(fixture.session.sessionId, fixture.registry);

    expect(result).toMatchObject({
      ok: false,
      error: 'mojo_close_reconciliation_required',
      retryable: false,
      recovery: 'uncertain',
    });
  });

  it('persists an irreversible prepare as commit-only prepared', async () => {
    const fixture = createFixture({ closeRecovery: 'irreversible' });

    const result = await closeSession(fixture.session.sessionId, fixture.registry);

    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal)
      .toMatchObject({
        phase: 'prepared',
        recovery: 'irreversible',
        commitOnly: true,
        admission: 'fenced',
      });
    // Retryable — but only as the LOCAL commit, which the error names.
    expect(result).toMatchObject({
      ok: false,
      error: 'mojo_close_commit_required',
      retryable: true,
      recovery: 'irreversible',
    });
    expect(sentTypes(fixture.worker)).not.toContain('close_abort');
  });

  it('lets a retry finish an irreversible close locally without a second cancel', async () => {
    const fixture = createFixture({ closeRecovery: 'irreversible' });
    await closeSession(fixture.session.sessionId, fixture.registry);
    (fixture.worker.send as any).mockClear();

    const retry = await closeSession(fixture.session.sessionId, fixture.registry);

    expect(retry.ok).toBe(true);
    // No second prepare and no abort: only the local commit may be replayed.
    expect(sentTypes(fixture.worker)).not.toContain('close');
    expect(sentTypes(fixture.worker)).not.toContain('close_abort');
    expect(sentTypes(fixture.worker)).toContain('close_commit');
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after?.status).toBe('closed');
    expect(after?.mojoCloseJournal).toBeUndefined();
  });

  it('does not roll back a RETRYABLE close whose admission is fenced', async () => {
    // The fencing hole this pair of fields exists for: an unproven local child
    // termination is retryable (the irreversible remote cancel never ran) while a
    // credentialed process may still be alive. Keying the rollback on `recovery`
    // sent close_abort and re-opened writes on top of that live orphan.
    const fixture = createFixture({
      closeRecovery: 'retryable',
      closeAdmission: 'fenced',
    });

    const result = await closeSession(fixture.session.sessionId, fixture.registry);

    expect(sentTypes(fixture.worker)).not.toContain('close_abort');
    // Retryable AS A CLOSE: a retry can still finish it, so it must not be
    // reported as needing manual reconciliation.
    expect(result).toMatchObject({
      ok: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      recovery: 'retryable',
    });
    // The durable intent stays `preparing` (the retry re-runs the cancel) while
    // admission is independently recorded as fenced.
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal)
      .toMatchObject({
        phase: 'preparing',
        recovery: 'retryable',
        admission: 'fenced',
      });
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('still rolls back when the worker says admission is restorable', async () => {
    // The historical path must survive the split: an explicitly restorable
    // result DOES abort, so the fence does not degenerate into fencing everything.
    const fixture = createFixture({
      closeRecovery: 'retryable',
      closeAdmission: 'restorable',
    });

    await closeSession(fixture.session.sessionId, fixture.registry);

    expect(sentTypes(fixture.worker)).toContain('close_abort');
  });

  it('keeps the session fenced when the verdict cannot be journalled', async () => {
    // Fail closed: a disk failure must not degrade into a rollback.
    const fixture = createFixture({ closeRecovery: 'irreversible' });
    vi.spyOn(sessionStore, 'markMojoCloseUnresolved')
      .mockImplementationOnce(() => { throw new Error('journal disk full'); });

    const result = await closeSession(fixture.session.sessionId, fixture.registry);

    expect(result).toMatchObject({ ok: false, error: 'mojo_durable_close_failed' });
    expect(sentTypes(fixture.worker)).not.toContain('close_abort');
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });
});

describe('a REFUSED close abort is not journalled as restored', () => {
  it('keeps the journal and the fence when close_abort_result says admission did not come back', async () => {
    // The laundering this closes: `close_abort_result.ok` means the abort was
    // HANDLED, not that writes came back. Inferring restoration from `ok` wrote
    // "admission restored" to disk (clearing the journal entirely) while the
    // backend's fence was still latched and write() kept returning false.
    const fixture = createFixture({
      closeRecovery: 'retryable',
      closeAdmission: 'restorable',
      abortRefused: true,
    });

    const result = await closeSession(fixture.session.sessionId, fixture.registry);

    // The abort WAS attempted -- this is the restorable path, so that is correct.
    expect(sentTypes(fixture.worker)).toContain('close_abort');
    // But its refusal must survive to disk instead of clearing the row.
    const stored = sessionStore.getSession(fixture.session.sessionId);
    expect(stored?.mojoCloseJournal).toMatchObject({ admission: 'fenced' });
    expect(stored?.status).toBe('active');
    // And the runtime fence must not be dropped either.
    expect(fixture.ds.remoteCloseState).toBeDefined();
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('still clears the journal when the abort really restored admission', async () => {
    // The historical path must survive: an accepted abort DOES clear the record,
    // otherwise every reversible failure would strand its session.
    const fixture = createFixture({
      closeRecovery: 'retryable',
      closeAdmission: 'restorable',
    });

    await closeSession(fixture.session.sessionId, fixture.registry);

    expect(sentTypes(fixture.worker)).toContain('close_abort');
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal)
      .toBeUndefined();
    expect(fixture.ds.remoteCloseState).toBeUndefined();
  });
});

describe('the journal is actually DURABLE, not just in-memory', () => {
  /**
   * Read the projection a restarting daemon would read.
   *
   * Every other assertion in this file goes through `sessionStore.getSession`,
   * which answers from the in-memory map -- so it cannot tell a persisted row
   * from a mutated object that never reached disk. That distinction is the whole
   * feature: the journal exists to survive a daemon crash.
   */
  function journalOnDisk(sessionId: string): Record<string, unknown> | undefined {
    const raw = JSON.parse(readFileSync(join(dataDir, 'sessions-app.json'), 'utf-8')) as
      Record<string, { mojoCloseJournal?: Record<string, unknown> }>;
    return raw[sessionId]?.mojoCloseJournal;
  }

  function seedActiveMojoRow(hint: string) {
    sessionStore.init('app');
    const session = sessionStore.createSession('oc_d', `om_${hint}`, hint, 'group');
    session.larkAppId = 'app';
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-durable';
    sessionStore.updateSession(session);
    return session;
  }

  it('flushes an unresolved verdict to disk before returning', () => {
    // Called DIRECTLY, so nothing else can run a save() in between and flush the
    // shared object for us. Driving this through closeSession() instead lets a
    // foreign save mask a missing flush entirely -- which is how "the file has
    // the row" passed while this function did not write it.
    const session = seedActiveMojoRow('durable-flush');
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-flush', 'mojo-sid-durable');

    sessionStore.markMojoCloseUnresolved(session.sessionId, 'req-flush', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-durable',
      admission: 'fenced',
    });

    expect(journalOnDisk(session.sessionId)).toMatchObject({
      phase: 'uncertain',
      requestId: 'req-flush',
      taskId: 'mojo-sid-durable',
      recovery: 'uncertain',
      admission: 'fenced',
    });
  });

  it('flushes the admission fence a crash would have to re-read', () => {
    // The fence is the part that must not evaporate: a row that comes back
    // without it is indistinguishable from a session that may accept writes.
    const session = seedActiveMojoRow('durable-fence');
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-fence', 'mojo-sid-durable');
    sessionStore.markMojoCloseUnresolved(session.sessionId, 'req-fence', {
      recovery: 'retryable',
      taskId: 'mojo-sid-durable',
      admission: 'fenced',
    });

    // Model the restart itself: drop every in-memory row and re-read the store.
    sessionStore.init('app');

    expect(sessionStore.getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      recovery: 'retryable',
      admission: 'fenced',
    });
  });

  it('flushes a commit-only proof, so a restart finishes the local close', () => {
    // If this one is lost, the restart sees no journal at all and resumes the
    // session as ordinary -- beside a remote lineage that is already gone.
    const session = seedActiveMojoRow('durable-commit-only');
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-commit', 'mojo-sid-durable');
    sessionStore.markMojoCloseUnresolved(session.sessionId, 'req-commit', {
      recovery: 'irreversible',
      taskId: 'mojo-sid-durable',
      admission: 'fenced',
    });

    expect(journalOnDisk(session.sessionId)).toMatchObject({
      phase: 'prepared',
      commitOnly: true,
      recovery: 'irreversible',
    });
  });
});

describe('a RETRYABLE journal accepts a fresh close attempt (P1-1/P1-2)', () => {
  function seedRetryable(hint: string, admission: 'restorable' | 'fenced' = 'restorable') {
    sessionStore.init('app');
    const session = sessionStore.createSession('oc_r', `om_${hint}`, hint, 'group');
    session.larkAppId = 'app';
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-retry';
    sessionStore.updateSession(session);
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-old', 'mojo-sid-retry');
    sessionStore.markMojoCloseUnresolved(session.sessionId, 'req-old', {
      recovery: 'retryable',
      taskId: 'mojo-sid-retry',
      admission,
    });
    return session;
  }

  it('lets a NEW requestId restart a journal recorded as retryable', () => {
    // Refusing every fresh requestId made the persisted `retryable` dead-code:
    // the promised retry could never re-enter the cancel, so the row was a
    // permanent brick that only hand-editing JSON state could clear.
    const session = seedRetryable('retry-restart');
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-new', 'mojo-sid-retry');
    // Rebuilt from scratch: the stale recovery/admission verdict must not
    // survive into the fresh attempt.
    expect(sessionStore.getSession(session.sessionId)?.mojoCloseJournal).toEqual({
      phase: 'preparing',
      requestId: 'req-new',
      taskId: 'mojo-sid-retry',
      updatedAt: expect.any(String),
    });
  });

  it('still refuses a NEW requestId when the journal did not say retryable', () => {
    sessionStore.init('app');
    const session = sessionStore.createSession('oc_r', 'om_owned', 'owned', 'group');
    session.larkAppId = 'app';
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-owned';
    sessionStore.updateSession(session);
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-a', 'mojo-sid-owned');
    expect(() => sessionStore.beginMojoCloseJournal(session.sessionId, 'req-b', 'mojo-sid-owned'))
      .toThrow(/already owns/);
  });

  it('still refuses a retryable restart whose lineage changed', () => {
    const session = seedRetryable('retry-lineage');
    expect(() => sessionStore.beginMojoCloseJournal(session.sessionId, 'req-new', 'mojo-sid-OTHER'))
      .toThrow(/lineage changed/);
  });
});

describe('a commit-only journal forbids further teardown', () => {
  function seedCommitOnly() {
    sessionStore.init('app');
    const session = sessionStore.createSession('oc_x', 'om_x', 'commit only', 'group');
    session.larkAppId = 'app';
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-777';
    sessionStore.updateSession(session);
    sessionStore.beginMojoCloseJournal(session.sessionId, 'req-1', 'mojo-sid-777');
    sessionStore.markMojoCloseUnresolved(session.sessionId, 'req-1', {
      recovery: 'irreversible',
      taskId: 'mojo-sid-777',
      admission: 'fenced',
    });
    return session;
  }

  it('refuses to abort it', () => {
    const session = seedCommitOnly();
    expect(() => sessionStore.finishMojoCloseAbort(session.sessionId, 'req-1', {
      admissionRestored: true,
      taskId: 'mojo-sid-777',
    })).toThrow(/irreversible/);
    // The proof survives the refusal.
    expect(sessionStore.getSession(session.sessionId)?.mojoCloseJournal)
      .toMatchObject({ phase: 'prepared', commitOnly: true });
  });

  it('refuses to start another cancel on it', () => {
    const session = seedCommitOnly();
    expect(() => sessionStore.beginMojoCloseJournal(session.sessionId, 'req-1', 'mojo-sid-777'))
      .toThrow(/commit-only/);
  });

  it('rejects an on-disk irreversible row that is not commit-only prepared', () => {
    // Session JSON is a runtime boundary: a hand-edited/truncated row must not
    // become authority for skipping the cancel.
    expect(sessionStore.isValidMojoCloseJournal({
      phase: 'uncertain',
      requestId: 'r',
      updatedAt: 'now',
      recovery: 'irreversible',
      commitOnly: true,
    })).toBe(false);
    // A `prepared` row claiming an irreversible verdict WITHOUT the commit-only
    // marker is the dangerous direction: it would let a later abort/cancel run.
    expect(sessionStore.isValidMojoCloseJournal({
      phase: 'prepared',
      requestId: 'r',
      updatedAt: 'now',
      recovery: 'irreversible',
    })).toBe(false);
    expect(sessionStore.isValidMojoCloseJournal({
      phase: 'prepared',
      requestId: 'r',
      updatedAt: 'now',
      recovery: 'irreversible',
      commitOnly: true,
    })).toBe(true);
    // A retryable verdict proves no irreversible teardown, so it must never wear
    // the marker that suppresses further cancellation.
    expect(sessionStore.isValidMojoCloseJournal({
      phase: 'prepared',
      requestId: 'r',
      updatedAt: 'now',
      recovery: 'retryable',
      commitOnly: true,
    })).toBe(false);
    // An unknown admission value is not a boolean-ish truthy fallback.
    expect(sessionStore.isValidMojoCloseJournal({
      phase: 'uncertain',
      requestId: 'r',
      updatedAt: 'now',
      recovery: 'uncertain',
      admission: 'maybe',
    })).toBe(false);
  });
});
