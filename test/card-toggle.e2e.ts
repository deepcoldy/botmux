/**
 * E2E test: Streaming card toggle_stream button behavior.
 *
 * Reproduces two bugs:
 * 1. Clicking toggle on a frozen OLD card affects the LATEST card
 * 2. Clicking toggle on the latest card "flashes then reverts" due to
 *    concurrent PATCHes — screen_update and toggle send simultaneously,
 *    delivery order at Feishu server is unpredictable.
 *
 * The correct fix is a PATCH serialization queue:
 *   - Only one PATCH in-flight at a time
 *   - New PATCHes queue behind the in-flight one (latest wins)
 *   - When in-flight completes, the queued PATCH fires
 *
 * Run:  pnpm vitest run test/card-toggle.e2e.ts
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ─── Controllable updateMessage mock ─────────────────────────────────────────

interface PatchCall {
  larkAppId: string;
  messageId: string;
  cardJson: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

const patchCalls: PatchCall[] = [];

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn((_appId: string, _msgId: string, _json: string) => {
    return new Promise<void>((resolve, reject) => {
      patchCalls.push({ larkAppId: _appId, messageId: _msgId, cardJson: _json, resolve, reject });
    });
  }),
  sendUserMessage: vi.fn(),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  // 8th positional arg is now `displayMode: 'hidden' | 'screenshot'` (4ed74e3
  // migrated cards from `expanded:boolean` to a tri-mode enum). The mock
  // surfaces it as `displayMode` so assertions can inspect the queued/sent
  // PATCH payloads.
  buildStreamingCard: vi.fn(
    (_sid: string, _rid: string, _url: string, _title: string, _content: string, _status: string, _cliId: string, displayMode?: string) =>
      JSON.stringify({ displayMode: displayMode ?? 'hidden', content: _content, status: _status }),
  ),
  buildSessionCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...orig,
    forkWorker: vi.fn(),
    killWorker: vi.fn(),
    initWorkerPool: vi.fn(),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  ensureSessionWhiteboard: vi.fn(),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  getAvailableBots: vi.fn(() => []),
  // card-handler's toggle path calls persistStreamCardState after flipping
  // displayMode — without a stub here the test crashes with "No export …"
  // before exercising the PATCH serialization we're actually testing.
  persistStreamCardState: vi.fn(),
  rememberLastCliInput: vi.fn((ds: any, userPrompt: string, cliInput: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = cliInput;
  }),
  resumeSession: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2, warn: 3 },
}));

// ─── Imports & helpers ───────────────────────────────────────────────────────

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

const APP_ID = 'app_test';
const ROOT_ID = 'om_root_111';
const NONCE_OLD = 'nonce_old_frozen';
const NONCE_LATEST = 'nonce_latest';

function makeDaemonSession(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'uuid-test',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      title: 'Test',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: { killed: false, send: vi.fn() } as any,
    workerPort: 8080,
    workerToken: 'tok',
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    streamCardId: 'om_card_latest',
    streamCardNonce: NONCE_LATEST,
    displayMode: 'hidden',
    lastScreenContent: 'some terminal output',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
    ...overrides,
  };
}

function makeToggleAction(cardNonce?: string) {
  return {
    action: { value: { action: 'toggle_stream', root_id: ROOT_ID, ...(cardNonce ? { card_nonce: cardNonce } : {}) } },
    operator: { open_id: 'ou_user' },
  };
}

function makeDeps(activeSessions: Map<string, DaemonSession>): CardHandlerDeps {
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'om_new_card'),
    lastRepoScan: new Map(),
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function parseDisplayMode(cardJson: string): string {
  return JSON.parse(cardJson).displayMode;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Streaming card toggle_stream', () => {
  beforeEach(() => {
    patchCalls.length = 0;
    vi.clearAllMocks();
  });

  // ── Bug 1: Old card toggle should NOT affect latest card ──────────────────

  describe('Bug 1: clicking toggle on OLD frozen card', () => {
    it('self-heals live displayMode on a stale-nonce click, but queues no PATCH without a clicked message id', async () => {
      const ds = makeDaemonSession({ displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      await handleCardAction(makeToggleAction(NONCE_OLD), makeDeps(sessions), APP_ID);

      // A stale-nonce click migrates the live session's displayMode and notifies
      // the worker (the self-heal added in #19; see card-integration Scenario 3).
      // The makeToggleAction event carries no clicked message id, so there is no
      // card to PATCH — the live card's PATCH queue stays empty.
      expect(ds.displayMode).toBe('screenshot');
      expect(patchCalls).toHaveLength(0);
    });

    it('should toggle when card_nonce matches streamCardNonce (current card)', async () => {
      const ds = makeDaemonSession({ displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);

      expect(ds.displayMode).toBe('screenshot');
      expect(patchCalls).toHaveLength(1);
      expect(parseDisplayMode(patchCalls[0].cardJson)).toBe('screenshot');
    });

    it('should toggle when card_nonce is absent (backwards compat)', async () => {
      const ds = makeDaemonSession({ displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      await handleCardAction(makeToggleAction(undefined), makeDeps(sessions), APP_ID);
      expect(ds.displayMode).toBe('screenshot');
    });
  });

  // ── Bug 2: Concurrent PATCHes — serialization required ───────────────────

  describe('Bug 2: PATCH serialization prevents race conditions', () => {
    it('toggle while screen_update PATCH in-flight: at most ONE PATCH in-flight at a time', async () => {
      // Scenario: screen_update PATCH is in-flight. User clicks toggle.
      // Correct behavior: toggle should NOT fire a second concurrent PATCH.
      // It should queue and fire AFTER the in-flight one completes.

      const ds = makeDaemonSession({ displayMode: 'hidden', cardPatchInFlight: true });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      // Simulate: screen_update already sent a PATCH (cardPatchInFlight=true)
      // Now user clicks toggle
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();

      // displayMode should be flipped to 'screenshot' immediately
      expect(ds.displayMode).toBe('screenshot');

      // But there should NOT be a new PATCH call while in-flight is true.
      // Instead, the card JSON should be queued on ds.pendingCardJson.
      // When the in-flight PATCH completes, the pending one flushes.
      expect(ds.pendingCardJson, 'toggle should queue a pending PATCH, not send immediately').toBeTruthy();
      const pendingMode = parseDisplayMode(ds.pendingCardJson!);
      expect(pendingMode, 'queued PATCH should reflect screenshot mode').toBe('screenshot');
    });

    it('queued PATCH flushes after in-flight completes', async () => {
      const ds = makeDaemonSession({ displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      // Step 1: First PATCH (simulating screen_update)
      // We trigger toggle first to get a PATCH in-flight
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();
      expect(patchCalls).toHaveLength(1);
      expect(ds.cardPatchInFlight).toBe(true);

      // Step 2: Second toggle while first is in-flight — flips back to 'hidden'
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();
      expect(ds.displayMode).toBe('hidden');

      // Should NOT have sent a second PATCH (queue instead)
      expect(patchCalls, 'should not send second PATCH while first is in-flight').toHaveLength(1);
      expect(ds.pendingCardJson).toBeTruthy();
      expect(parseDisplayMode(ds.pendingCardJson!)).toBe('hidden');

      // Step 3: First PATCH completes → queued PATCH flushes
      patchCalls[0].resolve();
      await flush();

      expect(patchCalls, 'queued PATCH should have flushed').toHaveLength(2);
      expect(parseDisplayMode(patchCalls[1].cardJson)).toBe('hidden');
      expect(ds.pendingCardJson, 'pending should be cleared after flush').toBeUndefined();

      // Step 4: Second PATCH completes
      patchCalls[1].resolve();
      await flush();
      expect(ds.cardPatchInFlight).toBe(false);
    });

    it('multiple queued PATCHes: only the LATEST is flushed (latest-wins)', async () => {
      const ds = makeDaemonSession({ displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);

      // Toggle 1: hidden→screenshot → sends PATCH (in-flight)
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();
      expect(patchCalls).toHaveLength(1);

      // Toggle 2: screenshot→hidden → queued (PATCH in-flight)
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();

      // Toggle 3: hidden→screenshot → replaces queued
      await handleCardAction(makeToggleAction(NONCE_LATEST), makeDeps(sessions), APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(patchCalls, 'only one PATCH sent').toHaveLength(1);
      expect(parseDisplayMode(ds.pendingCardJson!), 'latest queued should be screenshot').toBe('screenshot');

      // Resolve first → only ONE queued PATCH flushes (the latest)
      patchCalls[0].resolve();
      await flush();

      expect(patchCalls).toHaveLength(2);
      expect(parseDisplayMode(patchCalls[1].cardJson), 'flushed PATCH should be the latest state').toBe('screenshot');
    });
  });
});
