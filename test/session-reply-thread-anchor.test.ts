/**
 * Integration guard for the chat-scope send chokepoint (daemon.ts sessionReply).
 *
 * Regression: in `shared` (chat-scope) mode the repo-selection card and other
 * daemon-side sends that carry NO turnId leaked to the chat top level instead of
 * threading into the shared fold-back topic — sessionReply resolved the reply
 * target with the raw turnId rather than fallbackTurnId(ds, turnId), so the
 * turnId gate never matched (daemon.ts:2491 et al. pass no turnId).
 *
 * resolveSessionReplyTarget's composition with fallbackTurnId was already unit
 * tested (reply-target-fallback.test.ts), but NOTHING asserted that the real
 * send function WIRES it — which is exactly the gap that let e619250d fix some
 * sites and miss the repo-card ones. This drives the real sessionReply against a
 * seeded session so a revert (or a new unguarded send site) re-opens a failing
 * test, not a silent top-level leak.
 *
 * Run:  pnpm vitest run test/session-reply-thread-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  replyMessage: vi.fn(async () => 'om_reply'),
  sendMessage: vi.fn(async () => 'om_top'),
  getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, replyMessage: mocks.replyMessage, sendMessage: mocks.sendMessage, getChatMode: mocks.getChatMode };
});

import { registerBot } from '../src/bot-registry.js';
import { activeSessionKey, sessionKey } from '../src/core/types.js';
import { __testOnly_sessionReply as sessionReply, __testOnly_activeSessions as activeSessions } from '../src/daemon.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'session_reply_anchor_app';
const CHAT = 'oc_shared_chat';
const NOW = new Date().toISOString();

type Target = { rootMessageId: string; turnId: string; updatedAt: string };

function seedSharedSession(currentReplyTarget?: Target): DaemonSession {
  const ds = {
    scope: 'chat',
    chatId: CHAT,
    larkAppId: APP,
    session: {
      sessionId: 'sess-anchor-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 't',
      status: 'active',
      createdAt: NOW,
      currentReplyTarget,
    },
    currentReplyTarget,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(CHAT, APP), ds);
  return ds;
}

function seedReceiverSession(): DaemonSession {
  const ds = {
    scope: 'chat',
    chatId: CHAT,
    larkAppId: APP,
    session: {
      sessionId: 'sess-receiver-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'meeting receiver',
      status: 'active',
      createdAt: NOW,
      vcMeetingReceiver: {
        listenerAppId: 'listener-app',
        meetingId: 'meeting-1',
        memberId: 'member-1',
        memberEpoch: 1,
      },
    },
  } as unknown as DaemonSession;
  activeSessions.set(activeSessionKey(ds), ds);
  return ds;
}

describe('sessionReply chat-scope chokepoint — shared fold-back anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    activeSessions.clear();
    registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_o'] });
  });

  it('repo-card-style send (interactive, NO turnId) threads into the shared topic, not top-level', async () => {
    seedSharedSession({ rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW });
    // Mirrors daemon.ts:2491 — a card sent with no 5th turnId arg.
    await sessionReply(CHAT, '{"card":true}', 'interactive', APP);
    expect(mocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage).toHaveBeenCalledWith(APP, 'om_topic', '{"card":true}', 'interactive', true, undefined, expect.anything());
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('explicit STALE turnId still routes top-level — the fallback must not weaken the cross-turn hijack guard', async () => {
    seedSharedSession({ rootMessageId: 'om_topic', turnId: 'turn-1', updatedAt: NOW });
    await sessionReply(CHAT, 'late', 'text', APP, 'turn-2');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage).not.toHaveBeenCalled();
  });

  it('plain chat session (no fold-back anchor) keeps replying flat to the chat top-level', async () => {
    seedSharedSession(undefined);
    await sessionReply(CHAT, 'hello', 'text', APP);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.replyMessage).not.toHaveBeenCalled();
  });

  it('routes a dedicated receiver by exact source session when an ordinary session shares its chat', async () => {
    const ordinary = seedSharedSession({ rootMessageId: 'om_ordinary_topic', turnId: 'turn-ordinary', updatedAt: NOW });
    const receiver = seedReceiverSession();

    await sessionReply(CHAT, 'receiver output', 'text', APP, 'turn-receiver', {
      sourceSessionId: receiver.session.sessionId,
      uuid: 'vcd_delivery_stable',
      suppressHook: true,
    });

    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      APP,
      CHAT,
      'receiver output',
      'text',
      'vcd_delivery_stable',
      {
        sessionId: receiver.session.sessionId,
        scope: receiver.scope,
        anchor: CHAT,
      },
      { suppressHook: true },
    );
    expect(receiver.session.sessionId).not.toBe(ordinary.session.sessionId);
  });

  it('keeps receiver hook attribution when no ordinary chat session exists', async () => {
    const receiver = seedReceiverSession();

    await sessionReply(CHAT, 'receiver only', 'text', APP, undefined, {
      sourceSessionId: receiver.session.sessionId,
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      APP,
      CHAT,
      'receiver only',
      'text',
      undefined,
      {
        sessionId: receiver.session.sessionId,
        scope: receiver.scope,
        anchor: CHAT,
      },
      { suppressHook: true },
    );
  });

  it('fails closed when a receiver source session is stale instead of using the ordinary chat slot', async () => {
    seedSharedSession({ rootMessageId: 'om_ordinary_topic', turnId: 'turn-ordinary', updatedAt: NOW });

    await expect(sessionReply(CHAT, 'stale receiver output', 'text', APP, undefined, {
      sourceSessionId: 'sess-closed-receiver',
    })).rejects.toThrow(/source session identity/i);

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.replyMessage).not.toHaveBeenCalled();
  });

  it('quotes the exact explicit VC IM turn with its stable UUID and keeps that UUID on withdrawn fallback', async () => {
    seedSharedSession({ rootMessageId: 'om_topic_b', turnId: 'turn-b', updatedAt: NOW });
    await sessionReply(CHAT, '{"card":"A"}', 'interactive', APP, 'turn-a', {
      quoteMessageId: 'om_human_a',
      uuid: 'vcp_reply_a',
    });
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      APP, 'om_human_a', '{"card":"A"}', 'interactive', false, 'vcp_reply_a', expect.anything(),
    );

    mocks.replyMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_human_a'));
    await sessionReply(CHAT, '{"card":"A"}', 'interactive', APP, 'turn-a', {
      quoteMessageId: 'om_human_a',
      uuid: 'vcp_reply_a',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      APP, CHAT, '{"card":"A"}', 'interactive', 'vcp_reply_a', expect.anything(),
    );
  });

  it('revalidates authority after a withdrawn quote before the plain fallback', async () => {
    seedSharedSession({ rootMessageId: 'om_topic_b', turnId: 'turn-b', updatedAt: NOW });
    mocks.replyMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_human_a'));
    const beforeQuoteFallback = vi.fn(async () => {
      throw new Error('member removed while quote request was in flight');
    });

    await expect(sessionReply(CHAT, '{"card":"A"}', 'interactive', APP, 'turn-a', {
      quoteMessageId: 'om_human_a',
      uuid: 'vcp_reply_a',
      beforeQuoteFallback,
    })).rejects.toThrow('member removed while quote request was in flight');

    expect(beforeQuoteFallback).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
