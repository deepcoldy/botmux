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
 *   6. get_write_link delivers the write-link card privately (ephemeral in a
 *      group, DM fallback in p2p)
 *
 * Run:  pnpm vitest run test/card-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { FakeLarkClient } from './fixtures/fake-lark-client.js';
import {
  makeToggleEvent,
  makeRestartEvent,
  makeCloseEvent,
  makeResumeEvent,
  makeGetWriteLinkEvent,
  makeRetryLastTaskEvent,
} from './fixtures/card-action-events.js';

// ─── Shared state ─────────────────────────────────────────────────────────

const fakeLark = new FakeLarkClient();
let sessionReplyResults: string[] = [];
let sessionReplyCallIndex = 0;

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => fakeLark.createMock('updateMessage')(...args),
  sendUserMessage: (...args: any[]) => fakeLark.createMock('sendUserMessage')(...args),
  // Resolves immediately (no manual orchestration) — the private-close path just
  // awaits it; tests assert on the recorded args.
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
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
  buildSessionClosedCard: vi.fn(
    (sid: string, rid: string, title: string, cliId?: string, workingDir?: string) =>
      JSON.stringify({ type: 'closed', sid, rid, title, cliId, workingDir }),
  ),
  buildTuiPromptCard: vi.fn(() => JSON.stringify({ type: 'tui-prompt' })),
  buildTuiPromptProcessingCard: vi.fn(() => JSON.stringify({ type: 'tui-processing' })),
  buildTuiPromptResolvedCard: vi.fn(() => JSON.stringify({ type: 'tui-resolved' })),
  truncateContent: vi.fn((s: string) => s),
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
  // Resume action's permission gate falls back to a store lookup when the
  // session is no longer in activeSessions. Tests override the implementation
  // per-scenario via vi.mocked(getSession).mockReturnValueOnce(...).
  getSession: vi.fn(),
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
  rememberLastCliInput: vi.fn((ds: any, userPrompt: string, cliInput: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = cliInput;
  }),
  // Resume action delegates to session-manager — tests stub per-scenario.
  resumeSession: vi.fn(),
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
      scope: 'chat',
    },
    worker: { killed: false, send: vi.fn() } as any,
    workerPort: 8080,
    workerToken: 'tok_secret',
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    // Flat 普通群 session: status confirmations (restart/close/resume/not-ready)
    // go out as "visible-to-you" ephemeral cards. Thread-scope sessions take the
    // visible in-thread reply instead — covered by the thread-scope cases below.
    scope: 'chat',
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

  // ── Scenario 3: multi-turn card lifecycle (stale-nonce self-heal) ─────
  //
  // Before this PR, a click on a stale-nonce card was *ignored* (no state
  // change, no PATCH). That left users stranded on legacy cards — clicking
  // them produced no feedback, and the stale `cli_id` / image_key on the
  // card couldn't be corrected once a session rebooted under a different
  // CLI. The PR replaces that with a self-heal: a stale-nonce click migrates
  // the live session's displayMode to the next value, informs the worker
  // over IPC, and (when the event carries the clicked message id) PATCHes
  // the *clicked* card so its `cli_id` / chrome are re-bound to the current
  // session. The two tests below pin both halves of that contract.

  describe('Scenario 3: multi-turn card lifecycle', () => {
    it('stale-nonce toggle self-heals live state + worker IPC; current-nonce click still toggles back via scheduleCardPatch', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_new_card',
        streamCardNonce: NONCE_CURRENT,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);
      const workerSend = (ds.worker as any).send as Mock;

      // Click on OLD (frozen) card carrying stale nonce — and NO clicked
      // message id (e.g. some legacy webhook payloads omit context). State
      // self-heals, worker is notified, but no card can be PATCHed because
      // the handler doesn't know which message to target.
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_OLD), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(workerSend).toHaveBeenCalledWith({ type: 'set_display_mode', mode: 'screenshot' });
      expect(fakeLark.patches).toHaveLength(0);

      // Click on current card flips displayMode back and PATCHes the
      // live streaming card via the normal scheduleCardPatch path.
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe('om_new_card');
    });

    it('stale-nonce toggle with clicked message id migrates the legacy card via updateMessage', async () => {
      const NONCE_TURN1 = 'nonce_turn1';
      const NONCE_TURN2 = 'nonce_turn2';
      const LEGACY_MSG_ID = 'om_card_turn1';

      const ds = makeDaemonSession({
        streamCardId: 'om_card_turn2',
        streamCardNonce: NONCE_TURN2,
        displayMode: 'hidden',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      // Click on the older turn's card (turn1 nonce + its message id).
      // Self-heal should PATCH that *clicked* card, not the live one, so the
      // visible chrome on the legacy card gets re-bound to the current
      // session and CLI.
      await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_TURN1, 'ou_user', LEGACY_MSG_ID),
        deps,
        APP_ID,
      );
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe(LEGACY_MSG_ID);

      // Current-nonce click still works after a stale-nonce migration.
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_TURN2), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(2);
      expect(fakeLark.patches[1].args[1]).toBe('om_card_turn2');
    });
  });

  // ── Scenario 4: restart / close actions ───────────────────────────────

  describe('Scenario 4: restart and close button actions', () => {
    it('restart with live worker should send restart IPC message', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(workerSend).toHaveBeenCalledWith({ type: 'restart' });
      // The confirmation is delivered ephemeral to the clicker (group chat + an
      // operator open_id), not as a visible group reply.
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('重启'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
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
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessions.has(sKey)).toBe(false);
      // Closed reply is an interactive card with a Resume button, delivered
      // ephemeral to the clicker (group chat + operator open_id); the mocked
      // builder embeds the type marker so we assert on that shape.
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('"type":"closed"'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('close in private mode sends the closed card ephemeral to owners, not the group', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const botRegMod = await import('../src/bot-registry.js');
      // privateCard on + an owner in allowedUsers. Sticky (close path calls
      // getBot several times); restored in finally so it can't leak.
      vi.mocked(botRegMod.getBot).mockReturnValue({
        config: { larkAppId: APP_ID, cliId: 'claude-code', privateCard: true },
        resolvedAllowedUsers: ['ou_owner'],
        botOpenId: 'ou_bot',
      } as any);
      try {
        const ds = makeDaemonSession();
        const sessions = new Map<string, DaemonSession>();
        const sKey = sessionKey(ROOT_ID, APP_ID);
        sessions.set(sKey, ds);
        const deps = makeDeps(sessions);

        await handleCardAction(makeCloseEvent(ROOT_ID, 'ou_owner'), deps, APP_ID);

        expect(killWorker).toHaveBeenCalledWith(ds);
        expect(sessions.has(sKey)).toBe(false);
        // Closed card goes ephemeral to the owner …
        expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
          APP_ID, ds.chatId, 'ou_owner', expect.stringContaining('"type":"closed"'),
        );
        // … and NOT posted to the group thread (no leak of session/CLI/workingDir).
        const groupClosed = (deps.sessionReply as any).mock.calls.find(
          (c: any[]) => typeof c[1] === 'string' && c[1].includes('"type":"closed"'),
        );
        expect(groupClosed).toBeUndefined();
      } finally {
        vi.mocked(botRegMod.getBot).mockReturnValue({
          config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
          resolvedAllowedUsers: [],
          botOpenId: 'ou_bot',
        } as any);
      }
    });

    it('close from a private card stays ephemeral even after privateCard was turned off (no group leak)', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const botRegMod = await import('../src/bot-registry.js');
      // Config has since been flipped OFF, but the card itself was built in
      // private mode and carries visibility:'private'. The closed card must
      // still go ephemeral — its visibility is pinned to the card, not to the
      // current (mutable) config.
      vi.mocked(botRegMod.getBot).mockReturnValue({
        config: { larkAppId: APP_ID, cliId: 'claude-code', privateCard: false },
        resolvedAllowedUsers: ['ou_owner'],
        botOpenId: 'ou_bot',
      } as any);
      try {
        const ds = makeDaemonSession();
        const sessions = new Map<string, DaemonSession>();
        const sKey = sessionKey(ROOT_ID, APP_ID);
        sessions.set(sKey, ds);
        const deps = makeDeps(sessions);

        await handleCardAction(makeCloseEvent(ROOT_ID, 'ou_owner', 'private'), deps, APP_ID);

        expect(killWorker).toHaveBeenCalledWith(ds);
        // Closed card still goes ephemeral to the owner …
        expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
          APP_ID, ds.chatId, 'ou_owner', expect.stringContaining('"type":"closed"'),
        );
        // … and NOT posted to the group thread.
        const groupClosed = (deps.sessionReply as any).mock.calls.find(
          (c: any[]) => typeof c[1] === 'string' && c[1].includes('"type":"closed"'),
        );
        expect(groupClosed).toBeUndefined();
      } finally {
        vi.mocked(botRegMod.getBot).mockReturnValue({
          config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
          resolvedAllowedUsers: [],
          botOpenId: 'ou_bot',
        } as any);
      }
    });

    it('resume should call resumeSession and reply with success notice', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const sessionId = 'closed-uuid-1';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      // Permission gate: closed sessions aren't in activeSessions; the handler
      // falls back to sessionStore.getSession() to pin chatId/larkAppId.
      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: APP_ID, scope: 'chat', cliId: 'claude-code',
      } as any);

      const sm = await import('../src/core/session-manager.js');
      const fakeDs: any = {
        session: { sessionId, cliId: 'claude-code' },
        larkAppId: APP_ID,
        chatId: 'oc_chat',
        chatType: 'group',
        scope: 'chat',  // flat 普通群 → resume notice goes out ephemeral
      };
      vi.mocked(sm.resumeSession).mockReturnValue({ ok: true, ds: fakeDs } as any);

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId), deps, APP_ID);

      expect(sm.resumeSession).toHaveBeenCalledWith(sessionId, sessions);
      // Success notice is delivered ephemeral to the clicker (group + operator).
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, 'oc_chat', 'ou_user', expect.stringContaining('已恢复'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('resume should surface anchor_occupied error from resumeSession', async () => {
      const sessionId = 'closed-uuid-2';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: APP_ID, scope: 'thread',
      } as any);

      const sm = await import('../src/core/session-manager.js');
      vi.mocked(sm.resumeSession).mockReturnValue(
        { ok: false, error: 'anchor_occupied', activeSessionId: 'newer-session-uuid' } as any,
      );

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId), deps, APP_ID);

      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('已有新会话'),
        undefined,
        APP_ID,
      );
    });

    it('sensitive fallback should reject when only allowedChatGroups is configured', async () => {
      const botRegMod = await import('../src/bot-registry.js');
      vi.mocked(botRegMod.getAllBots).mockReturnValueOnce([{
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedChatGroups: ['oc_team'] } as any,
        resolvedAllowedUsers: [],
        botOpenId: 'ou_bot',
      } as any]);

      const sessionId = 'closed-uuid-fallback';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        scope: 'thread',
      } as any);
      const sm = await import('../src/core/session-manager.js');

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId, 'ou_user'), deps, undefined);

      expect(sm.resumeSession).not.toHaveBeenCalled();
    });

    it('sensitive fallback should reject when only globalGrants is configured', async () => {
      // 回归（Codex P2）：只配 globalGrants（talk-only）且进入无 effectiveAppId 的 fallback 时，
      // hasAllowlist 必须算成 true，否则敏感动作 fall through 成全开放。operator 不在 allowedUsers
      // （空）→ 应被拒，resumeSession 不被调用。
      const botRegMod = await import('../src/bot-registry.js');
      vi.mocked(botRegMod.getAllBots).mockReturnValueOnce([{
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', globalGrants: ['ou_peer'] } as any,
        resolvedAllowedUsers: [],
        botOpenId: 'ou_bot',
      } as any]);

      const sessionId = 'closed-uuid-fallback-global';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        scope: 'thread',
      } as any);
      const sm = await import('../src/core/session-manager.js');

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId, 'ou_user'), deps, undefined);

      expect(sm.resumeSession).not.toHaveBeenCalled();
    });

    it('resume should reject when operator is not in allowedUsers', async () => {
      // canOperate is gated through bot-registry.getBot(...).resolvedAllowedUsers
      // — switch the mock to a bot with a non-empty allowlist that excludes the
      // operator, then verify resumeSession was never called and no reply went out.
      const botRegMod = await import('../src/bot-registry.js');
      vi.mocked(botRegMod.getBot).mockReturnValueOnce({
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' } as any,
        resolvedAllowedUsers: ['ou_other_user'],
        botOpenId: 'ou_bot',
      } as any);

      const sessionId = 'closed-uuid-3';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: APP_ID, scope: 'thread',
      } as any);

      const sm = await import('../src/core/session-manager.js');

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId, 'ou_outsider'), deps, APP_ID);

      expect(sm.resumeSession).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 4b: thread-scope confirmations stay in-thread (no leak) ───
  //
  // Regression guard: the ephemeral API has no thread anchor, so a 话题 (a
  // thread-scope session inside a 普通群) must NOT use ephemeral — the
  // restart/close/resume confirmation has to stay in the topic via the visible
  // in-thread reply (sessionReply → reply_in_thread). Flat 普通群 (scope:'chat',
  // tested in Scenario 4) keeps the ephemeral "visible-to-you" behaviour.

  describe('Scenario 4b: thread-scope status cards stay in the thread', () => {
    it('restart confirmation in a thread-scope session is a visible in-thread reply, never ephemeral', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        scope: 'thread',
        worker: { killed: false, send: workerSend } as any,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(workerSend).toHaveBeenCalledWith({ type: 'restart' });
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID, expect.stringContaining('重启'), undefined, APP_ID,
      );
    });

    it('close card in a thread-scope session is replied in-thread, never ephemeral', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({ scope: 'thread' });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessions.has(sKey)).toBe(false);
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID, expect.stringContaining('"type":"closed"'), 'interactive', APP_ID,
      );
    });

    it('resume notice in a thread-scope session is replied in-thread, never ephemeral', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const sessionId = 'closed-uuid-thread';
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const sessionStoreMod = await import('../src/services/session-store.js');
      vi.mocked(sessionStoreMod.getSession).mockReturnValue({
        sessionId, chatId: 'oc_chat', rootMessageId: ROOT_ID,
        title: 'closed', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: APP_ID, scope: 'thread', cliId: 'claude-code',
      } as any);

      const sm = await import('../src/core/session-manager.js');
      const fakeDs: any = {
        session: { sessionId, cliId: 'claude-code' },
        larkAppId: APP_ID,
        chatId: 'oc_chat',
        chatType: 'group',
        scope: 'thread',  // 话题里恢复 → 确认留在话题内
      };
      vi.mocked(sm.resumeSession).mockReturnValue({ ok: true, ds: fakeDs } as any);

      await handleCardAction(makeResumeEvent(ROOT_ID, sessionId), deps, APP_ID);

      expect(sm.resumeSession).toHaveBeenCalledWith(sessionId, sessions);
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID, expect.stringContaining('已恢复'), undefined, APP_ID,
      );
    });
  });

  // ── Scenario 5: get_write_link delivers the write-link card privately ──

  describe('Scenario 5: get_write_link delivers the write-link card privately', () => {
    it('sends an ephemeral "visible-to-you" card in a group chat, not a DM', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({
        workerPort: 9090,
        workerToken: 'write_tok',
        chatType: 'group',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);
      await flush();

      // 普通群 → 仅点击者可见的 ephemeral 私密卡，不发 DM。
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('"type":"session"'),
      );
      const card = parseCard(vi.mocked(clientMod.sendEphemeralCard).mock.calls[0][3] as string);
      expect(card.type).toBe('session');
      expect(card.showManageButtons).toBe(true);
      expect(fakeLark.dms).toHaveLength(0);
    });

    it('falls back to a private DM in a p2p chat (ephemeral unsupported there)', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({
        workerPort: 9090,
        workerToken: 'write_tok',
        chatType: 'p2p',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);
      await flush();

      // 单聊 → 跳过注定失败的 ephemeral，直接私聊 DM（DM 落在同一个 1:1 会话里）。
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(fakeLark.dms).toHaveLength(1);
      expect(fakeLark.dms[0].args[0]).toBe(APP_ID);
      expect(fakeLark.dms[0].args[1]).toBe('ou_user');
      expect(parseCard(fakeLark.dms[0].args[2]).type).toBe('session');
    });

    it('should reply with warning when terminal not ready', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({
        workerPort: null,
        workerToken: null,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);

      expect(fakeLark.dms).toHaveLength(0);
      // The "not ready" warning is delivered ephemeral to the clicker (group +
      // operator), not as a visible group reply.
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('尚未就绪'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
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

  describe('Scenario 8: usage-limit retry action', () => {
    it('resends the stored CLI input and clears the limit state when retry is ready', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_stream_card_retry',
        lastScreenStatus: 'limited',
        usageLimit: {
          limited: true,
          kind: 'usage',
          retryAtMs: Date.now() - 1000,
          retryLabel: '10:36 PM',
          retryReady: true,
        },
        lastUserPrompt: '继续',
        lastCliInput: '<user_message>继续</user_message>',
        currentImageKey: 'img_old',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRetryLastTaskEvent(ROOT_ID), deps, APP_ID);

      expect((ds.worker as any).send).toHaveBeenCalledWith({
        type: 'message',
        content: '<user_message>继续</user_message>',
      });
      expect(ds.usageLimit).toBeUndefined();
      expect(ds.usageLimitRetryTimer).toBeUndefined();
      expect(ds.lastScreenStatus).toBe('working');
      expect(ds.streamCardPending).toBe(true);
      expect(ds.currentImageKey).toBeUndefined();
      expect(ds.currentTurnTitle).toBe('继续');
    });

    it('does not resend from a stale retry button after the limit state is cleared', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_stream_card_stale_retry',
        lastScreenStatus: 'working',
        lastUserPrompt: '继续',
        lastCliInput: '<user_message>继续</user_message>',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRetryLastTaskEvent(ROOT_ID), deps, APP_ID);

      expect((ds.worker as any).send).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalled();
    });
  });
});
