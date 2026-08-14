/**
 * Tests for adopt-related card actions: disconnect, takeover, and adopt_select dropdown.
 *
 * Covers:
 *   1. disconnect should kill worker and remove session
 *   2. takeover should kill adopt worker, clear adoptedFrom, forkWorker with resume
 *   3. takeover without sessionId should show error
 *   4. adopt_select dropdown should call startAdoptSession
 *   5. adopt_select with expired target should show error
 *
 * Run:  pnpm vitest run test/session-adopt.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getMessageDetail: vi.fn(async () => ({
    items: [{ chat_id: 'oc_chat', thread_id: 'omt_adopt_picker' }],
  })),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(
    (_sid: string, _rid: string, _url: string, _title: string, content: string, status: string, _cliId: string, expanded?: boolean, cardNonce?: string) =>
      JSON.stringify({ type: 'streaming', expanded: !!expanded, content, status, cardNonce }),
  ),
  buildSessionCard: vi.fn(
    (_sid: string, _rid: string, _url: string, _title: string, _cliId: string) =>
      JSON.stringify({ type: 'session', url: _url }),
  ),
  buildAdoptSelectCard: vi.fn(() => JSON.stringify({ type: 'adopt_select' })),
  // Confirm path dynamically imports adoptLiveKey to map a freshly-discovered
  // session back to the clicked entry_key — mirror the real key format.
  // zellij is pid-AGNOSTIC on purpose (see adoptLiveKey doc / fix 57dcbebbb):
  // the key must stay stable across a render→confirm pid shift.
  adoptLiveKey: vi.fn((s: any) =>
    'zellijPaneId' in s
      ? `live:zellij:${s.zellijSession}/${s.zellijPaneId}`
      : `live:tmux:${s.tmuxTarget}:${s.cliPid}`,
  ),
  buildCodexAppThreadSelectCard: vi.fn(() => JSON.stringify({ type: 'codex_app_thread_select' })),
  buildAdoptBlockedCard: vi.fn((rootId: string, sessionId: string, cliId?: string) => JSON.stringify({
    type: 'adopt_blocked',
    elements: [{ tag: 'action', actions: [{ tag: 'button', value: { action: 'close', root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' } }] }],
  })),
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
  getBotBrand: vi.fn(() => 'feishu'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  getSession: vi.fn(),
  getOwnedSession: vi.fn(),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/services/codex-app-threads.js', () => ({
  listCodexAppThreads: vi.fn(async () => []),
}));

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...orig,
    forkWorker: vi.fn(),
    forkAdoptWorker: vi.fn(),
    killWorker: vi.fn(),
    initWorkerPool: vi.fn(),
    // The disconnect card action delegates to the authoritative closeSession.
    // The real one awaits a worker close-fence (never resolves under a mock
    // worker) and persistent-backing teardown, so model its observable
    // contract instead: kill the worker, persist the close (owner-scoped),
    // and evict from the shared registry.
    closeSession: vi.fn(async (sessionId: string) => {
      const store = await import('../src/services/session-store.js');
      const reg = orig.getActiveSessionsRegistry?.();
      let hadLiveWorker = false;
      if (reg) {
        for (const [k, v] of reg as Map<string, any>) {
          if (v?.session?.sessionId === sessionId) {
            hadLiveWorker = !!v.worker && !v.worker.killed;
            try { v.worker?.send?.({ type: 'close' }); } catch { /* mock */ }
            (reg as Map<string, any>).delete(k);
            break;
          }
        }
      }
      const stored = store.getOwnedSession(sessionId);
      if (stored && stored.status !== 'closed') {
        store.closeSession(sessionId, { cleanupBridgeMarkers: !hadLiveWorker });
      }
      return { ok: true, alreadyClosed: false, known: !!stored };
    }),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  ensureSessionWhiteboard: vi.fn(),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  expandHome: vi.fn((p: string) => p),
  getProjectScanDir: vi.fn(() => '/tmp'),
  getProjectScanDirs: vi.fn(() => ['/tmp']),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn((ds: any, userPrompt: string, cliInput: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = cliInput;
  }),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { killWorker, forkWorker, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { deleteMessage, getMessageDetail } from '../src/im/lark/client.js';
import { getBot } from '../src/bot-registry.js';
import { listCodexAppThreads } from '../src/services/codex-app-threads.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const APP_ID = 'app_test';
const ROOT_ID = 'om_root_adopt';

function makeDaemonSession(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'uuid-adopt-test',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      title: 'Adopt Test',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: { killed: false, send: vi.fn(), once: vi.fn() } as any,
    workerPort: 8080,
    workerToken: 'tok_secret',
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ...overrides,
  };
}

function makeDeps(activeSessions: Map<string, DaemonSession>): CardHandlerDeps {
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'om_reply_1'),
    lastRepoScan: new Map(),
  };
}

function makeDisconnectEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'disconnect', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

function makeTakeoverEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'takeover', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

function makeAdoptSelectEvent(rootId: string, entryKey: string, operatorOpenId = 'ou_user') {
  // V2 picker: confirm carries the synthetic entry_key (live:<adoptTargetKey>
  // or resume:<cliSessionId>) rather than a JSON-encoded option string.
  return {
    action: {
      value: { action: 'adopt_confirm', entry_key: entryKey, root_id: rootId },
    },
    operator: { open_id: operatorOpenId },
    context: { open_message_id: 'om_card_msg' },
  };
}

function makeCodexAppThreadSelectEvent(rootId: string, selectedValue: string, operatorOpenId = 'ou_user') {
  return {
    action: {
      option: selectedValue,
      value: { key: 'codex_app_thread_select', root_id: rootId },
    },
    operator: { open_id: operatorOpenId },
    context: { open_message_id: 'om_card_msg' },
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Adopt card actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
    } as any);
    vi.mocked(listCodexAppThreads).mockResolvedValue([]);
    vi.mocked(getMessageDetail).mockResolvedValue({
      items: [{ chat_id: 'oc_chat', thread_id: 'omt_adopt_picker' }],
    });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────

  describe('disconnect action', () => {
    it('should kill worker, close session, and remove from activeSessions', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: '0:1.0',
          originalCliPid: 12345,
          cwd: '/home/user/project',
        },
      });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);
      const worker = ds.worker as any;
      vi.mocked(sessionStore.getSession).mockReturnValue(ds.session);
      // The authoritative worker-pool closeSession consults getOwnedSession
      // (owner-scoped) to decide whether to persist the close.
      vi.mocked(sessionStore.getOwnedSession).mockReturnValue(ds.session);
      setActiveSessionsRegistry(sessions);

      try {
        await handleCardAction(makeDisconnectEvent(ROOT_ID), deps, APP_ID);

        expect(worker.send).toHaveBeenCalledWith({ type: 'close' });
        // A live adopt worker → closeSession persists with cleanupBridgeMarkers:false.
        expect(sessionStore.closeSession).toHaveBeenCalledWith('uuid-adopt-test', { cleanupBridgeMarkers: false });
        expect(sessions.has(sKey)).toBe(false);
        expect(deps.sessionReply).toHaveBeenCalledWith(
          ROOT_ID,
          expect.stringContaining('断开'),
          undefined,
          APP_ID,
        );
      } finally {
        setActiveSessionsRegistry(new Map());
      }
    });

    it('should be a no-op when session does not exist', async () => {
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      await handleCardAction(makeDisconnectEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
    });
  });

  // ── Takeover ────────────────────────────────────────────────────────────

  describe('takeover action (legacy button — disabled in v3 bridge)', () => {
    // The v3 adopt-bridge refactor retired the legacy "接管" button:
    // bridge mode forwards Claude's final answers via the transcript
    // watcher without killing or replacing the user's CLI. New cards no
    // longer render the button (showTakeover=false in worker-pool), but
    // historical PATCHed cards may still expose it — the handler must
    // refuse the action so a stray click can't kill the user's CLI.

    it('legacy takeover with sessionId is now a no-op (no kill / no fork)', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: '0:1.0',
          originalCliPid: 12345,
          sessionId: 'claude-session-xyz',
          cliId: 'claude-code',
          cwd: '/home/user/project',
          paneCols: 200,
          paneRows: 50,
        },
      });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeTakeoverEvent(ROOT_ID), deps, APP_ID);

      // Critically: must NOT kill worker, must NOT fork a new one,
      // must NOT touch adoptedFrom or session id.
      expect(killWorker).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.adoptedFrom).toBeDefined();
      expect(ds.session.sessionId).toBe('uuid-adopt-test');
      expect(sessionStore.closeSession).not.toHaveBeenCalled();

      // Should reply with the deprecation notice
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('停用'),
        undefined,
        APP_ID,
      );
    });

    it('legacy takeover without sessionId is also a no-op', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: '0:1.0',
          originalCliPid: 12345,
          cwd: '/home/user/project',
        },
      });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeTakeoverEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
    });

    it('should be a no-op when session has no adoptedFrom', async () => {
      const ds = makeDaemonSession(); // No adoptedFrom
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeTakeoverEvent(ROOT_ID), deps, APP_ID);

      // takeover guard: ds.adoptedFrom is falsy, so handler is skipped
      expect(killWorker).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
    });
  });

  // ── adopt_confirm (V2 picker) ─────────────────────────────────────────

  describe('adopt_confirm (live)', () => {
    it('should show error when target CLI has exited', async () => {
      // Mock discoverAdoptableSessions to return empty (target gone)
      vi.doMock('../src/core/session-discovery.js', () => ({
        discoverAdoptableSessions: vi.fn(() => []),
        // 单 pane 快路径同样解析不到（pane 已经没了），card-handler 会回落全量扫描。
        discoverAdoptableSessionByTarget: vi.fn(() => undefined),
        excludeOwnedHerdrAdoptTargets: vi.fn((sessions: unknown[]) => sessions),
        adoptTargetKey: vi.fn((s: any) => `tmux:${s.tmuxTarget}:${s.cliPid}`),
        adoptTargetLabel: vi.fn(() => ''),
      }));

      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      // entry_key format = "live:" + adoptTargetKey = "live:tmux:0:1.0:99999".
      await handleCardAction(makeAdoptSelectEvent(ROOT_ID, 'live:tmux:0:1.0:99999'), deps, APP_ID);
      await flush();

      expect(getMessageDetail).toHaveBeenCalledWith(APP_ID, 'om_card_msg');
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('已退出'),
        undefined,
        APP_ID,
        undefined,
        { replyTarget: { mode: 'thread', rootMessageId: 'om_card_msg' } },
      );
      expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card_msg');

      vi.doUnmock('../src/core/session-discovery.js');
    });

    it('falls back to the legacy route when the picker placement probe fails', async () => {
      vi.doMock('../src/core/session-discovery.js', () => ({
        discoverAdoptableSessions: vi.fn(() => []),
        discoverAdoptableSessionByTarget: vi.fn(() => undefined),
        excludeOwnedHerdrAdoptTargets: vi.fn((sessions: unknown[]) => sessions),
        adoptTargetKey: vi.fn((s: any) => `tmux:${s.tmuxTarget}:${s.cliPid}`),
        adoptTargetLabel: vi.fn(() => ''),
      }));
      vi.mocked(getMessageDetail).mockRejectedValueOnce(new Error('placement unavailable'));
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), makeDaemonSession());
      const deps = makeDeps(sessions);

      await handleCardAction(makeAdoptSelectEvent(ROOT_ID, 'live:tmux:0:1.0:99999'), deps, APP_ID);
      await flush();

      expect(deps.sessionReply).toHaveBeenCalled();
      expect(vi.mocked(deps.sessionReply).mock.calls[0]?.[5]).toBeUndefined();
      expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card_msg');

      vi.doUnmock('../src/core/session-discovery.js');
    });

    it('freezes a top-level picker confirmation to its trusted chat', async () => {
      vi.doMock('../src/core/session-discovery.js', () => ({
        discoverAdoptableSessions: vi.fn(() => []),
        discoverAdoptableSessionByTarget: vi.fn(() => undefined),
        excludeOwnedHerdrAdoptTargets: vi.fn((sessions: unknown[]) => sessions),
        adoptTargetKey: vi.fn((s: any) => `tmux:${s.tmuxTarget}:${s.cliPid}`),
        adoptTargetLabel: vi.fn(() => ''),
      }));
      vi.mocked(getMessageDetail).mockResolvedValueOnce({ items: [{ chat_id: 'oc_chat' }] });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), makeDaemonSession());
      const deps = makeDeps(sessions);

      await handleCardAction(makeAdoptSelectEvent(ROOT_ID, 'live:tmux:0:1.0:99999'), deps, APP_ID);
      await flush();

      expect(vi.mocked(deps.sessionReply).mock.calls[0]?.[5]).toEqual({
        replyTarget: { mode: 'plain', chatId: 'oc_chat' },
      });

      vi.doUnmock('../src/core/session-discovery.js');
    });

    it('should return early when entry_key or rootId is missing', async () => {
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const event = {
        action: {
          value: { action: 'adopt_confirm', entry_key: 'live:tmux:0:1.0:123' }, // No root_id
        },
        operator: { open_id: 'ou_user' },
      };

      await handleCardAction(event, deps, APP_ID);
      await flush();

      // Should silently return without error
      expect(killWorker).not.toHaveBeenCalled();
    });
  });

  describe('codex-app thread select', () => {
    it('should resume selected Codex App thread without adopt metadata', async () => {
      vi.mocked(getBot).mockReturnValue({
        config: {
          larkAppId: APP_ID,
          larkAppSecret: 'secret',
          cliId: 'codex-app',
          cliPathOverride: '/opt/codex',
        },
        resolvedAllowedUsers: [],
        botOpenId: 'ou_bot',
      } as any);
      vi.mocked(listCodexAppThreads).mockResolvedValueOnce([
        {
          threadId: 'thread-1',
          name: 'Existing Codex App thread',
          preview: 'preview',
          cwd: '/repo/codex-app',
          updatedAtMs: 1780000000000,
        },
      ]);
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      const selectedValue = JSON.stringify({ threadId: 'thread-1' });
      await handleCardAction(makeCodexAppThreadSelectEvent(ROOT_ID, selectedValue), deps, APP_ID);
      await flush();

      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.workingDir).toBe('/repo/codex-app');
      expect(ds.session.cliSessionId).toBe('thread-1');
      expect(ds.session.cliId).toBe('codex-app');
      expect(ds.session.adoptedFrom).toBeUndefined();
      expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
      expect(forkWorker).toHaveBeenCalledWith(ds, '', true);
      expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card_msg');
    });

    it('refuses a Codex App thread takeover while the session is still on the pendingRepo gate', async () => {
      vi.mocked(getBot).mockReturnValue({
        config: {
          larkAppId: APP_ID,
          larkAppSecret: 'secret',
          cliId: 'codex-app',
          cliPathOverride: '/opt/codex',
        },
        resolvedAllowedUsers: [],
        botOpenId: 'ou_bot',
      } as any);
      vi.mocked(listCodexAppThreads).mockResolvedValueOnce([
        {
          threadId: 'thread-1',
          name: 'Existing Codex App thread',
          preview: 'preview',
          cwd: '/repo/codex-app',
          updatedAtMs: 1780000000000,
        },
      ]);
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: 'buffered' });
      const sessions = new Map<string, DaemonSession>();
      sessions.set(sessionKey(ROOT_ID, APP_ID), ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeCodexAppThreadSelectEvent(ROOT_ID, JSON.stringify({ threadId: 'thread-1' })), deps, APP_ID);
      await flush();

      // Refused: no takeover, pending gate untouched.
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.pendingRepo).toBe(true);
      expect(ds.session.cliSessionId).not.toBe('thread-1');
    });
  });

  // ── blocker #3: startAdoptSession fail-closes at the ENTRY for sandbox bots ──
  // Both real host-process adopt entries (/adopt <pane> and the adopt_select
  // card) route through startAdoptSession, so guarding it covers both. The
  // guard fires FIRST — before target validation or any state mutation — so
  // `adoptedFrom` is never persisted and "adopted" is never replied.
  describe('startAdoptSession sandbox guard (entry point)', () => {
    const target = {
      source: 'tmux' as const,
      tmuxTarget: '0:1.0',
      cliPid: 4242,
      sessionId: 'host-cli',
      cliId: 'claude-code' as const,
      cwd: '/repo',
      paneCols: 80,
      paneRows: 24,
    };

    it('sandbox:true bot → replies the sandbox-blocked notice, never persists adoptedFrom', async () => {
      vi.mocked(getBot).mockReturnValue({
        config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', sandbox: true },
        resolvedAllowedUsers: [], botOpenId: 'ou_bot',
      } as any);
      const { startAdoptSession } = await import('../src/core/command-handler.js');
      const ds = makeDaemonSession();
      const deps = makeDeps(new Map());

      await startAdoptSession(target, ds, deps as any, APP_ID);

      // guard fired before validation/mutation
      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.session.adoptedFrom).toBeUndefined();
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      const replies = (deps.sessionReply as any).mock.calls.map((c: any[]) => c[1]).join('\n');
      expect(replies).toContain('文件沙盒'); // the sandbox_blocked notice
      expect(replies).not.toContain('已接入'); // never the success message
    });

    it('readIsolation / global BOTMUX_SANDBOX / session frozen decision all block via the shared predicate (union)', async () => {
      const { adoptSandboxBlocked } = await import('../src/core/worker-pool.js');
      expect(adoptSandboxBlocked({ readIsolation: true })).toBe(true);
      expect(adoptSandboxBlocked({ sandbox: true })).toBe(true);
      expect(adoptSandboxBlocked({})).toBe(false);
      // session's FROZEN decision blocks even when the live bot flag is OFF
      // (forkWorker treats the frozen decision as authoritative).
      expect(adoptSandboxBlocked({ sandbox: false }, { sandbox: true })).toBe(true);
      expect(adoptSandboxBlocked({}, { sandbox: false })).toBe(false);
      vi.stubEnv('BOTMUX_SANDBOX', '1');
      expect(adoptSandboxBlocked({})).toBe(true);
      vi.unstubAllEnvs();
    });
  });
});
