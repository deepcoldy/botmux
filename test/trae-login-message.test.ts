import { describe, expect, it } from 'vitest';
import { isTraeLoginCallbackEvent, redactTraeLoginCallbackEvent } from '../src/services/trae-login-message.js';
import { durableLarkMessageEvent } from '../src/services/durable-inbox-shadow.js';

const raw = { sender: { sender_type: 'user' }, message: { message_id: 'om_callback', chat_type: 'p2p',
  message_type: 'text', content: JSON.stringify({ text: '/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=SYNTHETIC_SECRET' }) } };
describe('sensitive callback control input', () => {
  it('recognizes both text and fragmented rich-text callbacks', () => {
    expect(isTraeLoginCallbackEvent(raw)).toBe(true);
    expect(isTraeLoginCallbackEvent({ event: { message: { content: JSON.stringify({ content: [[
      { tag: 'text', text: '/dashboard' }, { tag: 'text', text: 'trae-login complete request-id' },
      { tag: 'a', href: 'http://127.0.0.1:1234/authorize?token=SYNTHETIC_SECRET' },
    ]] }) } } })).toBe(true);
  });
  it('preserves the live callback and removes its credentials from durable payloads', () => {
    const saved = durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'lark-message-routing:cli_test:oc_test', data: raw, now: 100 });
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_SECRET');
    expect(JSON.stringify(raw)).toContain('SYNTHETIC_SECRET');
    expect((redactTraeLoginCallbackEvent(raw).message).message_id).toBe('om_callback');
  });
  it('leaves unrelated durable message payloads unchanged', () => {
    const normal = { message: { content: JSON.stringify({ text: '/dashboard sessions' }) } };
    expect(isTraeLoginCallbackEvent(normal)).toBe(false);
    expect(redactTraeLoginCallbackEvent(normal)).toBe(normal);
    const example = { message: { content: JSON.stringify({ text: '请解释 /dashboard trae-login complete 这个命令的含义' }) } };
    expect(isTraeLoginCallbackEvent(example)).toBe(false);
    expect(redactTraeLoginCallbackEvent(example)).toBe(example);
    const mentioned = { message: { mentions: [{ key: '@_user_1' }], content: JSON.stringify({ text: '@_user_1 /dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=x' }) } };
    expect(isTraeLoginCallbackEvent(mentioned)).toBe(true);
  });
  it('removes the duplicated REST history body as well as the live event content', () => {
    const history = { ...raw, message: { ...raw.message, body: { content: raw.message.content } } };
    const saved = durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'lark-message-routing:cli_test:oc_test', data: history, now: 100 });
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_SECRET');
    expect(JSON.stringify(history)).toContain('SYNTHETIC_SECRET');
  });
  it.each([
    '/dashboard trae-login complete http://127.0.0.1:1234/authorize?token=INVALID_INPUT_SECRET',
    '/dashboard trae-login complete request-id <http://127.0.0.1:1234/authorize?token=INVALID_INPUT_SECRET>',
    '/dashboard trae-login complete\nrequest-id http://127.0.0.1:1234/authorize?token=INVALID_INPUT_SECRET',
  ])('protects malformed callback control input: %s', text => {
    const event = { message: { content: JSON.stringify({ text }) } };
    expect(isTraeLoginCallbackEvent(event)).toBe(true);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(event))).not.toContain('INVALID_INPUT_SECRET');
  });
});
