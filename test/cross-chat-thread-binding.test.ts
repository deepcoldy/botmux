import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let tempDir: string;
let capturedHandlers: Record<string, (data: any) => Promise<void>> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
  }
  class MockEventDispatcher {
    register(handlers: Record<string, (data: any) => Promise<void>>) {
      capturedHandlers = handlers;
      return this;
    }
  }
  class MockWSClient {
    close = vi.fn();
    start = vi.fn(async () => {});
    getConnectionStatus = vi.fn(() => ({ state: 'connected', reconnectAttempts: 0 }));
  }
  return {
    Client: FakeClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { info: 2 },
  };
});

vi.mock('../src/im/lark/transport/resilient-ws-client.js', () => ({
  createResilientWsClient: () => ({
    close: vi.fn(),
    start: vi.fn(async () => {}),
    getConnectionStatus: vi.fn(() => ({ state: 'connected', reconnectAttempts: 0 })),
  }),
}));

const mockReplyMessage = vi.fn(async () => 'om_grant_card');
const mockSendMessage = vi.fn(async () => 'om_sent');
const mockSendUserMessage = vi.fn(async () => 'om_dm');
const mockGetChatMode = vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p');

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    getChatMode: (...args: any[]) => mockGetChatMode(...args),
    getCachedChatMode: () => 'group' as const,
    getChatModeStrict: async () => 'group' as const,
    getCachedChatModeStrict: () => 'group' as const,
    getChatInfo: async () => ({ userCount: 5, botCount: 2 }),
    replyMessage: (...args: any[]) => mockReplyMessage(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    sendUserMessage: (...args: any[]) => mockSendUserMessage(...args),
    listChatMemberOpenIds: async () => [],
    getUserProfile: async () => null,
    resolveUnionIdFromOpenId: async () => null,
    resolveUnionIdFromOpenIdStrict: async () => ({ status: 'unavailable' as const }),
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      session: {
        ...actual.config.session,
        get dataDir() {
          return tempDir;
        },
      },
    },
  };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  resolveCrossChatFollowedThread,
  __clearCrossChatFollowBindingCacheForTest,
  type CrossChatCandidateSession,
} from '../src/services/cross-chat-thread-binding.js';
import { crossChatFollowThreadPath } from '../src/services/cross-chat-follow-thread-store.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import { cleanupSessionBridgeSendMarkersNow } from '../src/services/session-store.js';
import { renderCrossChatReplyHint, renderInboundMessageLocation } from '../src/core/reply-message.js';
import {
  beginReplyTargetTurn,
  pickTurnReplyTarget,
  registryEntryProvesHumanSender,
  registryTurnMayAuthenticateHuman,
} from '../src/core/reply-target.js';
import { currentGatewayCallerOpenId } from '../src/core/gateway-turn-caller.js';
import { parseSendInvocation } from '../src/cli/send-invocation.js';
import {
  startLarkEventDispatcher,
  markForwardFollowupsSessionsReady,
  __resetEventClaimsForTest,
  type EventHandlers,
} from '../src/im/lark/event-dispatcher.js';
import { __resetAnchorQueues } from '../src/utils/anchor-serializer.js';
import { _resetForTest as _resetGrantPending } from '../src/im/lark/grant-pending.js';

const APP_ID = 'cli_cross_chat_app';
const BOT_OPEN_ID = 'ou_bot_self';
const OWNER_OPEN_ID = 'ou_owner_a';
const GROUP_A = 'oc_group_a_task';
const GROUP_B = 'oc_group_b_release';
const SENT_ROOT_IN_B = 'om_sent_to_group_b';

function writeTurnSends(sessionId: string, entries: Array<Record<string, unknown>>): void {
  const dir = join(tempDir, 'turn-sends');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );
}

function writeHostBindings(sessionId: string, entries: Array<Record<string, unknown>>): void {
  const filePath = crossChatFollowThreadPath(tempDir, sessionId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map(e => JSON.stringify({ sessionId, ...e })).join('\n') + '\n', 'utf-8');
}

describe('cross-chat followed thread binding', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-cross-chat-thread-'));
    __clearCrossChatFollowBindingCacheForTest();
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    _resetGrantPending();
    mockReplyMessage.mockClear();
    mockSendMessage.mockClear();
    mockSendUserMessage.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches top-level and --into detoured sends from host-only bindings and honors --no-follow-thread', () => {
    const sessions: CrossChatCandidateSession[] = [
      {
        sessionId: 'sess-a',
        larkAppId: APP_ID,
        chatId: GROUP_A,
        rootMessageId: GROUP_A,
        scope: 'chat',
        status: 'active',
      },
    ];

    recordBridgeReplyMarker({
      dataDir: tempDir,
      sessionId: 'sess-a',
      sentAtMs: 1000,
      messageId: SENT_ROOT_IN_B,
      deliveryKind: 'detoured_send',
      content: '发车通知',
      targetChatId: GROUP_B,
      crossChatFollowThread: 'at',
    });

    const matchTopLevel = resolveCrossChatFollowedThread({
      dataDir: tempDir,
      larkAppId: APP_ID,
      chatId: GROUP_B,
      candidateRootIds: [SENT_ROOT_IN_B],
      sessions,
    });
    expect(matchTopLevel).toEqual({
      sourceSessionId: 'sess-a',
      sourceChatId: GROUP_A,
      scope: 'chat',
      anchor: GROUP_A,
      followedChatId: GROUP_B,
      followedRootMessageId: SENT_ROOT_IN_B,
    });

    // Follow-up sent via `--chat-id GROUP_B --into om_other_thread`
    recordBridgeReplyMarker({
      dataDir: tempDir,
      sessionId: 'sess-a',
      sentAtMs: 2000,
      messageId: 'om_followup_reply',
      deliveryKind: 'detoured_send',
      content: '话题内跟进',
      targetChatId: GROUP_B,
      targetRootMessageId: 'om_other_thread',
      crossChatFollowThread: 'at',
    });

    const matchInto = resolveCrossChatFollowedThread({
      dataDir: tempDir,
      larkAppId: APP_ID,
      chatId: GROUP_B,
      candidateRootIds: ['om_other_thread'],
      sessions,
    });
    expect(matchInto?.followedRootMessageId).toBe('om_other_thread');
    expect(matchInto?.sourceSessionId).toBe('sess-a');

    // Opt-out via --no-follow-thread (`crossChatFollowThread: 'off'`)
    recordBridgeReplyMarker({
      dataDir: tempDir,
      sessionId: 'sess-a',
      sentAtMs: 3000,
      messageId: 'om_opted_out',
      deliveryKind: 'detoured_send',
      content: '纯广播不跟帖',
      targetChatId: GROUP_B,
      crossChatFollowThread: 'off',
    });
    expect(
      resolveCrossChatFollowedThread({
        dataDir: tempDir,
        larkAppId: APP_ID,
        chatId: GROUP_B,
        candidateRootIds: ['om_opted_out'],
        sessions,
      }),
    ).toBeNull();
  });

  it('ignores forged follow markers in the CLI-writable turn-sends journal', () => {
    writeTurnSends('sess-a', [{
      sentAtMs: 1000, sessionId: 'sess-a', messageId: 'om_never_sent', deliveryKind: 'detoured_send',
      targetChatId: GROUP_B, crossChatFollowThread: 'at',
    }]);
    expect(resolveCrossChatFollowedThread({
      dataDir: tempDir, larkAppId: APP_ID, chatId: GROUP_B, candidateRootIds: ['om_never_sent'],
      sessions: [{
        sessionId: 'sess-a', larkAppId: APP_ID, chatId: GROUP_A, rootMessageId: GROUP_A,
        scope: 'chat', status: 'active',
      }],
    })).toBeNull();
  });

  it('cleans the host binding with the bridge marker lifecycle', () => {
    recordBridgeReplyMarker({
      dataDir: tempDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: SENT_ROOT_IN_B,
      deliveryKind: 'detoured_send', content: 'secret preview', targetChatId: GROUP_B, crossChatFollowThread: 'at',
    });
    const bindingPath = crossChatFollowThreadPath(tempDir, 'sess-a');
    expect(existsSync(join(tempDir, 'turn-sends', 'sess-a.jsonl'))).toBe(true);
    expect(existsSync(bindingPath)).toBe(true);
    expect(readFileSync(bindingPath, 'utf-8')).not.toContain('secret preview');
    const resolution = {
      dataDir: tempDir, larkAppId: APP_ID, chatId: GROUP_B, candidateRootIds: [SENT_ROOT_IN_B],
      sessions: [{
        sessionId: 'sess-a', larkAppId: APP_ID, chatId: GROUP_A, rootMessageId: GROUP_A,
        scope: 'chat' as const, status: 'active' as const,
      }],
    };
    expect(resolveCrossChatFollowedThread(resolution)).not.toBeNull();
    cleanupSessionBridgeSendMarkersNow('sess-a');
    expect(existsSync(join(tempDir, 'turn-sends', 'sess-a.jsonl'))).toBe(false);
    expect(existsSync(bindingPath)).toBe(false);
    expect(resolveCrossChatFollowedThread(resolution)).toBeNull();
  });

  it('yields to a local thread session in the target chat and ignores closed/queued sessions', () => {
    writeHostBindings('sess-a', [
      {
        sentAtMs: 1000,
        messageId: SENT_ROOT_IN_B,
        deliveryKind: 'detoured_send',
        targetChatId: GROUP_B,
      },
    ]);

    // When Group B already has its own thread-scope session at SENT_ROOT_IN_B, local wins
    expect(
      resolveCrossChatFollowedThread({
        dataDir: tempDir,
        larkAppId: APP_ID,
        chatId: GROUP_B,
        candidateRootIds: [SENT_ROOT_IN_B],
        sessions: [
          {
            sessionId: 'sess-a',
            larkAppId: APP_ID,
            chatId: GROUP_A,
            rootMessageId: GROUP_A,
            scope: 'chat',
            status: 'active',
          },
          {
            sessionId: 'sess-local-b',
            larkAppId: APP_ID,
            chatId: GROUP_B,
            rootMessageId: SENT_ROOT_IN_B,
            scope: 'thread',
            status: 'active',
          },
        ],
      }),
    ).toBeNull();

    // Closed or queued origin session does not match
    expect(
      resolveCrossChatFollowedThread({
        dataDir: tempDir,
        larkAppId: APP_ID,
        chatId: GROUP_B,
        candidateRootIds: [SENT_ROOT_IN_B],
        sessions: [
          {
            sessionId: 'sess-a',
            larkAppId: APP_ID,
            chatId: GROUP_A,
            rootMessageId: GROUP_A,
            scope: 'chat',
            status: 'closed',
          },
        ],
      }),
    ).toBeNull();
  });

  it('renders cross-chat message_location and reply hint while keeping Group A as default reply target', () => {
    const crossChatOrigin = {
      sourceChatId: GROUP_A,
      followedChatId: GROUP_B,
      followedRootMessageId: SENT_ROOT_IN_B,
    };
    const loc = renderInboundMessageLocation({
      messageId: 'om_reply_in_b',
      rootMessageId: SENT_ROOT_IN_B,
      crossChatOrigin,
    });
    expect(loc).toContain(
      `<message_location message_id="om_reply_in_b" placement="thread" chat_id="${GROUP_B}" root_message_id="${SENT_ROOT_IN_B}" default_reply_chat_id="${GROUP_A}" />`,
    );

    const hint = renderCrossChatReplyHint(crossChatOrigin);
    expect(hint).toContain(`default_reply_chat_id="${GROUP_A}"`);
    expect(hint).toContain(`botmux send --chat-id ${GROUP_B} --into ${SENT_ROOT_IN_B}`);

    // beginReplyTargetTurn must not leak Group B's message id as Group A's quoteTargetId,
    // and must not grant human principal authentication to the cross-chat sender.
    const ds: any = {
      scope: 'chat',
      chatId: GROUP_A,
      session: {
        sessionId: 'sess-a',
        chatId: GROUP_A,
        rootMessageId: GROUP_A,
        scope: 'chat',
        quoteTargetId: 'om_prev_in_a',
      },
    };
    beginReplyTargetTurn(ds, undefined, 'om_reply_in_b', '2026-11-17T12:00:00.000Z', {
      senderOpenId: 'ou_reviewer_b',
      participants: [{ openId: 'ou_reviewer_b', isBot: false }],
      inThread: true,
      sourceMessageId: 'om_reply_in_b',
      crossChatOrigin,
    });
    expect(ds.session.turnReplyContexts['om_reply_in_b'].quoteTargetId).toBeUndefined();
    expect(ds.session.turnReplyContexts['om_reply_in_b'].crossChatOrigin).toEqual(crossChatOrigin);
    expect(ds.session.turnReplyContexts['om_reply_in_b'].replyTargetSenderOpenId).toBe('ou_reviewer_b');
    const picked = pickTurnReplyTarget(ds.session, 'om_reply_in_b');
    expect(picked?.senderOpenId).toBe('ou_reviewer_b');
    expect(registryTurnMayAuthenticateHuman(ds.session, 'om_reply_in_b')).toBe(false);
    expect(registryEntryProvesHumanSender(picked)).toBe(false);
    expect(currentGatewayCallerOpenId(ds, 'om_reply_in_b')).toBeUndefined();
  });

  it('keeps registry and gateway authentication closed when a pinned reply target outlives the context map', () => {
    const crossChatOrigin = {
      sourceChatId: GROUP_A,
      followedChatId: GROUP_B,
      followedRootMessageId: SENT_ROOT_IN_B,
    };
    const ds: any = {
      larkAppId: APP_ID,
      scope: 'chat',
      chatId: GROUP_A,
      session: {
        sessionId: 'sess-a', chatId: GROUP_A, rootMessageId: GROUP_A, scope: 'chat',
        cronTaskReplyAnchors: { task: { turnId: 'om_reply_in_b', createdAtMs: 0 } },
      },
    };
    beginReplyTargetTurn(ds, undefined, 'om_reply_in_b', '2026-11-17T12:00:00.000Z', {
      senderOpenId: 'ou_stranger_b',
      participants: [{ openId: 'ou_stranger_b', isBot: false }],
      crossChatOrigin,
    });
    for (let i = 0; i < 1000 && ds.session.turnReplyContexts.om_reply_in_b; i++) {
      beginReplyTargetTurn(ds, undefined, `om_later_${i}`,
        new Date(Date.parse('2026-11-17T12:00:00.000Z') + (i + 1) * 1000).toISOString());
    }
    expect(ds.session.turnReplyContexts.om_reply_in_b).toBeUndefined();
    expect(pickTurnReplyTarget(ds.session, 'om_reply_in_b')?.crossChatOrigin).toEqual(crossChatOrigin);
    expect(registryTurnMayAuthenticateHuman(ds.session, 'om_reply_in_b')).toBe(false);
    expect(currentGatewayCallerOpenId(ds, 'om_reply_in_b')).toBeUndefined();
  });

  it('keeps registry and recovery fallbacks closed when the short reply index is pruned first', () => {
    const ds: any = {
      larkAppId: APP_ID, scope: 'chat', chatId: GROUP_A,
      session: { sessionId: 'sess-a', chatId: GROUP_A, rootMessageId: GROUP_A, scope: 'chat' },
    };
    beginReplyTargetTurn(ds, undefined, 'om_reply_in_b', '2026-11-17T12:00:00.000Z', {
      senderOpenId: 'ou_stranger_b', participants: [{ openId: 'ou_stranger_b', isBot: false }],
      crossChatOrigin: {
        sourceChatId: GROUP_A, followedChatId: GROUP_B, followedRootMessageId: SENT_ROOT_IN_B,
      },
    });
    for (let i = 0; i < 40; i++) {
      beginReplyTargetTurn(ds, undefined, `om_later_${i}`, `2026-11-17T12:01:${String(i).padStart(2, '0')}.000Z`);
    }
    expect(ds.session.replyTargets.om_reply_in_b).toBeUndefined();
    expect(ds.session.turnReplyContexts.om_reply_in_b.crossChatOrigin).toBeDefined();
    expect(registryTurnMayAuthenticateHuman(ds.session, 'om_reply_in_b')).toBe(false);
    ds.session.failedTurnRecovery = {
      turnId: 'om_reply_in_b',
      caller: { requestLarkAppId: APP_ID, requestUserOpenId: 'ou_stranger_b', senderType: 'user' },
    };
    expect(currentGatewayCallerOpenId(ds, 'om_reply_in_b')).toBeUndefined();
  });

  it('parses --follow-thread-at and --no-follow-thread in send invocation', () => {
    const inv1 = parseSendInvocation(['--chat-id', GROUP_B, '--follow-thread-at', '--no-mention', 'hello']);
    expect(inv1.arityErrors).toEqual([]);
    expect(Object.hasOwn(inv1.flags, '--follow-thread-at')).toBe(true);

    const inv2 = parseSendInvocation(['--chat-id', GROUP_B, '--no-follow-thread', '--no-mention', 'hello']);
    expect(inv2.arityErrors).toEqual([]);
    expect(Object.hasOwn(inv2.flags, '--no-follow-thread')).toBe(true);
  });

  it('exempts foreign bots and non-allowlisted humans in Group B followed thread from talk gate and routes to Group A session', async () => {
    registerBot({
      larkAppId: APP_ID,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: [OWNER_OPEN_ID],
      blockedUsers: ['ou_blocked_user'],
      commandTriggers: { enabled: true, commands: [{ cmd: '/solve', prompt: '执行模板 {args}' }] },
    });
    const bot = getBot(APP_ID);
    bot.botOpenId = BOT_OPEN_ID;
    bot.botName = 'zzh-美国豆包';
    bot.resolvedAllowedUsers = [OWNER_OPEN_ID];
    bot.resolvedBlockedUsers = ['ou_blocked_user'];

    writeHostBindings('sess-a', [
      {
        sentAtMs: 1000,
        messageId: SENT_ROOT_IN_B,
        deliveryKind: 'detoured_send',
        targetChatId: GROUP_B,
        crossChatFollowThread: 'at',
      },
    ]);

    const handleThreadReply = vi.fn(async (_data: any, ctx: any) => {
      ctx.ingressAdmission = { admitted: true };
    });
    const handleNewTopic = vi.fn(async () => {});
    const handlers: EventHandlers = {
      handleNewTopic,
      handleThreadReply,
      handleCardAction: vi.fn(async () => ({})),
      isSessionOwner: vi.fn((anchor: string) => anchor === GROUP_A),
      hasAnySessionAtAnchor: vi.fn(() => false),
      resolveCrossChatFollowedThread: vi.fn((candidateRootIds: readonly string[], chatId: string) =>
        resolveCrossChatFollowedThread({
          dataDir: tempDir,
          larkAppId: APP_ID,
          chatId,
          candidateRootIds,
          sessions: [
            {
              sessionId: 'sess-a',
              larkAppId: APP_ID,
              chatId: GROUP_A,
              rootMessageId: GROUP_A,
              scope: 'chat',
              status: 'active',
            },
          ],
        }),
      ),
    };

    startLarkEventDispatcher(APP_ID, 'secret', handlers);
    markForwardFollowupsSessionsReady(APP_ID);
    const onMessage = capturedHandlers['im.message.receive_v1'];
    expect(onMessage).toBeTypeOf('function');

    // 1. Foreign bot in Group B replies in thread of SENT_ROOT_IN_B and @mentions this bot
    await onMessage({
      sender: {
        sender_id: { open_id: 'ou_foreign_bot_b', union_id: 'on_foreign_bot_b' },
        sender_type: 'app',
      },
      message: {
        message_id: 'om_bot_reply_1',
        root_id: SENT_ROOT_IN_B,
        parent_id: SENT_ROOT_IN_B,
        thread_id: 'omt_thread_b',
        chat_id: GROUP_B,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 流水线检查通过，可以发车' }),
        mentions: [{ key: '@_user_1', name: 'zzh-美国豆包', id: { open_id: BOT_OPEN_ID } }],
      },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(handleThreadReply).toHaveBeenCalledTimes(1);
    expect(handleThreadReply.mock.calls[0]![1]).toMatchObject({
      chatId: GROUP_A,
      scope: 'chat',
      anchor: GROUP_A,
      larkAppId: APP_ID,
      crossChatThreadFollowUp: {
        sourceSessionId: 'sess-a',
        sourceChatId: GROUP_A,
        followedChatId: GROUP_B,
        followedRootMessageId: SENT_ROOT_IN_B,
      },
    });
    expect(mockReplyMessage).not.toHaveBeenCalled();

    // 2. Non-allowlisted human in Group B replies in thread of SENT_ROOT_IN_B and @mentions this bot
    handleThreadReply.mockClear();
    await onMessage({
      sender: {
        sender_id: { open_id: 'ou_stranger_human_b', union_id: 'on_stranger_human_b' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_human_reply_2',
        root_id: SENT_ROOT_IN_B,
        parent_id: SENT_ROOT_IN_B,
        thread_id: 'omt_thread_b',
        chat_id: GROUP_B,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 请补一下回归测试链接' }),
        mentions: [{ key: '@_user_1', name: 'zzh-美国豆包', id: { open_id: BOT_OPEN_ID } }],
      },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(handleThreadReply).toHaveBeenCalledTimes(1);
    expect(handleThreadReply.mock.calls[0]![1]).toMatchObject({
      chatId: GROUP_A,
      scope: 'chat',
      anchor: GROUP_A,
      larkAppId: APP_ID,
      crossChatThreadFollowUp: {
        sourceSessionId: 'sess-a',
        sourceChatId: GROUP_A,
        followedChatId: GROUP_B,
        followedRootMessageId: SENT_ROOT_IN_B,
      },
    });
    // Must NOT pop a grant request card in Group B!
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(mockSendUserMessage).not.toHaveBeenCalled();

    // 3. Un-@-mentioned reply in the same Group B thread is ignored (follow-thread-at requires @)
    handleThreadReply.mockClear();
    await onMessage({
      sender: {
        sender_id: { open_id: 'ou_stranger_human_b', union_id: 'on_stranger_human_b' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_human_unmentioned_3',
        root_id: SENT_ROOT_IN_B,
        parent_id: SENT_ROOT_IN_B,
        thread_id: 'omt_thread_b',
        chat_id: GROUP_B,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '大家看下这个改动' }),
        mentions: [],
      },
    });
    expect(handleThreadReply).not.toHaveBeenCalled();
    expect(handleNewTopic).not.toHaveBeenCalled();

    // 4. Explicitly blocked user is still rejected even when @mentioning in the followed thread
    handleThreadReply.mockClear();
    await onMessage({
      sender: {
        sender_id: { open_id: 'ou_blocked_user', union_id: 'on_blocked_user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_blocked_reply_4',
        root_id: SENT_ROOT_IN_B,
        parent_id: SENT_ROOT_IN_B,
        thread_id: 'omt_thread_b',
        chat_id: GROUP_B,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 试图触发' }),
        mentions: [{ key: '@_user_1', name: 'zzh-美国豆包', id: { open_id: BOT_OPEN_ID } }],
      },
    });
    expect(handleThreadReply).not.toHaveBeenCalled();
    expect(handleNewTopic).not.toHaveBeenCalled();

    // 5. Non-allowlisted human sending a slash-prefixed message in Group B's followed thread
    // routes to Group A without popping a grant card in Group B
    handleThreadReply.mockClear();
    await onMessage({
      sender: {
        sender_id: { open_id: 'ou_stranger_human_b', union_id: 'on_stranger_human_b' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_human_slash_5',
        root_id: SENT_ROOT_IN_B,
        parent_id: SENT_ROOT_IN_B,
        thread_id: 'omt_thread_b',
        chat_id: GROUP_B,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /solve 看下进度' }),
        mentions: [{ key: '@_user_1', name: 'zzh-美国豆包', id: { open_id: BOT_OPEN_ID } }],
      },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(handleThreadReply).toHaveBeenCalledTimes(1);
    expect(handleThreadReply.mock.calls[0]![1].commandTrigger).toBeUndefined();
    expect(handleThreadReply.mock.calls[0]![1].promptOverride).toBeUndefined();
    expect(handleThreadReply.mock.calls[0]![1].summaryCommand).toBeUndefined();
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(mockSendUserMessage).not.toHaveBeenCalled();
  });
});
