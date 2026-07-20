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
vi.mock('../src/services/session-store.js', () => ({
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

import { initWorkerPool, __testOnly_setupWorkerHandlers, restartCounts } from '../src/core/worker-pool.js';
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
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  it('after >3 tmux crashes: keeps the worker + marks lazy cold-resume (survives restart)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-keep', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);

    // First 3 auto-restart in place; the 4th asks the worker to park a
    // diagnostic shell (deferred park) and keeps it alive (no close).
    expect(worker.send).toHaveBeenCalledWith({ type: 'restart', reason: 'cli_crash' });
    expect(worker.send).toHaveBeenCalledWith({ type: 'park_diagnostic' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    // Survives daemon restart: lazy cold-resume + idle, restart counter reset.
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.lastScreenStatus).toBe('idle');
    expect(restartCounts.has('sid-diag-keep')).toBe(false);
    expect(updateSessionMock).toHaveBeenCalled();
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

  it('fails closed on an unexpected Riff exit without restarting or retiring its generation', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-riff-unexpected-exit', worker);
    ds.session.cliId = 'riff';
    ds.session.backendType = 'riff';
    ds.session.riffParentTaskId = 'task-riff-unexpected-exit';
    ds.initConfig = { backendType: 'riff' } as any;
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 1);

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'restart', reason: 'cli_crash' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'park_diagnostic' });
    expect(ds.worker).toBe(worker);
    expect(ds.session.riffParentTaskId).toBe('task-riff-unexpected-exit');
    expect(ds.session.status).toBe('active');
    expect(ds.lastScreenStatus).toBe('idle');
    expect(restartCounts.has('sid-riff-unexpected-exit')).toBe(false);
  });
});
