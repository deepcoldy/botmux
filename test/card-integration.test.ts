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
import { EventEmitter } from 'node:events';
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
const { deleteMessageMock } = vi.hoisted(() => ({
  deleteMessageMock: vi.fn(async () => true),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => fakeLark.createMock('updateMessage')(...args),
  deleteMessage: deleteMessageMock,
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
  STREAMING_CARD_PATCH_VERSION: '1',
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
      ...rest: any[]
    ) =>
      JSON.stringify({
        config: { wide_screen_mode: true, update_multi: true },
        type: 'streaming',
        expanded: displayMode === 'screenshot',
        displayMode,
        content,
        status,
        cardNonce,
        // Positional tail: rest[10] is the 23rd argument (screenshotUnavailable).
        imageKey: _imageKey ?? null,
        screenshotUnavailable: rest[10] === true,
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
  frozenIdleLabel: vi.fn(() => undefined),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    resolvedBlockedUsers: [],
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => 'feishu'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    // unit-setup supplies a per-file temporary directory, including concurrent runs.
    session: { dataDir: process.env.SESSION_DATA_DIR! },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getOwnedSession: vi.fn(),
  // Resume action's permission gate falls back to a store lookup when the
  // session is no longer in activeSessions. Tests override the implementation
  // per-scenario via vi.mocked(getSession).mockReturnValueOnce(...).
  getSession: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...orig,
    closeSession: vi.fn((...args: Parameters<typeof orig.closeSession>) => orig.closeSession(...args)),
    forkWorker: vi.fn(),
    killWorker: vi.fn(),
    initWorkerPool: vi.fn(),
    isSessionTransferring: vi.fn((...args: Parameters<typeof orig.isSessionTransferring>) => orig.isSessionTransferring(...args)),
    requestSessionRestart: vi.fn((_ds: any, observer: any) => {
      void observer.notify('in_progress');
      return { attemptId: 'attempt-card', joined: false };
    }),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  ensureSessionWhiteboard: vi.fn(),
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
import {
  closeSession as closeWorkerSession,
  scheduleCardPatch,
  setActiveSessionsRegistry,
  forkWorker,
  requestSessionRestart,
  isSessionTransferring,
  CARD_POSTING_SENTINEL,
} from '../src/core/worker-pool.js';
import { getBot } from '../src/bot-registry.js';
import { activeSessionKey, sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import * as sessionStore from '../src/services/session-store.js';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import { deleteFrozenCards } from '../src/services/frozen-card-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const APP_ID = 'app_test';
const ROOT_ID = 'om_root_001';
const NONCE_CURRENT = 'nonce_abc1';
const NONCE_OLD = 'nonce_old_xyz';

function makeDaemonSession(overrides?: Partial<DaemonSession>): DaemonSession {
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    send: vi.fn(),
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  worker.send.mockImplementation((message: { type?: string }) => {
    if (message.type === 'close') {
      queueMicrotask(() => {
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
    }
    return true;
  });

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
    worker: worker as any,
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
  // Card actions and worker-pool closeSession share this exact registry in
  // production. Model that identity here so close teardown mutates the same
  // object the card handler subsequently removes.
  setActiveSessionsRegistry(activeSessions);
  vi.mocked(sessionStore.getOwnedSession).mockImplementation((sessionId: string) =>
    [...activeSessions.values()].find(ds => ds.session.sessionId === sessionId)?.session,
  );
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

// This file deliberately uses the REAL frozen-card store (session-manager is
// mocked, frozen-card-store is not), and every scenario shares the session id
// 'uuid-integ-test'. A scenario whose card POST intentionally fails after
// parkStreamCard (e.g. the R5 failed-repost port) leaves its parked entry on
// disk, and the first test of the NEXT run would lazy-load and withdraw it as
// an extra card. Reset the on-disk map before every test so runs are isolated.
beforeEach(() => {
  deleteFrozenCards('uuid-integ-test');
});

describe('Card integration: full event flow', () => {
  beforeEach(() => {
    fakeLark.reset();
    sessionReplyResults = [];
    vi.clearAllMocks();
  });

  // ── Scenario 1: screen_update → POST card → toggle → PATCH ────────────

  describe('Scenario 1: screen_update then toggle (full lifecycle)', () => {
    it('reposts an upgrade-era legacy card once instead of PATCHing it', async () => {
      const legacyCardId = 'om_stream_card_legacy';
      const ds = makeDaemonSession({ streamCardId: legacyCardId, workerReady: true });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      sessions.set(activeSessionKey(ds), ds);
      const deps = makeDeps(sessions);

      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', legacyCardId, null),
        deps,
        APP_ID,
      );

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(0);
      expect(result).toMatchObject({ toast: { type: 'info' }, afterAck: expect.any(Function) });

      await result.afterAck();

      expect(deps.sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.streamCardId).toBe('om_card_0');
      expect(fakeLark.patches).toHaveLength(0);
      expect(deleteMessageMock).toHaveBeenCalledTimes(1);
      expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, legacyCardId);

      const duplicate = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', legacyCardId, null),
        deps,
        APP_ID,
      );
      expect(duplicate.afterAck).toBeUndefined();
      expect(deps.sessionReply).toHaveBeenCalledTimes(1);
    });

    it('allows a failed legacy-card migration to be retried on the next click', async () => {
      const legacyCardId = 'om_stream_card_legacy_retry';
      const ds = makeDaemonSession({ streamCardId: legacyCardId, workerReady: true });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      sessions.set(activeSessionKey(ds), ds);
      const deps = makeDeps(sessions);
      vi.mocked(deps.sessionReply)
        .mockRejectedValueOnce(new Error('temporary post failure'))
        .mockResolvedValueOnce('om_migrated_after_retry');

      const first = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', legacyCardId, null),
        deps,
        APP_ID,
      );
      await first.afterAck();
      expect(ds.streamCardId).toBe(legacyCardId);
      expect(ds.displayMode).toBe('hidden');

      const retry = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', legacyCardId, null),
        deps,
        APP_ID,
      );
      expect(retry.afterAck).toEqual(expect.any(Function));
      await retry.afterAck();

      expect(deps.sessionReply).toHaveBeenCalledTimes(2);
      expect(ds.streamCardId).toBe('om_migrated_after_retry');
      expect(ds.displayMode).toBe('screenshot');
    });

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
      const callbackResult = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      // Toggle should NOT have sent another PATCH — it should be queued
      expect(fakeLark.patches).toHaveLength(1);
      expect(ds.displayMode).toBe('screenshot');
      expect(ds.pendingCardJson).toBeTruthy();
      expect(parseCard(ds.pendingCardJson!).expanded).toBe(true);
      // The callback only acknowledges the click. Returning a raw card here
      // would let Lark update it synchronously outside scheduleCardPatch and
      // allow the older in-flight PATCH to overwrite the expanded state.
      expect(callbackResult).toEqual({
        toast: { type: 'info', content: '操作已收到，后台处理中' },
      });

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

    it('stale-nonce toggle with clicked message id repaints the legacy card through the callback only', async () => {
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

      // Click on the older turn's card (turn1 nonce + its message id). The
      // clicked card is re-bound to the current session/CLI by the callback
      // response alone: a parallel updateMessage would be an unqueued second
      // channel whose late arrival can undo the next click.
      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_TURN1, 'ou_user', LEGACY_MSG_ID),
        deps,
        APP_ID,
      );
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(result).toMatchObject({ type: 'streaming', expanded: true, cardNonce: NONCE_TURN2 });
      expect(fakeLark.patches).toHaveLength(0);
      expect(ds.streamCardId).toBe('om_card_turn2');

      // Current-nonce click still works after a stale-nonce migration.
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_TURN2), deps, APP_ID);
      await flush();

      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe('om_card_turn2');
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

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'card' }));
      // The confirmation is delivered ephemeral to the clicker (group chat + an
      // operator open_id), not as a visible group reply.
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('重启'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('restart from a stale Riff card should explain close-and-recreate without IPC', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      ds.session.cliId = 'riff';
      ds.session.backendType = 'riff';
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(workerSend).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID,
        ds.chatId,
        'ou_user',
        expect.stringMatching(/Riff.*不支持重启.*\/close/),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('restart without worker should re-fork', async () => {
      const ds = makeDaemonSession({ worker: null });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeRestartEvent(ROOT_ID), deps, APP_ID);

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'card' }));
    });

    it('close should remove session and deliver the closed card', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = activeSessionKey(ds);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCloseEvent(ROOT_ID, 'ou_user', undefined, ds.session.sessionId), deps, APP_ID);

      expect(sessionStore.closeSession).toHaveBeenCalledWith(
        ds.session.sessionId,
        { cleanupBridgeMarkers: false },
      );
      expect(ds.session.status).toBe('closed');
      expect(sessions.has(sKey)).toBe(false);
      // Closed reply is an interactive card with a Resume button, delivered
      // ephemeral to the clicker (group chat + operator open_id); the mocked
      // builder embeds the type marker so we assert on that shape.
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('"type":"closed"'),
      );
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('keeps a ZMX session active and returns a warning when verified teardown is refused', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession();
      ds.session.backendType = 'zmx';
      ds.initConfig = { backendType: 'zmx' } as DaemonSession['initConfig'];
      const workerSend = ds.worker!.send as Mock;
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);
      const kill = vi.spyOn(ZmxBackend, 'killManagedSession')
        .mockImplementationOnce(() => { throw new Error('ownership probe unavailable'); });

      try {
        const result = await handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);

        expect(kill).toHaveBeenCalledWith('bmx-uuid-int', ds.session.sessionId);
        expect(result?.toast).toEqual(expect.objectContaining({
          type: 'warning',
          content: expect.stringContaining('ownership probe unavailable'),
        }));
        expect(sessions.get(sKey)).toBe(ds);
        expect(ds.session.status).toBe('active');
        expect(ds.worker).not.toBeNull();
        expect(workerSend).not.toHaveBeenCalled();
        expect(sessionStore.closeSession).not.toHaveBeenCalled();
        expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
        expect(deps.sessionReply).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });

    it('close reports a residual instead of the ordinary closed card', async () => {
      // The row DID close, so this is not a failure — but a remote session was
      // deliberately left running (quarantined lineage cannot be cancelled safely).
      // Sending the normal closed card here would tell the user it is all gone.
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(activeSessionKey(ds), ds);
      const deps = makeDeps(sessions);
      vi.mocked(closeWorkerSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
        alreadyClosed: false,
        known: true,
      } as never);

      const result = await handleCardAction(
        makeCloseEvent(ROOT_ID, 'ou_user', undefined, ds.session.sessionId),
        deps,
        APP_ID,
      );

      expect(result?.toast).toEqual(expect.objectContaining({
        type: 'warning',
        content: expect.stringContaining('mojo-parked-9'),
      }));
      expect(result?.toast?.content).toContain('未被取消');
      // No ordinary "closed" card on either delivery path.
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('a LOCAL-subtree residual close toast points at the host process, not a phantom remote (round-11 P1-2)', async () => {
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(activeSessionKey(ds), ds);
      const deps = makeDeps(sessions);
      vi.mocked(closeWorkerSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'local_subtree_boundary_unproven' }, // no taskId
        alreadyClosed: false,
        known: true,
      } as never);

      const result = await handleCardAction(
        makeCloseEvent(ROOT_ID, 'ou_user', undefined, ds.session.sessionId),
        deps,
        APP_ID,
      );

      expect(result?.toast?.type).toBe('warning');
      expect(result?.toast?.content).toContain('本机');
      expect(result?.toast?.content).not.toContain('undefined');
      expect(result?.toast?.content).not.toMatch(/远端会话.*未.*取消/);
    });

    it('close refusal reports the remote id and does not send a closed card', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(activeSessionKey(ds), ds);
      const deps = makeDeps(sessions);
      vi.mocked(closeWorkerSession).mockResolvedValueOnce({
        ok: false,
        alreadyClosed: false,
        error: 'mojo_close_reconciliation_required',
        retryable: true,
        taskId: 'mojo-uncertain-9',
      } as never);

      const result = await handleCardAction(
        makeCloseEvent(ROOT_ID, 'ou_user', undefined, ds.session.sessionId),
        deps,
        APP_ID,
      );

      expect(result?.toast).toEqual(expect.objectContaining({
        type: 'warning',
        content: expect.stringContaining('mojo-uncertain-9'),
      }));
      expect(result?.toast?.content).toContain('mojo_close_reconciliation_required');
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('close in private mode sends the closed card ephemeral to owners, not the group', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const botRegMod = await import('../src/bot-registry.js');
      // privateCard on + an owner in allowedUsers. Sticky (close path calls
      // getBot several times); restored in finally so it can't leak.
      vi.mocked(botRegMod.getBot).mockReturnValue({
        config: { larkAppId: APP_ID, cliId: 'claude-code', privateCard: true, allowedUsers: ['ou_owner'] },
        resolvedAllowedUsers: ['ou_owner'],
        resolvedBlockedUsers: [],
        botOpenId: 'ou_bot',
      } as any);
      try {
        const ds = makeDaemonSession();
        ds.streamCardId = 'om_live';
        const sessions = new Map<string, DaemonSession>();
        const sKey = activeSessionKey(ds);
        sessions.set(sKey, ds);
        const deps = makeDeps(sessions);

        await handleCardAction(
          makeCloseEvent(ROOT_ID, 'ou_owner', undefined, ds.session.sessionId),
          deps,
          APP_ID,
        );

        expect(sessionStore.closeSession).toHaveBeenCalledWith(
          ds.session.sessionId,
          { cleanupBridgeMarkers: false },
        );
        expect(ds.session.status).toBe('closed');
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
        expect(fakeLark.patches).toHaveLength(0);
      } finally {
        vi.mocked(botRegMod.getBot).mockReturnValue({
          config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
          resolvedAllowedUsers: [],
          resolvedBlockedUsers: [],
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
        config: { larkAppId: APP_ID, cliId: 'claude-code', privateCard: false, allowedUsers: ['ou_owner'] },
        resolvedAllowedUsers: ['ou_owner'],
        resolvedBlockedUsers: [],
        botOpenId: 'ou_bot',
      } as any);
      try {
        const ds = makeDaemonSession();
        ds.streamCardId = 'om_live';
        const sessions = new Map<string, DaemonSession>();
        const sKey = activeSessionKey(ds);
        sessions.set(sKey, ds);
        const deps = makeDeps(sessions);

        await handleCardAction(
          makeCloseEvent(ROOT_ID, 'ou_owner', 'private', ds.session.sessionId),
          deps,
          APP_ID,
        );

        expect(sessionStore.closeSession).toHaveBeenCalledWith(
          ds.session.sessionId,
          { cleanupBridgeMarkers: false },
        );
        expect(ds.session.status).toBe('closed');
        // Closed card still goes ephemeral to the owner …
        expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
          APP_ID, ds.chatId, 'ou_owner', expect.stringContaining('"type":"closed"'),
        );
        // … and NOT posted to the group thread.
        const groupClosed = (deps.sessionReply as any).mock.calls.find(
          (c: any[]) => typeof c[1] === 'string' && c[1].includes('"type":"closed"'),
        );
        expect(groupClosed).toBeUndefined();
        expect(fakeLark.patches).toHaveLength(0);
      } finally {
        vi.mocked(botRegMod.getBot).mockReturnValue({
          config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
          resolvedAllowedUsers: [],
          resolvedBlockedUsers: [],
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
        resolvedBlockedUsers: [],
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
        resolvedBlockedUsers: [],
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

    it('sensitive fallback should reject when only p2pOpen is configured', async () => {
      // 回归（codex 复验）：p2pOpen 与 globalGrants 同理——它也是一次显式的权限边界声明，
      // 这条手写 fallback 必须把它算进 hasAllowlist，否则「只配 p2pOpen、无 allowedUsers」的
      // 部署会让敏感卡片动作 fall through 成全开放（p2pOpen 只该开私聊 talk，绝不给 operate）。
      const botRegMod = await import('../src/bot-registry.js');
      vi.mocked(botRegMod.getAllBots).mockReturnValueOnce([{
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', p2pOpen: true } as any,
        resolvedAllowedUsers: [],
        resolvedBlockedUsers: [],
        botOpenId: 'ou_bot',
      } as any]);

      const sessionId = 'closed-uuid-fallback-p2popen';
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
        // config.allowedUsers 是原始配置（hasAllowlist 据此判定）；resolvedAllowedUsers 是解析结果。
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_other_user'] } as any,
        resolvedAllowedUsers: ['ou_other_user'],
        resolvedBlockedUsers: [],
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

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'card' }));
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID, expect.stringContaining('重启'), undefined, APP_ID,
      );
    });

    it('close card in a thread-scope session is replied in-thread, never ephemeral', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({ scope: 'thread' });
      const sessions = new Map<string, DaemonSession>();
      const sKey = activeSessionKey(ds);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);

      expect(sessionStore.closeSession).toHaveBeenCalledWith(
        ds.session.sessionId,
        { cleanupBridgeMarkers: false },
      );
      expect(ds.session.status).toBe('closed');
      expect(sessions.has(sKey)).toBe(false);
      expect(vi.mocked(clientMod.sendEphemeralCard)).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID, expect.stringContaining('"type":"closed"'), 'interactive', APP_ID,
      );
    });

    it('does not delete a replacement session that wins the route while close cleanup awaits', async () => {
      const ds = makeDaemonSession({ scope: 'thread' });
      const replacement = makeDaemonSession({
        session: {
          ...ds.session,
          sessionId: 'uuid-replacement-after-close',
          status: 'active' as any,
        },
      });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);
      let signalCloseStarted!: () => void;
      const closeStarted = new Promise<void>((resolve) => {
        signalCloseStarted = resolve;
      });
      let releaseClose!: () => void;
      const closeCleanupPending = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      vi.mocked(closeWorkerSession).mockImplementationOnce(async () => {
        // Production closeSession removes and closes the captured ds before its
        // first network-cleanup await. A new session may then claim the key.
        sessions.delete(sKey);
        ds.session.status = 'closed';
        signalCloseStarted();
        await closeCleanupPending;
        return { ok: true, outcome: 'closed', alreadyClosed: false, known: true };
      });

      const closeAction = handleCardAction(makeCloseEvent(ROOT_ID), deps, APP_ID);
      await closeStarted;
      sessions.set(sKey, replacement);
      releaseClose();
      await closeAction;

      expect(sessions.get(sKey)).toBe(replacement);
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

      const res = await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);
      await flush();

      // 有权限点击：同步立即回执 success toast（投递是异步 fire-and-forget，不等它完成）。
      expect(res?.toast?.type).toBe('success');
      expect(res?.toast?.content).toContain('已私密发送');
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

      const res = await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);
      await flush();

      // 有权限：同样同步回执 success toast（不区分投递通道）。
      expect(res?.toast?.type).toBe('success');
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

    it('reports Web Terminal as unsupported for stale ZMX cards even if old terminal state remains', async () => {
      const clientMod = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({
        session: {
          ...makeDaemonSession().session,
          backendType: 'zmx',
          webPort: 9090,
        },
        workerPort: 9090,
        workerToken: 'stale-write-token',
        riffAccessUrl: 'https://stale-riff.example',
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const res = await handleCardAction(makeGetWriteLinkEvent(ROOT_ID, 'ou_user'), deps, APP_ID);

      expect(res?.toast?.type).not.toBe('success');
      expect(fakeLark.dms).toHaveLength(0);
      expect(vi.mocked(clientMod.sendEphemeralCard)).toHaveBeenCalledWith(
        APP_ID, ds.chatId, 'ou_user', expect.stringContaining('不提供 Web 终端'),
      );
      expect(vi.mocked(clientMod.sendEphemeralCard).mock.calls.at(-1)?.[3]).not.toContain('尚未就绪');
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

    it('toggle with no workerPort still PATCHes the current card (worker readiness only gates fresh frames)', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_no_port',
        workerPort: null,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_card_no_port'),
        deps,
        APP_ID,
      );
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe('om_card_no_port');
      const card = parseCard(fakeLark.patches[0].args[2]);
      expect(card.expanded).toBe(true);
      // Worker never reported ready and there is no cached frame: the card
      // must say so instead of waiting forever.
      expect(card.screenshotUnavailable).toBe(true);
      expect(result).toEqual({ toast: { type: 'info', content: '操作已收到，后台处理中' } });
    });

    it('a ready backend without Web Terminal (workerReady=true, workerPort=null) PATCHes and waits for the next frame', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_ready_no_port',
        workerPort: null,
        workerReady: true,
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_card_ready_no_port'),
        deps,
        APP_ID,
      );
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      const card = parseCard(fakeLark.patches[0].args[2]);
      expect(card.expanded).toBe(true);
      expect(card.screenshotUnavailable).toBe(false);
      expect((ds.worker as any).send).toHaveBeenCalledWith({ type: 'set_display_mode', mode: 'screenshot' });
    });

    it('hides cached output on the clicked current card while worker is unavailable', async () => {
      const cardId = 'om_current_sleeping';
      const ds = makeDaemonSession({
        streamCardId: cardId,
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'screenshot',
        currentImageKey: 'img_cached',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', cardId),
        makeDeps(sessions), APP_ID,
      );
      await flush();
      expect(ds.displayMode).toBe('hidden');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe(cardId);
      expect(parseCard(fakeLark.patches[0].args[2]).expanded).toBe(false);
      expect(result).not.toHaveProperty('elements');
      expect(result).not.toHaveProperty('type');
      expect(result?.toast?.type).toBe('info');
    });

    it('shows cached output on the clicked current card while worker is unavailable', async () => {
      const cardId = 'om_current_sleeping_show';
      const ds = makeDaemonSession({
        streamCardId: cardId,
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'hidden',
        currentImageKey: 'img_cached',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', cardId),
        makeDeps(sessions), APP_ID,
      );
      await flush();
      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe(cardId);
      const card = parseCard(fakeLark.patches[0].args[2]);
      expect(card.expanded).toBe(true);
      expect(card.imageKey).toBe('img_cached');
      expect(card.screenshotUnavailable).toBe(false);
      expect(result).not.toHaveProperty('type');
      // No implicit CLI start from a display button.
      expect(forkWorker).not.toHaveBeenCalled();
    });

    it('shows an explicit unavailable state when worker is unavailable and nothing is cached', async () => {
      const cardId = 'om_current_sleeping_empty';
      const ds = makeDaemonSession({
        streamCardId: cardId,
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'hidden',
        currentImageKey: undefined,
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', cardId),
        makeDeps(sessions), APP_ID,
      );
      await flush();
      expect(fakeLark.patches).toHaveLength(1);
      const card = parseCard(fakeLark.patches[0].args[2]);
      expect(card.expanded).toBe(true);
      expect(card.imageKey).toBeNull();
      expect(card.screenshotUnavailable).toBe(true);
      expect(forkWorker).not.toHaveBeenCalled();
    });

    it('updates an unknown frozen card from cache while the worker is unavailable (never rebinds it)', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_live_card',
        streamCardNonce: NONCE_CURRENT,
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'hidden',
        currentImageKey: 'img_cached',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_OLD, 'ou_user', 'om_unknown_frozen'),
        makeDeps(sessions), APP_ID,
      );
      await flush();
      expect(ds.displayMode).toBe('screenshot');
      expect(result).toMatchObject({ type: 'streaming', expanded: true, imageKey: 'img_cached' });
      expect(ds.streamCardId).toBe('om_live_card');
      expect(ds.streamCardNonce).toBe(NONCE_CURRENT);
    });

    it('returns the rebuilt card when a substitute turn declines the PATCH queue', async () => {
      const cardId = 'om_substitute_card';
      const ds = makeDaemonSession({
        streamCardId: cardId,
        displayMode: 'hidden',
        currentReplyTarget: {
          rootMessageId: 'om_substitute_trigger',
          turnId: 'om_substitute_turn',
          updatedAt: new Date().toISOString(),
          substitute: true,
        },
      });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const result = await handleCardAction(
        makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', cardId),
        deps,
        APP_ID,
      );
      await flush();

      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(0);
      expect(ds.pendingCardJson).toBeUndefined();
      expect(result).toMatchObject({ type: 'streaming', expanded: true });
    });

    it('close / toggle on a non-existent session return a failure toast; restart stays a silent no-op', async () => {
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      // 会话已不在线：close /「显示输出」给失败 toast（消除「按钮坏了」的错觉）。
      const toggleRes = await handleCardAction(makeToggleEvent('om_nonexistent', NONCE_CURRENT), deps, APP_ID);
      expect(toggleRes?.toast?.type).toBe('warning');
      expect(toggleRes?.toast?.content).toContain('不在线');

      const closeRes = await handleCardAction(makeCloseEvent('om_nonexistent'), deps, APP_ID);
      expect(closeRes?.toast?.type).toBe('warning');
      expect(closeRes?.toast?.content).toContain('不在线');

      // restart 未纳入本次失败 toast 范围，维持既有「静默 no-op」。
      const restartRes = await handleCardAction(makeRestartEvent('om_nonexistent'), deps, APP_ID);
      expect(restartRes?.toast).toBeUndefined();

      // 三者都不应产生卡片 PATCH。
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

      const result = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT), deps, APP_ID);
      await flush();

      // The handler must propagate adoptMode so the rebuilt card keeps
      // the `⏏ 断开` button — `❌ 关闭会话` would tear down the user's CLI.
      expect(result).toMatchObject({ toast: { type: 'info' } });
      expect(fakeLark.patches).toHaveLength(1);
      expect(parseCard(fakeLark.patches[0].args[2]).adoptMode).toBe(true);
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

  // ── Scenario 9: display toggle target identity (V2 strict rules) ─────────
  //
  // Real-shaped callback fixtures: root_id is the session's visible anchor
  // (chat-scope → chatId), session_id is the real session id, and the message
  // id comes from the Lark callback context — exactly what buildStreamingCard
  // embeds, so the positive case cannot pass on a field the fixture omits.
  describe('Scenario 9: toggle target identity and source isolation', () => {
    const CHAT_ANCHOR = 'oc_chat';
    const SESSION_ID = 'uuid-integ-test';
    const NONCE_N = 'nonce_N';
    const MSG_A = 'om_card_A_published';
    const MSG_B = 'om_card_B_old_selfhealed';

    function realToggleEvent(opts: {
      messageId?: string; nonce?: string; sessionId?: string; rootId?: string;
    }) {
      return {
        action: {
          value: {
            action: 'toggle_display',
            root_id: opts.rootId ?? CHAT_ANCHOR,
            session_id: opts.sessionId ?? SESSION_ID,
            cli_id: 'claude-code',
            stream_card_version: '1',
            ...(opts.nonce === undefined ? { card_nonce: NONCE_N } : opts.nonce ? { card_nonce: opts.nonce } : {}),
          },
        },
        operator: { open_id: 'ou_user' },
        ...(opts.messageId ? { context: { open_message_id: opts.messageId } } : {}),
      };
    }

    /** A/N was published by this daemon, then its runtime id was lost. */
    function lostIdSession(overrides?: Partial<DaemonSession>): { ds: DaemonSession; deps: CardHandlerDeps } {
      const ds = makeDaemonSession({
        streamCardId: undefined,
        streamCardNonce: NONCE_N,
        workerReady: true,
        displayMode: 'hidden',
        currentImageKey: 'img_cached',
        currentTurnId: 'om_turn_current',
        streamCardTurnGeneration: 4,
        ...overrides,
      });
      if (!overrides || !('lastPublishedStreamingCardIdentity' in overrides)) {
        ds.lastPublishedStreamingCardIdentity = {
          messageId: MSG_A,
          nonce: NONCE_N,
          sessionId: SESSION_ID,
          larkAppId: APP_ID,
          anchorId: CHAT_ANCHOR,
          runtimeKey: activeSessionKey(ds),
          turnGeneration: 4,
        };
      }
      const sessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
      return { ds, deps: makeDeps(sessions) };
    }

    it('positive: the exact proven publication A is restored as the current card and patched via the queue', async () => {
      const { ds, deps } = lostIdSession();
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
      await flush();
      expect(ds.streamCardId).toBe(MSG_A);
      expect(ds.displayMode).toBe('screenshot');
      expect(fakeLark.patches).toHaveLength(1);
      expect(fakeLark.patches[0].args[1]).toBe(MSG_A);
      expect(parseCard(fakeLark.patches[0].args[2])).toMatchObject({ expanded: true, imageKey: 'img_cached' });
      expect(result).toEqual({ toast: { type: 'info', content: '操作已收到，后台处理中' } });
    });

    it('A/N current → old B self-healed with N → A id lost → clicking B never rebinds B', async () => {
      const { ds, deps } = lostIdSession();
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_B }), deps, APP_ID);
      await flush();
      // Same nonce, same session, same root — still not proof of identity.
      expect(ds.streamCardId).toBeUndefined();
      expect(ds.streamCardNonce).toBe(NONCE_N);
      expect(ds.lastPublishedStreamingCardIdentity?.messageId).toBe(MSG_A);
      // Only the clicked card updates, via the callback (no queue PATCH).
      expect(fakeLark.patches).toHaveLength(0);
      expect(result).toMatchObject({ type: 'streaming', expanded: true, imageKey: 'img_cached' });
      // A late screenshot cannot reach B either (no current card).
      expect(ds.pendingCardJson).toBeUndefined();
    });

    const negatives: Array<[string, () => { ds: DaemonSession; deps: CardHandlerDeps }, Parameters<typeof realToggleEvent>[0]]> = [
      ['no proof (pre-fix session / history)', () => lostIdSession({ lastPublishedStreamingCardIdentity: undefined }), { messageId: MSG_A }],
      ['session_id mismatch', () => lostIdSession(), { messageId: MSG_A, sessionId: 'uuid-other-session' }],
      ['root_id mismatch', () => lostIdSession(), { messageId: MSG_A, rootId: 'om_other_root' }],
      ['missing session_id field', () => lostIdSession(), { messageId: MSG_A, sessionId: '' }],
      ['turn generation advanced', () => lostIdSession({ streamCardTurnGeneration: 5 }), { messageId: MSG_A }],
      ['streamCardPending (new turn awaiting its card)', () => lostIdSession({ streamCardPending: true }), { messageId: MSG_A }],
      ['pending turn id', () => lostIdSession({ streamCardPendingTurnId: 'om_turn_next' }), { messageId: MSG_A }],
      ['parked predecessor', () => lostIdSession({ parkedStreamCardNonce: NONCE_N }), { messageId: MSG_A }],
      ['restart-recovery silence', () => lostIdSession({ suppressRecoveryCard: true }), { messageId: MSG_A }],
      ['silent scheduled current turn', () => lostIdSession({ silentScheduledTurns: new Map([['om_turn_current', Date.now()]]) }), { messageId: MSG_A }],
      ['chat-scope substitute current turn (even when forced)', () => lostIdSession({
        streamingCardForced: true,
        currentReplyTarget: { rootMessageId: 'om_sub', turnId: 'om_turn_current', updatedAt: new Date().toISOString(), substitute: true },
      }), { messageId: MSG_A }],
      ['meeting-driven (managed) current turn', () => {
        const made = lostIdSession();
        (made.ds.session as any).vcMeetingReceiver = true;
        (made.ds.session as any).vcMeetingImTurnOrigins = {
          om_turn_current: { larkMessageId: 'om_turn_current', receiverSessionId: SESSION_ID },
        };
        return made;
      }, { messageId: MSG_A }],
    ];
    for (const [label, make, event] of negatives) {
      it(`negative: ${label} → no rebind`, async () => {
        const { ds, deps } = make();
        await handleCardAction(realToggleEvent(event), deps, APP_ID);
        await flush();
        expect(ds.streamCardId).toBeUndefined();
        expect(fakeLark.patches).toHaveLength(0);
      });
    }

    it('negative: nonce mismatch goes through the historical path and never rebinds', async () => {
      const { ds, deps } = lostIdSession();
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_A, nonce: 'nonce_other' }), deps, APP_ID);
      await flush();
      expect(ds.streamCardId).toBeUndefined();
      expect(ds.streamCardNonce).toBe(NONCE_N);
      expect(result).toMatchObject({ type: 'streaming' });
    });

    it('negative: POST sentinel is never replaced by the clicked message', async () => {
      const { ds, deps } = lostIdSession({ streamCardId: CARD_POSTING_SENTINEL });
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
      await flush();
      expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);
      expect(fakeLark.patches).toHaveLength(0);
      expect(result).toMatchObject({ type: 'streaming' });
    });

    it('negative: another session owns the registry slot', async () => {
      const { ds, deps } = lostIdSession();
      const usurper = makeDaemonSession({ session: { ...ds.session, sessionId: 'uuid-usurper' } as any });
      // Callback lookup still resolves ds, but the active registry slot is
      // owned by a different object.
      setActiveSessionsRegistry(new Map([[activeSessionKey(ds), usurper]]));
      await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
      await flush();
      expect(ds.streamCardId).toBeUndefined();
      expect(fakeLark.patches).toHaveLength(0);
    });

    it('negative: an in-flight PATCH of the same target blocks both rebind and the raw callback', async () => {
      const { ds, deps } = lostIdSession({ cardPatchInFlight: true, cardPatchInFlightMessageId: MSG_A });
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
      await flush();
      expect(ds.streamCardId).toBeUndefined();
      expect(result).toEqual({ toast: { type: 'warning', content: '卡片正在更新，请稍后再点一次' } });
      // The optimistic flip is rolled back so a retry requests the same transition.
      expect(ds.displayMode).toBe('hidden');
    });

    it('negative: an in-flight PATCH whose target is unknown conservatively refuses the raw callback', async () => {
      const { ds, deps } = lostIdSession({ cardPatchInFlight: true, lastPublishedStreamingCardIdentity: undefined });
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_B }), deps, APP_ID);
      expect(result?.toast?.type).toBe('warning');
      expect(ds.displayMode).toBe('hidden');
    });

    it('negative: closed session returns a failure toast and changes nothing', async () => {
      const { ds, deps } = lostIdSession();
      ds.session.status = 'closed' as any;
      const result = await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
      expect(result?.toast?.type).toBe('warning');
      expect(ds.displayMode).toBe('hidden');
      expect(ds.streamCardId).toBeUndefined();
    });

    it('negative: transferring session refuses the raw callback with an explicit toast', async () => {
      const { ds, deps } = lostIdSession({ lastPublishedStreamingCardIdentity: undefined });
      vi.mocked(isSessionTransferring).mockImplementation((candidate: DaemonSession) => candidate === ds);
      try {
        const result = await handleCardAction(realToggleEvent({ messageId: MSG_B }), deps, APP_ID);
        expect(result?.toast?.type).toBe('warning');
        expect(result?.toast?.content).toContain('接力');
        expect(ds.streamCardId).toBeUndefined();
        expect(ds.displayMode).toBe('hidden');
      } finally {
        vi.mocked(isSessionTransferring).mockImplementation(() => false);
      }
    });

    it('negative: apiOnly (no Lark transport) never repaints or rebinds', async () => {
      const { ds, deps } = lostIdSession();
      const normalBot = vi.mocked(getBot).getMockImplementation();
      vi.mocked(getBot).mockImplementation((() => ({
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', apiOnly: true },
        resolvedAllowedUsers: [], resolvedBlockedUsers: [], botOpenId: 'ou_bot',
      })) as any);
      try {
        const result = await handleCardAction(realToggleEvent({ messageId: MSG_A }), deps, APP_ID);
        expect(result?.toast?.type).toBe('warning');
        expect(ds.streamCardId).toBeUndefined();
        expect(fakeLark.patches).toHaveLength(0);
      } finally {
        vi.mocked(getBot).mockImplementation(normalBot as any);
      }
    });

    it('a cached frame from a silent scheduled turn is not shown; the card says unavailable instead', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_live_silent',
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'hidden',
        currentImageKey: 'img_silent_frame',
        currentImageSource: { imageKey: 'img_silent_frame', turnId: 'om_turn_silent' },
        currentTurnId: 'om_turn_user',
        silentScheduledTurns: new Map([['om_turn_silent', Date.now()]]),
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_live_silent'), makeDeps(sessions), APP_ID);
      await flush();
      expect(fakeLark.patches).toHaveLength(1);
      const card = parseCard(fakeLark.patches[0].args[2]);
      expect(card.imageKey).toBeNull();
      expect(card.screenshotUnavailable).toBe(true);
    });

    it('a cached frame with normal provenance is shown on a sleeping card', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_live_normal',
        worker: null,
        workerReady: false,
        workerPort: null,
        displayMode: 'hidden',
        currentImageKey: 'img_user_frame',
        currentImageSource: { imageKey: 'img_user_frame', turnId: 'om_turn_user' },
        currentTurnId: 'om_turn_user',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_live_normal'), makeDeps(sessions), APP_ID);
      await flush();
      expect(parseCard(fakeLark.patches[0].args[2])).toMatchObject({ imageKey: 'img_user_frame', screenshotUnavailable: false });
    });

    it('a legacy cache (no provenance) is withheld while the current turn is a substitute turn', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_sub_card',
        displayMode: 'hidden',
        currentImageKey: 'img_unknown_source',
        currentTurnId: 'om_turn_sub',
        currentReplyTarget: { rootMessageId: 'om_sub', turnId: 'om_turn_sub', updatedAt: new Date().toISOString(), substitute: true },
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const result = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_sub_card'), makeDeps(sessions), APP_ID);
      await flush();
      // Substitute turn declines the queue → callback, but without the image.
      expect(result).toMatchObject({ type: 'streaming', expanded: true, imageKey: null, screenshotUnavailable: true });
    });

    it('does not promise a fresh frame when the display-mode IPC cannot be delivered', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_ipc_broken', workerReady: true, displayMode: 'hidden', currentImageKey: undefined,
      });
      (ds.worker as any).send.mockImplementation(() => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_ipc_broken'), makeDeps(sessions), APP_ID);
      await flush();
      expect(fakeLark.patches).toHaveLength(1);
      expect(parseCard(fakeLark.patches[0].args[2])).toMatchObject({ expanded: true, screenshotUnavailable: true });
    });

    it('does not promise a fresh frame from an exited or disconnected worker', async () => {
      for (const broken of [{ connected: false }, { exitCode: 1 }, { signalCode: 'SIGKILL' }]) {
        fakeLark.reset();
        const ds = makeDaemonSession({
          streamCardId: 'om_worker_gone', workerReady: true, displayMode: 'hidden', currentImageKey: undefined,
        });
        Object.assign(ds.worker as any, broken);
        const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
        await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_worker_gone'), makeDeps(sessions), APP_ID);
        await flush();
        expect(parseCard(fakeLark.patches[0].args[2]), JSON.stringify(broken)).toMatchObject({ screenshotUnavailable: true });
      }
    });

    it('cross-turn: in-flight PATCH to old card A refuses a raw update of A but still queues the current card B', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_card_A',
        streamCardNonce: 'nonce_A',
        displayMode: 'hidden',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const deps = makeDeps(sessions);
      // A PATCH to A goes in flight…
      scheduleCardPatch(ds, buildStreamingCard(
        ds.session.sessionId, ROOT_ID, '', 'T', 'A content', 'working', 'claude-code', 'hidden' as any, 'nonce_A',
      ));
      await flush();
      expect(ds.cardPatchInFlightMessageId).toBe('om_card_A');
      // …then a new turn publishes B (A is frozen under its nonce).
      ds.frozenCards = new Map([['nonce_A', { messageId: 'om_card_A', content: '', title: 'T', displayMode: 'hidden' } as any]]);
      ds.streamCardId = 'om_card_B';
      ds.streamCardNonce = 'nonce_B';

      const onA = await handleCardAction(makeToggleEvent(ROOT_ID, 'nonce_A', 'ou_user', 'om_card_A'), deps, APP_ID);
      expect(onA).toEqual({ toast: { type: 'warning', content: '卡片正在更新，请稍后再点一次' } });
      expect(ds.displayMode).toBe('hidden');
      expect(ds.frozenCards!.has('nonce_A')).toBe(true);

      const onB = await handleCardAction(makeToggleEvent(ROOT_ID, 'nonce_B', 'ou_user', 'om_card_B'), deps, APP_ID);
      expect(onB).toEqual({ toast: { type: 'info', content: '操作已收到，后台处理中' } });
      expect(ds.pendingCardId).toBe('om_card_B');

      fakeLark.resolveCall('updateMessage', 0);
      await flush();
      expect(ds.cardPatchInFlightMessageId).toBe('om_card_B');
      expect(fakeLark.patches[1].args[1]).toBe('om_card_B');
      fakeLark.resolveCall('updateMessage', 1);
      await flush();
      expect(ds.cardPatchInFlight).toBe(false);
      expect(ds.cardPatchInFlightMessageId).toBeUndefined();

      // Once A is no longer in flight, the historical click repaints A.
      const retryA = await handleCardAction(makeToggleEvent(ROOT_ID, 'nonce_A', 'ou_user', 'om_card_A'), deps, APP_ID);
      expect(retryA).toMatchObject({ type: 'streaming', expanded: false });
    });

    it('rapid clicks on a sleeping current card stay serialized through the queue (latest wins)', async () => {
      const ds = makeDaemonSession({
        streamCardId: 'om_rapid', worker: null, workerReady: false, workerPort: null,
        displayMode: 'hidden', currentImageKey: 'img_cached',
      });
      const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
      const deps = makeDeps(sessions);
      const r1 = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_rapid'), deps, APP_ID);
      const r2 = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_rapid'), deps, APP_ID);
      const r3 = await handleCardAction(makeToggleEvent(ROOT_ID, NONCE_CURRENT, 'ou_user', 'om_rapid'), deps, APP_ID);
      for (const r of [r1, r2, r3]) expect(r).toEqual({ toast: { type: 'info', content: '操作已收到，后台处理中' } });
      expect(ds.displayMode).toBe('screenshot');
      // First click is in flight; the later two coalesce in the latest-wins slot.
      expect(fakeLark.patches).toHaveLength(1);
      expect(parseCard(fakeLark.patches[0].args[2])).toMatchObject({ expanded: true, imageKey: 'img_cached' });
      expect(parseCard(ds.pendingCardJson!)).toMatchObject({ expanded: true, imageKey: 'img_cached' });
      fakeLark.resolveCall('updateMessage', 0);
      await flush();
      // Final queued state equals the delivered one → adjacent duplicate dropped.
      expect(fakeLark.patches).toHaveLength(1);
      expect(ds.pendingCardJson).toBeUndefined();
      expect(ds.cardPatchInFlight).toBe(false);
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

// ─── Ported from Alex's independent acceptance review (round 1) ───────────
describe('Independent review: historical callback ordering', () => {
  beforeEach(() => {
    fakeLark.reset();
    vi.clearAllMocks();
  });

  it.each([false, true])('REVIEW historical double-click must keep last visible mode (known=%s)', async known => {
    const clickedId = 'om_review_historical_B';
    const ds = makeDaemonSession({
      streamCardId: 'om_review_current_A',
      streamCardNonce: NONCE_CURRENT,
      displayMode: 'hidden',
      worker: null,
      workerReady: false,
      workerPort: null,
      currentImageKey: 'img_review_cached',
      frozenCards: new Map(known ? [[NONCE_OLD, {
        messageId: clickedId, content: 'old output', title: 'old title', displayMode: 'hidden',
      }]] : []),
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);
    let visibleCard: any;

    const first = await handleCardAction(
      makeToggleEvent(ROOT_ID, NONCE_OLD, 'ou_user', clickedId), deps, APP_ID,
    );
    visibleCard = first; // Lark applies the first raw callback immediately.
    expect(visibleCard).toMatchObject({ expanded: true, cardNonce: NONCE_CURRENT });
    const olderPatch = fakeLark.patches[0];
    if (olderPatch) {
      expect(olderPatch.args[1]).toBe(clickedId);
      // Hold the first API PATCH so it can finish after the next callback.
      void olderPatch.promise.then(() => { visibleCard = parseCard(olderPatch.args[2]); });
    }

    const second = await handleCardAction(
      makeToggleEvent(ROOT_ID, visibleCard.cardNonce, 'ou_user', clickedId), deps, APP_ID,
    );
    visibleCard = second; // The newly rebased card's second click hides output.
    expect(visibleCard).toMatchObject({ expanded: false });
    expect(ds.displayMode).toBe('hidden');
    if (olderPatch) olderPatch.resolve();
    await flush();

    expect(ds.streamCardId).toBe('om_review_current_A');
    expect(visibleCard, 'older historical API PATCH must not undo the later hide callback')
      .toMatchObject({ expanded: false });
  });
});


// ─── Ported from Alex's R2 review (fixtures adjusted to capture_identity) ──
// capture_identity establishes the real capture identity; Alex's original
// turn_input_committed events stay in place as distractors.

describe('Independent review R2: capture identity vs display target', () => {
  beforeEach(() => {
    fakeLark.reset();
    vi.clearAllMocks();
  });

  async function livePool(overrides: Partial<DaemonSession>) {
    const pool = await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const ds = makeDaemonSession({ displayMode: 'screenshot', workerReady: true, ...overrides });
    const worker = ds.worker as any;
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();
    return { pool, ds, worker };
  }

  it('REVIEW R2 running predecessor must not paint a posted type-ahead successor', async () => {
    const { pool, ds, worker } = await livePool({
      streamCardId: 'om_review_card_A', streamCardNonce: 'nonce_review_A',
      currentTurnId: 'om_review_turn_A', streamCardTurnGeneration: 1, frozenCards: new Map(),
    });
    const reply = vi.fn(async () => 'om_review_card_B');
    pool.initWorkerPool({ sessionReply: reply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    pool.__testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'capture_identity', revision: 1, turnId: 'om_review_turn_A' });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_turn_A' }); // distractor
    await flush();
    expect(ds.captureIdentity).toMatchObject({ revision: 1, turnId: 'om_review_turn_A' });

    ds.currentTurnId = 'om_review_turn_B';
    ds.streamCardTurnGeneration = 2;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_review_turn_B';
    ds.currentImageKey = undefined;
    expect(await pool.postTurnStartingCard(ds, reply as any, 'om_review_turn_B')).toBe(true);
    await flush();
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardId).toBe('om_review_card_B');
    expect(ds.captureIdentity).toMatchObject({ revision: 1, turnId: 'om_review_turn_A' });
    fakeLark.reset();

    worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img_review_predecessor_A',
      status: 'working', turnId: 'om_review_turn_A', captureRevision: 1,
    });
    await flush();
    expect(fakeLark.patches.map(call => ({ messageId: call.args[1], imageKey: parseCard(call.args[2]).imageKey })))
      .not.toContainEqual({ messageId: 'om_review_card_B', imageKey: 'img_review_predecessor_A' });
    expect(ds.currentImageKey).toBeUndefined();

    // B's own write unlocks B's card.
    worker.emit('message', { type: 'capture_identity', revision: 2, turnId: 'om_review_turn_B' });
    worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img_review_B', status: 'working',
      turnId: 'om_review_turn_B', captureRevision: 2,
    });
    await flush();
    expect(ds.currentImageKey).toBe('img_review_B');
  });

  it('REVIEW R2 untagged frame must not expose a known suppressed managed attempt', async () => {
    const { pool, ds, worker } = await livePool({
      streamCardId: 'om_review_visible', streamCardNonce: NONCE_CURRENT,
      currentTurnId: 'om_review_prior_public',
      suppressedFinalOutputTurns: new Map([['trg_review_managed', 2]]),
    });
    pool.initWorkerPool({ sessionReply: vi.fn(async () => 'om_unused'), getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    pool.__testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'managed_turn_origin', sessionId: ds.session.sessionId, capability: 'test-cap', turnId: 'trg_review_managed', dispatchAttempt: 2 });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_review_managed' }); // distractor
    await flush();
    expect(ds.managedTurnOrigin).toMatchObject({ turnId: 'trg_review_managed', dispatchAttempt: 2 });
    // Legacy (pre-protocol) worker: no capture_identity, untagged frame.
    expect(ds.captureIdentity).toBeUndefined();
    expect(pool.screenshotSourceSuppressed(ds, 'trg_review_managed', 2)).toBe(true);
    fakeLark.reset();
    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_review_suppressed_untagged', status: 'working' });
    await flush();
    expect(ds.currentImageKey, 'known suppressed producer must fence even a legacy untagged frame').toBeUndefined();
    expect(fakeLark.patches).toHaveLength(0);
  });

  it('REVIEW R2 replayed old commit ACK must not disown current producer', async () => {
    const { pool, ds, worker } = await livePool({
      streamCardId: 'om_review_current_B', streamCardNonce: NONCE_CURRENT, currentTurnId: 'om_review_turn_B',
    });
    pool.initWorkerPool({ sessionReply: vi.fn(async () => 'om_unused'), getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    pool.__testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'capture_identity', revision: 1, turnId: 'om_review_turn_A' });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_turn_A' });
    worker.emit('message', { type: 'capture_identity', revision: 2, turnId: 'om_review_turn_B' });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_turn_B' });
    await flush();
    expect(ds.captureIdentity).toMatchObject({ revision: 2, turnId: 'om_review_turn_B' });
    // Re-ACK of already committed A (worker.ts deliberately re-ACKs duplicates).
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_turn_A' });
    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_review_current_B', status: 'working', turnId: 'om_review_turn_B', captureRevision: 2 });
    await flush();
    expect(ds.captureIdentity).toMatchObject({ revision: 2, turnId: 'om_review_turn_B' });
    expect(ds.currentImageKey, 'replayed historical receipt must not freeze current screenshots').toBe('img_review_current_B');
  });
});

// ─── Ported verbatim from Alex's R3 review ────────────────────────────────

describe('Independent review: R3 identity lifetime boundaries', () => {
  it.each(['om_review_previous_public', 'sch_review_private'])('REVIEW R3 initial empty replacement identity must not expose retained private pixels (lineage=%s)', async currentTurnId => {
    fakeLark.reset(); vi.clearAllMocks();
    const pool=await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const ds=makeDaemonSession({streamCardId:'om_review_public_card',displayMode:'screenshot',workerReady:true,currentTurnId,silentScheduledTurns:new Map([['sch_review_private',Date.now()]])});
    const attach=(worker:any)=>{worker.stdout=new EventEmitter();worker.stderr=new EventEmitter();ds.worker=worker;pool.__testOnly_setupWorkerHandlers(ds,worker);};
    pool.initWorkerPool({sessionReply:vi.fn(async()=> 'om_unused'),getSessionWorkingDir:()=>'/tmp',getActiveCount:()=>1,closeSession:vi.fn()});
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds),ds]]));
    const oldWorker=ds.worker as any; attach(oldWorker);
    oldWorker.emit('message',{type:'capture_identity',revision:3,turnId:'sch_review_private'});
    oldWorker.emit('message',{type:'capture_identity',revision:4});
    await flush();
    expect(ds.captureIdentity?.lastSource?.turnId).toBe('sch_review_private');
    oldWorker.emit('message',{type:'screenshot_uploaded',imageKey:'img_old_private',status:'idle',captureRevision:4});
    await flush();
    expect(ds.currentImageKey).toBeUndefined();

    // Worker restart/reattach keeps the persistent terminal's pixels. The new
    // process starts with revision0/empty, as required by the new protocol.
    const replacement=makeDaemonSession().worker as any; attach(replacement);
    replacement.emit('message',{type:'capture_identity',revision:0});
    replacement.emit('message',{type:'screenshot_uploaded',imageKey:'img_retained_private_pixels',status:'idle',captureRevision:0});
    await flush();
    expect(ds.currentImageKey,'changing worker generation does not prove old private pixels were cleared').toBeUndefined();
    expect(fakeLark.patches).toHaveLength(0);
  });

  it('REVIEW R3 missing current ID must not bypass a waiting target before proven recovery', async () => {
    fakeLark.reset(); vi.clearAllMocks();
    const pool=await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const ds=makeDaemonSession({streamCardId:'om_review_original_A',streamCardNonce:'nonce_A',displayMode:'hidden',workerReady:true,currentTurnId:'om_review_turn_A',streamCardTurnGeneration:1,frozenCards:new Map()});
    const worker=ds.worker as any;worker.stdout=new EventEmitter();worker.stderr=new EventEmitter();
    const reply=vi.fn(async()=> 'om_review_waiting_B');
    pool.initWorkerPool({sessionReply:reply,getSessionWorkingDir:()=>'/tmp',getActiveCount:()=>1,closeSession:vi.fn()});
    const sessions=new Map([[activeSessionKey(ds),ds]]);pool.setActiveSessionsRegistry(sessions);
    pool.__testOnly_setupWorkerHandlers(ds,worker);
    worker.emit('message',{type:'capture_identity',revision:1,turnId:'om_review_turn_A'});
    ds.currentTurnId='om_review_turn_B';ds.streamCardTurnGeneration=2;ds.streamCardPending=true;ds.streamCardPendingTurnId='om_review_turn_B';
    await pool.postTurnStartingCard(ds,reply as any,'om_review_turn_B');await flush();
    expect(ds.streamCardDisplayTarget).toMatchObject({messageId:'om_review_waiting_B',mode:'waiting-exact-turn',turnId:'om_review_turn_B'});
    const proof=ds.lastPublishedStreamingCardIdentity!;
    ds.streamCardId=undefined; // The exact publication proof remains recoverable.
    worker.emit('message',{type:'screenshot_uploaded',imageKey:'img_predecessor_during_missing_id',status:'working',turnId:'om_review_turn_A',captureRevision:1});
    await flush();
    fakeLark.reset();
    const event=makeToggleEvent(proof.anchorId,proof.nonce,'ou_user',proof.messageId);
    (event.action.value as any).session_id=ds.session.sessionId;
    await handleCardAction(event,makeDeps(sessions),APP_ID);await flush();
    expect(ds.streamCardId).toBe(proof.messageId);
    expect(fakeLark.patches.map(call=>({messageId:call.args[1],imageKey:parseCard(call.args[2]).imageKey})))
      .not.toContainEqual({messageId:proof.messageId,imageKey:'img_predecessor_during_missing_id'});
  });
});

// ─── Ported verbatim from Alex's R4 review ────────────────────────────────

describe('Independent review: R4 waiting target during manual repost', () => {
  it('REVIEW R4 held manual POST must not cache predecessor frame for waiting successor', async () => {
    fakeLark.reset(); vi.clearAllMocks();
    const pool=await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const ds=makeDaemonSession({streamCardId:'om_review_live_A',streamCardNonce:'nonce_A',displayMode:'screenshot',workerReady:true,currentTurnId:'om_review_turn_A',streamCardTurnGeneration:1,frozenCards:new Map()});
    const worker=ds.worker as any;worker.stdout=new EventEmitter();worker.stderr=new EventEmitter();
    const reply=vi.fn(async()=> 'om_review_waiting_B');
    pool.initWorkerPool({sessionReply:reply,getSessionWorkingDir:()=>'/tmp',getActiveCount:()=>1,closeSession:vi.fn()});
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds),ds]]));
    pool.__testOnly_setupWorkerHandlers(ds,worker);
    worker.emit('message',{type:'capture_identity',revision:1,turnId:'om_review_turn_A'});
    ds.currentTurnId='om_review_turn_B';ds.streamCardTurnGeneration=2;ds.streamCardPending=true;ds.streamCardPendingTurnId='om_review_turn_B';
    await pool.postTurnStartingCard(ds,reply as any,'om_review_turn_B');await flush();
    expect(ds.streamCardDisplayTarget).toMatchObject({messageId:'om_review_waiting_B',mode:'waiting-exact-turn',turnId:'om_review_turn_B'});
    expect(ds.streamCardPending).toBe(false);
    let resolveManual!: (id:string)=>void;
    const manualReply=vi.fn(()=> new Promise<string>(resolve=>{resolveManual=resolve;}));
    const manualPost=pool.postFreshStreamingCard(ds,manualReply as any);
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);
    expect(ds.streamCardPending).toBe(false);
    worker.emit('message',{type:'screenshot_uploaded',imageKey:'img_A_during_B_repost',status:'working',turnId:'om_review_turn_A',captureRevision:1});
    await flush();
    resolveManual('om_review_waiting_B_repost');
    expect(await manualPost).toBe(true);await flush();
    expect(ds.streamCardDisplayTarget).toMatchObject({messageId:'om_review_waiting_B_repost',mode:'waiting-exact-turn',turnId:'om_review_turn_B'});
    fakeLark.reset();
    // The next ordinary screen render uses the daemon's cached image key.
    worker.emit('message',{type:'screen_update',content:'A completed before queued B starts',status:'idle',turnId:'om_review_turn_A'});
    await flush();
    expect(fakeLark.patches.map(call=>({messageId:call.args[1],imageKey:parseCard(call.args[2]).imageKey})))
      .not.toContainEqual({messageId:'om_review_waiting_B_repost',imageKey:'img_A_during_B_repost'});
    expect(ds.currentImageKey).toBeUndefined();
  });
});

// ─── Ported verbatim from Alex's R5 review ────────────────────────────────

describe('Independent review: R5 failed repost activation', () => {
  it.each([false, true])('REVIEW R5 own turn activated during failed manual POST must unlock restored card (D before rollback=%s)', async dStartsBeforeRollback => {
    fakeLark.reset(); vi.clearAllMocks();
    const pool=await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const ds=makeDaemonSession({streamCardId:'om_review_A',streamCardNonce:'nonce_A',displayMode:'screenshot',workerReady:true,currentTurnId:'om_review_A_turn',streamCardTurnGeneration:1,frozenCards:new Map()});
    const worker=ds.worker as any;worker.stdout=new EventEmitter();worker.stderr=new EventEmitter();
    const reply=vi.fn(async()=> 'om_review_B');
    pool.initWorkerPool({sessionReply:reply,getSessionWorkingDir:()=>'/tmp',getActiveCount:()=>1,closeSession:vi.fn()});
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds),ds]]));
    pool.__testOnly_setupWorkerHandlers(ds,worker);
    worker.emit('message',{type:'capture_identity',revision:1,turnId:'om_review_A_turn'});
    ds.currentTurnId='om_review_B_turn';ds.streamCardTurnGeneration=2;ds.streamCardPending=true;ds.streamCardPendingTurnId='om_review_B_turn';
    await pool.postTurnStartingCard(ds,reply as any,'om_review_B_turn');await flush();
    expect(ds.streamCardDisplayTarget?.mode).toBe('waiting-exact-turn');
    let rejectPost!:(error:Error)=>void;
    const held=vi.fn(()=>new Promise<string>((_resolve,reject)=>{rejectPost=reject;}));
    const repost=pool.postFreshStreamingCard(ds,held as any);
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);
    // B really starts while its manual successor is still being POSTed.
    worker.emit('message',{type:'capture_identity',revision:2,turnId:'om_review_B_turn'});
    worker.emit('message',{type:'screenshot_uploaded',imageKey:'img_review_B',status:'working',turnId:'om_review_B_turn',captureRevision:2});
    await flush();
    expect(ds.currentImageKey).toBe('img_review_B');
    if (dStartsBeforeRollback) {
      worker.emit('message',{type:'capture_identity',revision:3,turnId:'trg_review_D'});
      await flush();
      expect(ds.captureIdentity?.turnId).toBe('trg_review_D');
    }
    rejectPost(new Error('review simulated transient POST failure'));
    expect(await repost).toBe(false);await flush();
    expect(ds.streamCardId).toBe('om_review_B');
    fakeLark.reset();
    // B matched during the reservation. In the second case D is already current
    // when rollback happens, so rechecking only the current tuple is too late.
    if (!dStartsBeforeRollback) worker.emit('message',{type:'capture_identity',revision:3,turnId:'trg_review_D'});
    worker.emit('message',{type:'screenshot_uploaded',imageKey:'img_review_D',status:'working',turnId:'trg_review_D',captureRevision:3});
    await flush();
    expect(ds.currentImageKey,'restoring the prior message must retain B activation observed during POST').toBe('img_review_D');
    expect(fakeLark.patches.map(call=>({messageId:call.args[1],imageKey:parseCard(call.args[2]).imageKey})))
      .toContainEqual({messageId:'om_review_B',imageKey:'img_review_D'});
  });
});
