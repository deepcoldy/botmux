import { describe, it, expect } from 'vitest';
import { parseEventMessage, parseApiMessage, extractResources } from '../message-parser.js';

function makeRawEvent(overrides: any = {}) {
  return {
    sender: {
      sender_id: { open_id: 'ou_sender1', user_id: 'u_123' },
      sender_type: 'user',
      ...(overrides.sender ?? {}),
    },
    message: {
      message_id: 'om_msg1',
      root_id: 'om_root1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello world' }),
      chat_id: 'oc_chat1',
      chat_type: 'group',
      create_time: '1700000000000',
      ...(overrides.message ?? {}),
    },
  };
}

describe('parseEventMessage', () => {
  it('extracts messageId, rootId, senderId, content, msgType from text event', () => {
    const { parsed } = parseEventMessage(makeRawEvent());

    expect(parsed.messageId).toBe('om_msg1');
    expect(parsed.rootId).toBe('om_root1');
    expect(parsed.senderId).toBe('ou_sender1');
    expect(parsed.senderType).toBe('user');
    expect(parsed.content).toBe('hello world');
    expect(parsed.msgType).toBe('text');
    expect(parsed.createTime).toBe('1700000000000');
  });

  it('defaults rootId to empty string when not present', () => {
    const { parsed } = parseEventMessage(makeRawEvent({
      message: { root_id: undefined },
    }));
    expect(parsed.rootId).toBe('');
  });

  it('handles image messages, returning [image] as content', () => {
    const { parsed, resources } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_key_abc' }),
      },
    }));
    expect(parsed.msgType).toBe('image');
    expect(parsed.content).toBe('[图片]');
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe('image');
    expect(resources[0].key).toBe('img_key_abc');
  });

  it('handles file messages with file name', () => {
    const { parsed, resources } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'file',
        content: JSON.stringify({ file_key: 'fk_123', file_name: 'report.pdf' }),
      },
    }));
    expect(parsed.content).toBe('[文件: report.pdf]');
    expect(resources).toHaveLength(1);
    expect(resources[0].type).toBe('file');
    expect(resources[0].key).toBe('fk_123');
    expect(resources[0].name).toBe('report.pdf');
  });

  it('extracts mentions correctly', () => {
    const { parsed } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 please help' }),
        mentions: [
          { key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } },
        ],
      },
    }));
    expect(parsed.content).toBe('@Alice please help');
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions![0].key).toBe('@_user_1');
    expect(parsed.mentions![0].name).toBe('Alice');
    expect(parsed.mentions![0].openId).toBe('ou_alice');
  });

  it('strips mention placeholders when no mention info is provided', () => {
    const { parsed } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 do something' }),
        mentions: undefined,
      },
    }));
    expect(parsed.content).toBe('do something');
    expect(parsed.mentions).toBeUndefined();
  });

  it('handles post messages, extracting text from paragraphs', () => {
    const postContent = {
      zh_cn: {
        title: 'Post Title',
        content: [
          [{ tag: 'text', text: 'line one' }],
          [{ tag: 'text', text: 'line two' }, { tag: 'a', text: 'link', href: 'https://example.com' }],
        ],
      },
    };
    const { parsed } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'post',
        content: JSON.stringify(postContent),
      },
    }));
    expect(parsed.content).toContain('Post Title');
    expect(parsed.content).toContain('line one');
    expect(parsed.content).toContain('line two');
  });

  it('handles interactive messages', () => {
    const { parsed } = parseEventMessage(makeRawEvent({
      message: {
        message_type: 'interactive',
        content: JSON.stringify({ card: 'stuff' }),
      },
    }));
    expect(parsed.content).toBe('[interactive card]');
  });
});

describe('parseApiMessage', () => {
  it('converts REST API message format to LarkMessage', () => {
    const msg = {
      message_id: 'om_api1',
      root_id: 'om_root_api',
      sender: { id: 'ou_api_sender', sender_type: 'user' },
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'api message' }) },
      create_time: '1700000001000',
    };
    const parsed = parseApiMessage(msg);
    expect(parsed.messageId).toBe('om_api1');
    expect(parsed.rootId).toBe('om_root_api');
    expect(parsed.senderId).toBe('ou_api_sender');
    expect(parsed.senderType).toBe('user');
    expect(parsed.content).toBe('api message');
    expect(parsed.createTime).toBe('1700000001000');
  });

  it('falls back to thread_id when root_id is absent', () => {
    const msg = {
      message_id: 'om_api2',
      thread_id: 'om_thread_fallback',
      sender: { id: 'ou_s', sender_type: 'app' },
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'hi' }) },
    };
    const parsed = parseApiMessage(msg);
    expect(parsed.rootId).toBe('om_thread_fallback');
  });

  it('handles missing fields gracefully with defaults', () => {
    const parsed = parseApiMessage({});
    expect(parsed.messageId).toBe('');
    expect(parsed.rootId).toBe('');
    expect(parsed.senderId).toBe('');
    expect(parsed.senderType).toBe('unknown');
    expect(parsed.msgType).toBe('text');
    expect(parsed.createTime).toBe('');
  });
});

describe('extractResources', () => {
  it('extracts image_key from image messages', () => {
    const resources = extractResources('image', JSON.stringify({ image_key: 'img_k' }));
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({ type: 'image', key: 'img_k', name: 'img_k.jpg' });
  });

  it('extracts file_key and file_name from file messages', () => {
    const resources = extractResources('file', JSON.stringify({ file_key: 'fk', file_name: 'doc.pdf' }));
    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual({ type: 'file', key: 'fk', name: 'doc.pdf' });
  });

  it('extracts images from post messages', () => {
    const post = {
      content: [
        [{ tag: 'text', text: 'hello' }],
        [{ tag: 'img', image_key: 'img_post_1' }],
      ],
    };
    const resources = extractResources('post', JSON.stringify(post));
    expect(resources).toHaveLength(1);
    expect(resources[0].key).toBe('img_post_1');
  });

  it('returns empty for text messages', () => {
    expect(extractResources('text', JSON.stringify({ text: 'hi' }))).toEqual([]);
  });

  it('returns empty for invalid JSON', () => {
    expect(extractResources('image', 'not json')).toEqual([]);
  });

  it('uses file_key as name when file_name is absent', () => {
    const resources = extractResources('file', JSON.stringify({ file_key: 'fk_no_name' }));
    expect(resources[0].name).toBe('fk_no_name');
  });
});
