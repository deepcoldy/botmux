/**
 * Unit tests for groups-store wrappers (Lark im/v1 chat APIs).
 *
 * Run:  pnpm vitest run test/groups-store.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chat.create is configurable per test via this stub so we can test both the
// happy path and error responses.
const chatCreateStub = vi.fn();
// chat.update mocks the owner-transfer call.
const chatUpdateStub = vi.fn();
// chat.link mocks the share-link fetch.
const chatLinkStub = vi.fn();

// Mock bot-registry's getBotClient — that's where groups-store imports from.
// Read-only GETs (listChats / isInChat / getChatOwner) now go through
// `client.request()` to avoid the empty-GET-body 411; mutating calls
// (chat.create / chat.update / chatMembers.create) stay on generated methods.
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn().mockImplementation(() => ({
    request: vi.fn().mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes('/members/is_in_chat')) {
        return { code: 0, data: { is_in_chat: true } };
      }
      if (/\/open-apis\/im\/v1\/chats$/.test(url)) {
        return {
          code: 0,
          data: {
            items: [
              {
                chat_id: 'c1',
                name: 'one',
                description: 'first chat',
                chat_mode: 'group',
                owner_id: 'ou_owner',
                avatar: 'https://avatar.example/c1.png',
              },
            ],
            has_more: false,
          },
        };
      }
      // getChatOwner: GET /open-apis/im/v1/chats/<id>
      if (/\/open-apis\/im\/v1\/chats\/[^/]+$/.test(url)) {
        return { code: 0, data: { owner_id: 'ou_owner' } };
      }
      throw new Error(`unexpected GET url in mock: ${url}`);
    }),
    im: {
      v1: {
        chat: {
          create: chatCreateStub,
          update: chatUpdateStub,
          link: chatLinkStub,
        },
        chatMembers: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { invalid_id_list: ['cli_X'] },
          }),
        },
      },
    },
  })),
}));

import { listChats, isInChat, addBotToChat, createChat, transferChatOwner, getChatShareLink } from '../src/services/groups-store.js';

describe('groups-store wrappers', () => {
  beforeEach(() => { chatCreateStub.mockClear(); chatUpdateStub.mockClear(); chatLinkStub.mockReset(); });

  it('listChats returns ChatBrief array', async () => {
    const out = await listChats('appA');
    expect(out).toHaveLength(1);
    expect(out[0].chatId).toBe('c1');
    expect(out[0].name).toBe('one');
    expect(out[0].description).toBe('first chat');
    expect(out[0].chatMode).toBe('group');
    expect(out[0].ownerId).toBe('ou_owner');
    expect(out[0].avatar).toBe('https://avatar.example/c1.png');
  });

  it('isInChat returns boolean', async () => {
    expect(await isInChat('appA', 'c1')).toBe(true);
  });

  it('addBotToChat marks invalid_id_list as failed and rest as ok', async () => {
    const r = await addBotToChat('appA', 'c1', ['cli_Y', 'cli_X']);
    expect(r.find(x => x.id === 'cli_Y')!.ok).toBe(true);
    expect(r.find(x => x.id === 'cli_X')!.ok).toBe(false);
    expect(r.find(x => x.id === 'cli_X')!.error).toBe('invalid_id');
  });

  it('addBotToChat with empty list returns empty', async () => {
    expect(await addBotToChat('appA', 'c1', [])).toEqual([]);
  });

  it('createChat returns chatId and forwards bot list (excluding creator)', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_new123', invalid_bot_id_list: [] },
    });
    const r = await createChat('cli_creator', { name: 'team', botIds: ['cli_creator', 'cli_other'] });
    expect(r.chatId).toBe('oc_new123');
    expect(r.invalidBotIds).toEqual([]);
    // Verify bot_id_list passed only the non-creator ids.
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.name).toBe('team');
    expect(callArgs.data.bot_id_list).toEqual(['cli_other']);
  });

  it('createChat omits bot_id_list when only creator is in the bot list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_solo' },
    });
    await createChat('cli_creator', { botIds: ['cli_creator'] });
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.bot_id_list).toBeUndefined();
    expect(callArgs.data.name).toBeUndefined();
  });

  it('createChat throws on non-zero Lark response', async () => {
    chatCreateStub.mockResolvedValueOnce({ code: 1234, msg: 'permission denied' });
    await expect(createChat('cli_creator', { botIds: ['cli_x'] })).rejects.toThrow(/permission denied/);
  });

  it('createChat surfaces invalid_bot_id_list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_partial', invalid_bot_id_list: ['cli_bad'] },
    });
    const r = await createChat('cli_creator', { botIds: ['cli_creator', 'cli_good', 'cli_bad'] });
    expect(r.invalidBotIds).toEqual(['cli_bad']);
  });

  it('createChat passes userIds as user_id_list with user_id_type=open_id', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_with_user', invalid_bot_id_list: [], invalid_user_id_list: [] },
    });
    const r = await createChat('cli_creator', {
      botIds: ['cli_creator'],
      userIds: ['ou_human123'],
    });
    expect(r.chatId).toBe('oc_with_user');
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.user_id_list).toEqual(['ou_human123']);
    expect(callArgs.params.user_id_type).toBe('open_id');
    // creator is the only bot in opts.botIds, so bot_id_list should be omitted.
    expect(callArgs.data.bot_id_list).toBeUndefined();
  });

  it('createChat surfaces invalid_user_id_list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_partial_user', invalid_bot_id_list: [], invalid_user_id_list: ['ou_ghost'] },
    });
    const r = await createChat('cli_creator', {
      botIds: ['cli_creator'],
      userIds: ['ou_real', 'ou_ghost'],
    });
    expect(r.invalidUserIds).toEqual(['ou_ghost']);
  });

  it('transferChatOwner posts owner_id with user_id_type=open_id', async () => {
    chatUpdateStub.mockResolvedValueOnce({ code: 0 });
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_human');
    expect(r).toEqual({ ok: true });
    const call = chatUpdateStub.mock.calls[0][0];
    expect(call.path.chat_id).toBe('oc_chat');
    expect(call.params.user_id_type).toBe('open_id');
    expect(call.data.owner_id).toBe('ou_human');
  });

  it('transferChatOwner returns error on non-zero Lark response', async () => {
    chatUpdateStub.mockResolvedValueOnce({ code: 230002, msg: 'user not in chat' });
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/user not in chat/);
  });

  it('transferChatOwner catches thrown errors', async () => {
    chatUpdateStub.mockRejectedValueOnce(new Error('network down'));
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/network down/);
  });

  it('createChat omits user_id_list and user_id_type when no userIds provided', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_no_user' },
    });
    await createChat('cli_creator', { botIds: ['cli_creator', 'cli_other'] });
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.user_id_list).toBeUndefined();
    expect(callArgs.params?.user_id_type).toBeUndefined();
  });

  it('getChatShareLink returns share_link and passes validity_period (default permanently)', async () => {
    chatLinkStub.mockResolvedValueOnce({
      code: 0,
      data: { share_link: 'https://applink.feishu.cn/.../add_by_link?link_token=tok', is_permanent: true },
    });
    const r = await getChatShareLink('cli_creator', 'oc_chat');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shareLink).toMatch(/add_by_link/);
    const callArgs = chatLinkStub.mock.calls[0][0];
    expect(callArgs.path.chat_id).toBe('oc_chat');
    expect(callArgs.data.validity_period).toBe('permanently');
  });

  it('getChatShareLink surfaces non-zero code as error (e.g. unsupported chat type)', async () => {
    chatLinkStub.mockResolvedValueOnce({ code: 232001, msg: 'unsupported chat type' });
    const r = await getChatShareLink('cli_creator', 'oc_p2p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported chat type.*232001/);
  });

  it('getChatShareLink treats empty share_link as error', async () => {
    chatLinkStub.mockResolvedValueOnce({ code: 0, data: {} });
    const r = await getChatShareLink('cli_creator', 'oc_chat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty share_link/);
  });

  it('getChatShareLink catches thrown errors', async () => {
    chatLinkStub.mockRejectedValueOnce(new Error('network down'));
    const r = await getChatShareLink('cli_creator', 'oc_chat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/network down/);
  });
});
