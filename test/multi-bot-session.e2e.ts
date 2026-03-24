/**
 * E2E test: Multi-bot session isolation.
 *
 * Verifies that when 3 bots share the same Lark group:
 * 1. Only the @mentioned bot creates a session (others ignore)
 * 2. Sessions keyed by rootMessageId don't collide across bots
 * 3. Card actions use the correct bot's allowedUsers
 * 4. Thread replies route to the correct bot's session
 *
 * Run:  pnpm vitest run test/multi-bot-session.e2e.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock modules before any imports ─────────────────────────────────────────

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killWorker: vi.fn(),
  initWorkerPool: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  getAvailableBots: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendUserMessage: vi.fn(),
  updateMessage: vi.fn(),
  getChatInfo: vi.fn(),
  listChatBotMembers: vi.fn(() => []),
  deleteMessage: vi.fn(),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildSessionCard: vi.fn(() => '{}'),
  buildStreamingCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude Code'),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    constructor(_opts: any) {}
  },
  WSClient: class MockWSClient {
    start() {}
  },
  EventDispatcher: class MockEventDispatcher {
    register() {}
  },
  LoggerLevel: { info: 2 },
}));

// ─── Test data ───────────────────────────────────────────────────────────────

const BOT1 = { appId: 'cli_bot1_aaa', secret: 's1', openId: 'ou_bot1_open', userOpenId: 'ou_user_for_bot1' };
const BOT2 = { appId: 'cli_bot2_bbb', secret: 's2', openId: 'ou_bot2_open', userOpenId: 'ou_user_for_bot2' };
const BOT3 = { appId: 'cli_bot3_ccc', secret: 's3', openId: 'ou_bot3_open', userOpenId: 'ou_user_for_bot3' };
const BOTS = [BOT1, BOT2, BOT3];

const CHAT_ID = 'oc_test_group_chat';
const MSG_ID_TOPIC_A = 'om_topic_a_111';
const MSG_ID_TOPIC_B = 'om_topic_b_222';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake Lark message event that @mentions a specific bot */
function makeLarkEvent(messageId: string, mentionBotOpenId: string, senderOpenId: string, rootId?: string) {
  return {
    message: {
      message_id: messageId,
      chat_id: CHAT_ID,
      chat_type: 'group',
      root_id: rootId,
      content: JSON.stringify({ text: `@bot test message` }),
      mentions: mentionBotOpenId
        ? [{ key: '@_user_1', id: { open_id: mentionBotOpenId } }]
        : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: senderOpenId },
    },
  };
}

/** Build a fake card action payload */
function makeCardAction(action: string, rootId: string, operatorOpenId: string) {
  return {
    action: {
      value: { action, root_id: rootId },
    },
    operator: { open_id: operatorOpenId },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Multi-bot @mention detection', () => {
  beforeEach(async () => {
    // Reset module state
    vi.resetModules();
  });

  it('isBotMentioned returns true only for the mentioned bot', async () => {
    const { registerBot, getBot } = await import('../src/bot-registry.js');
    const { isBotMentioned, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');

    // Register all bots and set their open_ids
    for (const bot of BOTS) {
      registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
    }

    // Message @mentions Bot2
    const event = makeLarkEvent(MSG_ID_TOPIC_A, BOT2.openId, BOT1.userOpenId);
    const message = event.message;

    // Only Bot2 should detect the @mention
    expect(isBotMentioned(BOT1.appId, message, undefined)).toBe(false);
    expect(isBotMentioned(BOT2.appId, message, undefined)).toBe(true);
    expect(isBotMentioned(BOT3.appId, message, undefined)).toBe(false);
  });

  it('isBotMentioned returns false when botOpenId is unknown', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { isBotMentioned } = await import('../src/im/lark/event-dispatcher.js');

    // Register bot WITHOUT setting open_id
    registerBot({ im: 'lark' as const, larkAppId: BOT1.appId, larkAppSecret: BOT1.secret, cliId: 'claude-code' });

    const event = makeLarkEvent(MSG_ID_TOPIC_A, BOT1.openId, BOT1.userOpenId);

    // Can't detect mentions without knowing own open_id
    expect(isBotMentioned(BOT1.appId, event.message, undefined)).toBe(false);
  });
});

describe('Multi-bot checkGroupMessageAccess', () => {
  beforeEach(() => { vi.resetModules(); });

  it('@mentioned bot gets "allowed", others get "ignore"', async () => {
    const { registerBot, getBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');

    // Register bots with resolved allowed users
    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    // Mock getChatInfo to return multi-member group (prevents solo-user fallback)
    const client = await import('../src/im/lark/client.js');
    vi.spyOn(client, 'getChatInfo').mockResolvedValue({ name: 'test', userCount: 4 });

    // Event: user @mentions Bot2
    const event = makeLarkEvent(MSG_ID_TOPIC_A, BOT2.openId, BOT2.userOpenId);
    const message = event.message;

    // Bot1: not mentioned → ignore
    const r1 = await checkGroupMessageAccess(BOT1.appId, message, CHAT_ID, BOT1.userOpenId);
    expect(r1).toBe('ignore');

    // Bot2: mentioned + user is allowed → allowed
    const r2 = await checkGroupMessageAccess(BOT2.appId, message, CHAT_ID, BOT2.userOpenId);
    expect(r2).toBe('allowed');

    // Bot3: not mentioned → ignore
    const r3 = await checkGroupMessageAccess(BOT3.appId, message, CHAT_ID, BOT3.userOpenId);
    expect(r3).toBe('ignore');
  });

  it('no @mention in multi-member group → all bots ignore', async () => {
    const { registerBot, getBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    const client = await import('../src/im/lark/client.js');
    vi.spyOn(client, 'getChatInfo').mockResolvedValue({ name: 'test', userCount: 4 });

    // Event without @mention
    const event = makeLarkEvent(MSG_ID_TOPIC_A, '', BOT1.userOpenId);

    for (const bot of BOTS) {
      const r = await checkGroupMessageAccess(bot.appId, event.message, CHAT_ID, bot.userOpenId);
      expect(r, `${bot.appId} should ignore non-mentioned message`).toBe('ignore');
    }
  });
});

describe('Multi-bot session isolation (activeSessions collision)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('composite key: each bot gets its own session for the same rootId', async () => {
    // With composite key, 3 bots can independently have sessions for the same thread.
    const { sessionKey } = await import('../src/core/types.js');
    const activeSessions = new Map<string, { imBotId: string; sessionId: string }>();
    const rootId = MSG_ID_TOPIC_A;

    // Simulate 3 bots all creating sessions for the same rootId
    activeSessions.set(sessionKey(rootId, BOT1.appId), { imBotId: BOT1.appId, sessionId: 'uuid-1' });
    activeSessions.set(sessionKey(rootId, BOT2.appId), { imBotId: BOT2.appId, sessionId: 'uuid-2' });
    activeSessions.set(sessionKey(rootId, BOT3.appId), { imBotId: BOT3.appId, sessionId: 'uuid-3' });

    // All 3 sessions coexist
    expect(activeSessions.size).toBe(3);
    expect(activeSessions.get(sessionKey(rootId, BOT1.appId))!.imBotId).toBe(BOT1.appId);
    expect(activeSessions.get(sessionKey(rootId, BOT2.appId))!.imBotId).toBe(BOT2.appId);
    expect(activeSessions.get(sessionKey(rootId, BOT3.appId))!.imBotId).toBe(BOT3.appId);
  });

  it('each bot can look up only its own session for a shared rootId', async () => {
    const { sessionKey } = await import('../src/core/types.js');
    const activeSessions = new Map<string, { imBotId: string; sessionId: string }>();
    const rootId = MSG_ID_TOPIC_A;

    // Only Bot1 has a session
    activeSessions.set(sessionKey(rootId, BOT1.appId), { imBotId: BOT1.appId, sessionId: 'uuid-1' });

    // Bot2 looks up — finds nothing (its own composite key doesn't exist)
    expect(activeSessions.has(sessionKey(rootId, BOT2.appId))).toBe(false);

    // Bot1 looks up — finds its own session
    expect(activeSessions.has(sessionKey(rootId, BOT1.appId))).toBe(true);
  });
});

describe('Multi-bot card action allowedUsers', () => {
  beforeEach(() => { vi.resetModules(); });

  it('card action should use receiving bot larkAppId for allowlist, not session larkAppId', async () => {
    const { registerBot, getBot } = await import('../src/bot-registry.js');
    const { handleCardAction } = await import('../src/im/lark/card-handler.js');
    const { sessionKey } = await import('../src/core/types.js');

    // Register bots with DIFFERENT per-app open_ids for the same user
    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    // Simulate: Bot2 owns the session, card action arrives via Bot2
    const activeSessions = new Map<string, any>();
    activeSessions.set(sessionKey(MSG_ID_TOPIC_A, BOT2.appId), {
      session: { sessionId: 'uuid-2', rootMessageId: MSG_ID_TOPIC_A },
      imBotId: BOT2.appId,
      pendingRepo: true,
      pendingPrompt: 'test',
      worker: null,
    });

    const deps = {
      activeSessions,
      sessionReply: vi.fn().mockResolvedValue('msg-id'),
      lastRepoScan: new Map(),
    };

    // Card action with Bot2's user open_id, passing Bot2's larkAppId
    const cardData = makeCardAction('skip_repo', MSG_ID_TOPIC_A, BOT2.userOpenId);
    await handleCardAction(cardData, deps, BOT2.appId);

    // Should NOT be blocked — Bot2's userOpenId is in Bot2's allowedUsers
    const ds = activeSessions.get(sessionKey(MSG_ID_TOPIC_A, BOT2.appId));
    expect(ds.pendingRepo, 'skip_repo should have been processed').toBe(false);
  });

  it('card action without larkAppId cannot find session (composite key)', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { handleCardAction } = await import('../src/im/lark/card-handler.js');
    const { sessionKey } = await import('../src/core/types.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    // Session owned by Bot1 — stored with composite key
    const activeSessions = new Map<string, any>();
    activeSessions.set(sessionKey(MSG_ID_TOPIC_A, BOT1.appId), {
      session: { sessionId: 'uuid-1', rootMessageId: MSG_ID_TOPIC_A },
      imBotId: BOT1.appId,
      pendingRepo: true,
      pendingPrompt: 'test',
      worker: null,
    });

    const deps = {
      activeSessions,
      sessionReply: vi.fn().mockResolvedValue('msg-id'),
      lastRepoScan: new Map(),
    };

    const cardData = makeCardAction('skip_repo', MSG_ID_TOPIC_A, BOT1.userOpenId);

    // Without larkAppId: cannot find session (composite key lookup fails), action is no-op
    await handleCardAction(cardData, deps);
    const ds1 = activeSessions.get(sessionKey(MSG_ID_TOPIC_A, BOT1.appId));
    expect(ds1.pendingRepo, 'should remain pending — no session found without larkAppId').toBe(true);

    // With correct larkAppId (Bot1): finds session via composite key, processes action
    await handleCardAction(cardData, deps, BOT1.appId);
    const ds2 = activeSessions.get(sessionKey(MSG_ID_TOPIC_A, BOT1.appId));
    expect(ds2.pendingRepo, 'should be processed with correct larkAppId').toBe(false);
  });
});

describe('Multi-bot handleNewTopic guard', () => {
  beforeEach(() => { vi.resetModules(); });

  it('second bot should not overwrite first bot session for same rootId', async () => {
    // This tests the fix: handleNewTopic checks activeSessions before creating
    const { registerBot } = await import('../src/bot-registry.js');
    const { setBotOpenId, checkGroupMessageAccess } = await import('../src/im/lark/event-dispatcher.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: bot.secret, cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    const client = await import('../src/im/lark/client.js');
    vi.spyOn(client, 'getChatInfo').mockResolvedValue({ name: 'test', userCount: 4 });

    // Simulate: user @mentions Bot1 in Topic A
    const event = makeLarkEvent(MSG_ID_TOPIC_A, BOT1.openId, BOT1.userOpenId);

    // Bot1: mentioned → allowed
    const r1 = await checkGroupMessageAccess(BOT1.appId, event.message, CHAT_ID, BOT1.userOpenId);
    expect(r1).toBe('allowed');

    // Bot2: not mentioned → ignore (should NOT create session)
    const r2 = await checkGroupMessageAccess(BOT2.appId, event.message, CHAT_ID, BOT2.userOpenId);
    expect(r2).toBe('ignore');

    // Bot3: not mentioned → ignore
    const r3 = await checkGroupMessageAccess(BOT3.appId, event.message, CHAT_ID, BOT3.userOpenId);
    expect(r3).toBe('ignore');

    // Only Bot1 should proceed to create a session
    // The @mention check is the PRIMARY guard against session collision
  });

  it('different topics can be handled by different bots without collision', async () => {
    const activeSessions = new Map<string, { imBotId: string }>();

    // Bot1 handles Topic A
    activeSessions.set(MSG_ID_TOPIC_A, { imBotId: BOT1.appId });

    // Bot2 handles Topic B (different rootId — no collision)
    activeSessions.set(MSG_ID_TOPIC_B, { imBotId: BOT2.appId });

    expect(activeSessions.get(MSG_ID_TOPIC_A)!.imBotId).toBe(BOT1.appId);
    expect(activeSessions.get(MSG_ID_TOPIC_B)!.imBotId).toBe(BOT2.appId);
    expect(activeSessions.size).toBe(2);
  });
});
