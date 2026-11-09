/** Disband permission is claimed only when Feishu's chat info proves this bot owns the group. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({}) }));
vi.mock('../src/im/lark/client.js', () => ({ larkGet: h.get }));
import { botProvablyOwnsChat } from '../src/services/groups-store.js';

/** A bot-owned group as Feishu returns it: no owner fields, counts as strings. */
const botOwned = { chat_mode: 'group', chat_status: 'normal', group_message_type: 'chat', bot_count: '1', user_count: '3', agent_count: '0', external: false };
const answer = (data: Record<string, unknown>, code = 0) => h.get.mockResolvedValue({ code, msg: code ? 'error' : 'success', data });
beforeEach(() => { h.get.mockReset(); });

describe('botProvablyOwnsChat', () => {
  it.each([['group', botOwned], ['topic group', { ...botOwned, chat_mode: 'topic', group_message_type: 'thread' }]])(
    'accepts a %s with no owner and no other bot', async (_shape, data) => {
      answer(data);
      expect(await botProvablyOwnsChat('cli_test', 'oc_test')).toBe(true);
      expect(h.get).toHaveBeenCalledWith(expect.anything(), '/open-apis/im/v1/chats/oc_test', {}, { timeoutMs: expect.any(Number) });
    });
  it.each([
    ['a human owner', { ...botOwned, owner_id_type: 'open_id', owner_id: 'ou_owner' }],
    ['an owner id alone', { ...botOwned, owner_id: 'ou_owner' }],
    ['an owner id type alone', { ...botOwned, owner_id_type: 'open_id' }],
    ['a second bot', { ...botOwned, bot_count: '2' }],
    ['no bot count', { ...botOwned, bot_count: undefined }],
    ['an agent', { ...botOwned, agent_count: '1' }],
    ['no agent count', { ...botOwned, agent_count: undefined }],
    ['a dissolved group', { ...botOwned, chat_status: 'dissolved' }],
    ['a DM', { ...botOwned, chat_mode: 'p2p' }],
  ])('refuses %s', async (_shape, data) => {
    answer(data);
    expect(await botProvablyOwnsChat('cli_test', 'oc_test')).toBe(false);
  });
  it('refuses when Feishu answers with an error or not at all', async () => {
    answer(botOwned, 232011);
    expect(await botProvablyOwnsChat('cli_test', 'oc_test')).toBe(false);
    h.get.mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    expect(await botProvablyOwnsChat('cli_test', 'oc_test')).toBe(false);
  });
});
