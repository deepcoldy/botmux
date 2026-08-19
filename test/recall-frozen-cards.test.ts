/**
 * Unit tests for recallFrozenCards (worker-pool.ts).
 *
 * Verifies the helper that wipes previous turns' streaming cards once a new
 * card becomes the active one — the "auto-recall" feature that keeps long
 * threads from filling up with stale interactive cards.
 *
 * Run:  pnpm vitest run test/recall-frozen-cards.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DaemonSession, FrozenCard } from '../src/core/types.js';
import { sessionKey } from '../src/core/types.js';
import { setTerminalProxyPort } from '../src/core/terminal-url.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const deleteMessageMock = vi.fn(async (_appId: string, _messageId: string) => {});
const updateMessageMock = vi.fn(async (_appId: string, _messageId: string, _json: string) => {});
const saveFrozenCardsMock = vi.fn();
const loadFrozenCardsMock = vi.fn(() => new Map<string, FrozenCard>());
const persistStreamCardStateMock = vi.fn();

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(args[0], args[1], args[2]),
    deleteMessage: (...args: any[]) => deleteMessageMock(args[0], args[1]),
    MessageWithdrawnError,
  };
});

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: (...args: any[]) => loadFrozenCardsMock(...args),
  saveFrozenCards: (...args: any[]) => saveFrozenCardsMock(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', cliId: 'claude-code' },
  })),
  getAllBots: vi.fn(() => []),
  // Streaming-card usage gate reads this; 'streaming' lets the snapshot flow
  // (the reader then finds no transcript → empty snapshot, asserted below).
  resolveUsageDisplay: vi.fn(() => 'streaming'),
}));

vi.mock('../src/config.js', () => ({
  config: { web: { externalHost: 'localhost' }, session: { dataDir: '/tmp' } },
}));

vi.mock('../src/global-config.js', () => ({
  isRemoteAccessEnabled: vi.fn(() => false),
}));

vi.mock('../src/platform/binding.js', () => ({
  platformMachineBaseUrl: vi.fn(() => null),
  publicReverseProxyBaseUrl: vi.fn(() => null),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: (...args: any[]) => persistStreamCardStateMock(...args),
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

// ─── Imports under test ────────────────────────────────────────────────────

import {
  recallFrozenCards,
  parkStreamCard,
  postFreshStreamingCard,
  postTurnStartingCard,
  setActiveSessionsRegistry,
  restoreUsageLimitRuntimeState,
  scheduleCardPatch,
  usageRefreshShouldRun,
  refreshStreamingCardUsage,
  syncUsageRefreshTimer,
  USAGE_REFRESH_INTERVAL_MS,
} from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { resolveUsageDisplay } from '../src/bot-registry.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const APP_ID = 'app_test';
const SESSION_ID = 'sess-recall-test';

function makeFrozen(messageId: string, overrides: Partial<FrozenCard> = {}): FrozenCard {
  return {
    messageId,
    content: 'snapshot',
    title: 'Turn',
    displayMode: 'hidden',
    ...overrides,
  };
}

function makeDs(frozenCards?: Map<string, FrozenCard>): DaemonSession {
  return {
    session: {
      sessionId: SESSION_ID,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 't',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    frozenCards,
  };
}

beforeEach(() => {
  deleteMessageMock.mockClear();
  updateMessageMock.mockReset();
  updateMessageMock.mockResolvedValue(undefined);
  saveFrozenCardsMock.mockClear();
  loadFrozenCardsMock.mockReset();
  loadFrozenCardsMock.mockReturnValue(new Map());
  persistStreamCardStateMock.mockClear();
  vi.mocked(buildStreamingCard).mockClear();
  setTerminalProxyPort(8800);
});

afterEach(() => {
  setActiveSessionsRegistry(undefined as any);
  vi.clearAllTimers();
  vi.useRealTimers();
});

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('recallFrozenCards', () => {
  it('is a no-op when frozenCards is undefined and disk is empty', () => {
    const ds = makeDs(undefined);
    recallFrozenCards(ds);

    expect(loadFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID);
    expect(deleteMessageMock).not.toHaveBeenCalled();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
    expect(ds.frozenCards?.size).toBe(0);
  });

  it('is a no-op when in-memory frozenCards is empty', () => {
    const ds = makeDs(new Map());
    recallFrozenCards(ds);

    // Lazy-load short-circuited because Map exists (just empty).
    expect(loadFrozenCardsMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
  });

  it('deletes every frozen card via the Lark client', () => {
    const map = new Map<string, FrozenCard>();
    map.set('n1', makeFrozen('om_a'));
    map.set('n2', makeFrozen('om_b'));
    map.set('n3', makeFrozen('om_c'));
    const ds = makeDs(map);

    recallFrozenCards(ds);

    expect(deleteMessageMock).toHaveBeenCalledTimes(3);
    const ids = deleteMessageMock.mock.calls.map(c => c[1]).sort();
    expect(ids).toEqual(['om_a', 'om_b', 'om_c']);
    deleteMessageMock.mock.calls.forEach(c => expect(c[0]).toBe(APP_ID));
  });

  it('clears the in-memory Map and persists empty state', () => {
    const map = new Map<string, FrozenCard>();
    map.set('n1', makeFrozen('om_a'));
    const ds = makeDs(map);

    recallFrozenCards(ds);

    expect(ds.frozenCards?.size).toBe(0);
    expect(saveFrozenCardsMock).toHaveBeenCalledTimes(1);
    expect(saveFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID, ds.frozenCards);
  });

  it('lazy-loads from disk when frozenCards is undefined', () => {
    const onDisk = new Map<string, FrozenCard>();
    onDisk.set('persisted', makeFrozen('om_persisted'));
    loadFrozenCardsMock.mockReturnValue(onDisk);

    const ds = makeDs(undefined);
    recallFrozenCards(ds);

    expect(loadFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID);
    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_persisted');
    expect(ds.frozenCards?.size).toBe(0);
  });

  it('swallows deleteMessage rejections without throwing', () => {
    deleteMessageMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const map = new Map<string, FrozenCard>();
    map.set('n1', makeFrozen('om_failing'));
    map.set('n2', makeFrozen('om_ok'));
    const ds = makeDs(map);

    expect(() => recallFrozenCards(ds)).not.toThrow();
    expect(deleteMessageMock).toHaveBeenCalledTimes(2);
    expect(ds.frozenCards?.size).toBe(0);
  });

  it('is idempotent — second call after the first does nothing', () => {
    const map = new Map<string, FrozenCard>();
    map.set('n1', makeFrozen('om_only'));
    const ds = makeDs(map);

    recallFrozenCards(ds);
    expect(deleteMessageMock).toHaveBeenCalledTimes(1);

    recallFrozenCards(ds);
    expect(deleteMessageMock).toHaveBeenCalledTimes(1); // still 1
  });

  // ── P2 regression: never delete the live card ─────────────────────────────

  it('skips entries whose messageId equals the active streamCardId', () => {
    // Reproduces the daemon-restart window where freeze persisted an entry
    // for the still-live card before crash. Recall must not delete it.
    const map = new Map<string, FrozenCard>();
    map.set('nonce_active', makeFrozen('om_active'));
    map.set('nonce_old', makeFrozen('om_old'));
    const ds = makeDs(map);
    ds.streamCardId = 'om_active';

    recallFrozenCards(ds);

    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_old');
    // Active entry preserved in the Map.
    expect(ds.frozenCards?.has('nonce_active')).toBe(true);
    expect(ds.frozenCards?.has('nonce_old')).toBe(false);
  });

  it('does not persist or call deleteMessage when only the active entry exists', () => {
    const map = new Map<string, FrozenCard>();
    map.set('nonce_active', makeFrozen('om_active'));
    const ds = makeDs(map);
    ds.streamCardId = 'om_active';

    recallFrozenCards(ds);

    expect(deleteMessageMock).not.toHaveBeenCalled();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
    expect(ds.frozenCards?.size).toBe(1);
  });

  it('treats CARD_POSTING_SENTINEL as no active id (deletes everything)', () => {
    const map = new Map<string, FrozenCard>();
    map.set('n1', makeFrozen('om_only'));
    const ds = makeDs(map);
    ds.streamCardId = '__posting__';

    recallFrozenCards(ds);

    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_only');
  });
});

describe('restoreUsageLimitRuntimeState', () => {
  it('marks restored limit sessions limited and re-arms the retry timer', () => {
    const now = new Date('2026-05-22T10:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ds = makeDs();
    ds.streamCardId = 'om_live_limit';
    ds.streamCardNonce = 'nonce_limit';
    ds.session.webPort = 8080;
    ds.workerPort = null;
    ds.usageLimit = {
      limited: true,
      kind: 'usage',
      retryAtMs: now + 1_000,
      retryLabel: '10:01 AM',
      retryReady: false,
    };

    restoreUsageLimitRuntimeState(ds);

    expect(ds.lastScreenStatus).toBe('limited');
    expect(ds.usageLimitRetryTimer).toBeDefined();
    expect(ds.usageLimit.retryReady).toBe(false);
    expect(persistStreamCardStateMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);

    expect(ds.usageLimit.retryReady).toBe(true);
    expect(persistStreamCardStateMock).toHaveBeenCalledWith(ds);
    expect(buildStreamingCard).toHaveBeenCalledWith(
      SESSION_ID,
      'om_root',
      `http://localhost:8800/s/${SESSION_ID}`,
      't',
      '',
      'limited',
      'claude-code',
      'hidden',
      'nonce_limit',
      undefined,
      false,
      false,
      'zh',
      ds.usageLimit,
      undefined,
      false,
      // 17th arg: streaming-card usage snapshot (no transcript in this test →
      // empty; turnTokens is always present, null when no turn delta is known).
      { context: null, tokens: null, turnTokens: null },
      // 18th arg: no configured runtime display name for this Claude fixture.
      undefined,
      // 19th arg: Codex Fast tier badge — undefined for this non-Codex fixture.
      undefined,
    );
    expect(updateMessageMock).toHaveBeenCalledWith(APP_ID, 'om_live_limit', '{}');
  });

  it('marks already-expired restored limits retry-ready immediately', () => {
    const now = new Date('2026-05-22T10:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ds = makeDs();
    ds.usageLimit = {
      limited: true,
      kind: 'usage',
      retryAtMs: now - 1_000,
      retryLabel: '9:59 AM',
      retryReady: false,
    };

    restoreUsageLimitRuntimeState(ds);

    expect(ds.lastScreenStatus).toBe('limited');
    expect(ds.usageLimit.retryReady).toBe(true);
    expect(ds.usageLimitRetryTimer).toBeUndefined();
    expect(persistStreamCardStateMock).toHaveBeenCalledWith(ds);
  });

  it('updates receiver retry state without patching a Lark card', () => {
    const now = new Date('2026-05-22T10:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ds = makeDs();
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    ds.streamCardId = 'om_legacy_card';
    ds.session.webPort = 8080;
    ds.usageLimit = {
      limited: true,
      kind: 'usage',
      retryAtMs: now + 1_000,
      retryLabel: '10:01 AM',
      retryReady: false,
    };

    restoreUsageLimitRuntimeState(ds);
    vi.advanceTimersByTime(1_000);

    expect(ds.usageLimit.retryReady).toBe(true);
    expect(persistStreamCardStateMock).toHaveBeenCalledWith(ds);
    expect(buildStreamingCard).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});

describe('receiver streaming card boundary', () => {
  it('refuses a fresh group-visible streaming card for a dedicated receiver', async () => {
    const ds = makeDs();
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    ds.workerPort = 4567;
    const sessionReply = vi.fn(async () => 'om_forbidden');

    await expect(postFreshStreamingCard(ds, sessionReply)).resolves.toBe(false);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(buildStreamingCard).not.toHaveBeenCalled();
  });
});

describe('postTurnStartingCard', () => {
  it('does not start a card POST while Riff retirement is already active', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.remoteCloseState = { phase: 'preparing', requestId: 'close-before-post' };
    const sessionReply = vi.fn(async () => 'om_forbidden');

    await expect(postTurnStartingCard(ds, sessionReply, 'om_turn_1')).resolves.toBe(false);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBe('om_turn_1');
  });

  it('posts a new-turn card immediately without waiting for screen_update', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.currentTurnTitle = 'first turn';
    const sessionReply = vi.fn(async () => 'om_turn_card_1');

    await expect(postTurnStartingCard(ds, sessionReply, 'om_turn_1')).resolves.toBe(true);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('om_turn_1');
    expect(ds.streamCardId).toBe('om_turn_card_1');
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
  });

  it('posts the newest queued turn after an older card POST finishes', async () => {
    let resolveFirst!: (messageId: string) => void;
    const sessionReply = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce('om_turn_card_2');
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.currentTurnTitle = 'first turn';

    const firstPost = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    expect(sessionReply).toHaveBeenCalledTimes(1);

    ds.streamCardTurnGeneration = 2;
    ds.streamCardPendingTurnId = 'om_turn_2';
    ds.currentTurnTitle = 'second turn';
    await expect(postTurnStartingCard(ds, sessionReply, 'om_turn_2')).resolves.toBe(false);

    resolveFirst('om_turn_card_1');
    await firstPost;
    await flush();
    await flush();

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1][4]).toBe('om_turn_2');
    expect(ds.streamCardId).toBe('om_turn_card_2');
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_turn_card_1');
  });

  it('restores the previous live card when the starting-card POST fails', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.currentTurnTitle = 'first turn';
    const sessionReply = vi.fn(async () => { throw new Error('network unavailable'); });

    await expect(postTurnStartingCard(ds, sessionReply, 'om_turn_1')).resolves.toBe(false);

    expect(ds.streamCardId).toBe('om_previous');
    expect(ds.streamCardNonce).toBe('nonce_previous');
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBe('om_turn_1');
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('does not let an old POST overwrite a replacement session', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.session = {
      ...ds.session,
      sessionId: 'sess-replacement',
      rootMessageId: 'om_replacement_root',
    };
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    persistStreamCardStateMock.mockClear();

    resolvePost('om_stale_turn_card');
    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(persistStreamCardStateMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_stale_turn_card');
  });

  it('deletes an orphan card when the session closes during POST', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.session.status = 'closed' as any;
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    persistStreamCardStateMock.mockClear();

    resolvePost('om_orphan_card');
    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(persistStreamCardStateMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_orphan_card');
  });

  it('does not adopt an old-route card after a completed transfer', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.session.rootMessageId = 'om_transferred_root';
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;

    resolvePost('om_old_route_card');
    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_old_route_card');
  });

  it('does not roll an old POST failure back into a replacement session', async () => {
    let rejectPost!: (error: Error) => void;
    const sessionReply = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectPost = reject; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.session = {
      ...ds.session,
      sessionId: 'sess-replacement',
      rootMessageId: 'om_replacement_root',
    };
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    persistStreamCardStateMock.mockClear();

    rejectPost(new Error('old route failed'));
    await expect(post).resolves.toBe(false);

    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(persistStreamCardStateMock).not.toHaveBeenCalled();
  });

  it('discards an in-flight card when Riff explicit close starts preparing', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.remoteCloseState = { phase: 'preparing', requestId: 'close-1' };
    resolvePost('om_riff_orphan_card');

    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).toBe('om_previous');
    expect(ds.streamCardNonce).toBe('nonce_previous');
    expect(ds.streamCardPending).toBe(true);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_riff_orphan_card');
  });

  it('discards an in-flight card when Riff daemon shutdown starts preparing', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.remoteShutdownState = { phase: 'preparing', requestId: 'shutdown-1' };
    resolvePost('om_riff_shutdown_orphan_card');

    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).toBe('om_previous');
    expect(ds.streamCardNonce).toBe('nonce_previous');
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_riff_shutdown_orphan_card');
  });

  it('can retry after Riff close preparation aborts without leaving the sentinel stuck', async () => {
    let resolveFirst!: (messageId: string) => void;
    const sessionReply = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce('om_retry_card');
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_previous';
    ds.streamCardNonce = 'nonce_previous';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';

    const firstPost = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    ds.remoteCloseState = { phase: 'preparing', requestId: 'close-abort' };
    resolveFirst('om_aborted_close_orphan_card');
    await expect(firstPost).resolves.toBe(false);

    ds.remoteCloseState = undefined;
    await expect(postTurnStartingCard(ds, sessionReply, 'om_turn_1')).resolves.toBe(true);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.streamCardId).toBe('om_retry_card');
    expect(ds.streamCardPending).toBe(false);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_aborted_close_orphan_card');
  });

  it('rejects a POST whose active registry key was taken by another session', async () => {
    let resolvePost!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPendingTurnId = 'om_turn_1';
    const registry = new Map([[sessionKey('om_root', APP_ID), ds]]);
    setActiveSessionsRegistry(registry);

    const post = postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    registry.set(sessionKey('om_root', APP_ID), makeDs());
    resolvePost('om_displaced_registry_card');

    await expect(post).resolves.toBe(false);
    await flush();

    expect(ds.streamCardId).not.toBe('om_displaced_registry_card');
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_displaced_registry_card');
  });
});

// ─── P3 helper: parkStreamCard ─────────────────────────────────────────────

describe('parkStreamCard', () => {
  it('moves the live streamCard into frozenCards and persists', () => {
    const ds = makeDs();
    ds.streamCardId = 'om_live';
    ds.streamCardNonce = 'nonce_live';
    ds.lastScreenContent = 'snapshot text';
    ds.currentTurnTitle = 'Some turn';
    ds.displayMode = 'screenshot';
    ds.currentImageKey = 'img_key_xyz';
    ds.session.cliId = 'codex';
    ds.codexServiceTier = {
      model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
    };

    parkStreamCard(ds);

    expect(ds.frozenCards?.size).toBe(1);
    const entry = ds.frozenCards?.get('nonce_live');
    expect(entry?.messageId).toBe('om_live');
    expect(entry?.content).toBe('snapshot text');
    expect(entry?.title).toBe('Some turn');
    expect(entry?.displayMode).toBe('screenshot');
    expect(entry?.imageKey).toBe('img_key_xyz');
    expect(entry?.codexServiceTierBadge).toBe('⚡ priority');
    expect(ds.parkedStreamCardNonce).toBe('nonce_live');
    expect(saveFrozenCardsMock).toHaveBeenCalledTimes(1);
    expect(saveFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID, ds.frozenCards);
  });

  it('does not leak a stale Codex tier snapshot into a non-Codex frozen card', () => {
    const ds = makeDs();
    ds.streamCardId = 'om_live';
    ds.streamCardNonce = 'nonce_live';
    ds.session.cliId = 'claude-code';
    ds.codexServiceTier = {
      model: 'gpt-5.6-sol', serviceTier: 'priority', nonDefault: true,
    };

    parkStreamCard(ds);

    expect(ds.frozenCards?.get('nonce_live')?.codexServiceTierBadge).toBeUndefined();
  });

  it('is a no-op when streamCardId is missing', () => {
    const ds = makeDs();
    parkStreamCard(ds);
    expect(ds.frozenCards).toBeUndefined();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
  });

  it('is a no-op when streamCardId is the in-flight POST sentinel', () => {
    const ds = makeDs();
    ds.streamCardId = '__posting__';
    ds.streamCardNonce = 'nonce_x';
    parkStreamCard(ds);
    expect(ds.frozenCards).toBeUndefined();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
  });

  it('is a no-op when streamCardNonce is missing', () => {
    // Without a nonce there is no key to associate the entry with — skip
    // rather than synthesize one (callers must own the nonce lifecycle).
    const ds = makeDs();
    ds.streamCardId = 'om_live';
    parkStreamCard(ds);
    expect(ds.frozenCards).toBeUndefined();
    expect(saveFrozenCardsMock).not.toHaveBeenCalled();
  });

  it('preserves existing frozen entries when parking a new one', () => {
    const map = new Map<string, FrozenCard>();
    map.set('older', makeFrozen('om_older'));
    const ds = makeDs(map);
    ds.streamCardId = 'om_now';
    ds.streamCardNonce = 'nonce_now';

    parkStreamCard(ds);

    expect(ds.frozenCards?.size).toBe(2);
    expect(ds.frozenCards?.get('older')?.messageId).toBe('om_older');
    expect(ds.frozenCards?.get('nonce_now')?.messageId).toBe('om_now');
  });

  it('lazy-loads existing entries from disk before parking', () => {
    // Models the daemon-restart path: ds.frozenCards is undefined because
    // restoreActiveSessions doesn't pre-load it, but the on-disk JSON
    // already holds frozen messageIds from earlier turns. Parking must
    // merge with disk state instead of overwriting it — otherwise those
    // earlier cards would be stranded in the thread.
    const onDisk = new Map<string, FrozenCard>();
    onDisk.set('persisted_a', makeFrozen('om_disk_a'));
    onDisk.set('persisted_b', makeFrozen('om_disk_b'));
    loadFrozenCardsMock.mockReturnValue(onDisk);

    const ds = makeDs(undefined);
    ds.streamCardId = 'om_live';
    ds.streamCardNonce = 'nonce_live';

    parkStreamCard(ds);

    expect(loadFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID);
    expect(ds.frozenCards?.size).toBe(3);
    expect(ds.frozenCards?.get('persisted_a')?.messageId).toBe('om_disk_a');
    expect(ds.frozenCards?.get('persisted_b')?.messageId).toBe('om_disk_b');
    expect(ds.frozenCards?.get('nonce_live')?.messageId).toBe('om_live');
    // saveFrozenCards must persist the merged Map, not just the new entry.
    expect(saveFrozenCardsMock).toHaveBeenCalledTimes(1);
    const persistedMap = saveFrozenCardsMock.mock.calls[0][1] as Map<string, FrozenCard>;
    expect(persistedMap.size).toBe(3);
  });
});

// ─── P1 regression: stale withdrawn PATCH must not clobber active card ─────

describe('scheduleCardPatch withdrawn handling', () => {
  it('does NOT clear ds.streamCardId when the withdrawn cardId is no longer active', async () => {
    // Models the race introduced by auto-recall: a freeze PATCH for the
    // previous turn's card is still in flight when the new card POSTs and
    // recall deletes the old message. The PATCH then surfaces a
    // MessageWithdrawnError — but ds.streamCardId already points at the
    // new live card, so the catch must NOT clear it.
    const ds = makeDs();
    ds.streamCardId = 'om_OLD';
    ds.streamCardNonce = 'nonce_old';

    let rejectPatch!: (err: Error) => void;
    updateMessageMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectPatch = reject; }),
    );

    scheduleCardPatch(ds, '{"freeze":true}');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_OLD');

    // Simulate auto-recall: new card now live, ds.streamCardId advanced.
    ds.streamCardId = 'om_NEW';

    rejectPatch(new MessageWithdrawnError('om_OLD'));
    await flush();

    expect(ds.streamCardId).toBe('om_NEW');
    expect(persistStreamCardStateMock).not.toHaveBeenCalled();
  });

  it('DOES clear ds.streamCardId when the withdrawn card is still the active one', async () => {
    // Original behavior preserved: an unrelated user-side withdraw of the
    // current card must still null out the reference so a fresh card is
    // POSTed on the next screen_update.
    const ds = makeDs();
    ds.streamCardId = 'om_ACTIVE';
    ds.streamCardNonce = 'nonce';

    let rejectPatch!: (err: Error) => void;
    updateMessageMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectPatch = reject; }),
    );

    scheduleCardPatch(ds, '{"any":true}');
    rejectPatch(new MessageWithdrawnError('om_ACTIVE'));
    await flush();

    expect(ds.streamCardId).toBeUndefined();
    expect(persistStreamCardStateMock).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleCardPatch adjacent duplicate handling', () => {
  it('drops an identical PATCH queued for the same card after the in-flight PATCH succeeds', async () => {
    const ds = makeDs();
    ds.streamCardId = 'om_SAME';

    let resolvePatch!: () => void;
    updateMessageMock.mockImplementationOnce(
      () => new Promise<void>(resolve => { resolvePatch = resolve; }),
    );

    scheduleCardPatch(ds, '{"state":"same"}');
    scheduleCardPatch(ds, '{"state":"same"}');

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.pendingCardId).toBe('om_SAME');
    expect(ds.pendingCardJson).toBe('{"state":"same"}');

    resolvePatch();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.pendingCardId).toBeUndefined();
    expect(ds.pendingCardJson).toBeUndefined();
    expect(ds.cardPatchInFlight).toBe(false);

    // The optimization is adjacency-only: once the successful PATCH has
    // settled, the same state scheduled later must still reach Lark.
    scheduleCardPatch(ds, '{"state":"same"}');
    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    await flush();
    expect(ds.cardPatchInFlight).toBe(false);
  });

  it('retries an identical queued PATCH when the in-flight PATCH fails', async () => {
    const ds = makeDs();
    ds.streamCardId = 'om_RETRY';

    let rejectPatch!: (error: Error) => void;
    let resolveRetry!: () => void;
    updateMessageMock
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => { rejectPatch = reject; }),
      )
      .mockImplementationOnce(
        () => new Promise<void>(resolve => { resolveRetry = resolve; }),
      );

    scheduleCardPatch(ds, '{"state":"retry"}');
    scheduleCardPatch(ds, '{"state":"retry"}');

    rejectPatch(new Error('temporary failure'));
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    expect(updateMessageMock.mock.calls[1]).toEqual([
      APP_ID,
      'om_RETRY',
      '{"state":"retry"}',
    ]);

    resolveRetry();
    await flush();
    expect(ds.cardPatchInFlight).toBe(false);
  });

  it('does not deduplicate identical JSON queued for a different card', async () => {
    const ds = makeDs();
    ds.streamCardId = 'om_OLD';

    let resolveOldPatch!: () => void;
    let resolveNewPatch!: () => void;
    updateMessageMock
      .mockImplementationOnce(
        () => new Promise<void>(resolve => { resolveOldPatch = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<void>(resolve => { resolveNewPatch = resolve; }),
      );

    scheduleCardPatch(ds, '{"state":"same-json"}');
    ds.streamCardId = 'om_NEW';
    scheduleCardPatch(ds, '{"state":"same-json"}');

    resolveOldPatch();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    expect(updateMessageMock.mock.calls[1]).toEqual([
      APP_ID,
      'om_NEW',
      '{"state":"same-json"}',
    ]);

    resolveNewPatch();
    await flush();
    expect(ds.cardPatchInFlight).toBe(false);
  });
});

// ─── Periodic usage refresh timer (PR #637 follow-up, codex review) ──────────
//
// The streaming card re-renders every USAGE_REFRESH_INTERVAL_MS while a turn is
// working so the total/turn usage climbs live. codex flagged five reachability
// gaps in the first cut; these lock the corrected contract:
//   - the arm predicate must NOT depend on the Web Terminal port (ZMX ready with
//     port=0 must still refresh), and must gate on native-usage CLI capability
//     (gemini/opencode/… have no transcript → nothing to refresh) and on
//     usageDisplay='streaming';
//   - the tick reads fresh (breaks the 15s cost-reader throttle) and is
//     self-correcting (clears its own timer when state no longer qualifies).
describe('usageRefreshShouldRun (arm/clear predicate)', () => {
  function workingDs(): DaemonSession {
    const ds = makeDs();
    ds.lastScreenStatus = 'working';
    ds.streamCardId = 'om_live';
    ds.workerReady = true; // worker initialized (ZMX reports ready with port=0)
    ds.workerPort = null;  // ← no Web Terminal port on purpose
    ds.session.cliId = 'claude-code';
    return ds;
  }

  it('is true for a working, initialized, streaming, native-usage session even with no worker port (ZMX port=0)', () => {
    const ds = workingDs();
    expect(ds.workerPort).toBeNull();
    expect(usageRefreshShouldRun(ds)).toBe(true);
  });

  it('is false once the turn leaves working (idle / limited)', () => {
    const ds = workingDs();
    ds.lastScreenStatus = 'idle';
    expect(usageRefreshShouldRun(ds)).toBe(false);
    ds.lastScreenStatus = 'limited';
    expect(usageRefreshShouldRun(ds)).toBe(false);
  });

  it('is false with no live card or the POSTING sentinel', () => {
    const ds = workingDs();
    ds.streamCardId = undefined;
    expect(usageRefreshShouldRun(ds)).toBe(false);
    ds.streamCardId = '__posting__';
    expect(usageRefreshShouldRun(ds)).toBe(false);
  });

  it('is false before the worker has initialized', () => {
    const ds = workingDs();
    ds.workerReady = false;
    expect(usageRefreshShouldRun(ds)).toBe(false);
  });

  it('is false for a CLI without native usage (gemini/opencode/…)', () => {
    const ds = workingDs();
    ds.session.cliId = 'gemini' as any;
    expect(usageRefreshShouldRun(ds)).toBe(false);
  });

  it('is false when usageDisplay is not streaming (footer / off)', () => {
    const ds = workingDs();
    vi.mocked(resolveUsageDisplay).mockReturnValue('footer' as any);
    expect(usageRefreshShouldRun(ds)).toBe(false);
    vi.mocked(resolveUsageDisplay).mockReturnValue('off' as any);
    expect(usageRefreshShouldRun(ds)).toBe(false);
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming' as any);
  });
});

describe('refreshStreamingCardUsage (interval tick)', () => {
  function workingDs(): DaemonSession {
    const ds = makeDs();
    ds.lastScreenStatus = 'working';
    ds.streamCardId = 'om_live';
    ds.workerReady = true;
    ds.session.cliId = 'claude-code';
    return ds;
  }

  it('re-renders and PATCHes the live card while working', () => {
    const ds = workingDs();
    refreshStreamingCardUsage(ds);
    expect(buildStreamingCard).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).toHaveBeenCalledWith(APP_ID, 'om_live', expect.any(String));
  });

  it('reads usage fresh so the 12s tick beats the 15s cost-reader throttle', () => {
    // The whole point of the tick is to break the reparse throttle. The 17th
    // buildStreamingCard arg is the streaming usage snapshot; assert the tick
    // asked for a fresh read (empty transcript here → concrete empty snapshot).
    const ds = workingDs();
    refreshStreamingCardUsage(ds);
    const call = vi.mocked(buildStreamingCard).mock.calls[0]!;
    // Snapshot present (17th positional arg) and interval < throttle by design.
    expect(call[16]).toEqual({ context: null, tokens: null, turnTokens: null });
    expect(USAGE_REFRESH_INTERVAL_MS).toBeLessThan(15_000);
  });

  it('renders an empty terminal URL for a port=0 backend (ZMX) — no fake `:undefined` link', () => {
    // workingDs() has workerPort=null (ZMX reports ready without a Web Terminal).
    // The tick must use readableTerminalUrlFor (→ '') not raw buildTerminalUrl.
    const ds = workingDs();
    expect(ds.workerPort ?? null).toBeNull();
    refreshStreamingCardUsage(ds);
    const call = vi.mocked(buildStreamingCard).mock.calls[0]!;
    expect(call[2]).toBe(''); // 3rd positional arg = read-only terminal URL
  });

  it('renders the read-only terminal URL for a Web-Terminal backend (tmux/pty)', () => {
    const ds = workingDs();
    ds.workerPort = 9101; // a real Web Terminal port
    refreshStreamingCardUsage(ds);
    const call = vi.mocked(buildStreamingCard).mock.calls[0]!;
    expect(typeof call[2]).toBe('string');
    expect(call[2]).not.toBe('');
    expect(call[2]).toContain(`/s/${SESSION_ID}`);
  });

  it('is self-correcting: a tick that no longer qualifies clears its own timer and does not PATCH', () => {
    vi.useFakeTimers();
    const ds = workingDs();
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    // Turn settled between ticks without an explicit clear on this path.
    ds.lastScreenStatus = 'idle';
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.usageRefreshTimer).toBeUndefined();
  });

  it('does not PATCH during the new-turn handoff window (streamCardPending=true, old card still live)', () => {
    // beginNewTurn: live worker still `working`, OLD streamCardId still set, but
    // streamCardPending=true and currentTurnTitle already swapped to the new
    // turn. A stray tick here must NOT PATCH the previous card with the new
    // turn's title — it self-clears instead.
    vi.useFakeTimers();
    const ds = workingDs();
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    ds.streamCardPending = true;             // handoff opened; streamCardId unchanged
    ds.currentTurnTitle = 'NEW TURN TITLE';
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.usageRefreshTimer).toBeUndefined();
  });
});

describe('syncUsageRefreshTimer (state-boundary arm/clear)', () => {
  function workingDs(): DaemonSession {
    const ds = makeDs();
    ds.lastScreenStatus = 'working';
    ds.streamCardId = 'om_live';
    ds.workerReady = true;
    ds.session.cliId = 'claude-code';
    return ds;
  }

  it('arms a repeating timer for a qualifying working turn and re-renders each interval with fresh usage', () => {
    vi.useFakeTimers();
    const ds = workingDs();
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    // Re-render (buildStreamingCard) is the per-tick signal: scheduleCardPatch
    // coalesces overlapping in-flight PATCHes, so updateMessage call count is not
    // a reliable per-tick counter under fake timers (the mock never resolves).
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
    expect(buildStreamingCard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
    expect(buildStreamingCard).toHaveBeenCalledTimes(2);
  });

  it('clears the timer when the session no longer qualifies (idle)', () => {
    vi.useFakeTimers();
    const ds = workingDs();
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    ds.lastScreenStatus = 'idle';
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeUndefined();
  });

  it('does not arm for an unsupported CLI (no group-visible empty-usage PATCH storm)', () => {
    vi.useFakeTimers();
    const ds = workingDs();
    ds.session.cliId = 'gemini' as any;
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeUndefined();
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS * 3);
    expect(buildStreamingCard).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('does not arm when usageDisplay is off', () => {
    vi.useFakeTimers();
    const ds = workingDs();
    vi.mocked(resolveUsageDisplay).mockReturnValue('off' as any);
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeUndefined();
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming' as any);
  });

  it('re-arms after a CLI auto-restart (working card survives, worker re-readies)', () => {
    // Third authorized arm point: claude_exit rc<=3 sets workerReady=false and
    // restarts; the tick self-clears while uninitialized; on `ready` the old
    // still-working card is reused and syncUsageRefreshTimer must re-arm — the
    // post-restart screen_update is working→working and would otherwise never
    // reach the arm choke point.
    vi.useFakeTimers();
    const ds = workingDs();
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    // Worker exits/restarts: not initialized → the next tick self-clears.
    ds.workerReady = false;
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
    expect(ds.usageRefreshTimer).toBeUndefined();

    // `ready` reuses the surviving working card and re-syncs.
    ds.workerReady = true;
    syncUsageRefreshTimer(ds);
    expect(ds.usageRefreshTimer).toBeDefined();

    // Now ticks resume even without a status edge (working→working).
    const before = vi.mocked(buildStreamingCard).mock.calls.length;
    vi.advanceTimersByTime(USAGE_REFRESH_INTERVAL_MS);
    expect(vi.mocked(buildStreamingCard).mock.calls.length).toBe(before + 1);
  });
});
