import { describe, expect, it } from 'vitest';
import { enrichHistorySenders } from '../src/dashboard/history-senders.js';

describe('dashboard history sender enrichment', () => {
  it('keeps different bots distinct and attaches their own avatar/app identity', () => {
    const messages = [
      { messageId: 'm1', senderId: 'ou_alice', senderType: 'user', msgType: 'text', content: 'go' },
      { messageId: 'm2', senderId: 'ou_bot_a_seen_here', senderType: 'app', msgType: 'text', content: 'A' },
      { messageId: 'm3', senderId: 'ou_bot_b_seen_here', senderType: 'bot', msgType: 'text', content: 'B' },
    ];
    const out = enrichHistorySenders(
      messages,
      new Map([['ou_alice', { name: 'Alice', avatarUrl: 'https://img/alice' }]]),
      [
        { openId: 'ou_bot_a_seen_here', displayName: 'Codex A', larkAppId: 'cli_a' },
        { openId: 'ou_bot_b_seen_here', displayName: 'Claude B', larkAppId: 'cli_b' },
      ],
      [
        { larkAppId: 'cli_a', botName: 'Codex A', botAvatarUrl: 'https://img/a' },
        { larkAppId: 'cli_b', botName: 'Claude B', botAvatarUrl: 'https://img/b' },
      ],
    );

    expect(out[0]).toMatchObject({ senderName: 'Alice', senderAvatar: 'https://img/alice' });
    expect(out[1]).toMatchObject({ senderName: 'Codex A', senderAvatar: 'https://img/a', senderBotAppId: 'cli_a' });
    expect(out[2]).toMatchObject({ senderName: 'Claude B', senderAvatar: 'https://img/b', senderBotAppId: 'cli_b' });
  });

  it('does not guess a bot identity when the observer-scoped open_id is unknown', () => {
    const [message] = enrichHistorySenders(
      [{ messageId: 'm1', senderId: 'ou_unknown', senderType: 'app', msgType: 'text', content: 'x' }],
      new Map(),
      [{ openId: 'ou_known', displayName: 'Known', larkAppId: 'cli_known' }],
      [{ larkAppId: 'cli_known', botName: 'Known', botAvatarUrl: 'https://img/known' }],
    );
    expect(message).not.toHaveProperty('senderName');
    expect(message).not.toHaveProperty('senderAvatar');
  });

  it('keeps the server-provided senderName when local rosters cannot resolve the sender', () => {
    const out = enrichHistorySenders(
      [
        // Third-party bot not in bots.json / observed roster — server name survives.
        { messageId: 'm1', senderId: 'ou_foreign_bot', senderType: 'app', msgType: 'text', content: 'x', senderName: 'ForeignBot' },
        // Human outside the app's visible range (contact lookup returned null).
        { messageId: 'm2', senderId: 'ou_stranger', senderType: 'user', msgType: 'text', content: 'y', senderName: '张三' },
      ],
      new Map([['ou_stranger', null]]),
      [],
      [],
    );
    expect(out[0]).toMatchObject({ senderName: 'ForeignBot' });
    expect(out[1]).toMatchObject({ senderName: '张三' });
  });

  it('prefers the locally-resolved name over the server-provided one', () => {
    const [message] = enrichHistorySenders(
      [{ messageId: 'm1', senderId: 'ou_bot', senderType: 'app', msgType: 'text', content: 'x', senderName: 'ServerName' }],
      new Map(),
      [{ openId: 'ou_bot', displayName: 'Local Display', larkAppId: 'cli_x' }],
      [{ larkAppId: 'cli_x', botName: 'Local Display', botAvatarUrl: 'https://img/x' }],
    );
    expect(message).toMatchObject({ senderName: 'Local Display' });
  });

  it('resolves app senders that Lark history identifies by stable cli app id', () => {
    const [message] = enrichHistorySenders(
      [{ messageId: 'm1', senderId: 'cli_peer', senderType: 'app', msgType: 'text', content: 'done' }],
      new Map(),
      [],
      [{ larkAppId: 'cli_peer', botName: 'Peer Bot', botAvatarUrl: 'https://img/peer' }],
    );
    expect(message).toMatchObject({
      senderName: 'Peer Bot',
      senderAvatar: 'https://img/peer',
      senderBotAppId: 'cli_peer',
    });
  });
});
