/**
 * #1607: when a hidden schedule run's CLI never took its prompt, the worker
 * reports the turn as a failed terminal with a dedicated error code. The
 * worker pool must hand that code to the deferred-schedule settlement (which
 * reports the run instead of closing it quietly); an ordinary terminal carries
 * none. Drives the real worker-pool IPC handler with a fake worker, like
 * silent-turn-receipt.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE } from '../src/core/deferred-schedule-settlement.js';
import type { DaemonSession } from '../src/core/types.js';
import { EventEmitter } from 'node:events';

const TURN = 'schedule:task-1607:run-1';

function makeHiddenRun(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-hidden-run',
      rootMessageId: 'schedule-run:task-1607:run-1',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'opencode',
      scope: 'chat',
      deferredScheduleRun: {
        taskId: 'task-1607', turnId: TURN, routingAnchor: 'schedule-run:task-1607:run-1',
        createdAt: new Date().toISOString(), runId: 'run-1',
      },
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
}

describe('hidden schedule run terminal → settlement', () => {
  const settled = vi.fn();
  beforeEach(() => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_x'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onDeferredScheduleTurnSettled: settled,
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('passes the undelivered verdict of a failed terminal on to the settlement', async () => {
    const ds = makeHiddenRun();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: 'sid-hidden-run', turnId: TURN,
      status: 'failed', errorCode: SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE,
    });

    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(ds, {
      turnId: TURN, source: 'terminal', errorCode: SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE,
    }));
  });

  it('settles a completed terminal without any verdict', async () => {
    const ds = makeHiddenRun();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: 'sid-hidden-run', turnId: TURN, status: 'completed',
    });

    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(ds, { turnId: TURN, source: 'terminal' }));
  });
});
