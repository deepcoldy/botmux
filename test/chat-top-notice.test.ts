import { beforeEach, describe, expect, it, vi } from 'vitest';

const { putTopNotice, lookupMessageChatId } = vi.hoisted(() => ({
  putTopNotice: vi.fn(),
  lookupMessageChatId: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ im: { v1: { chatTopNotice: { putTopNotice } } } }),
}));

vi.mock('../src/im/lark/client.js', () => ({
  assertLarkTransport: vi.fn(),
  lookupMessageChatId,
}));

import { putChatTopNotice } from '../src/im/lark/chat-top-notice.js';
import { parseChatTopNoticeCli } from '../src/cli/chat-top-notice-command.js';

describe('chat top notice API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets a message from the requested chat as the top notice', async () => {
    lookupMessageChatId.mockResolvedValue('oc_group');
    putTopNotice.mockResolvedValue({ code: 0, data: {} });

    await expect(putChatTopNotice('app', 'oc_group', 'om_welcome')).resolves.toBeUndefined();
    expect(putTopNotice).toHaveBeenCalledWith({
      path: { chat_id: 'oc_group' },
      data: { chat_top_notice: [{ action_type: '1', message_id: 'om_welcome' }] },
    });
  });

  it('fails closed before writing when the message belongs to another chat', async () => {
    lookupMessageChatId.mockResolvedValue('oc_other');
    await expect(putChatTopNotice('app', 'oc_group', 'om_welcome'))
      .rejects.toThrow('message_chat_mismatch');
    expect(putTopNotice).not.toHaveBeenCalled();
  });

  it('does not accept a missing or non-zero provider code as success', async () => {
    lookupMessageChatId.mockResolvedValue('oc_group');
    putTopNotice.mockResolvedValueOnce({ data: {} });
    await expect(putChatTopNotice('app', 'oc_group', 'om_welcome')).rejects.toThrow('missing_code');
    putTopNotice.mockResolvedValueOnce({ code: 230001, msg: 'denied' });
    await expect(putChatTopNotice('app', 'oc_group', 'om_welcome')).rejects.toThrow('230001: denied');
  });
});

describe('parseChatTopNoticeCli', () => {
  it('parses a targeted JSON set command', () => {
    expect(parseChatTopNoticeCli([
      'set', 'om_welcome', '--session-id=s1', '--chat-id', 'oc_group', '--json',
    ])).toEqual({
      action: 'set',
      messageId: 'om_welcome',
      sessionId: 's1',
      chatId: 'oc_group',
      json: true,
    });
  });

  it('accepts repository-standard Lark IDs including underscores, hyphens, and 128 characters', () => {
    const messageId = `om_${'a_b-'.repeat(32)}`;
    const chatId = `oc_${'z-y_'.repeat(32)}`;
    expect(parseChatTopNoticeCli(['set', messageId, '--chat-id', chatId])).toMatchObject({
      messageId,
      chatId,
    });
  });

  it('rejects malformed identifiers and unknown arguments', () => {
    expect(() => parseChatTopNoticeCli(['set', 'bad'])).toThrow('message_id 无效');
    expect(() => parseChatTopNoticeCli(['set', 'om_'])).toThrow('message_id 无效');
    expect(() => parseChatTopNoticeCli(['set', `om_${'a'.repeat(129)}`])).toThrow('message_id 无效');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--chat-id', 'bad'])).toThrow('chat_id 无效');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--chat-id', 'oc_'])).toThrow('chat_id 无效');
    expect(() => parseChatTopNoticeCli([
      'set', 'om_ok', '--chat-id', `oc_${'a'.repeat(129)}`,
    ])).toThrow('chat_id 无效');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--wat'])).toThrow('未知参数');
  });

  it('rejects missing, empty, and duplicate option values', () => {
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--chat-id'])).toThrow('--chat-id 缺少值');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--session-id='])).toThrow('--session-id 缺少值');
    expect(() => parseChatTopNoticeCli([
      'set', 'om_ok', '--chat-id', 'oc_one', '--chat-id=oc_two',
    ])).toThrow('参数重复: --chat-id');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--json', '--json']))
      .toThrow('参数重复: --json');
  });
});
