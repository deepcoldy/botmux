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

  it('only works in regular groups', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute off', 'p2p'), USER);
    expect(lastReply()).toBe('cmd.substitute.unsupported');

    mockGetChatMode.mockResolvedValue('topic');
    await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER);
    expect(lastReply()).toBe('cmd.substitute.unsupported');
  });
});
