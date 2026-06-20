import { describe, expect, it, vi } from 'vitest';

import {
  chatHasAllowedUser,
  resolveGroupJoinPrompt,
  shouldAutoStartOnNewTopic,
  waitForAllowedUserInChat,
} from '../src/core/auto-start.js';

describe('shouldAutoStartOnNewTopic (场景②)', () => {
  const base = {
    enabled: true,
    scope: 'thread' as const,
    anchor: 'om_seed',
    messageId: 'om_seed',
    chatType: 'group' as const,
    ownsSession: false,
  };

  it('FR-6: fires for a topic-group new-topic seed when enabled', () => {
    expect(shouldAutoStartOnNewTopic(base)).toBe(true);
  });

  it('FR-8: does not fire when disabled', () => {
    expect(shouldAutoStartOnNewTopic({ ...base, enabled: false })).toBe(false);
  });

  it('FR-7: does not fire for a regular group (chat-scope, anchor = chatId)', () => {
    expect(
      shouldAutoStartOnNewTopic({ ...base, scope: 'chat', anchor: 'oc_chat', messageId: 'om_seed' }),
    ).toBe(false);
  });

  it('does not fire for a thread reply (anchor = thread root, not this message)', () => {
    expect(
      shouldAutoStartOnNewTopic({ ...base, anchor: 'om_root', messageId: 'om_reply' }),
    ).toBe(false);
  });

  it('does not fire when a session already owns the anchor', () => {
    expect(shouldAutoStartOnNewTopic({ ...base, ownsSession: true })).toBe(false);
  });

  it('does not fire in p2p', () => {
    expect(shouldAutoStartOnNewTopic({ ...base, chatType: 'p2p' })).toBe(false);
  });
});

describe('chatHasAllowedUser (场景①)', () => {
  it('FR-1: true when an allowedUser is a chat member', () => {
    expect(chatHasAllowedUser(['ou_x', 'ou_owner', 'ou_y'], ['ou_owner'])).toBe(true);
  });

  it('FR-2: false when no allowedUser is a member', () => {
    expect(chatHasAllowedUser(['ou_x', 'ou_y'], ['ou_owner'])).toBe(false);
  });

  it('FR-2: false when allowedUsers is empty', () => {
    expect(chatHasAllowedUser(['ou_x', 'ou_y'], [])).toBe(false);
  });

  it('false for an empty chat', () => {
    expect(chatHasAllowedUser([], ['ou_owner'])).toBe(false);
  });
});

describe('resolveGroupJoinPrompt (场景① D8)', () => {
  it('returns the trimmed configured prompt', () => {
    expect(resolveGroupJoinPrompt('  先做代码审查 ')).toBe('先做代码审查');
  });

  it('returns empty string when unset', () => {
    expect(resolveGroupJoinPrompt(undefined)).toBe('');
  });

  it('returns empty string for a blank prompt', () => {
    expect(resolveGroupJoinPrompt('   ')).toBe('');
  });
});

describe('waitForAllowedUserInChat (场景① D7 入群竞态)', () => {
  /** sleep stub: records requested delays, resolves immediately. */
  function makeSleep() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
  }

  it('returns true without retrying when an allowedUser is already a member', async () => {
    const { slept, sleep } = makeSleep();
    const listMembers = vi.fn(async () => ['ou_bot', 'ou_owner']);
    await expect(
      waitForAllowedUserInChat({ listMembers, allowedUsers: ['ou_owner'], sleep }),
    ).resolves.toBe(true);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('retries until the allowedUser shows up (platform adds bot before humans)', async () => {
    const { slept, sleep } = makeSleep();
    // Nexus-style sequence: at bot.added time the chat only contains bots;
    // the humans (incl. the owner) land a moment later.
    const listMembers = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['ou_bot'])
      .mockResolvedValueOnce(['ou_bot', 'ou_other'])
      .mockResolvedValue(['ou_bot', 'ou_other', 'ou_owner']);
    const retries: Array<[number, number]> = [];
    await expect(
      waitForAllowedUserInChat({
        listMembers,
        allowedUsers: ['ou_owner'],
        sleep,
        onRetry: (attempt, delayMs) => retries.push([attempt, delayMs]),
      }),
    ).resolves.toBe(true);
    expect(listMembers).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([3000, 7000]);
    expect(retries).toEqual([[1, 3000], [2, 7000]]);
  });

  it('gives up after exhausting all retries', async () => {
    const { slept, sleep } = makeSleep();
    const listMembers = vi.fn(async () => ['ou_bot']);
    await expect(
      waitForAllowedUserInChat({ listMembers, allowedUsers: ['ou_owner'], sleep }),
    ).resolves.toBe(false);
    expect(listMembers).toHaveBeenCalledTimes(4); // 1 + default 3 retries
    expect(slept).toEqual([3000, 7000, 15000]);
  });

  it('honours custom retryDelaysMs', async () => {
    const { slept, sleep } = makeSleep();
    const listMembers = vi.fn(async () => ['ou_bot']);
    await expect(
      waitForAllowedUserInChat({
        listMembers,
        allowedUsers: ['ou_owner'],
        retryDelaysMs: [10],
        sleep,
      }),
    ).resolves.toBe(false);
    expect(listMembers).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([10]);
  });

  it('FR-2: short-circuits false for empty allowedUsers without listing members', async () => {
    const listMembers = vi.fn(async () => ['ou_x']);
    await expect(waitForAllowedUserInChat({ listMembers, allowedUsers: [] })).resolves.toBe(false);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('propagates listMembers errors to the caller (any attempt)', async () => {
    const { sleep } = makeSleep();
    const listMembers = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['ou_bot'])
      .mockRejectedValueOnce(new Error('no scope'));
    await expect(
      waitForAllowedUserInChat({ listMembers, allowedUsers: ['ou_owner'], sleep }),
    ).rejects.toThrow('no scope');
  });
});
