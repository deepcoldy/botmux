/**
 * Integration test: Streaming card full event flow.
 *
 * Tests the complete lifecycle of Feishu streaming cards:
 *   event-dispatcher → card-handler → worker-pool (scheduleCardPatch)
 *
 * Unlike card-toggle.e2e.ts (unit-level, tests scheduleCardPatch in isolation),
 * this test exercises the full event flow with a FakeLarkClient that records
 * all API calls and allows controlled resolution of Promises.
 *
 * Scenarios covered:
 *   1. screen_update → new card POST → toggle → card PATCH (full flow)
 *   2. Concurrent screen_update + toggle → serialization queue
 *   3. Multi-turn: new card creation + old card freeze (nonce-based isolation)
 *   4. restart / close button actions
 *   5. Old card toggle ignored (card_nonce mismatch)
 *   6. get_write_link sends DM to operator
 *
 * Run:  pnpm vitest run test/card-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { FakeLarkClient } from './fixtures/fake-lark-client.js';
import {
  makeToggleEvent,
  makeRestartEvent,
  makeCloseEvent,
  makeGetWriteLinkEvent,
} from './fixtures/card-action-events.js';

// ─── Shared state ─────────────────────────────────────────────────────────

const fakeLark = new FakeLarkClient();
let sessionReplyResults: string[] = [];
let sessionReplyCallIndex = 0;

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => fakeLark.createMock('updateMessage')(...args),
  sendUserMessage: (...args: any[]) => fakeLark.createMock('sendUserMessage')(...args),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  // Mirrors the real buildStreamingCard signature:
  //   (sessionId, rootId, terminalUrl, title, screenContent, status,
  //    cliId?, displayMode='hidden', cardNonce?, imageKey?, adoptMode?, showTakeover?)
  // The legacy `streamExpanded` boolean has been replaced by `displayMode`
  // ('hidden' | 'screenshot'). Tests still parse `expanded` from the rendered
  // card body for back-compat — derive it from displayMode.
  buildStreamingCard: vi.fn(
    (
      _sid: string, _rid: string, _url: string, _title: string,
      content: string, status: string, _cliId: string,
      displayMode: 'hidden' | 'screenshot' = 'hidden',
      cardNonce?: string,
      _imageKey?: string,
      adoptMode?: boolean,
      showTakeover?: boolean,
    ) =>
      JSON.stringify({
        type: 'streaming',
        expanded: displayMode === 'screenshot',
        displayMode,
        content,
        status,
        cardNonce,
        adoptMode: !!adoptMode,
        showTakeover: !!showTakeover,
      }),
  ),
  buildSessionCard: vi.fn(
    (
      _sid: string, _rid: string, _url: string, _title: string,
      _cliId: string, showManageButtons?: boolean, adoptMode?: boolean,
    ) =>
      JSON.stringify({ type: 'session', url: _url, showManageButtons: !!showManageButtons, adoptMode: !!adoptMode }),
  ),
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
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  // card-handler now persists streaming-card state on every toggle so it
  // survives daemon restart; the integration tests don't care about disk
  // state, just that the call is satisfied.
  persistStreamCardState: vi.fn(),
  buildBridgeInputContent: vi.fn((s: string) => s),
  buildFollowUpContent: vi.fn((s: string) => s),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { scheduleCardPatch } from '../src/core/worker-pool.js';
import { killWorker, forkWorker } from '../src/core/worker-pool.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const APP_ID = 'app_test';
const ROOT_ID = 'om_root_001';
const NONCE_CURRENT = 'nonce_abc1';
const NONCE_OLD = 'nonce_old_xyz';

function makeDaemonSession(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'uuid-integ-test',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      title: 'Integration Test',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: { killed: false, send: vi.fn() } as any,
    workerPort: 8080,
    workerToken: 'tok_secret',
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    streamCardNonce: NONCE_CURRENT,
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
    ...overrides,
  };
}

function makeDeps(activeSessions: Map<string, DaemonSession>): CardHandlerDeps {
  sessionReplyCallIndex = 0;
  return {
    activeSessions,
    sessionReply: vi.fn(async () => {
      const id = sessionReplyResults[sessionReplyCallIndex] ?? `om_card_${sessionReplyCallIndex}`;
      sessionReplyCallIndex++;
      return id;
    }),
    lastRepoScan: new Map(),
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function parseCard(json: string): any {
  return JSON.parse(json);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Card integration: full event flow', () => {
  beforeEach(() => {
    fakeLark.reset();
    sessionReplyResults = [];
    vi.clearAllMocks();
  });

  // ── Scenario 1: screen_update → POST card → toggle → PATCH ────────────

  describe('Scenario 1: screen_update then toggle (full lifecycle)', () => {
    it('should POST new card on first screen_update, then PATCH on toggle', async () => {
      const CARD_ID = 'om_stream_card_1';
      const ds = makeDaemonSession({ streamCardId: CARD_ID });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Simulate: worker sends screen_update → daemon calls scheduleCardPatch
      const cardJson1 = buildStreamingCard(
        ds.session.sessionId, ROOT_ID, 'http://localhost:8080',
        'Test task', 'Hello world', 'working', 'claude-code', false, NONCE_CURRENT,
      );
      scheduleCardPatch(ds, cardJson1);
      await flush();

      // Should have sent one PATCH
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe(CARD_ID);
      const patchedCard = parseCard(fakeLark.patches[0].args[2]);
      expect(patchedCard.content).toBe('Hello world');
      expect(patchedCard.expanded).toBe(false);

      // Resolve the PATCH
      fakeLark.resolveCall('updateMessage', 0);
      await flush();
      expect(ds.cardPatchInFlight).toBe(false);

      // Now user clicks toggle on current card (with matching nonce)
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(2);
      const toggledCard = parseCard(fakeLark.patches[1].args[2]);
      expect(toggledCard.expanded).toBe(true);
    });
  });

  // ── Scenario 2: concurrent screen_update + toggle → serialization ─────

  describe('Scenario 2: concurrent screen_update + toggle', () => {
    it('should serialize: toggle queues behind in-flight screen_update PATCH', async () => {
      const CARD_ID = 'om_stream_card_2';
      const ds = makeDaemonSession({ streamCardId: CARD_ID, displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Step 1: screen_update sends a PATCH (in-flight)
      const screenCard = buildStreamingCard(
        ds.session.sessionId, ROOT_ID, 'http://localhost:8080',
        'Test task', 'processing...', 'working', 'claude-code', false, NONCE_CURRENT,
      );
      scheduleCardPatch(ds, screenCard);
      await flush();

      expect(fakeLark.patches).toHaveLength(1);
      expect(ds.cardPatchInFlight).toBe(true);

      // Step 2: while PATCH is in-flight, user clicks toggle
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      // Toggle should NOT have sent another PATCH — it should be queued
      expect(fakeLark.patches).toHaveLength(1);
      expect(ds.displayMode).toBe('screenshot');
      expect(ds.pendingCardJson).toBeTruthy();
      expect(parseCard(ds.pendingCardJson!).expanded).toBe(true);

      // Step 3: in-flight PATCH completes → queued toggle PATCH flushes
      fakeLark.resolveCall('updateMessage', 0);
      await flush();

      expect(fakeLark.patches).toHaveLength(2);
      expect(parseCard(fakeLark.patches[1].args[2]).expanded).toBe(true);
      expect(ds.pendingCardJson).toBeUndefined();

      // Step 4: second PATCH completes
      fakeLark.resolveCall('updateMessage', 1);
      await flush();
      expect(ds.cardPatchInFlight).toBe(false);
    });

    it('should apply latest-wins: multiple toggles while PATCH in-flight', async () => {
      const CARD_ID = 'om_stream_card_3';
      const ds = makeDaemonSession({ streamCardId: CARD_ID, displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // screen_update PATCH in-flight
      scheduleCardPatch(ds, buildStreamingCard(
        ds.session.sessionId, ROOT_ID, 'http://localhost:8080',
        'Test task', 'working...', 'working', 'claude-code', false, NONCE_CURRENT,
      ));
      await flush();
      expect(fakeLark.patches).toHaveLength(1);

      // Toggle 1: false → true (queued)
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('screenshot');

      // Toggle 2: true → false (overwrites queued)
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('hidden');

      // Toggle 3: false → true (overwrites again)
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('screenshot');

      // Still only 1 PATCH sent (the original screen_update)
      expect(fakeLark.patches).toHaveLength(1);
      // Pending should be the latest state (expanded=true)
      expect(parseCard(ds.pendingCardJson!).expanded).toBe(true);

      // Resolve original PATCH → only one queued PATCH flushes
      fakeLark.resolveCall('updateMessage', 0);
      await flush();

      expect(fakeLark.patches).toHaveLength(2);
      expect(parseCard(fakeLark.patches[1].args[2]).expanded).toBe(true);
    });
  });

  // ── Scenario 3: multi-turn card lifecycle (nonce-based isolation) ──────

  describe('Scenario 3: multi-turn card lifecycle', () => {
    it('toggle on old card (stale nonce) should be ignored, toggle on current card works', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_new_card',
        streamCardNonce: NONCE_CURRENT,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // User clicks toggle on OLD (frozen) card — carries stale nonce
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_OLD), deps, APP_ID);
      await flush();

      // Should NOT have toggled or sent any PATCH
      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(0);

      // User clicks toggle on current card — carries current nonce
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
    });

    it('new turn: old nonce is stale, new nonce distinguishes cards', async () => {
      const NONCE_TURN1 = 'nonce_turn1';
      const NONCE_TURN2 = 'nonce_turn2';

      const ds = makeDaemonSession({
        streamCardId: 'om_card_turn2',
        streamCardNonce: NONCE_TURN2,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Toggle with turn1 nonce → ignored
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_TURN1), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(0);

      // Toggle with turn2 nonce → works
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_TURN2), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
    });
  });

  // ── Scenario 4: restart / close actions ───────────────────────────────

  describe('Scenario 4: restart and close button actions', () => {
    it('restart with live worker should send restart IPC message', async () => {
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(workerSend).toHaveBeenCalledWith({ type: 'restart' });
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('重启'),
        undefined,
        APP_ID,
      );
    });

    it('restart without worker should re-fork', async () => {
      const ds = makeDaemonSession({ worker: null });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
    });

    it('close should kill worker and remove session', async () => {
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessions.has(sKey)).toBe(false);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('关闭'),
        undefined,
        APP_ID,
      );
    });
  });

  // ── Scenario 5: get_write_link DM ────────────────────────────────────

  describe('Scenario 5: get_write_link sends DM', () => {
    it('should send session card via DM to operator', async () => {
      const ds = makeDaemonSession({
        workerPort: 9090,
        workerToken: 'write_tok',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);
      await flush();

      expect(fakeLark.dms).toHaveLength(1);
      expect(fakeLark.dms[0].args[0]).toBe(APP_ID);
      expect(fakeLark.dms[0].args[1]).toBe('ou_user');
      const dmCard = parseCard(fakeLark.dms[0].args[2]);
      expect(dmCard.type).toBe('session');
    });

    it('should reply with warning when terminal not ready', async () => {
      const ds = makeDaemonSession({
        workerPort: null,
        workerToken: null,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);

      expect(fakeLark.dms).toHaveLength(0);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('尚未就绪'),
        undefined,
        APP_ID,
      );
    });
  });

  // ── Scenario 6: edge cases ────────────────────────────────────────────

  describe('Scenario 6: edge cases', () => {
    it('toggle without card_nonce should still work (backwards compat)', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_compat',
        streamCardNonce: NONCE_CURRENT,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // No nonce in event — should fall back to toggling current card
      await handleCardAction(makeToggleEvent(ROOT_ID, undefined), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      expect(parseCard(fakeLark.patches[0].args[2]).expanded).toBe(true);
    });

    it('toggle with no streamCardNonce on session should still work', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_no_nonce',
        streamCardNonce: undefined,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Even with a nonce in event, if session has no nonce → allow toggle
      await handleCardAction(makeToggleEvent(ROOT_ID, 'some_nonce'), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
    });

    it('toggle with no workerPort should toggle state but not PATCH', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_no_port',
        workerPort: null,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(0);
    });

    it('action on non-existent session should be a no-op', async () => {
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      await handleCardAction(makeToggleEvent('om_nonexistent', NONCE_CURRENT), deps, APP_ID);
      await handleCardAction(makeRestartEvent('om_nonexistent'), deps, APP_ID);
      await handleCardAction(makeCloseEvent('om_nonexistent'), deps, APP_ID);

      expect(fakeLark.patches).toHaveLength(0);
    });

    it('screen_update PATCH interleaved with toggle PATCH: correct final state', async () => {
      const CARD_ID = 'om_interleave';
      const ds = makeDaemonSession({ streamCardId: CARD_ID, displayMode: 'hidden' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // screen_update #1
      scheduleCardPatch(ds, buildStreamingCard(
        ds.session.sessionId, ROOT_ID, 'http://localhost:8080',
        'Test', 'line 1', 'working', 'claude-code', false, NONCE_CURRENT,
      ));
      await flush();
      expect(fakeLark.patches).toHaveLength(1);

      // screen_update #2 (queued)
      scheduleCardPatch(ds, buildStreamingCard(
        ds.session.sessionId, ROOT_ID, 'http://localhost:8080',
        'Test', 'line 2', 'working', 'claude-code', false, NONCE_CURRENT,
      ));
      await flush();

      // toggle (queued, overwrites screen_update #2)
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();
      expect(ds.displayMode).toBe('screenshot');

      // Still just 1 PATCH in-flight
      expect(fakeLark.patches).toHaveLength(1);

      // Resolve #1 → flushed PATCH should be the toggle (latest-wins)
      fakeLark.resolveCall('updateMessage', 0);
      await flush();

      expect(fakeLark.patches).toHaveLength(2);
      const flushedCard = parseCard(fakeLark.patches[1].args[2]);
      expect(flushedCard.expanded).toBe(true);

      // Resolve #2
      fakeLark.resolveCall('updateMessage', 1);
      await flush();
      expect(ds.cardPatchInFlight).toBe(false);
      expect(ds.pendingCardJson).toBeUndefined();
    });
  });

  // ── Scenario 7: adopt mode keeps the right buttons across rebuilds ────
  // Codex review of 59c9670: every card-handler path that re-renders the
  // streaming card must propagate adoptMode. Otherwise toggling /
  // refreshing / pressing a quick-action key on an adopt session would
  // silently rebuild the card with the default `❌ 关闭会话` button,
  // which would tear down the user's underlying CLI on click.
  describe('Scenario 7: adopt-mode card rebuild propagation', () => {
    function makeAdoptSession(overrides?: Partial<DaemonSession>): DaemonSession {
      const ds = makeDaemonSession({
        streamCardId: 'om_adopt_card',
        ...overrides,
      });
      ds.adoptedFrom = {
        tmuxTarget: '0:1.0',
        originalCliPid: 1234,
        sessionId: 'adopt-cli-uuid',
        cliId: 'claude-code',
        cwd: '/tmp/adopt',
        paneCols: 270,
        paneRows: 57,
      };
      return ds;
    }

    it('toggle on adopt session rebuilds card with adoptMode=true', async () => {
      const ds = makeAdoptSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Toggle returns the rebuilt card body (see card-handler.ts:337).
      const result = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      // The handler must propagate adoptMode so the rebuilt card keeps
      // the `⏏ 断开` button — `❌ 关闭会话` would tear down the user's CLI.
      expect(result).toBeDefined();
      expect((result as any).adoptMode).toBe(true);
    });

    it('term_action on adopt session returns a card with adoptMode=true', async () => {
      const ds = makeAdoptSession({ displayMode: 'screenshot' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const event = {
        token: 'tok',
        action: { tag: 'button', value: { action: 'term_action', root_id: ROOT_ID, session_id: ds.session.sessionId, key: 'enter' } },
        operator: { open_id: 'ou_user' },
        host: 'im_message_card_action',
      } as any;
      const result = await handleCardAction(event, deps, APP_ID);
      // term_action returns the freshly rebuilt card body — must carry adoptMode.
      expect(result).toBeDefined();
      expect((result as any).adoptMode).toBe(true);
    });

    it('refresh_screenshot on adopt session returns a card with adoptMode=true', async () => {
      const ds = makeAdoptSession({ displayMode: 'screenshot' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const event = {
        token: 'tok',
        action: { tag: 'button', value: { action: 'refresh_screenshot', root_id: ROOT_ID, session_id: ds.session.sessionId } },
        operator: { open_id: 'ou_user' },
        host: 'im_message_card_action',
      } as any;
      const result = await handleCardAction(event, deps, APP_ID);
      expect(result).toBeDefined();
      expect((result as any).adoptMode).toBe(true);
    });

    it('restart on adopt session is hard-rejected (does not kill user CLI)', async () => {
      const ds = makeAdoptSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);
      await flush();

      // worker.send must NOT have received a 'restart' IPC, and
      // forkWorker must NOT have been called — defense-in-depth against
      // a stale pre-fix card whose button still says "重启".
      expect((ds.worker as any).send).not.toHaveBeenCalledWith({ type: 'restart' });
      expect(forkWorker).not.toHaveBeenCalled();
      // sessionReply was used to surface the rejection message.
      expect(deps.sessionReply).toHaveBeenCalled();
    });
  });
});
