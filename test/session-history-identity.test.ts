import { describe, expect, it } from 'vitest';
import type { ChatBotMember } from '../src/im/lark/client.js';
import { seedSessionHistoryIdentity } from '../src/dashboard/session-history-identity.js';

function configuredMember(overrides: Partial<ChatBotMember> = {}): ChatBotMember {
  return {
    larkAppId: 'cli_self',
    openId: 'ou_self',
    name: 'Self Bot',
    displayName: 'Self Bot',
    source: 'configured',
    hasTeamRole: false,
    mentionable: true,
    mentionSource: 'self',
    ...overrides,
  };
}

describe('session history identity seeding', () => {
  it('filters malformed registry rows before adding self fallbacks', () => {
    const result = seedSessionHistoryIdentity(
      'cli_self',
      { botOpenId: 'ou_self', botName: 'Self Bot', botAvatarUrl: 'https://img/self' },
      [],
      [null, { larkAppId: 'cli_other', botName: 'Other' }],
    );

    expect(result.botMembers).toContainEqual(configuredMember());
    expect(result.botInfos).toContainEqual({
      larkAppId: 'cli_self',
      botOpenId: 'ou_self',
      botName: 'Self Bot',
      botAvatarUrl: 'https://img/self',
    });
    expect(result.botInfos).toContainEqual({ larkAppId: 'cli_other', botName: 'Other' });
  });

  it('does not duplicate self rows already present in the roster and registry', () => {
    const selfMember = configuredMember();
    const selfInfo = { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'Self Bot' };
    const result = seedSessionHistoryIdentity(
      'cli_self',
      { botOpenId: 'ou_self', botName: 'Self Bot' },
      [selfMember],
      [selfInfo],
    );

    expect(result.botMembers).toEqual([selfMember]);
    expect(result.botInfos).toEqual([selfInfo]);
  });

  it('adds self registry identity before its observer-scoped open id is known', () => {
    const result = seedSessionHistoryIdentity(
      'cli_self',
      { botName: 'Self Bot', botAvatarUrl: 'https://img/self' },
      [],
      [],
    );

    expect(result.botMembers).toEqual([]);
    expect(result.botInfos).toContainEqual({
      larkAppId: 'cli_self',
      botOpenId: undefined,
      botName: 'Self Bot',
      botAvatarUrl: 'https://img/self',
    });
  });

  it('keeps healthy peer rows when the local bot config no longer exists', () => {
    const result = seedSessionHistoryIdentity(
      'cli_self',
      undefined,
      [],
      [{ larkAppId: 'cli_other', botName: 'Other' }],
    );

    expect(result.botMembers).toEqual([]);
    expect(result.botInfos).toEqual([{ larkAppId: 'cli_other', botName: 'Other' }]);
    expect(result.botInfos).not.toContainEqual(expect.objectContaining({ larkAppId: 'cli_self' }));
  });
});
