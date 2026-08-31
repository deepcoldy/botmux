/**
 * Workerless mojo `/close` must PROVE the remote session is cancelled before the
 * durable row is published as closed.
 *
 * Before this, closeSession() marked the row closed and returned success while the
 * cancel was still in flight, so a failed cancel left the operator believing the
 * session was gone while the remote one kept running and holding the injected
 * credential. The retained lineage was not a recovery path either: a second
 * `/close` cannot reach the cancel at all, because the first close removed the
 * session from the active registry.
 *
 * Run:  pnpm vitest run test/mojo-explicit-close.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeSessionKey,
  remoteRetirementAdmissionPhase,
  type DaemonSession,
} from '../src/core/types.js';

const { getBotMock, cancelMojoMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelMojoMock: vi.fn(async () => ({ kind: 'cancelled' as const })),
}));
const unpinMessageMock = vi.hoisted(() => vi.fn(async () => true));

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
  unpinMessage: (...args: any[]) => unpinMessageMock(...args),
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
  __testOnly_waitForPinStreamingCardIdle,
  closeSession,
  closeSessionForBackgroundCleanup,
  forkWorker,
  initWorkerPool,
  sendWorkerInput,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import {
  readBootId,
  recordContainmentHandle,
  reconcileContainmentHandlesOnBoot,
  revokeContainmentHandles,
} from '../src/core/mojo-containment.js';

let dataDir: string;
let previousDataDir: string;
const sessionReplyMock = vi.fn(async () => 'om_reply');

/**
 * Record the outstanding containment handle a residual close implies. Since
 * round 12, `mojoLocalResidual` (row field + journal copy) is DERIVED state —
 * consumers report it only while the handle ledger still holds a handle for the
 * session — so any test asserting a residual survives retries/replays must
 * mirror production and leave the handle in the ledger.
 */
function recordOutstandingHandle(sessionId: string): void {
  recordContainmentHandle({
    kind: 'tree-identity',
    sessionId,
    generation: 1,
    rootPid: 4242,
    bootId: 'boot-close-test',
    startTime: 999,
    nonce: `nonce-${sessionId}`,
  });
}

function createFixture(options: {
  closeRecovery?: 'retryable' | 'uncertain' | 'irreversible';
  liveWorker?: boolean;
  closeOk?: boolean;
  resultTaskId?: string;
  /** Local-subtree residual the worker reports on an otherwise successful close. */
  closeResidual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
  /** Omit the frozen identity so the lineage reads as quarantined. */
  legacyUnfrozen?: boolean;
  /** Restore-time quarantine PARKS the id here and clears the active slot. */
  parkedLineage?: string;
  /** Drop the active lineage, as restore-time quarantine does. */
  noActiveLineage?: boolean;
} = {}) {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_mojo', 'om_mojo', 'mojo close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'mojo';
  session.riffParentTaskId = options.noActiveLineage ? undefined : 'mojo-sid-123';
  if (options.parkedLineage) session.mojoQuarantinedLineage = options.parkedLineage;
  if (!options.legacyUnfrozen) {
    // A frozen identity is what makes the lineage cancellable (trustworthy control
    // plane); without it the teardown path must refuse to cancel.
    session.mojoIdentity = { cloud: true };
  }
  sessionStore.updateSession(session);

  const worker = options.liveWorker ? new EventEmitter() as any : null;
  if (worker) {
    worker.killed = false;
    worker.exitCode = null;
    worker.signalCode = null;
    worker.kill = vi.fn();
    // Remote close is prepare/commit: only the matching commit retires the
    // worker after the daemon has durably closed the row.
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
        taskId: options.resultTaskId ?? 'mojo-sid-123',
        ...((options.closeOk ?? true) ? {} : { error: 'mojo cancel HTTP 500' }),
        ...(options.closeRecovery ? { recovery: options.closeRecovery } : {}),
        ...(options.closeResidual ? { residual: options.closeResidual } : {}),
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
    initConfig: { backendType: 'mojo' },
  } as unknown as DaemonSession;
  if (worker) __testOnly_setupWorkerHandlers(ds, worker);
  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  return { session, ds, worker, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-mojo-close-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { mojo: { cloud: true } },
  });
  cancelMojoMock.mockResolvedValue({ kind: 'cancelled' });
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

describe('mojo explicit close', () => {
  it('starts streaming-card cleanup after a durable closed_with_residual result', async () => {
    const fixture = createFixture({ legacyUnfrozen: true });
    fixture.session.streamCardId = 'om_mojo_stream';
    fixture.ds.streamCardId = 'om_mojo_stream';
    getBotMock.mockReturnValue({
      resolvedAllowedUsers: [],
      config: { mojo: { cloud: true }, pinStreamingCard: true },
    });

    await expect(closeSession(fixture.session.sessionId)).resolves.toMatchObject({
      ok: true, outcome: 'closed_with_residual',
    });
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).toHaveBeenCalledWith('app', 'om_mojo_stream');
  });

  it('does NOT roll back an uncertain close prepare', async () => {
    // The tri-state existed only inside the worker: the daemon saw a bare ok:false
    // and sent close_abort unconditionally, laundering `uncertain` straight back
    // into `retryable`. This drives the REAL worker->daemon IPC, so a regression
    // here cannot hide behind an isolated helper unit test.
    const fixture = createFixture({ liveWorker: true, closeOk: false, closeRecovery: 'uncertain' });

    const result = await closeSession(fixture.ds.session.sessionId, fixture.registry);

    expect(result.ok).toBe(false);
    // The abort is what re-opens write admission; it must not have been sent.
    const sent = (fixture.worker.send as unknown as { mock: { calls: Array<[{ type: string }]> } }).mock.calls
      .map(([message]) => message.type);
    expect(sent).toContain('close');
    expect(sent).not.toContain('close_abort');
    expect(sent).not.toContain('close_commit');
    // The row stays active, which is what keeps its device-isolation blocker.
    expect(sessionStore.getSession(fixture.ds.session.sessionId)?.status).toBe('active');
  });

  it('does NOT roll back an irreversible close prepare', async () => {
    // Restoring admission after the remote side is gone yields a session that looks
    // writable but can never continue.
    const fixture = createFixture({ liveWorker: true, closeOk: false, closeRecovery: 'irreversible' });

    await closeSession(fixture.ds.session.sessionId, fixture.registry);

    const sent = (fixture.worker.send as unknown as { mock: { calls: Array<[{ type: string }]> } }).mock.calls
      .map(([message]) => message.type);
    expect(sent).not.toContain('close_abort');
  });

  it('still rolls back a retryable close prepare', async () => {
    // The historical behaviour must survive: a reversible failure DOES restore
    // admission, and an absent `recovery` still means retryable (riff sends none).
    const fixture = createFixture({ liveWorker: true, closeOk: false });

    await closeSession(fixture.ds.session.sessionId, fixture.registry);

    const sent = (fixture.worker.send as unknown as { mock: { calls: Array<[{ type: string }]> } }).mock.calls
      .map(([message]) => message.type);
    expect(sent).toContain('close_abort');
  });

  it('refuses explicit close while shutdown owns the exact Mojo generation', async () => {
    const fixture = createFixture({ liveWorker: true });
    fixture.ds.remoteShutdownState = {
      phase: 'preparing',
      requestId: 'shutdown-mojo',
      taskId: 'mojo-sid-123',
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_shutdown_fence_in_progress',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(fixture.worker?.send).not.toHaveBeenCalled();
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('awaits worker-less cancellation before closing, then clears the lineage', async () => {
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).toHaveBeenCalledWith(expect.anything(), 'mojo-sid-123');
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.riffParentTaskId).toBeUndefined();
    expect(after?.mojoCloseJournal).toBeUndefined();
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(fixture.registry.size).toBe(0);
  });

  it('does not start a workerless cancel when its durable intent cannot be written', async () => {
    const fixture = createFixture();
    vi.spyOn(sessionStore, 'beginMojoCloseJournal')
      .mockImplementationOnce(() => { throw new Error('journal disk full'); });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-123',
    });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does NOT report success when the cancel fails; row and lineage survive', async () => {
    // The whole point: the operator must not be told the session is gone while the
    // remote one keeps running with the injected credential.
    cancelMojoMock.mockResolvedValue({ kind: 'failed', message: 'HTTP 500', retryable: true });
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after?.status).not.toBe('closed');
    // Lineage retained so the SAME close can be retried — and because the row is
    // still open, the session is still in the registry for that retry to find.
    expect(after?.riffParentTaskId).toBe('mojo-sid-123');
    expect(after?.mojoCloseJournal).toBeUndefined();
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(fixture.registry.size).toBe(1);
  });

  it('retries a workerless abort commit before issuing another cancel', async () => {
    cancelMojoMock.mockResolvedValue({ kind: 'failed', message: 'HTTP 500', retryable: true });
    const fixture = createFixture();
    const realFinish = sessionStore.finishMojoCloseAbort;
    vi.spyOn(sessionStore, 'finishMojoCloseAbort')
      .mockImplementationOnce(() => { throw new Error('abort journal disk full'); })
      .mockImplementation((...args) => realFinish(...args));

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
      taskId: 'mojo-sid-123',
    });
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'abort_restored' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_cancel_failed',
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(2);
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('a retry after a failed cancel actually reaches the cancel again', async () => {
    // The regression this suite exists for: the old path closed the row on the
    // first attempt, so nothing could ever retry the cancel.
    cancelMojoMock.mockResolvedValue({ kind: 'failed', message: 'HTTP 500', retryable: true });
    const fixture = createFixture();
    expect((await closeSession(fixture.session.sessionId)).ok).toBe(false);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);

    cancelMojoMock.mockResolvedValue({ kind: 'cancelled' });
    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('cancels exactly once — the best-effort teardown must not fire it again', async () => {
    // killWorker's synchronous orphan teardown also cancels mojo lineage. Clearing
    // the runtime lineage on a proven cancel is what keeps that path a no-op here.
    const fixture = createFixture();
    await closeSession(fixture.session.sessionId);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
  });

  it('retries only the local durable commit after a workerless cancel succeeds', async () => {
    const fixture = createFixture();
    const realClose = sessionStore.closeSession;
    vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'prepared' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      taskId: 'mojo-sid-123',
    });

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('re-publishes a workerless cancellation proof without cancelling twice', async () => {
    const fixture = createFixture();
    const realPrepare = sessionStore.markMojoClosePrepared;
    vi.spyOn(sessionStore, 'markMojoClosePrepared')
      .mockImplementationOnce(() => { throw new Error('proof disk full'); })
      .mockImplementation((...args) => realPrepare(...args));

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'prepared' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
    });

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('recovers a workerless prepared close after daemon loss without cancelling again', async () => {
    const fixture = createFixture();
    const realClose = sessionStore.closeSession;
    vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(false);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
    });

    // Lose every runtime-only proof and reload the row exactly as a new daemon.
    fixture.ds.remoteCloseState = undefined;
    setActiveSessionsRegistry(new Map());
    sessionStore.init('app');

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('never cancels a quarantined lineage: closes, but as an explicit residual', async () => {
    // Nothing records which control plane holds an unfrozen lineage, so cancelling
    // could reach a different tenant. Close proceeds and the id is KEPT on the row
    // for manual cleanup — a retry could never make this safe. But it must NOT look
    // like an ordinary close, or the user is told a running remote session is gone.
    const fixture = createFixture({ legacyUnfrozen: true });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-sid-123' },
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    // The id is PARKED (not left in the active slot) by the same durable write that
    // closed the row — that is what makes the residual replayable.
    expect(after?.mojoQuarantinedLineage).toBe('mojo-sid-123');
    expect(after?.riffParentTaskId).toBeUndefined();
  });

  it('refuses (retryably) when the bot is deregistered', async () => {
    // Re-registering the bot restores the config this needs, so this IS retryable —
    // closing the row now would publish "gone" for a session still running.
    getBotMock.mockImplementation(() => { throw new Error('bot gone'); });
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_config_missing',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after?.status).not.toBe('closed');
    expect(after?.riffParentTaskId).toBe('mojo-sid-123');
  });

  it('refuses a durable lineage that has no active owner to cancel through', async () => {
    // Open row + lineage, but nothing in the registry: the frozen identity the
    // cancel needs hangs off DaemonSession. Publishing closed here would be the
    // same lie through a different door.
    const fixture = createFixture();
    setActiveSessionsRegistry(new Map());

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_identity_missing',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).not.toBe('closed');
  });

  it('DRAINS an uncertain journal: the row closes with the lineage parked as a residual (P1-1)', async () => {
    // The reconciliation exit the journal always promised. Before it, an
    // `uncertain` row (restore's downgrade of every crashed close) was refused
    // on every /close as reconciliation_required while never being registered —
    // a permanent brick whose remote session kept its credential, fixable only
    // by hand-editing JSON state.
    const fixture = createFixture();
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-crashed', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-crashed', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    setActiveSessionsRegistry(new Map());

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-sid-123' },
      alreadyClosed: false,
      known: true,
    });
    // Never a second cancel through an unknown outcome — the drain closes the
    // local row only and preserves the id for manual remote cleanup.
    expect(cancelMojoMock).not.toHaveBeenCalled();
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.mojoQuarantinedLineage).toBe('mojo-sid-123');
    expect(after?.riffParentTaskId).toBeUndefined();
    expect(after?.mojoCloseJournal).toBeUndefined();
  });

  it('NEVER drains past a live worker: an uncertain journal goes through prepare/commit (P0-new)', async () => {
    // The drain × remote-guard intersection: draining an uncertain journal
    // while a live worker existed returned ok:true, closed the row and deleted
    // the registry entry — but killWorker's remote guard (P0-2) refused the
    // request-less retirement, so the still-running, credential-carrying worker
    // became unreachable by every entry point. A live worker must instead be
    // retired through prepare/commit: it re-runs the cancel under a fresh
    // requestId (journal takeover) and is retired with the commit requestId.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-crashed', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-crashed', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    // PRODUCTION-FAITHFUL fixture (third-round review): every in-process path
    // that produces a durable uncertain journal also leaves the runtime
    // uncertain fence on the ds — the combination "durable uncertain + live
    // worker + clean runtime state" does not exist in production. The takeover
    // must therefore clear THIS fence too, or the exit is dead code.
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'req-crashed',
      taskId: 'mojo-sid-123',
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    // The worker was actually RETIRED, not orphaned: it received the prepare
    // and then the commit that legally passes the remote-retirement guard.
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close',
      requestId: expect.any(String),
    }));
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_commit',
      requestId: expect.any(String),
    }));
    expect(fixture.ds.worker).toBeNull();
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.mojoCloseJournal).toBeUndefined();
    // No lineage was parked: the cancel really ran, nothing was left behind.
    expect(after?.mojoQuarantinedLineage).toBeUndefined();
  });

  it('takes over a RETRYABLE-but-fenced journal through the runtime fence (round-4 gap A)', async () => {
    // A prepare that failed retryable+fenced writes durable phase 'preparing'
    // (recovery retryable) while the runtime fence is 'uncertain' — the
    // uncertain/uncertain exact match rejected this pair forever with
    // retryable:false, even though the durable row itself promises a retry.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-fenced', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-fenced', {
      recovery: 'retryable',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'req-fenced',
      taskId: 'mojo-sid-123',
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'close_commit' }));
    expect(fixture.ds.worker).toBeNull();
  });

  it('takes over when the durable journal carries a lineage the runtime fence lacks (round-4 gap B)', async () => {
    // The worker can report the pre-init lineage into the JOURNAL while the
    // runtime fence kept none — a durable superset, not a disagreement.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-preinit', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-preinit', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    fixture.ds.remoteCloseState = { phase: 'uncertain', requestId: 'req-preinit' };

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true, outcome: 'closed' });
    expect(fixture.ds.worker).toBeNull();
  });

  it('refuses when the two sides carry CONFLICTING lineages', async () => {
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-conflict', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-conflict', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'req-conflict',
      taskId: 'mojo-sid-OTHER',
    };

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_close_reconciliation_required',
    });
    expect(fixture.worker.send).not.toHaveBeenCalled();
  });

  it('refuses when the durable journal is a plain fresh prepare (phase leg)', async () => {
    // A bare 'preparing' journal WITHOUT a recorded retryable verdict is a
    // different attempt state, not a recorded failure inviting retry.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-bare', 'mojo-sid-123');
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'req-bare',
      taskId: 'mojo-sid-123',
    };

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_close_reconciliation_required',
    });
    expect(fixture.worker.send).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('restores the runtime fence when the takeover journal write fails (round-5 zero-coverage fix)', async () => {
    // The takeover clears ds.remoteCloseState BEFORE the fresh attempt's
    // durable write. If that write throws, the fence must come back — guards
    // keyed on remoteCloseState (shutdown-detach's explicit-close check)
    // otherwise silently lose their signal while disk still says uncertain.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-restore', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-restore', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    const fence = {
      phase: 'uncertain' as const,
      requestId: 'req-restore',
      taskId: 'mojo-sid-123',
    };
    fixture.ds.remoteCloseState = fence;
    vi.spyOn(sessionStore, 'beginMojoCloseJournal')
      .mockImplementationOnce(() => { throw new Error('journal disk full'); });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
    });
    // The SAME fence object is back — not a lookalike rebuilt from guesses.
    expect(fixture.ds.remoteCloseState).toBe(fence);
    expect(fixture.worker.send).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('keeps refusing when the runtime uncertain fence does not match the durable journal', async () => {
    // The takeover requires runtime and disk to describe the SAME failed
    // attempt (phase + requestId + lineage). A mismatched pair means they
    // disagree about which attempt happened; clearing the fence on that would
    // launder an unknown state into a fresh cancel.
    const fixture = createFixture({ liveWorker: true });
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-disk', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-disk', {
      recovery: 'uncertain',
      taskId: 'mojo-sid-123',
      admission: 'fenced',
    });
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'req-OTHER',
      taskId: 'mojo-sid-123',
    };

    const result = await closeSession(fixture.session.sessionId);
    expect(result).toMatchObject({ ok: false, error: 'mojo_close_reconciliation_required' });
    // Nothing was sent to the worker and nothing closed.
    expect(fixture.worker.send).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('RETRIES the cancel for a journal durably recorded as retryable (P1-2)', async () => {
    // `recovery: 'retryable'` is a durable statement that re-running the cancel
    // is legitimate. With a registered owner, /close must actually re-enter the
    // cancel under a fresh requestId instead of being refused forever.
    const fixture = createFixture();
    sessionStore.beginMojoCloseJournal(fixture.session.sessionId, 'req-failed', 'mojo-sid-123');
    sessionStore.markMojoCloseUnresolved(fixture.session.sessionId, 'req-failed', {
      recovery: 'retryable',
      taskId: 'mojo-sid-123',
      admission: 'restorable',
    });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).toHaveBeenCalledWith(expect.anything(), 'mojo-sid-123');
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.riffParentTaskId).toBeUndefined();
    expect(after?.mojoCloseJournal).toBeUndefined();
  });

  it('commits a live-worker cancellation only after its prepare result', async () => {
    const fixture = createFixture({ liveWorker: true });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close',
      requestId: expect.any(String),
    }));
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_commit',
      requestId: expect.any(String),
    }));
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does not send the cancel when the durable preparing journal cannot be written', async () => {
    const fixture = createFixture({ liveWorker: true });
    vi.spyOn(sessionStore, 'beginMojoCloseJournal')
      .mockImplementationOnce(() => { throw new Error('journal disk full'); });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(fixture.worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'close' }));
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('keeps a live session active when worker-side cancellation is not proven', async () => {
    const fixture = createFixture({ liveWorker: true, closeOk: false });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_cancel_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_abort',
      requestId: expect.any(String),
    }));
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-123',
    });
  });

  it('retries a durable abort commit after worker admission was already restored', async () => {
    const fixture = createFixture({ liveWorker: true, closeOk: false });
    const realFinish = sessionStore.finishMojoCloseAbort;
    vi.spyOn(sessionStore, 'finishMojoCloseAbort')
      .mockImplementationOnce(() => { throw new Error('abort journal disk full'); })
      .mockImplementation((...args) => realFinish(...args));

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
    });
    expect(fixture.ds.remoteCloseState).toMatchObject({ phase: 'abort_restored' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
    });
    expect(sendWorkerInput(fixture.ds, 'must stay fenced', 'om_abort_commit_pending')).toBe(false);

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_cancel_failed',
    });
    const sends = vi.mocked(fixture.worker.send).mock.calls.map(call => call[0]?.type);
    expect(sends.filter(type => type === 'close')).toHaveLength(2);
    expect(sends.filter(type => type === 'close_abort')).toHaveLength(2);
    expect(fixture.ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
  });

  it('uses the worker result when pre-init lineage was not durable yet', async () => {
    const fixture = createFixture({
      liveWorker: true,
      noActiveLineage: true,
      resultTaskId: 'mojo-from-system-init',
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'close' }));
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('retries only the durable commit after irreversible live cancellation', async () => {
    const fixture = createFixture({ liveWorker: true });
    const realClose = sessionStore.closeSession;
    const closeSpy = vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(fixture.worker.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_abort',
    }));
    expect(sessionStore.getSession(fixture.session.sessionId)?.status).toBe('active');
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      taskId: 'mojo-sid-123',
    });
    expect(sendWorkerInput(fixture.ds, 'must stay fenced', 'om_after_cancel')).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'oc_mojo',
      expect.stringMatching(/Mojo.*正在关闭/),
      'text',
      'app',
      'om_after_cancel',
    );

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    const sends = vi.mocked(fixture.worker.send).mock.calls.map(call => call[0]?.type);
    expect(sends.filter(type => type === 'close')).toHaveLength(1);
    expect(sends.filter(type => type === 'close_commit')).toHaveLength(1);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('recovers a durable prepared close after daemon loss without cancelling again', async () => {
    const fixture = createFixture({ liveWorker: true });
    const realClose = sessionStore.closeSession;
    vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(false);
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      taskId: 'mojo-sid-123',
    });

    // Simulate a daemon restart: the exact ChildProcess/runtime proof is gone;
    // only the durable active row and its journal survive.
    fixture.worker.killed = true;
    fixture.ds.remoteCloseState = undefined;
    setActiveSessionsRegistry(new Map());
    sessionStore.init('app');

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    const sends = vi.mocked(fixture.worker.send).mock.calls.map(call => call[0]?.type);
    expect(sends.filter(type => type === 'close')).toHaveLength(1);
    expect(sends.filter(type => type === 'close_commit')).toHaveLength(0);
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does not re-cancel when persisting a pre-init result lineage fails', async () => {
    const fixture = createFixture({
      liveWorker: true,
      noActiveLineage: true,
      resultTaskId: 'mojo-from-system-init',
    });
    const realPrepare = sessionStore.markMojoClosePrepared;
    vi.spyOn(sessionStore, 'markMojoClosePrepared')
      .mockImplementationOnce(() => { throw new Error('lineage disk full'); })
      .mockImplementation((...args) => realPrepare(...args));

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_durable_close_failed',
      retryable: true,
      taskId: 'mojo-from-system-init',
    });
    expect(fixture.worker.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'close_abort',
    }));
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
    });

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    const sends = vi.mocked(fixture.worker.send).mock.calls.map(call => call[0]?.type);
    expect(sends.filter(type => type === 'close')).toHaveLength(1);
    expect(sends.filter(type => type === 'close_commit')).toHaveLength(1);
  });

  it('refuses an interrupted durable prepare instead of resuming or re-cancelling it', async () => {
    const fixture = createFixture();
    sessionStore.beginMojoCloseJournal(
      fixture.session.sessionId,
      'crashed-close-request',
      'mojo-sid-123',
    );
    setActiveSessionsRegistry(new Map());
    sessionStore.init('app');

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      mojoCloseJournal: { phase: 'preparing', requestId: 'crashed-close-request' },
    });
  });

  it('does not accept a malformed prepared journal as cancellation proof', async () => {
    const fixture = createFixture();
    fixture.session.mojoCloseJournal = {
      phase: 'prepared',
      requestId: '',
      taskId: 'mojo-sid-123',
      updatedAt: '',
    };
    sessionStore.updateSession(fixture.session);

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
  });

  it('does not accept a prepared journal that exists only on a detached runtime copy', async () => {
    const fixture = createFixture();
    (fixture.ds as unknown as { session: typeof fixture.session }).session = {
      ...fixture.session,
      mojoCloseJournal: {
        phase: 'prepared',
        requestId: 'runtime-only-proof',
        taskId: 'mojo-sid-123',
        updatedAt: new Date().toISOString(),
      },
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'active' });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does not re-cancel a durable prepared proof missed by a detached runtime copy', async () => {
    const fixture = createFixture();
    sessionStore.beginMojoCloseJournal(
      fixture.session.sessionId,
      'durable-only-proof',
      'mojo-sid-123',
    );
    sessionStore.markMojoClosePrepared(
      fixture.session.sessionId,
      'durable-only-proof',
      'mojo-sid-123',
    );
    (fixture.ds as unknown as { session: typeof fixture.session }).session = {
      ...fixture.session,
      mojoCloseJournal: undefined,
    };

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'closed',
    });
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('does not clear a Mojo journal through another backend close path', async () => {
    const fixture = createFixture();
    fixture.session.backendType = 'riff';
    fixture.ds.initConfig = { backendType: 'riff' } as DaemonSession['initConfig'];
    fixture.session.mojoCloseJournal = {
      phase: 'prepared',
      requestId: 'cross-backend-close',
      taskId: 'mojo-sid-123',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(fixture.session);

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'active',
      mojoCloseJournal: { phase: 'prepared' },
    });
  });

  it('does not flatten a contradictory closed row with a journal into success', async () => {
    const fixture = createFixture();
    fixture.session.status = 'closed';
    fixture.session.closedAt = new Date().toISOString();
    fixture.session.mojoCloseJournal = {
      phase: 'uncertain',
      requestId: 'closed-but-uncertain',
      taskId: 'mojo-sid-123',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(fixture.session);
    setActiveSessionsRegistry(new Map());

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'mojo_close_reconciliation_required',
      retryable: true,
      taskId: 'mojo-sid-123',
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'uncertain',
    });
  });

  it('does not fork a replacement generation while remote close reconciliation is fenced', async () => {
    const fixture = createFixture();
    fixture.ds.worker = null;
    fixture.ds.remoteCloseState = {
      phase: 'uncertain',
      requestId: 'close-generation-1',
      taskId: 'mojo-sid-123',
    };

    expect(forkWorker(fixture.ds, 'must not start a replacement', {
      resume: true,
      turnId: 'om_fenced_refork',
    })).toBe(true);
    expect(fixture.ds.worker).toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'oc_mojo',
      expect.stringMatching(/Mojo.*正在关闭/),
      'text',
      'app',
      'om_fenced_refork',
    );
  });

  it('enforces the replacement fence from the durable journal alone', async () => {
    const fixture = createFixture();
    fixture.ds.worker = null;
    fixture.ds.remoteCloseState = undefined;
    fixture.session.mojoCloseJournal = {
      phase: 'uncertain',
      requestId: 'durable-close-generation',
      taskId: 'mojo-sid-123',
      updatedAt: new Date().toISOString(),
    };
    sessionStore.updateSession(fixture.session);

    expect(remoteRetirementAdmissionPhase(fixture.ds)).toBe('close-uncertain');
    expect(forkWorker(fixture.ds, 'must stay fenced after daemon recovery', {
      resume: true,
      turnId: 'om_durable_fenced_refork',
    })).toBe(true);
    expect(fixture.ds.worker).toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'oc_mojo',
      expect.stringMatching(/Mojo.*正在关闭/),
      'text',
      'app',
      'om_durable_fenced_refork',
    );
  });

  it('reports a PARKED lineage as residual even with no active lineage', async () => {
    // The production shape: restore-time quarantine moves the id into
    // mojoQuarantinedLineage and CLEARS riffParentTaskId. Reading only the active
    // slot made this row close as an ordinary success while its remote session
    // kept running.
    const fixture = createFixture({ parkedLineage: 'mojo-parked-9', noActiveLineage: true });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
      alreadyClosed: false,
      known: true,
    });
    // Nothing active to cancel, so no cancel is attempted.
    expect(cancelMojoMock).not.toHaveBeenCalled();
  });

  it('cancels the active lineage but still reports the parked one', async () => {
    // A row can carry both: restore parked the old id, the session then made a new
    // one. Cancelling the new one says nothing about the old.
    const fixture = createFixture({ parkedLineage: 'mojo-parked-9' });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).toHaveBeenCalledWith(expect.anything(), 'mojo-sid-123');
  });

  it('replays the same residual on a second close instead of failing', async () => {
    // The residual decision is persisted (the id is parked as part of the durable
    // close), so a repeat close is an idempotent success — not a retryable failure
    // about a missing owner.
    const fixture = createFixture({ legacyUnfrozen: true });
    const first = await closeSession(fixture.session.sessionId);
    expect(first).toMatchObject({ ok: true, outcome: 'closed_with_residual' });

    const second = await closeSession(fixture.session.sessionId);
    expect(second).toEqual({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-sid-123' },
      alreadyClosed: true,
      known: true,
    });
  });

  it('leaves ZERO mojo-field pollution when the durable close fails', async () => {
    // The park must not survive a failed save. If it did, the next turn would read
    // a still-live remote session as quarantined and start a new one — silently
    // breaking the "close failed, retry unchanged" guarantee.
    const fixture = createFixture({ legacyUnfrozen: true });
    const realClose = sessionStore.closeSession;
    const spy = vi.spyOn(sessionStore, 'closeSession').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(closeSession(fixture.session.sessionId)).rejects.toThrow('disk full');
    spy.mockRestore();
    void realClose;

    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after?.status).not.toBe('closed');
    expect(after?.mojoQuarantinedLineage).toBeUndefined();
    expect(after?.mojoQuarantineNoticePending).toBeUndefined();
    // The lineage the retry needs is still exactly where it was.
    expect(after?.riffParentTaskId).toBe('mojo-sid-123');
  });

  it('persists the park even when the runtime object is NOT the store row', async () => {
    // worker-pool used to write the park onto ds.session. When that is a different
    // object from the authoritative row (restore/transfer paths), the id never
    // reached disk: first close reported a residual, the second degraded to a plain
    // success, and the only cleanup handle was gone.
    const fixture = createFixture({ legacyUnfrozen: true });
    // Detach the runtime object from the store row, keeping the same field values.
    (fixture.ds as unknown as { session: unknown }).session = {
      ...fixture.session,
    };

    const first = await closeSession(fixture.session.sessionId);
    expect(first).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-sid-123' },
    });
    // Durable row carries the park, not just the in-memory copy.
    const onDisk = sessionStore.getSession(fixture.session.sessionId);
    expect(onDisk?.mojoQuarantinedLineage).toBe('mojo-sid-123');

    const second = await closeSession(fixture.session.sessionId);
    expect(second).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-sid-123' },
      alreadyClosed: true,
    });
  });
});

describe('closeSessionForBackgroundCleanup', () => {
  it('logs the surviving remote id when a background close leaves a residual', async () => {
    // These callers have no card/toast to render to, so the log line is the only
    // thing standing between "remote still running" and total invisibility.
    const fixture = createFixture({ legacyUnfrozen: true });
    const { logger } = await import('../src/utils/logger.js');

    const result = await closeSessionForBackgroundCleanup(
      fixture.session.sessionId,
      'unit cleanup',
    );

    expect(result).toMatchObject({ ok: true, outcome: 'closed_with_residual' });
    const warned = vi.mocked(logger.warn).mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('mojo-sid-123');
    expect(warned).toContain('mojo_lineage_quarantined');
    expect(warned).toContain('unit cleanup');
  });

  it('a LOCAL-subtree residual logs the host subtree, not a phantom remote id (round-11 P1-2)', async () => {
    const fixture = createFixture();
    const { logger } = await import('../src/utils/logger.js');
    cancelMojoMock.mockResolvedValue({ kind: 'cancelled', localResidual: 'local_subtree_boundary_unproven' });

    const result = await closeSessionForBackgroundCleanup(fixture.session.sessionId, 'unit cleanup');

    expect(result).toMatchObject({
      ok: true, outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    const warned = vi.mocked(logger.warn).mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('本地');            // names the host subtree
    expect(warned).not.toContain('undefined');
    expect(warned).not.toMatch(/远端会话.*未.*取消|remote session .*undefined/);
  });

  it('logs an error when a background close is refused', async () => {
    cancelMojoMock.mockResolvedValue({ kind: 'failed', message: 'HTTP 500', retryable: true });
    const fixture = createFixture();
    const { logger } = await import('../src/utils/logger.js');

    const result = await closeSessionForBackgroundCleanup(
      fixture.session.sessionId,
      'unit cleanup',
    );

    expect(result.ok).toBe(false);
    const errored = vi.mocked(logger.error).mock.calls.map(c => String(c[0])).join('\n');
    expect(errored).toContain('close REFUSED');
    expect(errored).toContain('unit cleanup');
    expect(errored).toContain('mojo-sid-123');
  });
});

describe('local residual survives durable retry, restart replay and the workerless path (round-6 P1)', () => {
  it('durable-retry: a failed prepare commit republishes the SAME residual close', async () => {
    // live worker reports ok + local residual; the first durable commit fails.
    // The retry must publish closed_with_residual — before this fix
    // remoteCloseState kept only {phase,requestId,taskId}, so the retry
    // silently downgraded the close to a plain `closed`.
    const fixture = createFixture({
      liveWorker: true,
      closeResidual: 'local_subtree_boundary_unproven',
    });
    recordOutstandingHandle(fixture.session.sessionId);
    const realPrepare = sessionStore.markMojoClosePrepared;
    vi.spyOn(sessionStore, 'markMojoClosePrepared')
      .mockImplementationOnce(() => { throw new Error('proof disk full'); })
      .mockImplementation((...args) => realPrepare(...args));

    expect(await closeSession(fixture.ds.session.sessionId, fixture.registry)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
    });
    expect(fixture.ds.remoteCloseState).toMatchObject({
      phase: 'prepared',
      localResidual: 'local_subtree_boundary_unproven',
    });

    expect(await closeSession(fixture.ds.session.sessionId, fixture.registry)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    // The replay handed the durable layer the residual it was replaying.
    const prepareCalls = vi.mocked(sessionStore.markMojoClosePrepared).mock.calls;
    expect(prepareCalls[prepareCalls.length - 1]![3]).toBe('local_subtree_boundary_unproven');
  });

  it('restart replay: a prepared journal carrying a residual still publishes it after daemon loss', async () => {
    const fixture = createFixture({
      liveWorker: true,
      closeResidual: 'local_subtree_unprovable_on_platform',
    });
    recordOutstandingHandle(fixture.session.sessionId);
    const realClose = sessionStore.closeSession;
    vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect((await closeSession(fixture.ds.session.sessionId, fixture.registry)).ok).toBe(false);
    // The residual reached the DURABLE journal with the prepare proof.
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      localResidual: 'local_subtree_unprovable_on_platform',
    });

    // Lose every runtime-only proof and reload the row exactly as a new daemon.
    setActiveSessionsRegistry(new Map());
    sessionStore.init('app');

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_unprovable_on_platform' },
    });
  });

  it('workerless: a weak-only local proof reaches the close as closed_with_residual', async () => {
    // cancelMojoSessionById now carries the workerless local-subtree proof on the
    // outcome; dropping it (the old `return null` contract in
    // proveWorkerlessLocalSubtree) published a plain closed row while the
    // containment handle silently stayed behind.
    const fixture = createFixture();
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({ status: 'closed' });
  });

  it('idempotent re-close STILL reports the local residual (round-7 finding-3)', async () => {
    // The residual's runtime home (the journal) is wiped on commit. Without
    // parking it on the row, a second close of the already-closed row — e.g. a
    // client that lost the first response and retries — returned a plain `closed`,
    // a false all-clear while the containment handle and blocker were still held.
    const fixture = createFixture();
    recordOutstandingHandle(fixture.session.sessionId);
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });

    const first = await closeSession(fixture.session.sessionId);
    expect(first).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    // The row is now closed and carries the parked local residual.
    expect(sessionStore.getSession(fixture.session.sessionId)).toMatchObject({
      status: 'closed',
      mojoLocalResidual: 'local_subtree_boundary_unproven',
    });

    const second = await closeSession(fixture.session.sessionId);
    expect(second).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    // No second cancel — the row was already closed.
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
  });

  it('workerless durable-retry: the residual survives a failed prepare commit too', async () => {
    const fixture = createFixture();
    recordOutstandingHandle(fixture.session.sessionId);
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });
    const realPrepare = sessionStore.markMojoClosePrepared;
    vi.spyOn(sessionStore, 'markMojoClosePrepared')
      .mockImplementationOnce(() => { throw new Error('proof disk full'); })
      .mockImplementation((...args) => realPrepare(...args));

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: false,
      error: 'mojo_durable_close_failed',
    });
    expect(fixture.ds.remoteCloseState).toMatchObject({
      phase: 'prepared',
      localResidual: 'local_subtree_boundary_unproven',
    });

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
    // No second cancel: the retry republished the recorded proof.
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);
  });
});

describe('mojoLocalResidual is DERIVED from the handle ledger (round-12 P1)', () => {
  // The row field has writes but deliberately no clear path: boot reconciliation
  // and operator revoke discharge the LEDGER only. Without read-time derivation
  // the field forked from the ledger permanently — a host reboot proved the tree
  // dead and released the handle, yet the row kept claiming "a credentialed
  // process may remain on this host" to every dashboard / re-close / repo-switch
  // consumer forever.
  it('re-close reports a plain closed once the ledger no longer holds a handle', async () => {
    // No handle is ever recorded — the ledger reads empty, exactly the state
    // boot reconciliation leaves behind after a reboot proof.
    const fixture = createFixture();
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });

    // The ORIGINAL close reports the live proof it just computed, ungated.
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
    });
    // The stale row field alone must no longer resurrect the claim.
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoLocalResidual)
      .toBe('local_subtree_boundary_unproven');
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
  });

  it('journal replay after daemon loss also derives: released handle → plain closed', async () => {
    const fixture = createFixture({
      liveWorker: true,
      closeResidual: 'local_subtree_unprovable_on_platform',
    });
    const realClose = sessionStore.closeSession;
    vi.spyOn(sessionStore, 'closeSession')
      .mockImplementationOnce(() => { throw new Error('disk full'); })
      .mockImplementation((...args) => realClose(...args));

    expect((await closeSession(fixture.ds.session.sessionId, fixture.registry)).ok).toBe(false);
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      localResidual: 'local_subtree_unprovable_on_platform',
    });

    // New daemon, and (unlike the round-6 case above) the ledger holds nothing:
    // a reboot between the prepare and this replay discharged the handle.
    setActiveSessionsRegistry(new Map());
    sessionStore.init('app');

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    // And the commit must not RE-PARK the journal's residual onto the row: a
    // "crash in prepared → host reboot" sequence would otherwise mint a fresh
    // stale field right after the reconcile cleaned everything up.
    expect(sessionStore.getSession(fixture.session.sessionId)?.mojoLocalResidual).toBeUndefined();
  });

  // Needs a real boot id to prove "recorded handle predates this boot" — on
  // hosts without /proc the reconcile fails closed and the case is meaningless.
  it.runIf(readBootId() !== null)(
    'end-to-end: boot reconciliation releases an old-boot handle and the re-close stops reporting',
    async () => {
      const fixture = createFixture();
      recordContainmentHandle({
        kind: 'tree-identity',
        sessionId: fixture.session.sessionId,
        generation: 1,
        rootPid: 4242,
        bootId: 'boot-previous-life', // provably not this boot
        startTime: 999,
        nonce: 'nonce-old-boot',
      });
      cancelMojoMock.mockResolvedValue({
        kind: 'cancelled',
        localResidual: 'local_subtree_boundary_unproven',
      });
      expect(await closeSession(fixture.session.sessionId)).toMatchObject({
        ok: true,
        outcome: 'closed_with_residual',
      });

      // The production consumer of the bootId proof, not a hand-emptied ledger.
      expect(reconcileContainmentHandlesOnBoot()).toMatchObject({ released: 1, retained: 0 });

      expect(await closeSession(fixture.session.sessionId)).toMatchObject({
        ok: true,
        outcome: 'closed',
      });
    },
  );

  it('operator revoke is not inherited either: re-close after revoke reports plain closed', async () => {
    const fixture = createFixture();
    recordOutstandingHandle(fixture.session.sessionId);
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
    });

    const { removed } = revokeContainmentHandles(fixture.session.sessionId, {
      auditNote: 'round-12 regression',
    });
    expect(removed).toHaveLength(1);

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed',
    });
  });

  it('an unreadable ledger keeps the residual reported (fail-closed)', async () => {
    const fixture = createFixture();
    cancelMojoMock.mockResolvedValue({
      kind: 'cancelled',
      localResidual: 'local_subtree_boundary_unproven',
    });
    expect(await closeSession(fixture.session.sessionId)).toMatchObject({ ok: true });

    // Corrupt the ledger AFTER the close: "cannot read" must never collapse into
    // "no handle, claim withdrawn" — that is the exact state in which an
    // unproven subtree would silently stop being reported.
    writeFileSync(join(dataDir, 'mojo-containment-handles.json'), '{not json');

    expect(await closeSession(fixture.session.sessionId)).toMatchObject({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'local_subtree_boundary_unproven' },
    });
  });
});
