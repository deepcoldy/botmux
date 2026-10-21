/**
 * Restart recovery keeps the surviving streaming card truthful.
 *
 *   - suppressRecoveryCard only forbids a NEW card: a restored card still follows
 *     the worker's status edges (it used to freeze at 「工作中」 until the next
 *     human message — weeks, in practice).
 *   - reconcileRestoredStreamingCardStatus: a session whose CLI did not come back
 *     gets its card read back from Lark and, only if it still claims work, set
 *     to idle (or withdrawn past Lark's 14-day edit window).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const updateMessageMock = vi.fn(async (..._args: any[]) => {});
const deleteMessageMock = vi.fn(async (..._args: any[]) => true);
const getMessageDetailMock = vi.fn(async (..._args: any[]): Promise<any> => ({}));
const listChatMessagesMock = vi.fn(async (..._args: any[]): Promise<any[]> => []);
const listThreadMessagesMock = vi.fn(async (..._args: any[]): Promise<any[]> => []);
const probeMock = vi.hoisted(() => vi.fn(() => 'missing'));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  class MessageUpdateExpiredError extends Error {
    constructor(id: string) { super(`expired: ${id}`); this.name = 'MessageUpdateExpiredError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
    deleteMessage: (...args: any[]) => deleteMessageMock(...args),
    getMessageDetail: (...args: any[]) => getMessageDetailMock(...args),
    listChatMessages: (...args: any[]) => listChatMessagesMock(...args),
    listThreadMessages: (...args: any[]) => listThreadMessagesMock(...args),
    pinMessage: vi.fn(async () => ({})),
    unpinMessage: vi.fn(async () => true),
    listChatPins: vi.fn(async () => []),
    MessageWithdrawnError,
    MessageUpdateExpiredError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn((...args: any[]) => JSON.stringify({ type: 'streaming', status: args[5] })),
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
  normalizeUsageDisplay: vi.fn(() => 'off'),
  getBotClient: vi.fn(() => ({ request: vi.fn() })),
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

vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn(() => ({ tokenUsage: undefined })) }));
vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenEnabled: vi.fn(() => false),
  isLocalCliOpenReady: vi.fn(() => false),
}));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/core/persistent-backend.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/persistent-backend.js')>(),
  persistentBackendTargetForSession: vi.fn(() => ({ backendType: 'tmux', sessionName: 'bmx-test' })),
  probePersistentBackendTargets: vi.fn((targets: Iterable<{ backendType: string; sessionName: string }>) =>
    new Map([...targets].map(t => [`${t.backendType}:${t.sessionName}`, probeMock()]))),
  persistentBackendTargetKey: vi.fn((t: { backendType: string; sessionName: string }) => `${t.backendType}:${t.sessionName}`),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { staleWorkingCardIds } from '../src/core/restored-card-status.js';
import {
  initWorkerPool,
  reconcileRestoredStreamingCardStatus,
  sweepStaleWorkingCards,
  setActiveSessionsRegistry,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { MessageUpdateExpiredError } from '../src/im/lark/client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

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

function makeDs(overrides?: Partial<DaemonSession>, session?: Record<string, unknown>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-restore-card',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      ...session,
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    streamCardNonce: 'n1',
    currentTurnTitle: 'Test task',
    ...overrides,
  } as DaemonSession;
}

function activate(...sessions: DaemonSession[]): void {
  setActiveSessionsRegistry(new Map(sessions.map(ds => [activeSessionKey(ds), ds])));
}

function cardDetail(title: string, extra: Record<string, unknown> = {}) {
  return {
    items: [{
      message_id: 'om_card',
      msg_type: 'interactive',
      body: { content: JSON.stringify({ header: { title: { tag: 'plain_text', content: title } } }) },
      ...extra,
    }],
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const lastPatchedStatus = () => JSON.parse(String(updateMessageMock.mock.calls.at(-1)?.[2])).status;

let sessionReplyMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  getMessageDetailMock.mockReset();
  updateMessageMock.mockReset();
  probeMock.mockReturnValue('missing');
  sessionReplyMock = vi.fn(async () => 'om_new_card');
  initWorkerPool({
    sessionReply: sessionReplyMock as any,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
  setActiveSessionsRegistry(new Map());
});

describe('silent restart recovery: no new card, but the surviving card follows status', () => {
  it('PATCHes the restored card when the re-attached CLI reports idle', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, suppressRecoveryCard: true, streamCardId: 'om_card' });
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok' });
    await flush();
    // ready stays silent: no 「启动中」 re-render, no new card.
    expect(updateMessageMock).not.toHaveBeenCalled();

    worker.emit('message', { type: 'screen_update', content: '❯', status: 'idle' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_card');
    expect(lastPatchedStatus()).toBe('idle');
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.suppressRecoveryCard).toBe(true);
  });

  it('still never posts a card when no card survived the restart', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, suppressRecoveryCard: true, streamCardId: undefined });
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok' });
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    worker.emit('message', { type: 'screen_update', content: '❯', status: 'idle' });
    await flush();
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBeUndefined();
  });
});

describe('reconcileRestoredStreamingCardStatus', () => {
  it('sets a worker-less card that still claims work to idle', async () => {
    const ds = makeDs({ streamCardId: 'om_card' });
    activate(ds);
    getMessageDetailMock.mockResolvedValueOnce(cardDetail('🖥️ Claude · fix bug — 工作中'));

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(getMessageDetailMock).toHaveBeenCalledWith('app_test', 'om_card', expect.anything());
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_card');
    expect(lastPatchedStatus()).toBe('idle');
    expect(deleteMessageMock).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBe('om_card');
  });

  it.each([
    '🖥️ Claude · fix bug — 等待输入',
    '🖥️ Claude · fix bug — ✓ 本轮已结束 · 等待输入',
    '🛑 会话已关闭',
  ])('leaves a card that does not claim work untouched: %s', async (title) => {
    const ds = makeDs({ streamCardId: 'om_card' });
    activate(ds);
    getMessageDetailMock.mockResolvedValueOnce(cardDetail(title));

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('skips sessions whose CLI may still be running', async () => {
    const reattached = makeDs({ streamCardId: 'om_a', worker: makeFakeWorker() }, { sessionId: 'sid-a', rootMessageId: 'om_ra' });
    const inconclusive = makeDs({ streamCardId: 'om_b' }, { sessionId: 'sid-b', rootMessageId: 'om_rb', backendType: 'tmux' });
    const adopted = makeDs({ streamCardId: 'om_c', adoptedFrom: { sessionName: 's', pane: '%1' } as any }, { sessionId: 'sid-c', rootMessageId: 'om_rc' });
    activate(reattached, inconclusive, adopted);
    probeMock.mockReturnValue('unknown');
    getMessageDetailMock.mockResolvedValue(cardDetail('🖥️ Claude · t — 工作中'));

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(getMessageDetailMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('treats a missing persistent pane as a CLI that is gone', async () => {
    const ds = makeDs({ streamCardId: 'om_card' }, { backendType: 'tmux' });
    activate(ds);
    getMessageDetailMock.mockResolvedValueOnce(cardDetail('🖥️ Pi · review — Working'));

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(probeMock).toHaveBeenCalled();
    expect(lastPatchedStatus()).toBe('idle');
  });

  it('withdraws a working card past the edit window and forgets it', async () => {
    const ds = makeDs({ streamCardId: 'om_card' });
    activate(ds);
    getMessageDetailMock.mockResolvedValueOnce(cardDetail('🖥️ Relay · 三方收敛 — 工作中'));
    updateMessageMock.mockRejectedValueOnce(new MessageUpdateExpiredError('om_card'));

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_card');
    expect(ds.streamCardId).toBeUndefined();
  });

  it('does not write when a turn claimed the session during the read', async () => {
    const ds = makeDs({ streamCardId: 'om_card' });
    activate(ds);
    getMessageDetailMock.mockImplementationOnce(async () => {
      ds.worker = makeFakeWorker();
      return cardDetail('🖥️ Claude · t — 工作中');
    });

    await reconcileRestoredStreamingCardStatus('app_test');

    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});

function listedCard(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    message_id: id,
    msg_type: 'interactive',
    create_time: '1000',
    sender: { id: 'app_test', id_type: 'app_id', sender_type: 'app' },
    body: { content: JSON.stringify({ title, elements: [] }) },
    ...overrides,
  };
}

describe('staleWorkingCardIds', () => {
  const opts = { larkAppId: 'app_test', liveCardIds: new Set(['om_live']), postedBefore: 5_000 };

  it('picks only this bot\'s untracked streaming cards that still claim work', () => {
    expect(staleWorkingCardIds([
      listedCard('om_orphan', '🖥️ Claude · 进度如何 — 工作中'),
      listedCard('om_orphan_en', '🖥️ Pi · review — Starting…'),
      listedCard('om_live', '🖥️ Claude · current — 工作中'),
      listedCard('om_idle', '🖥️ Claude · old — 等待输入'),
      listedCard('om_other_bot', '🖥️ Claude · x — 工作中', { sender: { id: 'cli_other', sender_type: 'app' } }),
      listedCard('om_human', '🖥️ Claude · x — 工作中', { sender: { id: 'ou_x', sender_type: 'user' } }),
      listedCard('om_recalled', '🖥️ Claude · x — 工作中', { deleted: true }),
      listedCard('om_new', '🖥️ Claude · x — 工作中', { create_time: '9000' }),
      listedCard('om_text', '🖥️ Claude · x — 工作中', { msg_type: 'text' }),
    ], opts)).toEqual(['om_orphan', 'om_orphan_en']);
  });

  it('recognises this bot under every sender shape the message API uses', () => {
    expect(staleWorkingCardIds([
      listedCard('om_as_bot', '🖥️ Claude · x — 工作中', { sender: { id: 'app_test', id_type: 'app_id', sender_type: 'bot' } }),
      listedCard('om_app_id_only', '🖥️ Claude · x — 工作中', { sender: { id: 'app_test', id_type: 'app_id' } }),
      listedCard('om_other_bot', '🖥️ Claude · x — 工作中', { sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'bot' } }),
      listedCard('om_untyped', '🖥️ Claude · x — 工作中', { sender: { id: 'app_test' } }),
    ], opts)).toEqual(['om_as_bot', 'om_app_id_only']);
  });
});

describe('sweepStaleWorkingCards', () => {
  let dataDir: string;
  const previousDataDir = config.session.dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stale-card-sweep-'));
    config.session.dataDir = dataDir;
    listChatMessagesMock.mockReset().mockResolvedValue([]);
    listThreadMessagesMock.mockReset().mockResolvedValue([]);
    deleteMessageMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    config.session.dataDir = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('withdraws untracked working cards once per bot and keeps every live card', async () => {
    const thread = makeDs({ scope: 'thread', streamCardId: 'om_live_a' } as any, { sessionId: 'sid-a', rootMessageId: 'om_root_a' });
    const chat = makeDs({ scope: 'chat', streamCardId: 'om_live_b' } as any, { sessionId: 'sid-b', rootMessageId: 'om_root_b', chatId: 'oc_chat' });
    activate(thread, chat);
    listThreadMessagesMock.mockResolvedValue([
      listedCard('om_orphan_a', '🖥️ Claude · 进度如何 — 工作中'),
      listedCard('om_live_a', '🖥️ Claude · 用pil — 工作中'),
    ]);
    listChatMessagesMock.mockResolvedValue([
      listedCard('om_orphan_b', '🖥️ Pi · t — 工作中'),
      // Another session's live card in the same chat is never touched.
      listedCard('om_live_a', '🖥️ Claude · 用pil — 工作中'),
    ]);

    await sweepStaleWorkingCards('app_test');

    expect(listThreadMessagesMock).toHaveBeenCalledWith('app_test', 'oc_chat', 'om_root_a', expect.any(Number));
    expect(deleteMessageMock.mock.calls.map(c => c[1]).sort()).toEqual(['om_orphan_a', 'om_orphan_b']);
    expect(existsSync(join(dataDir, 'card-sweeps', 'app_test.stale-working-v1'))).toBe(true);

    deleteMessageMock.mockClear();
    await sweepStaleWorkingCards('app_test');
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('a failed listing only skips that container', async () => {
    const a = makeDs({ scope: 'thread', streamCardId: 'om_live_a' } as any, { sessionId: 'sid-a', rootMessageId: 'om_root_a' });
    const b = makeDs({ scope: 'thread', streamCardId: 'om_live_b' } as any, { sessionId: 'sid-b', rootMessageId: 'om_root_b' });
    activate(a, b);
    listThreadMessagesMock
      .mockRejectedValueOnce(new Error('no permission'))
      .mockResolvedValueOnce([listedCard('om_orphan_b', '🖥️ Claude · t — 工作中')]);

    await sweepStaleWorkingCards('app_test');

    expect(deleteMessageMock.mock.calls.map(c => c[1])).toEqual(['om_orphan_b']);
  });
});
