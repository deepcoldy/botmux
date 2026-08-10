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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { getBotMock, cancelMojoMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelMojoMock: vi.fn(async () => true),
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
  liveWorker?: boolean;
  /** Omit the frozen identity so the lineage reads as quarantined. */
  legacyUnfrozen?: boolean;
} = {}) {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_mojo', 'om_mojo', 'mojo close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'mojo';
  session.riffParentTaskId = 'mojo-sid-123';
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
    // A real worker exits after handling {type:'close'}; closeSession waits for it.
    worker.send = vi.fn((message: any) => {
      if (message.type !== 'close') return;
      queueMicrotask(() => {
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
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
  cancelMojoMock.mockResolvedValue(true);
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

describe('mojo explicit close', () => {
  it('awaits worker-less cancellation before closing, then clears the lineage', async () => {
    const fixture = createFixture();

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).toHaveBeenCalledWith(expect.anything(), 'mojo-sid-123');
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.riffParentTaskId).toBeUndefined();
    expect(fixture.registry.size).toBe(0);
  });

  it('does NOT report success when the cancel fails; row and lineage survive', async () => {
    // The whole point: the operator must not be told the session is gone while the
    // remote one keeps running with the injected credential.
    cancelMojoMock.mockResolvedValue(false);
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
    expect(fixture.registry.size).toBe(1);
  });

  it('a retry after a failed cancel actually reaches the cancel again', async () => {
    // The regression this suite exists for: the old path closed the row on the
    // first attempt, so nothing could ever retry the cancel.
    cancelMojoMock.mockResolvedValue(false);
    const fixture = createFixture();
    expect((await closeSession(fixture.session.sessionId)).ok).toBe(false);
    expect(cancelMojoMock).toHaveBeenCalledTimes(1);

    cancelMojoMock.mockResolvedValue(true);
    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
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

  it('never cancels a quarantined lineage, but still closes', async () => {
    // Nothing records which control plane holds an unfrozen lineage, so cancelling
    // could reach a different tenant. Close proceeds and the id is KEPT on the row
    // for manual cleanup — a retry could never make this safe.
    const fixture = createFixture({ legacyUnfrozen: true });

    expect(await closeSession(fixture.session.sessionId)).toEqual({
      ok: true,
      alreadyClosed: false,
      known: true,
    });
    expect(cancelMojoMock).not.toHaveBeenCalled();
    const after = sessionStore.getSession(fixture.session.sessionId);
    expect(after).toMatchObject({ status: 'closed' });
    expect(after?.riffParentTaskId).toBe('mojo-sid-123');
  });

  it('closes (keeping the lineage) when the bot is deregistered', async () => {
    // Cancelling is impossible and no retry could change that, so blocking the
    // close forever would strand the row instead of just the remote session.
    getBotMock.mockImplementation(() => { throw new Error('bot gone'); });
    const fixture = createFixture();

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId)
      .toBe('mojo-sid-123');
  });

  it('leaves cancellation to the worker when one is live', async () => {
    // The `close` IPC makes the worker run MojoBackend.destroySession(), which
    // awaits the cancel on its own side AND waits out the pre-init window the
    // daemon cannot observe. A daemon-side cancel here would race it.
    const fixture = createFixture({ liveWorker: true });

    expect((await closeSession(fixture.session.sessionId)).ok).toBe(true);
    expect(cancelMojoMock).not.toHaveBeenCalled();
    expect(fixture.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'close' }));
  });
});
