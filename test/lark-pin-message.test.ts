/**
 * pinMessage 返回 Lark 确认的 Pin 记录，unpinMessage 返回 boolean；
 * SDK 抛错或非 0 / missing code 都按失败值返回（Pin 是 QoL，必须 fail-open）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../src/utils/logger.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { listChatPins, pinMessage, unpinMessage } from '../src/im/lark/client.js';

function setPinImpl(appId: string, impl: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { pin: { create: impl } } } } as any;
}

function setUnpinImpl(appId: string, impl: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { pin: { delete: impl } } } } as any;
}

function setListPinsImpl(appId: string, impl: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { pin: { list: impl } } } } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('pinMessage provenance and unpinMessage boolean contracts', () => {
  it('pin calls SDK with exact create payload', async () => {
    const create = vi.fn(async () => ({ code: 0 }));
    setPinImpl('p_payload', create);
    await pinMessage('p_payload', 'om_pin');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: { message_id: 'om_pin' } });
  });

  it('unpin calls SDK with exact delete payload', async () => {
    const del = vi.fn(async () => ({ code: 0 }));
    setUnpinImpl('u_payload', del);
    await unpinMessage('u_payload', 'om_pin');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ path: { message_id: 'om_pin' } });
  });

  it('returns a Pin record only when Lark confirms (code 0)', async () => {
    setPinImpl('p_ok', async () => ({
      code: 0,
      msg: 'success',
      data: {
        pin: {
          message_id: 'om_pin',
          operator_id: 'p_ok',
          operator_id_type: 'app_id',
        },
      },
    }));
    setUnpinImpl('u_ok', async () => ({ code: 0, msg: 'success' }));
    await expect(pinMessage('p_ok', 'om_pin')).resolves.toMatchObject({
      messageId: 'om_pin',
      operatorId: 'p_ok',
      operatorIdType: 'app_id',
    });
    await expect(unpinMessage('u_ok', 'om_pin')).resolves.toBe(true);
  });

  it('returns the exact Pin provenance confirmed by a successful create response', async () => {
    setPinImpl('p_provenance', async () => ({
      code: 0,
      data: {
        pin: {
          message_id: 'om_pin',
          chat_id: 'oc_chat',
          operator_id: 'p_provenance',
          operator_id_type: 'app_id',
          create_time: '1700000000000',
        },
      },
    }));

    await expect(pinMessage('p_provenance', 'om_pin')).resolves.toEqual({
      messageId: 'om_pin',
      chatId: 'oc_chat',
      operatorId: 'p_provenance',
      operatorIdType: 'app_id',
      createTime: '1700000000000',
    });
  });

  it('does not report ownership when create succeeds without a Pin record', async () => {
    setPinImpl('p_missing_pin', async () => ({ code: 0, data: {} }));

    await expect(pinMessage('p_missing_pin', 'om_pin')).resolves.toBeNull();
  });

  it('returns null/false failure values on non-zero code', async () => {
    setPinImpl('p_bad', async () => ({ code: 230001, msg: 'fail' }));
    setUnpinImpl('u_bad', async () => ({ code: 230001, msg: 'fail' }));
    await expect(pinMessage('p_bad', 'om_pin')).resolves.toBeNull();
    await expect(unpinMessage('u_bad', 'om_pin')).resolves.toBe(false);
  });

  it('returns null/false failure values when the response has no code field', async () => {
    setPinImpl('p_missing', async () => ({}));
    setUnpinImpl('u_missing', async () => ({}));
    await expect(pinMessage('p_missing', 'om_pin')).resolves.toBeNull();
    await expect(unpinMessage('u_missing', 'om_pin')).resolves.toBe(false);
  });

  it('returns null when create throws and logs only at debug without leaking auth tokens', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const err: any = new Error('sdk failed');
    err.config = { headers: { Authorization: 'Bearer fake_authorization_token' } };
    setPinImpl('p_throw', async () => { throw err; });
    await expect(pinMessage('p_throw', 'om_pin')).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    const joined = debug.mock.calls.map((c) => c.join(' ')).join(' ');
    const lowered = joined.toLowerCase();
    expect(lowered).not.toContain('fake_authorization_token');
    expect(lowered).not.toContain('authorization');
  });

  it('unpin failures log only at debug (not warn)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    setUnpinImpl('u_debug_code', async () => ({ code: 230001, msg: 'fail' }));
    await expect(unpinMessage('u_debug_code', 'om_pin')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();

    warn.mockClear();
    debug.mockClear();

    const err: any = new Error('sdk failed');
    err.config = { headers: { Authorization: 'Bearer fake_authorization_token' } };
    setUnpinImpl('u_debug_throw', async () => { throw err; });
    await expect(unpinMessage('u_debug_throw', 'om_pin')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    const joined = debug.mock.calls.map((c) => c.join(' ')).join(' ');
    const lowered = joined.toLowerCase();
    expect(lowered).not.toContain('fake_authorization_token');
    expect(lowered).not.toContain('authorization');
  });

  it('two successful unpin calls both return true (wrapper is stateless)', async () => {
    setUnpinImpl('u_idem', async () => ({ code: 0 }));
    await expect(unpinMessage('u_idem', 'om_pin')).resolves.toBe(true);
    await expect(unpinMessage('u_idem', 'om_pin')).resolves.toBe(true);
  });
});

describe('listChatPins pagination contract', () => {
  it('drains pages with exact first and next payloads and normalizes records', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              message_id: 'om_first',
              chat_id: 'oc_chat',
              operator_id: 'ou_first',
              operator_id_type: 'open_id',
              create_time: '1700000000000',
            },
          ],
          has_more: true,
          page_token: 'next-token',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              message_id: 'om_second',
              chat_id: 'oc_chat',
              operator_id: 'ou_second',
              operator_id_type: 'union_id',
              create_time: '1700000001000',
            },
          ],
          has_more: false,
        },
      });
    setListPinsImpl('list_ok', list);

    await expect(listChatPins('list_ok', 'oc_chat')).resolves.toEqual([
      {
        messageId: 'om_first',
        chatId: 'oc_chat',
        operatorId: 'ou_first',
        operatorIdType: 'open_id',
        createTime: '1700000000000',
      },
      {
        messageId: 'om_second',
        chatId: 'oc_chat',
        operatorId: 'ou_second',
        operatorIdType: 'union_id',
        createTime: '1700000001000',
      },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      params: {
        chat_id: 'oc_chat',
        page_size: 50,
      },
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        chat_id: 'oc_chat',
        page_size: 50,
        page_token: 'next-token',
      },
    });
  });

  it('preserves every remote record and raw string provenance fields verbatim', async () => {
    setListPinsImpl('list_verbatim', async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: '',
            chat_id: '  oc_chat  ',
            operator_id: '  ou_blank  ',
            operator_id_type: ' open_id ',
            create_time: ' 1700000000000 ',
          },
          {
            message_id: '  om_spaced  ',
            chat_id: '',
            operator_id: ' ',
            operator_id_type: '',
            create_time: '',
          },
        ],
        has_more: false,
      },
    }));

    await expect(listChatPins('list_verbatim', 'oc_chat')).resolves.toEqual([
      {
        messageId: '',
        chatId: '  oc_chat  ',
        operatorId: '  ou_blank  ',
        operatorIdType: ' open_id ',
        createTime: ' 1700000000000 ',
      },
      {
        messageId: '  om_spaced  ',
        chatId: '',
        operatorId: ' ',
        operatorIdType: '',
        createTime: '',
      },
    ]);
  });

  it('throws on non-zero code or missing code', async () => {
    setListPinsImpl('list_bad_code', async () => ({ code: 230001, msg: 'fail' }));
    setListPinsImpl('list_missing_code', async () => ({ data: { items: [] } }));

    await expect(listChatPins('list_bad_code', 'oc_chat')).rejects.toThrow(/230001|fail/);
    await expect(listChatPins('list_missing_code', 'oc_chat')).rejects.toThrow(/missing code/i);
  });

  it('rethrows SDK errors', async () => {
    const err = new Error('sdk failed');
    setListPinsImpl('list_throw', async () => { throw err; });
    await expect(listChatPins('list_throw', 'oc_chat')).rejects.toThrow('sdk failed');
  });

  it('throws when has_more is true but next page token is missing', async () => {
    setListPinsImpl('list_missing_token', async () => ({
      code: 0,
      data: {
        items: [],
        has_more: true,
      },
    }));

    await expect(listChatPins('list_missing_token', 'oc_chat')).rejects.toThrow(/malformed pagination/i);
  });

  it('throws when has_more is true but next page token is empty or has surrounding whitespace', async () => {
    setListPinsImpl('list_bad_whitespace_token', vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: '',
        },
      }));
    setListPinsImpl('list_surrounded_whitespace_token', vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: ' next-token ',
        },
      }));

    await expect(listChatPins('list_bad_whitespace_token', 'oc_chat')).rejects.toThrow(/malformed pagination/i);
    await expect(listChatPins('list_surrounded_whitespace_token', 'oc_chat')).rejects.toThrow(/malformed pagination/i);
  });

  it('throws when the server repeats a page token', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: 'dup-token',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: 'dup-token',
        },
      });
    setListPinsImpl('list_dup_token', list);

    await expect(listChatPins('list_dup_token', 'oc_chat')).rejects.toThrow(/repeated page token/i);
  });

  it('treats raw opaque page tokens as exact values for follow-up requests and duplicate detection', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: 'opaque-token',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [],
          has_more: true,
          page_token: 'opaque-token',
        },
      });
    setListPinsImpl('list_exact_token', list);

    await expect(listChatPins('list_exact_token', 'oc_chat')).rejects.toThrow(/repeated page token/i);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        chat_id: 'oc_chat',
        page_size: 50,
        page_token: 'opaque-token',
      },
    });
  });
});
