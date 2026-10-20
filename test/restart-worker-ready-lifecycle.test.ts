/**
 * Behavioural regression for the in-worker restart lifecycle fence.
 *
 * requestSessionRestart() clears ds.workerReady before asking the live worker
 * to respawn its CLI in place. The in-worker respawn never re-emits the
 * process-level `ready`, so the matching successful `restart_result` receipt
 * is the only edge that may release the fence. Otherwise fork / relay stay
 * blocked as `worker_busy` forever while the terminal already looks idle.
 *
 * Drives the real worker-pool IPC handler (__testOnly_setupWorkerHandlers +
 * fake worker EventEmitter), mirroring test/worker-ready-display-mode.test.ts.
 *
 * Run:  bun run vitest run test/restart-worker-ready-lifecycle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks (same surface as worker-ready-display-mode.test.ts) ─────────────

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    listChatPins: vi.fn(async () => undefined),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn((...args: any[]) => JSON.stringify({
    type: 'streaming',
    readUrl: args[2],
    status: args[5],
    localCliReady: args[15] === true,
    // Signature tail after the master merge: 15 localCliReady, 16 usage,
    // 17 runtimeDisplayName, 18 serviceTierBadge.
    serviceTierBadge: args[18],
  })),
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
  normalizeUsageDisplay: vi.fn(() => 'off'),
  getBotClient: vi.fn(() => ({ request: vi.fn() })),
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
  composeRowFromActive: vi.fn(() => ({ tokenUsage: undefined })),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenEnabled: vi.fn(() => true),
  isLocalCliOpenReady: vi.fn((ds: DaemonSession, opts?: { cliId?: string }) => {
    if (!ds.adoptedFrom && !ds.session.adoptedFrom && (ds.session.backendType === 'tmux' || ds.session.backendType === 'herdr')) {
      return true;
    }
    const cliId = opts?.cliId ?? ds.session.cliId;
    if (cliId === 'oh-my-pi') return true;
    return !!(ds.adoptedFrom?.sessionId ?? ds.session.adoptedFrom?.sessionId ?? ds.session.cliSessionId);
  }),
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

// ─── Imports under test ────────────────────────────────────────────────────

import {
  initWorkerPool,
  setActiveSessionsRegistry,
  requestSessionRestart,
  isSessionLifecycleInFlight,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function makeDs(): DaemonSession {
  return {
    session: {
      sessionId: 'sid-restart-fence',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Restart fence',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    workerReady: true,
    cliReady: true,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

/** Arm the real IPC handler and start a coordinated in-worker restart. */
function startRestart(): { ds: DaemonSession; worker: any; attemptId: string } {
  const ds = makeDs();
  const worker = ds.worker as any;
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  __testOnly_setupWorkerHandlers(ds, worker);
  const started = requestSessionRestart(ds, { source: 'slash', notify: vi.fn() });
  expect(started).toBeDefined();
  expect(started!.joined).toBe(false);
  // The physical restart went to the live worker in place …
  expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'restart', attemptId: started!.attemptId,
  }));
  // … and the lifecycle fence is down.
  expect(ds.workerReady).toBe(false);
  expect(isSessionLifecycleInFlight(ds)).toBe(true);
  return { ds, worker, attemptId: started!.attemptId };
}

function receipt(worker: any, attemptId: string, status: 'succeeded' | 'failed' | 'timed_out'): void {
  worker.emit('message', { type: 'restart_result', attemptId, status });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('in-worker restart lifecycle fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetRestartCoordinator();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_card'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    setActiveSessionsRegistry(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
    __testOnly_resetRestartCoordinator();
  });

  it('a matching succeeded receipt releases workerReady and the lifecycle fence', () => {
    const { ds, worker, attemptId } = startRestart();
    receipt(worker, attemptId, 'succeeded');
    expect(ds.workerReady).toBe(true);
    expect(isSessionLifecycleInFlight(ds)).toBe(false);
  });

  it('a failed receipt keeps the fence down, and a duplicate succeeded after it does not lift it', () => {
    const { ds, worker, attemptId } = startRestart();
    receipt(worker, attemptId, 'failed');
    expect(ds.workerReady).toBe(false);
    expect(isSessionLifecycleInFlight(ds)).toBe(true);

    receipt(worker, attemptId, 'succeeded');
    expect(ds.workerReady).toBe(false);
    expect(isSessionLifecycleInFlight(ds)).toBe(true);
  });

  it('a succeeded receipt for an unknown attemptId is ignored; the real receipt still releases', () => {
    const { ds, worker, attemptId } = startRestart();
    receipt(worker, `${attemptId}-bogus`, 'succeeded');
    expect(ds.workerReady).toBe(false);
    expect(isSessionLifecycleInFlight(ds)).toBe(true);

    receipt(worker, attemptId, 'succeeded');
    expect(ds.workerReady).toBe(true);
    expect(isSessionLifecycleInFlight(ds)).toBe(false);
  });

  it('a succeeded receipt arriving after the coordinator timed out does not release', () => {
    vi.useFakeTimers();
    const { ds, worker, attemptId } = startRestart();
    vi.advanceTimersByTime(40_001);
    receipt(worker, attemptId, 'succeeded');
    expect(ds.workerReady).toBe(false);
  });

  it('a succeeded receipt from a stale worker generation does not release', () => {
    const { ds, worker, attemptId } = startRestart();
    const replacement = makeFakeWorker();
    ds.worker = replacement;
    receipt(worker, attemptId, 'succeeded');
    expect(ds.workerReady).toBe(false);
    // The attempt is still open: the stale receipt did not settle it.
    expect(isSessionLifecycleInFlight(ds)).toBe(true);
  });
});
