import { describe, expect, it, vi } from 'vitest';

import {
  chatHasAllowedUser,
  pickGroupJoinAnchorMessageId,
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

  it('preserves a custom multiline task for either locale', () => {
    const task = '先读上下文\n再汇报进度';
    expect(resolveGroupJoinPrompt(` \n${task}\n `, 'zh')).toBe(task);
    expect(resolveGroupJoinPrompt(` \n${task}\n `, 'en')).toBe(task);
  });

  it.each([[undefined], [''], [' \n\t ']])('provides a first-turn task for an unset or blank prompt (%j)', (configured) => {
    expect(resolveGroupJoinPrompt(configured).trim()).not.toBe('');
  });

  it('localizes the built-in task', () => {
    const chinese = resolveGroupJoinPrompt(undefined, 'zh');
    const english = resolveGroupJoinPrompt(undefined, 'en');
    expect(chinese).toMatch(/[\u4e00-\u9fff]/);
    expect(english).toMatch(/[A-Za-z]/);
    expect(english).not.toMatch(/[\u4e00-\u9fff]/);
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

describe('pickGroupJoinAnchorMessageId (场景① latest-message anchor)', () => {
  const appId = 'cli_self';
  const msg = (id: string, createTime: number, extra: Record<string, unknown> = {}) => ({
    message_id: id,
    create_time: String(createTime),
    msg_type: 'interactive',
    sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app' },
    ...extra,
  });

  it('picks the newest message regardless of input order', () => {
    expect(pickGroupJoinAnchorMessageId([msg('om_new', 300), msg('om_old', 100), msg('om_mid', 200)], appId)).toBe('om_new');
  });

  it('skips system events, recalled messages and the bot\'s own messages', () => {
    expect(pickGroupJoinAnchorMessageId([
      msg('om_card', 100),
      msg('om_self', 400, { sender: { id: appId, id_type: 'app_id', sender_type: 'app' } }),
      msg('om_recalled', 300, { deleted: true }),
      msg('om_system', 200, { msg_type: 'system' }),
    ], appId)).toBe('om_card');
  });

  it('skips the bot\'s own message when the listing uses its per-app open_id sender shape', () => {
    // Real im/v1/messages listings return THIS bot's own messages with either
    // sender.id = app_id (id_type=app_id) or sender.id = the bot's own open_id
    // (ou_…). The ou_ form must be skipped only when selfOpenId is supplied.
    const selfOpenId = 'ou_self_bot';
    const listing = [
      msg('om_context', 100),
      msg('om_self_open_id', 400, { sender: { id: selfOpenId, id_type: 'open_id', sender_type: 'app' } }),
    ];
    expect(pickGroupJoinAnchorMessageId(listing, appId, selfOpenId)).toBe('om_context');
    // Without the open-id hint the ou_ shape is unknowable and stays eligible.
    expect(pickGroupJoinAnchorMessageId(listing, appId)).toBe('om_self_open_id');
  });

  it('resolves a message inside a native topic to its root', () => {
    expect(pickGroupJoinAnchorMessageId([msg('om_reply', 200, { root_id: 'om_root', thread_id: 'omt_1' })], appId)).toBe('om_root');
  });

  it('keeps a quote reply (root_id without thread_id) as its own anchor', () => {
    expect(pickGroupJoinAnchorMessageId([msg('om_quote', 200, { root_id: 'om_root' })], appId)).toBe('om_quote');
  });

  it('returns undefined when nothing qualifies', () => {
    expect(pickGroupJoinAnchorMessageId([], appId)).toBeUndefined();
    expect(pickGroupJoinAnchorMessageId([msg('om_system', 1, { msg_type: 'system' })], appId)).toBeUndefined();
  });
});
