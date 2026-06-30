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
// bots-info.json 走原子写 helper；这里直接代理到 mockWriteFileSync，
// 断言面（最终路径 + 完整内容）与裸 writeFileSync 时代保持一致。
vi.mock('../src/utils/atomic-write.js', () => ({
  atomicWriteFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

const mockGetBot = vi.fn();
const mockGetAllBots = vi.fn(() => []);
const mockGetBotOpenId = vi.fn((larkAppId: string) => mockGetBot(larkAppId)?.botOpenId as string | undefined);
const mockGetOwnerOpenId = vi.fn(() => undefined as string | undefined);
const mockIsChatOncallBoundForAnyBot = vi.fn<(chatId: string) => boolean>(() => false);
const mockFindOncallChat = vi.fn<(larkAppId: string, chatId: string) => { chatId: string; workingDir: string } | undefined>(() => undefined);
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  getAllBots: () => mockGetAllBots(),
  getBotOpenId: (...args: any[]) => mockGetBotOpenId(...(args as [string])),
  getOwnerOpenId: (...args: any[]) => mockGetOwnerOpenId(...args),
  findOncallChat: (...args: any[]) => mockFindOncallChat(...(args as [string, string])),
  isChatOncallBoundForAnyBot: (...args: any[]) => mockIsChatOncallBoundForAnyBot(...(args as [string])),
}));

const mockListChatBotMembers = vi.fn(async () => [] as Array<{ openId: string; name: string }>);
const mockGetChatMode = vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p');
const mockGetCachedChatMode = vi.fn(() => undefined as 'group' | 'topic' | 'p2p' | undefined);
const mockGetChatInfo = vi.fn(async () => ({ userCount: 1, botCount: 1 }));
const mockReplyMessage = vi.fn(async () => 'msg-id');
const mockUpdateMessage = vi.fn(async () => true);
const mockListChatMessages = vi.fn(async () => [] as any[]);
const mockListChatMessagesUntil = vi.fn(async () => [] as any[]);
const mockListThreadMessages = vi.fn(async () => [] as any[]);
const mockGetMessageDetail = vi.fn(async () => ({ items: [] as any[] }));
// 默认所有 open_id 都判为「非真人」（bot）→ 保持既有用例「全部登记」的预期；
// 需要模拟真人的用例用 mockResolvedValueOnce(true)。
const mockIsHumanOpenId = vi.fn(async () => false);
vi.mock('../src/im/lark/client.js', () => ({
  getChatInfo: (...args: any[]) => mockGetChatInfo(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  getCachedChatMode: (...args: any[]) => mockGetCachedChatMode(...args),
  listChatBotMembers: (...args: any[]) => mockListChatBotMembers(...args),
  replyMessage: (...args: any[]) => mockReplyMessage(...args),
  updateMessage: (...args: any[]) => mockUpdateMessage(...args),
  getMessageDetail: (...args: any[]) => mockGetMessageDetail(...args),
  isHumanOpenId: (...args: any[]) => mockIsHumanOpenId(...args),
  listChatMessages: (...args: any[]) => mockListChatMessages(...args),
  listChatMessagesUntil: (...args: any[]) => mockListChatMessagesUntil(...args),
  listThreadMessages: (...args: any[]) => mockListThreadMessages(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRecordObservedBots = vi.fn();
const mockListObservedBots = vi.fn(() => [] as any[]);
vi.mock('../src/services/observed-bots-store.js', () => ({
  recordObservedBots: (...args: any[]) => mockRecordObservedBots(...args),
  listObservedBots: (...args: any[]) => mockListObservedBots(...args),
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
    start = vi.fn(async () => {});
    getConnectionStatus = vi.fn(() => ({ state: 'connected', reconnectAttempts: 0 }));
  }
  return {
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { info: 2 },
  };
});

// ─── Imports (must be after mocks) ──────────────────────────────────────────

import { __resetAnchorQueues } from '../src/utils/anchor-serializer.js';
import { __resetEventClaimsForTest, canOperate, canTalk, decideRouting, ensureBotOpenId, isBotMentioned, mentionsAnotherMember, startLarkEventDispatcher, writeBotInfoFile, type EventHandlers } from '../src/im/lark/event-dispatcher.js';
// grant-pending is a real (unmocked) module-level table; reset it per test so the
// grant-card throttle state never leaks across cases (it backs the @blocked card path).
import { _resetForTest as _resetGrantPending } from '../src/im/lark/grant-pending.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const MY_APP_ID = 'app-bot-a';
const MY_OPEN_ID = 'ou_bot_a_open_id';
const OTHER_BOT_OPEN_ID = 'ou_bot_b_open_id';
const USER_OPEN_ID = 'ou_user_123';

beforeEach(() => {
  mockListChatMessages.mockReset().mockResolvedValue([]);
  mockListChatMessagesUntil.mockReset().mockResolvedValue([]);
  mockListThreadMessages.mockReset().mockResolvedValue([]);
  mockGetMessageDetail.mockReset().mockResolvedValue({ items: [] });
});

type TestMention = {
  key: string;
  name: string;
  id: { open_id?: string; app_id?: string } | string;
  id_type?: string;
};

async function flushEventWork() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function setupBotState(opts?: {
  botOpenId?: string | undefined;
  chatGrants?: Record<string, string[]>;
  globalGrants?: string[];
  allowedUsers?: string[];
  /** 原始配置里的 allowedUsers（默认镜像 allowedUsers）。用于构造「配了 owner 但解析为空」的场景。 */
  configAllowedUsers?: string[];
  restrictGrantCommands?: boolean;
  regularGroupReplyMode?: 'chat' | 'new-topic' | 'shared' | 'chat-topic';
	  regularGroupMentionMode?: 'always' | 'topic' | 'never';
	  autoStartOnNewTopic?: boolean;
	  autoGrantRequestCards?: boolean;
	  chatReplyModes?: Record<string, 'chat' | 'new-topic' | 'shared' | 'chat-topic'>;
	  p2pMode?: 'thread' | 'chat';
	  summaryRange?: { limit?: number; sinceHours?: number };
	}) {
  mockGetBot.mockReturnValue({
    config: {
      larkAppId: MY_APP_ID,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      // 生产里 config.allowedUsers 是原始配置（启动后 resolvedAllowedUsers 才是解析结果）。
      // 默认镜像, 单测可用 configAllowedUsers 单独构造「配了但解析为空」的 fail-closed 场景。
      allowedUsers: opts?.configAllowedUsers ?? opts?.allowedUsers,
      chatGrants: opts?.chatGrants,
      globalGrants: opts?.globalGrants,
      restrictGrantCommands: opts?.restrictGrantCommands,
      regularGroupReplyMode: opts?.regularGroupReplyMode,
      regularGroupMentionMode: opts?.regularGroupMentionMode,
      autoStartOnNewTopic: opts?.autoStartOnNewTopic,
      autoGrantRequestCards: opts?.autoGrantRequestCards,
	      chatReplyModes: opts?.chatReplyModes,
	      p2pMode: opts?.p2pMode,
	      summaryRange: opts?.summaryRange,
	    },
    botOpenId: opts && 'botOpenId' in opts ? opts.botOpenId : MY_OPEN_ID,
    resolvedAllowedUsers: opts?.allowedUsers ?? [],
  });
}

	function makeHandlers(): EventHandlers & {
  handleNewTopic: ReturnType<typeof vi.fn>;
  handleThreadReply: ReturnType<typeof vi.fn>;
  handleCardAction: ReturnType<typeof vi.fn>;
  isSessionOwner: ReturnType<typeof vi.fn>;
  onChatModeConverted: ReturnType<typeof vi.fn>;
  resolveReplyThreadAlias: ReturnType<typeof vi.fn>;
} {
  return {
    handleCardAction: vi.fn(async () => undefined),
    handleNewTopic: vi.fn(async () => {}),
    handleThreadReply: vi.fn(async () => {}),
    isSessionOwner: vi.fn(() => false),
    resolveReplyThreadAlias: vi.fn(() => null),
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
  mentions?: TestMention[];
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
  mentions?: TestMention[];
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

describe('decideRouting — p2p p2pMode (thread | chat)', () => {
  // Build a p2p DM message object (decideRouting takes message, not the full event).
  const dm = (over: Record<string, any> = {}) => ({
    message_id: 'msg-dm', chat_id: 'oc_dm', chat_type: 'p2p',
    root_id: undefined, thread_id: undefined, ...over,
  });

  it('chat mode: top-level DM → flat chat-scope anchored on chatId', async () => {
    setupBotState({ p2pMode: 'chat' });
    expect(await decideRouting(MY_APP_ID, dm())).toEqual({ scope: 'chat', anchor: 'oc_dm' });
  });

  it('chat mode: DM reply carrying root_id+thread_id still folds into the SAME chat-scope session (regression — must not escape to thread-scope)', async () => {
    setupBotState({ p2pMode: 'chat' });
    expect(await decideRouting(MY_APP_ID, dm({ root_id: 'root-dm', thread_id: 'root-dm' })))
      .toEqual({ scope: 'chat', anchor: 'oc_dm' });
  });

  it('default (thread) mode: top-level DM → fresh thread-scope anchored on messageId', async () => {
    setupBotState({});
    expect(await decideRouting(MY_APP_ID, dm())).toEqual({ scope: 'thread', anchor: 'msg-dm' });
  });

  it('default (thread) mode: DM reply with root_id+thread_id threads into its session (real-thread, unchanged)', async () => {
    setupBotState({});
    expect(await decideRouting(MY_APP_ID, dm({ root_id: 'root-dm', thread_id: 'root-dm' })))
      .toEqual({ scope: 'thread', anchor: 'root-dm' });
  });

  it('p2pMode=chat does NOT leak into group routing (gate is p2p-only): group real-thread stays thread-scope', async () => {
    setupBotState({ p2pMode: 'chat' });
    expect(await decideRouting(MY_APP_ID, { message_id: 'msg-g', chat_id: 'oc_g', chat_type: 'group', root_id: 'root-g', thread_id: 'root-g' }))
      .toEqual({ scope: 'thread', anchor: 'root-g' });
  });
});

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

  it('detects @mention via REST string-form id (im.message.get shape)', () => {
    // The message REST API delivers mention.id as a bare string "ou_xxx" with a
    // sibling id_type, unlike the WS event's { open_id } object. mentionOpenId
    // must absorb this so a Lark shape convergence can't silently break @-routing.
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: MY_OPEN_ID, id_type: 'open_id' }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('detects string-form id with no id_type (defaults to open_id)', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: MY_OPEN_ID }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('does NOT match a string-form id whose id_type is not open_id', () => {
    // Guard: Lark may return a union_id/user_id string when the app lacks the
    // open_id scope. Even if its value coincided with our open_id it must not be
    // compared as one.
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: MY_OPEN_ID, id_type: 'union_id' }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
  });

  it('detects @mention via app_id mention payload', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: MY_APP_ID, id_type: 'app_id' }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(true);
  });

  it('does not treat another app_id as this bot mention', () => {
    const message = {
      mentions: [{ key: '@_other', name: 'Other', id: 'app-other', id_type: 'app_id' }],
      content: JSON.stringify({ text: '@Other hello' }),
    };
    expect(isBotMentioned(MY_APP_ID, message, undefined)).toBe(false);
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

// The 'ambient' mention policy answers un-@ messages but backs off the moment
// the user @mentions a *different* member (person/bot) — the redirect carve-out.
// mentionsAnotherMember is that predicate. 'never' ignores it (unconditional).
describe('mentionsAnotherMember (ambient redirect carve-out)', () => {
  beforeEach(() => {
    setupBotState();
  });

  it('returns true when the message @mentions another member via mentions array', () => {
    const message = {
      mentions: [{ key: '@_other', name: 'Other', id: { open_id: 'ou_other' } }],
      content: JSON.stringify({ text: '@Other 你看下' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(true);
  });

  it('returns true when another BOT is @mentioned via REST string-form id (regression — naked m.id.open_id misses this)', () => {
    // The headline scenario for the carve-out: "@another bot → back off". On the
    // REST shape mention.id arrives as a bare string, and a bot @ is a "cli_…"
    // string. mentionOpenId() must absorb it, otherwise the ambient bot keeps
    // answering instead of yielding to the bot the user actually summoned.
    const message = {
      mentions: [{ key: '@_other', name: 'OtherBot', id: 'cli_other_bot', id_type: 'open_id' }],
      content: JSON.stringify({ text: '@OtherBot 你来答' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(true);
  });

  it('returns true when another member is @mentioned via string-form id with no id_type (defaults to open_id)', () => {
    const message = {
      mentions: [{ key: '@_other', name: 'Other', id: 'ou_other' }],
      content: JSON.stringify({ text: '@Other 你看下' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(true);
  });

  it('returns false when only THIS bot is @mentioned via string-form id (no false redirect)', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: MY_OPEN_ID, id_type: 'open_id' }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(false);
  });

  it('returns true when another member is @mentioned via inline at node (post content)', () => {
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'at', user_id: 'ou_other' },
          { tag: 'text', text: ' 帮我看下' },
        ]],
      },
    });
    expect(mentionsAnotherMember(MY_APP_ID, { content: postContent, mentions: [] })).toBe(true);
  });

  it('returns false when only THIS bot is @mentioned', () => {
    const message = {
      mentions: [{ key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      content: JSON.stringify({ text: '@BotA hello' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(false);
  });

  it('returns false for @all (everyone incl. me — not a redirect to someone else)', () => {
    const message = {
      mentions: [{ key: '@_all_', name: 'all', id: { open_id: 'all' } }],
      content: JSON.stringify({ text: '@all 通知' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(false);
  });

  it('returns false when no one is @mentioned (plain ambient message)', () => {
    const message = { mentions: [], content: JSON.stringify({ text: '随便说一句' }) };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(false);
  });

  it('returns true when both this bot AND another member are @mentioned (still a hand-off signal)', () => {
    const message = {
      mentions: [
        { key: '@_bot', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_other', name: 'Other', id: { open_id: 'ou_other' } },
      ],
      content: JSON.stringify({ text: '@BotA @Other' }),
    };
    expect(mentionsAnotherMember(MY_APP_ID, message)).toBe(true);
  });
});

describe('im.message.receive_v1 — bot-to-bot @mention routing', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    _resetGrantPending();
    mockReplyMessage.mockClear();
    mockGetOwnerOpenId.mockReset();
    mockGetOwnerOpenId.mockReturnValue(undefined);
    mockGetCachedChatMode.mockReset();
    mockGetCachedChatMode.mockReturnValue(undefined);
    mockRecordObservedBots.mockClear();
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockFindOncallChat.mockReturnValue(undefined);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('blocks /introduce for restricted chat-granted users before recording bots', async () => {
    setupBotState({
      chatGrants: { chat_restrict: [USER_OPEN_ID] },
      allowedUsers: ['ou_owner'],
      restrictGrantCommands: true,
    });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /introduce' }),
      messageId: 'msg-intro-restricted',
      chatId: 'chat_restrict',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockReplyMessage).toHaveBeenCalledWith(
      MY_APP_ID,
      'msg-intro-restricted',
      expect.stringContaining('/introduce'),
    );
    expect(mockRecordObservedBots).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('sends a grant request card when an unknown external bot is @blocked and the toggle is on', async () => {
    setupBotState({ allowedUsers: ['ou_owner'] });
    mockGetOwnerOpenId.mockReturnValue('ou_owner');
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');
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
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(mockReplyMessage).toHaveBeenCalledWith(
      MY_APP_ID,
      'msg-001',
      expect.stringContaining(OTHER_BOT_OPEN_ID),
      'interactive',
    );
  });

  it('keeps the unknown external bot @blocked path silent when auto grant cards are disabled', async () => {
    setupBotState({ allowedUsers: ['ou_owner'], autoGrantRequestCards: false });
    mockGetOwnerOpenId.mockReturnValue('ou_owner');
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');
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
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it('throttles repeat @blocked mentions from the same bot+chat to a single grant card', async () => {
    setupBotState({ allowedUsers: ['ou_owner'] });
    mockGetOwnerOpenId.mockReturnValue('ou_owner');
    mockGetChatMode.mockResolvedValue('group');
    mockReadFileSync.mockReturnValue('{}');
    handlers.isSessionOwner.mockReturnValue(false);

    const makeBlocked = (messageId: string) => {
      const event = makeBotMessageEvent({
        senderOpenId: OTHER_BOT_OPEN_ID,
        senderType: 'bot',
        messageId,
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
        }),
        rootId: undefined,
      });
      event.message.root_id = undefined as any;
      return event;
    };

    // Two distinct messages (distinct message_id → both clear event-dedup) from the
    // SAME bot in the SAME chat. The throttle keys on bot:chat:target, so the second
    // is suppressed while the first card is still pending.
    await capturedHandlers['im.message.receive_v1'](makeBlocked('msg-001'));
    await flushEventWork();
    await capturedHandlers['im.message.receive_v1'](makeBlocked('msg-002'));
    await flushEventWork();

    expect(mockReplyMessage).toHaveBeenCalledTimes(1);
    expect(mockReplyMessage).toHaveBeenCalledWith(
      MY_APP_ID,
      'msg-001',
      expect.stringContaining(OTHER_BOT_OPEN_ID),
      'interactive',
    );
  });

  it('retries the grant card on a later @blocked after a failed send (clears stale pending)', async () => {
    setupBotState({ allowedUsers: ['ou_owner'] });
    mockGetOwnerOpenId.mockReturnValue('ou_owner');
    mockGetChatMode.mockResolvedValue('group');
    mockReadFileSync.mockReturnValue('{}');
    handlers.isSessionOwner.mockReturnValue(false);
    // First send fails (transient Lark error). The pending opened just before the send
    // must be cleared so a later @ from the same bot re-triggers a card — otherwise the
    // sender is throttled forever and the owner never sees any grant card.
    mockReplyMessage.mockRejectedValueOnce(new Error('lark 500'));

    const makeBlocked = (messageId: string) => {
      const event = makeBotMessageEvent({
        senderOpenId: OTHER_BOT_OPEN_ID,
        senderType: 'bot',
        messageId,
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
        }),
        rootId: undefined,
      });
      event.message.root_id = undefined as any;
      return event;
    };

    await capturedHandlers['im.message.receive_v1'](makeBlocked('msg-001'));
    await flushEventWork();
    await capturedHandlers['im.message.receive_v1'](makeBlocked('msg-002'));
    await flushEventWork();

    // The failed first send did not poison the throttle: the second @ tried again.
    expect(mockReplyMessage).toHaveBeenCalledTimes(2);
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('still drops an unknown-peer bot even when it sends /t (no force-topic gate bypass)', async () => {
    // 关键回归：bot-sender 的 `/t` override 把 chat-scope 翻成 thread-scope，但
    // 它必须排在 vetting gate 之后。否则随机第三方 bot 发 `@bot /t …` 会让闸门
    // 的 `ctx.scope === 'chat' || source === 'regular-group-thread'` 两条件全 false
    // → 绕过 vetting → 静默 spawn 一个 thread-scope 会话。这条用例锁死「不能绕」。
    mockGetChatMode.mockResolvedValueOnce('group');  // 普通群, regularGroupReplyMode unset(chat) → source=regular-group-chat
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('lets a KNOWN-peer bot use /t to seed a fresh topic in 普通群', async () => {
    // 合法用例：已登记 peer bot（cross-ref 命中）发 `@bot /t …` 交接，过 vetting
    // gate 后 override 生效，把 chat-scope 翻成 thread-scope 开新话题。与上面的
    // 「unknown peer + /t 被 drop」对照，证明修复只挡未授权 bot、不误伤交接。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'BotB': OTHER_BOT_OPEN_ID }));  // known peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('still drops an unknown-peer bot /t when this bot owns a chat-scope session (stale-anchor ownsSession must not exempt)', async () => {
    // 关键回归（Codex gate 抓到）：vetting gate 的 ownsSession 放行口是「外部 bot
    // 跟进我们已拥有的会话」。但 /t 会把 anchor 从 chatId 改成新的 messageId——
    // 我们在新 anchor 上不拥有任何会话。所以 gate 必须按 override 之后的 anchor 算
    // ownsSession，否则未授权 bot 借旧 chat-scope session 的归属绕过 vetting，再被
    // /t 翻成 thread 后在新 anchor 上 auto-create 出一个会话。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    // bot already owns the chat-scope session at chat-001 (the OLD anchor)
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-001');

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('still drops an unknown-peer bot on the /topic alias too (alias must not bypass either)', async () => {
    // /t 和 /topic 走同一条 parseForceTopicInvocation，别让别名成为绕过 vetting 的后门。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /topic spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('lets a chat-granted bot use /t to seed a topic (override reachable past the grant exemption)', async () => {
    // 闸门的另一条放行口：chatGrants。override 排在闸门之后，仍须能被这条放行路径到达。
    setupBotState({ chatGrants: { 'chat-001': [OTHER_BOT_OPEN_ID] } });
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer，唯一放行靠 grant
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('lets a globally-granted bot use /t to seed a topic (override reachable past the global grant)', async () => {
    setupBotState({ globalGrants: [OTHER_BOT_OPEN_ID] });
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('lets a bot use /t to seed a topic in an oncall chat (override reachable past the oncall exemption)', async () => {
    // oncall 短路整段 gate（!findOncallChat），override 仍须落在它后面照常翻 thread。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockFindOncallChat.mockReturnValue({ chatId: 'chat-001', workingDir: '/repo' });
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer，靠 oncall 放行
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({
        zh_cn: { content: [[
          { tag: 'at', user_id: MY_OPEN_ID },
          { tag: 'text', text: ' /t spawn me' },
        ]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('routes unknown-peer cross-bot @mention in chat-scope when the bot is chat-granted via /grant', async () => {
    // owner 用 `/grant @bot` 把外部 bot 加进本群 chatGrants：即便它不在 peer
    // cross-ref（isKnownPeerBot=false），命中 chatGrants 也应与已注册 peer 同等
    // 放行，拉起 chat-scope session。与上面「unknown peer 被 drop」用例对照。
    setupBotState({ chatGrants: { 'chat-001': [OTHER_BOT_OPEN_ID] } });
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
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
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-001',
      larkAppId: MY_APP_ID,
    }));
  });

  it('does not let a chat-grant for one chat leak into a different chat', async () => {
    // chatGrants 是 per-chat：在 chat-001 授权的 bot 到了 chat-999 仍应被 drop。
    setupBotState({ chatGrants: { 'chat-001': [OTHER_BOT_OPEN_ID] } });
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      chatId: 'chat-999',
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('routes unknown-peer cross-bot @mention in ANY chat when the bot is globally granted', async () => {
    // 全局对话授权（globalGrants）：被授权 bot 不在 peer cross-ref、也没在本群 chatGrants，
    // 但命中 globalGrants → 在任意群（这里用一个全新的 chat-777）都应放行拉起 chat-scope session。
    setupBotState({ globalGrants: [OTHER_BOT_OPEN_ID] });
    mockGetChatMode.mockResolvedValueOnce('group');
    mockReadFileSync.mockReturnValue('{}');  // empty cross-ref → unknown peer
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      chatId: 'chat-777',
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-777',
      larkAppId: MY_APP_ID,
    }));
  });

  it('routes unknown-peer cross-bot @mention in oncall chat-scope (auto-create, no /introduce needed)', async () => {
    // oncall 群是当前接收 bot 显式绑定的协作工作区：canTalk 已对真人全员放行，
    // bot→bot 接收侧同等放行 —— 即使发送方不在 cross-ref（isKnownPeerBot=false），
    // 也跳过这道 vetting，让外部 bot 直接拉起 chat-scope session。对照上面的非
    // oncall 用例：同样的 unknown peer 会被 drop。
    // 注意 /introduce 写的是 observed-bots-store（发现/能 @ 到对方），跟这道接收侧
    // cross-ref vetting 是两套独立存储，不是这里放行的前提。
    mockGetChatMode.mockResolvedValueOnce('group');
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockFindOncallChat.mockReturnValue({ chatId: 'chat-001', workingDir: '/repo' });
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
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-001',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('does not let oncall exemption resurrect self-message routing beyond exact /close', async () => {
    // oncall 豁免只放在 foreign-bot chat-scope gate 上，位于 self-message 特判
    // (787-799) 之后。所以即便 chat 是 oncall-bound，本 bot 自己发的非 /close
    // 消息仍在 self 分支被 drop，不会因为 oncall 而被路由。
    // （self 非 /close 在 decideRouting 之前就 return，故无需 stub getChatMode。）
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockFindOncallChat.mockReturnValue({ chatId: 'chat-001', workingDir: '/repo' });
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: 'I just finished the task' }),
      rootId: undefined,
    });
    event.message.root_id = undefined as any;

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('still processes self /close even when chat is oncall-bound', async () => {
    // 镜像上一条：oncall 不应改变 self /close 的既有行为 —— 精确 /close 仍进入
    // handleThreadReply 走关闭流程。
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockFindOncallChat.mockReturnValue({ chatId: 'chat-001', workingDir: '/repo' });
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: '/close' }),
      rootId: 'root-thread-oncall-close',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      anchor: 'root-thread-oncall-close',
      scope: 'thread',
      larkAppId: MY_APP_ID,
    }));
  });

  it('keeps sibling oncall bindings from relaxing this bot canTalk', async () => {
    // /oncall bind is bot-scoped. If Bot A binds this chat, Bot B still uses
    // Bot B's own allowedUsers/chatGrants/globalGrants until Bot B also binds
    // the same chat. Cross-bot oncall discovery may still report the chat as
    // bound somewhere, but that must not open talk access for this receiver.
    mockGetChatMode.mockResolvedValueOnce('topic');
    mockIsChatOncallBoundForAnyBot.mockReturnValue(true);
    mockFindOncallChat.mockReturnValue(undefined);
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_allowed_sibling'] },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_allowed_sibling'],
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
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(canTalk(MY_APP_ID, 'chat-oncall-sibling', 'ou_allowed_sibling')).toBe(true);
  });

  it('allows ordinary talk for any sender when the current chat is in allowedChatGroups', () => {
    // chatId-based: membership is implicit (you can only post in chats you belong to),
    // so any sender posting in a talk-open chat passes — no member snapshot needed.
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedChatGroups: ['oc_team'] },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: [],
    });

    expect(canTalk(MY_APP_ID, 'oc_team', USER_OPEN_ID)).toBe(true);
  });

  it('denies talk in a chat that is not listed in allowedChatGroups when an allowlist exists', () => {
    // chat-scoped: a talk-open chat does NOT leak permission into other chats / DMs.
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedChatGroups: ['oc_team'] },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: [],
    });

    expect(canTalk(MY_APP_ID, 'oc_other_chat', USER_OPEN_ID)).toBe(false);
  });

  it('does not grant sensitive operations from an allowedChatGroups chat', () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedChatGroups: ['oc_team'], allowedUsers: ['ou_admin'] },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_admin'],
    });

    expect(canOperate(MY_APP_ID, 'oc_team', USER_OPEN_ID)).toBe(false);
    expect(canOperate(MY_APP_ID, 'oc_team', 'ou_admin')).toBe(true);
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
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_allowed_human_only'] },
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-fallback-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('folds an @ inside a regular-group topic into the chat-scope session when no thread session owns it', async () => {
    // In chat/shared modes, a mentioned reply inside a regular-group topic should
    // reuse the group chat-scope context and reply in that same topic, rather
    // than spawning a new thread-scope session per topic.
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
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-fallback-3',
      replyRootId: 'real-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
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
    await flushEventWork();

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
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('shared top-level @ routes through chat session with replyRootId=current message', async () => {
    setupBotState({ chatReplyModes: { 'chat-reply-mode': 'shared' }, allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA please answer in a topic' }),
      messageId: 'msg-topic-alias-1',
      chatId: 'chat-reply-mode',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'msg-topic-alias-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('shared thread-contained @ reuses the chat session and replies in the existing topic', async () => {
    setupBotState({ chatReplyModes: { 'chat-reply-mode': 'shared' }, allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA delegated from an existing thread' }),
      rootId: 'old-discussion-root',
      messageId: 'msg-topic-alias-delegate',
      chatId: 'chat-reply-mode',
      chatType: 'group',
      threadId: 'old-discussion-root',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'old-discussion-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('shared explicit @ inside an existing alias thread replies in that alias topic', async () => {
    setupBotState({ chatReplyModes: { 'chat-reply-mode': 'shared' }, allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'chat-reply-mode', sessionId: 'sess-chat' });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA new delegated task inside existing alias' }),
      rootId: 'old-alias-root',
      messageId: 'msg-new-delegate-in-alias',
      chatId: 'chat-reply-mode',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'old-alias-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('shared bot-sent post inside a thread reuses the chat session and replies in the existing topic', async () => {
    setupBotState({ chatReplyModes: { 'chat-reply-mode': 'shared' } });
    mockGetChatMode.mockResolvedValue('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ BotB: OTHER_BOT_OPEN_ID }));
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');
    const postContent = JSON.stringify({
      zh_cn: { content: [[
        { tag: 'at', user_id: MY_OPEN_ID },
        { tag: 'text', text: ' delegated from bot inside existing thread' },
      ]] },
    });
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: postContent,
      rootId: 'old-thread-root',
      threadId: 'old-thread-root',
      messageId: 'msg-bot-delegate',
      chatId: 'chat-reply-mode',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'old-thread-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('default chat-mode @ inside a regular-group topic reuses the group chat session', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-default');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA continue with group context' }),
      rootId: 'existing-topic-root',
      threadId: 'existing-topic-root',
      messageId: 'msg-mentioned-in-topic',
      chatId: 'chat-default',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-default',
      replyRootId: 'existing-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('new-topic mode keeps @ inside a regular-group topic as an independent thread session', async () => {
    setupBotState({ regularGroupReplyMode: 'new-topic', allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'existing-topic-root');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA use independent topic context' }),
      rootId: 'existing-topic-root',
      threadId: 'existing-topic-root',
      messageId: 'msg-mentioned-in-new-topic-mode',
      chatId: 'chat-new-topic',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'existing-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('chat-topic mode: a fresh @ inside a native regular-group topic spawns an independent thread session (NOT folded to chat-scope)', async () => {
    // Direct contrast to the chat/shared fold test above: SAME setup (bot owns
    // the group chat-scope anchor, @mentioned inside a native Lark topic), but in
    // chat-topic mode the turn must NOT fold into the group session. With no
    // session owned at the topic root yet, it spawns a fresh thread-scope session
    // (handleNewTopic, anchor=rootId) — "话题里开新会话".
    setupBotState({ regularGroupReplyMode: 'chat-topic', allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA independent topic context please' }),
      rootId: 'chat-topic-native-root',
      threadId: 'omt_chat_topic_thread', // real Lark thread
      messageId: 'msg-mentioned-in-chat-topic-mode',
      chatId: 'chat-chat-topic',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    // Bot owns the group chat-scope anchor — must NOT pull the topic into it.
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-chat-topic');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'chat-topic-native-root',
      larkAppId: MY_APP_ID,
    }));
    // Crucially NOT routed into the group chat-scope session (the fold path).
    expect(handlers.handleThreadReply).not.toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-chat-topic',
    }));
  });

  it('chat-topic mode: a follow-up @ in a native topic the bot already owns continues that per-topic session (thread-scope, not folded)', async () => {
    // Once a per-topic session exists, further @s continue it in thread-scope —
    // never folded back to the group chat-scope session.
    setupBotState({ regularGroupReplyMode: 'chat-topic', allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owned-chat-topic-root');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA keep going in this topic' }),
      rootId: 'owned-chat-topic-root',
      threadId: 'owned-chat-topic-root',
      messageId: 'msg-followup-in-chat-topic',
      chatId: 'chat-chat-topic-2',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'owned-chat-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('chat-topic mode: a TOP-LEVEL @ still routes flat through the group chat-scope session', async () => {
    // The hybrid: only native topics diverge. A plain top-level @ behaves exactly
    // like `chat` — flat chat-scope anchored on chatId, no topic seeding. No
    // session owned yet → handleNewTopic at chat-scope.
    setupBotState({ regularGroupReplyMode: 'chat-topic', allowedUsers: [USER_OPEN_ID] });
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA top-level question' }),
      messageId: 'msg-chat-topic-top-level',
      chatId: 'chat-chat-topic-flat',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-chat-topic-flat',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('shared follow-up thread reply folds back to chat session when mention mode is topic (no-@ inside topics)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'topic' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'chat-reply-mode', sessionId: 'sess-chat' });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'follow up in alias topic' }),
      rootId: 'msg-topic-alias-1',
      messageId: 'msg-topic-alias-2',
      chatId: 'chat-reply-mode',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'msg-topic-alias-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('shared follow-up thread reply WITHOUT @ is ignored by default (mention mode always → @ required even in topics)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID] }); // default = always
    mockGetChatMode.mockResolvedValue('group');
    handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'chat-reply-mode', sessionId: 'sess-chat' });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'follow up in alias topic without @' }),
      rootId: 'msg-topic-alias-1',
      messageId: 'msg-topic-alias-2b',
      chatId: 'chat-reply-mode',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // No fold-back: the non-@ thread message is left to the normal "@ required"
    // gate, so neither handler fires (the alias resolver is never consulted).
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.resolveReplyThreadAlias).not.toHaveBeenCalled();
  });

  it('mention mode never: a non-@ top-level message from an allowed user is answered (no @ required)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'never' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'no at-mention at all, top level' }),
      messageId: 'msg-never-toplevel',
      chatId: 'chat-never',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // never tier relaxes the "@ required" gate for talk-allowed senders → the
    // non-@ top-level message routes to handleNewTopic (chat-scope, no session yet).
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-never',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('mention mode topic: a non-@ reply inside an owned thread (new-topic/话题群) is answered even in a multi-person group', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'topic' });
    mockGetChatMode.mockResolvedValue('group');
    mockGetChatInfo.mockResolvedValue({ userCount: 3, botCount: 1 }); // multi-person → no 1v1 relax
    handlers.resolveReplyThreadAlias.mockReturnValue(null); // not a shared alias — a real owned thread
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owned-topic-root');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'follow up inside the topic, no @' }),
      rootId: 'owned-topic-root',
      threadId: 'owned-topic-root',
      messageId: 'msg-in-owned-topic',
      chatId: 'chat-topic-tier',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'owned-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('mention mode always (default): a non-@ reply inside an owned thread is ignored in a multi-person group (@ required even in topics)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID] }); // default always
    mockGetChatMode.mockResolvedValue('group');
    mockGetChatInfo.mockResolvedValue({ userCount: 3, botCount: 1 });
    handlers.resolveReplyThreadAlias.mockReturnValue(null);
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'owned-topic-root');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'follow up inside the topic, no @' }),
      rootId: 'owned-topic-root',
      threadId: 'owned-topic-root',
      messageId: 'msg-in-owned-topic-always',
      chatId: 'chat-always-tier',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('shared + never: a non-@ top-level message OPENS a topic (seeds replyRootId), not a flat reply', async () => {
    // Regression: shared mode + never must auto-open a topic even without @,
    // instead of replying at the group top level.
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupReplyMode: 'shared', regularGroupMentionMode: 'never' });
    mockGetChatMode.mockResolvedValue('group');
    mockGetCachedChatMode.mockReturnValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'no @ but should open a shared topic' }),
      messageId: 'msg-shared-never-seed',
      chatId: 'chat-shared-never',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // replyRootId === messageId means a topic is seeded under this message
    // (reply will go into a thread reusing the chat session), not flat top-level.
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-shared-never',
      replyRootId: 'msg-shared-never-seed',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('mention mode always (default): a non-@ top-level message is ignored', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID] }); // default = always
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'no at-mention at all, top level' }),
      messageId: 'msg-always-toplevel',
      chatId: 'chat-always',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  // ── ambient tier — end-to-end gating across the three no-@ decision points ──
  // mentionsAnotherMember is unit-tested above; these drive the FULL dispatch
  // path to prove the redirect carve-out is wired into every gate that drops the
  // @ requirement: the top-level gate, shared-topic seeding, and alias fold-back.
  // Each gate gets a positive (ambient answers) + the carve-out (@ someone else
  // → yields). @all is never a redirect, so it still answers.

  it('ambient: a non-@ top-level message from an allowed user is answered (like never)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'no @ at all — ambient default responder answers' }),
      messageId: 'msg-ambient-toplevel',
      chatId: 'chat-ambient',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-ambient',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('ambient: a top-level message that @mentions ANOTHER member (not this bot) is ignored — yields the turn', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@Someone 你来看看这个' }),
      messageId: 'msg-ambient-redirect',
      chatId: 'chat-ambient-redirect',
      chatType: 'group',
      mentions: [{ key: '@_other', name: 'Someone', id: { open_id: 'ou_someone_else' } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // The redirect carve-out: @ing someone else hands the turn away → stay quiet.
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('ambient: a top-level @all message is still answered (@all is not a redirect to someone else)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@all 大家注意' }),
      messageId: 'msg-ambient-atall',
      chatId: 'chat-ambient-atall',
      chatType: 'group',
      mentions: [{ key: '@_all', name: 'all', id: { open_id: 'all' } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-ambient-atall',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('shared + ambient: a non-@ top-level message OPENS a topic (seeds replyRootId), like never', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupReplyMode: 'shared', regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    mockGetCachedChatMode.mockReturnValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'no @ but should open a shared topic' }),
      messageId: 'msg-shared-ambient-seed',
      chatId: 'chat-shared-ambient',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-shared-ambient',
      replyRootId: 'msg-shared-ambient-seed',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('shared + ambient: a non-@ top-level message that @mentions another member does NOT seed a topic (yields)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupReplyMode: 'shared', regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    mockGetCachedChatMode.mockReturnValue('group');
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@Someone 这个交给你' }),
      messageId: 'msg-shared-ambient-redirect',
      chatId: 'chat-shared-ambient-redirect',
      chatType: 'group',
      mentions: [{ key: '@_other', name: 'Someone', id: { open_id: 'ou_someone_else' } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // Seeding gate backs off → no topic opened, and the top-level gate also yields.
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('ambient: a non-@ follow-up inside a shared-topic alias thread folds back into the chat session (like topic/never)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'chat-ambient-alias', sessionId: 'sess-chat' });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-ambient-alias');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: 'follow up in alias topic, no @' }),
      rootId: 'msg-ambient-alias-1',
      messageId: 'msg-ambient-alias-2',
      chatId: 'chat-ambient-alias',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-ambient-alias',
      replyRootId: 'msg-ambient-alias-1',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('ambient: a follow-up inside a shared-topic alias thread that @mentions another member does NOT fold back (yields)', async () => {
    setupBotState({ allowedUsers: [USER_OPEN_ID], regularGroupMentionMode: 'ambient' });
    mockGetChatMode.mockResolvedValue('group');
    handlers.resolveReplyThreadAlias.mockReturnValue({ chatId: 'chat-ambient-alias', sessionId: 'sess-chat' });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-ambient-alias');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@Someone 你接着看' }),
      rootId: 'msg-ambient-alias-1',
      messageId: 'msg-ambient-alias-redirect',
      chatId: 'chat-ambient-alias',
      chatType: 'group',
      mentions: [{ key: '@_other', name: 'Someone', id: { open_id: 'ou_someone_else' } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    // The fold-back is skipped (redirect) → the alias resolver is never consulted
    // and the message is not pulled into the shared chat session.
    expect(handlers.resolveReplyThreadAlias).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — regular group thread replies preference', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState({ regularGroupReplyMode: 'new-topic' });
    handlers = makeHandlers();
    mockFindOncallChat.mockReturnValue(undefined);
    mockGetChatMode.mockResolvedValue('group');
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('routes a top-level @mention in a regular group to thread-scope when enabled', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA handle this' }),
      messageId: 'msg-regular-thread',
      chatId: 'chat-regular-thread',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockReturnValue(false);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-regular-thread',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('does not route into an existing chat-scope session when the new preference is enabled', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA make a focused topic' }),
      messageId: 'msg-regular-existing-chat',
      chatId: 'chat-regular-existing-chat',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-regular-existing-chat');

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-regular-existing-chat',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — regular group reply mode (tri-state: chat | new-topic | shared)', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    setupBotState();
    handlers = makeHandlers();
    mockFindOncallChat.mockReturnValue(undefined);
    mockGetChatMode.mockResolvedValue('group');
    mockGetCachedChatMode.mockReset();
    mockGetCachedChatMode.mockReturnValue(undefined);
    mockListChatBotMembers.mockResolvedValue([{ openId: MY_OPEN_ID, name: 'BotA' }]);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('per-chat new-topic forks a thread-scope session even when the per-bot default is off', async () => {
    setupBotState({ chatReplyModes: { 'chat-tri-newtopic': 'new-topic' }, allowedUsers: [USER_OPEN_ID] });
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA open a focused topic' }),
      messageId: 'msg-tri-newtopic',
      chatId: 'chat-tri-newtopic',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-tri-newtopic',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('bot-sent @ inside a freshly seeded shared topic folds into the receiver chat session', async () => {
    setupBotState({ regularGroupReplyMode: 'shared' });
    mockGetChatMode.mockResolvedValue('group');
    mockReadFileSync.mockReturnValue(JSON.stringify({ BotB: OTHER_BOT_OPEN_ID }));
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-reply-mode');
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      senderType: 'bot',
      content: JSON.stringify({ text: '@BotA inherited group-context handoff' }),
      rootId: 'sender-shared-topic-root',
      threadId: 'sender-shared-topic-root',
      messageId: 'msg-bot-shared-handoff',
      chatId: 'chat-reply-mode',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-reply-mode',
      replyRootId: 'sender-shared-topic-root',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('per-chat shared overrides a per-bot new-topic default — single mode, no competition', async () => {
    // Per-bot default would fork a new topic; the per-chat shared override
    // must win and keep this turn on the chat-scope session (alias into thread).
    setupBotState({ regularGroupReplyMode: 'new-topic', chatReplyModes: { 'chat-tri-alias': 'shared' }, allowedUsers: [USER_OPEN_ID] });
    handlers.isSessionOwner.mockImplementation((anchor: string) => anchor === 'chat-tri-alias');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA delegate but keep my session' }),
      messageId: 'msg-tri-alias',
      chatId: 'chat-tri-alias',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-tri-alias',
      replyRootId: 'msg-tri-alias',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('per-chat chat opts out of a per-bot new-topic default — flat chat-scope, not a new topic', async () => {
    setupBotState({ regularGroupReplyMode: 'new-topic', chatReplyModes: { 'chat-tri-flat': 'chat' }, allowedUsers: [USER_OPEN_ID] });
    handlers.isSessionOwner.mockReturnValue(false);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA just answer here' }),
      messageId: 'msg-tri-flat',
      chatId: 'chat-tri-flat',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-tri-flat',
      larkAppId: MY_APP_ID,
    }));
  });
});

describe('globalGrants — global talk-only authorization (canTalk / canOperate)', () => {
  beforeEach(() => {
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');  // empty peer cross-ref
  });

  it('canTalk: a globally-granted user can talk in ANY chat', () => {
    setupBotState({ globalGrants: [USER_OPEN_ID] });
    expect(canTalk(MY_APP_ID, 'chat-A', USER_OPEN_ID)).toBe(true);
    expect(canTalk(MY_APP_ID, 'chat-B', USER_OPEN_ID)).toBe(true);
  });

  it('canTalk: configuring globalGrants establishes an allowlist — non-granted users blocked', () => {
    // 只配 globalGrants（无 allowedUsers / allowedChatGroups）也算限制态，不能 fall through 到全开放。
    setupBotState({ globalGrants: ['ou_someone_else'] });
    expect(canTalk(MY_APP_ID, 'chat-A', USER_OPEN_ID)).toBe(false);
  });

  it('canOperate: a globally-granted user does NOT gain operate (PR#46 boundary)', () => {
    setupBotState({ globalGrants: [USER_OPEN_ID] });
    expect(canOperate(MY_APP_ID, 'chat-A', USER_OPEN_ID)).toBe(false);
  });

  it('canOperate: globalGrants alone does NOT leave operate open to everyone', () => {
    // 回归：globalGrants 必须计入 canOperate 的 hasAllowlist，否则只配 globalGrants 会让
    // operate fall through 到「无白名单=全开放」，把 talk-only 授权放大成 operate 全开。
    setupBotState({ globalGrants: ['ou_granted'] });
    expect(canOperate(MY_APP_ID, 'chat-A', 'ou_random_stranger')).toBe(false);
  });

  it('canOperate: allowedUsers member still gains operate alongside globalGrants', () => {
    setupBotState({ globalGrants: ['ou_talk_only'], allowedUsers: ['ou_admin'] });
    expect(canOperate(MY_APP_ID, 'chat-A', 'ou_admin')).toBe(true);
    expect(canOperate(MY_APP_ID, 'chat-A', 'ou_talk_only')).toBe(false);
  });
});

describe('configured-but-unresolved allowlist stays fail-closed (not fail-open)', () => {
  beforeEach(() => {
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');  // empty peer cross-ref
  });

  // 回归：config.allowedUsers 配了 owner，但启动时 email/union 解析失败 → resolvedAllowedUsers
  // 为空。hasAllowlist 必须用「原始配置」判定，否则会 fall through 成「无白名单=全开放」，
  // 让任何人 canTalk/canOperate（正是 onboarding 路径可能写出的隐患）。
  it('canOperate: configured owner that resolves to empty denies everyone (not open)', () => {
    setupBotState({ configAllowedUsers: ['owner@corp.com'], allowedUsers: [] });
    expect(canOperate(MY_APP_ID, 'chat-A', 'ou_random_stranger')).toBe(false);
    expect(canOperate(MY_APP_ID, 'chat-A', USER_OPEN_ID)).toBe(false);
  });

  it('canTalk: configured owner that resolves to empty blocks ordinary talk (not open)', () => {
    setupBotState({ configAllowedUsers: ['owner@corp.com'], allowedUsers: [] });
    expect(canTalk(MY_APP_ID, 'chat-A', 'ou_random_stranger')).toBe(false);
  });

  it('truly empty config (no allowlist at all) remains open mode', () => {
    // 对照：完全没配白名单仍是「个人自用全开放」，不被本次收紧误伤。
    setupBotState({ allowedUsers: [] });
    expect(canOperate(MY_APP_ID, 'chat-A', 'ou_random_stranger')).toBe(true);
    expect(canTalk(MY_APP_ID, 'chat-A', 'ou_random_stranger')).toBe(true);
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
    __resetAnchorQueues();
    __resetEventClaimsForTest();
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    __resetAnchorQueues();
    __resetEventClaimsForTest();
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
    await flushEventWork();

    // Reroutes: scope='chat', anchor=chatId → bot replies via sendMessage(chatId),
    // not replyMessage(messageId, reply_in_thread=true).
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-flipback',
      larkAppId: MY_APP_ID,
    }));
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('keeps thread-scope on topic-cache flip-back when regular group thread replies are enabled', async () => {
    setupBotState({ regularGroupReplyMode: 'new-topic' });
    mockGetChatMode.mockImplementation(async (_appId: string, _chatId: string, options?: { forceRefresh?: boolean }) => {
      return options?.forceRefresh ? 'group' : 'topic';
    });
    handlers.isSessionOwner.mockReturnValue(false);

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA top-level after flip-back' }),
      messageId: 'msg-flipback-pref-thread',
      chatId: 'chat-flipback-pref-thread',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-flipback-pref-thread',
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    __resetAnchorQueues();
    __resetEventClaimsForTest();
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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

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
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-force-key-2',
    }));
  });

  it('still ignores when sender is not allowed (permission gate runs first)', async () => {
    // Even with /t, an un-allow-listed user gets the same not_allowed treatment.
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_only_this_user'] },
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
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — 主动开工 场景② (autoStartOnNewTopic)', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  function setupAutoTopicBot(enabled: boolean, regularGroupNewTopic = false) {
    mockGetBot.mockReturnValue({
      config: {
        larkAppId: MY_APP_ID,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        allowedUsers: ['ou_someone_else'],
        autoStartOnNewTopic: enabled,
        regularGroupReplyMode: regularGroupNewTopic ? 'new-topic' : undefined,
      },
      botOpenId: MY_OPEN_ID,
      // A non-empty allowlist that does NOT include the sender → canTalk(sender)
      // is false, so an un-@ message deterministically returns 'ignore' (the
      // path auto-topic hooks). An EMPTY allowlist means "open mode" (canTalk
      // true), which would route through the single-user relaxation instead and
      // never exercise the branch under test.
      resolvedAllowedUsers: ['ou_someone_else'],
    });
  }

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    setupBotState();
    handlers = makeHandlers();
    handlers.isSessionOwner.mockReturnValue(false);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('话题群新话题（未 @）开关开 → 自动开工 (FR-6)', async () => {
    setupAutoTopicBot(true);
    mockGetChatMode.mockResolvedValue('topic');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '帮我看下 README' }),
      messageId: 'msg-topic-seed',
      chatId: 'chat-topic-1',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'thread',
      anchor: 'msg-topic-seed',
      larkAppId: MY_APP_ID,
    }));
  });

  it('话题群新话题（未 @）开关关 → 不触发 (FR-8)', async () => {
    setupAutoTopicBot(false);
    mockGetChatMode.mockResolvedValue('topic');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '随便说一句' }),
      messageId: 'msg-topic-off',
      chatId: 'chat-topic-2',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('普通群普通消息（未 @）开关开 → 不触发 (FR-7)', async () => {
    setupAutoTopicBot(true);
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '群里随便聊天' }),
      messageId: 'msg-plain',
      chatId: 'chat-plain-1',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('普通群开话题回复开启且未 @ 时仍不触发 autoStartOnNewTopic', async () => {
    setupAutoTopicBot(true, true);
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '普通群里随便聊一句' }),
      messageId: 'msg-regular-no-at-thread-pref',
      chatId: 'chat-regular-no-at-thread-pref',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('普通群 /t（未 @）开关开 → 不触发：/t override 不得被误判为话题群 seed (FR-7 回归)', async () => {
    // 回归 P1a：`/t` 会把普通群 chat-scope routing 翻成 thread+anchor=messageId；
    // 若 auto-topic 判定看 override 后的 routing，会在普通群误开工。必须看 override 前的 routing。
    setupAutoTopicBot(true);
    mockGetChatMode.mockResolvedValue('group');
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '/t 偷偷开工' }),
      messageId: 'msg-plain-forcetopic',
      chatId: 'chat-plain-2',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — /summary command', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    _resetGrantPending();
    handlers = makeHandlers();
    handlers.isSessionOwner.mockReturnValue(false);
    mockGetChatMode.mockResolvedValue('group');
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
    });
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('keeps non-@ regular group messages silent', async () => {
    mockGetChatInfo.mockResolvedValue({ userCount: 3, botCount: 1 });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '只是普通聊天' }),
      messageId: 'msg-no-trigger',
      chatId: 'chat-content-trigger',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(mockListChatMessages).not.toHaveBeenCalled();
    expect(mockListChatMessagesUntil).not.toHaveBeenCalled();
    expect(mockListThreadMessages).not.toHaveBeenCalled();
  });

  it('routes @bot /summary using default 50 messages and 24 hours', async () => {
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
    });
    const triggerMs = 100 * 60 * 60_000;
    mockListChatMessagesUntil.mockResolvedValue([
      {
        message_id: 'old',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '二十五小时前的旧消息' }) },
        sender: { id: 'ou_old', sender_type: 'user' },
        create_time: String(triggerMs - 25 * 60 * 60_000),
      },
      {
        message_id: 'fresh',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '一小时前的新消息' }) },
        sender: { id: 'ou_fresh', sender_type: 'user' },
        create_time: String(triggerMs - 60 * 60_000),
      },
    ]);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /summary' }),
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      messageId: 'msg-summary-command',
      chatId: 'chat-summary-command',
      chatType: 'group',
    });
    (event.message as any).create_time = String(triggerMs);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockListChatMessagesUntil).toHaveBeenCalledWith(MY_APP_ID, 'chat-summary-command', expect.objectContaining({
      stopAfter: expect.any(Function),
    }));
    expect(handlers.handleNewTopic).toHaveBeenCalledWith(event, expect.objectContaining({
      scope: 'chat',
      anchor: 'chat-summary-command',
      summaryCommand: { name: 'summary-command', chatKind: 'regularGroup' },
      promptOverride: expect.stringContaining('请根据当前会话历史生成总结。'),
    }));
    const ctx = handlers.handleNewTopic.mock.calls[0][1] as any;
    expect(ctx.promptOverride).toContain('一小时前的新消息');
    expect(ctx.promptOverride).not.toContain('二十五小时前的旧消息');
  });

  it('uses configured dashboard summary range for @bot /summary', async () => {
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
      summaryRange: { limit: 0, sinceHours: 0 },
    });
    const triggerMs = 100 * 60 * 60_000;
    mockListChatMessagesUntil.mockResolvedValue([
      {
        message_id: 'old',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '很久以前的消息' }) },
        sender: { id: 'ou_old', sender_type: 'user' },
        create_time: String(triggerMs - 200 * 60 * 60_000),
      },
      {
        message_id: 'fresh',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '最近消息' }) },
        sender: { id: 'ou_fresh', sender_type: 'user' },
        create_time: String(triggerMs - 60 * 60_000),
      },
    ]);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /summary' }),
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      messageId: 'msg-summary-command-configured',
      chatId: 'chat-summary-command',
      chatType: 'group',
    });
    (event.message as any).create_time = String(triggerMs);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockListChatMessagesUntil).toHaveBeenCalledWith(MY_APP_ID, 'chat-summary-command', expect.objectContaining({
      stopAfter: expect.any(Function),
    }));
    const ctx = handlers.handleNewTopic.mock.calls[0][1] as any;
    expect(ctx.promptOverride).toContain('很久以前的消息');
    expect(ctx.promptOverride).toContain('最近消息');
  });

  it('summarizes regular group history after the previous @this bot /summary', async () => {
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
      summaryRange: { limit: 0, sinceHours: 0 },
    });
    const triggerMs = 100 * 60 * 60_000;
    mockListChatMessagesUntil.mockResolvedValue([
      {
        message_id: 'before-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '上一轮已经总结过的内容' }) },
        sender: { id: 'ou_before', sender_type: 'user' },
        create_time: String(triggerMs - 4 * 60 * 60_000),
      },
      {
        message_id: 'previous-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '@_bot_a /summary' }) },
        mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
        sender: { id: USER_OPEN_ID, sender_type: 'user' },
        create_time: String(triggerMs - 3 * 60 * 60_000),
      },
      {
        message_id: 'after-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '本轮新增讨论' }) },
        sender: { id: 'ou_after', sender_type: 'user' },
        create_time: String(triggerMs - 60 * 60_000),
      },
    ]);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /summary' }),
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      messageId: 'msg-summary-incremental',
      chatId: 'chat-summary-incremental',
      chatType: 'group',
    });
    (event.message as any).create_time = String(triggerMs);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    const ctx = handlers.handleNewTopic.mock.calls[0][1] as any;
    expect(ctx.promptOverride).toContain('window="since-last-summary"');
    expect(ctx.promptOverride).toContain('本轮新增讨论');
    expect(ctx.promptOverride).not.toContain('上一轮已经总结过的内容');
    expect(ctx.promptOverride).not.toContain('previous-summary');
  });

  it('does not use another bot mention as the previous /summary boundary', async () => {
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
      summaryRange: { limit: 0, sinceHours: 0 },
    });
    const triggerMs = 100 * 60 * 60_000;
    mockListChatMessagesUntil.mockResolvedValue([
      {
        message_id: 'before-other-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '应该仍然在本次总结窗口内' }) },
        sender: { id: 'ou_before', sender_type: 'user' },
        create_time: String(triggerMs - 4 * 60 * 60_000),
      },
      {
        message_id: 'other-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '@_bot_b /summary' }) },
        mentions: [{ key: '@_bot_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } }],
        sender: { id: USER_OPEN_ID, sender_type: 'user' },
        create_time: String(triggerMs - 3 * 60 * 60_000),
      },
      {
        message_id: 'after-other-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '后续讨论' }) },
        sender: { id: 'ou_after', sender_type: 'user' },
        create_time: String(triggerMs - 60 * 60_000),
      },
    ]);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /summary' }),
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      messageId: 'msg-summary-ignore-other-bot',
      chatId: 'chat-summary-ignore-other-bot',
      chatType: 'group',
    });
    (event.message as any).create_time = String(triggerMs);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    const ctx = handlers.handleNewTopic.mock.calls[0][1] as any;
    expect(ctx.promptOverride).toContain('window="configured-range"');
    expect(ctx.promptOverride).toContain('应该仍然在本次总结窗口内');
    expect(ctx.promptOverride).toContain('后续讨论');
  });

  it('summarizes topic history after the previous @this bot /summary', async () => {
    mockGetChatMode.mockResolvedValue('topic');
    setupBotState({
      allowedUsers: [USER_OPEN_ID],
      summaryRange: { limit: 0, sinceHours: 0 },
    });
    const triggerMs = 100 * 60 * 60_000;
    mockListThreadMessages.mockResolvedValue([
      {
        message_id: 'topic-before-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '话题里上一轮已经总结过的内容' }) },
        sender: { id: 'ou_before', sender_type: 'user' },
        create_time: String(triggerMs - 4 * 60 * 60_000),
      },
      {
        message_id: 'topic-previous-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '@_bot_a /summary' }) },
        mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
        sender: { id: USER_OPEN_ID, sender_type: 'user' },
        create_time: String(triggerMs - 3 * 60 * 60_000),
      },
      {
        message_id: 'topic-after-summary',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '话题里本轮新增讨论' }) },
        sender: { id: 'ou_after', sender_type: 'user' },
        create_time: String(triggerMs - 60 * 60_000),
      },
    ]);
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@_bot_a /summary' }),
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      rootId: 'topic-root-summary',
      threadId: 'topic-thread-summary',
      messageId: 'msg-topic-summary-incremental',
      chatId: 'chat-topic-summary-incremental',
      chatType: 'group',
    });
    (event.message as any).create_time = String(triggerMs);

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockListThreadMessages).toHaveBeenCalledWith(MY_APP_ID, 'chat-topic-summary-incremental', 'topic-root-summary', 0);
    const ctx = handlers.handleNewTopic.mock.calls[0][1] as any;
    expect(ctx.promptOverride).toContain('window="since-last-summary"');
    expect(ctx.promptOverride).toContain('话题里本轮新增讨论');
    expect(ctx.promptOverride).not.toContain('话题里上一轮已经总结过的内容');
  });

	  it('keeps non-@ /summary silent', async () => {
	    setupBotState({
	      allowedUsers: [USER_OPEN_ID],
	    });
    mockGetChatInfo.mockResolvedValue({ userCount: 3, botCount: 1 });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '/summary' }),
      messageId: 'msg-summary-no-mention',
      chatId: 'chat-summary-no-mention',
      chatType: 'group',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(mockListChatMessages).not.toHaveBeenCalled();
    expect(mockListChatMessagesUntil).not.toHaveBeenCalled();
    expect(mockListThreadMessages).not.toHaveBeenCalled();
  });
});

describe('im.message.receive_v1 — /introduce command', () => {
  let handlers: ReturnType<typeof makeHandlers>;
  const OTHER_BOT_OPEN_ID_2 = 'ou_bot_c_open_id';

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockRecordObservedBots.mockReset();
    mockReplyMessage.mockReset().mockResolvedValue('ack-msg-id');
    mockIsHumanOpenId.mockReset().mockResolvedValue(false);
    mockGetChatMode.mockResolvedValue('topic');
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  function makeIntroduceEvent(opts: {
    extraText?: string;
    mentions: TestMention[];
    chatId?: string;
    messageId?: string;
  }) {
    const text = `/introduce${opts.extraText ?? ''}`;
    return makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text }),
      chatId: opts.chatId ?? 'chat-intro-001',
      messageId: opts.messageId ?? 'msg-intro-001',
      chatType: 'group',
      mentions: opts.mentions,
    });
  }

  it('records mentioned bots (including self) when external bot is in mentions', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalledTimes(1);
    const [, larkAppIdArg, chatIdArg, botsArg, sourceArg] = mockRecordObservedBots.mock.calls[0];
    expect(larkAppIdArg).toBe(MY_APP_ID);
    expect(chatIdArg).toBe('chat-intro-001');
    expect(sourceArg).toBe('introduce');
    expect((botsArg as Array<{ openId: string; name: string }>).sort((a, b) => a.openId.localeCompare(b.openId)))
      .toEqual([
        { openId: MY_OPEN_ID, name: 'BotA' },
        { openId: OTHER_BOT_OPEN_ID, name: 'BotB' },
      ].sort((a, b) => a.openId.localeCompare(b.openId)));
  });

  it('drops confirmed humans from the roster (contact lookup), keeps bots + self', async () => {
    mockIsHumanOpenId.mockImplementation(async (_app: string, openId: string) => openId === 'ou_human');
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },        // self → kept
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },  // bot → kept
        { key: '@_h', name: '张三', id: { open_id: 'ou_human' } },          // human → dropped
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalledTimes(1);
    const [, , , botsArg] = mockRecordObservedBots.mock.calls[0];
    expect((botsArg as Array<{ openId: string }>).map(b => b.openId).sort())
      .toEqual([MY_OPEN_ID, OTHER_BOT_OPEN_ID].sort());   // 张三(ou_human) filtered out
    const ack = mockReplyMessage.mock.calls[0][2] as string;
    expect(ack).toContain('BotB');
    expect(ack).not.toContain('张三');
  });

  it('sends ack reply when /introduce is consumed', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockReplyMessage).toHaveBeenCalledTimes(1);
    const [larkAppIdArg, messageIdArg, contentArg] = mockReplyMessage.mock.calls[0];
    expect(larkAppIdArg).toBe(MY_APP_ID);
    expect(messageIdArg).toBe('msg-intro-001');
    expect(contentArg).toContain('BotB');
  });

  it('does NOT route /introduce message to handleNewTopic or handleThreadReply', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('does NOT record or ack when only self is @mentioned', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it('does NOT record or ack when no mentions at all', async () => {
    const event = makeIntroduceEvent({
      mentions: [],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it('still consumes (no routing) when only self is @mentioned — does not fall through to CLI', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('does NOT trigger on normal user message that doesn\'t contain /introduce', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA hi there' }),
      mentions: [{ key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      chatType: 'group',
      messageId: 'msg-normal',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
    // Normal routing should fire
    expect(handlers.handleNewTopic).toHaveBeenCalled();
  });

  it('consumes /introduce with extra text after the command (extra text is dropped, not forwarded to CLI)', async () => {
    const event = makeIntroduceEvent({
      extraText: ' 还有这些请帮忙',
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalledTimes(1);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('records all bots (>=3) in one introduce', async () => {
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
        { key: '@_c', name: 'BotC', id: { open_id: OTHER_BOT_OPEN_ID_2 } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    const [, , , botsArg] = mockRecordObservedBots.mock.calls[0];
    expect((botsArg as Array<{ openId: string }>).map(b => b.openId).sort())
      .toEqual([MY_OPEN_ID, OTHER_BOT_OPEN_ID, OTHER_BOT_OPEN_ID_2].sort());
  });

  it('allows /introduce from any user (no auth gate): records + acks, never reaches CLI', async () => {
    // sender NOT in allowedUsers — /introduce should STILL work（只记花名册、不授权）。
    mockGetBot.mockReturnValue({
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_some_other_human'] },
      botOpenId: MY_OPEN_ID,
      resolvedAllowedUsers: ['ou_some_other_human'],  // USER_OPEN_ID not in list
    });
    const event = makeIntroduceEvent({
      mentions: [
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalled();   // 任何人都能登记
    expect(mockReplyMessage).toHaveBeenCalled();          // 仍然回执 ack
    // Still intercepted: never falls through to CLI handlers
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('matches /introduce only as a standalone token (not as a substring like /introducer)', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '/introducer @BotB foo' }),
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
      chatType: 'group',
      messageId: 'msg-introducer',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).not.toHaveBeenCalled();
  });

  it('does NOT trigger when /introduce appears mid-message (must be at command position)', async () => {
    // Codex review finding: "请运行 /introduce" 之类的引用/说明文本不应触发。
    // 命令位置 = 消息文本(去前导 @mention 后)以 /introduce 开头。
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '请运行 /introduce 然后看 ack' }),
      mentions: [
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
      chatType: 'group',
      messageId: 'msg-mid-introduce',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it('triggers when @mention prefixes /introduce (command position after stripping leading @mentions)', async () => {
    // 真实使用形态: 用户先 @ 一串 bot 再喊 /introduce
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA @BotB /introduce' }),
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
      chatType: 'group',
      messageId: 'msg-prefixed-introduce',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalledTimes(1);
  });

  it('triggers on rich-text (post) form: tag:"at" + text " /introduce"', async () => {
    // 锁住飞书富文本 post 形态: @ 节点不进 routing text (extractor 只拼 text 节点),
    // 但 message.mentions[] 仍带全量 (open_id, name)。/introduce 必须仍触发。
    // 后续如果有人改 extractMessageTextForRouting 把 at 节点也拼进文本,
    // 或者破坏 post → text 提取逻辑,这个测试会先炸。
    const postContent = JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'at', user_id: MY_OPEN_ID, user_name: 'BotA' },
          { tag: 'at', user_id: OTHER_BOT_OPEN_ID, user_name: 'BotB' },
          { tag: 'text', text: ' /introduce' },
        ]],
      },
    });
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: postContent,
      mentions: [
        { key: '@_a', name: 'BotA', id: { open_id: MY_OPEN_ID } },
        { key: '@_b', name: 'BotB', id: { open_id: OTHER_BOT_OPEN_ID } },
      ],
      chatType: 'group',
      messageId: 'msg-post-introduce',
    });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();

    expect(mockRecordObservedBots).toHaveBeenCalledTimes(1);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });
});

describe('card.action.trigger — ack-safe slow handlers', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    mockUpdateMessage.mockClear();
    setupBotState();
    handlers = makeHandlers();
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('preserves immediate card action responses when the handler is fast', async () => {
    handlers.handleCardAction.mockResolvedValue({ type: 'updated-card' });

    const result = await capturedHandlers['card.action.trigger']({
      action: { value: { action: 'toggle_stream', root_id: 'root-fast' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_fast_card' },
    });

    expect(result).toEqual({ card: { type: 'raw', data: { type: 'updated-card' } } });
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  it('returns a toast before a slow handler settles, then patches the card in background', async () => {
    let release!: () => void;
    const slow = new Promise(resolve => { release = () => resolve({ type: 'late-card' }); });
    handlers.handleCardAction.mockReturnValue(slow as any);

    vi.useFakeTimers();
    const call = capturedHandlers['card.action.trigger']({
      action: { value: { action: 'toggle_stream', root_id: 'root-slow' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_slow_card' },
    });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(call).resolves.toEqual({ toast: { type: 'info', content: '操作已收到，后台处理中' } });

    release();
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(mockUpdateMessage).toHaveBeenCalledWith(MY_APP_ID, 'om_slow_card', JSON.stringify({ type: 'late-card' }));
  });

  it('dedupes a repeated card action while the first copy is still running', async () => {
    let release!: () => void;
    handlers.handleCardAction.mockReturnValue(new Promise(resolve => { release = () => resolve(undefined); }) as any);
    const event = {
      action: { value: { action: 'restart', root_id: 'root-dup' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_dup_card' },
    };

    const first = capturedHandlers['card.action.trigger'](event);
    const second = await capturedHandlers['card.action.trigger']({ ...event });

    expect(second).toEqual({ toast: { type: 'info', content: '操作正在处理中，请稍候' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('dedupes a same-event_id redelivery that arrives AFTER the first copy completed', async () => {
    handlers.handleCardAction.mockResolvedValue({ type: 'done-card' });
    const event = {
      event_id: 'evt-card-claim',
      action: { value: { action: 'restart', root_id: 'root-claim' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_claim_card' },
    };

    const first = await capturedHandlers['card.action.trigger'](event);
    expect(first).toEqual({ card: { type: 'raw', data: { type: 'done-card' } } });

    // In-flight Set has already cleared in finally(); only the durable claim can
    // still stop a redelivery from re-firing a non-idempotent action (restart).
    const redelivery = await capturedHandlers['card.action.trigger']({ ...event });
    expect(redelivery).toEqual({ toast: { type: 'info', content: '操作已收到，请勿重复点击' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
  });

  it('does NOT durably dedupe distinct clicks without an event_id (legitimate repeat)', async () => {
    handlers.handleCardAction.mockResolvedValue({ type: 'toggled' });
    const event = {
      action: { value: { action: 'toggle_stream', root_id: 'root-toggle' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_toggle_card' },
    };

    const first = await capturedHandlers['card.action.trigger'](event);
    const second = await capturedHandlers['card.action.trigger']({ ...event });

    // No stable id to claim + in-flight guard cleared between clicks, so a repeat
    // (e.g. toggling stream on then off) is NOT suppressed.
    expect(first).toEqual({ card: { type: 'raw', data: { type: 'toggled' } } });
    expect(second).toEqual({ card: { type: 'raw', data: { type: 'toggled' } } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
  });

  // codex slice-1 blocker #2: dash_sessions_page only differs by `page`. If
  // `cardActionKey` doesn't include `page`, a rapid prev→next sequence in
  // the in-flight window would hash to the same key and the second click
  // would be silently dropped.
  it('concurrent `dash_sessions_page` clicks at DIFFERENT pages must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ type: 'card1' }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ type: 'card2' }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const ev = (page: string) => ({
      action: { value: { action: 'dash_sessions_page', invoker_open_id: USER_OPEN_ID, page } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_page_card' },
    });

    const firstP = capturedHandlers['card.action.trigger'](ev('5'));   // user lands on page 5
    const secondP = capturedHandlers['card.action.trigger'](ev('4'));  // immediately clicks prev → page 4

    // Both handler invocations are in flight; neither was suppressed.
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([firstP, secondP]);
  });

  // Settings counterpart guard — dash_settings_toggle on different fields.
  // Sanity check that the existing settings dedupe key still works.
  it('concurrent `dash_settings_toggle` clicks on DIFFERENT fields must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    handlers.handleCardAction
      .mockReturnValueOnce(new Promise(resolve => { release1 = () => resolve({ type: 'a' }); }) as any)
      .mockReturnValueOnce(new Promise(resolve => { release2 = () => resolve({ type: 'b' }); }) as any);

    const ev = (field: string, next: string) => ({
      action: { value: {
        action: 'dash_settings_toggle', invoker_open_id: USER_OPEN_ID,
        field, next_value: next,
      } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_settings_card' },
    });

    const a = capturedHandlers['card.action.trigger'](ev('publicReadOnly', 'true'));
    const b = capturedHandlers['card.action.trigger'](ev('openTerminalInFeishu', 'true'));
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([a, b]);
  });

  // PR3 sessions slice 2a — per-row 📂 详情 buttons share `action: dash_sessions_detail`,
  // only `value.session_id` distinguishes them. The cardActionKey already includes
  // `sessionId`, but pin it down so a future key refactor can't silently drop it.
  it('concurrent `dash_sessions_detail` clicks on DIFFERENT session_id values must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ type: 'detail_a' }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ type: 'detail_b' }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const ev = (sessionId: string) => ({
      action: { value: { action: 'dash_sessions_detail', invoker_open_id: USER_OPEN_ID, session_id: sessionId } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_detail_card' },
    });

    const firstP = capturedHandlers['card.action.trigger'](ev('sess_AAA'));
    const secondP = capturedHandlers['card.action.trigger'](ev('sess_BBB'));

    // BOTH handler invocations reach the handler — the differing session_id
    // must NOT collide on the in-flight dedupe key.
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([firstP, secondP]);
  });

  // Companion test: same session_id while first is in flight → still deduped.
  // Preserves the existing in-flight semantics so non-idempotent slice-2a
  // actions (e.g. close) can't double-fire mid-flight.
  it('concurrent `dash_sessions_detail` clicks on the SAME session_id WHILE in-flight ARE deduped', async () => {
    let release!: () => void;
    const pending = new Promise(resolve => { release = () => resolve({ type: 'detail_only' }); });
    handlers.handleCardAction.mockReturnValueOnce(pending as any);

    const ev = () => ({
      action: { value: { action: 'dash_sessions_detail', invoker_open_id: USER_OPEN_ID, session_id: 'sess_SAME' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_detail_card' },
    });

    const first = capturedHandlers['card.action.trigger'](ev());
    const second = await capturedHandlers['card.action.trigger'](ev());

    // Second click hits the in-flight guard and returns a toast.
    expect(second).toEqual({ toast: { type: 'info', content: '操作正在处理中，请稍候' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  // PR3 schedules slice 2a — per-detail-card pause/resume buttons share
  // `action: dash_schedules_pause` / `dash_schedules_resume`. Only
  // `value.schedule_id` distinguishes which schedule the click targets. The
  // cardActionKey now includes `scheduleId`; pin it down so a future key
  // refactor can't silently drop it and turn two distinct schedule clicks
  // into one (e.g. user opens detail A then detail B and pauses B while A
  // is still in flight).
  it('concurrent `dash_schedules_pause` clicks on DIFFERENT schedule_id values must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ type: 'pause_a' }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ type: 'pause_b' }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const ev = (scheduleId: string) => ({
      action: { value: { action: 'dash_schedules_pause', invoker_open_id: USER_OPEN_ID, schedule_id: scheduleId } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_schedules_card' },
    });

    const firstP = capturedHandlers['card.action.trigger'](ev('sch_AAA'));
    const secondP = capturedHandlers['card.action.trigger'](ev('sch_BBB'));

    // BOTH handler invocations reach the handler — the differing schedule_id
    // must NOT collide on the in-flight dedupe key.
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([firstP, secondP]);
  });

  // Companion: same schedule_id while first is in flight → still deduped.
  // Preserves the existing in-flight semantics so non-idempotent pause/resume
  // can't double-fire on a rapid double-click.
  it('concurrent `dash_schedules_pause` clicks on the SAME schedule_id WHILE in-flight ARE deduped', async () => {
    let release!: () => void;
    const pending = new Promise(resolve => { release = () => resolve({ type: 'pause_only' }); });
    handlers.handleCardAction.mockReturnValueOnce(pending as any);

    const ev = () => ({
      action: { value: { action: 'dash_schedules_pause', invoker_open_id: USER_OPEN_ID, schedule_id: 'sch_SAME' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_schedules_card' },
    });

    const first = capturedHandlers['card.action.trigger'](ev());
    const second = await capturedHandlers['card.action.trigger'](ev());

    expect(second).toEqual({ toast: { type: 'info', content: '操作正在处理中，请稍候' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  // PR3 workflows slice 2a (codex 2026-06-10) — per-detail-card cancel buttons
  // share `action: dash_workflows_cancel`. Only `value.run_id` distinguishes
  // which run the click targets. The cardActionKey now includes `runId`; pin
  // it down so a future key refactor can't silently drop it and turn two
  // distinct run cancel clicks into one (e.g. user opens detail A then detail
  // B and cancels B while A is still in flight).
  it('concurrent `dash_workflows_cancel` clicks on DIFFERENT run_id values must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ type: 'cancel_a' }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ type: 'cancel_b' }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const ev = (runId: string) => ({
      action: { value: { action: 'dash_workflows_cancel', invoker_open_id: USER_OPEN_ID, run_id: runId } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_workflows_card' },
    });

    const firstP = capturedHandlers['card.action.trigger'](ev('run_AAA'));
    const secondP = capturedHandlers['card.action.trigger'](ev('run_BBB'));

    // BOTH handler invocations reach the handler — the differing run_id
    // must NOT collide on the in-flight dedupe key.
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([firstP, secondP]);
  });

  // Companion: same run_id while first is in flight → still deduped.
  // Preserves the existing in-flight semantics so non-idempotent cancel can't
  // double-fire on a rapid double-click against the same run.
  it('concurrent `dash_workflows_cancel` clicks on the SAME run_id WHILE in-flight ARE deduped', async () => {
    let release!: () => void;
    const pending = new Promise(resolve => { release = () => resolve({ type: 'cancel_only' }); });
    handlers.handleCardAction.mockReturnValueOnce(pending as any);

    const ev = () => ({
      action: { value: { action: 'dash_workflows_cancel', invoker_open_id: USER_OPEN_ID, run_id: 'run_SAME' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_workflows_card' },
    });

    const first = capturedHandlers['card.action.trigger'](ev());
    const second = await capturedHandlers['card.action.trigger'](ev());

    expect(second).toEqual({ toast: { type: 'info', content: '操作正在处理中，请稍候' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  // Dashboard groups detail actions share the same action id across many
  // cells. `chat_id` + `app_id` must both be in the in-flight dedupe key so
  // managing bot A in chat X doesn't swallow bot B in chat Y.
  it('concurrent `dash_groups_oncall_bind` clicks on DIFFERENT chat/app cells must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ type: 'bind_a' }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ type: 'bind_b' }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const ev = (chatId: string, appId: string) => ({
      action: {
        value: {
          action: 'dash_groups_oncall_bind',
          invoker_open_id: USER_OPEN_ID,
          chat_id: chatId,
          app_id: appId,
        },
      },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_groups_card' },
    });

    const firstP = capturedHandlers['card.action.trigger'](ev('oc_A', 'cli_A'));
    const secondP = capturedHandlers['card.action.trigger'](ev('oc_B', 'cli_B'));

    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([firstP, secondP]);
  });

  it('concurrent `dash_groups_oncall_bind` clicks on the SAME chat/app cell WHILE in-flight ARE deduped', async () => {
    let release!: () => void;
    const pending = new Promise(resolve => { release = () => resolve({ type: 'bind_only' }); });
    handlers.handleCardAction.mockReturnValueOnce(pending as any);

    const ev = () => ({
      action: {
        value: {
          action: 'dash_groups_oncall_bind',
          invoker_open_id: USER_OPEN_ID,
          chat_id: 'oc_SAME',
          app_id: 'cli_SAME',
        },
      },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_groups_card' },
    });

    const first = capturedHandlers['card.action.trigger'](ev());
    const second = await capturedHandlers['card.action.trigger'](ev());

    expect(second).toEqual({ toast: { type: 'info', content: '操作正在处理中，请稍候' } });
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  // PR3 overview drilldown (2026-06-10): origin/page_size are now part of the
  // dedupe key so a standalone-shaped click (origin=undefined, page_size=undef)
  // and an overview-drilldown-shaped click (origin=overview, page_size=5) on
  // the same page index don't hash-collide. The standalone+drilldown forms can
  // theoretically reach the same handler from two different open cards within
  // the dedupe window.
  it('concurrent `dash_sessions_page` clicks differing ONLY by origin must NOT dedupe', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ card: { type: 'raw', data: {} } }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ card: { type: 'raw', data: {} } }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const evStandalone = {
      action: { value: { action: 'dash_sessions_page', invoker_open_id: USER_OPEN_ID, page: '2' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_a' },
    };
    const evDrilldown = {
      action: { value: { action: 'dash_sessions_page', invoker_open_id: USER_OPEN_ID, page: '2', origin: 'overview', page_size: '5' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_b' },
    };

    const first = capturedHandlers['card.action.trigger'](evStandalone);
    const second = capturedHandlers['card.action.trigger'](evDrilldown);
    // Both should reach the handler — no dedupe.
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([first, second]);
  });

  it('concurrent `dash_sessions_page` clicks at DIFFERENT pages but SAME origin must NOT dedupe (page already in key)', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const pending1 = new Promise(resolve => { release1 = () => resolve({ card: { type: 'raw', data: {} } }); });
    const pending2 = new Promise(resolve => { release2 = () => resolve({ card: { type: 'raw', data: {} } }); });
    handlers.handleCardAction
      .mockReturnValueOnce(pending1 as any)
      .mockReturnValueOnce(pending2 as any);

    const evPage1 = {
      action: { value: { action: 'dash_sessions_page', invoker_open_id: USER_OPEN_ID, page: '1', origin: 'overview', page_size: '5' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_card' },
    };
    const evPage2 = {
      action: { value: { action: 'dash_sessions_page', invoker_open_id: USER_OPEN_ID, page: '2', origin: 'overview', page_size: '5' } },
      operator: { open_id: USER_OPEN_ID },
      context: { open_message_id: 'om_card' },
    };

    const first = capturedHandlers['card.action.trigger'](evPage1);
    const second = capturedHandlers['card.action.trigger'](evPage2);
    expect(handlers.handleCardAction).toHaveBeenCalledTimes(2);
    release1();
    release2();
    await Promise.all([first, second]);
  });
});

describe('im.message.receive_v1 — ack-safe duplicate delivery', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    mockReplyMessage.mockClear();
    mockRecordObservedBots.mockClear();
    setupBotState({ allowedUsers: [USER_OPEN_ID] });
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    mockFindOncallChat.mockReturnValue(undefined);
    mockGetChatMode.mockResolvedValue('group');
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('returns before slow message processing settles so Lark can ACK promptly', async () => {
    let release!: () => void;
    const slowWork = new Promise<void>(resolve => { release = resolve; });
    handlers.handleNewTopic.mockImplementation(async () => slowWork);

    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA slow work' }),
      messageId: 'msg-ack-fast',
      chatId: 'chat-ack-fast',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    const call = capturedHandlers['im.message.receive_v1'](event);
    await expect(Promise.resolve(call)).resolves.toBeUndefined();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();

    await new Promise(resolve => setImmediate(resolve));
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
    release();
    await flushEventWork();
  });

  it('dedupes timeout redelivery of the same message_id', async () => {
    const event = makeUserMessageEvent({
      senderOpenId: USER_OPEN_ID,
      content: JSON.stringify({ text: '@BotA handle once' }),
      messageId: 'msg-dedupe-once',
      chatId: 'chat-dedupe-once',
      chatType: 'group',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    capturedHandlers['im.message.receive_v1'](event);
    capturedHandlers['im.message.receive_v1']({ ...event, uuid: undefined, event_id: undefined });
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
  });

  it('processes two id-less events instead of dropping one (fallback key never collides)', async () => {
    const makeIdless = (text: string) => {
      const e = makeUserMessageEvent({
        senderOpenId: USER_OPEN_ID,
        content: JSON.stringify({ text }),
        chatId: 'chat-unkeyable',
        chatType: 'group',
        mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
      });
      // Strip every id so both events take the unkeyable fallback path. A
      // content-prefix fallback key would collide here and silently drop one.
      return { ...e, uuid: undefined, event_id: undefined, message: { ...e.message, message_id: undefined } };
    };

    capturedHandlers['im.message.receive_v1'](makeIdless('@BotA first'));
    capturedHandlers['im.message.receive_v1'](makeIdless('@BotA second'));
    await flushEventWork();

    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(2);
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

describe('im.message.receive_v1 — botOpenId startup race', () => {
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    capturedHandlers = {};
    __resetAnchorQueues();
    __resetEventClaimsForTest();
    mockReplyMessage.mockClear();
    mockGetCachedChatMode.mockReset();
    mockGetCachedChatMode.mockReturnValue(undefined);
    mockRecordObservedBots.mockClear();
    setupBotState();
    handlers = makeHandlers();
    mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
    startLarkEventDispatcher(MY_APP_ID, 'secret', handlers);
  });

  it('processes a foreign-bot @ that arrives before botOpenId is probed (does not silently drop it)', async () => {
    // Just-restarted daemon: probeBotOpenId still in flight, botOpenId unset.
    const botState: any = {
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      botOpenId: undefined,
      resolvedAllowedUsers: [],
    };
    mockGetBot.mockReturnValue(botState);
    // The probe resolves the open_id: token call, then bot-info call.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't' }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, bot: { open_id: MY_OPEN_ID, app_name: 'Claude' } }) });
    vi.stubGlobal('fetch', fetchMock as any);

    const postContent = JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }, { tag: 'text', text: ' review' }]] } });
    const event = makeBotMessageEvent({ senderOpenId: OTHER_BOT_OPEN_ID, content: postContent, rootId: 'root-race-1' });

    await capturedHandlers['im.message.receive_v1'](event);
    await flushEventWork();
    // Routing runs through serializeByAnchor (fire-and-forget); let its
    // microtask chain settle before asserting.
    await new Promise(resolve => setTimeout(resolve, 0));

    // The @ must be recognized once the probe lands — not dropped because the
    // open_id wasn't ready yet (the silent-drop-then-ACK bug).
    expect(handlers.handleThreadReply).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('ensureBotOpenId — dedup', () => {
  it('shares a single probe across concurrent callers during the startup window', async () => {
    const botState: any = {
      config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
      botOpenId: undefined,
      resolvedAllowedUsers: [],
    };
    mockGetBot.mockReturnValue(botState);
    // Each probe = 2 fetches (token + bot-info). Same payload works for both.
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ code: 0, tenant_access_token: 't', bot: { open_id: MY_OPEN_ID } }),
    });
    vi.stubGlobal('fetch', fetchMock as any);

    await Promise.all([ensureBotOpenId(MY_APP_ID), ensureBotOpenId(MY_APP_ID), ensureBotOpenId(MY_APP_ID)]);

    // One deduped probe → exactly 2 fetches, not 6 (3 separate probes).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(botState.botOpenId).toBe(MY_OPEN_ID);
    vi.unstubAllGlobals();
  });
});

describe('startLarkEventDispatcher — 长连接死后自愈 (reconnect-exhausted recovery)', () => {
  it('SDK 重连耗尽 (state=failed) 时，定时探测并重新 start() 重建长连接', async () => {
    vi.useFakeTimers();
    const ws = startLarkEventDispatcher(MY_APP_ID, 'secret', makeHandlers()) as any;
    // 启动时的首次握手
    expect(ws.start).toHaveBeenCalledTimes(1);

    // 模拟主机长断网：SDK 重连预算耗尽、永久放弃，但进程仍 online（PM2 不会兜底）
    ws.getConnectionStatus.mockReturnValue({ state: 'failed', reconnectAttempts: 9 });

    // 健康检查每 60s 一次：发现 failed → 重新 start() 重建
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.start).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('连接健康 (state=connected) 时不重建，不打断 SDK 自身的重连', async () => {
    vi.useFakeTimers();
    const ws = startLarkEventDispatcher(MY_APP_ID, 'secret', makeHandlers()) as any;
    expect(ws.start).toHaveBeenCalledTimes(1);

    // getConnectionStatus 默认返回 connected；推进多个周期都不应触发重建
    await vi.advanceTimersByTimeAsync(180_000);
    expect(ws.start).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
