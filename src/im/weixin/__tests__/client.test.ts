import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Must import after stubbing fetch
let sendMessage: typeof import('../client.js').sendMessage;
let getUpdates: typeof import('../client.js').getUpdates;
let isAuthError: typeof import('../client.js').isAuthError;
let isSuccess: typeof import('../client.js').isSuccess;
let downloadImage: typeof import('../client.js').downloadImage;
let uploadImage: typeof import('../client.js').uploadImage;
let sendImage: typeof import('../client.js').sendImage;

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
    downloadImage = mod.downloadImage;
    uploadImage = mod.uploadImage;
    sendImage = mod.sendImage;
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

  describe('downloadImage', () => {
    const tmpDir = join('/tmp', 'botmux-test-download');

    afterEach(() => {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    });

    it('downloads, decrypts AES-128-ECB, and saves to disk', async () => {
      // Encrypt some test data
      const plaintext = Buffer.from('fake-png-data-for-testing');
      const key = randomBytes(16);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
      });

      const savePath = join(tmpDir, 'test.jpg');
      const result = await downloadImage('https://cdn.example.com/img.enc', key.toString('base64'), savePath);

      expect(result).toBe(savePath);
      expect(existsSync(savePath)).toBe(true);
      const saved = readFileSync(savePath);
      expect(saved.toString()).toBe('fake-png-data-for-testing');
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(
        downloadImage('https://cdn.example.com/missing.enc', 'dGVzdA==', join(tmpDir, 'x.jpg')),
      ).rejects.toThrow('CDN download failed: 404');
    });
  });

  describe('uploadImage', () => {
    const tmpDir = join('/tmp', 'botmux-test-upload');
    const testFile = join(tmpDir, 'test-upload.jpg');

    beforeEach(() => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(testFile, Buffer.from('test-image-bytes'));
    });

    afterEach(() => {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    });

    it('encrypts file, gets presigned URL, and uploads', async () => {
      // Mock getuploadurl response
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          url: 'https://cdn.example.com/upload?sig=abc',
          download_url: 'https://cdn.example.com/download/img.enc',
        }),
      });
      // Mock PUT upload
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await uploadImage('tok_123', testFile);

      expect(result.cdnUrl).toBe('https://cdn.example.com/download/img.enc');
      expect(result.aesKey).toBeDefined();
      expect(Buffer.from(result.aesKey, 'base64')).toHaveLength(16);
      expect(result.fileSize).toBeGreaterThan(0);

      // Verify getuploadurl call
      const [url1, opts1] = mockFetch.mock.calls[0];
      expect(url1).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl');
      const body1 = JSON.parse(opts1.body);
      expect(body1.file_name).toBe('test-upload.jpg');
      expect(body1.file_type).toBe('image/jpeg');

      // Verify PUT call
      const [url2, opts2] = mockFetch.mock.calls[1];
      expect(url2).toBe('https://cdn.example.com/upload?sig=abc');
      expect(opts2.method).toBe('PUT');
    });

    it('throws when getuploadurl returns no url', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ error: 'bad request' }),
      });

      await expect(uploadImage('tok', testFile)).rejects.toThrow('getuploadurl failed');
    });
  });

  describe('sendImage', () => {
    it('builds correct image message body', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ msg_id: 'img_msg_1' }),
      });

      const result = await sendImage(
        'tok_123', 'user_abc', 'ctx_tok',
        'https://cdn.example.com/img.enc', 'dGVzdGtleQ==', 2048,
      );

      expect(result).toBe('img_msg_1');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');

      const body = JSON.parse(opts.body);
      expect(body.msg.message_type).toBe(2);
      expect(body.msg.to_user_id).toBe('user_abc');
      expect(body.msg.context_token).toBe('ctx_tok');
      expect(body.msg.item_list).toHaveLength(1);
      expect(body.msg.item_list[0].type).toBe(2);
      expect(body.msg.item_list[0].image_item).toEqual({
        url: 'https://cdn.example.com/img.enc',
        aes_key: 'dGVzdGtleQ==',
        file_size: 2048,
      });
    });
  });
});
