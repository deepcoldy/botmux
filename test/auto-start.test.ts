import { describe, expect, it } from 'vitest';

import {
  chatHasAllowedUser,
  resolveGroupJoinPrompt,
  shouldAutoStartOnNewTopic,
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

  it('does not fire for bot-sent topic seeds unless explicitly enabled', () => {
    expect(shouldAutoStartOnNewTopic({ ...base, fromBot: true })).toBe(false);
    expect(shouldAutoStartOnNewTopic({ ...base, fromBot: true, includeBotMessages: true })).toBe(true);
  });

  it('FR-8: does not fire when disabled', () => {
    expect(shouldAutoStartOnNewTopic({ ...base, enabled: false, fromBot: true, includeBotMessages: true })).toBe(false);
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
