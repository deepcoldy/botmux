/**
 * Verifies that the `case 'ready'` handler in worker-pool.ts sends
 * `set_display_mode` to the worker after POSTing a new streaming card.
 *
 * Regression test for: worker 重启走 POST 路径时未补发 set_display_mode，
 * 导致截图循环静默失效。
 *
 * Scenarios:
 *   1. POST path + displayMode='screenshot' → worker.send called
 *   2. POST path + displayMode='hidden' → worker.send NOT called
 *   3. PATCH path + displayMode='screenshot' → worker.send called (symmetry)
 *
 * Run:  pnpm vitest run test/worker-ready-display-mode.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const updateMessageMock = vi.fn(async () => {});

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
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

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
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

// ─── Imports under test ────────────────────────────────────────────────────

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

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

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-ready-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: makeFakeWorker(),
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
    streamCardNonce: undefined,
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
    ...overrides,
  } as DaemonSession;
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Worker ready: set_display_mode re-sync', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionReplyMock = vi.fn(async () => 'om_new_card');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('POST path sends set_display_mode when displayMode is screenshot', async () => {
    const fakeWorker = makeFakeWorker();
    // streamCardPending = true forces POST path (no existing card to PATCH)
    const ds = makeDs({
      displayMode: 'screenshot',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // sessionReply should have been called (POST new card)
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('POST path does NOT send set_display_mode when displayMode is hidden', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'hidden',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // worker.send should NOT be called with set_display_mode
    const sendCalls = fakeWorker.send.mock.calls;
    const displayModeCalls = sendCalls.filter(
      (args: any[]) => args[0]?.type === 'set_display_mode',
    );
    expect(displayModeCalls).toHaveLength(0);
  });

  it('PATCH path sends set_display_mode when displayMode is screenshot', async () => {
    const fakeWorker = makeFakeWorker();
    // Existing card + streamCardPending=false → PATCH path
    const ds = makeDs({
      displayMode: 'screenshot',
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      worker: fakeWorker,
    });

    updateMessageMock.mockResolvedValueOnce(undefined);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // updateMessage should have been called (PATCH existing card)
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    // sessionReply should NOT be called (didn't fall through to POST)
    expect(sessionReplyMock).not.toHaveBeenCalled();
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });
});
