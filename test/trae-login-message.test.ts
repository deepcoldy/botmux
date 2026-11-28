import { describe, expect, it } from 'vitest';
import { isTraeLoginCallbackEvent, redactTraeLoginCallbackEvent } from '../src/services/trae-login-message.js';
import { durableLarkMessageEvent } from '../src/services/durable-inbox-shadow.js';
import { parseEventMessage, stripLeadingMentions } from '../src/im/lark/message-parser.js';
import { classifySlash } from '../src/core/command-router.js';

const raw = { sender: { sender_type: 'user' }, message: { message_id: 'om_callback', chat_type: 'p2p',
  message_type: 'text', content: JSON.stringify({ text: '/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=SYNTHETIC_SECRET' }) } };

function expectCanonicalCallback(event: any): void {
  const envelope = event?.message ? event : event?.event;
  const { parsed } = parseEventMessage({
    sender: { sender_id: {}, sender_type: 'unknown' }, ...envelope,
  });
  const commandText = stripLeadingMentions(parsed.content, parsed.mentions);
  expect(classifySlash({
    text: commandText, context: 'thread', phase: 'closed', passthrough: new Set(), coldStartPassthrough: new Set(),
    senderIsBot: false, acceptSlashFromBots: false,
  })).toMatchObject({ kind: 'daemon', cmd: '/dashboard', sessionPolicy: 'sessionless' });
  expect(isTraeLoginCallbackEvent(event)).toBe(true);
}
describe('sensitive callback control input', () => {
  it('recognizes both text and fragmented rich-text callbacks', () => {
    expectCanonicalCallback(raw);
    expectCanonicalCallback({ event: { message: { message_type: 'post', content: JSON.stringify({ content: [[
      { tag: 'text', text: '/dashboard ' }, { tag: 'text', text: 'trae-login complete request-id ' },
      { tag: 'a', href: 'http://127.0.0.1:1234/authorize?token=SYNTHETIC_SECRET' },
    ]] }) } } });
  });
  it('redacts a callback when adjacent post nodes split the complete token', () => {
    const secret = 'SPLIT_COMPLETE_SECRET';
    const event = { ...raw, message: { ...raw.message, message_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[
      { tag: 'text', text: '/dashboard trae-login comp' },
      { tag: 'text', text: 'lete request-id ' },
      { tag: 'a', text: `http://127.0.0.1:1234/authorize?token=${secret}`, href: `http://127.0.0.1:1234/authorize?token=${secret}` },
    ]] } }) } };
    expectCanonicalCallback(event);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(event))).not.toContain(secret);
    const saved = durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'lark-message-routing:cli_test:oc_test', data: event, now: 100 });
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  it('redacts a callback immediately adjacent to a leading mention', () => {
    const secret = 'NO_SPACE_MENTION_SECRET';
    const event = { ...raw, message: { ...raw.message,
      mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }],
      content: JSON.stringify({ text: `@_user_1/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=${secret}` }),
    } };
    expectCanonicalCallback(event);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(event))).not.toContain(secret);
    const saved = durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'lark-message-routing:cli_test:oc_test', data: event, now: 100 });
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  it.each([{ spacing: '', label: 'attached' }, { spacing: ' ', label: 'spaced' }])('uses inline post AST for $label commands without erasing discussion', ({ spacing }) => {
    const secret = 'INLINE_POST_MENTION_SECRET';
    const callback = { ...raw, message: { ...raw.message, message_type: 'post', mentions: undefined,
      content: JSON.stringify({ zh_cn: { title: '', content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Bot' },
        { tag: 'text', text: `${spacing}/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=${secret}` },
      ]] } }),
    } };
    expect(isTraeLoginCallbackEvent(callback)).toBe(true);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(callback))).not.toContain(secret);
    expect(JSON.stringify(durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'p', data: callback, now: 100 }))).not.toContain(secret);

    const discussion = { ...callback, message: { ...callback.message,
      content: JSON.stringify({ zh_cn: { title: '', content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Bot' },
        { tag: 'text', text: `${spacing}请解释 /dashboard trae-login complete 命令的含义` },
      ]] } }),
    } };
    expect(isTraeLoginCallbackEvent(discussion)).toBe(false);
    expect(redactTraeLoginCallbackEvent(discussion)).toBe(discussion);
  });

  it('protects an attached text mention without metadata but preserves attached prose', () => {
    const secret = 'UNSTRUCTURED_TEXT_MENTION_SECRET';
    const callback = { ...raw, message: { ...raw.message, mentions: undefined,
      content: JSON.stringify({ text: `@Bot/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=${secret}` }),
    } };
    expect(isTraeLoginCallbackEvent(callback)).toBe(true);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(callback))).not.toContain(secret);
    expect(JSON.stringify(durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'p', data: callback, now: 100 }))).not.toContain(secret);

    const discussion = { ...callback, message: { ...callback.message,
      content: JSON.stringify({ text: '@Bot请解释 /dashboard trae-login complete 命令的含义' }),
    } };
    expect(isTraeLoginCallbackEvent(discussion)).toBe(false);
    expect(redactTraeLoginCallbackEvent(discussion)).toBe(discussion);
  });

  it.each([
    {
      name: 'null rich-text node',
      content: { zh_cn: { title: '', content: [[null,
        { tag: 'text', text: '/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=MALFORMED_POST_SECRET' },
      ]] } },
      mentions: undefined,
      secret: 'MALFORMED_POST_SECRET',
    },
    {
      name: 'structured mentions without display names',
      content: { text: '@_user_1@_user_2/dashboard trae-login complete request-id http://127.0.0.1:1234/authorize?token=MISSING_NAMES_SECRET' },
      mentions: [{ key: '@_user_1' }, { key: '@_user_2' }],
      secret: 'MISSING_NAMES_SECRET',
    },
  ])('fails closed for $name', ({ content, mentions, secret }) => {
    const event = { ...raw, message: { ...raw.message,
      message_type: 'text' in content ? 'text' : 'post', mentions, content: JSON.stringify(content),
    } };
    expect(isTraeLoginCallbackEvent(event)).toBe(true);
    expect(JSON.stringify(redactTraeLoginCallbackEvent(event))).not.toContain(secret);
    expect(JSON.stringify(durableLarkMessageEvent({ larkAppId: 'cli_test', eventId: 'im.message.receive_v1:cli_test:om_callback',
      partitionKey: 'p', data: event, now: 100 }))).not.toContain(secret);
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
