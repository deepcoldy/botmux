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
 *  - sendMessage throw surfaces as `notifyError`, chatId still returned
 *  - createChat throw bubbles up (caller decides exit code)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCreateChat = vi.fn();
const mockTransferChatOwner = vi.fn();
vi.mock('../src/services/groups-store.js', () => ({
  createChat: (...args: any[]) => mockCreateChat(...args),
  transferChatOwner: (...args: any[]) => mockTransferChatOwner(...args),
}));

const mockSendMessage = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
}));

import { createGroupWithBots } from '../src/services/group-creator.js';

const CREATOR = 'cli_creator_app';
const OTHER_BOT = 'cli_other_bot';
const USER_OPEN_ID = 'ou_user_alice';

describe('createGroupWithBots', () => {
  beforeEach(() => {
    mockCreateChat.mockReset();
    mockTransferChatOwner.mockReset();
    mockSendMessage.mockReset();
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
    });
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
