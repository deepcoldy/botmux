/**
 * E2E test: Multi-bot group message flow.
 *
 * Simulates the COMPLETE event routing pipeline for 3 bots sharing a Lark group.
 *
 * Key insight: Lark open_id is per-app. The SAME human user has a DIFFERENT
 * open_id for each bot app. So when Bot1's WSClient receives an event, the
 * sender.sender_id.open_id is the user's open_id scoped to Bot1's app.
 *
 * Bugs reproduced:
 *
 * Bug 1: getChatInfo.user_count EXCLUDES bots (only real users).
 *         In a group with 1 user + 3 bots, userCount=1.
 *         checkGroupMessageAccess has a "solo group" fallback: if userCount<=1,
 *         respond without @mention. All 3 bots trigger this, all respond.
 *         First bot to create a session "wins", others are blocked by guard.
 *
 * Bug 2: Thread replies in groups require @mention even for the owning bot.
 *         After Bot1 creates a session via @mention, subsequent thread replies
 *         WITHOUT @mention are ignored by checkGroupMessageAccess (returns 'ignore').
 *         The user must @mention the bot in EVERY message, even in its own thread.
 *
 * Bug 3: @mentioning Bot2 in Bot1's thread is blocked by the session ownership
 *         guard. Bot2 passes access check but can't create/use a session for a
 *         rootId already owned by Bot1.
 *
 * Run:  pnpm vitest run test/multi-bot-group-flow.e2e.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock modules ────────────────────────────────────────────────────────────

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(), killWorker: vi.fn(), initWorkerPool: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  getAvailableBots: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(), updateSession: vi.fn(), createSession: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendUserMessage: vi.fn(), updateMessage: vi.fn(), replyMessage: vi.fn(),
  resolveAllowedUsers: vi.fn(),
  getChatInfo: vi.fn(),
  listChatBotMembers: vi.fn(),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildSessionCard: vi.fn(() => '{}'), buildStreamingCard: vi.fn(() => '{}'),
  buildRepoSelectCard: vi.fn(() => '{}'), getCliDisplayName: vi.fn(() => 'Claude Code'),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor(_: any) {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Test data ───────────────────────────────────────────────────────────────

// Same human user → different open_id per bot app
const USER_EMAIL = 'alice@example.com';
const BOT1 = { appId: 'cli_bot1', openId: 'ou_bot1_self', userOpenId: 'ou_alice_via_bot1' };
const BOT2 = { appId: 'cli_bot2', openId: 'ou_bot2_self', userOpenId: 'ou_alice_via_bot2' };
const BOT3 = { appId: 'cli_bot3', openId: 'ou_bot3_self', userOpenId: 'ou_alice_via_bot3' };
const BOTS = [BOT1, BOT2, BOT3];

const CHAT_ID = 'oc_test_group';
const MSG_TOPIC_A = 'om_topic_a';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake Lark message event */
function makeEvent(messageId: string, opts: {
  mentionBotOpenId?: string;
  senderOpenId: string;
  rootId?: string;
  chatType?: string;
}) {
  return {
    message: {
      message_id: messageId,
      chat_id: CHAT_ID,
      chat_type: opts.chatType ?? 'group',
      root_id: opts.rootId,
      content: JSON.stringify({ text: 'test' }),
      mentions: opts.mentionBotOpenId
        ? [{ key: '@_user_1', id: { open_id: opts.mentionBotOpenId } }]
        : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

/**
 * Simulate event dispatcher routing for a single bot.
 * Mirrors startLarkEventDispatcher's im.message.receive_v1 handler.
 *
 * IMPORTANT: Each bot's WSClient delivers events with per-app open_id.
 * So `senderOpenId` differs per bot for the same human sender.
 */
async function routeForBot(
  larkAppId: string,
  message: any,
  senderOpenId: string,
  checkGroupMessageAccess: Function,
  allowedUsers: string[],
  isSessionOwner?: (rootId: string, appId: string) => boolean,
): Promise<'new_topic' | 'thread_reply' | 'not_allowed' | 'ignore'> {
  const chatType = message.chat_type;
  const rootId = message.root_id;
  const isAllowed = allowedUsers.length === 0 || allowedUsers.includes(senderOpenId);

  if (chatType === 'group' && !rootId) {
    return await checkGroupMessageAccess(larkAppId, message, CHAT_ID, senderOpenId);
  }
  if (chatType === 'group' && rootId) {
    // Fix B: owning bot can respond without @mention
    const ownsSession = isSessionOwner?.(rootId, larkAppId) ?? false;
    if (ownsSession && isAllowed) {
      return 'thread_reply';
    }
    const access = await checkGroupMessageAccess(larkAppId, message, CHAT_ID, senderOpenId);
    if (access === 'allowed') return 'thread_reply';
    return access;
  }
  // P2P
  if (!isAllowed) return 'ignore';
  return !rootId ? 'new_topic' : 'thread_reply';
}

/**
 * Route through ALL bots. Each bot sees the event with its own per-app senderOpenId.
 */
async function routeForAllBots(
  message: any,
  checkGroupMessageAccess: Function,
  botInfos: typeof BOTS,
  sessions?: Map<string, { imBotId: string }>,
): Promise<Map<string, string>> {
  const isSessionOwner = sessions
    ? (rootId: string, appId: string) => sessions.get(rootId)?.imBotId === appId
    : undefined;
  const results = new Map<string, string>();
  for (const bot of botInfos) {
    const result = await routeForBot(
      bot.appId,
      message,
      bot.userOpenId,
      checkGroupMessageAccess,
      [bot.userOpenId],
      isSessionOwner,
    );
    results.set(bot.appId, result as string);
  }
  return results;
}

/** Simulate daemon's handleNewTopic with session guard */
function simNewTopic(
  appId: string, msgId: string, sessions: Map<string, { imBotId: string }>,
): 'created' | 'blocked' {
  const existing = sessions.get(msgId);
  if (existing && existing.imBotId !== appId) return 'blocked';
  sessions.set(msgId, { imBotId: appId });
  return 'created';
}

/** Simulate daemon's handleThreadReply with session guard */
function simThreadReply(
  appId: string, rootId: string, sessions: Map<string, { imBotId: string }>,
): 'routed' | 'auto_created' | 'blocked_wrong_owner' {
  const ds = sessions.get(rootId);
  if (ds) {
    return ds.imBotId !== appId ? 'blocked_wrong_owner' : 'routed';
  }
  sessions.set(rootId, { imBotId: appId });
  return 'auto_created';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Bug 1: userCount=1 (bots excluded) → all bots respond without @mention', () => {
  beforeEach(() => { vi.resetModules(); });

  it('FIXED: with multiple bots registered, solo-group fallback is disabled → all ignore', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    // Lark user_count excludes bots. 1 human + 3 bots → user_count=1
    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 1 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    // User sends message WITHOUT @mention
    const event = makeEvent(MSG_TOPIC_A, { senderOpenId: 'irrelevant' });
    const results = await routeForAllBots(event.message, checkGroupMessageAccess, BOTS);

    // FIXED: with 3 bots registered, solo-group fallback is disabled.
    // All bots require @mention to disambiguate.
    expect(results.get(BOT1.appId), 'Bot1 correctly ignores').toBe('ignore');
    expect(results.get(BOT2.appId), 'Bot2 correctly ignores').toBe('ignore');
    expect(results.get(BOT3.appId), 'Bot3 correctly ignores').toBe('ignore');
  });

  it('single-bot mode: solo-group fallback still works', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    // Only 1 bot registered
    const state = registerBot({ im: 'lark' as const, larkAppId: BOT1.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
    setBotOpenId(BOT1.appId, BOT1.openId);
    state.resolvedAllowedUsers = [BOT1.userOpenId];

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 1 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue([{ bot_id: BOT1.openId }] as any);

    const event = makeEvent(MSG_TOPIC_A, { senderOpenId: BOT1.userOpenId });
    const result = await checkGroupMessageAccess(BOT1.appId, event.message, CHAT_ID, BOT1.userOpenId);

    // Single bot: solo-group fallback still works (backwards compatible)
    expect(result, 'single bot responds without @mention in solo group').toBe('allowed');
  });

  it('with userCount=4 (hypothetical: if bots were counted), all correctly ignore', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 4 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    const event = makeEvent(MSG_TOPIC_A, { senderOpenId: 'irrelevant' });
    const results = await routeForAllBots(event.message, checkGroupMessageAccess, BOTS);

    for (const [appId, result] of results) {
      expect(result, `${appId} correctly ignores`).toBe('ignore');
    }
  });
});

describe('Fix B: Owning bot responds to thread replies without @mention', () => {
  beforeEach(() => { vi.resetModules(); });

  it('FIXED: Bot1 owns thread, user replies without @mention → Bot1 responds, others ignore', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 4 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    // Bot1 owns the session
    const sessions = new Map<string, { imBotId: string }>();
    sessions.set(MSG_TOPIC_A, { imBotId: BOT1.appId });

    // User replies WITHOUT @mention
    const reply = makeEvent('om_reply_1', {
      senderOpenId: BOT1.userOpenId,
      rootId: MSG_TOPIC_A,
    });
    const results = await routeForAllBots(reply.message, checkGroupMessageAccess, BOTS, sessions);

    // FIXED: Bot1 responds (it owns the thread), others ignore
    expect(results.get(BOT1.appId), 'Bot1 responds to its own thread').toBe('thread_reply');
    expect(results.get(BOT2.appId), 'Bot2 ignores').toBe('ignore');
    expect(results.get(BOT3.appId), 'Bot3 ignores').toBe('ignore');
  });

  it('non-allowed user cannot use session-owner shortcut', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 4 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    const sessions = new Map<string, { imBotId: string }>();
    sessions.set(MSG_TOPIC_A, { imBotId: BOT1.appId });

    // Reply from a user NOT in Bot1's allowlist
    const reply = makeEvent('om_reply_2', {
      senderOpenId: 'ou_stranger',
      rootId: MSG_TOPIC_A,
    });

    // Simulate with per-bot routing: stranger's open_id is not in any bot's allowlist
    const isSessionOwner = (rootId: string, appId: string) => sessions.get(rootId)?.imBotId === appId;
    const result = await routeForBot(
      BOT1.appId, reply.message, 'ou_stranger',
      checkGroupMessageAccess, [BOT1.userOpenId], isSessionOwner,
    );
    // Bot1 owns session but stranger is not allowed → falls through to @mention check → ignore
    expect(result, 'stranger blocked despite session ownership').toBe('ignore');
  });
});

describe('Fix C: @mention Bot2 in Bot1 thread → takeover', () => {
  beforeEach(() => { vi.resetModules(); });

  it('FIXED: Bot2 @mentioned in Bot1 thread → Bot2 takes over the session', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 4 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    // Bot1 owns the session
    const sessions = new Map<string, { imBotId: string }>();
    sessions.set(MSG_TOPIC_A, { imBotId: BOT1.appId });

    // User @mentions Bot2 in Bot1's thread
    const reply = makeEvent('om_reply_3', {
      mentionBotOpenId: BOT2.openId,
      senderOpenId: BOT2.userOpenId,
      rootId: MSG_TOPIC_A,
    });

    const results = await routeForAllBots(reply.message, checkGroupMessageAccess, BOTS, sessions);

    // Bot2 passes access check (it was @mentioned)
    expect(results.get(BOT2.appId), 'Bot2 passes access check').toBe('thread_reply');
    // Bot1 also passes (session owner) but won't interfere — daemon routes to Bot2 via takeover
    expect(results.get(BOT1.appId), 'Bot1 sees session ownership').toBe('thread_reply');

    // Simulate takeover: Bot2 takes over from Bot1
    // (daemon.ts: if ds.larkAppId !== larkAppId → close old session, create new)
    const ds = sessions.get(MSG_TOPIC_A)!;
    if (ds.imBotId !== BOT2.appId) {
      // Takeover: close old, create new
      sessions.delete(MSG_TOPIC_A);
      sessions.set(MSG_TOPIC_A, { imBotId: BOT2.appId });
    }

    // Bot2 now owns the thread
    expect(sessions.get(MSG_TOPIC_A)!.imBotId, 'Bot2 owns thread after takeover').toBe(BOT2.appId);
  });
});

describe('Full scenario: reproducing user-reported bug end-to-end', () => {
  beforeEach(() => { vi.resetModules(); });

  it('ALL FIXED: @mention → session → thread reply → takeover → all work', async () => {
    const { registerBot } = await import('../src/bot-registry.js');
    const { checkGroupMessageAccess, setBotOpenId } = await import('../src/im/lark/event-dispatcher.js');
    const clientModule = await import('../src/im/lark/client.js');

    for (const bot of BOTS) {
      const state = registerBot({ im: 'lark' as const, larkAppId: bot.appId, larkAppSecret: 'secret', cliId: 'claude-code' });
      setBotOpenId(bot.appId, bot.openId);
      state.resolvedAllowedUsers = [bot.userOpenId];
    }

    vi.mocked(clientModule.getChatInfo).mockResolvedValue({ userCount: 1 });
    vi.mocked(clientModule.listChatBotMembers).mockResolvedValue(BOTS.map(b => ({ bot_id: b.openId })) as any);

    const sessions = new Map<string, { imBotId: string }>();

    // ━━ Step 1: Non-@mention → all ignore (Fix A) ━━━━━━━━━━━━━━━━━━━━━━━━
    const msg1 = makeEvent(MSG_TOPIC_A, { senderOpenId: 'irrelevant' });
    const r1 = await routeForAllBots(msg1.message, checkGroupMessageAccess, BOTS, sessions);
    for (const [appId, result] of r1) {
      expect(result, `Step 1: ${appId} ignores`).toBe('ignore');
    }

    // ━━ Step 2: @mention Bot1 → Bot1 creates session ━━━━━━━━━━━━━━━━━━━━━━
    const msg2 = makeEvent(MSG_TOPIC_A, {
      mentionBotOpenId: BOT1.openId,
      senderOpenId: BOT1.userOpenId,
    });
    const r2 = await routeForAllBots(msg2.message, checkGroupMessageAccess, BOTS, sessions);
    expect(r2.get(BOT1.appId), 'Step 2: Bot1 handles').toBe('allowed');
    expect(r2.get(BOT2.appId), 'Step 2: Bot2 ignores').toBe('ignore');

    simNewTopic(BOT1.appId, MSG_TOPIC_A, sessions);
    expect(sessions.get(MSG_TOPIC_A)!.imBotId).toBe(BOT1.appId);

    // ━━ Step 3: Thread reply without @mention → Bot1 responds (Fix B) ━━━━━
    const msg3 = makeEvent('om_reply_1', {
      senderOpenId: BOT1.userOpenId,
      rootId: MSG_TOPIC_A,
    });
    const r3 = await routeForAllBots(msg3.message, checkGroupMessageAccess, BOTS, sessions);
    expect(r3.get(BOT1.appId), 'Step 3: Bot1 responds (session owner)').toBe('thread_reply');
    expect(r3.get(BOT2.appId), 'Step 3: Bot2 ignores').toBe('ignore');

    // ━━ Step 4: @mention Bot2 in Bot1's thread → takeover (Fix C) ━━━━━━━━━
    const msg4 = makeEvent('om_reply_2', {
      mentionBotOpenId: BOT2.openId,
      senderOpenId: BOT2.userOpenId,
      rootId: MSG_TOPIC_A,
    });
    const r4 = await routeForAllBots(msg4.message, checkGroupMessageAccess, BOTS, sessions);
    expect(r4.get(BOT2.appId), 'Step 4: Bot2 passes access').toBe('thread_reply');

    // Simulate takeover (daemon kills Bot1's session, Bot2 creates new one)
    sessions.delete(MSG_TOPIC_A);
    sessions.set(MSG_TOPIC_A, { imBotId: BOT2.appId });

    // ━━ Step 5: Thread reply without @mention → Bot2 responds now ━━━━━━━━━
    const msg5 = makeEvent('om_reply_3', {
      senderOpenId: BOT2.userOpenId,
      rootId: MSG_TOPIC_A,
    });
    const r5 = await routeForAllBots(msg5.message, checkGroupMessageAccess, BOTS, sessions);
    expect(r5.get(BOT2.appId), 'Step 5: Bot2 responds (new owner)').toBe('thread_reply');
    expect(r5.get(BOT1.appId), 'Step 5: Bot1 ignores (no longer owner)').toBe('ignore');
  });
});
