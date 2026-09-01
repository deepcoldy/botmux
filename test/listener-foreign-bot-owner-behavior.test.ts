/**
 * Behavioral route-level guard for upstream PR #723 review blocker P1-2.
 *
 * The reviewer asked for a test that ACTUALLY reaches session creation and
 * verifies the owner is never set to a bot (the source-level guard in
 * test/listener-foreign-bot-owner.test.ts pins the invariant on daemon.ts
 * source text, but does not exercise the running route).
 *
 * This file drives the REAL handleNewTopic route with a bot-typed sender
 * (sender_type='app', as a third-party alert bot / message-listener match
 * arrives) and asserts on the persisted session record:
 *   - session.ownerOpenId / ownerUnionId are undefined (foreign-bot senders
 *     own nothing → daemon footers never --mention-back the alert bot, no
 *     self-poke loop, no owner-gated surface leak);
 *   - session.creatorOpenId keeps the raw bot sender (botmux report resolves);
 *   - session.quoteTargetSenderOpenId keeps the raw sender and
 *     quoteTargetSenderIsBot is true (first-turn quote still resolves, but is
 *     flagged as a bot).
 * Control: a human sender (sender_type='user') on the same route DOES become
 * the owner — so the suppression is scoped to bot senders only.
 *
 * Run:  pnpm vitest run test/listener-foreign-bot-owner-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-listener-owner-behavior-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const created: any[] = [];
  return {
    created,
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
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const s = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      created.push(s);
      return s;
    }),
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
} from '../src/daemon.js';

const APP = 'listener_owner_behavior_app';
const CHAT = 'oc_listener_owner_behavior_chat';
const OWNER = 'ou_human_owner';
const ALERT_BOT = 'ou_alert_bot_via_this_app';

function makeEventData(messageId: string, senderOpenId: string, senderType: 'user' | 'app'): any {
  return {
    sender: { sender_id: { open_id: senderOpenId, union_id: `on_${senderOpenId}` }, sender_type: senderType },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text: 'alert fired: disk 95%' }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'chat' as const,
    anchor,
    larkAppId: APP,
    // message-listener authorized path: bypasses the allowedUsers quota gate so
    // a third-party bot's card actually spawns a topic (that's the feature).
    messageListener: {
      name: 'Argos',
      prompt: 'analyze this alert',
      messageText: 'alert fired: disk 95%',
      msgType: 'text',
      senderType: 'bot',
      senderOpenId: ALERT_BOT,
    },
  };
}

describe('handleNewTopic — foreign-bot sender never owns the session (review P1-2, behavioral)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
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
      // Pin a real dir so the spawn path resolves a workingDir and reaches the
      // owner-assignment block (no repo-select card, forkWorker is mocked).
      workingDir: '/tmp',
      oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('bot sender: session created, but owner suppressed while creator/quoteTarget keep the raw sender', async () => {
    await handleNewTopic(
      makeEventData('om_alert_1', ALERT_BOT, 'app'),
      makeCtx('om_alert_1', 'om_alert_1'),
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const session = mocks.created[0];
    // The whole point: a bot must NOT be the owner.
    expect(session.ownerOpenId).toBeUndefined();
    expect(session.ownerUnionId).toBeUndefined();
    // …but the raw bot sender is retained for report + first-turn quote.
    expect(session.creatorOpenId).toBe(ALERT_BOT);
    expect(session.quoteTargetSenderOpenId).toBe(ALERT_BOT);
    expect(session.quoteTargetSenderIsBot).toBe(true);
    // Registered under the chat-scope anchor.
    expect(activeSessions.get(sessionKey('om_alert_1', APP))?.ownerOpenId).toBeUndefined();
  });

  it('control — human sender on the same route DOES become the owner', async () => {
    await handleNewTopic(
      makeEventData('om_human_1', OWNER, 'user'),
      // human path: no messageListener, normal allowedUsers gate applies.
      {
        chatId: CHAT,
        messageId: 'om_human_1',
        chatType: 'group' as const,
        scope: 'chat' as const,
        anchor: 'om_human_1',
        larkAppId: APP,
      },
    );

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const session = mocks.created[0];
    expect(session.ownerOpenId).toBe(OWNER);
    expect(session.creatorOpenId).toBe(OWNER);
    expect(session.quoteTargetSenderIsBot).toBe(false);
  });
});
