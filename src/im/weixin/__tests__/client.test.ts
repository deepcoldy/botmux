import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must import after stubbing fetch
let sendMessage: typeof import('../client.js').sendMessage;
let getUpdates: typeof import('../client.js').getUpdates;
let isAuthError: typeof import('../client.js').isAuthError;
let isSuccess: typeof import('../client.js').isSuccess;

describe('iLink client', () => {
  const mockFetch = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    // Re-import to pick up the stubbed fetch
    const mod = await import('../client.js');
    sendMessage = mod.sendMessage;
    getUpdates = mod.getUpdates;
    isAuthError = mod.isAuthError;
    isSuccess = mod.isSuccess;
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('sendMessage', () => {
    it('builds correct request body with msg wrapper', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => JSON.stringify({ msg_id: 'sent_1' }),
      });

      const result = await sendMessage('tok_123', 'user_abc', 'hello', 'ctx_tok');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body.msg).toBeDefined();
      expect(body.msg.to_user_id).toBe('user_abc');
      expect(body.msg.message_type).toBe(2);
      expect(body.msg.message_state).toBe(2);
      expect(body.msg.context_token).toBe('ctx_tok');
      expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }]);
      expect(body.msg.client_id).toBeDefined();
      expect(body.base_info).toEqual({ channel_version: '1.0.2' });
      expect(result).toBe('sent_1');
    });

    it('includes authorization headers', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => '{}',
      });

      await sendMessage('my_token', 'u', 'hi', '');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer my_token');
      expect(opts.headers.AuthorizationType).toBe('ilink_bot_token');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('returns empty string when response lacks msg_id', async () => {
      mockFetch.mockResolvedValueOnce({
        text: async () => '{}',
      });

      const result = await sendMessage('tok', 'u', 'hi', '');
      expect(result).toBe('');
    });
  });

  describe('getUpdates', () => {
    it('sends correct body with cursor and base_info', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ msgs: [], sync_buf: 'buf_1' }),
      });

      await getUpdates('tok_456', 'cursor_abc');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates');

      const body = JSON.parse(opts.body);
      expect(body.get_updates_buf).toBe('cursor_abc');
      expect(body.base_info).toEqual({ channel_version: '1.0.2' });
    });

    it('returns response data including msgs array', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ msgs: [{ text: 'hi' }], sync_buf: 'b' }),
      });

      const data = await getUpdates('tok', 'c');
      expect(data.msgs).toHaveLength(1);
    });
  });

  describe('isAuthError', () => {
    it('returns true for errcode response with non-zero code', () => {
      expect(isAuthError({ errcode: 40001, errmsg: 'invalid token' })).toBe(true);
    });

    it('returns false when errcode is 0', () => {
      expect(isAuthError({ errcode: 0 })).toBe(false);
    });

    it('returns false when errcode is undefined', () => {
      expect(isAuthError({ msgs: [] })).toBe(false);
    });
  });

  describe('isSuccess', () => {
    it('returns true when msgs is an array', () => {
      expect(isSuccess({ msgs: [] })).toBe(true);
      expect(isSuccess({ msgs: [{ text: 'hi' }] })).toBe(true);
    });

    it('returns false when msgs is not an array', () => {
      expect(isSuccess({ errcode: 40001 })).toBe(false);
      expect(isSuccess({})).toBe(false);
    });
  });
});
