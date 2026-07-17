import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => true);
const mockCanTalk = vi.fn(() => true);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
  canTalk: (...a: any[]) => mockCanTalk(...a),
  extractMessageTextForRouting: (m: any) => {
    try { return JSON.parse(m.content ?? '{}').text ?? ''; } catch { return ''; }
  },
}));

vi.mock('../src/im/lark/message-parser.js', () => ({
  stripLeadingMentions: (s: string) => s,
}));

const mockGetChatMode = vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p');
const mockReplyMessage = vi.fn(async () => 'msg-id');
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: (...a: any[]) => mockGetChatMode(...a),
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
}));

const mockIsSubstituteEnabledForChat = vi.fn(() => true);
const mockSetSubstituteEnabledForChat = vi.fn();
vi.mock('../src/services/substitute-chat-toggle-store.js', () => ({
  isSubstituteEnabledForChat: (...a: any[]) => mockIsSubstituteEnabledForChat(...a),
  setSubstituteEnabledForChat: (...a: any[]) => mockSetSubstituteEnabledForChat(...a),
}));

const mockGetBot = vi.fn(() => ({
  config: {
    substituteMode: {
      enabled: true,
      targets: [{ openId: 'ou_sub' }],
      topicGroups: true,
    },
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

vi.mock('../src/i18n/index.js', () => ({
  t: (key: string) => key,
  localeForBot: () => 'zh',
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tryHandleSubstituteCommand } from '../src/im/lark/substitute-command.js';

const APP = 'app-x';
const USER = 'ou_user';

function msg(text: string, chatType: 'group' | 'p2p' = 'group') {
  return {
    chat_id: chatType === 'p2p' ? 'oc_dm' : 'oc_group',
    message_id: 'om_1',
    chat_type: chatType,
    content: JSON.stringify({ text }),
    mentions: [],
  };
}

function lastReply(): string | undefined {
  const calls = mockReplyMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][2] : undefined;
}

describe('tryHandleSubstituteCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockCanTalk.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
    mockIsSubstituteEnabledForChat.mockReturnValue(true);
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub' }],
          topicGroups: true,
        },
      },
    });
  });

  it('non-command messages are ignored', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('hello'), USER)).toBe(false);
  });

  it('status reports current per-chat state', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('/substitute'), USER)).toBe(true);
    expect(lastReply()).toBe('cmd.substitute.status_on');

    mockIsSubstituteEnabledForChat.mockReturnValue(false);
    await tryHandleSubstituteCommand(APP, msg('/substitute status'), USER);
    expect(lastReply()).toBe('cmd.substitute.status_off');
  });

  it('on/off requires canOperate and writes the per-chat toggle', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER)).toBe(true);
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', false);
    expect(lastReply()).toBe('cmd.substitute.updated_off');

    await tryHandleSubstituteCommand(APP, msg('/substitute on'), USER);
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', true);
    expect(lastReply()).toBe('cmd.substitute.updated_on');
  });

  it('denies mutations for non-operators', async () => {
    mockCanOperate.mockReturnValue(false);
    await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER);
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.substitute.owner_only');
  });

  it('rejects p2p but accepts topic groups (per-chat toggle applies to both group kinds)', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute off', 'p2p'), USER);
    expect(lastReply()).toBe('cmd.substitute.unsupported');

    // 话题群同样支持 per-chat 开关（话题群替身支持随 PR 放开）。
    mockGetChatMode.mockResolvedValue('topic');
    await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER);
    expect(lastReply()).toBe('cmd.substitute.updated_off');
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', false);
  });

  it('topicGroups=false reports the bot-level disable instead of a false per-chat success', async () => {
    mockGetChatMode.mockResolvedValue('topic');
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub' }],
          topicGroups: false,
        },
      },
    });

    await tryHandleSubstituteCommand(APP, msg('/substitute status'), USER);
    expect(lastReply()).toBe('cmd.substitute.topic_disabled');

    await tryHandleSubstituteCommand(APP, msg('/substitute on'), USER);
    expect(lastReply()).toBe('cmd.substitute.topic_disabled');
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
  });
});
