import { beforeEach, describe, expect, it, vi } from 'vitest';
const getMessageDetail = vi.hoisted(() => vi.fn());
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail }));
import { resolveSubstituteAppMentions, substituteMentionIdentities } from '../src/im/lark/substitute-app-mentions.js';

const message = {
  message_id: 'om_probe', chat_id: 'oc_probe', message_type: 'text',
  content: JSON.stringify({ text: '@_user_1 hello' }),
  mentions: [{ key: '@_user_1', name: 'Same name', id: { open_id: 'ou_observed' } }],
};
const canonical = () => ({
  message_id: message.message_id, chat_id: message.chat_id, msg_type: 'text',
  body: { content: message.content },
  mentions: [{ key: '@_user_1', name: 'Same name', id: 'cli_external', id_type: 'app_id' }],
});
const reply = (item: any, options: any) => ({ items: [{ ...item, mentions: options?.userIdType ? item.mentions : message.mentions }] });
beforeEach(() => { getMessageDetail.mockReset().mockImplementation((_app, _id, options) => Promise.resolve(reply(canonical(), options))); });

describe('stable App ID mention recovery', () => {
  it('uses the exact REST message app_id and preserves the event Open ID', async () => {
    const resolved = await resolveSubstituteAppMentions('cli_receiver', message);
    expect(substituteMentionIdentities(resolved)[0]).toMatchObject({ appId: 'cli_external', openId: 'ou_observed' });
    expect(message.mentions[0].id).toEqual({ open_id: 'ou_observed' });
    expect(getMessageDetail).toHaveBeenCalledWith('cli_receiver', 'om_probe', expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });
  it.each([
    { message_id: 'om_other' }, { chat_id: 'oc_other' }, { msg_type: 'interactive' },
    { body: { content: JSON.stringify({ text: '@_user_1 edited' }) } },
  ])('does not bind from a different or edited message: %j', async patch => {
    getMessageDetail.mockImplementation((_app, _id, options) => Promise.resolve(reply({ ...canonical(), ...patch }, options)));
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });
  it('never guesses from a same-name person and fails closed on API failure', async () => {
    getMessageDetail.mockResolvedValueOnce({ items: [{ ...canonical(), mentions: [{ key: '@_user_1', name: 'Same name', id: 'ou_person', id_type: 'open_id' }] }] });
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
    getMessageDetail.mockRejectedValueOnce(new Error('timeout'));
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });
  it.each(['interactive', 'merge_forward', 'image'])('does not fetch inherited %s mentions', async message_type => {
    expect(await resolveSubstituteAppMentions('cli_receiver', { ...message, message_type })).toMatchObject({ message_type });
    expect(getMessageDetail).not.toHaveBeenCalled();
  });
  it('does not fetch messages without a real mention or already carrying stable App IDs', async () => {
    await resolveSubstituteAppMentions('cli_receiver', { ...message, mentions: [] });
    await resolveSubstituteAppMentions('cli_receiver', { ...message, mentions: canonical().mentions });
    expect(getMessageDetail).not.toHaveBeenCalled();
  });
});
