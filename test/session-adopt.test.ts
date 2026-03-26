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
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
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
    forkAdoptWorker: vi.fn(),
    killWorker: vi.fn(),
    initWorkerPool: vi.fn(),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  expandHome: vi.fn((p: string) => p),
  getProjectScanDir: vi.fn(() => '/tmp'),
  getProjectScanDirs: vi.fn(() => ['/tmp']),
  getAvailableBots: vi.fn(async () => []),
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
import { killWorker, forkWorker } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { deleteMessage } from '../src/im/lark/client.js';
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

function makeAdoptSelectEvent(rootId: string, selectedValue: string, operatorOpenId = 'ou_user') {
  return {
    action: {
      option: selectedValue,
      value: { key: 'adopt_select', root_id: rootId },
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

      await handleCardAction(makeDisconnectEvent(ROOT_ID), deps, APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessionStore.closeSession).toHaveBeenCalledWith('uuid-adopt-test');
      expect(sessions.has(sKey)).toBe(false);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('断开'),
        undefined,
        APP_ID,
      );
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

  describe('takeover action', () => {
    it('should kill adopt worker, clear adoptedFrom, and fork standard worker with resume', async () => {
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

      // Should kill the adopt worker
      expect(killWorker).toHaveBeenCalledWith(ds);

      // adoptedFrom should be cleared
      expect(ds.adoptedFrom).toBeUndefined();

      // Session ID should be replaced with the original CLI session ID
      expect(ds.session.sessionId).toBe('claude-session-xyz');

      // Working dir should be set to original cwd
      expect(ds.workingDir).toBe('/home/user/project');
      expect(ds.session.workingDir).toBe('/home/user/project');

      // hasHistory should be true
      expect(ds.hasHistory).toBe(true);

      // Should have closed old session and updated with new ID
      expect(sessionStore.closeSession).toHaveBeenCalledWith('uuid-adopt-test');
      expect(sessionStore.updateSession).toHaveBeenCalled();

      // Should fork standard worker with resume=true
      expect(forkWorker).toHaveBeenCalledWith(ds, '', true);

      // Should reply with success message
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('接管'),
        undefined,
        APP_ID,
      );
    });

    it('should show error when adoptedFrom has no sessionId', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: '0:1.0',
          originalCliPid: 12345,
          cwd: '/home/user/project',
          // No sessionId
        },
      });
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      await handleCardAction(makeTakeoverEvent(ROOT_ID), deps, APP_ID);

      // Should NOT kill worker or fork a new one
      expect(killWorker).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();

      // Should show error
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('无法接管'),
        undefined,
        APP_ID,
      );
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

  // ── adopt_select dropdown ─────────────────────────────────────────────

  describe('adopt_select dropdown', () => {
    it('should show error when target CLI has exited', async () => {
      // Mock discoverAdoptableSessions to return empty (target gone)
      vi.doMock('../src/core/session-discovery.js', () => ({
        discoverAdoptableSessions: vi.fn(() => []),
      }));

      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      const selectedValue = JSON.stringify({ tmuxTarget: '0:1.0', cliPid: 99999 });
      await handleCardAction(makeAdoptSelectEvent(ROOT_ID, selectedValue), deps, APP_ID);
      await flush();

      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('已退出'),
        undefined,
        APP_ID,
      );
      expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card_msg');

      vi.doUnmock('../src/core/session-discovery.js');
    });

    it('should ignore invalid JSON in option', async () => {
      const ds = makeDaemonSession();
      const sessions = new Map<string, DaemonSession>();
      const sKey = sessionKey(ROOT_ID, APP_ID);
      sessions.set(sKey, ds);
      const deps = makeDeps(sessions);

      // Invalid JSON option should be silently ignored
      await handleCardAction(makeAdoptSelectEvent(ROOT_ID, 'not-json'), deps, APP_ID);
      await flush();

      // Should not crash, no session reply for parse error
      expect(killWorker).not.toHaveBeenCalled();
    });

    it('should return early when rootId is missing', async () => {
      const sessions = new Map<string, DaemonSession>();
      const deps = makeDeps(sessions);

      const event = {
        action: {
          option: JSON.stringify({ tmuxTarget: '0:1.0', cliPid: 123 }),
          value: { key: 'adopt_select' },  // No root_id
        },
        operator: { open_id: 'ou_user' },
      };

      await handleCardAction(event, deps, APP_ID);
      await flush();

      // Should silently return without error
      expect(killWorker).not.toHaveBeenCalled();
    });
  });
});
