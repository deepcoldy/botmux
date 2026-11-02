/**
 * The recovery failure notice through the REAL worker IPC handlers
 * (__testOnly_setupWorkerHandlers + a fake worker, same harness shape as
 * test/session-cli-ready.test.ts): the daemon wiring — attach on handler
 * setup, `prompt_ready` → lost-continuation check, warn → durable notice →
 * `sessionReply` — is exercised end to end, not re-implemented in the test.
 *
 * Starting state is the 10-31 oncall session's shape: a Claude ordinary turn
 * whose delivered continuation never reported its terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  initWorkerPool,
  sendWorkerSessionInput,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';
import { disposeOrdinaryTurnRecovery } from '../src/services/ordinary-turn-recovery.js';
import type { DaemonSession } from '../src/core/types.js';

const recoveryCardMock = vi.fn((opts: any) => JSON.stringify({ recoveryCard: opts }));
const persistedRows: any[] = [];

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildTuiPromptCard: () => '{}',
  buildTuiPromptResolvedCard: () => '{}',
  buildTuiPromptFailedCard: () => '{}',
  buildTuiPromptProcessingCard: () => '{}',
  buildStreamingCard: () => '{}',
  buildSessionCard: () => '{}',
  buildTurnFailedCard: () => '{"legacyTurnFailed":true}',
  buildRecoveryFailedCard: (opts: any) => recoveryCardMock(opts),
  getCliDisplayName: () => 'Claude',
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({
    config: { larkAppId: 'cli_app', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  }),
  getAllBots: () => [],
  getOwnerOpenId: () => undefined,
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: () => {},
  cleanupSessionBridgeSendMarkers: () => {},
  cleanupSessionBridgeSendMarkersNow: () => {},
  closeSession: () => {},
  updateSession: (session: any) => { persistedRows.push(structuredClone(session)); },
  getSession: () => undefined,
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: () => new Map(),
  saveFrozenCards: () => {},
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: () => {},
  ensureSessionWhiteboard: () => {},
  rememberLastCliInput: () => {},
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: () => {} },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: () => {},
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: () => {},
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: () => undefined,
}));

vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenEnabled: () => false,
  isLocalCliOpenReady: () => false,
}));

const ASKER = 'ou_asker';
const ENVELOPE = '<role>oncall</role>\n<user_message>\n@Bot 私聊回复怎么都放进一个话题？\n</user_message>';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.connected = true;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 4242;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

let seq = 0;
const wired: DaemonSession[] = [];

function stuckSession(now: number): any {
  seq += 1;
  return {
    sessionId: `sid-recovery-notice-${seq}`,
    rootMessageId: 'om_root',
    chatId: 'oc_group',
    title: 'oncall',
    status: 'active',
    createdAt: new Date(now).toISOString(),
    chatType: 'group',
    scope: 'chat',
    cliId: 'claude-code',
    larkAppId: 'cli_app',
    turnReplyContexts: { om_A: { target: { mode: 'plain', chatId: 'oc_group' }, replyTargetSenderOpenId: ASKER, replyTargetSenderIsBot: false } },
    replyTargets: { om_A: { updatedAt: new Date(now - 6 * 60_000).toISOString(), senderOpenId: ASKER, participants: [{ openId: ASKER, isBot: false }] } },
    ordinaryTurnRecovery: {
      logicalTurnId: 'om_A',
      currentTurnId: 'bmx-recovery-lost',
      continuationsStarted: 1,
      status: 'running',
      lastErrorCode: 'provider_server_error',
      causeErrorCode: 'provider_server_error',
      dispatchedAt: now - 6 * 60_000,
      retryInputs: { om_A: { cliInput: ENVELOPE, trustedCaller: { requestUserOpenId: ASKER, requestLarkAppId: 'cli_app', senderType: 'user' } } },
    },
  };
}

function wire(session: any) {
  const worker = makeFakeWorker();
  const ds = {
    session,
    worker,
    workerPort: null,
    workerToken: null,
    workerGeneration: 1,
    larkAppId: 'cli_app',
    chatId: 'oc_group',
    chatType: 'group',
    scope: 'chat',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  wired.push(ds);
  return { ds, worker };
}

const recoveryCalls = (sessionReply: ReturnType<typeof vi.fn>) =>
  sessionReply.mock.calls.filter(call => typeof call[1] === 'string' && call[1].includes('recoveryCard'));

describe('recovery failure notice via the real worker IPC handlers', () => {
  let sessionReply: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-31T04:29:50.000Z'));
    __testOnly_resetRestartCoordinator();
    recoveryCardMock.mockClear();
    persistedRows.length = 0;
    sessionReply = vi.fn(async (..._args: any[]) => 'om_card');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  afterEach(() => {
    for (const ds of wired.splice(0)) disposeOrdinaryTurnRecovery(ds.session);
    vi.useRealTimers();
  });

  it('prompt_ready + idle grace settles the lost continuation and posts one card to the original turn', async () => {
    const { ds, worker } = wire(stuckSession(Date.now()));

    worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ds.session.ordinaryTurnRecovery?.status).toBe('running');
    expect(recoveryCalls(sessionReply)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ds.session.ordinaryTurnRecovery).toMatchObject({
      status: 'attention_required', lastErrorCode: 'recovery_outcome_unverified', warningDispatched: true,
    });
    const calls = recoveryCalls(sessionReply);
    expect(calls).toHaveLength(1);
    const [, , msgType, appId, turnId, opts] = calls[0];
    expect([msgType, appId, turnId]).toEqual(['interactive', 'cli_app', 'om_A']);
    expect(opts).toMatchObject({ uuid: expect.any(String) });
    expect(recoveryCardMock.mock.calls.at(-1)?.[0]).toMatchObject({
      logicalTurnId: 'om_A',
      mentionOpenId: ASKER,
      retry: { kind: 'available' },
      errorCodes: ['provider_server_error', 'recovery_outcome_unverified'],
    });
    // Status card follows into the failed end state.
    expect(ds.failedIdleTurnId).toBe('om_A');
    expect(persistedRows.at(-1)?.ordinaryRecoveryNotices?.[0]?.delivery?.state).toBe('delivered');

    // Later idle edges (polling) never post again.
    worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(recoveryCalls(sessionReply)).toHaveLength(1);
  });

  it('keeps retrying while Feishu rejects the send and lands the card once it recovers', async () => {
    sessionReply.mockImplementation(async (..._args: any[]) => {
      if (recoveryCalls(sessionReply).length <= 2) throw new Error('getaddrinfo ENOTFOUND open.feishu.cn');
      return 'om_card';
    });
    const { ds, worker } = wire(stuckSession(Date.now()));
    worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoveryCalls(sessionReply)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(recoveryCalls(sessionReply)).toHaveLength(3);
    expect(ds.session.ordinaryRecoveryNotices?.[0]?.delivery).toMatchObject({ state: 'delivered', attempts: 3 });
  });

  it('without frozen input keeps the admin continue button only when lastFailedTurn is this very turn', async () => {
    const pinned = stuckSession(Date.now());
    delete pinned.ordinaryTurnRecovery.retryInputs;
    pinned.lastFailedTurn = { turnId: 'om_A', userPrompt: 'q', cliInput: ENVELOPE, failedAt: new Date().toISOString(), status: 'failed', retryCount: 0 };
    const other = stuckSession(Date.now());
    delete other.ordinaryTurnRecovery.retryInputs;
    other.lastFailedTurn = { turnId: 'om_B', userPrompt: 'q2', cliInput: 'x', failedAt: new Date().toISOString(), status: 'failed', retryCount: 0 };

    for (const session of [pinned, other]) {
      const { worker } = wire(session);
      worker.emit('message', { type: 'prompt_ready' });
    }
    await vi.advanceTimersByTimeAsync(60_000);

    const retries = recoveryCardMock.mock.calls.map(([opts]) => [opts.sessionId, opts.retry]);
    expect(retries).toEqual(expect.arrayContaining([
      [pinned.sessionId, { kind: 'continue_legacy', turnId: 'om_A' }],
      [other.sessionId, { kind: 'none', reason: 'no_input' }],
    ]));
  });

  it('a type-ahead follow-up failing during the in-flight recovery gets its own durable recovery card, not the one-shot fallback', async () => {
    let feishuDown = true;
    sessionReply.mockImplementation(async (..._args: any[]) => {
      if (feishuDown) throw new Error('getaddrinfo EAI_AGAIN open.feishu.cn');
      return 'om_card';
    });
    const session = stuckSession(Date.now());
    session.ordinaryTurnRecovery.queuedLogicalTurnIds = ['om_B'];
    session.ordinaryTurnRecovery.retryInputs.om_B = {
      cliInput: '<user_message>\n@Bot 可以回答一下吗\n</user_message>',
      trustedCaller: { requestUserOpenId: ASKER, requestLarkAppId: 'cli_app', senderType: 'user' },
    };
    session.replyTargets.om_B = { updatedAt: new Date().toISOString(), senderOpenId: ASKER, participants: [{ openId: ASKER, isBot: false }] };
    const { ds, worker } = wire(session);

    worker.emit('message', {
      type: 'turn_terminal', sessionId: session.sessionId, turnId: 'om_B',
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionReply.mock.calls.some(call => String(call[1]).includes('legacyTurnFailed'))).toBe(false);
    expect(recoveryCardMock.mock.calls.at(-1)?.[0]).toMatchObject({ logicalTurnId: 'om_B', retry: { kind: 'available' } });
    expect(ds.session.ordinaryRecoveryNotices?.find(n => n.logicalTurnId === 'om_B')?.delivery.state).toBe('pending');

    feishuDown = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ds.session.ordinaryRecoveryNotices?.find(n => n.logicalTurnId === 'om_B')?.delivery.state).toBe('delivered');
    // The earlier turn's recovery is untouched and still owns the slot.
    expect(ds.session.ordinaryTurnRecovery).toMatchObject({ logicalTurnId: 'om_A', status: 'running' });
  });

  it('restart re-creates a notice that was owed but never recorded (died between the two writes); pre-upgrade states are left alone', async () => {
    const owed = stuckSession(Date.now());
    Object.assign(owed.ordinaryTurnRecovery, {
      status: 'attention_required', lastErrorCode: 'recovery_outcome_unverified',
      warningDispatched: true, alertSentAt: Date.now(), failureNoticeOwed: true,
    });
    const legacy = stuckSession(Date.now());
    Object.assign(legacy.ordinaryTurnRecovery, {
      status: 'exhausted', warningDispatched: true, alertSentAt: Date.now(),
    });
    wire(owed);
    wire(legacy);
    await vi.advanceTimersByTimeAsync(60_000);

    const cardSessions = recoveryCardMock.mock.calls.map(([opts]) => opts.sessionId);
    expect(cardSessions.filter(id => id === owed.sessionId)).toHaveLength(1);
    expect(cardSessions.filter(id => id === legacy.sessionId)).toHaveLength(0);
  });

  it('a user stop on the Claude session cancels the in-flight continuation: no failure card afterwards', async () => {
    const { ds, worker } = wire(stuckSession(Date.now()));
    sendWorkerSessionInput(ds, { type: 'term_action', key: 'ctrlc' } as any);
    expect(ds.session.ordinaryTurnRecovery).toMatchObject({ status: 'cancelled', cancelledByTurnId: 'stop' });

    worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(recoveryCalls(sessionReply)).toHaveLength(0);
  });

  it('a daemon restart re-attaches without posting the delivered card again', async () => {
    const { worker } = wire(stuckSession(Date.now()));
    worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoveryCalls(sessionReply)).toHaveLength(1);
    const durable = structuredClone(persistedRows.at(-1));

    // New process: only the durable row survives.
    for (const ds of wired.splice(0)) disposeOrdinaryTurnRecovery(ds.session);
    vi.setSystemTime(new Date(Date.now() + 16 * 60 * 60_000));
    const restarted = wire(durable);
    restarted.worker.emit('message', { type: 'prompt_ready' });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(recoveryCalls(sessionReply)).toHaveLength(1);
    expect(restarted.ds.session.ordinaryTurnRecovery?.status).toBe('attention_required');
  });
});
