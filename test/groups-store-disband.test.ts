/** Group deletion needs an explicit API success acknowledgement; a gone chat needs an explicit answer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ remove: vi.fn(), get: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({ im: { v1: { chat: { delete: h.remove } } } }) }));
vi.mock('../src/im/lark/client.js', () => ({ larkGet: h.get }));
import { disbandChat, probeChatGone } from '../src/services/groups-store.js';
beforeEach(() => { h.remove.mockReset(); h.get.mockReset(); });
describe('disbandChat', () => {
  it('deletes only the requested chat', async () => {
    h.remove.mockResolvedValue({ code: 0 });
    expect(await disbandChat('cli_test', 'oc_test')).toEqual({ ok: true });
    expect(h.remove).toHaveBeenCalledWith({ path: { chat_id: 'oc_test' } });
  });
  it.each([undefined, {}, { code: 230001, msg: 'denied' }])('does not claim success for %j', async result => {
    h.remove.mockResolvedValue(result);
    expect((await disbandChat('cli_test', 'oc_test')).ok).toBe(false);
  });
});

// Response shapes observed on real chats: a disbanded chat and one the bot was
// removed from both still answer chat info with code 0.
const info = (chatStatus: string) => ({ code: 0, data: { chat_status: chatStatus, bot_count: '0' } });
const inChat = (isInChat: boolean) => ({ code: 0, data: { is_in_chat: isInChat } });
describe('probeChatGone', () => {
  function answer(chat: unknown, member?: unknown) {
    h.get.mockImplementation(async (_client: unknown, path: string) => {
      const value = path.endsWith('/members/is_in_chat') ? member : chat;
      if (value instanceof Error) throw value;
      return value;
    });
  }
  it.each(['dissolved', 'dissolved_save'])('reports a %s chat as disbanded', async status => {
    answer(info(status));
    expect(await probeChatGone('cli_test', 'oc_test')).toBe('disbanded');
  });
  it('reports a normal chat without this bot as bot_removed', async () => {
    answer(info('normal'), inChat(false));
    expect(await probeChatGone('cli_test', 'oc_test')).toBe('bot_removed');
    expect(h.get).toHaveBeenCalledWith(expect.anything(), '/open-apis/im/v1/chats/oc_test/members/is_in_chat');
  });
  it.each([
    ['a chat the bot is still in', info('normal'), inChat(true)],
    ['a chat info error', { code: 99992356, msg: 'invalid chat' }, inChat(false)],
    ['a missing status', { code: 0, data: {} }, inChat(false)],
    ['a membership error', info('normal'), { code: 232011, msg: 'operator not in chat' }],
    ['a membership answer without the flag', info('normal'), { code: 0, data: {} }],
    ['a thrown request', new Error('network'), inChat(false)],
  ])('never reports gone for %s', async (_label, chat, member) => {
    answer(chat, member);
    expect(await probeChatGone('cli_test', 'oc_test')).toBeUndefined();
  });
});
