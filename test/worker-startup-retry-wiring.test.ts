/**
 * Daemon-side wiring test — worker-pool `case 'error'` transient self-heal
 * (2026-08-23 tmux restart-storm incident).
 *
 * Pins the contract of scheduleTransientStartupRetry:
 *   - a TURN-LESS transient failure ("spawnSync tmux ETIMEDOUT") schedules a
 *     bounded silent retry: NO user-visible 会话启动失败 card, retry state on ds;
 *   - repeated transient failures escalate attempts; once the budget
 *     (MAX_STARTUP_AUTO_RETRIES) is exhausted the standard card IS posted;
 *   - a turn-carrying failure keeps the immediate notify (the sender is
 *     waiting; durable deliveries own their retries);
 *   - a deterministic failure (ENOENT install breakage) notifies immediately.
 *
 * Harness mirrors crash-loop-diagnostic.test.ts (fake worker EventEmitter +
 * __testOnly_setupWorkerHandlers).
 *
 * Run:  pnpm vitest run --project unit test/worker-startup-retry-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { MAX_STARTUP_AUTO_RETRIES } from '../src/core/worker-startup-retry.js';
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

/** One worker GENERATION per failure round, like production: each round wires
 *  fresh handlers (fresh startupState) on a new fake worker bound to the same
 *  ds, then delivers the fatal `error` IPC. */
async function failOnce(ds: DaemonSession, message: string, extras: Record<string, unknown> = {}) {
  const worker = makeFakeWorker();
  ds.worker = worker;
  __testOnly_setupWorkerHandlers(ds, worker);
  worker.emit('message', { type: 'error', message, ...extras });
  await flush();
}

const INCIDENT_REASON = 'spawnSync tmux ETIMEDOUT';

describe("worker-pool 'error' transient self-heal wiring", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a silent bounded retry for a turn-less transient failure (08-23 incident shape)', async () => {
    const ds = makeDs('sid-transient', makeFakeWorker());
    await failOnce(ds, INCIDENT_REASON);

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.startupAutoRetry?.attempts).toBe(1);
    expect(ds.startupAutoRetry?.timer).toBeDefined();
  });

  it('escalates attempts per failing generation and surfaces the card only after the budget is exhausted', async () => {
    const ds = makeDs('sid-budget', makeFakeWorker());

    for (let round = 1; round <= MAX_STARTUP_AUTO_RETRIES; round += 1) {
      await failOnce(ds, INCIDENT_REASON);
      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(ds.startupAutoRetry?.attempts).toBe(round);
    }

    // Budget exhausted → the standard user-visible failure card is posted.
    await failOnce(ds, INCIDENT_REASON);
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('spawnSync tmux ETIMEDOUT'),
      'text',
      'app_test',
      undefined,
      undefined,
    );
  });

  it('keeps the immediate notify for a turn-carrying transient failure (sender is waiting)', async () => {
    const ds = makeDs('sid-turn', makeFakeWorker());
    await failOnce(ds, INCIDENT_REASON, { turnId: 'turn-123' });

    expect(ds.startupAutoRetry).toBeUndefined();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the immediate notify for a deterministic failure (install breakage)', async () => {
    const ds = makeDs('sid-enoent', makeFakeWorker());
    await failOnce(ds, 'spawn codex ENOENT');

    expect(ds.startupAutoRetry).toBeUndefined();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
  });

  it('does not double-notify via the pre-ready exit guard once a retry is scheduled', async () => {
    const ds = makeDs('sid-exit-guard', makeFakeWorker());
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'error', message: INCIDENT_REASON });
    await flush();
    // The worker process then dies (sendFatalWorkerErrorAndExit → exit 1).
    worker.emit('exit', 1, null);
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.startupAutoRetry?.attempts).toBe(1);
  });

  it('clears the previous pending timer when a later generation schedules the next attempt (no orphan timers)', async () => {
    const ds = makeDs('sid-orphan-timer', makeFakeWorker());

    await failOnce(ds, INCIDENT_REASON);
    expect(ds.startupAutoRetry?.attempts).toBe(1);
    const firstTimer = ds.startupAutoRetry!.timer;
    expect(firstTimer).toBeDefined();

    // An inbound message revives the session, the replacement generation fails
    // too: attempt 2 must REPLACE the pending attempt-1 timer, not stack an
    // orphan beside it.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await failOnce(ds, INCIDENT_REASON);
      expect(ds.startupAutoRetry?.attempts).toBe(2);
      expect(ds.startupAutoRetry?.timer).not.toBe(firstTimer);
      expect(clearSpy.mock.calls.some(([handle]) => handle === firstTimer)).toBe(true);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('the pending retry no-ops (no fork) when another path already revived the session', async () => {
    vi.useFakeTimers();
    const ds = makeDs('sid-revived', makeFakeWorker());
    const worker = makeFakeWorker();
    ds.worker = worker;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'error', message: INCIDENT_REASON });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.startupAutoRetry?.attempts).toBe(1);

    // An inbound message revived the session with a live worker before the
    // timer fired; the retry must yield without touching it (a real fork here
    // would throw in this harness — reaching child_process.fork of a worker).
    const revived = makeFakeWorker();
    ds.worker = revived;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(ds.worker).toBe(revived);
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });
});
