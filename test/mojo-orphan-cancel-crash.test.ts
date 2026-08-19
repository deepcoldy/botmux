/**
 * The best-effort orphan-cancel is FIRE-AND-FORGET, so a rejection there has no
 * caller to land on: it becomes an unhandledRejection, and the daemon installs no
 * handler for those (only worker.ts does), so Node v22 terminates the process --
 * killing every OTHER session this daemon serves. The repo has a recorded
 * incident of exactly this shape (tmux-pipe-backend.ts).
 *
 * It is reachable, not theoretical: cancelMojoSessionById constructs its backend
 * before its own try block, so an unreadable containment store throws out of it
 * instead of returning the structured failure its signature promises. The
 * lineage-clearing sessionStore.updateSession in the same continuation can throw
 * for the same class of reason (a failed save).
 *
 * Both must degrade to "lineage retained, log it" -- never to a crash. That is
 * what makes the fail-closed design fail CLOSED rather than fail-CRASH.
 *
 * Run:  TMPDIR=/tmp pnpm vitest run test/mojo-orphan-cancel-crash.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { getBotMock, cancelMojoMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelMojoMock: vi.fn(),
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
  initWorkerPool,
  killWorker,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

/**
 * Capture unhandled rejections ourselves rather than relying on the runner.
 *
 * Vitest's own handling of an unhandled rejection varies with timing and can be
 * attributed to a later test, which would make this assertion a coin flip. The
 * production consequence is precisely "the process gets an unhandledRejection",
 * so observe that directly.
 */
function watchUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { seen.push(reason); };
  // Vitest installs its own listener that fails the run. Ours is additive; we do
  // not remove theirs, so a regression is caught either way.
  process.on('unhandledRejection', onUnhandled);
  return { seen, stop: () => { process.off('unhandledRejection', onUnhandled); } };
}

/** Let the rejection propagate: microtasks first, then a macrotask turn. */
async function drainRejections(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function createWorkerlessMojoSession() {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_mojo', 'om_mojo', 'orphan cancel', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'mojo';
  session.riffParentTaskId = 'mojo-sid-orphan';
  // A frozen identity is what makes the lineage cancellable at all; without it
  // the helper refuses before ever reaching the promise.
  session.mojoIdentity = { cloud: true };
  sessionStore.updateSession(session);

  // Workerless: this is the branch that fires the best-effort cancel.
  const worker = new EventEmitter() as any;
  worker.killed = true;
  worker.exitCode = 0;
  worker.kill = vi.fn();
  worker.send = vi.fn();

  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    session,
    initConfig: { backendType: 'mojo' },
  } as unknown as DaemonSession;
  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  return { session, ds, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-orphan-crash-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { mojo: { cloud: true } },
  });
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

describe('a rejected orphan cancel must not reach unhandledRejection', () => {
  it('survives a THROWN cancelMojoSessionById (corrupt containment store)', async () => {
    // The exact reported path: the backend is constructed above the function's own
    // try block, so an unreadable store escapes as a rejection instead of the
    // structured { kind: 'failed' } the signature promises.
    cancelMojoMock.mockRejectedValue(
      new Error('cannot read mojo containment store; an unproven subtree would be lost'),
    );
    const fixture = createWorkerlessMojoSession();
    const watcher = watchUnhandledRejections();

    try {
      killWorker(fixture.ds);
      await drainRejections();

      expect(watcher.seen).toEqual([]);
    } finally {
      watcher.stop();
    }

    // Failing closed means the lineage SURVIVES for an explicit /close to retry.
    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId)
      .toBe('mojo-sid-orphan');
  });

  it('survives a THROWN lineage clear after a successful cancel', async () => {
    // Same crash shape from the continuation instead of the call: the cancel
    // succeeded, and persisting the cleared lineage failed. Guarding only the
    // call (a .catch placed BEFORE .then) would leave this one unhandled.
    cancelMojoMock.mockResolvedValue({ kind: 'cancelled' });
    const fixture = createWorkerlessMojoSession();
    // Spied AFTER the fixture: seeding the row legitimately calls updateSession,
    // so an earlier spy would blow up the setup instead of the path under test.
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {
      throw new Error('journal disk full');
    });
    const watcher = watchUnhandledRejections();

    try {
      killWorker(fixture.ds);
      await drainRejections();

      expect(watcher.seen).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  it('still clears the lineage when the cancel really succeeded', async () => {
    // The guard must not swallow the success path: a proven-gone remote session
    // still has to drop its lineage, or every close would report a residual.
    cancelMojoMock.mockResolvedValue({ kind: 'cancelled' });
    const fixture = createWorkerlessMojoSession();

    killWorker(fixture.ds);
    await drainRejections();

    expect(sessionStore.getSession(fixture.session.sessionId)?.riffParentTaskId)
      .toBeUndefined();
  });
});
