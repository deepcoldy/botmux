/**
 * getAvailableBots filtering: only surface bots that are (a) not self and
 * (b) reliably @-mentionable, identifying self by larkAppId (not cliId).
 * Run: pnpm vitest run test/available-bots.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  listChatBotMembers: vi.fn(),
  downloadMessageResource: vi.fn(),
}));

import { listChatBotMembers } from '../src/im/lark/client.js';
import { getAvailableBots } from '../src/core/session-manager.js';

type Member = Awaited<ReturnType<typeof listChatBotMembers>>[number];
const member = (over: Partial<Member>): Member => ({
  larkAppId: '', openId: 'ou_x', name: 'codex', displayName: 'X',
  source: 'configured', hasTeamRole: false, mentionable: true, mentionSource: 'cross-ref',
  ...over,
});

describe('getAvailableBots filtering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes self by larkAppId — and keeps a peer sharing the same cliId', async () => {
    (listChatBotMembers as any).mockResolvedValue([
      member({ larkAppId: 'cli_self', name: 'codex', displayName: 'Self', openId: 'ou_self' }),
      member({ larkAppId: 'cli_peer', name: 'codex', displayName: 'Peer', openId: 'ou_peer' }),
    ]);
    const bots = await getAvailableBots('cli_self', 'oc_x');
    expect(bots.map(b => b.displayName)).toEqual(['Peer']);
  });

  it('excludes peers that are not reliably mentionable', async () => {
    (listChatBotMembers as any).mockResolvedValue([
      member({ larkAppId: 'cli_p1', displayName: 'Reliable', openId: 'ou1', mentionable: true, mentionSource: 'cross-ref' }),
      member({ larkAppId: 'cli_p2', displayName: 'Unreliable', openId: 'ou2', mentionable: false, mentionSource: 'self' }),
      member({ larkAppId: '', displayName: 'External', openId: 'ou3', source: 'introduce', mentionable: true, mentionSource: 'observed' }),
    ]);
    const bots = await getAvailableBots('cli_self', 'oc_x');
    expect(bots.map(b => b.displayName).sort()).toEqual(['External', 'Reliable']);
  });

  it('returns [] on listing error', async () => {
    (listChatBotMembers as any).mockRejectedValue(new Error('boom'));
    expect(await getAvailableBots('cli_self', 'oc_x')).toEqual([]);
  });
});
