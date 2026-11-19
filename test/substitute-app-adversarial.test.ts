import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMessageDetail = vi.hoisted(() => vi.fn());
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
import { resolveSubstituteAppMentions, substituteMentionIdentities } from '../src/im/lark/substitute-app-mentions.js';
import { resolveSubstituteTargets } from '../src/services/substitute-mode-store.js';

beforeEach(() => vi.clearAllMocks());

describe('App ID adversarial identity boundaries', () => {
  const message = {
    message_id: 'om_edit_probe', chat_id: 'oc_probe', message_type: 'text',
    create_time: '1000', update_time: '1000',
    content: JSON.stringify({ text: '@_user_1 hello' }),
    mentions: [{ key: '@_user_1', name: 'Same name', id: { open_id: 'ou_original' } }],
  };

  it('does not attach an edited mention identity to the original event with identical text', async () => {
    getMessageDetail.mockResolvedValue({ items: [{
      message_id: message.message_id, chat_id: message.chat_id, msg_type: 'text',
      create_time: '1000', update_time: '2000',
      body: { content: message.content },
      mentions: [{ key: '@_user_1', name: 'Same name', id: 'cli_replacement', id_type: 'app_id' }],
    }] });
    const result = await resolveSubstituteAppMentions('cli_receiver', message);
    expect(substituteMentionIdentities(result).some(mention => mention.appId === 'cli_replacement')).toBe(false);
  });

  it('does not append a REST app mention whose placeholder is absent from the text event', async () => {
    getMessageDetail.mockResolvedValue({ items: [{
      message_id: message.message_id, chat_id: message.chat_id, msg_type: 'text',
      create_time: '1000', update_time: '1000', body: { content: message.content },
      mentions: [{ key: '@_user_2', name: 'Same name', id: 'cli_unmentioned', id_type: 'app_id' }],
    }] });
    const result = await resolveSubstituteAppMentions('cli_receiver', message);
    expect(substituteMentionIdentities(result).some(mention => mention.appId === 'cli_unmentioned')).toBe(false);
  });

  it('keeps concurrent message lookups separate when their REST responses complete in reverse order', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    getMessageDetail.mockImplementation((_appId, messageId, options) => new Promise(resolve => pending.set(messageId + (options?.userIdType ? ':app' : ':open'), resolve)));
    const first = { ...message, message_id: 'om_first' };
    const second = { ...message, message_id: 'om_second' };
    const firstResult = resolveSubstituteAppMentions('cli_receiver', first);
    const secondResult = resolveSubstituteAppMentions('cli_receiver', second);
    const detail = (event: typeof message, appId: string) => ({ items: [{
      message_id: event.message_id, chat_id: event.chat_id, msg_type: 'text',
      create_time: '1000', update_time: '1000', body: { content: event.content },
      mentions: [{ key: '@_user_1', id: appId, id_type: 'app_id' }],
    }] });
    pending.get('om_second:app')!(detail(second, 'cli_second'));
    pending.get('om_second:open')!({ items: [{ ...detail(second, 'cli_second').items[0], mentions: message.mentions }] });
    expect(substituteMentionIdentities(await secondResult)[0].appId).toBe('cli_second');
    pending.get('om_first:app')!(detail(first, 'cli_first'));
    pending.get('om_first:open')!({ items: [{ ...detail(first, 'cli_first').items[0], mentions: message.mentions }] });
    expect(substituteMentionIdentities(await firstResult)[0].appId).toBe('cli_first');
    expect(message.mentions[0].id).toEqual({ open_id: 'ou_original' });
  });


  it.each(['', '  ', null])('marks an explicitly invalid empty App ID as invalid: %j', async appId => {
    const resolveRaw = vi.fn();
    const getProfile = vi.fn();
    const result = await resolveSubstituteTargets('cli_receiver', [
      { appId: 'cli_valid' }, { appId },
    ], { resolveRaw, getProfile });
    expect(result.invalidAppId).toBe(true);
    expect(result.resolution.some(entry => !entry.ok)).toBe(true);
    expect(resolveRaw).not.toHaveBeenCalled();
  });
});
