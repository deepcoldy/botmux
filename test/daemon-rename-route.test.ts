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
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    forkWorker: vi.fn(),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => ({
      sessionId: `sess-fake-${++seq}`,
      chatId,
      rootMessageId,
      title,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      chatType,
    })),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import type { DaemonSession } from '../src/core/types.js';

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

function makeMentionOnlyEventData(messageId: string, rootId?: string): any {
  const data = makeEventData(messageId, '@@_user_1', rootId);
  data.message.mentions = [{
    key: '@_user_1',
    name: 'TestBot',
    id: { open_id: 'ou_bot' },
  }];
  return data;
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

function seedLiveChatSession(send = vi.fn()): DaemonSession {
  const ds = {
    scope: 'chat',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: { killed: false, send },
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    currentReplyTarget: {
      rootMessageId: 'om_stale_root',
      turnId: 'om_stale_turn',
      updatedAt: NOW,
    },
    session: {
      sessionId: 'sess-live-chat-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: 'om_original_root',
      title: 'live chat',
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
      scope: 'chat',
      quoteTargetId: 'om_stale_quote',
      quoteTargetSenderOpenId: 'ou_stale_caller',
      lastCallerOpenId: 'ou_stale_caller',
      currentReplyTarget: {
        rootMessageId: 'om_stale_root',
        turnId: 'om_stale_turn',
        updatedAt: NOW,
      },
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(CHAT, APP), ds);
  return ds;
}

function seedPendingRawSession(anchor: string): DaemonSession {
  const ds = seedThreadSession(anchor, 'pending raw');
  ds.pendingRepo = true;
  ds.pendingPrompt = '';
  ds.pendingRawInput = '/goal start';
  ds.pendingRawTurnId = 'om_initial_raw';
  ds.pendingSender = { openId: OWNER, type: 'user' };
  return ds;
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
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
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

  it('new topic: passes the accepted Lark message id into the first worker', async () => {
    await handleNewTopic(
      makeEventData('om_workflow_new', '/workflow new 修复首轮授权'),
      makeCtx('om_workflow_new', 'om_workflow_new'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual({ turnId: 'om_workflow_new' });
    const ds = activeSessions.get(sessionKey('om_workflow_new', APP));
    expect(ds?.session.nativeSessionTitle).toBe('[BotMux·Lark] /workflow new 修复首轮授权');
  });

  it('uses the group name for mention-only sessions on both creation paths', async () => {
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'codex',
      allowedUsers: [OWNER],
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
    mocks.getChatNameAndMode.mockResolvedValue({
      name: 'BotMux 标题优化群',
      mode: 'topic',
    });

    await handleNewTopic(
      makeMentionOnlyEventData('om_group_title_new'),
      makeCtx('om_group_title_new', 'om_group_title_new'),
    );
    const newTopic = activeSessions.get(sessionKey('om_group_title_new', APP));
    expect(newTopic?.session.chatDisplayName).toBe('BotMux 标题优化群');
    expect(newTopic?.session.nativeSessionTitle).toBe('[BotMux·Lark] BotMux 标题优化群');

    activeSessions.clear();
    await handleThreadReply(
      makeMentionOnlyEventData('om_group_title_reply', 'om_group_title_root'),
      makeCtx('om_group_title_root', 'om_group_title_reply'),
    );
    const safetyNet = activeSessions.get(sessionKey('om_group_title_root', APP));
    expect(safetyNet?.session.chatDisplayName).toBe('BotMux 标题优化群');
    expect(safetyNet?.session.nativeSessionTitle).toBe('[BotMux·Lark] BotMux 标题优化群');
    expect(mocks.getChatNameAndMode).toHaveBeenCalledTimes(2);
  });

  it('thread safety-net: passes the accepted reply id into the first worker', async () => {
    await handleThreadReply(
      makeEventData('om_workflow_reply', '/workflow new 修复首轮授权', 'om_fresh_root'),
      makeCtx('om_fresh_root', 'om_workflow_reply'),
    );

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker.mock.calls[0]?.[2]).toEqual({ turnId: 'om_workflow_reply' });
  });

  it('live passthrough binds raw input and reply metadata to the accepted message', async () => {
    const send = vi.fn();
    const ds = seedLiveChatSession(send);
    const messageId = 'om_model_turn';
    const replyRootId = 'om_model_reply_root';

    await handleThreadReply(
      makeEventData(messageId, '/model opus', replyRootId),
      {
        chatId: CHAT,
        messageId,
        chatType: 'group' as const,
        scope: 'chat' as const,
        anchor: CHAT,
        replyRootId,
        larkAppId: APP,
      },
    );

    expect(send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/model opus',
      turnId: messageId,
    });
    expect(ds.session.quoteTargetId).toBe(messageId);
    expect(ds.session.quoteTargetSenderOpenId).toBe(OWNER);
    expect(ds.session.lastCallerOpenId).toBe(OWNER);
    expect(ds.currentReplyTarget).toMatchObject({ rootMessageId: replyRootId, turnId: messageId });
    expect(ds.session.currentReplyTarget).toMatchObject({ rootMessageId: replyRootId, turnId: messageId });
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('pending raw same-caller follow-up rotates both staged turns to the latest message', async () => {
    const anchor = 'om_pending_raw_root';
    const ds = seedPendingRawSession(anchor);
    const messageId = 'om_pending_raw_followup';

    await handleThreadReply(
      makeEventData(messageId, '补充同一个人的要求', anchor),
      makeCtx(anchor, messageId),
    );

    expect(ds.pendingRawTurnId).toBe(messageId);
    expect(ds.pendingFollowUpTurnId).toBe(messageId);
    expect(ds.pendingFollowUps).toHaveLength(1);
    expect(ds.session.quoteTargetId).toBe(messageId);
  });

  it('pending raw mixed-caller follow-up clears both staged turns', async () => {
    const anchor = 'om_pending_raw_mixed_root';
    const ds = seedPendingRawSession(anchor);
    const ownerMessageId = 'om_pending_owner_followup';

    await handleThreadReply(
      makeEventData(ownerMessageId, '先由原调用者补充', anchor),
      makeCtx(anchor, ownerMessageId),
    );
    expect(ds.pendingRawTurnId).toBe(ownerMessageId);
    expect(ds.pendingFollowUpTurnId).toBe(ownerMessageId);

    const strangerMessageId = 'om_pending_stranger_followup';
    const strangerData = makeEventData(strangerMessageId, '再由另一个人补充', anchor);
    strangerData.sender = { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' };
    await handleThreadReply(strangerData, makeCtx(anchor, strangerMessageId));

    expect(ds.pendingRawTurnId).toBeUndefined();
    expect(ds.pendingFollowUpTurnId).toBeUndefined();
    expect(ds.pendingFollowUps).toHaveLength(2);
    expect(ds.session.quoteTargetId).toBe(strangerMessageId);
    expect(ds.session.lastCallerOpenId).toBe('ou_stranger');
  });
});
