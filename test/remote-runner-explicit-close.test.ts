import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { listChatPinsMock } = vi.hoisted(() => ({
  listChatPinsMock: vi.fn(async () => []),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/adapters/backend/mojo-backend.js', () => ({
  cancelMojoSessionById: vi.fn(async () => ({ kind: 'cancelled' as const })),
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
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(async () => true),
  listChatPins: (...args: unknown[]) => listChatPinsMock(...args),
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
  __testOnly_setRemoteRunnerExplicitCloseWake,
  __testOnly_setupWorkerHandlers,
  __testOnly_wakeRemoteRunnerWorkerForExplicitClose,
  closeSession,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

function createFakeWorker(): EventEmitter & {
  killed: boolean;
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
} {
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
    send: vi.fn(),
  });
  worker.send.mockImplementation((message: { type: string; requestId?: string }) => {
    if (message.type === 'close' && message.requestId) {
      queueMicrotask(() => worker.emit('message', {
        type: 'close_result',
        requestId: message.requestId,
        ok: true,
      }));
    } else if (message.type === 'close_commit') {
      queueMicrotask(() => {
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
    }
  });
  return worker;
}

function createFixture(liveWorker: boolean): {
  ds: DaemonSession;
  worker: (EventEmitter & { killed: boolean; send: ReturnType<typeof vi.fn> }) | null;
} {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_remote', 'om_remote', 'remote close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'remote-runner';
  session.remoteBackendState = {
    version: 1,
    provider: 'test-provider',
    generation: 1,
    remoteSessionId: 'remote-1',
    agentThreadId: 'thread-1',
  };
  sessionStore.updateSession(session);

  const worker = liveWorker ? createFakeWorker() : null;
  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    session,
    initConfig: { backendType: 'remote-runner' },
  } as unknown as DaemonSession;
  if (worker) __testOnly_setupWorkerHandlers(ds, worker as never);
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  return { ds, worker };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-remote-close-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  listChatPinsMock.mockResolvedValue([]);
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __testOnly_setRemoteRunnerExplicitCloseWake();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('remote runner explicit close', () => {
  it('uses prepare/commit before publishing a live remote session closed', async () => {
    const { ds, worker } = createFixture(true);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    const sent = worker!.send.mock.calls.map(([message]) => message);
    const prepare = sent.find(message => message.type === 'close');
    expect(prepare?.requestId).toEqual(expect.any(String));
    expect(sent).toContainEqual({ type: 'close_commit', requestId: prepare.requestId });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
    expect(sessionStore.getSession(ds.session.sessionId)?.remoteBackendState).toMatchObject({
      remoteSessionId: 'remote-1',
      agentThreadId: 'thread-1',
    });
  });

  it('allows a live pre-ready worker to close before backend state is persisted', async () => {
    const { ds } = createFixture(true);
    ds.session.remoteBackendState = undefined;
    sessionStore.updateSession(ds.session);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });

  it('fails closed for a worker-less active row with opaque provider state', async () => {
    const { ds } = createFixture(false);
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => false);

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_missing',
      retryable: true,
    });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });

  it('wakes a control-only worker before closing a dormant remote session', async () => {
    const { ds } = createFixture(false);
    const wake = vi.fn(async (target: DaemonSession) => {
      const worker = createFakeWorker();
      target.worker = worker as never;
      target.workerReady = true;
      __testOnly_setupWorkerHandlers(target, worker as never);
      return true;
    });
    __testOnly_setRemoteRunnerExplicitCloseWake(wake);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(ds, expect.stringMatching(/^remote-runner-wake:/));
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });

  it('uses an empty, non-deferred resume fork for the control-only wake', async () => {
    const { ds } = createFixture(false);
    const fork = vi.fn((
      target: DaemonSession,
      prompt: unknown,
      resume: unknown,
      opts: { deferDuringDeviceIsolation?: boolean; onAdmission?: (value: 'accepted') => void },
    ) => {
      const worker = createFakeWorker();
      target.worker = worker as never;
      target.workerReady = true;
      opts.onAdmission?.('accepted');
      return true;
    });

    await expect(
      __testOnly_wakeRemoteRunnerWorkerForExplicitClose(ds, fork as never),
    ).resolves.toBe(true);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork.mock.calls[0]?.[1]).toBe('');
    expect(fork.mock.calls[0]?.[2]).toBe(true);
    expect(fork.mock.calls[0]?.[3]).toMatchObject({
      deferDuringDeviceIsolation: false,
      onAdmission: expect.any(Function),
    });
  });

  it('refuses a control-only wake while durable queued work is unsettled', async () => {
    const { ds } = createFixture(false);
    ds.session.queued = true;
    sessionStore.updateSession(ds.session);
    const fork = vi.fn(() => true);

    await expect(
      __testOnly_wakeRemoteRunnerWorkerForExplicitClose(ds, fork as never),
    ).resolves.toBe(false);
    expect(fork).not.toHaveBeenCalled();
    expect(ds.remoteCloseState).toBeUndefined();
  });

  it('clears the wake admission fence when control-worker materialization throws', async () => {
    const { ds } = createFixture(false);
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => {
      throw new Error('wake exploded');
    });

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_missing',
      retryable: true,
    });
    expect(ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });
});
