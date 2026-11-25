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
import {
  executeChatTopNoticeViaDaemonIpc,
  parseChatTopNoticeCli,
} from '../src/cli/chat-top-notice-command.js';

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
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--bot'])).toThrow('--bot 缺少值');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--bot='])).toThrow('--bot 缺少值');
    expect(() => parseChatTopNoticeCli([
      'set', 'om_ok', '--chat-id', 'oc_one', '--chat-id=oc_two',
    ])).toThrow('参数重复: --chat-id');
    expect(() => parseChatTopNoticeCli([
      'set', 'om_ok', '--bot', 'cli_one', '--bot=cli_two', '--chat-id', 'oc_one',
    ])).toThrow('参数重复: --bot');
    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--json', '--json']))
      .toThrow('参数重复: --json');
  });

  it('parses headless --bot mode with explicit --chat-id and rejects invalid combinations', () => {
    expect(parseChatTopNoticeCli([
      'set', 'om_welcome', '--bot', 'cli_bot_1', '--chat-id', 'oc_group', '--json',
    ])).toEqual({
      action: 'set',
      messageId: 'om_welcome',
      sessionId: undefined,
      chatId: 'oc_group',
      bot: 'cli_bot_1',
      json: true,
    });
    expect(parseChatTopNoticeCli([
      'set', 'om_welcome', '--bot=cli_bot_2', '--chat-id=oc_group',
    ])).toMatchObject({ bot: 'cli_bot_2', chatId: 'oc_group', json: false });

    expect(() => parseChatTopNoticeCli(['set', 'om_ok', '--bot', 'cli_bot_1']))
      .toThrow('必须同时指定 --chat-id');
    expect(() => parseChatTopNoticeCli([
      'set', 'om_ok', '--bot', 'cli_bot_1', '--session-id', 's1', '--chat-id', 'oc_group',
    ])).toThrow('--bot 与 --session-id 不能同时指定');
    for (const badBot of ['ou_123', 'local_bot', 'cli_', `cli_${'a'.repeat(129)}`, 'bad']) {
      expect(() => parseChatTopNoticeCli([
        'set', 'om_ok', '--bot', badBot, '--chat-id', 'oc_group',
      ])).toThrow('bot 无效');
    }
  });
});

describe('executeChatTopNoticeViaDaemonIpc', () => {
  it('posts to the target bot daemon IPC route and verifies receipt identity', async () => {
    const fetchIpc = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      larkAppId: 'cli_bot_1',
      chatId: 'oc_group',
      messageId: 'om_welcome',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await executeChatTopNoticeViaDaemonIpc(
      { larkAppId: 'cli_bot_1', chatId: 'oc_group', messageId: 'om_welcome' },
      {
        dataDir: '/tmp/data',
        findDaemon: (appId, dir) => {
          expect(appId).toBe('cli_bot_1');
          expect(dir).toBe('/tmp/data');
          return { ipcPort: 19234 };
        },
        loadSecret: () => 'sec_test',
        fetchIpc: fetchIpc as any,
      },
    );

    expect(result).toEqual({
      action: 'set',
      messageId: 'om_welcome',
      chatId: 'oc_group',
      larkAppId: 'cli_bot_1',
    });
    expect(fetchIpc).toHaveBeenCalledWith(
      19234,
      '/api/groups/oc_group/top-notice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messageId: 'om_welcome', larkAppId: 'cli_bot_1' }),
      }),
      'sec_test',
    );
  });

  it('fails closed when daemon is offline, route is unsupported, or receipt mismatches bot/chat', async () => {
    await expect(executeChatTopNoticeViaDaemonIpc(
      { larkAppId: 'cli_off', chatId: 'oc_group', messageId: 'om_welcome' },
      { findDaemon: () => null, loadSecret: () => 'sec' },
    )).rejects.toThrow('daemon_offline');

    const unsupportedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'not_found',
    }), { status: 404 }));
    await expect(executeChatTopNoticeViaDaemonIpc(
      { larkAppId: 'cli_old', chatId: 'oc_group', messageId: 'om_welcome' },
      { findDaemon: () => ({ ipcPort: 19234 }), loadSecret: () => 'sec', fetchIpc: unsupportedFetch as any },
    )).rejects.toThrow('daemon_top_notice_unsupported');

    for (const badReceipt of [
      { ok: true, larkAppId: 'cli_wrong_bot', chatId: 'oc_group', messageId: 'om_welcome' },
      { ok: true, larkAppId: 'cli_bot_1', chatId: 'oc_other_chat', messageId: 'om_welcome' },
      { ok: true, larkAppId: 'cli_bot_1', chatId: 'oc_group', messageId: 'om_other_msg' },
      { ok: false, larkAppId: 'cli_bot_1', chatId: 'oc_group', messageId: 'om_welcome' },
    ]) {
      const mismatchFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(badReceipt), { status: 200 }));
      await expect(executeChatTopNoticeViaDaemonIpc(
        { larkAppId: 'cli_bot_1', chatId: 'oc_group', messageId: 'om_welcome' },
        { findDaemon: () => ({ ipcPort: 19234 }), loadSecret: () => 'sec', fetchIpc: mismatchFetch as any },
      )).rejects.toThrow('invalid_ipc_response');
    }
  });
});
