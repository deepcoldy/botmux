/**
 * 「显示 / 隐藏输出」 re-renders the streaming card from cached daemon state.
 *
 * `lastScreenStatus` lives only in memory: a session restored after a daemon
 * restart has none, and a worker that dies mid-turn leaves its last one behind.
 * With no worker there is no CLI behind the card, so a toggle must not bring
 * back 「工作中」 and a 「⏹ 停止」 button — the restart-time reconcile has just
 * set that card to 「等待输入」, and the toggle used to undo it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const updateMessageMock = vi.fn(async (..._args: any[]) => {});
const getMessageDetailMock = vi.fn(async (..._args: any[]): Promise<any> => ({}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => updateMessageMock(...args),
  getMessageDetail: (...args: any[]) => getMessageDetailMock(...args),
  deleteMessage: vi.fn(async () => true),
  sendUserMessage: vi.fn(),
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
  MessageUpdateExpiredError: class MessageUpdateExpiredError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: ['ou_user'],
    resolvedBlockedUsers: [],
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => 'feishu'),
  normalizeUsageDisplay: vi.fn(() => 'off'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    // unit-setup supplies a per-file temporary directory.
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
  getOwnedSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { STREAMING_CARD_PATCH_VERSION } from '../src/im/lark/card-builder.js';
import {
  cachedStreamingCardStatus,
  initWorkerPool,
  isSessionTransferring,
  reconcileRestoredStreamingCardStatus,
  setActiveSessionsRegistry,
  transferSession,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { activeSessionKey, sessionKey, type DaemonSession, type FrozenCard } from '../src/core/types.js';
import { t } from '../src/i18n/index.js';

const APP_ID = 'app_test';
const ROOT_ID = 'om_root';
const CARD_ID = 'om_card';
const NONCE = 'n_current';

const label = (key: string) => t(key, undefined, 'zh');
const IDLE = label('card.status.idle');
const WORKING = label('card.status.working');
const STARTING = label('card.status.starting');
const LIMITED = label('card.status.limited');
const STOP = label('card.btn.stop');
const UNAVAILABLE = label('card.status.screenshot_unavailable');

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn(() => true);
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

/** A session as restore leaves it: card ids persisted, runtime status absent. */
function makeRestoredDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-toggle-status',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: null,
    workerReady: false,
    workerPort: null,
    workerToken: null,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    streamCardId: CARD_ID,
    streamCardNonce: NONCE,
    currentTurnTitle: 'Test task',
    suppressRecoveryCard: true,
    ...overrides,
  } as DaemonSession;
}

function activate(ds: DaemonSession): CardHandlerDeps {
  const sessions = new Map<string, DaemonSession>([
    [activeSessionKey(ds), ds],
    [sessionKey(ROOT_ID, APP_ID), ds],
  ]);
  setActiveSessionsRegistry(sessions);
  return { activeSessions: sessions, sessionReply: vi.fn(async () => 'om_new'), lastRepoScan: new Map() } as any;
}

function toggle(cardNonce = NONCE, messageId = CARD_ID) {
  return {
    action: {
      value: {
        action: 'toggle_display',
        root_id: ROOT_ID,
        session_id: 'sid-toggle-status',
        card_nonce: cardNonce,
        stream_card_version: STREAMING_CARD_PATCH_VERSION,
      },
    },
    operator: { open_id: 'ou_user' },
    context: { open_message_id: messageId },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const patches = () => updateMessageMock.mock.calls.map(call => ({
  messageId: call[1] as string,
  card: JSON.parse(String(call[2])),
}));
const titleOf = (card: any): string => card.header.title.content;
const statusOf = (card: any): string => titleOf(card).slice(titleOf(card).lastIndexOf(' — ') + ' — '.length);
const buttonsOf = (card: any): any[] =>
  card.elements.filter((el: any) => el.tag === 'action').flatMap((el: any) => el.actions);
const hasStopButton = (card: any): boolean =>
  buttonsOf(card).some(b => b.value?.action === 'stop_turn' || b.text?.content === STOP);
const markdownOf = (card: any): string[] =>
  card.elements.filter((el: any) => el.tag === 'markdown').map((el: any) => el.content);

/** One toggle on the live card; returns the card it PATCHed. */
async function toggleCurrent(ds: DaemonSession, deps: CardHandlerDeps): Promise<any> {
  const before = updateMessageMock.mock.calls.length;
  await handleCardAction(toggle(), deps, APP_ID);
  await flush();
  expect(updateMessageMock.mock.calls.length).toBe(before + 1);
  const last = patches().at(-1)!;
  expect(last.messageId).toBe(ds.streamCardId);
  return last.card;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMessageMock.mockReset();
  updateMessageMock.mockImplementation(async () => {});
  getMessageDetailMock.mockReset();
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_new') as any,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
  setActiveSessionsRegistry(new Map());
});

describe('restored session with no CLI: reconcile, then show / hide output', () => {
  it('keeps the card at 等待输入 through both clicks, with no stop button', async () => {
    const ds = makeRestoredDs();
    const deps = activate(ds);
    getMessageDetailMock.mockResolvedValueOnce({
      items: [{
        message_id: CARD_ID,
        msg_type: 'interactive',
        body: { content: JSON.stringify({ header: { title: { tag: 'plain_text', content: `🖥️ Claude Code · Test task — ${WORKING}` } } }) },
      }],
    });

    await reconcileRestoredStreamingCardStatus(APP_ID);
    expect(patches()).toHaveLength(1);
    expect(statusOf(patches()[0].card)).toBe(IDLE);
    // Restore state is untouched: no worker, no runtime status.
    expect(ds.lastScreenStatus).toBeUndefined();

    const shown = await toggleCurrent(ds, deps);
    expect(ds.displayMode).toBe('screenshot');
    expect(statusOf(shown)).toBe(IDLE);
    expect(hasStopButton(shown)).toBe(false);
    expect(markdownOf(shown)).toContain(UNAVAILABLE);

    const hidden = await toggleCurrent(ds, deps);
    expect(ds.displayMode).toBe('hidden');
    expect(statusOf(hidden)).toBe(IDLE);
    expect(hasStopButton(hidden)).toBe(false);

    expect(patches().map(p => statusOf(p.card))).toEqual([IDLE, IDLE, IDLE]);
    expect(ds.lastScreenStatus).toBeUndefined();
  });
});

describe('toggle status without a fresh worker report', () => {
  it('no worker → 等待输入', async () => {
    const ds = makeRestoredDs();
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(IDLE);
    expect(hasStopButton(card)).toBe(false);
  });

  it('worker died mid-turn (stale working status and subtask count) → 等待输入', async () => {
    const worker = makeFakeWorker();
    const ds = makeRestoredDs({ worker, suppressRecoveryCard: false });
    const deps = activate(ds);
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'ready', port: 9999, token: 'tok' });
    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working', backgroundTasks: 2 });
    await flush();
    expect(ds.lastScreenStatus).toBe('working');

    worker.emit('exit', 1, null);
    await flush();
    expect(ds.worker).toBeNull();
    // The exit path keeps the last report; the card must not trust it.
    expect(ds.lastScreenStatus).toBe('working');
    expect(ds.backgroundTaskCount).toBe(2);

    const card = await toggleCurrent(ds, deps);
    expect(statusOf(card)).toBe(IDLE);
    expect(hasStopButton(card)).toBe(false);
  });

  it('worker not initialized yet → 启动中', async () => {
    const ds = makeRestoredDs({ worker: makeFakeWorker(), workerReady: false });
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(STARTING);
    expect(hasStopButton(card)).toBe(false);
  });

  it('worker that has not reported yet → what the starting card shows (Grok: 工作中)', async () => {
    const ds = makeRestoredDs({ worker: makeFakeWorker(), workerReady: true });
    ds.session.cliId = 'grok';
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(WORKING);
  });

  it('a routing transfer between workers is not mistaken for a stopped CLI', async () => {
    const ds = makeRestoredDs({ scope: 'thread', workingDir: '/tmp' } as Partial<DaemonSession>);
    Object.assign(ds.session, { scope: 'thread', larkAppId: APP_ID, cliId: 'claude-code', workingDir: '/tmp' });
    activate(ds);
    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>(resolve => { releaseDetach = resolve; }));
    const moving = transferSession(ds.session.sessionId, 'oc_target', 'om_target', 'group', 'chat',
      { detachWorkerImpl: detach, forkWorkerImpl: vi.fn() as any });
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(isSessionTransferring(ds)).toBe(true);
    expect(ds.worker).toBeNull();

    expect(cachedStreamingCardStatus(ds)).toBe('starting');

    releaseDetach(false);
    await moving.catch(() => undefined);
  });

  it('usage limit pending → 限额已达, with its retry time', async () => {
    const ds = makeRestoredDs({
      usageLimit: { limited: true, kind: 'usage', retryAtMs: Date.now() + 3_600_000, retryLabel: '23:59', retryReady: false },
    });
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(LIMITED);
    expect(markdownOf(card).some(md => md.includes('23:59'))).toBe(true);
    expect(hasStopButton(card)).toBe(false);
  });

  it('running worker with subtasks left → still shows them', async () => {
    const ds = makeRestoredDs({ worker: makeFakeWorker(), workerReady: true, lastScreenStatus: 'idle', backgroundTaskCount: 2 });
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(t('card.status.background_wait', { count: 2 }, 'zh'));
  });

  it('running worker reporting working → still 工作中 with the stop button', async () => {
    const ds = makeRestoredDs({ worker: makeFakeWorker(), workerReady: true, lastScreenStatus: 'working' });
    const card = await toggleCurrent(ds, activate(ds));
    expect(statusOf(card)).toBe(WORKING);
    expect(hasStopButton(card)).toBe(true);
  });
});

describe('historical cards with no worker', () => {
  it('a known frozen card does not come back as 工作中', async () => {
    const frozen: FrozenCard = { messageId: 'om_old', content: '', title: 'Old task', displayMode: 'hidden' };
    const ds = makeRestoredDs({ frozenCards: new Map([['n_old', frozen]]) });
    const result: any = await handleCardAction(toggle('n_old', 'om_old'), activate(ds), APP_ID);
    expect(statusOf(result)).toBe(IDLE);
    expect(hasStopButton(result)).toBe(false);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('an unknown frozen card does not come back as 工作中', async () => {
    const ds = makeRestoredDs({ frozenCards: new Map() });
    const result: any = await handleCardAction(toggle('n_unknown', 'om_stale'), activate(ds), APP_ID);
    expect(statusOf(result)).toBe(IDLE);
    expect(hasStopButton(result)).toBe(false);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});
