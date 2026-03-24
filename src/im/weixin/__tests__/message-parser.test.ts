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
