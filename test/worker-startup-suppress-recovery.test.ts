/**
 * Daemon-side wiring test — worker-pool `notifyStartupFailure` recovery-mode
 * suppression (restart broadcast-storm fix).
 *
 * Pins the contract: while `ds.suppressRecoveryCard` is set (daemon-restart
 * batch restore, cleared by the first real CLI input), a worker startup
 * failure must NOT post a "会话启动失败" card into the session's chat — the
 * failure still lands in the daemon log. Once the flag clears, failures
 * notify normally again.
 *
 * Harness mirrors worker-startup-retry-wiring.test.ts (fake worker
 * EventEmitter + __testOnly_setupWorkerHandlers).
 *
 * Run:  pnpm vitest run --project unit test/worker-startup-suppress-recovery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
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
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'codex' },
  },
}));

const updateSessionMock = vi.fn();
const sessionReplyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/services/session-lifecycle-hooks.js', () => ({
  emitSessionLifecycleHook: vi.fn(),
  emitSessionStateTransitionHook: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers, restartCounts } from '../src/core/worker-pool.js';
import { logger } from '../src/utils/logger.js';
import type { DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(sessionId: string, worker: any): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as DaemonSession;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

const DETERMINISTIC_REASON = 'spawn codex ENOENT';

describe("worker-pool startup failure × suppressRecoveryCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restartCounts.clear();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  it('suppresses the startup-failure card in recovery mode but still logs (daemon-restart restore)', async () => {
    const ds = makeDs('sid-recovery-suppressed', makeFakeWorker());
    ds.suppressRecoveryCard = true;
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'error', message: DETERMINISTIC_REASON });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('suppressRecoveryCard'),
    );
    // The reason must stay visible in the daemon log for post-mortems.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(DETERMINISTIC_REASON),
    );
  });

  it('suppresses a turn-carrying startup failure in recovery mode too (guard precedes turn handling)', async () => {
    const ds = makeDs('sid-recovery-turn', makeFakeWorker());
    ds.suppressRecoveryCard = true;
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'error',
      message: DETERMINISTIC_REASON,
      turnId: 'turn-recovery-1',
      dispatchAttempt: 1,
    });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('suppressRecoveryCard'),
    );
  });

  it('posts the startup-failure card when suppressRecoveryCard is off (regression guard)', async () => {
    const ds = makeDs('sid-recovery-off', makeFakeWorker());
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'error', message: DETERMINISTIC_REASON });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining(DETERMINISTIC_REASON),
      'text',
      'app_test',
      undefined,
      undefined,
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('suppressRecoveryCard'),
    );
  });

  it('does not permanently mute the session: a failure after the flag clears still notifies', async () => {
    const ds = makeDs('sid-recovery-transient', makeFakeWorker());
    ds.suppressRecoveryCard = true;
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);

    // First failure lands during recovery: suppressed, no card.
    worker.emit('message', { type: 'error', message: DETERMINISTIC_REASON });
    await flush();
    expect(sessionReplyMock).not.toHaveBeenCalled();

    // First real CLI input clears the recovery silence (rememberLastCliInput
    // in production); the same worker generation failing again must notify.
    ds.suppressRecoveryCard = undefined;
    worker.emit('message', { type: 'error', message: DETERMINISTIC_REASON });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining(DETERMINISTIC_REASON),
      'text',
      'app_test',
      undefined,
      undefined,
    );
  });
});
