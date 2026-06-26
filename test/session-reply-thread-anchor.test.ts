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
import { sessionKey } from '../src/core/types.js';
import { __testOnly_sessionReply as sessionReply, __testOnly_activeSessions as activeSessions } from '../src/daemon.js';
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
});
