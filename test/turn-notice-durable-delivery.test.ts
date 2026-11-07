/**
 * #2687: a turn failure card or a worker `user_notify` whose send hits a
 * Feishu transport failure (DNS, refused connection, open circuit, reset
 * mid-request) is kept on the session and retried with the same Feishu uuid
 * until it lands, instead of being logged once and dropped. A deterministic
 * rejection from Feishu (content audit, …) keeps the old log-and-drop path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  buildTurnFailedCard: vi.fn(() => '{"type":"turn_failed"}'),
  buildInputNotSubmittedCard: vi.fn(() => '{"type":"input_not_submitted"}'),
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
  getOwnerOpenId: vi.fn(() => undefined),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

const updateSessionMock = vi.fn();
const sessionReplyMock = vi.fn(async (..._args: any[]) => 'om_reply');
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
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

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

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

function makeDs(sessionId: string, worker: any): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as DaemonSession;
}

const dnsFailure = () => Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });
const resetMidRequest = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const contentAudit = () => Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { code: 230028, msg: 'content audit' } },
});

const serverError = () => Object.assign(new Error('Request failed with status code 503'), {
  isAxiosError: true,
  response: { status: 503, data: {} },
});
const rateLimited = () => Object.assign(new Error('Request failed with status code 400'), {
  isAxiosError: true,
  response: { status: 400, data: { code: 230020, msg: 'rate limited' } },
});
const topicCheckFailed = () => Object.assign(new Error('TOPIC_SEND_CHECK_FAILED: lookup failed'), {
  name: 'TopicSendError',
  code: 'TOPIC_SEND_CHECK_FAILED',
  cause: resetMidRequest(),
});

const calls = () => sessionReplyMock.mock.calls as any[][];

describe('durable delivery of failure cards and worker notices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionReplyMock.mockImplementation(async () => 'om_reply');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends a user_notify that could not reach Feishu, once, with the same uuid', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-notify-dns', worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    sessionReplyMock.mockRejectedValueOnce(dnsFailure());

    worker.emit('message', { type: 'user_notify', message: '消息未提交，请重试', turnId: 'om_turn_1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls()).toHaveLength(2);
    const [first, retry] = calls();
    expect(retry[1]).toBe('消息未提交，请重试');
    expect(retry[2]).toBe('text');
    expect(retry[4]).toBe('om_turn_1');
    expect(retry[5]?.uuid).toBeTruthy();
    expect(retry[5]?.uuid).toBe(first[5]?.uuid);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toHaveLength(2);
  });

  it('retries a failure card whose send outcome is unknown with the same uuid and card', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-card-reset', worker);
    // A CLI without ordinary-turn recovery and a legacy-card turn: the plain
    // failure card owns this terminal.
    ds.session.cliId = 'dsh';
    __testOnly_setupWorkerHandlers(ds, worker);
    sessionReplyMock.mockRejectedValueOnce(resetMidRequest());

    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'turn-2', status: 'ambiguous' });
    await vi.advanceTimersByTimeAsync(0);
    const cardCalls = () => calls().filter(c => c[2] === 'interactive');
    expect(cardCalls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(cardCalls()).toHaveLength(2);
    const [first, retry] = cardCalls();
    expect(retry[1]).toBe(first[1]);
    expect(retry[4]).toBe('turn-2');
    expect(retry[5]?.uuid).toBeTruthy();
    expect(retry[5]?.uuid).toBe(first[5]?.uuid);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(cardCalls()).toHaveLength(2);
  });

  it.each([
    ['a Feishu server error', serverError],
    ['a transient Feishu rate-limit code', rateLimited],
    ['a pre-send topic check that failed on the network', topicCheckFailed],
  ])('retries a notice whose send hit %s', async (_label, failure) => {
    const worker = makeFakeWorker();
    const ds = makeDs(`sid-notify-${failure.name}`, worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    sessionReplyMock.mockRejectedValueOnce(failure());

    worker.emit('message', { type: 'user_notify', message: 'transient failure', turnId: 'om_turn_6' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][5]?.uuid).toBe(calls()[0][5]?.uuid);
  });

  it('stops at a deterministic rejection from Feishu, on the first send or on a retry', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-notify-audit', worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    sessionReplyMock.mockRejectedValueOnce(contentAudit());

    worker.emit('message', { type: 'user_notify', message: 'blocked text', turnId: 'om_turn_3' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toHaveLength(1);

    sessionReplyMock.mockRejectedValueOnce(dnsFailure()).mockRejectedValueOnce(contentAudit());
    worker.emit('message', { type: 'user_notify', message: 'blocked later', turnId: 'om_turn_5' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toHaveLength(3);
  });

  it('resumes a notice still owed from before a daemon restart and never re-sends it once delivered', async () => {
    const pending = {
      kind: 'user_notify',
      turnId: 'om_turn_4',
      msgType: 'text',
      content: 'owed notice',
      createdAt: Date.now() - 60_000,
      delivery: { state: 'pending', attempts: 1, uuid: 'uuid-owed-notice', nextAttemptAt: Date.now() - 1_000 },
    };
    const worker = makeFakeWorker();
    const ds = makeDs('sid-notify-restart', worker);
    (ds.session as any).turnNotices = [pending];
    __testOnly_setupWorkerHandlers(ds, worker);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toHaveLength(1);
    expect(calls()[0][1]).toBe('owed notice');
    expect(calls()[0][4]).toBe('om_turn_4');
    expect(calls()[0][5]?.uuid).toBe('uuid-owed-notice');

    const nextWorker = makeFakeWorker();
    ds.worker = nextWorker;
    __testOnly_setupWorkerHandlers(ds, nextWorker);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toHaveLength(1);
  });
});
