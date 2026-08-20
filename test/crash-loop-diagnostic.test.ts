/**
 * Daemon-side crash-loop handling — worker-pool `case 'claude_exit'`, rc.count > 3.
 *
 *   - canParkDiagnostic:true   → KEEP the worker (ask it to park via park_diagnostic),
 *     reset the restart counter, status → idle, and mark the session
 *     suspendedColdResume so the parked diagnostic shell's "send a message to
 *     retry" affordance survives a daemon restart (restore lazy-resumes
 *     instead of zombie-closing).
 *   - canParkDiagnostic:false  → historical path: kill the worker.
 *
 * Run:  pnpm vitest run --project unit test/crash-loop-diagnostic.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks (mirror worker-ready-display-mode.test.ts harness) ────────────────

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
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
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
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
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

// ─── Imports under test ──────────────────────────────────────────────────────

import { initWorkerPool, __testOnly_setupWorkerHandlers, restartCounts, sendWorkerInput } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';

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
    hasHistory: false,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as DaemonSession;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

async function crashTimes(worker: any, n: number, canParkDiagnostic?: boolean) {
  for (let i = 0; i < n; i++) {
    worker.emit('message', { type: 'claude_exit', code: 1, signal: null, canParkDiagnostic });
  }
  await flush();
}

describe("crash-loop diagnostic terminal (daemon 'claude_exit' handler)", () => {
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

  it('does not auto-restart a crashed Riff worker and tells the user how to recover', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-riff-no-restart', worker);
    ds.session.cliId = 'riff';
    ds.session.backendType = 'riff';
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 1);

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'restart' });
    expect(restartCounts.has('sid-riff-no-restart')).toBe(false);
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringMatching(/Riff.*不支持重启.*\/close/),
      'text',
      'app_test',
      undefined,
      undefined,
    );
  });

  it('does not duplicate recovery guidance while an explicit Riff close owns the exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-riff-closing', worker);
    ds.session.cliId = 'riff';
    ds.session.backendType = 'riff';
    ds.remoteCloseState = {
      phase: 'preparing',
      requestId: 'close-riff',
      taskId: 'task-riff',
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 1);

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'restart' });
    expect(restartCounts.has('sid-riff-closing')).toBe(false);
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('after >3 tmux crashes: keeps the worker + marks lazy cold-resume (survives restart)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-keep', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);

    // First 3 auto-restart in place; the 4th asks the worker to park a
    // diagnostic shell (deferred park) and keeps it alive (no close).
    // auto-restart 捎带最新 per-bot env + 最新模型（本 fixture 的 mock getBot
    // 两者都没配 → 均为 null，即「明确清空快照」），并标记 reason: 'cli_crash'
    // 区分 operator 主动 restart。
    expect(worker.send).toHaveBeenCalledWith({ type: 'restart', reason: 'cli_crash', env: null, model: null });
    expect(worker.send).toHaveBeenCalledWith({ type: 'park_diagnostic' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    // Survives daemon restart: lazy cold-resume + idle, restart counter reset.
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.lastScreenStatus).toBe('idle');
    expect(restartCounts.has('sid-diag-keep')).toBe(false);
    expect(updateSessionMock).toHaveBeenCalled();
  });

  // The parked worker respawns the CLI ITSELF when the next message arrives
  // (worker.ts `Message received after crash-loop stop`), so that message is the
  // only channel that can refresh its launch snapshot — a model changed while the
  // session sat parked must reach the recovery spawn.
  it('carries the current launch model on the message that triggers the parked retry', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-model', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);
    expect(ds.crashDiagnosticParked).toBe(true);

    // The user changes the bot's model while the session sits parked.
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', model: 'opus' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    worker.send.mockClear();

    sendWorkerInput(ds, 'retry please', 'om_turn_retry');

    const message = worker.send.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type === 'message');
    expect(message?.model).toBe('opus');

    // Once a CLI is live again the refresh stops riding along on every turn.
    worker.emit('message', { type: 'ready', port: 1234, token: 't' });
    expect(ds.crashDiagnosticParked).toBeUndefined();
  });

  it('clears suspendedColdResume once the retried CLI reaches prompt_ready (in-place retry path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-cleared', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);
    expect(ds.session.suspendedColdResume).toBe(true); // parked → marked for restart survival

    // The in-place retry (worker.ts) respawns the CLI WITHOUT going through
    // forkWorker; prompt_ready is the daemon's signal that retry succeeded.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(ds.session.suspendedColdResume).toBeFalsy();
  });

  it('after >3 crashes with NO diagnostic terminal: kills the worker (historical path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-nokeep', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, undefined);

    expect(worker.send).toHaveBeenCalledWith({ type: 'close' });
    expect(ds.session.suspendedColdResume).toBeFalsy();
  });

});
