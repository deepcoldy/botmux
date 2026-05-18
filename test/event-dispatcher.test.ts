/**
 * Unit tests for event-dispatcher: bot-to-bot @mention routing.
 *
 * Covers the im.message.receive_v1 handler behavior when receiving messages
 * from other bots (sender_type === 'app'), specifically:
 * - Routing @mentioned bot messages to handleThreadReply
 * - Ignoring bot messages that don't @mention this bot
 * - Processing /close commands from the bot's own messages
 * - Learning own open_id from outgoing messages
 *
 * Run:  pnpm vitest run test/event-dispatcher.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock external modules ──────────────────────────────────────────────────

const mockExistsSync = vi.fn(() => true);
const mockReadFileSync = vi.fn(() => '[]');
const mockWriteFileSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    mkdirSync: vi.fn(),
  };
});

const mockGetBot = vi.fn();
const mockGetAllBots = vi.fn(() => []);
const mockIsChatOncallBoundForAnyBot = vi.fn<(chatId: string) => boolean>(() => false);
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  getAllBots: () => mockGetAllBots(),
  isChatOncallBoundForAnyBot: (...args: any[]) => mockIsChatOncallBoundForAnyBot(...(args as [string])),
}));

const mockListChatBotMembers = vi.fn(async () => [] as Array<{ openId: string; name: string }>);
const mockGetChatMode = vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p');
const mockGetChatInfo = vi.fn(async () => ({ userCount: 1, botCount: 1 }));
vi.mock('../src/im/lark/client.js', () => ({
  getChatInfo: (...args: any[]) => mockGetChatInfo(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  listChatBotMembers: (...args: any[]) => mockListChatBotMembers(...args),
  replyMessage: vi.fn(async () => 'msg-id'),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the registered event handlers from EventDispatcher.register()
let capturedHandlers: Record<string, Function> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handlers: Record<string, Function>) {
      capturedHandlers = handlers;
      return this;
    }
  }
  class MockWSClient {
    start() {}
  }
  return {
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { info: 2 },
  };
});

// ─── Imports (must be after mocks) ──────────────────────────────────────────

import { isBotMentioned, startLarkEventDispatcher, writeBotInfoFile, type EventHandlers } from '../src/im/lark/event-dispatcher.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const MY_APP_ID = 'app-bot-a';
const MY_OPEN_ID = 'ou_bot_a_open_id';
const OTHER_BOT_OPEN_ID = 'ou_bot_b_open_id';
const USER_OPEN_ID = 'ou_user_123';

function setupBotState(opts?: { botOpenId?: string | undefined }) {
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: opts && 'botOpenId' in opts ? opts.botOpenId : MY_OPEN_ID,
    resolvedAllowedUsers: [],
  });
}

function makeHandlers(): EventHandlers & {
  handleNewTopic: ReturnType<typeof vi.fn>;
  handleThreadReply: ReturnType<typeof vi.fn>;
  handleCardAction: ReturnType<typeof vi.fn>;
  isSessionOwner: ReturnType<typeof vi.fn>;
  onChatModeConverted: ReturnType<typeof vi.fn>;
} {
  return {
    handleCardAction: vi.fn(async () => undefined),
    handleNewTopic: vi.fn(async () => {}),
    handleThreadReply: vi.fn(async () => {}),
    isSessionOwner: vi.fn(() => false),
    onChatModeConverted: vi.fn(),
  };
}

/** Build a Lark im.message.receive_v1 event data object */
function makeBotMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  /** Pass `null` to omit thread_id (model Lark quote-bubble quirk).
   *  Otherwise defaults to rootId, matching real Lark threaded messages
   *  where root_id and thread_id are co-present. */
  threadId?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
  /** Override `sender.sender_type`. Defaults to `'app'`. Use `'bot'` to model
   *  飞书在跨 bot 卡片消息场景实测投递的值。 */
  senderType?: string;
}) {
  const rootId = opts.rootId ?? 'root-001';
  const threadId = opts.threadId === null ? undefined : (opts.threadId ?? rootId);
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: rootId,
      thread_id: threadId,
      chat_id: opts.chatId ?? 'chat-001',
      chat_type: opts.chatType ?? 'group',
      content: opts.content,
      mentions: opts.mentions,
    },
    sender: {
      sender_type: opts.senderType ?? 'app',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

function makeUserMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  /** Pass `null` to model Lark's quote-bubble quirk (root_id present without
   *  thread_id). Otherwise defaults to rootId, matching real Lark threaded
   *  messages where both fields are co-present. */
  threadId?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
}) {
  const threadId = opts.threadId === null
    ? undefined
    : (opts.threadId ?? opts.rootId);
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: opts.rootId,
      thread_id: threadId,
      chat_id: opts.chatId ?? 'chat-001',
      chat_type: opts.chatType ?? 'group',
      content: opts.content,
      mentions: opts.mentions,
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('isBotMentioned', () => {
  beforeEach(() => {
    setupBotState();
  });

  it('detects @mention via message.mentions array', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('detects @mention in post content at tags (bot-sent messages)', () => {
    // Bot-sent post messages embed @mentions as inline `at` nodes in content,
    // NOT in the message.mentions array
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'text', text: 'Hey ' },
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' can you help?' },
        ]],
      },
    });
    const message = { content: postContent, mentions: [] };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('returns false when bot is not mentioned', () => {
    const message = {
      mentions: [{ key: '@_other', name: 'Other', id: { open_id: 'ou_other' } }],
      content: JSON.stringify({ text: '@Other hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
  });

  it('returns false when bot open_id is unknown', () => {
    setupBotState({ botOpenId: undefined });
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
  });
});

describe('im.message.receive_v1 — bot-to-bot @mention routing', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('routes @mentioned bot message to handleThreadReply', async () => {
    // Another bot sends a post message that @mentions this bot in a thread
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' please review this' },
        ]],
      },
    });

    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: postContent,
      rootId: 'root-thread-1',
    });

    const handler = capturedHandlers['im.message.receive_v1'];
    expect(handler).toBeDefined();
    await handler(event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-1',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('routes @mentioned bot message (via mentions array) to handleThreadReply', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: '@BotA check this' }),
      rootId: 'root-thread-2',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-2',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores bot message that does not @mention this bot', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: 'talking to someone else' }),
      rootId: 'root-thread-3',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('ignores cross-bot @mention in chat-scope from an unknown bot', async () => {
    // Foreign bot @mentions us at top level (no rootId) in a 普通群, but the
    // sender is NOT in our peer cross-ref (random Lark bot, not a botmux peer).
    // Drop it — otherwise random bots could spawn chat-scope sessions in any
    // chat they share with us.
    mockGetChatMode.mockResolvedValueOnce('group');
    // No cross-ref entries → unknown peer
    mockReadFileSync.mockReturnValue('{}');
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('routes cross-bot @mention in chat-scope when sender is a known botmux peer', async () => {
    // Same setup as above, but the foreign bot IS in our peer cross-ref → the
    // dispatcher should route it through to handleThreadReply (which auto-
    // creates a chat-scope session and inherits the peer's workingDir).
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'BotB': OTHER_BOT_OPEN_ID }));
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('treats sender_type="bot" same as "app" in chat-scope (known peer routes through)', async () => {
    // Lark 实测：跨 bot 卡片消息到接收方时 sender_type 是 'bot'，不是文档里
    // 写的 'app'。dispatcher 必须把两个值等价对待，否则会绕开 foreign-bot
    // 分支，落到下面的 user-message 通用分支去（绕过 chat-scope gate /
    // /close self-message 特判 / "Bot-to-bot @mention detected" 日志）。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'BotB': OTHER_BOT_OPEN_ID }));
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-001',
      larkAppId: MY_APP_ID,
    }));
    // 必须没有同时再走 user-message 分支去开新 topic — 即 chat-scope gate
    // 只能命中一次，handleNewTopic 不应被 trigger。
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('still enforces chat-scope known-peer gate when sender_type="bot" + unknown peer', async () => {
    // sender_type='bot' 不应该绕开 isKnownPeerBot gate。Lark 随机第三方 bot
    // 给我们发卡片 @mention，sender_type 即使是 'bot'，cross-ref 里没有 →
    // 应该跟 'app' 走 unknown-peer 分支一样被 drop，不能 fall through 到
    // user-message 路径开 chat-scope session。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('treats oncall as chat-level: relaxes canTalk even when THIS bot is not the one bound', async () => {
    // Regression: /oncall bind is per-bot, but oncall is meant to be a
    // chat-level concept. In multi-bot deployments the user often only binds
    // one bot — sibling bots used to fall back to allowedUsers and reply
    // "⚠️ 无操作权限" when @-mentioned by anyone outside the allowlist.
    // isChatOncallBoundForAnyBot now answers true if ANY bot has the chat
    // bound, so unbound siblings join the relaxed talking gate too.
    mockGetChatMode.mockResolvedValueOnce('topic');
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_some_other_human'],
    });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID, // NOT in allowedUsers
      content: JSON.stringify({ text: '@BotA 召集判断一下' }),
      messageId: 'msg-oncall-sibling',
      chatId: 'chat-oncall-sibling',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'msg-oncall-sibling',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('allows known botmux peers to @mention in non-oncall chats even when allowedUsers is restricted', async () => {
    // Regression: bot-to-bot handoff in the same group used canTalk(), whose
    // non-oncall branch only checked human allowedUsers. A peer bot's app-
    // scoped open_id is never in that list, so a valid @mention fell through
    // to "⚠️ 无操作权限" instead of routing to the target bot.
    mockGetChatMode.mockResolvedValueOnce('group');
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'BotB': OTHER_BOT_OPEN_ID }));
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_allowed_human_only'],
    });
    const event = makeUserMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: '@BotA please review' }),
      messageId: 'msg-known-peer-allowedusers',
      chatId: 'chat-known-peer',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-known-peer',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('processes /close from own bot messages in a thread', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: '/close' }),
      rootId: 'root-thread-4',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-4',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores own bot messages that are not /close', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: 'I just finished the task' }),
      rootId: 'root-thread-5',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('does not interfere with normal user messages (sole bot)', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello' }),
      rootId: 'root-thread-6',
      chatType: 'group',
    });
    // User message in a thread where bot owns session, sole bot in chat
    handlers.isSessionOwner.mockReturnValue(true);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-6',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('requires @mention in multi-bot thread even if bot owns session', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello everyone' }),
      rootId: 'root-thread-7',
      chatId: 'chat-multi-1',  // unique chatId to avoid botCount cache
      chatType: 'group',
    });
    handlers.isSessionOwner.mockReturnValue(true);
    // Multi-bot stats — the relax check needs botCount > 1 to fail and force
    // the @mention requirement back on.
    mockGetChatInfo.mockResolvedValue({ userCount: 1, botCount: 2 });
    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    // No @mention → should NOT be routed even though bot owns session
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('processes @mentioned message in multi-bot thread', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA do this' }),
      rootId: 'root-thread-8',
      chatId: 'chat-multi-2',  // unique chatId to avoid botCount cache
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(true);

    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-8',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('treats 普通群 root_id WITHOUT thread_id as chat-scope (Lark quote-bubble quirk)', async () => {
    // User typed a top-level message in 普通群; Lark UI attached root_id but
    // NOT thread_id (引用气泡 / 快速回复 bubble). decideRouting now keys on
    // thread_id, so this routes straight to chat-scope (no fallback needed).
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA continue please' }),
      rootId: 'root-not-mine',
      threadId: null, // explicit: simulate Lark quirk
      chatId: 'chat-fallback-1',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // mockResolvedValue (sticky), not Once: dispatcher reverifies via
    // forceRefresh getChatMode when isSessionOwner=true at scope='chat', so
    // both the routing call and the reverify call must return 'group' here.
    mockGetChatMode.mockResolvedValue('group'); // 普通群
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-fallback-1');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-fallback-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('honors a real Lark 话题 (root_id + thread_id) in 普通群 even when chat-scope session exists', async () => {
    // User explicitly opened a 话题 on a message in 普通群 → message carries
    // both root_id AND thread_id. The bot owns a chat-scope session at this
    // chat, but the user's intent is a fresh thread, so we must NOT bounce
    // them back into chat-scope. Routes thread-scope; since no thread session
    // owns this root, handleNewTopic is invoked (fresh thread session).
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA new topic please' }),
      rootId: 'real-topic-root',
      threadId: 'omt_real_thread', // real Lark thread
      chatId: 'chat-fallback-3',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // Bot owns chat-scope at this chat — but we should NOT re-route into it.
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-fallback-3');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'real-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('keeps thread-scope when root_id+thread_id are set and a thread session DOES exist', async () => {
    // Bot already owns a thread-scope session at this root → continue it.
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA continue please' }),
      rootId: 'root-keep',
      chatId: 'chat-fallback-2',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'root-keep');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'root-keep',
      larkAppId: MY_APP_ID,
    }));
  });

  it('ignores unmentioned replies when another bot owns the thread', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'hello everyone' }),
      rootId: 'root-thread-9',
      chatId: 'chat-multi-3',
      chatType: 'group',
    });
    handlers.isSessionOwner.mockReturnValue(false);

    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — stale chat-scope detection (group → topic conversion)', () => {
  // Lark lets group admins flip chat_mode 'group' ↔ 'topic' on the fly. A
  // botmux chat-scope session built while a chat was 普通群 keeps `scope='chat'`
  // forever; after the chat becomes 话题群, dispatch via sendMessage(chatId)
  // makes Lark wrap every reply into a fresh topic — the user's actual bug
  // report. The fix: when scope='chat' AND we own a session at the chat, the
  // dispatcher force-refreshes chat_mode; if it flipped to 'topic', the stale
  // chat-scope session is evicted and the new message is routed as thread-scope
  // anchored at its own messageId, so handleNewTopic seeds a fresh thread.
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('reroutes to thread-scope when chat-scope session is stale (chat now topic-mode)', async () => {
    // Cache says 'group' (legacy), forceRefresh reveals 'topic' (current truth).
    mockGetChatMode.mockImplementation(async (_appId: string, _chatId: string, options?: { forceRefresh?: boolean }) => {
      return options?.forceRefresh ? 'topic' : 'group';
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-converted');

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA first message after switch' }),
      messageId: 'msg-after-conv',
      chatId: 'chat-converted',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    // Reroutes: scope='thread', anchor=messageId → handleNewTopic seeds a new
    // thread session, NOT handleThreadReply on the stale chat-scope owner.
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-after-conv',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    // Daemon notified so it can evict the stale chat-scope session.
    expect(handlers.onChatModeConverted).toHaveBeenCalledWith('chat-converted', MY_APP_ID);
  });

  it('keeps chat-scope when reverify confirms still 普通群 (no conversion)', async () => {
    mockGetChatMode.mockResolvedValue('group'); // both calls return 'group'
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-stable');

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA still 普通群' }),
      messageId: 'msg-stable',
      chatId: 'chat-stable',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-stable',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.onChatModeConverted).not.toHaveBeenCalled();
  });

  it('does NOT forceRefresh when no chat-scope session exists (no API waste)', async () => {
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false); // no chat-scope session
    // Clear mock history so we measure only this test's getChatMode calls
    // (vitest doesn't auto-reset between tests within a file).
    mockGetChatMode.mockClear();

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA fresh chat' }),
      messageId: 'msg-fresh',
      chatId: 'chat-fresh',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    const forceRefreshCalls = mockGetChatMode.mock.calls.filter(
      ([, , options]) => (options as { forceRefresh?: boolean } | undefined)?.forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(0);
    expect(handlers.onChatModeConverted).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — stale topic detection (topic → group conversion)', () => {
  // Symmetric to the forward case: when a 话题群 is flipped back to 普通群,
  // chat_mode webhook signal isn't pushed and the dispatcher's 5-min cache
  // can keep returning 'topic' long after the flip. Without a guard, every
  // new top-level message routes thread-scope (anchor=messageId) and the
  // bot replies via reply_in_thread=true — which Lark renders as a fresh
  // topic even in the now-flat 普通群. The fix: when routing landed on
  // thread-scope purely from cached chat_mode (anchor==messageId AND the
  // message has no real thread_id), force-refresh once; on 'group', flatten
  // to chat-scope so the reply lands as a plain group message.
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('reroutes to chat-scope when cached topic is stale (chat now group-mode)', async () => {
    // Cache says 'topic' (legacy), forceRefresh reveals 'group' (current truth).
    mockGetChatMode.mockImplementation(async (_appId: string, _chatId: string, options?: { forceRefresh?: boolean }) => {
      return options?.forceRefresh ? 'group' : 'topic';
    });
    handlers.isSessionOwner.mockReturnValue(false);

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA top-level after flip-back' }),
      messageId: 'msg-after-flipback',
      chatId: 'chat-flipback',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    // Reroutes: scope='chat', anchor=chatId → bot replies via sendMessage(chatId),
    // not replyMessage(messageId, reply_in_thread=true).
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-flipback',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('keeps thread-scope when reverify confirms still 话题群 (no flip-back)', async () => {
    // Both cache and forceRefresh agree: still 'topic'. Reverse-check fires
    // (one API call) but routing is preserved — this is the legitimate "new
    // topic seed in 话题群" path and must continue working.
    mockGetChatMode.mockResolvedValue('topic');
    handlers.isSessionOwner.mockReturnValue(false);

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA new topic seed' }),
      messageId: 'msg-topic-seed',
      chatId: 'chat-still-topic',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-topic-seed',
      larkAppId: MY_APP_ID,
    }));
  });

  it('does NOT forceRefresh when message has a real thread_id (existing topic reply)', async () => {
    // Reply *inside* an existing thread in 话题群: message carries both
    // root_id and thread_id. decideRouting returns thread-scope anchored at
    // root_id (not messageId), so the reverse check must skip — there's no
    // ambiguity here and a force-refresh would be wasted API.
    mockGetChatMode.mockResolvedValue('topic');
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'root-existing-topic');
    mockGetChatMode.mockClear();

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA reply inside existing topic' }),
      messageId: 'msg-reply-in-topic',
      rootId: 'root-existing-topic',
      threadId: 'omt_existing',
      chatId: 'chat-topic',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    const forceRefreshCalls = mockGetChatMode.mock.calls.filter(
      ([, , options]) => (options as { forceRefresh?: boolean } | undefined)?.forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(0);
    // Routing stays anchored at the real thread root.
    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'root-existing-topic',
    }));
  });

  it('lets /t still force a topic seed after reverse-flatten (compatibility)', async () => {
    // User typed `@BotA /t …` top-level in a 话题群-flipped-to-普通群. Reverse
    // check flattens routing to chat-scope, then /t override flips it back to
    // thread-scope anchored at messageId — exactly the behaviour /t promises.
    mockGetChatMode.mockImplementation(async (_appId: string, _chatId: string, options?: { forceRefresh?: boolean }) => {
      return options?.forceRefresh ? 'group' : 'topic';
    });
    handlers.isSessionOwner.mockReturnValue(false);

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA /t open new topic' }),
      messageId: 'msg-flipback-t',
      chatId: 'chat-flipback-t',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-flipback-t',
      larkAppId: MY_APP_ID,
    }));
  });
});

describe('im.message.receive_v1 — /t force-topic override', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    mockGetChatMode.mockResolvedValue('group'); // 普通群
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('flips chat-scope to thread-scope on /t in 普通群 (text message)', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA /t 帮我看 X' }),
      messageId: 'msg-force-1',
      chatId: 'chat-force-1',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('flips even when chat-scope session is currently active (the v1 limitation fix)', async () => {
    // The user's exact scenario: bot owns a chat-scope session in 普通群,
    // user sends `@bot /t xxx` — must spawn a fresh thread, NOT pass through.
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA /t open new topic' }),
      messageId: 'msg-force-2',
      chatId: 'chat-force-2',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // Bot already owns chat-scope at chat-force-2 — but /t must override.
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-force-2');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-2',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('detects /t inside a post message (multi-paragraph content)', async () => {
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t 看下 README' },
        ]],
      },
    });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: postContent,
      messageId: 'msg-force-3',
      chatId: 'chat-force-3',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // post message_type
    (event.message as any).message_type = 'post';
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-3',
      larkAppId: MY_APP_ID,
    }));
  });

  it('does NOT flip when message has no /t prefix', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA hello' }),
      messageId: 'msg-noflip-1',
      chatId: 'chat-noflip-1',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    // No /t → routing stays chat-scope (anchor = chatId)
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-noflip-1',
    }));
  });

  it('does NOT flip when scope is already thread (e.g. real Lark 话题 in 普通群)', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA /t inside an existing thread' }),
      rootId: 'root-existing',
      threadId: 'omt_existing',
      messageId: 'msg-noflip-2',
      chatId: 'chat-noflip-2',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    // Already thread-scope → keep anchor = root_id, do NOT change to messageId.
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'root-existing',
    }));
  });

  it('resolves Lark mention keys (@_user_N) before /t detection', async () => {
    // Real Lark text messages put placeholder keys like "@_user_1" in obj.text;
    // the human-readable name lives in message.mentions[].name. Without
    // resolving keys → @${name} first, stripLeadingMentions can't strip them
    // and /t never matches.
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /t real lark form' }),
      messageId: 'msg-force-key-1',
      chatId: 'chat-force-key-1',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-key-1',
    }));
  });

  it('resolves multiple mention keys (multi-bot @ /t scenario)', async () => {
    // User @s two bots in front of /t. Both keys must be resolved/stripped
    // before parseForceTopicInvocation sees the prefix.
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a @_bot_b /t multi-bot' }),
      messageId: 'msg-force-key-2',
      chatId: 'chat-force-key-2',
      chatType: 'group',
      mentions: [
        { key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_bot_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([
      { openId: MY_OPEN_ID, name: 'BotA' },
      { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
    ]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-key-2',
    }));
  });

  it('still ignores when sender is not allowed (permission gate runs first)', async () => {
    // Even with /t, an un-allow-listed user gets the same not_allowed treatment.
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_only_this_user'],
    });
    const event = makeUserMessageEvent({
      senderOpenId: 'ou_random_user',
      content: JSON.stringify({ text: '@BotA /t sneaky' }),
      messageId: 'msg-force-perm',
      chatId: 'chat-force-perm',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('writeBotInfoFile — multi-daemon merge', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('[]');
    mockWriteFileSync.mockReset();
  });

  it('merges current bot into existing entries from other daemons', () => {
    // Existing file has bot B written by another daemon process
    const existing = [
      { larkAppId: 'app-bot-b', botOpenId: 'ou_bot_b', botName: 'BotB', cliId: 'aiden' },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    // Current daemon has bot A
    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    // Should have written merged result with both bots
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(2);
    expect(written.find((e: any) => e.larkAppId === 'app-bot-b')?.botOpenId).toBe('ou_bot_b');
    expect(written.find((e: any) => e.larkAppId === MY_APP_ID)?.botOpenId).toBe(MY_OPEN_ID);
  });

  it('updates own entry without removing others', () => {
    // File already has both bots, but bot A has stale open_id
    const existing = [
      { larkAppId: MY_APP_ID, botOpenId: null, botName: null, cliId: 'claude-code' },
      { larkAppId: 'app-bot-b', botOpenId: 'ou_bot_b', botName: 'BotB', cliId: 'aiden' },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(2);
    // Bot A should be updated
    expect(written.find((e: any) => e.larkAppId === MY_APP_ID)?.botOpenId).toBe(MY_OPEN_ID);
    // Bot B should remain unchanged
    expect(written.find((e: any) => e.larkAppId === 'app-bot-b')?.botOpenId).toBe('ou_bot_b');
  });

  it('creates new file when none exists', () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.json'));
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

    mockGetAllBots.mockReturnValue([{
      config: { larkAppId: MY_APP_ID, cliId: 'claude-code' },
      botOpenId: MY_OPEN_ID,
      botName: 'BotA',
    }]);

    writeBotInfoFile('/data');

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(1);
    expect(written[0].larkAppId).toBe(MY_APP_ID);
  });
});
