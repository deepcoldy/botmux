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
 *   4. silent recovery + displayMode='screenshot' → worker.send called without card IO
 *
 * Run:  pnpm vitest run test/worker-ready-display-mode.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const updateMessageMock = vi.fn(async () => {});
const deleteMessageMock = vi.fn(async () => {});
const pinMessageMock = vi.fn(async () => true);
const unpinMessageMock = vi.fn(async () => true);
const { loggerInfoMock } = vi.hoisted(() => ({ loggerInfoMock: vi.fn() }));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
    deleteMessage: (...args: any[]) => deleteMessageMock(...args),
    pinMessage: (...args: any[]) => pinMessageMock(...args),
    unpinMessage: (...args: any[]) => unpinMessageMock(...args),
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
  logger: { info: loggerInfoMock, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports under test ────────────────────────────────────────────────────

import {
  CARD_POSTING_SENTINEL,
  initWorkerPool,
  postTurnStartingCard,
  __testOnly_setupWorkerHandlers,
  __testOnly_waitForPinStreamingCardIdle,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';

const getBotMock = getBot as ReturnType<typeof vi.fn>;

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

async function primaryEffectsBarrier(): Promise<void> {
  await flush();
}

async function deferredAndIdleBarrier(): Promise<void> {
  await __testOnly_waitForPinStreamingCardIdle();
  await flush();
}

function activate(ds: DaemonSession): void {
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
}

function setupActiveWorkerHandlers(ds: DaemonSession, worker: any): void {
  activate(ds);
  __testOnly_setupWorkerHandlers(ds, worker);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Worker ready: set_display_mode re-sync', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;
  let closeSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pinMessageMock.mockResolvedValue(true);
    unpinMessageMock.mockResolvedValue(true);
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    sessionReplyMock = vi.fn(async () => 'om_new_card');
    closeSessionMock = vi.fn();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: closeSessionMock,
    });
    setActiveSessionsRegistry(new Map());
  });

  it('does not let a stale ready Pin continuation recall the successor frozen cards', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardPendingTurnId: 'om_turn_1',
      streamCardId: undefined,
      frozenCards: new Map([[
        'old', { messageId: 'om_frozen_predecessor', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'thread:om_root' },
      ]]),
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc', turnId: 'om_turn_1' });
    await primaryEffectsBarrier();
    expect(ds.streamCardId).toBe('om_new_card');
    expect(pinMessageMock).toHaveBeenCalledWith('app_test', 'om_new_card');
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_frozen_predecessor');

    // A successor wins while the older Pin is still in flight. Primary recall
    // already happened; the old continuation may only compensate its own Pin.
    ds.streamCardId = 'om_successor';
    resolvePin(true);
    await deferredAndIdleBarrier();

    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.frozenCards?.has('old')).toBe(false);
    expect(unpinMessageMock).toHaveBeenCalledWith('app_test', 'om_new_card');
  });

  it('does not let a stale persisted-card reuse recall or overwrite the successor', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardId: 'om_restored_card',
      streamCardPending: false,
      frozenCards: new Map([['old', {
        messageId: 'om_frozen_predecessor', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'thread:om_root',
      }]]),
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await primaryEffectsBarrier();
    expect(updateMessageMock).toHaveBeenCalledWith('app_test', 'om_restored_card', expect.any(String));
    expect(pinMessageMock).toHaveBeenCalledWith('app_test', 'om_restored_card');
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_frozen_predecessor');

    ds.streamCardId = 'om_successor';
    resolvePin(true);
    await deferredAndIdleBarrier();

    expect(ds.streamCardId).toBe('om_successor');
    expect(ds.frozenCards?.has('old')).toBe(false);
    expect(unpinMessageMock).toHaveBeenCalledWith('app_test', 'om_restored_card');
  });

  it('leaves a successor intact when a stale persisted-card restore PATCH rejects', async () => {
    let rejectRestore!: (error: Error) => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRestore = reject;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardId: 'om_restored_card',
      streamCardPending: false,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledWith('app_test', 'om_restored_card', expect.any(String));

    ds.streamCardId = 'om_successor';
    rejectRestore(new Error('restored card rejected'));
    await flush();
    await flush();

    expect(ds.streamCardId).toBe('om_successor');
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('schedules the successor after a turn-start Pin loses ownership', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const ds = makeDs({ worker: makeFakeWorker(), workerReady: true, streamCardPending: true, streamCardPendingTurnId: 'om_turn_old', streamCardId: undefined });
    activate(ds);
    const oldPost = postTurnStartingCard(ds, sessionReplyMock, 'om_turn_old');
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    await expect(oldPost).resolves.toBe(true);

    ds.streamCardTurnGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_successor';
    ds.streamCardId = undefined;
    await expect(postTurnStartingCard(ds, sessionReplyMock, 'om_turn_successor')).resolves.toBe(true);

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    resolvePin(true);
    await __testOnly_waitForPinStreamingCardIdle();
  });

  it('schedules the successor after a worker-ready Pin loses ownership', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, streamCardPending: true, streamCardPendingTurnId: 'om_turn_old', streamCardId: undefined });
    activate(ds);
    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc', turnId: 'om_turn_old' });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe('om_new_card');

    ds.streamCardTurnGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_successor';
    ds.streamCardId = undefined;
    await expect(postTurnStartingCard(ds, sessionReplyMock, 'om_turn_successor')).resolves.toBe(true);

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    resolvePin(true);
    await __testOnly_waitForPinStreamingCardIdle();
  });

  it('persists the exact shared Herdr target reported by the worker', () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'persistent_backend_target',
      target: {
        backendType: 'herdr',
        sessionName: 'work',
        agentName: 'botmux-sid-read',
      },
    });

    expect(ds.session.persistentBackendTarget).toEqual({
      backendType: 'herdr',
      sessionName: 'work',
      agentName: 'botmux-sid-read',
    });
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('patches a static Codex card when executor tier changes without a screen update', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      workerPort: 9999,
      streamCardId: 'om_static_card',
      streamCardPending: false,
    });
    ds.session.cliId = 'codex';

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'codex_service_tier',
      snapshot: {
        model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
      },
    });
    await flush();
    expect(ds.codexServiceTier?.nonDefault).toBe(true);
    expect(JSON.parse(updateMessageMock.mock.calls.at(-1)![2])).toMatchObject({ serviceTierBadge: '⚡ priority' });

    fakeWorker.emit('message', {
      type: 'codex_service_tier',
      snapshot: {
        model: 'gpt-5.6-sol', serviceTier: 'default', nonDefault: false,
      },
    });
    await flush();
    expect(ds.codexServiceTier?.nonDefault).toBe(false);
    expect(JSON.parse(updateMessageMock.mock.calls.at(-1)![2]).serviceTierBadge).toBeUndefined();
  });

  it('clears tier state at worker-generation setup and ignores stale-worker updates', async () => {
    const staleWorker = makeFakeWorker();
    const replacement = makeFakeWorker();
    const ds = makeDs({
      worker: staleWorker,
      workerPort: 9999,
      streamCardId: 'om_static_card',
      codexServiceTier: {
        model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
      },
    });
    ds.session.cliId = 'claude-code';

    setupActiveWorkerHandlers(ds, staleWorker);
    expect(ds.codexServiceTier).toBeUndefined();
    ds.worker = replacement;
    staleWorker.emit('message', {
      type: 'codex_service_tier',
      snapshot: {
        model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
      },
    });
    await flush();

    expect(ds.codexServiceTier).toBeUndefined();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('does not rewrite a frozen card when teardown clears the live tier', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      workerPort: 9999,
      streamCardId: 'om_frozen_card',
      streamCardNonce: 'nonce_frozen',
      parkedStreamCardNonce: 'nonce_frozen',
    });
    ds.session.cliId = 'codex';

    setupActiveWorkerHandlers(ds, fakeWorker);
    updateMessageMock.mockClear();
    fakeWorker.emit('message', { type: 'codex_service_tier', snapshot: null });
    await flush();

    expect(ds.codexServiceTier).toBeUndefined();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('does not retain a pending tier refresh when no live card exists', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, workerPort: null, streamCardId: undefined });
    ds.session.cliId = 'codex';

    setupActiveWorkerHandlers(ds, fakeWorker);
    ds.pendingCodexTierCardRefresh = true;
    fakeWorker.emit('message', {
      type: 'codex_service_tier',
      snapshot: {
        model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
      },
    });
    await flush();

    expect(ds.pendingCodexTierCardRefresh).toBeUndefined();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('POST path forwards ready.turnId to sessionReply for initial alias cards', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ streamCardPending: true, streamCardId: undefined, worker: fakeWorker });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'ready',
      port: 9999,
      token: 'tok_abc',
      viewToken: 'view_cap',
      turnId: 'om_turn_ready',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock.mock.calls[0][4]).toBe('om_turn_ready');
    expect(ds.workerViewToken).toBe('view_cap');
    expect(JSON.stringify(sessionReplyMock.mock.calls[0][1])).toContain('viewToken=view_cap');
    const logs = loggerInfoMock.mock.calls.flat().join('\n');
    expect(logs).toContain('viewToken=[redacted]');
    expect(logs).not.toContain('view_cap');
  });

  it('ready POST keeps the dispatch-time topic when currentReplyTarget changes while awaiting Lark', async () => {
    let resolvePost!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePost = resolve;
    }));
    const now = new Date().toISOString();
    const targetA = { rootMessageId: 'om_topic_a', turnId: 'om_turn_a', updatedAt: now };
    const targetB = { rootMessageId: 'om_topic_b', turnId: 'om_turn_b', updatedAt: now };
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      scope: 'chat',
      currentReplyTarget: targetA,
      session: {
        ...makeDs().session,
        scope: 'chat',
        currentReplyTarget: targetA,
        replyTargets: { om_turn_a: targetA, om_turn_b: targetB },
      },
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(sessionReplyMock.mock.calls[0][4]).toBe('om_turn_a');
    ds.currentReplyTarget = targetB;
    ds.session.currentReplyTarget = targetB;
    resolvePost('om_new_card');
    await flush();

    expect(ds.streamCardReplyTargetKey).toBe('thread:om_topic_a');
  });

  it('screen_update POST keeps the dispatch-time topic when currentReplyTarget changes while awaiting Lark', async () => {
    let resolvePost!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePost = resolve;
    }));
    const now = new Date().toISOString();
    const targetA = { rootMessageId: 'om_topic_a', turnId: 'om_turn_a', updatedAt: now };
    const targetB = { rootMessageId: 'om_topic_b', turnId: 'om_turn_b', updatedAt: now };
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      scope: 'chat',
      currentReplyTarget: targetA,
      session: {
        ...makeDs().session,
        scope: 'chat',
        currentReplyTarget: targetA,
        replyTargets: { om_turn_a: targetA, om_turn_b: targetB },
      },
      streamCardPending: true,
      streamCardId: undefined,
      workerReady: true,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'screen_update',
      content: 'working in topic A',
      status: 'working',
    });
    await flush();

    expect(sessionReplyMock.mock.calls[0][4]).toBe('om_turn_a');
    ds.currentReplyTarget = targetB;
    ds.session.currentReplyTarget = targetB;
    resolvePost('om_new_card');
    await flush();

    expect(ds.streamCardReplyTargetKey).toBe('thread:om_topic_a');
  });

  it('screen_update POST discards stale results once remote retirement starts waiting', async () => {
    let resolvePost!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePost = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardId: undefined,
      workerReady: true,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'screen_update', content: 'working', status: 'working' });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    ds.remoteCloseState = { phase: 'preparing', requestId: 'close-screen-update' } as any;
    resolvePost('om_retired_screen_card');
    await flush();
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_retired_screen_card');
    expect(pinMessageMock).not.toHaveBeenCalledWith('app_test', 'om_retired_screen_card');
  });

  it('leaves a successor card intact when a stale screen-update POST rejects', async () => {
    let rejectPost!: (error: Error) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
      rejectPost = reject;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardId: undefined,
      workerReady: true,
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'screen_update', content: 'first', status: 'working' });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    ds.streamCardId = 'om_successor';
    rejectPost(new Error('stale post rejected'));
    await flush();
    await flush();

    expect(ds.streamCardId).toBe('om_successor');
  });

  it('schedules the successor after a screen-update Pin loses ownership', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, workerReady: true, streamCardPending: true, streamCardPendingTurnId: 'om_turn_old', streamCardId: undefined });
    activate(ds);
    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'screen_update', content: 'old', status: 'working', turnId: 'om_turn_old' });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe('om_new_card');

    ds.streamCardTurnGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_successor';
    ds.streamCardId = undefined;
    await expect(postTurnStartingCard(ds, sessionReplyMock, 'om_turn_successor')).resolves.toBe(true);

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    resolvePin(true);
    await __testOnly_waitForPinStreamingCardIdle();
  });

  it('treats port=0 as ready without Web Terminal and keeps screen/screenshot state flowing', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      session: { ...makeDs().session, backendType: 'zmx' },
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
      displayMode: 'screenshot',
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 0, token: 'unused', viewToken: 'unused-view' });
    await flush();

    expect(ds.workerReady).toBe(true);
    expect(ds.workerPort).toBeNull();
    expect(ds.workerToken).toBeNull();
    expect(ds.workerViewToken).toBeNull();
    expect(ds.session.webPort).toBeUndefined();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionReplyMock.mock.calls[0][1]).readUrl).toBe('');

    fakeWorker.emit('message', {
      type: 'screen_update',
      content: 'plain zmx history',
      status: 'idle',
    });
    fakeWorker.emit('message', {
      type: 'screenshot_uploaded',
      imageKey: 'img_zmx_history',
      status: 'idle',
    });
    await flush();

    expect(ds.lastScreenContent).toBe('plain zmx history');
    expect(ds.lastScreenStatus).toBe('idle');
    expect(ds.currentImageKey).toBe('img_zmx_history');
  });

  it('ignores every message from a replaced worker generation', async () => {
    const staleWorker = makeFakeWorker();
    const currentWorker = makeFakeWorker();
    const ds = makeDs({
      worker: currentWorker,
      workerReady: false,
      workerPort: null,
      lastScreenContent: 'current generation',
      lastScreenStatus: 'working',
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, staleWorker);
    staleWorker.emit('message', { type: 'ready', port: 9999, token: 'stale-token' });
    staleWorker.emit('message', {
      type: 'screen_update',
      content: 'stale generation',
      status: 'idle',
    });
    await flush();

    expect(ds.workerReady).toBe(false);
    expect(ds.workerPort).toBeNull();
    expect(ds.workerToken).toBeNull();
    expect(ds.lastScreenContent).toBe('current generation');
    expect(ds.lastScreenStatus).toBe('working');
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('doc-native session never posts a streaming card to the virtual doc: chat id', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      scope: 'chat',
      chatId: 'doc:doc_token_123',
      session: {
        ...makeDs().session,
        chatId: 'doc:doc_token_123',
        rootMessageId: 'doc:doc_token_123',
      },
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_doc' });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('doc-native session never posts a TUI prompt card to the virtual doc: chat id', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      scope: 'chat',
      chatId: 'doc:doc_token_123',
      session: {
        ...makeDs().session,
        scope: 'chat',
        chatId: 'doc:doc_token_123',
        rootMessageId: 'doc:doc_token_123',
      },
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve command?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
      turnId: 'turn-doc',
    });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.tuiPromptCardId).toBeUndefined();
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
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // sessionReply should have been called (POST new card)
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('ready POST discards stale results once remote retirement starts waiting', async () => {
    let resolvePost!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePost = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc', turnId: 'om_turn_ready' });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    ds.remoteCloseState = { phase: 'preparing', requestId: 'close-ready' } as any;
    resolvePost('om_retired_ready_card');
    await flush();
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_retired_ready_card');
    expect(pinMessageMock).not.toHaveBeenCalledWith('app_test', 'om_retired_ready_card');
  });

  it('POST path does NOT send set_display_mode when displayMode is hidden', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'hidden',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
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

  it('preserves worker and pending Codex FIFO when the root is withdrawn during ready POST', async () => {
    sessionReplyMock.mockRejectedValueOnce(new MessageWithdrawnError('om_root'));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-pending',
      turnId: 'turn-pending',
      state: 'prepared',
      content: 'pending',
    }];

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'ready', port: 9999, token: 'tok_abc', turnId: 'turn-pending',
    });
    await flush();

    expect(closeSessionMock).not.toHaveBeenCalled();
    expect(fakeWorker.kill).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger).toHaveLength(1);
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

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // updateMessage should have been called (PATCH existing card)
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ status: 'working' });
    // sessionReply should NOT be called (didn't fall through to POST)
    expect(sessionReplyMock).not.toHaveBeenCalled();
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('silent recovery restores screenshot mode without touching the streaming card', async () => {
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePin = resolve; }));
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', pinStreamingCard: true },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'screenshot',
      suppressRecoveryCard: true,
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await primaryEffectsBarrier();

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(pinMessageMock).toHaveBeenCalledWith('app_test', 'om_existing_card');
    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'set_display_mode',
      mode: 'screenshot',
    });

    resolvePin(true);
    await deferredAndIdleBarrier();
  });

  it('sentinel early-break (in-flight card POST) still sends set_display_mode', async () => {
    // The mojo-shape race: a headless backend reaches prompt-ready synchronously
    // on spawn, so a screen_update wins the card POST and `ready` finds
    // CARD_POSTING_SENTINEL already set. The old implementation broke out of the
    // handler right there and the fresh worker stayed displayMode='hidden'
    // forever ("waiting for first screenshot…"). Note: we only assert the
    // worker got the mode — the first screenshot_uploaded may still be dropped
    // by the streamCardPending gate; the next 10s cycle delivers it.
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'screenshot',
      streamCardPending: false,
      streamCardId: CARD_POSTING_SENTINEL,
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // No duplicate card POST while the sentinel is held.
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('managed/silent-suppressed ready (apiOnly transport) still sends set_display_mode', async () => {
    // apiOnly makes auxUiSuppressedFor() return true — the "worker exists, no
    // card will ever be posted" shape. The mode re-sync must not be tied to
    // card delivery. Implementation is restored in finally: clearAllMocks()
    // does not undo a leaked mockImplementation for later tests.
    const originalGetBot = getBotMock.getMockImplementation();
    getBotMock.mockImplementation((() => ({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', apiOnly: true },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    })) as any);
    try {
      const fakeWorker = makeFakeWorker();
      const ds = makeDs({
        displayMode: 'screenshot',
        streamCardPending: false,
        streamCardId: undefined,
        worker: fakeWorker,
      });

      setupActiveWorkerHandlers(ds, fakeWorker);
      fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
      await flush();

      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(fakeWorker.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
      );
    } finally {
      getBotMock.mockImplementation(originalGetBot as any);
    }
  });

  it('streamingCardDisabled ready still sends set_display_mode', async () => {
    const originalGetBot = getBotMock.getMockImplementation();
    getBotMock.mockImplementation((() => ({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', disableStreamingCard: true },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    })) as any);
    try {
      const fakeWorker = makeFakeWorker();
      const ds = makeDs({
        displayMode: 'screenshot',
        streamCardPending: false,
        streamCardId: undefined,
        worker: fakeWorker,
      });

      setupActiveWorkerHandlers(ds, fakeWorker);
      fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
      await flush();

      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(fakeWorker.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
      );
    } finally {
      getBotMock.mockImplementation(originalGetBot as any);
    }
  });

  it('suppressed managed turn screenshot never lands in currentImageKey', async () => {
    // With the early re-sync, a worker can be uploading during a managed/silent
    // turn — that frame must not become the next visible card's image.
    const originalGetBot = getBotMock.getMockImplementation();
    getBotMock.mockImplementation((() => ({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', apiOnly: true },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    })) as any);
    try {
      const fakeWorker = makeFakeWorker();
      const ds = makeDs({
        displayMode: 'screenshot',
        streamCardPending: false,
        streamCardId: 'om_visible_card',
        worker: fakeWorker,
      });

      setupActiveWorkerHandlers(ds, fakeWorker);
      fakeWorker.emit('message', {
        type: 'screenshot_uploaded',
        imageKey: 'img_managed_frame',
        status: 'working',
        turnId: 'turn-managed',
      });
      await flush();

      expect(ds.currentImageKey).toBeUndefined();
      expect(updateMessageMock).not.toHaveBeenCalled();
    } finally {
      getBotMock.mockImplementation(originalGetBot as any);
    }
  });

  it('re-applies readiness when cli_session_id races a restored-card PATCH', async () => {
    let resolveRestorePatch!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRestorePatch = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: false });

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(updateMessageMock.mock.calls[1][2])).toMatchObject({ localCliReady: true });

    resolveRestorePatch();
    await flush();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(updateMessageMock.mock.calls.at(-1)![2])).toMatchObject({ localCliReady: true });
  });

  it('does not require cli_session_id for mode-aware managed tmux local attach readiness', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    ds.session.cliId = 'gemini' as any;
    ds.session.backendType = 'tmux';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  // Regression: a re-fork that happens while streamCardPending is true (new turn
  // + worker had exited, e.g. resume) used to POST the "starting" card via the
  // ready path but leave streamCardPending=true. The next screen_update then took
  // the new-card POST branch and emitted a SECOND card ("working"), orphaning the
  // "starting" card (never frozen → recallFrozenCards can't withdraw it). The
  // ready POST path must clear streamCardPending so subsequent screen_updates
  // PATCH this card in place instead.
  it('POST path clears streamCardPending so the next screen_update PATCHes (no duplicate card)', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'hidden',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // POSTed exactly one card and committed its id.
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe('om_new_card');
    // Flag cleared → a later screen_update will PATCH, not POST a 2nd card.
    expect(ds.streamCardPending).toBe(false);
  });

  it('ready POST starts a pending turn busy and reconciles a working update received in flight', async () => {
    let resolvePost!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePost = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      lastScreenStatus: 'idle',
      streamCardPending: true,
      streamCardPendingTurnId: 'om_turn_1',
      streamCardId: undefined,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'ready', port: 9999, token: 'tok_abc', turnId: 'om_turn_1',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionReplyMock.mock.calls[0][1])).toMatchObject({ status: 'starting' });

    fakeWorker.emit('message', {
      type: 'screen_update',
      content: 'working after cold resume',
      status: 'working',
      turnId: 'om_turn_1',
    });
    await flush();
    expect(updateMessageMock).not.toHaveBeenCalled();

    resolvePost('om_new_card');
    await flush();
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe('om_new_card');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_new_card');
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ status: 'working' });
  });

  it('ready POST without a pending new turn preserves the last live status', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      lastScreenStatus: 'idle',
      streamCardPending: false,
      streamCardId: undefined,
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionReplyMock.mock.calls[0][1])).toMatchObject({ status: 'idle' });
  });

  it('does not let an older ready POST consume a newer turn pending state', async () => {
    let resolveFirst!: (messageId: string) => void;
    let resolveSecond!: (messageId: string) => void;
    sessionReplyMock
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveSecond = resolve; }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      streamCardPending: true,
      streamCardId: undefined,
      streamCardTurnGeneration: 1,
      streamCardPendingTurnId: 'om_turn_1',
      worker: fakeWorker,
    });
    activate(ds);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'ready', port: 9999, token: 'tok_abc', turnId: 'om_turn_1',
    });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    fakeWorker.emit('message', {
      type: 'screen_update',
      content: 'older turn working while its card posts',
      status: 'working',
      turnId: 'om_turn_1',
    });
    await flush();

    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 2;
    ds.streamCardPendingTurnId = 'om_turn_2';
    ds.currentTurnTitle = 'newer turn';
    resolveFirst('om_older_card');
    await flush();
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    expect(sessionReplyMock.mock.calls[1][4]).toBe('om_turn_2');
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);
    expect(ds.streamCardPending).toBe(true);
    expect(updateMessageMock).not.toHaveBeenCalled();

    resolveSecond('om_newer_card');
    await flush();
    await flush();

    expect(ds.streamCardId).toBe('om_newer_card');
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
  });

  it('patches the active card when cli_session_id makes local resume ready', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      workerPort: 9999,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    activate(ds);
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';
    ds.adoptedFrom = { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/tmp' };
    ds.session.adoptedFrom = { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/tmp' };

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();

    expect(ds.session.cliSessionId).toBe('trae-native-ready');
    expect(ds.adoptedFrom.sessionId).toBe('trae-native-ready');
    expect(ds.session.adoptedFrom.sessionId).toBe('trae-native-ready');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_existing_card');
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  it('defers the readiness patch until an in-flight card POST has a message id', async () => {
    let resolveReply!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveReply = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: true,
      streamCardId: undefined,
      workingDir: '/tmp',
    });
    activate(ds);
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    expect(ds.pendingLocalCliButtonRefresh).toBe(true);
    expect(updateMessageMock).not.toHaveBeenCalled();

    resolveReply('om_new_card');
    await flush();
    await flush();

    expect(ds.streamCardId).toBe('om_new_card');
    expect(ds.pendingLocalCliButtonRefresh).toBeUndefined();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_new_card');
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  it('keeps a delivered fallback card/session alive when its readiness patch fails', async () => {
    let resolveFallbackReply!: (messageId: string) => void;
    sessionReplyMock
      .mockRejectedValueOnce(new Error('streaming POST failed'))
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveFallbackReply = resolve;
      }));
    updateMessageMock.mockRejectedValueOnce(new Error('fallback PATCH failed'));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, workingDir: '/tmp' });
    activate(ds);
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(2);

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    resolveFallbackReply('om_fallback_card');
    await flush();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_fallback_card',
      expect.any(String),
    );
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('prompt_ready sends a pending raw slash command once', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship the onboarding flow',
    } as Partial<DaemonSession>);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship the onboarding flow',
    });
    expect(ds.pendingRawInput).toBeUndefined();

    fakeWorker.send.mockClear();
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'raw_input' }),
    );
  });

  it('replays a restored raw opening with its durable token and releases only on the matching ACK', async () => {
    const submitted = vi.fn(async () => true);
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: closeSessionMock,
      onQueuedActivationSubmitted: submitted,
    });
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal RESTORED_RAW_N',
      initialStartPending: true,
    } as Partial<DaemonSession>);
    Object.assign(ds.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'raw-activation-token',
      queuedActivationTurnId: 'turn-raw-n',
      pendingRepoSetup: {
        mode: 'picker', prompt: '', rawInput: '/goal RESTORED_RAW_N', turnId: 'turn-raw-n',
      },
    });

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal RESTORED_RAW_N',
      queuedActivationToken: 'raw-activation-token',
      turnId: 'turn-raw-n',
    });
    expect(submitted).not.toHaveBeenCalled();

    fakeWorker.emit('message', {
      type: 'queued_activation_submitted',
      sessionId: ds.session.sessionId,
      activationToken: 'raw-activation-token',
    });
    await flush();
    expect(submitted).toHaveBeenCalledWith(ds, 'raw-activation-token');
  });

  it('prompt_ready bundles the buffered follow-up ONTO the raw_input IPC (single atomic message)', async () => {
    // Two separate IPCs would race inside the worker: its async message
    // handlers don't serialize, and raw_input awaits 200ms between sendText
    // and Enter — a separate `message` IPC could write into that window. The
    // follow-up must therefore ride on the raw_input message itself.
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship the onboarding flow',
      pendingRawTurnId: 'om_goal_turn',
      pendingFollowUpInput: {
        userPrompt: '另外帮我顺手看下 CI',
        cliInput: '<user_message>另外帮我顺手看下 CI</user_message>',
        turnId: 'om_followup_turn',
      },
    } as Partial<DaemonSession>);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    // Exactly ONE outbound IPC carrying both payloads — never a separate
    // `message` IPC that could race the raw_input handler.
    expect(fakeWorker.send).toHaveBeenCalledTimes(1);
    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship the onboarding flow',
      turnId: 'om_goal_turn',
      followUpContent: '<user_message>另外帮我顺手看下 CI</user_message>',
      followUpTurnId: 'om_followup_turn',
    });
    expect(ds.pendingRawInput).toBeUndefined();
    expect(ds.pendingRawTurnId).toBeUndefined();
    expect(ds.pendingFollowUpInput).toBeUndefined();

    fakeWorker.send.mockClear();
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(fakeWorker.send).not.toHaveBeenCalled();
  });

  it('prompt_ready preserves a clean sidecar whose gate was frozen on when staged', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship',
      pendingFollowUpInput: {
        userPrompt: 'clean',
        cliInput: '<user_message>legacy</user_message>',
        codexAppInput: { text: 'clean' },
        codexAppInputGateFrozen: true,
      },
    } as Partial<DaemonSession>);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship',
      followUpContent: '<user_message>legacy</user_message>',
      followUpCodexAppInput: { text: 'clean' },
    });
  });

  it('prompt_ready keeps a staged-off follow-up legacy even if config is now on', async () => {
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex-app', codexAppCleanInput: true },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship',
      pendingFollowUpInput: {
        userPrompt: 'legacy',
        cliInput: '<user_message>legacy</user_message>',
        codexAppInputGateFrozen: true,
      },
    } as Partial<DaemonSession>);
    ds.session.cliId = 'codex-app' as any;

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship',
      followUpContent: '<user_message>legacy</user_message>',
    });
  });

  it('prompt_ready without pending raw input never emits the buffered follow-up alone', async () => {
    const fakeWorker = makeFakeWorker();
    // Follow-up input only exists alongside pendingRawInput (built at the same
    // fork site); if state drifts, it must not fire without the raw command.
    const ds = makeDs({
      worker: fakeWorker,
      pendingFollowUpInput: { userPrompt: 'x', cliInput: '<user_message>x</user_message>' },
    } as Partial<DaemonSession>);

    setupActiveWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(fakeWorker.send).not.toHaveBeenCalled();
  });
});
