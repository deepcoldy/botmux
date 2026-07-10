import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => true);
const mockCanTalk = vi.fn(() => true);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
  canTalk: (...a: any[]) => mockCanTalk(...a),
  extractMessageTextForRouting: (m: any) => {
    try { return JSON.parse(m.content ?? '{}').text ?? ''; } catch { return ''; }
  },
}));

vi.mock('../src/im/lark/message-parser.js', () => ({
  stripLeadingMentions: (s: string) => s,
}));

const mockGetChatMode = vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p');
const mockReplyMessage = vi.fn(async () => 'msg-id');
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: (...a: any[]) => mockGetChatMode(...a),
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
}));

const mockGetBot = vi.fn(() => ({
  config: {
    substituteMode: {
      enabled: true,
      targets: [{ openId: USER, name: 'User' }],
      disclosure: 'prefix',
    },
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

const mockListChats = vi.fn(async () => [{ chatId: 'oc_group', name: 'Group', chatMode: 'group' }]);
const mockLeaveChat = vi.fn(async () => ({ ok: true as const }));
vi.mock('../src/services/groups-store.js', () => ({
  listChats: (...a: any[]) => mockListChats(...a),
  leaveChat: (...a: any[]) => mockLeaveChat(...a),
}));

const mockIsSubstituteEnabledForChat = vi.fn(() => true);
const mockSetSubstituteEnabledForChat = vi.fn();
vi.mock('../src/services/substitute-chat-toggle-store.js', () => ({
  isSubstituteEnabledForChat: (...a: any[]) => mockIsSubstituteEnabledForChat(...a),
  setSubstituteEnabledForChat: (...a: any[]) => mockSetSubstituteEnabledForChat(...a),
}));

const mockDirect = new Map<string, any>();
vi.mock('../src/services/substitute-direct-store.js', () => ({
  getSubstituteDirectBinding: (_app: string, openId: string) => mockDirect.get(openId),
  getSubstituteDirectChat: (_app: string, openId: string, chatId: string) => mockDirect.get(openId)?.chats?.[chatId],
  upsertSubstituteDirectChat: (input: any) => {
    const cur = mockDirect.get(input.substituteOpenId) ?? { chats: {} };
    cur.targetOpenId = input.targetOpenId;
    cur.substituteUserId = input.substituteUserId;
    cur.substituteUnionId = input.substituteUnionId;
    cur.targetName = input.targetName;
    cur.chats = {};
    cur.chats[input.chatId] = { ...input };
    cur.activeChatId = input.chatId;
    mockDirect.set(input.substituteOpenId, cur);
    return cur;
  },
  clearSubstituteDirectChat: (_app: string, openId: string, chatId?: string) => {
    if (!chatId) return mockDirect.delete(openId);
    const cur = mockDirect.get(openId);
    if (!cur?.chats?.[chatId]) return false;
    delete cur.chats[chatId];
    return true;
  },
}));

vi.mock('../src/i18n/index.js', () => ({
  t: (key: string) => key,
  localeForBot: () => 'zh',
  setBotLookup: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleSubstituteDirectCardAction, tryHandleSubstituteCommand } from '../src/im/lark/substitute-command.js';

const APP = 'app-x';
const USER = 'ou_user';

function msg(text: string, chatType: 'group' | 'p2p' = 'group') {
  return {
    chat_id: chatType === 'p2p' ? 'oc_dm' : 'oc_group',
    message_id: 'om_1',
    chat_type: chatType,
    content: JSON.stringify({ text }),
    mentions: [],
  };
}

function lastReply(): string | undefined {
  const calls = mockReplyMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][2] : undefined;
}

function lastReplyCard(): any {
  const raw = lastReply();
  return raw ? JSON.parse(raw) : undefined;
}

describe('tryHandleSubstituteCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockCanTalk.mockReturnValue(true);
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: USER, name: 'User' }],
          disclosure: 'prefix',
        },
      },
    });
    mockGetChatMode.mockResolvedValue('group');
    mockIsSubstituteEnabledForChat.mockReturnValue(true);
    mockListChats.mockResolvedValue([{ chatId: 'oc_group', name: 'Group', chatMode: 'group' }]);
    mockLeaveChat.mockResolvedValue({ ok: true });
    mockDirect.clear();
  });

  it('non-command messages are ignored', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('hello'), USER)).toBe(false);
  });

  it('status reports current per-chat state', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('/substitute'), USER)).toBe(true);
    expect(lastReply()).toBe('cmd.substitute.status_on');

    mockIsSubstituteEnabledForChat.mockReturnValue(false);
    await tryHandleSubstituteCommand(APP, msg('/substitute status'), USER);
    expect(lastReply()).toBe('cmd.substitute.status_off');
  });

  it('on/off requires canOperate and writes the per-chat toggle', async () => {
    expect(await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER)).toBe(true);
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', false);
    expect(lastReply()).toBe('cmd.substitute.updated_off');

    await tryHandleSubstituteCommand(APP, msg('/substitute on'), USER);
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', true);
    expect(lastReply()).toBe('cmd.substitute.updated_on');
  });

  it('denies mutations for non-operators', async () => {
    mockCanOperate.mockReturnValue(false);
    await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER);
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.substitute.owner_only');
  });

  it('only works in regular groups', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute off', 'p2p'), USER);
    expect(lastReply()).toBe('cmd.substitute.unsupported');

    mockGetChatMode.mockResolvedValue('topic');
    await tryHandleSubstituteCommand(APP, msg('/substitute off'), USER);
    expect(lastReply()).toBe('cmd.substitute.unsupported');
  });

  it('DM list shows substitute groups', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    expect(lastReply()).toContain('cmd.substitute.direct_list_header');
    expect(lastReply()).toContain('oc_group');
  });

  it('DM list uses one dynamic substitute toggle button per group', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    let toggleActions = lastReplyCard().elements
      .flatMap((el: any) => el.actions ?? [])
      .filter((a: any) => a.value?.action === 'substitute_direct_enable' || a.value?.action === 'substitute_direct_disable');
    expect(toggleActions).toHaveLength(1);
    expect(toggleActions[0].text.content).toBe('cmd.substitute.direct_btn_disable_substitute');
    expect(toggleActions[0].value.action).toBe('substitute_direct_disable');

    mockIsSubstituteEnabledForChat.mockReturnValue(false);
    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    toggleActions = lastReplyCard().elements
      .flatMap((el: any) => el.actions ?? [])
      .filter((a: any) => a.value?.action === 'substitute_direct_enable' || a.value?.action === 'substitute_direct_disable');
    expect(toggleActions).toHaveLength(1);
    expect(toggleActions[0].text.content).toBe('cmd.substitute.direct_btn_enable_substitute');
    expect(toggleActions[0].value.action).toBe('substitute_direct_enable');
  });

  it('DM list uses dynamic direct and intervention buttons per group', async () => {
    const expectActionRow = (actions: any[], labels: string[], actionValues: Array<string | undefined>) => {
      expect(actions).toHaveLength(5);
      expect(actions.map((a: any) => a.text.content)).toEqual([...labels, 'cmd.substitute.direct_btn_open_chat']);
      expect(actions.map((a: any) => a.value?.action)).toEqual([...actionValues, undefined]);
      expect(actions[4].multi_url?.url).toContain('openChatId=oc_group');
      expect(actions[4].multi_url?.pc_url).toBe(actions[4].multi_url?.url);
      expect(actions[4].multi_url?.android_url).toBe(actions[4].multi_url?.url);
      expect(actions[4].multi_url?.ios_url).toBe(actions[4].multi_url?.url);
    };

    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    let actions = lastReplyCard().elements.flatMap((el: any) => el.actions ?? []);
    expectActionRow(actions, [
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_enter',
      'cmd.substitute.direct_btn_intervene',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_disable',
      'substitute_direct_enter',
      'substitute_direct_intervene',
      'substitute_direct_leave_group',
    ]);

    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);
    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    actions = lastReplyCard().elements.flatMap((el: any) => el.actions ?? []);
    expectActionRow(actions, [
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_exit',
      'cmd.substitute.direct_btn_intervene',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_disable',
      'substitute_direct_exit',
      'substitute_direct_intervene',
      'substitute_direct_leave_group',
    ]);

    await tryHandleSubstituteCommand(APP, msg('/substitute intervene oc_group', 'p2p'), USER);
    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);
    actions = lastReplyCard().elements.flatMap((el: any) => el.actions ?? []);
    expectActionRow(actions, [
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_enter',
      'cmd.substitute.direct_btn_exit_intervene',
      'cmd.substitute.direct_btn_leave_group',
    ], [
      'substitute_direct_disable',
      'substitute_direct_enter',
      'substitute_direct_exit',
      'substitute_direct_leave_group',
    ]);
  });

  it('DM list does not require the sender to already be a substitute target', async () => {
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });

    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);

    expect(lastReply()).toContain('cmd.substitute.direct_list_header');
    expect(lastReply()).toContain('oc_group');
  });

  it('DM list is forbidden when sender is neither operator nor substitute target', async () => {
    mockCanOperate.mockReturnValue(false);
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });

    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);

    expect(lastReply()).toBe('cmd.substitute.direct_forbidden');
  });

  it('DM list remains forbidden for a stale direct binding after the user loses substitute permission', async () => {
    mockCanOperate.mockReturnValue(false);
    mockGetBot.mockReturnValue({ config: { substituteMode: { enabled: true, targets: [], disclosure: 'prefix' } } });
    mockDirect.set(USER, {
      activeChatId: 'oc_group',
      chats: {
        oc_group: { chatId: 'oc_group', mode: 'direct' },
      },
    });

    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);

    expect(lastReply()).toBe('cmd.substitute.direct_forbidden');
  });

  it('DM list filters out topic chats using getChatMode', async () => {
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_topic', name: 'Topic', chatMode: 'group' },
    ]);
    mockGetChatMode.mockImplementation(async (_app, chatId) => chatId === 'oc_topic' ? 'topic' : 'group');

    await tryHandleSubstituteCommand(APP, msg('/substitute list', 'p2p'), USER);

    expect(lastReply()).toContain('oc_group');
    expect(lastReply()).not.toContain('oc_topic');
  });

  it('DM enter/exit toggles direct mode for a group', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);
    expect(lastReply()).toBe('cmd.substitute.direct_enter_ok');
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeTruthy();

    await tryHandleSubstituteCommand(APP, msg('/substitute exit oc_group', 'p2p'), USER);
    expect(lastReply()).toBe('cmd.substitute.direct_exit_ok');
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeFalsy();
  });

  it('DM enter/intervene keeps only one active substitute group', async () => {
    mockListChats.mockResolvedValue([
      { chatId: 'oc_group', name: 'Group', chatMode: 'group' },
      { chatId: 'oc_group_2', name: 'Group 2', chatMode: 'group' },
    ]);

    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['oc_group']);

    await tryHandleSubstituteCommand(APP, msg('/substitute intervene oc_group_2', 'p2p'), USER);
    expect(mockDirect.get(USER)?.activeChatId).toBe('oc_group_2');
    expect(Object.keys(mockDirect.get(USER)?.chats ?? {})).toEqual(['oc_group_2']);
    expect(mockDirect.get(USER)?.chats?.oc_group_2?.mode).toBe('intervene');
  });

  it('DM leave-group makes the bot leave the selected group and removes direct state', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);
    await tryHandleSubstituteCommand(APP, msg('/substitute leave-group oc_group', 'p2p'), USER);
    expect(mockLeaveChat).toHaveBeenCalledWith(APP, 'oc_group');
    expect(lastReply()).toBe('cmd.substitute.direct_leave_group_ok');
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeFalsy();
  });

  it('DM leave-group requires operator permission', async () => {
    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);
    mockCanOperate.mockReturnValue(false);

    await tryHandleSubstituteCommand(APP, msg('/substitute leave-group oc_group', 'p2p'), USER);

    expect(mockLeaveChat).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.substitute.owner_only');
  });

  it('card action enter updates direct mode and returns an updated card', async () => {
    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    expect(result.toast).toEqual({ type: 'success', content: 'cmd.substitute.direct_enter_ok' });
    expect(result.card.type).toBe('raw');
    expect(mockDirect.get(USER)?.chats?.oc_group).toBeTruthy();
  });

  it('operator entering direct mode stores state under the configured substitute target', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub', userId: 'u_sub', unionId: 'on_sub', name: 'Sub' }],
          disclosure: 'prefix',
        },
      },
    });

    await tryHandleSubstituteCommand(APP, msg('/substitute enter oc_group', 'p2p'), USER);

    expect(mockDirect.get('ou_sub')).toBeUndefined();
    expect(mockDirect.get(USER)).toMatchObject({
      targetOpenId: 'ou_sub',
      substituteUserId: 'u_sub',
      substituteUnionId: 'on_sub',
      targetName: 'Sub',
      activeChatId: 'oc_group',
      chats: {
        oc_group: expect.objectContaining({ mode: 'direct', targetName: 'Sub' }),
      },
    });
  });

  it('operator card action enter refreshes the card as direct mode on', async () => {
    mockGetBot.mockReturnValue({
      config: {
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_sub', name: 'Sub' }],
          disclosure: 'prefix',
        },
      },
    });

    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enter',
      chatId: 'oc_group',
    });

    const actions = result.card.data.elements.flatMap((el: any) => el.actions ?? []);
    expect(actions.map((a: any) => a.text.content)).toEqual([
      'cmd.substitute.direct_btn_disable_substitute',
      'cmd.substitute.direct_btn_exit',
      'cmd.substitute.direct_btn_intervene',
      'cmd.substitute.direct_btn_leave_group',
      'cmd.substitute.direct_btn_open_chat',
    ]);
    expect(actions[4].multi_url?.url).toContain('openChatId=oc_group');
  });

  it('card action can enable and disable substitute for the target group', async () => {
    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_disable',
      chatId: 'oc_group',
    });
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', false);

    await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_enable',
      chatId: 'oc_group',
    });
    expect(mockSetSubstituteEnabledForChat).toHaveBeenCalledWith(APP, 'oc_group', true);
  });

  it('card action requires operator permission to enable or disable substitute', async () => {
    mockCanOperate.mockReturnValue(false);

    const result = await handleSubstituteDirectCardAction({
      larkAppId: APP,
      operatorOpenId: USER,
      invokerOpenId: USER,
      action: 'substitute_direct_disable',
      chatId: 'oc_group',
    });

    expect(result.toast).toEqual({ type: 'error', content: 'cmd.substitute.owner_only' });
    expect(mockSetSubstituteEnabledForChat).not.toHaveBeenCalled();
  });
});
