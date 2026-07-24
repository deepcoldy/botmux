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
const mockAddUsersByUnionId = vi.fn();
const mockAddBotToChat = vi.fn();
vi.mock('../src/services/groups-store.js', () => ({
  createChat: (...args: any[]) => mockCreateChat(...args),
  transferChatOwner: (...args: any[]) => mockTransferChatOwner(...args),
  getChatOwner: (...args: any[]) => mockGetChatOwner(...args),
  getChatShareLink: (...args: any[]) => mockGetChatShareLink(...args),
  addUsersToChatByUnionId: (...args: any[]) => mockAddUsersByUnionId(...args),
  addBotToChat: (...args: any[]) => mockAddBotToChat(...args),
}));

const SHARE_LINK = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok';

const mockSendMessage = vi.fn();
const mockListChatBotMembers = vi.fn();
const mockResolveAllowedUsersWithMap = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  listChatBotMembers: (...args: any[]) => mockListChatBotMembers(...args),
  resolveAllowedUsersWithMap: (...args: any[]) => mockResolveAllowedUsersWithMap(...args),
}));

const mockBindOncall = vi.fn();
vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: (...args: any[]) => mockBindOncall(...args),
}));

const mockReadRoleProfileEntry = vi.fn();
vi.mock('../src/services/role-profile-store.js', () => ({
  isValidRoleProfileId: (id: string) => /^[A-Za-z0-9._-]{1,64}$/.test(id) && id !== '.' && id !== '..',
  readRoleProfileEntry: (...args: any[]) => mockReadRoleProfileEntry(...args),
}));

const mockWriteRoleFile = vi.fn();
vi.mock('../src/core/role-resolver.js', () => ({
  writeRoleFile: (...args: any[]) => mockWriteRoleFile(...args),
}));

import { createGroupWithBots, transferGroupOwner } from '../src/services/group-creator.js';

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
    mockListChatBotMembers.mockReset();
    mockResolveAllowedUsersWithMap.mockReset();
    mockBindOncall.mockReset();
    mockAddUsersByUnionId.mockReset();
    mockAddBotToChat.mockReset();
    mockReadRoleProfileEntry.mockReset();
    mockWriteRoleFile.mockReset();
    // Default: share-link fetch succeeds. group-creator always calls this after
    // createChat; individual tests override to exercise the fallback path.
    mockGetChatShareLink.mockResolvedValue({ ok: true, shareLink: SHARE_LINK });
    mockAddUsersByUnionId.mockResolvedValue({ invalidUserIds: [] });
    mockResolveAllowedUsersWithMap.mockResolvedValue({ resolved: [], map: new Map() });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) =>
      ids.map(id => ({ id, ok: true })),
    );
  });

  it('pulls bot owners into the chat by union_id; reports invalidOwnerUnionIds', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_fed', invalidBotIds: [], invalidUserIds: [] });
    mockAddUsersByUnionId.mockResolvedValue({ invalidUserIds: ['on_gone'] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      name: 'fed',
      ownerUnionIds: ['on_me', 'on_gone'],
    });
    // owners added via union_id by the creator bot
    expect(mockAddUsersByUnionId).toHaveBeenCalledWith(CREATOR, 'oc_fed', ['on_me', 'on_gone']);
    expect(result.invalidOwnerUnionIds).toEqual(['on_gone']);
    expect(result.chatId).toBe('oc_fed');
  });

  it('resolves the team operator union_id in the creator app scope, then transfers and notifies', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_team', invalidBotIds: [], invalidUserIds: [] });
    mockResolveAllowedUsersWithMap.mockResolvedValue({
      resolved: [USER_OPEN_ID],
      map: new Map([['on_operator', USER_OPEN_ID]]),
    });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    mockSendMessage.mockResolvedValue('om_owner_notify');

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      ownerUnionIds: ['on_operator', 'on_other_owner'],
      transferOwnerUnionId: 'on_operator',
    });

    expect(mockResolveAllowedUsersWithMap).toHaveBeenCalledWith(CREATOR, ['on_operator']);
    expect(mockTransferChatOwner).toHaveBeenCalledWith(CREATOR, 'oc_team', USER_OPEN_ID);
    expect(mockSendMessage).toHaveBeenCalledWith(
      CREATOR,
      'oc_team',
      `<at user_id="${USER_OPEN_ID}"></at>`,
      'text',
    );
    expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
    expect(result.transferError).toBeNull();
    expect(result.notifyMessageId).toBe('om_owner_notify');
    expect(result.notifyError).toBeNull();
  });

  it('does not resolve or transfer when Lark rejected the operator union_id invite', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_team', invalidBotIds: [], invalidUserIds: [] });
    mockAddUsersByUnionId.mockResolvedValue({ invalidUserIds: ['on_operator'] });

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      ownerUnionIds: ['on_operator'],
      transferOwnerUnionId: 'on_operator',
    });

    expect(mockResolveAllowedUsersWithMap).not.toHaveBeenCalled();
    expect(mockTransferChatOwner).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.transferError).toBe('invitee_rejected');
    expect(result.notifyError).toBe('invitee_rejected');
  });

  it('skips the union_id owner add when no ownerUnionIds given', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] });
    const result = await createGroupWithBots({ creatorLarkAppId: CREATOR, larkAppIds: [CREATOR] });
    expect(mockAddUsersByUnionId).not.toHaveBeenCalled();
    expect(result.invalidOwnerUnionIds).toEqual([]);
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
      invalidOwnerUnionIds: [],
      ownerTransferredTo: USER_OPEN_ID,
      transferError: null,
      notifyMessageId: 'om_notify_1',
      notifyError: null,
      shareLink: SHARE_LINK,
      shareLinkError: null,
      oncallBindings: [],
      roleProfileBootstrapMessageId: null,
      roleProfileBootstrapError: null,
      kickoffMessageId: null,
      kickoffError: null,
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
    expect(args[1].botIds).toEqual([]);  // bots are added after createChat
    expect(mockAddBotToChat).toHaveBeenCalledWith(CREATOR, 'oc_x', [OTHER_BOT]);
  });

  it('reports chatId immediately after chat.create before invite and transfer work', async () => {
    const events: string[] = [];
    mockCreateChat.mockImplementation(async () => {
      events.push('create');
      return { chatId: 'oc_progress', invalidBotIds: [], invalidUserIds: [] };
    });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) => {
      events.push('invite');
      return ids.map(id => ({ id, ok: true }));
    });
    mockGetChatShareLink.mockImplementation(async () => {
      events.push('share-link');
      return { ok: true, shareLink: SHARE_LINK };
    });
    mockTransferChatOwner.mockImplementation(async () => {
      events.push('transfer');
      return { ok: true };
    });

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      transferOwnerTo: USER_OPEN_ID,
      onChatCreated: chatId => events.push(`progress:${chatId}`),
    });

    expect(result.chatId).toBe('oc_progress');
    expect(events).toEqual([
      'create',
      'progress:oc_progress',
      'invite',
      'share-link',
      'transfer',
    ]);
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
      invalidBotIds: [],
      invalidUserIds: [],
    });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) =>
      ids.map(id => id === 'cli_rejected_bot'
        ? { id, ok: false, error: 'invalid_id' }
        : { id, ok: true }),
    );
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
      invalidBotIds: [],
      invalidUserIds: ['ou_banned'],
    });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) =>
      ids.map(id => id === 'cli_zombie'
        ? { id, ok: false, error: 'invalid_id' }
        : { id, ok: true }),
    );
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, 'cli_zombie'],
      userOpenIds: ['ou_banned'],
    });
    expect(result.invalidBotIds).toEqual(['cli_zombie']);
    expect(result.invalidUserIds).toEqual(['ou_banned']);
  });

  it('sends kickoff using the target bot open_id observed by the creator app', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_kickoff', invalidBotIds: [], invalidUserIds: [] });
    mockListChatBotMembers.mockResolvedValue([
      { larkAppId: CREATOR, openId: 'ou_creator', mentionable: true },
      { larkAppId: OTHER_BOT, openId: 'ou_other_seen_by_creator', mentionable: true },
    ]);
    mockSendMessage.mockResolvedValue('om_kickoff');

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
    });

    expect(mockListChatBotMembers).toHaveBeenCalledWith(CREATOR, 'oc_kickoff');
    expect(mockSendMessage).toHaveBeenCalledWith(
      CREATOR,
      'oc_kickoff',
      '<at user_id="ou_other_seen_by_creator"></at> Review PR 562',
      'text',
    );
    expect(result.kickoffMessageId).toBe('om_kickoff');
    expect(result.kickoffError).toBeNull();
  });

  it('establishes collaboration after peer invitation and before role/kickoff messages', async () => {
    const events: string[] = [];
    mockCreateChat.mockResolvedValue({ chatId: 'oc_ordered', invalidBotIds: [], invalidUserIds: [] });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) => {
      events.push(`invite:${ids.join(',')}`);
      return ids.map(id => ({ id, ok: true }));
    });
    mockListChatBotMembers.mockResolvedValue([
      { larkAppId: CREATOR, openId: 'ou_creator', mentionable: true },
      { larkAppId: OTHER_BOT, openId: 'ou_other', mentionable: true },
    ]);
    mockReadRoleProfileEntry.mockReturnValue('creator role');
    mockSendMessage.mockImplementation(async (_app: string, _chatId: string, content: string) => {
      events.push(content.includes('/role profile') ? 'role' : 'kickoff');
      return content.includes('/role profile') ? 'om_role' : 'om_kickoff';
    });

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      roleProfileId: 'collab-main',
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
      ensureBotCollaboration: async (chatId, joinedBotAppIds, rejectedBotAppIds) => {
        events.push(`grant:${chatId}:${joinedBotAppIds.join(',')}:rejected=${rejectedBotAppIds.join(',')}`);
      },
    });

    expect(events).toEqual([
      `invite:${OTHER_BOT}`,
      `grant:oc_ordered:${CREATOR},${OTHER_BOT}:rejected=`,
      'role',
      'kickoff',
    ]);
    expect(result.roleProfileBootstrapMessageId).toBe('om_role');
    expect(result.kickoffMessageId).toBe('om_kickoff');
  });

  it('aborts cold-group initialization without role or kickoff when collaboration grant fails', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_grant_failed', invalidBotIds: [], invalidUserIds: [] });
    const onChatCreated = vi.fn();

    await expect(createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      roleProfileId: 'collab-main',
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
      onChatCreated,
      ensureBotCollaboration: async () => {
        throw new Error('exact grant matrix unavailable');
      },
    })).rejects.toThrow('exact grant matrix unavailable');

    expect(onChatCreated).toHaveBeenCalledWith('oc_grant_failed');
    expect(mockAddBotToChat).toHaveBeenCalled();
    expect(mockGetChatShareLink).not.toHaveBeenCalled();
    expect(mockReadRoleProfileEntry).not.toHaveBeenCalled();
    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('exposes rejected invitees to the strict preflight before any role or kickoff message', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_partial', invalidBotIds: [], invalidUserIds: [] });
    mockAddBotToChat.mockResolvedValue([{ id: OTHER_BOT, ok: false, error: 'invalid_id' }]);
    const ensureBotCollaboration = vi.fn(async (
      _chatId: string,
      _joinedBotAppIds: string[],
      rejectedBotAppIds: string[],
    ) => {
      if (rejectedBotAppIds.length > 0) throw new Error('bot_invites_incomplete');
    });

    await expect(createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      roleProfileId: 'collab-main',
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
      ensureBotCollaboration,
    })).rejects.toThrow('bot_invites_incomplete');

    expect(ensureBotCollaboration).toHaveBeenCalledWith(
      'oc_partial',
      [CREATOR],
      [OTHER_BOT],
    );
    expect(mockGetChatShareLink).not.toHaveBeenCalled();
    expect(mockReadRoleProfileEntry).not.toHaveBeenCalled();
    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not send kickoff when Lark rejected the target bot invite', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_kickoff', invalidBotIds: [], invalidUserIds: [] });
    mockAddBotToChat.mockResolvedValue([{ id: OTHER_BOT, ok: false, error: 'invalid_id' }]);

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
    });

    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.kickoffMessageId).toBeNull();
    expect(result.kickoffError).toBe('invitee_rejected');
  });

  it('surfaces an unmentionable kickoff target without aborting group creation', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_kickoff', invalidBotIds: [], invalidUserIds: [] });
    mockListChatBotMembers.mockResolvedValue([
      { larkAppId: OTHER_BOT, openId: 'ou_other_self_scope', mentionable: false },
    ]);

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.kickoffMessageId).toBeNull();
    expect(result.kickoffError).toBe('kickoff_bot_not_mentionable');
  });

  it('surfaces kickoff send failure without aborting group creation', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_kickoff', invalidBotIds: [], invalidUserIds: [] });
    mockListChatBotMembers.mockResolvedValue([
      { larkAppId: OTHER_BOT, openId: 'ou_other_seen_by_creator', mentionable: true },
    ]);
    mockSendMessage.mockRejectedValue(new Error('network down'));

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      kickoffBotLarkAppId: OTHER_BOT,
      kickoffPrompt: 'Review PR 562',
    });

    expect(result.chatId).toBe('oc_kickoff');
    expect(result.kickoffMessageId).toBeNull();
    expect(result.kickoffError).toBe('network down');
  });

  it('requires paired kickoff service arguments', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_kickoff', invalidBotIds: [], invalidUserIds: [] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      kickoffBotLarkAppId: OTHER_BOT,
    });

    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.kickoffError).toBe('kickoff_args_must_be_paired');
  });

  it('materializes the creator role directly and posts a bootstrap command for peers', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_profile', invalidBotIds: [], invalidUserIds: [] });
    mockListChatBotMembers.mockResolvedValue([
      { larkAppId: CREATOR, openId: 'ou_creator', mentionable: true, displayName: 'Creator' },
      { larkAppId: OTHER_BOT, openId: 'ou_other', mentionable: true, displayName: 'Other' },
    ]);
    mockSendMessage.mockResolvedValue('om_bootstrap');
    mockReadRoleProfileEntry.mockReturnValue('creator role');

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR, OTHER_BOT],
      roleProfileId: 'collab-main',
    });

    expect(mockReadRoleProfileEntry).toHaveBeenCalledWith(expect.any(String), 'collab-main', CREATOR);
    expect(mockWriteRoleFile).toHaveBeenCalledWith(CREATOR, 'oc_profile', 'creator role');
    expect(mockListChatBotMembers).toHaveBeenCalledWith(CREATOR, 'oc_profile');
    expect(mockSendMessage).toHaveBeenCalledWith(
      CREATOR,
      'oc_profile',
      '<at user_id="ou_other"></at> /role profile apply collab-main --quiet',
      'text',
    );
    expect(result.roleProfileBootstrapMessageId).toBe('om_bootstrap');
    expect(result.roleProfileBootstrapError).toBeNull();
  });

  it('does not post a bootstrap command for a creator-only role profile group', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_profile_solo', invalidBotIds: [], invalidUserIds: [] });
    mockReadRoleProfileEntry.mockReturnValue('solo creator role');

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      roleProfileId: 'collab-main',
    });

    expect(mockWriteRoleFile).toHaveBeenCalledWith(CREATOR, 'oc_profile_solo', 'solo creator role');
    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.roleProfileBootstrapMessageId).toBeNull();
    expect(result.roleProfileBootstrapError).toBeNull();
  });

  it('reports no_applicable_entries for a solo group whose creator has no profile entry', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_profile_noentry', invalidBotIds: [], invalidUserIds: [] });
    mockReadRoleProfileEntry.mockReturnValue(null);

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      roleProfileId: 'collab-main',
    });

    expect(mockWriteRoleFile).not.toHaveBeenCalled();
    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.roleProfileBootstrapMessageId).toBeNull();
    expect(result.roleProfileBootstrapError).toBe('no_applicable_entries');
  });

  it('treats a solo group creator with an explicit empty entry as a valid (clear) entry', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_profile_empty', invalidBotIds: [], invalidUserIds: [] });
    mockReadRoleProfileEntry.mockReturnValue(''); // explicit empty entry = clear, not missing

    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      roleProfileId: 'collab-main',
    });

    // Nothing to write on a fresh chat, but '' is a real entry → not flagged.
    expect(mockWriteRoleFile).not.toHaveBeenCalled();
    expect(mockListChatBotMembers).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.roleProfileBootstrapMessageId).toBeNull();
    expect(result.roleProfileBootstrapError).toBeNull();
  });
});

describe('transferGroupOwner', () => {
  beforeEach(() => {
    mockTransferChatOwner.mockReset();
    mockGetChatOwner.mockReset();
  });

  it('uses union_id for a deferred cross-deployment transfer', async () => {
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    const result = await transferGroupOwner({
      creatorLarkAppId: CREATOR,
      chatId: 'oc_deferred',
      ownerId: 'on_operator',
      ownerIdType: 'union_id',
    });
    expect(mockTransferChatOwner).toHaveBeenCalledWith(
      CREATOR, 'oc_deferred', 'on_operator', 'union_id',
    );
    expect(result).toEqual({ ownerTransferredTo: 'on_operator', transferError: null });
  });

  it('verifies an ambiguous union_id transfer using the same id type', async () => {
    mockTransferChatOwner.mockResolvedValue({ ok: false, error: 'timeout' });
    mockGetChatOwner.mockResolvedValue('on_operator');
    const result = await transferGroupOwner({
      creatorLarkAppId: CREATOR,
      chatId: 'oc_deferred',
      ownerId: 'on_operator',
      ownerIdType: 'union_id',
    });
    expect(mockGetChatOwner).toHaveBeenCalledWith(CREATOR, 'oc_deferred', 'union_id');
    expect(result).toEqual({ ownerTransferredTo: 'on_operator', transferError: null });
  });
});
