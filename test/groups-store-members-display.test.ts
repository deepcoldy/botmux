import { beforeEach, describe, expect, it, vi } from 'vitest';

const larkGetMock = vi.fn();
const listChatBotMembersMock = vi.fn();

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: vi.fn() }),
}));

vi.mock('../src/im/lark/client.js', () => ({
  larkGet: (...args: unknown[]) => larkGetMock(...args),
  listChatBotMembers: (...args: unknown[]) => listChatBotMembersMock(...args),
}));

import { listChatMemberDisplays } from '../src/services/groups-store.js';

describe('listChatMemberDisplays larkAppId enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes larkAppId on configured bot entries and omits it for humans and external bots', async () => {
    larkGetMock.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [
          { member_id: 'ou_human_1', name: 'Operator A', member_type: 'user' },
          { member_id: 'ou_unknown_1', name: 'Operator B' },
        ],
      },
    });
    listChatBotMembersMock.mockResolvedValue([
      {
        larkAppId: 'cli_bot_self',
        openId: 'ou_bot_self',
        name: 'Bot Self',
        displayName: 'Bot Self Display',
        source: 'configured',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'self',
      },
      {
        larkAppId: '  cli_bot_peer  ',
        openId: 'ou_bot_peer',
        name: 'Bot Peer',
        displayName: 'Bot Peer Display',
        source: 'configured',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'cross-ref',
      },
      {
        larkAppId: '',
        openId: 'ou_bot_external',
        name: 'External Bot',
        displayName: 'External Bot',
        source: 'introduce',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'observed',
      },
    ]);

    const rows = await listChatMemberDisplays('cli_bot_self', 'oc_chat_1');

    expect(rows).toEqual([
      { openId: 'ou_human_1', name: 'Operator A', memberType: 'user' },
      { openId: 'ou_unknown_1', name: 'Operator B', memberType: 'unknown' },
      { openId: 'ou_bot_self', name: 'Bot Self Display', memberType: 'bot', larkAppId: 'cli_bot_self' },
      { openId: 'ou_bot_peer', name: 'Bot Peer Display', memberType: 'bot', larkAppId: 'cli_bot_peer' },
      { openId: 'ou_bot_external', name: 'External Bot', memberType: 'bot' },
    ]);
    expect('larkAppId' in rows[0]!).toBe(false);
    expect('larkAppId' in rows[1]!).toBe(false);
    expect('larkAppId' in rows[4]!).toBe(false);
  });

  it('merges bot rows over existing openIds without wiping a previously known larkAppId', async () => {
    larkGetMock.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [
          { member_id: 'ou_bot_a', name: 'Bot A Raw', member_type: 'app' },
        ],
      },
    });
    listChatBotMembersMock.mockResolvedValue([
      {
        larkAppId: 'cli_bot_a',
        openId: 'ou_bot_a',
        name: 'Bot A',
        displayName: 'Bot A',
        source: 'configured',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'cross-ref',
      },
      {
        larkAppId: '',
        openId: 'ou_bot_a',
        name: 'Bot A Dup',
        displayName: 'Bot A Dup',
        source: 'introduce',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'observed',
      },
    ]);

    const rows = await listChatMemberDisplays('cli_bot_self', 'oc_chat_2');
    expect(rows).toEqual([
      { openId: 'ou_bot_a', name: 'Bot A Dup', memberType: 'bot', larkAppId: 'cli_bot_a' },
    ]);
  });

  it('omits larkAppId when different configured bots claim one openId, and keeps the conflict ambiguous', async () => {
    larkGetMock.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [{ member_id: 'ou_shared', name: 'Twin', member_type: 'app' }],
      },
    });
    const botRow = (larkAppId: string, source: 'configured' | 'introduce') => ({
      larkAppId,
      openId: 'ou_shared',
      name: 'Twin',
      displayName: 'Twin',
      source,
      hasTeamRole: false,
      mentionable: true,
      mentionSource: source === 'configured' ? 'cross-ref' : 'observed',
    });
    listChatBotMembersMock.mockResolvedValue([
      botRow('cli_self', 'configured'),
      botRow('cli_peer', 'configured'),
      // An external duplicate must neither restore nor select either claimant.
      botRow('', 'introduce'),
      botRow('cli_self', 'configured'),
    ]);

    const rows = await listChatMemberDisplays('cli_self', 'oc_chat_ambiguous');
    expect(rows).toEqual([
      { openId: 'ou_shared', name: 'Twin', memberType: 'bot' },
    ]);
    expect(rows[0]).not.toHaveProperty('larkAppId');
  });

  it('degrades gracefully when listChatBotMembers fails', async () => {
    larkGetMock.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [{ member_id: 'ou_human_only', name: 'Human', member_type: 'user' }],
      },
    });
    listChatBotMembersMock.mockRejectedValue(new Error('network timeout'));

    const rows = await listChatMemberDisplays('cli_bot_self', 'oc_chat_3');
    expect(rows).toEqual([{ openId: 'ou_human_only', name: 'Human', memberType: 'user' }]);
  });

  it('deduplicates /members across pages and preserves non-openId names when displayName is blank', async () => {
    larkGetMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: true,
          page_token: 'p2',
          items: [
            { member_id: 'ou_bot_drift', name: 'Bot Drift', member_type: 'app' },
            { member_id: 'ou_u1', name: 'User One', member_type: 'user' },
          ],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: false,
          items: [
            { member_id: 'ou_bot_drift', name: '   ', member_type: '' },
            { member_id: 'ou_u1', name: 'User One', member_type: 'user' },
          ],
        },
      });
    listChatBotMembersMock.mockResolvedValue([
      {
        larkAppId: 'cli_bot_drift',
        openId: 'ou_bot_drift',
        name: 'Fallback Name',
        displayName: '   ',
        source: 'configured',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'cross-ref',
      },
      {
        larkAppId: '',
        openId: 'ou_bot_drift',
        name: '',
        displayName: '',
        source: 'introduce',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'observed',
      },
    ]);

    const rows = await listChatMemberDisplays('cli_bot_self', 'oc_chat_4');
    expect(rows).toEqual([
      { openId: 'ou_bot_drift', name: 'Fallback Name', memberType: 'bot', larkAppId: 'cli_bot_drift' },
      { openId: 'ou_u1', name: 'User One', memberType: 'user' },
    ]);
  });
});
