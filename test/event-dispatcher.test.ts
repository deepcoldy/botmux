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
const mockFindOncallChat = vi.fn(() => undefined);
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  getAllBots: () => mockGetAllBots(),
  findOncallChat: (...args: any[]) => mockFindOncallChat(...args),
}));

const mockListChatBotMembers = vi.fn(async () => [] as Array<{ openId: string; name: string }>);
vi.mock('../src/im/lark/client.js', () => ({
  getChatInfo: vi.fn(async () => ({ userCount: 1 })),
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
} {
  return {
    handleCardAction: vi.fn(async () => undefined),
    handleNewTopic: vi.fn(async () => {}),
    handleThreadReply: vi.fn(async () => {}),
    isSessionOwner: vi.fn(() => false),
  };
}

/** Build a Lark im.message.receive_v1 event data object */
function makeBotMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
}) {
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: opts.rootId ?? 'root-001',
      chat_id: opts.chatId ?? 'chat-001',
      chat_type: opts.chatType ?? 'group',
      content: opts.content,
      mentions: opts.mentions,
    },
    sender: {
      sender_type: 'app',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

function makeUserMessageEvent(opts: {
  senderOpenId: string;
  content: string;
  rootId?: string;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
}) {
  return {
    message: {
      message_id: opts.messageId ?? 'msg-001',
      root_id: opts.rootId,
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

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, 'root-thread-1', MY_APP_ID);
  });

  it('routes @mentioned bot message (via mentions array) to handleThreadReply', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({ text: '@BotA check this' }),
      rootId: 'root-thread-2',
      mentions: [{ key: '@_bot_a', name: 'BotA', id: { open_id: MY_OPEN_ID } }],
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, 'root-thread-2', MY_APP_ID);
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

  it('ignores bot message without rootId (not in a thread)', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: OTHER_BOT_OPEN_ID,
      content: JSON.stringify({
        zh_cn: { content: [[{ tag: 'at', user_id: MY_OPEN_ID }]] },
      }),
      rootId: undefined,
    });
    // rootId is undefined — set it explicitly
    event.message.root_id = undefined as any;

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('processes /close from own bot messages in a thread', async () => {
    const event = makeBotMessageEvent({
      senderOpenId: MY_OPEN_ID,  // own message
      content: JSON.stringify({ text: '/close' }),
      rootId: 'root-thread-4',
    });

    await capturedHandlers['im.message.receive_v1'](event);

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, 'root-thread-4', MY_APP_ID);
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

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, 'root-thread-6', MY_APP_ID);
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

    expect(handlers.handleThreadReply).toHaveBeenCalledWith(event, 'root-thread-8', MY_APP_ID);
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
