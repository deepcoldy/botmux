/**
 * The /adopt confirm path never reaches the live-name enrichment
 * (services/adopt-live-enrich). Split from test/adopt-live-enrich.test.ts
 * because it re-points modules mid-file (vi.mock with the real module,
 * vi.doMock, vi.resetModules), which only vitest supports; the main file can
 * then run on the bun test leg too.
 *
 * Run:  bunx vitest run --project unit test/adopt-live-enrich-confirm.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real module, with its entry point wrapped in a spy so the confirm-path
// test at the bottom can prove the enrichment is never reached from there.
vi.mock('../src/services/adopt-live-enrich.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/adopt-live-enrich.js')>('../src/services/adopt-live-enrich.js');
  return { ...actual, enrichAdoptLiveSessions: vi.fn(actual.enrichAdoptLiveSessions) };
});

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'adopt-live-enrich-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── Confirm path ──────────────────────────────────────────────────────────
// Keep this block LAST in the file: it calls vi.resetModules() and doMocks the
// card-handler graph, so anything added below would see fresh module instances.

describe('adopt_confirm (live) never enriches', () => {
  it('re-discovers exactly as before (four scans for a vanished pane) without calling the enrichment', async () => {
    const discover = vi.fn(() => []);
    vi.doMock('../src/core/session-discovery.js', () => ({
      discoverAdoptableSessions: discover,
      discoverAdoptableSessionByTarget: vi.fn(() => undefined),
      excludeOwnedHerdrAdoptTargets: (sessions: unknown[]) => sessions,
      adoptTargetKey: (s: any) => `herdr:${s.herdrSessionName}:${s.herdrPaneId}`,
      adoptTargetLabel: (s: any) => `${s.herdrSessionName}:${s.herdrPaneId}`,
    }));
    vi.doMock('../src/core/zellij-adopt-discovery.js', () => ({ discoverAdoptableZellijSessions: vi.fn(() => []) }));
    vi.doMock('../src/im/lark/client.js', () => ({
      updateMessage: vi.fn(async () => {}),
      sendUserMessage: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => {}),
      getMessageDetail: vi.fn(async () => ({ items: [{ chat_id: 'oc_chat', thread_id: 'omt_picker' }] })),
      getChatInfo: vi.fn(),
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    vi.doMock('../src/bot-registry.js', () => ({
      getBot: vi.fn(() => ({
        config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
        resolvedAllowedUsers: [],
        resolvedBlockedUsers: [],
        botOpenId: 'ou_bot',
      })),
      getAllBots: vi.fn(() => []),
      getBotClient: vi.fn(),
      getBotBrand: vi.fn(() => 'feishu'),
      getOwnerOpenId: vi.fn(() => undefined),
    }));
    vi.doMock('../src/config.js', () => ({
      config: {
        web: { externalHost: 'localhost' },
        session: { dataDir: join(dataDir, 'sessions') },
        daemon: { backendType: 'pty', cliId: 'claude-code' },
      },
    }));
    vi.doMock('../src/services/session-store.js', () => ({
      getSession: vi.fn(),
      getOwnedSession: vi.fn(),
      registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
      cleanupSessionBridgeSendMarkers: vi.fn(),
      cleanupSessionBridgeSendMarkersNow: vi.fn(),
      closeSession: vi.fn(),
      updateSession: vi.fn(),
      createSession: vi.fn(),
      collectBotmuxSessionIdentities: vi.fn(() => new Set<string>()),
    }));
    vi.doMock('../src/core/session-manager.js', () => ({
      getSessionWorkingDir: vi.fn(() => '/tmp'),
      ensureSessionWhiteboard: vi.fn(),
      buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
      expandHome: vi.fn((p: string) => p),
      getProjectScanDir: vi.fn(() => '/tmp'),
      getProjectScanDirs: vi.fn(() => ['/tmp']),
      getAvailableBots: vi.fn(async () => []),
      rememberLastCliInput: vi.fn(),
      persistStreamCardState: vi.fn(),
    }));
    vi.doMock('../src/services/frozen-card-store.js', () => ({
      loadFrozenCards: vi.fn(() => new Map()),
      saveFrozenCards: vi.fn(),
    }));
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      Client: class {},
      WSClient: class { start() {} },
      EventDispatcher: class { register() {} },
      LoggerLevel: { info: 2 },
    }));
    try {
      // Re-evaluate the card-handler graph so every doMock above applies, even to
      // a module some earlier import already loaded.
      vi.resetModules();
      const { handleCardAction } = await import('../src/im/lark/card-handler.js');
      const { sessionKey } = await import('../src/core/types.js');
      const { enrichAdoptLiveSessions: enrichSpy } = await import('../src/services/adopt-live-enrich.js');
      const rootId = 'om_root_confirm';
      const ds: any = {
        session: {
          sessionId: 'uuid-confirm-test', rootMessageId: rootId, chatId: 'oc_chat', title: 'Adopt Test',
          status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group',
        },
        worker: { killed: false, send: vi.fn(), once: vi.fn() },
        larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'group',
        spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: false,
      };
      const activeSessions = new Map([[sessionKey(rootId, 'app_test'), ds]]);
      const sessionReply = vi.fn(async () => 'om_reply');
      vi.mocked(enrichSpy).mockClear();

      await handleCardAction({
        action: { value: { action: 'adopt_confirm', entry_key: 'live:herdr:default:w1:p1', root_id: rootId } },
        operator: { open_id: 'ou_user' },
        context: { open_message_id: 'om_card_msg' },
      } as any, { activeSessions, sessionReply, lastRepoScan: new Map() } as any, 'app_test');

      expect(discover).toHaveBeenCalledTimes(4);
      expect(enrichSpy).not.toHaveBeenCalled();
      expect(sessionReply).toHaveBeenCalledWith(rootId, expect.stringContaining('已退出'), undefined, 'app_test', undefined, expect.anything());
    } finally {
      for (const path of [
        '../src/core/session-discovery.js', '../src/core/zellij-adopt-discovery.js', '../src/im/lark/client.js',
        '../src/bot-registry.js', '../src/config.js', '../src/services/session-store.js', '../src/core/session-manager.js',
        '../src/services/frozen-card-store.js', '@larksuiteoapi/node-sdk',
      ]) vi.doUnmock(path);
    }
  });
});
