/**
 * Route-level regression guard for `/rename` (PR review P1).
 *
 * `/rename` is a DAEMON_COMMAND, and the daemon's production routes
 * (handleNewTopic / handleThreadReply) pre-create a sessionStore record +
 * activeSessions entry (worker:null) for session-needing daemon commands
 * BEFORE calling handleCommand. That made command-handler's `if (!ds)`
 * no-active-session branch dead code in production: `/rename Foo` in a fresh
 * topic (or a thread with no session) silently created a phantom session and
 * renamed it — polluting the dashboard's session list.
 *
 * The unit tests in command-handler.test.ts call handleCommand directly and
 * can never catch this, so this file drives the REAL routing handlers and
 * asserts:
 *   - `/rename` with no session: NO sessionStore.createSession, NO
 *     activeSessions entry, and a plain no-active-session reply — on BOTH
 *     production entry paths;
 *   - `/rename` with an existing session still renames it;
 *   - the generic pre-create block stays intact for other session-needing
 *     daemon commands (`/status` as control).
 *
 * Run:  pnpm vitest run test/daemon-rename-route.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  // Isolate every sessionStore/config read-write under a per-process temp dir
  // (no fs imports here — hoisted code runs before module imports initialize),
  // and make sure hook events run the local (no-op, nothing configured) path
  // instead of forwarding to a live daemon when the test itself runs inside a
  // botmux session shell.
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-rename-route-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    }),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, replyMessage: mocks.replyMessage, sendMessage: mocks.sendMessage, getChatMode: mocks.getChatMode };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionAnchorId, sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_claimNewDaemonSession as claimNewDaemonSession,
  __testOnly_handleChatModeConverted as handleChatModeConverted,
  __testOnly_handleDocComment as handleDocComment,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_onQueuedActivationSubmitted as onQueuedActivationSubmitted,
  __testOnly_prewarmDocCommentSession as prewarmDocCommentSession,
  __testOnly_releaseQueuedActivationReservation as releaseQueuedActivationReservation,
  __testOnly_reserveAsyncQueuedActivationTailAdmission as reserveAsyncQueuedActivationTailAdmission,
  __testOnly_resetDocCommentClaims as resetDocCommentClaims,
  __testOnly_settleAsyncQueuedActivationTailAdmission as settleAsyncQueuedActivationTailAdmission,
} from '../src/daemon.js';
import { admitQueuedActivationTail } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getDocSubscription, putDocSubscription, removeDocSubscription } from '../src/services/doc-subs-store.js';
import { config } from '../src/config.js';

const APP = 'rename_route_app';
const CHAT = 'oc_rename_route_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function seedThreadSession(anchor: string, title: string): DaemonSession {
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: null,
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    session: {
      sessionId: 'sess-seeded-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title,
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

function makeChatSession(sessionId: string, chatId: string, options?: {
  pendingLedger?: boolean;
  pendingRepo?: boolean;
  queued?: boolean;
}): DaemonSession {
  const session = {
    sessionId,
    chatId,
    rootMessageId: `om_${sessionId}`,
    title: sessionId,
    status: 'active' as const,
    createdAt: NOW,
    larkAppId: APP,
    scope: 'chat' as const,
    chatType: 'group' as const,
    queued: options?.queued,
    codexAppDispatchLedger: options?.pendingLedger ? [{
      dispatchId: `dispatch-${sessionId}`,
      turnId: `turn-${sessionId}`,
      dispatchAttempt: 1,
      state: 'prepared' as const,
      content: 'durable work',
      deliverySink: 'lark' as const,
    }] : undefined,
  };
  mocks.sessions.set(sessionId, session);
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: options?.pendingRepo,
  } as DaemonSession;
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

describe('/rename production routing — must not pre-create a session (review P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    resetDocCommentClaims();
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('new topic: `/rename Foo` replies no-active-session and creates NOTHING', async () => {
    await handleNewTopic(makeEventData('om_new_1', '/rename Foo'), makeCtx('om_new_1', 'om_new_1'));

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
    expect(repliedText()).toContain('没有活跃的会话');
  });

  it('thread reply with no existing session: `/rename Foo` replies no-active-session and creates NOTHING', async () => {
    await handleThreadReply(
      makeEventData('om_reply_1', '/rename Foo', 'om_root_1'),
      makeCtx('om_root_1', 'om_reply_1'),
    );

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
    expect(repliedText()).toContain('没有活跃的会话');
  });

  it('thread reply with an existing session: `/rename` renames it in place', async () => {
    const ds = seedThreadSession('om_root_2', '旧标题');

    await handleThreadReply(
      makeEventData('om_reply_2', '/rename ZMX 后端集成推进', 'om_root_2'),
      makeCtx('om_root_2', 'om_reply_2'),
    );

    expect(ds.session.title).toBe('ZMX 后端集成推进');
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);
    expect(mocks.createSession).not.toHaveBeenCalled();
    // Still exactly the seeded session — nothing new registered.
    expect(activeSessions.size).toBe(1);
    expect(activeSessions.get(sessionKey('om_root_2', APP))).toBe(ds);
    expect(repliedText()).toContain('会话标题已更新');
  });

  it('non-allowedUsers sender: `/rename` is denied by canOperate on BOTH routes, nothing created/renamed', async () => {
    // The /rename handler itself has no permission gate — it relies entirely on
    // the routes' canOperate gate running BEFORE the existing-session-only
    // special case. This pins that ordering: moving the special case above the
    // gate (e.g. to literally mirror /card//term placement) must fail here.
    const stranger = { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' };

    // Leg 1 — new topic. Assert the denial text per leg: a no_active_session
    // reply here would mean handleCommand ran BEFORE the gate.
    const newTopicData = makeEventData('om_new_3', '/rename Hacked');
    newTopicData.sender = stranger;
    await handleNewTopic(newTopicData, makeCtx('om_new_3', 'om_new_3'));
    expect(repliedText()).toContain('仅 allowedUsers 可执行');
    expect(repliedText()).not.toContain('没有活跃的会话');

    // Leg 2 — thread reply against a seeded session: the rename must not land.
    mocks.replyMessage.mockClear();
    mocks.sendMessage.mockClear();
    const ds = seedThreadSession('om_root_3', '原标题');
    const replyData = makeEventData('om_reply_3', '/rename Hacked', 'om_root_3');
    replyData.sender = stranger;
    await handleThreadReply(replyData, makeCtx('om_root_3', 'om_reply_3'));
    expect(repliedText()).toContain('仅 allowedUsers 可执行');

    expect(ds.session.title).toBe('原标题');
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1); // only the seeded session
  });

  it('control: `/status` in a new topic still pre-creates the session (generic block intact)', async () => {
    await handleNewTopic(makeEventData('om_new_2', '/status'), makeCtx('om_new_2', 'om_new_2'));

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(activeSessions.has(sessionKey('om_new_2', APP))).toBe(true);
  });

  it('routes a colliding daemon command to the canonical pending owner and closes only the loser', async () => {
    const anchor = 'om_pending_owner';
    const incumbent = seedThreadSession(anchor, 'durable owner');
    incumbent.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-incumbent',
      turnId: 'turn-incumbent',
      dispatchAttempt: 1,
      state: 'prepared',
      content: 'accepted input',
      deliverySink: 'lark',
    }];

    await handleNewTopic(makeEventData(anchor, '/status'), makeCtx(anchor, anchor));

    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(incumbent);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const incomingId = mocks.createSession.mock.results[0]!.value.sessionId;
    expect(mocks.closeSession).toHaveBeenCalledWith(incomingId);
    expect(mocks.closeSession).not.toHaveBeenCalledWith(incumbent.session.sessionId);
    expect(repliedText()).toContain(`Session: ${incumbent.session.sessionId}`);
  });

  it('delivers an ordinary loser turn to the canonical owner exactly once', async () => {
    const anchor = 'om_collision_delivery';
    const incumbent = seedThreadSession(anchor, 'canonical owner');
    const send = vi.fn();
    incumbent.worker = { killed: false, send } as any;

    await handleNewTopic(
      makeEventData(anchor, 'deliver this once'),
      makeCtx(anchor, anchor),
    );

    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(incumbent);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).toHaveBeenCalledWith(
      mocks.createSession.mock.results[0]!.value.sessionId,
    );
    const inputCalls = send.mock.calls.filter(call => call[0]?.type === 'message');
    expect(inputCalls).toHaveLength(1);
    expect(JSON.stringify(inputCalls[0]![0])).toContain('deliver this once');
  });

  it('buffers a later turn while the winning initial start is paused, then forks once in input order', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      defaultWorkingDir: '/tmp',
    }).resolvedAllowedUsers = [OWNER];

    let announcePreparation!: () => void;
    const preparationStarted = new Promise<void>(resolve => { announcePreparation = resolve; });
    let releasePreparation!: (bots: any[]) => void;
    const preparationGate = new Promise<any[]>(resolve => { releasePreparation = resolve; });
    mocks.getAvailableBots.mockImplementationOnce(async () => {
      announcePreparation();
      return preparationGate;
    });

    const anchor = 'om_initial_order_root';
    const first = handleNewTopic(
      makeEventData(anchor, 'first task'),
      makeCtx(anchor, anchor),
    );
    await preparationStarted;

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(owner.initialStartPending).toBe(true);
    expect(owner.worker).toBeNull();

    await handleThreadReply(
      makeEventData('om_initial_order_second', 'second task', anchor),
      makeCtx(anchor, 'om_initial_order_second'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(owner.pendingFollowUps).toBeUndefined();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_initial_order_second',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('second task'),
        }),
      }),
    ]);

    releasePreparation([]);
    await first;

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const openingInput = mocks.forkWorker.mock.calls[0]![1];
    expect(openingInput.content.indexOf('first task')).toBeGreaterThanOrEqual(0);
    expect(openingInput.content).not.toContain('second task');
    expect(owner.worker!.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_initial_order_second',
      content: expect.stringContaining('second task'),
      queuedActivationToken: expect.any(String),
    }));
    expect(owner.initialStartPending).toBe(true);
    expect(owner.pendingFollowUps).toBeUndefined();
  });

  it('keeps the no-project text fallback gated until its queued activation ACK', async () => {
    const anchor = 'om_no_project_text_cutpoint';
    const openingToken = 'token-no-project-text';
    const send = vi.fn();
    mocks.forkWorker.mockImplementationOnce((owner: any, input: any) => {
      expect(owner.session.queued).toBe(true);
      expect(input.content).toContain('OPENING_TEXT_N');
      Object.assign(owner.session, {
        queued: false,
        queuedActivationPending: true,
        queuedActivationToken: openingToken,
        queuedActivationInput: input,
        queuedActivationTurnId: anchor,
        queuedActivationResume: false,
      });
      owner.worker = { killed: false, send };
    });

    await handleNewTopic(
      makeEventData(anchor, 'OPENING_TEXT_N'),
      makeCtx(anchor, anchor),
    );

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(mocks.scanMultipleProjects).toHaveBeenCalled();
    expect(owner.pendingRepo).toBe(false);
    expect(owner.initialStartPending).toBe(true);
    expect(owner.session.queuedActivationToken).toBe(openingToken);

    await handleThreadReply(
      makeEventData('om_no_project_text_n1', 'FOLLOWER_TEXT_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_no_project_text_n1'),
    );

    expect(send).not.toHaveBeenCalled();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_no_project_text_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_TEXT_N_PLUS_1'),
        }),
      }),
    ]);

    Object.assign(owner.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationResume: undefined,
      pendingRepoSetup: undefined,
    });
    expect(onQueuedActivationSubmitted(owner, openingToken)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_no_project_text_n1',
      content: expect.stringContaining('FOLLOWER_TEXT_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
  });

  it('keeps the no-project raw fallback gated through raw text-to-Enter ACK', async () => {
    const anchor = 'om_no_project_raw_cutpoint';
    const openingToken = 'token-no-project-raw';
    const rawOpening = '/goal OPENING_RAW_N';
    const send = vi.fn();
    mocks.forkWorker.mockImplementationOnce((owner: any, input: any) => {
      expect(owner.session.queued).toBe(true);
      expect(input).toBe('');
      expect(owner.pendingRawInput).toBe(rawOpening);
      Object.assign(owner.session, {
        queued: false,
        queuedActivationPending: true,
        queuedActivationToken: openingToken,
        queuedActivationInput: { content: '' },
        queuedActivationTurnId: anchor,
        queuedActivationResume: false,
      });
      owner.worker = { killed: false, send };
    });

    await handleNewTopic(
      makeEventData(anchor, rawOpening),
      makeCtx(anchor, anchor),
    );

    const owner = activeSessions.get(sessionKey(anchor, APP))!;
    expect(mocks.scanMultipleProjects).toHaveBeenCalled();
    expect(owner.pendingRepo).toBe(false);
    expect(owner.initialStartPending).toBe(true);
    expect(owner.session.queuedActivationToken).toBe(openingToken);

    await handleThreadReply(
      makeEventData('om_no_project_raw_n1', 'FOLLOWER_AFTER_RAW_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_no_project_raw_n1'),
    );

    // The follower must stay durable until the adapter confirms that both the
    // raw command text and its Enter beat were submitted.
    expect(send).not.toHaveBeenCalled();
    expect(owner.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_no_project_raw_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_AFTER_RAW_N_PLUS_1'),
        }),
      }),
    ]);

    Object.assign(owner.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationResume: undefined,
      pendingRepoSetup: undefined,
    });
    expect(onQueuedActivationSubmitted(owner, openingToken)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_no_project_raw_n1',
      content: expect.stringContaining('FOLLOWER_AFTER_RAW_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
  });

  it('refuses an existing raw CLI passthrough while activation admission owns the route', async () => {
    const anchor = 'om_passthrough_activation';
    const owner = seedThreadSession(anchor, 'activation owner');
    const send = vi.fn();
    owner.worker = { killed: false, send } as any;
    Object.assign(owner.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'passthrough-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });

    await handleThreadReply(
      makeEventData('om_passthrough_n1', '/model opus', anchor),
      makeCtx(anchor, 'om_passthrough_n1'),
    );

    expect(send).not.toHaveBeenCalled();
    expect(owner.currentTurnTitle).toBeUndefined();
    expect(owner.session.queuedActivationToken).toBe('passthrough-token');
    expect(repliedText()).toContain('仍在提交中');
  });

  it.each([
    ['close preparing', { riffCloseState: { phase: 'preparing', requestId: 'close-preparing' } }],
    ['close prepared', { riffCloseState: { phase: 'prepared', requestId: 'close-prepared' } }],
    ['shutdown prepared', {
      riffShutdownState: {
        phase: 'prepared', requestId: 'shutdown-prepared', taskId: 'task-fenced',
      },
    }],
  ] as const)('refuses raw CLI passthrough during Riff retirement (%s)', async (_label, state) => {
    const anchor = `om_passthrough_${_label.replace(/ /g, '_')}`;
    const owner = seedThreadSession(anchor, 'retirement owner');
    const send = vi.fn();
    owner.worker = { killed: false, send } as any;
    Object.assign(owner, state);
    const priorActivity = owner.lastMessageAt;

    await handleThreadReply(
      makeEventData(`om_passthrough_turn_${_label}`, '/model opus', anchor),
      makeCtx(anchor, `om_passthrough_turn_${_label}`),
    );

    expect(send).not.toHaveBeenCalled();
    expect(owner.currentTurnTitle).toBeUndefined();
    expect(owner.lastMessageAt).toBe(priorActivity);
    expect(repliedText()).toContain('Riff');
  });

  it('preserves an ordinary inbound turn before acceptance after the fenced worker exited', async () => {
    const anchor = 'om_workerless_shutdown_fence';
    const owner = seedThreadSession(anchor, 'workerless fenced owner');
    owner.worker = null;
    owner.session.backendType = 'riff';
    owner.riffShutdownState = {
      phase: 'prepared',
      requestId: 'shutdown-worker-exited',
      taskId: 'task-unverified',
    };

    await handleThreadReply(
      makeEventData('om_workerless_fenced_turn', 'MUST_RETRY_EXACTLY', anchor),
      makeCtx(anchor, 'om_workerless_fenced_turn'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(owner.riffShutdownState).toMatchObject({ requestId: 'shutdown-worker-exited' });
    expect(repliedText()).toContain('Riff');
  });

  it('replays a retained queued activation exactly, then releases the later inbound with its own turn id', async () => {
    const anchor = 'om_reparked_activation_root';
    const ds = seedThreadSession(anchor, 're-parked activation');
    const exactOpening = {
      content: '<user_message>BACKLOG_N\n\nPRIOR_TRIGGER_REPLY</user_message>',
    };
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'STALE_REBUILD_SOURCE_MUST_NOT_BE_USED',
      queuedActivationInput: exactOpening,
      queuedActivationTurnId: 'om_prior_trigger',
      queuedActivationDispatchAttempt: 4,
    });
    ds.workingDir = '/tmp';

    await handleThreadReply(
      makeEventData('om_later_n_plus_1', 'LATER_REPLY_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_later_n_plus_1'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, exactOpening, {
      resume: false,
      turnId: 'om_prior_trigger',
      dispatchAttempt: 4,
    });
    expect(mocks.forkWorker.mock.calls[0]![1]).toBe(exactOpening);
    expect(JSON.stringify(mocks.forkWorker.mock.calls[0]![1]))
      .not.toContain('STALE_REBUILD_SOURCE_MUST_NOT_BE_USED');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_later_n_plus_1',
        userPrompt: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
        cliInput: expect.objectContaining({
          content: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
        }),
      }),
    ]);

    const send = vi.mocked(ds.worker!.send);
    expect(releaseQueuedActivationReservation(ds)).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_later_n_plus_1',
      content: expect.stringContaining('LATER_REPLY_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.invocationCallOrder[0])
      .toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationInput?.content).toContain('LATER_REPLY_N_PLUS_1');
    const successorToken = ds.session.queuedActivationToken!;
    // The worker-pool clears the tokened journal durably before invoking the
    // daemon callback. Model that adapter ACK boundary explicitly here.
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, successorToken)).toBe(true);
    expect(ds.initialStartPending).toBe(false);
  });

  it('atomically claims a fresh queued refork so a concurrent reply buffers behind its owner', async () => {
    const anchor = 'om_fresh_queued_claim_root';
    const ds = seedThreadSession(anchor, 'fresh queued claim');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'BACKLOG_N',
    });
    ds.workingDir = '/tmp';

    let announceFirstDownload!: () => void;
    const firstDownloadStarted = new Promise<void>(resolve => { announceFirstDownload = resolve; });
    let releaseFirstDownload!: () => void;
    const firstDownloadGate = new Promise<void>(resolve => { releaseFirstDownload = resolve; });
    mocks.downloadResources.mockImplementationOnce(async () => {
      announceFirstDownload();
      await firstDownloadGate;
      return { attachments: [], needLogin: false };
    });

    const first = handleThreadReply(
      makeEventData('om_fresh_owner_n', 'OWNER_REPLY_N', anchor),
      makeCtx(anchor, 'om_fresh_owner_n'),
    );
    await firstDownloadStarted;

    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toEqual(expect.any(String));
    const ownerToken = ds.initialStartClaimToken;

    const follower = handleThreadReply(
      makeEventData('om_fresh_follower_n1', 'FOLLOWER_REPLY_N_PLUS_1', anchor),
      makeCtx(anchor, 'om_fresh_follower_n1'),
    );

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.initialStartClaimToken).toBe(ownerToken);

    releaseFirstDownload();
    await first;
    await follower;

    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'om_fresh_follower_n1',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('FOLLOWER_REPLY_N_PLUS_1'),
        }),
      }),
    ]);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const opening = mocks.forkWorker.mock.calls[0]![1];
    expect(opening.content.indexOf('BACKLOG_N')).toBeGreaterThanOrEqual(0);
    expect(opening.content.indexOf('OWNER_REPLY_N')).toBeGreaterThan(opening.content.indexOf('BACKLOG_N'));
    expect(opening.content).not.toContain('FOLLOWER_REPLY_N_PLUS_1');
    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toBe(ownerToken);

    const send = vi.mocked(ds.worker!.send);
    expect(onQueuedActivationSubmitted(ds)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_fresh_follower_n1',
      content: expect.stringContaining('FOLLOWER_REPLY_N_PLUS_1'),
      queuedActivationToken: expect.any(String),
    }));
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationInput?.content).toContain('FOLLOWER_REPLY_N_PLUS_1');
    const successorToken = ds.session.queuedActivationToken!;
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, successorToken)).toBe(true);
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
  });

  it.each([
    { arrivalGate: true, laterGate: false, expectsSidecar: true, label: 'ON→OFF' },
    { arrivalGate: false, laterGate: true, expectsSidecar: false, label: 'OFF→ON' },
  ])(
    'freezes a queued follower clean-input decision at reservation time ($label)',
    ({ arrivalGate, laterGate, expectsSidecar }) => {
      const bot = registerBot({
        larkAppId: APP,
        larkAppSecret: 's',
        cliId: 'codex-app',
        codexAppCleanInput: arrivalGate,
        allowedUsers: [OWNER],
      });
      bot.resolvedAllowedUsers = [OWNER];
      const ds = seedThreadSession(`om_gate_${arrivalGate}`, 'clean-input reservation');
      const send = vi.fn();
      ds.worker = { killed: false, send } as any;
      ds.initialStartPending = true;
      ds.hasHistory = true;
      ds.session.cliId = 'codex-app';

      const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
      expect(ds.queuedActivationTailAdmissionsOutstanding).toBe(1);
      bot.config.codexAppCleanInput = laterGate;

      // Model N's ACK landing while N+1 is still awaiting prompt materialization.
      expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
      const sidecar = {
        text: 'FOLLOWER_CLEAN_N1',
        additionalContext: {
          hidden: { kind: 'application' as const, value: '<hidden>arrival</hidden>' },
        },
      };
      admitQueuedActivationTail(ds, {
        userPrompt: 'FOLLOWER_CLEAN_N1',
        cliInput: {
          content: '<user_message>FOLLOWER_LEGACY_N1</user_message>',
          codexAppInput: sidecar,
        },
        turnId: 'turn-clean-follower',
        dispatchAttempt: 2,
      }, reservation);
      settleAsyncQueuedActivationTailAdmission(ds);

      const expectedSidecar = expectsSidecar
        ? { ...sidecar, clientUserMessageId: 'turn-clean-follower' }
        : undefined;
      expect(ds.queuedActivationTailAdmissionsOutstanding).toBeUndefined();
      expect(ds.queuedActivationTailReleasePending).toBeUndefined();
      expect(ds.session.queuedActivationTail).toBeUndefined();
      expect(ds.session.queuedActivationInput?.codexAppInput).toEqual(expectedSidecar);
      expect(ds.session.codexAppDispatchLedger?.at(-1)?.codexAppInput)
        .toEqual(expectedSidecar);
      expect(ds.session.lastCodexAppInput).toEqual(expectedSidecar);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message',
        turnId: 'turn-clean-follower',
        ...(expectedSidecar ? { codexAppInput: expectedSidecar } : {}),
      }));
      if (!expectedSidecar) {
        expect(send.mock.calls[0]![0]).not.toHaveProperty('codexAppInput');
      }
    },
  );

  it('parks a late follower after ACK→worker-exit and reforks it before the next inbound', async () => {
    const anchor = 'om_ack_exit_late_admission';
    const ds = seedThreadSession(anchor, 'ACK exit late admission');
    ds.session.cliId = 'claude-code';
    ds.workingDir = '/tmp';
    ds.session.workingDir = '/tmp';
    ds.hasHistory = true;
    ds.initialStartPending = true;
    ds.worker = { killed: false, send: vi.fn() } as any;

    const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
    expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
    // N's worker exits after its ACK but before the reserved N+1 finishes.
    ds.worker = null;
    admitQueuedActivationTail(ds, {
      userPrompt: 'LATE_N_PLUS_1',
      cliInput: { content: 'LATE_N_PLUS_1' },
      turnId: 'turn-late-n1',
    }, reservation);
    settleAsyncQueuedActivationTailAdmission(ds);

    expect(ds.session).toMatchObject({
      queuedActivationPending: true,
      queuedActivationInput: { content: 'LATE_N_PLUS_1' },
      queuedActivationTurnId: 'turn-late-n1',
    });
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
    expect(ds.queuedActivationTailReleaseRetryTimer).toBeUndefined();

    mocks.forkWorker.mockClear();
    await handleThreadReply(
      makeEventData('turn-after-late-n2', 'AFTER_LATE_N_PLUS_2', anchor),
      makeCtx(anchor, 'turn-after-late-n2'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]![1]).toBe(ds.session.queuedActivationInput);
    expect(mocks.forkWorker.mock.calls[0]![1].content).toBe('LATE_N_PLUS_1');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'turn-after-late-n2',
        cliInput: expect.objectContaining({
          content: expect.stringContaining('AFTER_LATE_N_PLUS_2'),
        }),
      }),
    ]);
  });

  it('releases the route when a post-ACK async follower admission fails', () => {
    const ds = seedThreadSession('om_failed_late_admission', 'failed late admission');
    ds.session.cliId = 'claude-code';
    ds.initialStartPending = true;
    ds.worker = { killed: false, send: vi.fn() } as any;
    const reservation = reserveAsyncQueuedActivationTailAdmission(ds);
    expect(releaseQueuedActivationReservation(ds, 'opening-token')).toBe(false);
    mocks.updateSession.mockImplementationOnce(() => {
      throw new Error('tail persistence unavailable');
    });

    expect(() => {
      try {
        admitQueuedActivationTail(ds, {
          userPrompt: 'FAILED_N_PLUS_1',
          cliInput: { content: 'FAILED_N_PLUS_1' },
          turnId: 'turn-failed-n1',
        }, reservation);
      } finally {
        settleAsyncQueuedActivationTailAdmission(ds);
      }
    }).toThrow('tail persistence unavailable');

    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.queuedActivationTailAdmissionsOutstanding).toBeUndefined();
    expect(ds.queuedActivationTailReleasePending).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();
    expect(ds.queuedActivationTailReleaseRetryTimer).toBeUndefined();
  });

  it('releases a failed queued-refork claim so a later inbound can become the owner', async () => {
    const anchor = 'om_failed_queued_claim_root';
    const ds = seedThreadSession(anchor, 'failed queued claim');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: true,
      queuedPrompt: 'BACKLOG_RETRY',
    });
    ds.workingDir = '/tmp';
    mocks.forkWorker.mockImplementationOnce(() => {
      throw new Error('pre-fork acceptance failed');
    });

    await expect(handleThreadReply(
      makeEventData('om_failed_owner', 'FAILED_OWNER_REPLY', anchor),
      makeCtx(anchor, 'om_failed_owner'),
    )).rejects.toThrow('pre-fork acceptance failed');

    expect(ds.worker).toBeNull();
    expect(ds.initialStartPending).toBe(false);
    expect(ds.initialStartClaimToken).toBeUndefined();

    mocks.forkWorker.mockImplementation((owner: any) => {
      owner.worker = { killed: false, send: vi.fn() };
    });
    await handleThreadReply(
      makeEventData('om_retry_owner', 'RETRY_OWNER_REPLY', anchor),
      makeCtx(anchor, 'om_retry_owner'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(2);
    expect(mocks.forkWorker.mock.calls[1]![1].content).toContain('RETRY_OWNER_REPLY');
    expect(ds.initialStartPending).toBe(true);
    expect(ds.initialStartClaimToken).toEqual(expect.any(String));
  });

  it('retains a tokened generic ACK successor after IPC failure and recovers it before the next inbound', async () => {
    const anchor = 'om_ack_tail_handoff_root';
    const ds = seedThreadSession(anchor, 'ACK tail handoff');
    Object.assign(ds.session, {
      cliId: 'claude-code',
      workingDir: '/tmp',
      queued: false,
    });
    ds.workingDir = '/tmp';
    ds.hasHistory = true;
    ds.initialStartPending = true;
    ds.pendingFollowUps = ['GENERIC_TAIL_N_PLUS_1'];
    ds.pendingFollowUpTurnIds = ['om_generic_tail_n_plus_1'];
    const failedSend = vi.fn(() => { throw new Error('worker exited before accepting tail'); });
    const kill = vi.fn();
    ds.worker = { killed: false, send: failedSend, kill } as any;

    // Promotion is already a durable acceptance boundary: an IPC throw fences
    // this child but keeps one tokened journal owner for exact recovery.
    expect(onQueuedActivationSubmitted(ds)).toBe(true);
    expect(failedSend).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session).toMatchObject({
      queued: false,
      queuedActivationPending: true,
      queuedActivationToken: expect.any(String),
      queuedActivationTurnId: 'om_generic_tail_n_plus_1',
      queuedActivationInput: expect.objectContaining({
        content: expect.stringContaining('GENERIC_TAIL_N_PLUS_1'),
      }),
    });
    const retainedToken = ds.session.queuedActivationToken;
    // Model the worker error/exit fence (the route test uses a lightweight
    // child stub without worker-pool event handlers).
    ds.worker = null;
    ds.initialStartPending = false;
    ds.initialStartClaimToken = undefined;
    expect(ds.initialStartPending).toBe(false);

    mocks.forkWorker.mockClear();
    await handleThreadReply(
      makeEventData('om_after_tail_n_plus_2', 'AFTER_TAIL_N_PLUS_2', anchor),
      makeCtx(anchor, 'om_after_tail_n_plus_2'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const reforkedHead = mocks.forkWorker.mock.calls[0]![1];
    expect(reforkedHead).toBe(ds.session.queuedActivationInput);
    expect(reforkedHead.content).toContain('GENERIC_TAIL_N_PLUS_1');
    expect(reforkedHead.content).not.toContain('AFTER_TAIL_N_PLUS_2');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({ turnId: 'om_after_tail_n_plus_2' }),
    ]);

    const resumedSend = vi.mocked(ds.worker!.send);
    Object.assign(ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
    });
    expect(onQueuedActivationSubmitted(ds, retainedToken)).toBe(true);
    expect(resumedSend).toHaveBeenCalledTimes(1);
    expect(resumedSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_after_tail_n_plus_2',
      content: expect.stringContaining('AFTER_TAIL_N_PLUS_2'),
      queuedActivationToken: expect.any(String),
    }));
  });
});

describe('daemon live-session registration claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.getAvailableBots.mockResolvedValue([]);
  });

  it('is first-owner-wins under concurrent creation and closes the empty loser', async () => {
    const registry = new Map<string, DaemonSession>();
    const first = makeChatSession('claim-first', 'oc_claim');
    const second = makeChatSession('claim-second', 'oc_claim');

    const [firstResult, secondResult] = await Promise.all([
      claimNewDaemonSession(registry, first),
      claimNewDaemonSession(registry, second),
    ]);

    expect(firstResult.accepted).toBe(true);
    expect(secondResult).toMatchObject({
      accepted: false,
      reason: 'existing_owner',
      owner: first,
      closedIncomingSessionId: second.session.sessionId,
    });
    expect(registry.get(sessionKey('oc_claim', APP))).toBe(first);
    expect(mocks.closeSession).toHaveBeenCalledTimes(1);
    expect(mocks.closeSession).toHaveBeenCalledWith(second.session.sessionId);
  });

  it('fails closed and preserves both persistence rows when both owners are pending', async () => {
    const registry = new Map<string, DaemonSession>();
    const incumbent = makeChatSession('claim-pending-a', 'oc_pending', { pendingLedger: true });
    const incoming = makeChatSession('claim-pending-b', 'oc_pending', { pendingLedger: true });
    registry.set(sessionKey('oc_pending', APP), incumbent);

    const result = await claimNewDaemonSession(registry, incoming);

    expect(result).toMatchObject({
      accepted: false,
      reason: 'both_pending',
      owner: incumbent,
      preservedIncomingSessionId: incoming.session.sessionId,
    });
    expect(registry.get(sessionKey('oc_pending', APP))).toBe(incumbent);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.sessions.get(incoming.session.sessionId)?.status).toBe('active');
  });

  it('retires a losing group-join-style pending runtime before any durable setup is staged', async () => {
    const registry = new Map<string, DaemonSession>();
    const incumbent = makeChatSession('join-canonical', 'oc_join_claim');
    const duplicate = makeChatSession('join-duplicate', 'oc_join_claim');
    duplicate.pendingRepo = true;
    duplicate.pendingPrompt = 'SYNTHETIC_JOIN_OPENING';
    duplicate.initialStartPending = true;
    registry.set(sessionKey('oc_join_claim', APP), incumbent);

    const result = await claimNewDaemonSession(registry, duplicate);

    expect(result).toMatchObject({
      accepted: false,
      reason: 'existing_owner',
      owner: incumbent,
      closedIncomingSessionId: duplicate.session.sessionId,
    });
    expect(duplicate.session.pendingRepoSetup).toBeUndefined();
    expect(mocks.closeSession).toHaveBeenCalledWith(duplicate.session.sessionId);
    expect(registry.get(sessionKey('oc_join_claim', APP))).toBe(incumbent);
  });
});

describe('chat-mode conversion ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.getAvailableBots.mockResolvedValue([]);
    activeSessions.clear();
  });

  it.each([
    ['durable ledger', { pendingLedger: true }],
    ['repo selection', { pendingRepo: true }],
    ['queued dashboard task', { queued: true }],
  ])('preserves a pending chat owner (%s)', (_label, options) => {
    const owner = makeChatSession(`converted-${_label}`, CHAT, options);
    activeSessions.set(sessionKey(CHAT, APP), owner);

    expect(handleChatModeConverted(CHAT, APP)).toBe(false);
    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(owner);
  });

  it('still evicts a ledger-empty idle owner', () => {
    const owner = makeChatSession('converted-idle', CHAT);
    activeSessions.set(sessionKey(CHAT, APP), owner);

    expect(handleChatModeConverted(CHAT, APP)).toBe(true);
    expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
  });

  it.each([
    'live frozen backend',
    'session backend',
    'session cli id',
    'frozen cli id',
    'workerless durable lineage',
  ])(
    'preserves an idle Riff owner across conversion (%s)',
    variant => {
      const owner = makeChatSession(`converted-riff-${variant}`, CHAT);
      if (variant === 'live frozen backend') {
        owner.initConfig = { backendType: 'riff' } as any;
        owner.worker = { killed: false, send: vi.fn() } as any;
      } else if (variant === 'session backend') {
        owner.session.backendType = 'riff';
      } else if (variant === 'session cli id') {
        owner.session.cliId = 'riff';
      } else if (variant === 'frozen cli id') {
        owner.initConfig = { cliId: 'riff' } as any;
      } else {
        owner.session.backendType = 'riff';
        owner.session.riffParentTaskId = 'task-owned';
      }
      activeSessions.set(sessionKey(CHAT, APP), owner);

      expect(handleChatModeConverted(CHAT, APP)).toBe(false);
      expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(owner);
    },
  );
});

describe('document comment canonical ownership and single-flight delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.getAvailableBots.mockResolvedValue([]);
    activeSessions.clear();
    resetDocCommentClaims();
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
    bot.resolvedAllowedUsers = [OWNER];
  });

  function docSub(fileToken: string): any {
    const sub = {
      fileToken,
      fileType: 'docx',
      sessionAnchor: `om_legacy_${fileToken}`,
      scope: 'thread' as const,
      chatId: CHAT,
      commentTriggerMode: 'all' as const,
      managedBy: 'watch-comment' as const,
      createdAt: Date.now(),
    };
    putDocSubscription(config.session.dataDir, APP, sub);
    return sub;
  }

  function docCtx(sub: any, suffix: string): any {
    return {
      larkAppId: APP,
      sub,
      commentId: `comment-${suffix}`,
      replyId: `reply-${suffix}`,
      text: `question ${suffix}`,
    };
  }

  function bindSubToSession(sub: any, ds: DaemonSession): void {
    Object.assign(sub, {
      sessionAnchor: sessionAnchorId(ds),
      sessionId: ds.session.sessionId,
      scope: ds.scope,
      chatId: ds.chatId,
    });
    putDocSubscription(config.session.dataDir, APP, sub);
  }

  it('leaves the provider cursor retryable when a worker-null setup owner exists', async () => {
    const sub = docSub(`doc-protected-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'protected doc owner');
    ds.pendingRepo = true;
    ds.session.queued = true;
    ds.session.queuedPrompt = 'OPENING_N';
    ds.session.pendingRepoSetup = { mode: 'picker', prompt: 'OPENING_N' };
    bindSubToSession(sub, ds);
    mocks.forkWorker.mockClear();

    await expect(handleDocComment(docCtx(sub, 'protected'))).resolves.toBe(false);

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.worker).toBeNull();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(ds.session.pendingRepoSetup).toMatchObject({ mode: 'picker', prompt: 'OPENING_N' });
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('durably queues a live document comment behind the activation head without worker IPC', async () => {
    const sub = docSub(`doc-live-gate-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'live gated doc owner');
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;
    Object.assign(ds.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'doc-opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'opening-turn',
    });
    bindSubToSession(sub, ds);

    await expect(handleDocComment(docCtx(sub, 'live'))).resolves.toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'reply-live',
        cliInput: expect.objectContaining({ content: expect.stringContaining('question live') }),
      }),
    ]);
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('refuses doc-watch prewarm before turn mutation when a worker-null setup owner exists', async () => {
    const sub = docSub(`doc-prewarm-protected-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'prewarm protected');
    ds.session.pendingRepoSetup = { mode: 'picker', prompt: 'OPENING_N' };
    ds.pendingRepo = true;
    const priorLastMessageAt = ds.lastMessageAt;
    mocks.forkWorker.mockClear();

    await expect(prewarmDocCommentSession(ds, sub)).rejects.toThrow('durable opening ownership');

    expect(ds.lastMessageAt).toBe(priorLastMessageAt);
    expect(ds.currentTurnTitle).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('durably queues live doc-watch prewarm behind activation without worker IPC', async () => {
    const sub = docSub(`doc-prewarm-live-${Date.now()}`);
    const ds = seedThreadSession(sub.sessionAnchor, 'prewarm live');
    const send = vi.fn();
    ds.worker = { killed: false, send } as any;
    Object.assign(ds.session, {
      queuedActivationPending: true,
      queuedActivationToken: 'prewarm-opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
      queuedActivationTurnId: 'opening-turn',
    });

    await expect(prewarmDocCommentSession(ds, sub)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: expect.stringMatching(/^doc-watch-/),
        cliInput: expect.objectContaining({ content: expect.stringContaining(sub.fileToken) }),
      }),
    ]);
    removeDocSubscription(config.session.dataDir, APP, sub.fileToken);
  });

  it('serializes concurrent get-or-create, merges targets, and reuses canonical state after restart', async () => {
    const fileToken = `doc-concurrent-${Date.now()}`;
    const sub = docSub(fileToken);

    await expect(Promise.all([
      handleDocComment(docCtx(sub, 'one')),
      handleDocComment(docCtx(sub, 'two')),
    ])).resolves.toEqual([true, true]);

    const key = sessionKey(`doc:${fileToken}`, APP);
    const owner = activeSessions.get(key)!;
    expect(owner).toBeDefined();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(Object.keys(owner.session.docCommentTargets ?? {}).sort()).toEqual(['reply-one', 'reply-two']);

    const persisted = getDocSubscription(config.session.dataDir, APP, fileToken)!;
    expect(persisted).toMatchObject({
      sessionAnchor: `doc:${fileToken}`,
      sessionId: owner.session.sessionId,
      scope: 'chat',
      chatId: `doc:${fileToken}`,
    });
    // This is the exact anchor closeSession uses to find subscriptions.
    expect(sessionAnchorId(owner)).toBe(persisted.sessionAnchor);

    // Simulate a daemon memory restart restoring the same persisted session at
    // activeSessionKey(ds), then deliver another comment from a stale snapshot.
    activeSessions.clear();
    owner.worker = null;
    activeSessions.set(key, owner);
    const staleSnapshot = { ...sub };
    await expect(handleDocComment(docCtx(staleSnapshot, 'three'))).resolves.toBe(true);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(activeSessions.get(key)).toBe(owner);
    expect(Object.keys(owner.session.docCommentTargets ?? {}).sort()).toEqual([
      'reply-one',
      'reply-three',
      'reply-two',
    ]);

    removeDocSubscription(config.session.dataDir, APP, fileToken);
  });

  it('makes duplicate WS/poll deliveries share failure so neither advances its cursor', async () => {
    const fileToken = `doc-failure-${Date.now()}`;
    const sub = docSub(fileToken);
    const ctx = docCtx(sub, 'same');
    mocks.forkWorker.mockImplementationOnce(() => { throw new Error('simulated fork failure'); });

    const results = await Promise.all([
      handleDocComment(ctx),
      handleDocComment({ ...ctx, sub: { ...sub } }),
    ]);

    expect(results).toEqual([false, false]);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);

    // Failure was not recorded as completed: a later poll retry can deliver.
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    await expect(handleDocComment(ctx)).resolves.toBe(true);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(2);

    removeDocSubscription(config.session.dataDir, APP, fileToken);
  });
});
