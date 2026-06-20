/**
 * Unit tests for deliverWriteLinkCard (worker-pool.ts) — how the write-enabled
 * session card ("DM 卡") reaches the operator who clicked 「获取操作链接」.
 *
 * Behaviour under test (方案 A): prefer an in-chat "visible-to-you" ephemeral
 * card, but Feishu's ephemeral API only works in plain `group` chats (topic /
 * thread groups reject with 18053, p2p unsupported). chatType can't tell a topic
 * group from a regular one, so we attempt ephemeral for any non-p2p chat and
 * fall back to a private DM on failure. p2p skips straight to the DM. Both
 * channels are private — the fallback never leaks the write token.
 *
 * Run:  pnpm vitest run test/write-link-delivery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const { sendEphemeralCardMock, sendUserMessageMock, botState } = vi.hoisted(() => ({
  sendEphemeralCardMock: vi.fn(),
  sendUserMessageMock: vi.fn(),
  // Mutable so a test can populate the owner audience (resolvePrivateCardAudience
  // keeps only `ou_`-prefixed allowedUsers).
  botState: { owners: [] as string[] },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: botState.owners, config: { cliId: 'claude-code' } })),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: sendEphemeralCardMock,
  sendUserMessage: sendUserMessageMock,
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

import { deliverWriteLinkCard, deliverWriteLinkCardToOwners, deliverWritableTerminalCardTo } from '../src/core/worker-pool.js';

const OP = 'ou_operator';
const CARD = '{"card":"json"}';

const ds = (over: Partial<DaemonSession> = {}) => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  session: { sessionId: 'sess1234abcd' },
  ...over,
} as unknown as DaemonSession);

// A session whose terminal is live (workerPort+workerToken set), used by the
// owner-fanout tests so deliverWriteLinkCardToOwners gets past the readiness gate
// and actually builds + delivers the card.
const liveDs = (over: Partial<DaemonSession> = {}) => ds({
  scope: 'thread',
  workerPort: 41000,
  workerToken: 'wtok-xyz',
  session: { sessionId: 'sess1234abcd', rootMessageId: 'om_root', title: 'demo', cliId: 'claude-code' },
  ...over,
} as Partial<DaemonSession>);

beforeEach(() => {
  vi.clearAllMocks();
  botState.owners = [];
  sendEphemeralCardMock.mockResolvedValue('eph_msg_id');
  sendUserMessageMock.mockResolvedValue('dm_msg_id');
});

describe('deliverWriteLinkCard', () => {
  it('sends an ephemeral card in a plain group and does NOT DM', async () => {
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('ephemeral');
    expect(sendEphemeralCardMock).toHaveBeenCalledWith('app', 'oc_here', OP, CARD);
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to a private DM when the ephemeral API rejects (e.g. topic group 18053)', async () => {
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('chat can not be thread (code: 18053)'));
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('dm');
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(1);
    expect(sendUserMessageMock).toHaveBeenCalledWith('app', OP, CARD, 'interactive');
  });

  it('skips ephemeral entirely for p2p chats and DMs directly', async () => {
    const r = await deliverWriteLinkCard(ds({ chatType: 'p2p' }), OP, CARD);
    expect(r).toBe('dm');
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(sendUserMessageMock).toHaveBeenCalledWith('app', OP, CARD, 'interactive');
  });

  it('returns "failed" when both the ephemeral attempt and the DM fallback error', async () => {
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('18053'));
    sendUserMessageMock.mockRejectedValueOnce(new Error('bot not in chat'));
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('failed');
  });
});

describe('deliverWriteLinkCardToOwners (botmux term-link backend)', () => {
  it('refuses when the terminal is not ready (no worker token) — never builds a card', async () => {
    botState.owners = ['ou_owner1'];
    const r = await deliverWriteLinkCardToOwners(liveDs({ workerToken: null }));
    expect(r).toEqual({ ok: false, error: 'terminal_unavailable', delivered: 0, total: 0, channels: [] });
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('refuses when the bot has no owner audience (fully-open / no allowedUsers)', async () => {
    botState.owners = []; // no ou_-prefixed owners
    const r = await deliverWriteLinkCardToOwners(liveDs());
    expect(r).toEqual({ ok: false, error: 'no_owner', delivered: 0, total: 0, channels: [] });
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
  });

  it('keeps only ou_-prefixed owners, fans out one private card each', async () => {
    botState.owners = ['ou_a', 'ou_b', 'on_union_not_ou']; // last one filtered out
    const r = await deliverWriteLinkCardToOwners(liveDs({ chatType: 'group' }));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ delivered: 2, total: 2, channels: ['ephemeral', 'ephemeral'] });
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(2);
    // The card delivered is the write-enabled session card the daemon built
    // (not echoed to the caller) — it must carry the write token URL.
    const cardArg = sendEphemeralCardMock.mock.calls[0][3] as string;
    expect(cardArg).toContain('token=wtok-xyz');
  });

  it('reports partial success — counts only the owners actually reached', async () => {
    botState.owners = ['ou_a', 'ou_b'];
    // First owner: ephemeral fails then DM fails → 'failed'. Second: ephemeral ok.
    sendEphemeralCardMock
      .mockRejectedValueOnce(new Error('18053'))
      .mockResolvedValueOnce('eph_ok');
    sendUserMessageMock.mockRejectedValueOnce(new Error('bot not in chat'));
    const r = await deliverWriteLinkCardToOwners(liveDs({ chatType: 'group' }));
    expect(r.ok).toBe(true); // at least one delivered
    expect(r.delivered).toBe(1);
    expect(r.total).toBe(2);
    expect(r.channels).toEqual(['failed', 'ephemeral']);
  });

  it('returns delivery_failed when every owner channel errors', async () => {
    botState.owners = ['ou_a'];
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('18053'));
    sendUserMessageMock.mockRejectedValueOnce(new Error('bot not in chat'));
    const r = await deliverWriteLinkCardToOwners(liveDs({ chatType: 'group' }));
    expect(r).toMatchObject({ ok: false, error: 'delivery_failed', delivered: 0, total: 1 });
  });
});

describe('deliverWritableTerminalCardTo (/term slash command backend)', () => {
  it('returns not_ready (and never sends) when the terminal has no token', async () => {
    const r = await deliverWritableTerminalCardTo(liveDs({ workerToken: null }), 'ou_owner');
    expect(r).toBe('not_ready');
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('delivers a token-bearing card to the single operator (ephemeral in a plain group)', async () => {
    const r = await deliverWritableTerminalCardTo(liveDs({ chatType: 'group' }), 'ou_owner');
    expect(r).toBe('ephemeral');
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(1);
    const [, , who, card] = sendEphemeralCardMock.mock.calls[0];
    expect(who).toBe('ou_owner');
    expect(card).toContain('token=wtok-xyz');
    // does NOT fan out to an audience — exactly one recipient
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to DM in a p2p/topic chat', async () => {
    const r = await deliverWritableTerminalCardTo(liveDs({ chatType: 'p2p' }), 'ou_owner');
    expect(r).toBe('dm');
    expect(sendUserMessageMock).toHaveBeenCalledWith('app', 'ou_owner', expect.stringContaining('token=wtok-xyz'), 'interactive');
  });
});
