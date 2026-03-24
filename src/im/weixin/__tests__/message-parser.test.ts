import { describe, it, expect } from 'vitest';
import { parseMessage, isTextMessage } from '../message-parser.js';
import type { ILinkRawMessage } from '../message-parser.js';

function makeRawMessage(overrides: Partial<ILinkRawMessage> = {}): ILinkRawMessage {
  return {
    from_user_id: 'user_abc',
    to_user_id: 'bot_123',
    message_type: 1,
    message_state: 1,
    context_token: 'ctx_tok',
    item_list: [
      { type: 1, text_item: { text: 'hello world' } },
    ],
    ...overrides,
  };
}

describe('parseMessage', () => {
  it('extracts text content from item_list', () => {
    const msg = parseMessage(makeRawMessage());
    expect(msg.content).toBe('hello world');
  });

  it('joins multiple text items with newlines', () => {
    const msg = parseMessage(makeRawMessage({
      item_list: [
        { type: 1, text_item: { text: 'line one' } },
        { type: 1, text_item: { text: 'line two' } },
      ],
    }));
    expect(msg.content).toBe('line one\nline two');
  });

  it('sets threadId to from_user_id', () => {
    const msg = parseMessage(makeRawMessage({ from_user_id: 'wx_user_xyz' }));
    expect(msg.threadId).toBe('wx_user_xyz');
  });

  it('sets senderId to from_user_id', () => {
    const msg = parseMessage(makeRawMessage({ from_user_id: 'wx_sender' }));
    expect(msg.senderId).toBe('wx_sender');
  });

  it('sets senderType to user', () => {
    const msg = parseMessage(makeRawMessage());
    expect(msg.senderType).toBe('user');
  });

  it('sets msgType to text for message_type 1', () => {
    const msg = parseMessage(makeRawMessage({ message_type: 1 }));
    expect(msg.msgType).toBe('text');
  });

  it('sets msgType to media_N for non-text message types', () => {
    const msg = parseMessage(makeRawMessage({ message_type: 2 }));
    expect(msg.msgType).toBe('media_2');

    const msg3 = parseMessage(makeRawMessage({ message_type: 4 }));
    expect(msg3.msgType).toBe('media_4');
  });

  it('generates an id starting with wx-', () => {
    const msg = parseMessage(makeRawMessage());
    expect(msg.id).toMatch(/^wx-/);
  });

  it('handles empty item_list', () => {
    const msg = parseMessage(makeRawMessage({ item_list: [] }));
    expect(msg.content).toBe('');
  });

  it('skips non-text items (type !== 1)', () => {
    const msg = parseMessage(makeRawMessage({
      item_list: [
        { type: 2 },
        { type: 1, text_item: { text: 'only text' } },
        { type: 3 },
      ],
    }));
    expect(msg.content).toBe('only text');
  });

  it('skips items with missing text_item', () => {
    const msg = parseMessage(makeRawMessage({
      item_list: [
        { type: 1 },
        { type: 1, text_item: { text: 'has text' } },
      ],
    }));
    expect(msg.content).toBe('has text');
  });

  it('extracts image attachments from image_item', () => {
    const msg = parseMessage(makeRawMessage({
      message_type: 2,
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'abc123hex', aes_key: 'dGVzdGtleQ==' },
          },
        },
      ],
    }));
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0].type).toBe('image');
    expect(msg.attachments![0].name).toBe('image_0.jpg');
  });

  it('builds CDN download URL from encrypt_query_param and stores aes_key', () => {
    const msg = parseMessage(makeRawMessage({
      message_type: 2,
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'test_param_123', aes_key: 'dGVzdGtleQ==' },
          },
        },
      ],
    }));
    const [cdnUrl, aesKey] = msg.attachments![0].path.split('\n');
    expect(cdnUrl).toContain('novac2c.cdn.weixin.qq.com');
    expect(cdnUrl).toContain('encrypted_query_param=test_param_123');
    expect(aesKey).toBe('dGVzdGtleQ==');
  });

  it('resolves aeskey from hex field when media.aes_key is missing', () => {
    // aeskey is 32-char hex = 16 bytes
    const hexKey = '00112233445566778899aabbccddeeff';
    const msg = parseMessage(makeRawMessage({
      message_type: 2,
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'param' },
            aeskey: hexKey,
          },
        },
      ],
    }));
    expect(msg.attachments).toHaveLength(1);
    const [, aesKey] = msg.attachments![0].path.split('\n');
    expect(aesKey).toBe(Buffer.from(hexKey, 'hex').toString('base64'));
  });

  it('does not include attachments when no image items exist', () => {
    const msg = parseMessage(makeRawMessage({
      item_list: [
        { type: 1, text_item: { text: 'text only' } },
      ],
    }));
    expect(msg.attachments).toBeUndefined();
  });

  it('extracts both text and image from mixed item_list', () => {
    const msg = parseMessage(makeRawMessage({
      message_type: 2,
      item_list: [
        { type: 1, text_item: { text: 'caption' } },
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'abc123', aes_key: 'a2V5MQ==' },
          },
        },
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'def456', aes_key: 'a2V5Mg==' },
          },
        },
      ],
    }));
    expect(msg.content).toBe('caption');
    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments![0].name).toBe('image_1.jpg');  // index 1 in item_list (text is index 0)
    expect(msg.attachments![1].name).toBe('image_2.jpg');
  });
});

describe('isTextMessage', () => {
  it('returns true for message_type 1', () => {
    expect(isTextMessage(makeRawMessage({ message_type: 1 }))).toBe(true);
  });

  it('returns false for message_type 2 (image)', () => {
    expect(isTextMessage(makeRawMessage({ message_type: 2 }))).toBe(false);
  });

  it('returns false for message_type 3 (voice)', () => {
    expect(isTextMessage(makeRawMessage({ message_type: 3 }))).toBe(false);
  });

  it('returns false for message_type 4 (file)', () => {
    expect(isTextMessage(makeRawMessage({ message_type: 4 }))).toBe(false);
  });
});
