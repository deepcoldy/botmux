/**
 * Unit tests for `createGroupWithBots` service. Mocks the underlying
 * groups-store + Lark client so no real API calls happen.
 *
 * Coverage:
 *  - happy path returns expected fields
 *  - creator self-filter (creator should not appear in bot_id_list)
 *  - invalidUserIds includes transferTo → skip transfer with 'invitee_rejected'
 *  - invalidUserIds includes notifyTo → skip notify with 'invitee_rejected'
 *  - transferChatOwner failure surfaces as `transferError`, chatId still returned
 *  - transferChatOwner error but getChatOwner confirms target → treated as success
 *    (Lark slow-ACK / 504 false-negative recovery)
 *  - sendMessage throw surfaces as `notifyError`, chatId still returned
 *  - createChat throw bubbles up (caller decides exit code)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCreateChat = vi.fn();
const mockTransferChatOwner = vi.fn();
const mockGetChatOwner = vi.fn();
const mockGetChatShareLink = vi.fn();
vi.mock('../src/services/groups-store.js', () => ({
  createChat: (...args: any[]) => mockCreateChat(...args),
  transferChatOwner: (...args: any[]) => mockTransferChatOwner(...args),
  getChatOwner: (...args: any[]) => mockGetChatOwner(...args),
  getChatShareLink: (...args: any[]) => mockGetChatShareLink(...args),
}));

const SHARE_LINK = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok';

const mockSendMessage = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
}));

const mockBindOncall = vi.fn();
vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: (...args: any[]) => mockBindOncall(...args),
}));

import { createGroupWithBots } from '../src/services/group-creator.js';

const CREATOR = 'cli_creator_app';
const OTHER_BOT = 'cli_other_bot';
const USER_OPEN_ID = 'ou_user_alice';

describe('createGroupWithBots', () => {
  beforeEach(() => {
    mockCreateChat.mockReset();
    mockTransferChatOwner.mockReset();
    mockGetChatOwner.mockReset();
    mockGetChatShareLink.mockReset();
    mockSendMessage.mockReset();
    mockBindOncall.mockReset();
    // Default: share-link fetch succeeds. group-creator always calls this after
    // createChat; individual tests override to exercise the fallback path.
    mockGetChatShareLink.mockResolvedValue({ ok: true, shareLink: SHARE_LINK });
  });

  it('returns chatId + all status fields on a clean happy path', async () => {
    mockCreateChat.mockResolvedValue({
      chatId: 'oc_new_chat',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    mockSendMessage.mockResolvedValue('om_notify_1');

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      name: 'test',
      userOpenIds: [USER_OPEN_ID],
      transferOwnerTo: USER_OPEN_ID,
      notifyOwnerOpenId: USER_OPEN_ID,
    });

    expect(result).toEqual({
      ok: true,
      chatId: 'oc_new_chat',
      creator: CREATOR,
      invalidBotIds: [],
      invalidUserIds: [],
      ownerTransferredTo: USER_OPEN_ID,
      transferError: null,
      notifyMessageId: 'om_notify_1',
      notifyError: null,
      shareLink: SHARE_LINK,
      shareLinkError: null,
      oncallBindings: [],
    });
  });

  it('falls back (shareLink null + shareLinkError set) when the link API fails', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    mockGetChatShareLink.mockResolvedValue({ ok: false, error: 'unsupported chat type (code: 232001)' });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
    });
    expect(result.chatId).toBe('oc_x');
    expect(result.shareLink).toBeNull();
    expect(result.shareLinkError).toBe('unsupported chat type (code: 232001)');
  });

  it('filters creator out of bot_id_list before calling createChat', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT, CREATOR],  // creator listed twice + another bot
    });
    expect(mockCreateChat).toHaveBeenCalledTimes(1);
    const args = mockCreateChat.mock.calls[0];
    expect(args[0]).toBe(CREATOR);
    expect(args[1].botIds).toEqual([OTHER_BOT]);  // creator filtered out
  });

  it('skips transfer when invitee was rejected by Lark', async () => {
    mockCreateChat.mockResolvedValue({
      chatId: 'oc_x',
      invalidBotIds: [],
      invalidUserIds: [USER_OPEN_ID],
    });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      transferOwnerTo: USER_OPEN_ID,
    });
    expect(mockTransferChatOwner).not.toHaveBeenCalled();
    expect(result.ownerTransferredTo).toBeNull();
    expect(result.transferError).toBe('invitee_rejected');
  });

  it('skips notify when invitee was rejected by Lark', async () => {
    mockCreateChat.mockResolvedValue({
      chatId: 'oc_x',
      invalidBotIds: [],
      invalidUserIds: [USER_OPEN_ID],
    });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      notifyOwnerOpenId: USER_OPEN_ID,
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.notifyMessageId).toBeNull();
    expect(result.notifyError).toBe('invitee_rejected');
  });

  it('surfaces transferChatOwner failure as transferError without aborting', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: false, error: 'permission_denied' });
    // Readback confirms the transfer really did NOT happen (owner is still
    // someone other than the target), so the error must surface.
    mockGetChatOwner.mockResolvedValue('ou_still_the_bot');
    mockSendMessage.mockResolvedValue('om_notify');
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      transferOwnerTo: USER_OPEN_ID,
      notifyOwnerOpenId: USER_OPEN_ID,
    });
    expect(result.chatId).toBe('oc_x');
    expect(result.ownerTransferredTo).toBeNull();
    expect(result.transferError).toBe('permission_denied');
    // notify still ran
    expect(result.notifyMessageId).toBe('om_notify');
    expect(result.notifyError).toBeNull();
  });

  it('treats a transfer error as success when getChatOwner confirms the target', async () => {
    // Lark sometimes returns 504/transient errors on owner transfer even though
    // the write committed. group-creator reads back the owner; if it already
    // matches the target, the transfer really succeeded and no error surfaces.
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: false, error: 'gateway_timeout' });
    mockGetChatOwner.mockResolvedValue(USER_OPEN_ID);
    mockSendMessage.mockResolvedValue('om_notify');
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      transferOwnerTo: USER_OPEN_ID,
      notifyOwnerOpenId: USER_OPEN_ID,
    });
    expect(mockGetChatOwner).toHaveBeenCalledWith(CREATOR, 'oc_x');
    expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
    expect(result.transferError).toBeNull();
  });

  it('surfaces sendMessage throw as notifyError without aborting', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    mockSendMessage.mockRejectedValue(new Error('network down'));
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      transferOwnerTo: USER_OPEN_ID,
      notifyOwnerOpenId: USER_OPEN_ID,
    });
    expect(result.chatId).toBe('oc_x');
    expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
    expect(result.notifyMessageId).toBeNull();
    expect(result.notifyError).toBe('network down');
  });

  it('rethrows when createChat itself fails', async () => {
    mockCreateChat.mockRejectedValue(new Error('bad app secret'));
    await expect(createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
    })).rejects.toThrow('bad app secret');
  });

  it('binds the newly created chat for joined bots when bindWorkingDir is provided', async () => {
    mockCreateChat.mockResolvedValue({
      chatId: 'oc_bound',
      invalidBotIds: ['cli_rejected_bot'],
      invalidUserIds: [],
    });
    mockBindOncall.mockResolvedValue({ ok: true, created: true });

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT, 'cli_rejected_bot'],
      bindWorkingDir: '~/projects/botmux',
    });

    expect(mockBindOncall).toHaveBeenCalledTimes(2);
    expect(mockBindOncall).toHaveBeenNthCalledWith(1, CREATOR, 'oc_bound', '~/projects/botmux');
    expect(mockBindOncall).toHaveBeenNthCalledWith(2, OTHER_BOT, 'oc_bound', '~/projects/botmux');
    expect(result.oncallBindings).toEqual([
      { larkAppId: CREATOR, ok: true, created: true },
      { larkAppId: OTHER_BOT, ok: true, created: true },
    ]);
  });

  it('reports per-bot oncall bind failures without aborting group creation', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_bound', invalidBotIds: [], invalidUserIds: [] });
    mockBindOncall
      .mockResolvedValueOnce({ ok: true, created: false })
      .mockResolvedValueOnce({ ok: false, reason: 'bot_not_in_config' });

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      bindWorkingDir: '/repo',
    });

    expect(result.chatId).toBe('oc_bound');
    expect(result.oncallBindings).toEqual([
      { larkAppId: CREATOR, ok: true, created: false },
      { larkAppId: OTHER_BOT, ok: false, error: 'bot_not_in_config' },
    ]);
  });

  it('omits transfer/notify steps entirely when targets are not provided', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
    });
    expect(mockTransferChatOwner).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.transferError).toBeNull();
    expect(result.notifyError).toBeNull();
  });

  it('reports invalidBotIds/invalidUserIds passthrough from createChat', async () => {
    mockCreateChat.mockResolvedValue({
      chatId: 'oc_x',
      invalidBotIds: ['cli_zombie'],
      invalidUserIds: ['ou_banned'],
    });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, 'cli_zombie'],
      userOpenIds: ['ou_banned'],
    });
    expect(result.invalidBotIds).toEqual(['cli_zombie']);
    expect(result.invalidUserIds).toEqual(['ou_banned']);
  });
});
