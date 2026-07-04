/**
 * Unit tests for deliverEphemeralOrReply (worker-pool.ts) — how restart /
 * session-closed / resume status confirmations reach the operator.
 *
 * Regression guard (本次修复): the ephemeral API (`ephemeral/v1/send`) takes a
 * `chat_id` only and has no thread/root anchoring. So an ephemeral confirmation
 * for a **thread-scope** session (a 话题 inside a 普通群) escapes the topic and
 * lands at the group top-level. The fix gates ephemeral to flat **chat-scope**
 * sessions only; thread-scope sessions take the visible `reply()` path, which
 * routes back into the thread via `reply_in_thread`.
 *
 * Run:  pnpm vitest run test/ephemeral-or-reply.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const { sendEphemeralCardMock } = vi.hoisted(() => ({
  sendEphemeralCardMock: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: sendEphemeralCardMock,
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { deliverEphemeralOrReply } from '../src/core/worker-pool.js';

const OP = 'ou_operator';

const ds = (over: Partial<DaemonSession> = {}) => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  scope: 'chat',
  session: { sessionId: 'sess1234abcd', rootMessageId: 'om_root' },
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  vi.clearAllMocks();
  sendEphemeralCardMock.mockResolvedValue('eph_msg_id');
});

describe('deliverEphemeralOrReply', () => {
  it('uses an ephemeral card (not the visible reply) for a flat chat-scope 普通群 session', async () => {
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ scope: 'chat' }), OP, 'restarted', 'text', reply);
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(1);
    expect(sendEphemeralCardMock.mock.calls[0][0]).toBe('app');
    expect(sendEphemeralCardMock.mock.calls[0][1]).toBe('oc_here');
    expect(sendEphemeralCardMock.mock.calls[0][2]).toBe(OP);
    expect(reply).not.toHaveBeenCalled();
  });

  it('wraps a plain text confirmation into a markdown card before sending ephemeral', async () => {
    await deliverEphemeralOrReply(ds({ scope: 'chat' }), OP, 'restarted', 'text', vi.fn());
    const cardJson = sendEphemeralCardMock.mock.calls[0][3];
    const card = JSON.parse(cardJson);
    expect(card.elements[0]).toMatchObject({ tag: 'markdown', content: 'restarted' });
  });

  it('passes an interactive card JSON through verbatim (no re-wrapping)', async () => {
    const CARD = '{"card":"closed"}';
    await deliverEphemeralOrReply(ds({ scope: 'chat' }), OP, CARD, 'interactive', vi.fn());
    expect(sendEphemeralCardMock.mock.calls[0][3]).toBe(CARD);
  });

  it('REGRESSION: keeps the card in the thread for a thread-scope session — never ephemeral', async () => {
    // A 话题 inside a 普通群: scope='thread'. Ephemeral has no thread anchor, so it
    // must NOT be attempted — the card has to stay in the topic via reply().
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ scope: 'thread' }), OP, 'restarted', 'text', reply);
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: thread-scope close card stays in-thread too (interactive)', async () => {
    const CARD = '{"card":"closed"}';
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ scope: 'thread' }), OP, CARD, 'interactive', reply);
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('replies visibly (no ephemeral) for p2p chats', async () => {
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ chatType: 'p2p', scope: 'chat' }), OP, 'restarted', 'text', reply);
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('replies visibly when there is no operator open_id', async () => {
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ scope: 'chat' }), undefined, 'restarted', 'text', reply);
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('falls back to the visible reply when a chat-scope ephemeral send fails (e.g. 18053)', async () => {
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('chat can not be thread (code: 18053)'));
    const reply = vi.fn().mockResolvedValue('reply_id');
    await deliverEphemeralOrReply(ds({ scope: 'chat' }), OP, 'restarted', 'text', reply);
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
