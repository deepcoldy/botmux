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
  __testOnly_setupWorkerHandlers,
  closeSession,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

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

  const worker = liveWorker
    ? Object.assign(new EventEmitter(), {
        killed: false,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
        send: vi.fn(),
      })
    : null;
  if (worker) {
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
  }
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

  it('fails closed for a worker-less active row with opaque provider state', async () => {
    const { ds } = createFixture(false);

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_missing',
      retryable: true,
    });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });
});
