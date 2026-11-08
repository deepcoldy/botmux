/**
 * worker-pool + idle-worker-sweeper: a session woken by a message shows an
 * idle prompt while its worker is still typing that message into the CLI.
 * Over the live-worker cap, with every other session busy, it was the only
 * idle candidate, and suspending it destroyed the message with the CLI.
 *
 * The worker's `cli_input_backlog` report keeps it out of every automatic
 * sweep until the CLI has taken the input; a deliberate retirement in that
 * window tells the user the message did not land.
 *
 * Run: bun x vitest run --project unit test/worker-pool-unaccepted-cli-input.test.ts
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: vi.fn(),
}));

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
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
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

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
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
  TmuxBackend: class { static sessionName(sessionId: string) { return `bmx-${sessionId.slice(0, 8)}`; } },
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

import {
  initWorkerPool,
  suspendWorker,
  __testOnly_setupWorkerHandlers,
  __testOnly_setSuspendBackingVerifier,
} from '../src/core/worker-pool.js';
import {
  DEFAULT_MAX_LIVE_WORKERS,
  reclaimIdleWorkersForAdmission,
  selectIdleSuspendCandidates,
  sweepIdleWorkers,
  sweepIdleWorkersAsync,
} from '../src/core/idle-worker-sweeper.js';
import { botLocale, t as tr } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';

const now = Date.UTC(2026, 10, 7, 12, 30, 0);
const WAKE_TURN = 'om_wake_message_0001';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.once = vi.fn();
  worker.pid = 4242;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(sessionId: string, worker: any, status: 'idle' | 'working', lastMessageAt: number): DaemonSession {
  return {
    session: {
      sessionId, rootMessageId: `om_root_${sessionId}`, chatId: 'oc_chat', title: sessionId,
      status: 'active', createdAt: new Date(now - 86_400_000).toISOString(), chatType: 'group',
      cliId: 'claude-code', workingDir: '/repo', cliSessionId: `native-${sessionId}`,
      lastMessageAt: new Date(lastMessageAt).toISOString(),
    },
    worker, workerPort: 9999, workerToken: 'tok', workerReady: true, larkAppId: 'app_test',
    chatId: 'oc_chat', chatType: 'group', scope: 'thread', spawnedAt: lastMessageAt, lastMessageAt,
    hasHistory: true, workingDir: '/repo', displayMode: 'hidden', lastScreenContent: '',
    lastScreenStatus: status, idleSinceAt: status === 'idle' ? now - 2 * 3_600_000 : undefined,
    initConfig: { backendType: 'tmux' },
  } as unknown as DaemonSession;
}

/** The incident's shape: the bot is one over its cap, every other session is
 *  mid-turn, and the session just woken by a message is the only idle one. */
function overCapWithOnlyTheWokenSessionIdle() {
  const worker = makeFakeWorker();
  const woken = makeDs('woken', worker, 'idle', now);
  __testOnly_setupWorkerHandlers(woken, worker);
  const sessions = new Map<string, DaemonSession>();
  for (let i = 0; i < DEFAULT_MAX_LIVE_WORKERS; i++) {
    sessions.set(`busy-${i}`, makeDs(`busy-${i}`, makeFakeWorker(), 'working', now - (i + 1) * 60_000));
  }
  sessions.set('woken', woken);
  return { worker, woken, sessions };
}

async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

function retiredBeforeCliAcceptNotices(sessionReply: ReturnType<typeof vi.fn>, turnId: string): unknown[][] {
  const expected = tr('worker.input_retired_before_cli_accept', { turnId: turnId.substring(0, 16) }, botLocale({}));
  return sessionReply.mock.calls.filter(call => call[1] === expected);
}

describe('a session whose CLI has not taken its message yet', () => {
  let sessionReply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_setSuspendBackingVerifier(() => true);
    sessionReply = vi.fn(async () => 'om_notice');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  });

  afterEach(() => __testOnly_setSuspendBackingVerifier());

  it('is not suspended by the live-worker cap, the idle TTL or admission reclaim, then is once the CLI takes it', () => {
    const { worker, woken, sessions } = overCapWithOnlyTheWokenSessionIdle();

    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    expect(sweepIdleWorkers(sessions, {})).toEqual([]);
    expect(sweepIdleWorkers(sessions, { idleTtlMs: 60_000, now })).toEqual([]);
    expect(reclaimIdleWorkersForAdmission(sessions, { maxSuspend: 1 })).toEqual([]);
    expect(woken.worker).toBe(worker);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    worker.emit('message', { type: 'cli_input_backlog', pending: false });

    expect(sweepIdleWorkers(sessions, {})).toEqual([{ sessionId: 'woken', reason: 'live_worker_cap' }]);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(woken.worker).toBe(null);
  });

  it('is re-checked right before the kill: a report landing during the async sweep saves it', async () => {
    const { worker, woken, sessions } = overCapWithOnlyTheWokenSessionIdle();

    const suspended = await sweepIdleWorkersAsync(sessions, {}, async () => {
      worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });
    });

    expect(suspended).toEqual([]);
    expect(woken.worker).toBe(worker);
  });

  it('is not proposed by the operator idle-age sweep until the CLI takes it', () => {
    const day = 86_400_000;
    const worker = makeFakeWorker();
    const quiet = makeDs('quiet', worker, 'idle', now - 8 * day);
    quiet.idleSinceAt = now - 8 * day;
    __testOnly_setupWorkerHandlers(quiet, worker);
    const sessions = new Map<string, DaemonSession>([['quiet', quiet]]);
    const ids = () => selectIdleSuspendCandidates(sessions, { olderThanMs: 7 * day, now }).map(c => c.sessionId);

    worker.emit('message', { type: 'cli_input_backlog', pending: true });
    expect(ids()).toEqual([]);

    worker.emit('message', { type: 'cli_input_backlog', pending: false });
    expect(ids()).toEqual(['quiet']);
  });

  it('holds a suspend queued for its idle edge until the CLI takes the message, then carries it out', async () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    worker.emit('message', { type: 'cli_install_changed', runningVersion: '1.1.0', installedVersion: '1.3.0' });
    await flush();

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(woken.worker).toBe(worker);
    expect(woken.pendingSuspendReason).toBe('cli_install_changed');

    worker.emit('message', { type: 'cli_input_backlog', pending: false });
    await flush();

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(woken.worker).toBe(null);
    expect(woken.pendingSuspendReason).toBeUndefined();
  });

  it('keeps a suspend queued during the write off the turn that write opened, until that turn ends', async () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });
    worker.emit('message', { type: 'cli_install_changed', runningVersion: '1.1.0', installedVersion: '1.3.0' });
    await flush();

    // What the worker sends once the CLI takes the message.
    worker.emit('message', { type: 'screen_update', content: '', status: 'working', turnId: WAKE_TURN });
    worker.emit('message', { type: 'cli_input_backlog', pending: false });
    await flush();

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(woken.worker).toBe(worker);

    worker.emit('message', { type: 'screen_update', content: '', status: 'idle', turnId: WAKE_TURN });
    await flush();

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(woken.worker).toBe(null);
  });

  it('tells the user when a deliberate suspend retires the worker mid-write, even if the write then fails', () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    expect(suspendWorker(woken, 'manual_suspend')).toBe(true);
    // Destroying the pane fails the write; the retired worker's update must
    // not erase the turn it was carrying.
    worker.emit('message', { type: 'cli_input_backlog', pending: false });
    worker.emit('exit', 0, null);

    const notices = retiredBeforeCliAcceptNotices(sessionReply, WAKE_TURN);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual([woken.session.rootMessageId, expect.any(String), 'text', 'app_test', WAKE_TURN]);
  });

  it('stays silent when the write had settled before the suspend', () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });
    worker.emit('message', { type: 'cli_input_backlog', pending: false });

    expect(suspendWorker(woken, 'manual_suspend')).toBe(true);
    worker.emit('exit', 0, null);

    expect(retiredBeforeCliAcceptNotices(sessionReply, WAKE_TURN)).toEqual([]);
  });

  it('does not report a turn as lost when its commit ACK drained after the worker retired', () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    expect(suspendWorker(woken, 'manual_suspend')).toBe(true);
    // The CLI actually took the input: its commit ACK drains after suspendWorker
    // detached ds.worker, so the stale-message branch settles it.
    worker.emit('message', { type: 'turn_input_committed', turnId: WAKE_TURN });
    worker.emit('exit', 0, null);

    expect(retiredBeforeCliAcceptNotices(sessionReply, WAKE_TURN)).toEqual([]);
  });

  it('stays silent when a live commit ACK was observed even if the backlog clear never arrived', () => {
    const { worker, woken } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });
    // ACK observed while this worker is still the live generation.
    worker.emit('message', { type: 'turn_input_committed', turnId: WAKE_TURN });

    expect(suspendWorker(woken, 'manual_suspend')).toBe(true);
    worker.emit('exit', 0, null);

    expect(retiredBeforeCliAcceptNotices(sessionReply, WAKE_TURN)).toEqual([]);
  });

  it('leaves a worker crash to the existing crash handling', () => {
    const { worker } = overCapWithOnlyTheWokenSessionIdle();
    worker.emit('message', { type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    worker.emit('exit', 1, null);

    expect(retiredBeforeCliAcceptNotices(sessionReply, WAKE_TURN)).toEqual([]);
  });
});
