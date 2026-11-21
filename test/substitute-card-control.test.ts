import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCachedChatModeStrict = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  getCachedChatModeStrict: (...args: any[]) => mockGetCachedChatModeStrict(...args),
}));

const mockIsSubstituteEnabledForChat = vi.fn(() => true);
vi.mock('../src/services/substitute-chat-toggle-store.js', () => ({
  isSubstituteEnabledForChat: (...args: any[]) => mockIsSubstituteEnabledForChat(...args),
}));

import { resolveSubstituteCardControl } from '../src/im/lark/substitute-card-control.js';

const APP = 'app_test';
const CHAT = 'oc_group';

function cfg(overrides: Record<string, unknown> = {}): any {
  return {
    enabled: true,
    targets: [{ openId: 'ou_target' }],
    topicGroups: true,
    ...overrides,
  };
}

describe('resolveSubstituteCardControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedChatModeStrict.mockReturnValue('group');
    mockIsSubstituteEnabledForChat.mockReturnValue(true);
  });

  it('hides for p2p chats', () => {
    expect(resolveSubstituteCardControl(APP, CHAT, 'p2p', cfg())).toBeUndefined();
  });

  it('hides when bot-level substitute mode is off', () => {
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg({ enabled: false }))).toBeUndefined();
  });

  it('hides when the chat is in excludedChats', () => {
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg({ excludedChats: [CHAT] }))).toBeUndefined();
  });

  it('hides when the chat is outside a configured allow-list', () => {
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg({ chats: ['oc_other'] }))).toBeUndefined();
  });

  it('shows inside a configured allow-list', () => {
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg({ chats: [CHAT] }))).toEqual({ enabled: true });
  });

  it('topicGroups=false: shows only for a strictly known flat group', () => {
    const disabledTopics = cfg({ topicGroups: false });
    mockGetCachedChatModeStrict.mockReturnValue('group');
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', disabledTopics)).toEqual({ enabled: true });

    mockGetCachedChatModeStrict.mockReturnValue('topic');
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', disabledTopics)).toBeUndefined();

    mockGetCachedChatModeStrict.mockReturnValue(undefined);
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', disabledTopics)).toBeUndefined();

    mockGetCachedChatModeStrict.mockReturnValue('p2p');
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', disabledTopics)).toBeUndefined();
  });

  it('topicGroups enabled: shows for group, topic and unknown strict cache', () => {
    for (const mode of ['group', 'topic', undefined]) {
      mockGetCachedChatModeStrict.mockReturnValue(mode as any);
      expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg())).toEqual({ enabled: true });
    }
  });

  it('reports the live per-chat state', () => {
    mockIsSubstituteEnabledForChat.mockReturnValue(false);
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg())).toEqual({ enabled: false });
  });

  it('hides a strictly cached p2p even when session chatType says group', () => {
    mockGetCachedChatModeStrict.mockReturnValue('p2p');
    expect(resolveSubstituteCardControl(APP, CHAT, 'group', cfg())).toBeUndefined();
  });
});
