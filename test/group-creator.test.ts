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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockCreateChat = vi.fn();
const mockTransferChatOwner = vi.fn();
const mockGetChatOwner = vi.fn();
const mockGetChatShareLink = vi.fn();
const mockAddUsersByUnionId = vi.fn();
const mockAddBotToChat = vi.fn();
const mockAddChatManagers = vi.fn();
vi.mock('../src/services/groups-store.js', () => ({
  createChat: (...args: any[]) => mockCreateChat(...args),
  transferChatOwner: (...args: any[]) => mockTransferChatOwner(...args),
  getChatOwner: (...args: any[]) => mockGetChatOwner(...args),
  getChatShareLink: (...args: any[]) => mockGetChatShareLink(...args),
  addUsersToChatByUnionId: (...args: any[]) => mockAddUsersByUnionId(...args),
  addBotToChat: (...args: any[]) => mockAddBotToChat(...args),
  addChatManagers: (...args: any[]) => mockAddChatManagers(...args),
}));

const SHARE_LINK = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok';

const mockSendMessage = vi.fn();
const mockListChatBotMembers = vi.fn();
const mockResolveAllowedUsersWithMap = vi.fn();
const mockResolveUnionIdStrict = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  listChatBotMembers: (...args: any[]) => mockListChatBotMembers(...args),
  resolveAllowedUsersWithMap: (...args: any[]) => mockResolveAllowedUsersWithMap(...args),
  resolveUnionIdFromOpenIdStrict: (...args: any[]) => mockResolveUnionIdStrict(...args),
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

const mockNameAvatar = vi.fn();
const mockPersonalTag = vi.fn();
vi.mock('../src/services/group-name-avatar.js', () => ({ applyGroupNameAvatar: (...args: any[]) => mockNameAvatar(...args) }));
vi.mock('../src/services/feed-group-tagger.js', () => ({ addCreatedChatToFeedGroup: (...args: any[]) => mockPersonalTag(...args) }));
const mockLogoAvatar = vi.fn();
vi.mock('../src/services/session-group-avatar.js', () => ({ applyLogoGroupAvatar: (...args: any[]) => mockLogoAvatar(...args) }));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGroupWithBots, transferGroupOwner } from '../src/services/group-creator.js';
import { isStewardSilentJoin } from '../src/services/steward-auto-join.js';
import { adminListFingerprint, writeBotAdminUnions } from '../src/services/bot-admin-unions-store.js';
import { config } from '../src/config.js';

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
    mockAddChatManagers.mockReset();
    mockReadRoleProfileEntry.mockReset();
    mockWriteRoleFile.mockReset();
    // Default: share-link fetch succeeds. group-creator always calls this after
    // createChat; individual tests override to exercise the fallback path.
    mockGetChatShareLink.mockResolvedValue({ ok: true, shareLink: SHARE_LINK });
    mockAddUsersByUnionId.mockResolvedValue({ invalidUserIds: [] });
    mockAddChatManagers.mockResolvedValue({ ok: true, addedManagers: [] });
    mockResolveAllowedUsersWithMap.mockResolvedValue({ resolved: [], map: new Map() });
    mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) =>
      ids.map(id => ({ id, ok: true })),
    );
  });

  it('invites teammates before waiting for optional personal tagging', async () => {
    let release!: () => void;
    mockCreateChat.mockResolvedValue({ chatId: 'oc_pending_tag', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    mockPersonalTag.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    const task = createGroupWithBots({
      creatorLarkAppId: CREATOR, larkAppIds: [CREATOR, OTHER_BOT], name: 'Project',
      transferOwnerTo: USER_OPEN_ID,
      customization: { tag: 'Work', userOpenId: USER_OPEN_ID },
    });
    try {
      await vi.waitFor(() => expect(mockPersonalTag).toHaveBeenCalled());
      expect(mockAddBotToChat).toHaveBeenCalledWith(CREATOR, 'oc_pending_tag', [OTHER_BOT]);
      expect(mockAddBotToChat.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockPersonalTag.mock.invocationCallOrder.at(-1)!);
    } finally {
      release();
      await task;
    }
  });

  it('runs avatar before transfer and personal tag after transfer, preserving the group on independent failures', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_custom', invalidBotIds: [], invalidUserIds: [] });
    mockNameAvatar.mockRejectedValueOnce(new Error('no font'));
    mockPersonalTag.mockRejectedValueOnce(new Error('no user token'));
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], name: 'Project', transferOwnerTo: USER_OPEN_ID,
      customization: { tag: 'Work', avatar: 'name', userOpenId: USER_OPEN_ID },
    });
    expect(result.chatId).toBe('oc_custom');
    expect(result.customization).toEqual({ avatarError: 'no font', tagError: 'no user token' });
    expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
    expect(mockNameAvatar.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockTransferChatOwner.mock.invocationCallOrder.at(-1)!);
    expect(mockTransferChatOwner.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockPersonalTag.mock.invocationCallOrder.at(-1)!);
    expect(mockPersonalTag).toHaveBeenCalledWith(CREATOR, 'oc_custom', USER_OPEN_ID, 'Work');
    expect(mockCreateChat).toHaveBeenCalledTimes(1);
  });

  it('applies the logo avatar (not the name renderer) before transfer and reports its failure', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_logo', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    mockLogoAvatar.mockReset();
    mockNameAvatar.mockReset();
    mockLogoAvatar.mockResolvedValueOnce('glacier');
    const ok = await createGroupWithBots({
      creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], name: '新会话 10/17 14:30', transferOwnerTo: USER_OPEN_ID,
      customization: { avatar: 'logo', userOpenId: USER_OPEN_ID },
    });
    expect(ok.customization).toEqual({});
    expect(mockLogoAvatar).toHaveBeenCalledWith(CREATOR, 'oc_logo');
    expect(mockNameAvatar).not.toHaveBeenCalled();
    expect(mockLogoAvatar.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockTransferChatOwner.mock.invocationCallOrder.at(-1)!);

    mockLogoAvatar.mockRejectedValueOnce(new Error('avatar upload failed (glacier)'));
    const failed = await createGroupWithBots({
      creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], name: 'X', transferOwnerTo: USER_OPEN_ID,
      customization: { avatar: 'logo', userOpenId: USER_OPEN_ID },
    });
    expect(failed.chatId).toBe('oc_logo');
    expect(failed.customization).toEqual({ avatarError: 'avatar upload failed (glacier)' });
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
      expect.stringMatching(new RegExp(`^<at user_id="${USER_OPEN_ID}"></at> (群已创建|The group is ready)`)),
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
      managersAdded: [],
      managerError: null,
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

  it('forwards chatMode to createChat (topic group)', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_topic', invalidBotIds: [], invalidUserIds: [] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      chatMode: 'topic',
    });
    expect(result.chatId).toBe('oc_topic');
    expect(mockCreateChat).toHaveBeenCalledTimes(1);
    expect(mockCreateChat.mock.calls[0][1].chatMode).toBe('topic');
  });

  it('leaves chatMode undefined when the caller does not ask for a topology', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_default', invalidBotIds: [], invalidUserIds: [] });
    await createGroupWithBots({ creatorLarkAppId: CREATOR, larkAppIds: [CREATOR] });
    expect(mockCreateChat.mock.calls[0][1].chatMode).toBeUndefined();
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

  it('adds group managers when managerUserIds is provided', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_mgr', invalidBotIds: [], invalidUserIds: [] });
    mockAddChatManagers.mockResolvedValue({ ok: true, addedManagers: [USER_OPEN_ID] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      userOpenIds: [USER_OPEN_ID],
      managerUserIds: [USER_OPEN_ID],
    });
    expect(mockAddChatManagers).toHaveBeenCalledWith(CREATOR, 'oc_mgr', [USER_OPEN_ID]);
    expect(result.managersAdded).toEqual([USER_OPEN_ID]);
    expect(result.managerError).toBeNull();
  });

  it('skips adding manager if user was successfully transferred ownership', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_mgr2', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: true });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      userOpenIds: [USER_OPEN_ID],
      transferOwnerTo: USER_OPEN_ID,
      managerUserIds: [USER_OPEN_ID],
    });
    expect(mockAddChatManagers).not.toHaveBeenCalled();
    expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
    expect(result.managersAdded).toEqual([]);
  });

  it('falls back to addChatManagers when owner transfer fails', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_mgr3', invalidBotIds: [], invalidUserIds: [] });
    mockTransferChatOwner.mockResolvedValue({ ok: false, error: 'transfer_rejected' });
    mockAddChatManagers.mockResolvedValue({ ok: true, addedManagers: [USER_OPEN_ID] });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      userOpenIds: [USER_OPEN_ID],
      transferOwnerTo: USER_OPEN_ID,
      managerUserIds: [USER_OPEN_ID],
    });
    expect(mockTransferChatOwner).toHaveBeenCalled();
    expect(result.transferError).toBe('transfer_rejected');
    expect(mockAddChatManagers).toHaveBeenCalledWith(CREATOR, 'oc_mgr3', [USER_OPEN_ID]);
    expect(result.managersAdded).toEqual([USER_OPEN_ID]);
  });

  it('records managerError gracefully when addChatManagers fails', async () => {
    mockCreateChat.mockResolvedValue({ chatId: 'oc_mgr4', invalidBotIds: [], invalidUserIds: [] });
    mockAddChatManagers.mockResolvedValue({ ok: false, error: 'permission_denied' });
    const result = await createGroupWithBots({
      creatorLarkAppId: CREATOR,
      larkAppIds: [CREATOR],
      userOpenIds: [USER_OPEN_ID],
      managerUserIds: [USER_OPEN_ID],
    });
    expect(result.chatId).toBe('oc_mgr4');
    expect(result.managerError).toBe('permission_denied');
    expect(result.managersAdded).toEqual([]);
  });
  describe('拉新群时带上管家', () => {
    // 不 mock 配置与快照：本机 bots.json 用 BOTS_CONFIG 指向临时文件，管家 owner 的 union_id
    // 按管家 daemon 的发布格式写进数据目录（creator 进程只读这两样）。
    const STEWARD = 'cli_steward';
    const STEWARD_ADMINS = ['alice@example.com'];
    const stewardBot = (steward: Record<string, unknown>) => ({
      larkAppId: STEWARD, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: STEWARD_ADMINS, steward,
    });
    let botsDir: string;
    const writeBots = (entries: Array<Record<string, unknown>>) =>
      writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify(entries));

    beforeEach(() => {
      botsDir = mkdtempSync(join(tmpdir(), 'group-creator-steward-'));
      process.env.BOTS_CONFIG = join(botsDir, 'bots.json');
      writeBots([
        { larkAppId: CREATOR, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [USER_OPEN_ID] },
        stewardBot({ enabled: true, chatId: 'oc_steward_home' }),
      ]);
      writeBotAdminUnions(config.session.dataDir, STEWARD, {
        fingerprint: adminListFingerprint(STEWARD_ADMINS), admins: ['on_alice'], exact: true, owner: 'on_alice', updatedAt: 1,
      });
      mockResolveUnionIdStrict.mockReset().mockImplementation(async (_app: string, openId: string) =>
        (openId === USER_OPEN_ID ? { status: 'resolved', unionId: 'on_alice' } : { status: 'unavailable' }));
      mockTransferChatOwner.mockResolvedValue({ ok: true });
      mockBindOncall.mockResolvedValue({ ok: true, created: true });
    });

    afterEach(() => {
      delete process.env.BOTS_CONFIG;
      rmSync(botsDir, { recursive: true, force: true });
    });

    it('owner 在新群里：请求的 bot 进群后、群主转让前把管家加进来；管家不进协作授权 / oncall 绑定 / invalidBotIds', async () => {
      mockCreateChat.mockResolvedValue({ chatId: 'oc_with_steward', invalidBotIds: [], invalidUserIds: [] });
      const ensureBotCollaboration = vi.fn(async () => {});
      const result = await createGroupWithBots({
        creatorLarkAppId: CREATOR,
        larkAppIds: [CREATOR, OTHER_BOT],
        userOpenIds: [USER_OPEN_ID],
        transferOwnerTo: USER_OPEN_ID,
        bindWorkingDir: '/repo',
        ensureBotCollaboration,
      });
      expect(mockAddBotToChat.mock.calls).toEqual([
        [CREATOR, 'oc_with_steward', [OTHER_BOT]],
        [CREATOR, 'oc_with_steward', [STEWARD]],
      ]);
      expect(mockAddBotToChat.mock.invocationCallOrder[1]!).toBeLessThan(mockTransferChatOwner.mock.invocationCallOrder[0]!);
      expect(mockResolveUnionIdStrict).toHaveBeenCalledWith(CREATOR, USER_OPEN_ID);
      expect(result.stewardJoins).toEqual([{ larkAppId: STEWARD, ok: true }]);
      expect(result.invalidBotIds).toEqual([]);
      expect(ensureBotCollaboration).toHaveBeenCalledWith('oc_with_steward', [CREATOR, OTHER_BOT], []);
      expect(mockBindOncall.mock.calls.map(c => c[0])).toEqual([CREATOR, OTHER_BOT]);
      expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
      // 管家 daemon 看到这条标记就不跑入群动作（见 event-dispatcher 的 bot.added）。
      expect(isStewardSilentJoin(config.session.dataDir, STEWARD, 'oc_with_steward')).toBe(true);
    });

    // 调用形状同 core/session-group-birth.ts：1 人 1 bot、不转群主、绑目录。
    const sessionGroupBirth = (chatId: string) => {
      mockCreateChat.mockResolvedValue({ chatId, invalidBotIds: [], invalidUserIds: [] });
      return createGroupWithBots({
        creatorLarkAppId: CREATOR,
        larkAppIds: [CREATOR],
        name: '新会话',
        userOpenIds: [USER_OPEN_ID],
        managerUserIds: [USER_OPEN_ID],
        bindWorkingDir: '/repo',
      });
    };

    it('私聊转出的会话群（1 人 1 bot）默认不带管家：不查身份、不写静默标记，保持免 @ 续话', async () => {
      const result = await sessionGroupBirth('oc_session_group');
      expect('stewardJoins' in result).toBe(false);
      expect(mockAddBotToChat).not.toHaveBeenCalled();
      expect(mockResolveUnionIdStrict).not.toHaveBeenCalled();
      expect(isStewardSilentJoin(config.session.dataDir, STEWARD, 'oc_session_group')).toBe(false);
    });

    it('/fork --create、私聊里 /group 等同样只有 1 人 1 bot 的新群也默认不带；按实际进群的人和 bot 数判断', async () => {
      const solo = async (chatId: string, extra: Record<string, unknown> = {}, invalidBotIds: string[] = []) => {
        mockCreateChat.mockResolvedValue({ chatId, invalidBotIds: [], invalidUserIds: [] });
        mockAddBotToChat.mockImplementation(async (_app: string, _chat: string, ids: string[]) =>
          ids.map(id => (invalidBotIds.includes(id) ? { id, ok: false, error: 'invalid_id' } : { id, ok: true })));
        return createGroupWithBots({ creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], name: 'x', userOpenIds: [USER_OPEN_ID], transferOwnerTo: USER_OPEN_ID, ...extra });
      };
      expect('stewardJoins' in await solo('oc_fork')).toBe(false);
      // 要了两个 bot 但另一个被飞书拒了：实际只有 1 人 1 bot，同样不带。
      expect('stewardJoins' in await solo('oc_half', { larkAppIds: [CREATOR, OTHER_BOT] }, [OTHER_BOT])).toBe(false);
      // 同一个人既按 open_id 又按 union_id 拉进来，仍算一个人。
      expect('stewardJoins' in await solo('oc_same_person', { ownerUnionIds: ['on_alice'] })).toBe(false);
      expect(mockResolveUnionIdStrict).not.toHaveBeenCalled();
      // 群里不止一个人：不是单人群，照带。
      expect((await solo('oc_two_people', { userOpenIds: [USER_OPEN_ID, 'ou_bob'] })).stewardJoins).toEqual([{ larkAppId: STEWARD, ok: true }]);
    });

    it('会议监听群（larkAppIds 为空 + 1 个目标用户）按单人群不带；issue 领取群单 bot 不带、多 bot 照带', async () => {
      // 形状同 daemon.ts 的会议监听群：只有 creator 自己。
      mockCreateChat.mockResolvedValue({ chatId: 'oc_vc_listener', invalidBotIds: [], invalidUserIds: [] });
      const vc = await createGroupWithBots({
        creatorLarkAppId: CREATOR, larkAppIds: [], name: '会议监听-x', userOpenIds: [USER_OPEN_ID],
        transferOwnerTo: USER_OPEN_ID, notifyOwnerOpenId: USER_OPEN_ID,
      });
      expect('stewardJoins' in vc).toBe(false);
      // 形状同 issue-claim-flow + issue-command-deps：creator + 认领 bot（+ 同伴 bot）、领取人、owner union_id。
      const claim = (chatId: string, larkAppIds: string[]) => {
        mockCreateChat.mockResolvedValue({ chatId, invalidBotIds: [], invalidUserIds: [] });
        return createGroupWithBots({
          creatorLarkAppId: CREATOR, larkAppIds, name: 'issue', bindWorkingDir: '/repo',
          ownerUnionIds: ['on_alice'], userOpenIds: [USER_OPEN_ID],
        });
      };
      expect('stewardJoins' in await claim('oc_claim_solo', [CREATOR])).toBe(false);
      expect(mockAddBotToChat).not.toHaveBeenCalled();
      expect((await claim('oc_claim_peers', [CREATOR, OTHER_BOT])).stewardJoins).toEqual([{ larkAppId: STEWARD, ok: true }]);
    });

    it('管家打开「只有你和一个 Bot 的群也带上管家」后，会话群、/fork 这类单人群也带（不绑目录）', async () => {
      writeBots([stewardBot({ enabled: true, autoJoinSoloGroups: true })]);
      const opted = await sessionGroupBirth('oc_session_opted');
      expect(opted.stewardJoins).toEqual([{ larkAppId: STEWARD, ok: true }]);
      expect(mockAddBotToChat.mock.calls).toEqual([[CREATOR, 'oc_session_opted', [STEWARD]]]);
      expect(mockBindOncall.mock.calls.map(c => c[0])).toEqual([CREATOR]);
      mockCreateChat.mockResolvedValue({ chatId: 'oc_fork_opted', invalidBotIds: [], invalidUserIds: [] });
      const fork = await createGroupWithBots({
        creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], name: 'fork', userOpenIds: [USER_OPEN_ID], transferOwnerTo: USER_OPEN_ID,
      });
      expect(fork.stewardJoins).toEqual([{ larkAppId: STEWARD, ok: true }]);
    });

    it('加管家失败：群照建、群主照转，失败只写在 stewardJoins 里', async () => {
      mockCreateChat.mockResolvedValue({ chatId: 'oc_steward_rejected', invalidBotIds: [], invalidUserIds: [] });
      mockAddBotToChat.mockImplementation(async (_app: string, _chatId: string, ids: string[]) =>
        ids.map(id => (id === STEWARD ? { id, ok: false, error: 'bot not visible to app (code: 232043)' } : { id, ok: true })));
      const result = await createGroupWithBots({
        creatorLarkAppId: CREATOR,
        larkAppIds: [CREATOR, OTHER_BOT],
        userOpenIds: [USER_OPEN_ID],
        transferOwnerTo: USER_OPEN_ID,
        notifyOwnerOpenId: USER_OPEN_ID,
      });
      expect(result.ok).toBe(true);
      expect(result.chatId).toBe('oc_steward_rejected');
      expect(result.invalidBotIds).toEqual([]);
      expect(result.ownerTransferredTo).toBe(USER_OPEN_ID);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(result.stewardJoins).toEqual([{ larkAppId: STEWARD, ok: false, error: 'bot not visible to app (code: 232043)' }]);
      expect(isStewardSilentJoin(config.session.dataDir, STEWARD, 'oc_steward_rejected')).toBe(false);
    });

    it.each([
      ['没开管家的部署', () => [{ larkAppId: OTHER_BOT, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['alice@example.com'] }]],
      ['管家关着', () => [stewardBot({ enabled: false, chatId: 'oc_steward_home' })]],
      ['关掉「拉新群时带上管家」', () => [stewardBot({ enabled: true, autoJoinNewGroups: false })]],
    ])('%s：建群和原来一样，不查身份、不加管家、结果里没有 stewardJoins', async (_name, bots) => {
      writeBots(bots());
      mockCreateChat.mockResolvedValue({ chatId: 'oc_switch_off', invalidBotIds: [], invalidUserIds: [] });
      const result = await createGroupWithBots({
        creatorLarkAppId: CREATOR, larkAppIds: [CREATOR, OTHER_BOT], userOpenIds: [USER_OPEN_ID], transferOwnerTo: USER_OPEN_ID,
      });
      expect(mockAddBotToChat.mock.calls).toEqual([[CREATOR, 'oc_switch_off', [OTHER_BOT]]]);
      expect(mockResolveUnionIdStrict).not.toHaveBeenCalled();
      expect('stewardJoins' in result).toBe(false);
    });

    it('owner 不在新群里、或管家已经是要拉的 bot：不带', async () => {
      mockCreateChat.mockResolvedValue({ chatId: 'oc_someone_else', invalidBotIds: [], invalidUserIds: [] });
      const other = await createGroupWithBots({
        creatorLarkAppId: CREATOR, larkAppIds: [CREATOR], userOpenIds: ['ou_bob'], transferOwnerTo: 'ou_bob',
      });
      expect('stewardJoins' in other).toBe(false);
      mockCreateChat.mockResolvedValue({ chatId: 'oc_already', invalidBotIds: [], invalidUserIds: [] });
      const already = await createGroupWithBots({
        creatorLarkAppId: CREATOR, larkAppIds: [CREATOR, STEWARD], userOpenIds: [USER_OPEN_ID],
      });
      expect('stewardJoins' in already).toBe(false);
      expect(mockAddBotToChat.mock.calls).toEqual([[CREATOR, 'oc_already', [STEWARD]]]);
    });
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
