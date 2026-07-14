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
}));

vi.mock('../src/config.js', () => ({
  config: { web: { externalHost: 'localhost' }, session: { dataDir: '/tmp' } },
}));

vi.mock('../src/services/session-store.js', () => ({
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

import { recallFrozenCards, parkStreamCard, restoreUsageLimitRuntimeState, scheduleCardPatch } from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';

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
  setTerminalProxyPort(8800);
});

afterEach(() => {
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

    parkStreamCard(ds);

    expect(ds.frozenCards?.size).toBe(1);
    const entry = ds.frozenCards?.get('nonce_live');
    expect(entry?.messageId).toBe('om_live');
    expect(entry?.content).toBe('snapshot text');
    expect(entry?.title).toBe('Some turn');
    expect(entry?.displayMode).toBe('screenshot');
    expect(entry?.imageKey).toBe('img_key_xyz');
    expect(saveFrozenCardsMock).toHaveBeenCalledTimes(1);
    expect(saveFrozenCardsMock).toHaveBeenCalledWith(SESSION_ID, ds.frozenCards);
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
