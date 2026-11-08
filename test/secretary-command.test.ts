import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dataDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'secretary-cmd-')) };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir } } }));

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => true);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
  extractMessageTextForRouting: (m: any) => {
    try { return JSON.parse(m.content ?? '{}').text ?? ''; } catch { return ''; }
  },
}));
vi.mock('../src/im/lark/message-parser.js', () => ({ stripLeadingMentions: (s: string) => s }));

const mockGetChatMode = vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p');
const mockReplyMessage = vi.fn(async () => 'msg-id');
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: (...a: any[]) => mockGetChatMode(...a),
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
}));
vi.mock('../src/i18n/index.js', () => ({ t: (key: string) => key, localeForBot: () => 'zh' }));
const mockIsSessionGroup = vi.fn(() => false);
vi.mock('../src/services/session-groups-store.js', () => ({ isSessionGroup: (...a: any[]) => mockIsSessionGroup(...a) }));
const botConfig = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (id: string) => ({ config: { larkAppId: id, ...botConfig.extra } }),
  effectiveBotDisplayName: (st: any) => `Bot-${st.config.larkAppId}`,
}));
// 群描述标记：用内存 Map 模拟飞书群描述（跨机器共享的权威登记）。
const markerByChat = new Map<string, string>();
const mockWriteMarker = vi.fn(async (_app: string, chat: string, appId: string | null) => {
  const previous = markerByChat.get(chat);
  if (appId) markerByChat.set(chat, appId); else markerByChat.delete(chat);
  return { ok: true as const, ...(previous ? { previous } : {}) };
});
vi.mock('../src/services/group-secretary-marker.js', () => ({
  readSecretaryMarker: async (_app: string, chat: string) => markerByChat.get(chat),
  writeSecretaryMarker: (...a: any[]) => (mockWriteMarker as any)(...a),
}));
const mockForget = vi.fn();
vi.mock('../src/services/group-secretary-runtime.js', () => ({ forgetGroupSecretaryChat: (...a: any[]) => mockForget(...a), noteSecretaryMarker: () => {} }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { tryHandleSecretaryCommand } from '../src/im/lark/secretary-command.js';
import { isGroupSecretaryChat, getGroupSecretaryChat, resetGroupSecretaryStoreCache } from '../src/services/group-secretary-store.js';

const APP = 'cli_app';
const USER = 'ou_user';

function msg(text: string, chatType: 'group' | 'p2p' = 'group', chatId = 'oc_group') {
  return { chat_id: chatId, message_id: 'om_1', chat_type: chatType, content: JSON.stringify({ text }), mentions: [] };
}
const lastReply = () => mockReplyMessage.mock.calls.at(-1)?.[2];

describe('tryHandleSecretaryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
    mockIsSessionGroup.mockReturnValue(false);
    botConfig.extra = { groupSecretaryEnabled: true };
  });

  it('ignores unrelated text', async () => {
    expect(await tryHandleSecretaryCommand(APP, msg('/secretaryx on'), USER, true)).toBe(false);
    expect(await tryHandleSecretaryCommand(APP, msg('hello'), USER, true)).toBe(false);
  });

  it('on → persists per chat with the enabler, survives a cache reset, off removes it', async () => {
    expect(await tryHandleSecretaryCommand(APP, msg('/secretary on'), USER, true)).toBe(true);
    expect(lastReply()).toBe('cmd.secretary.enabled');
    resetGroupSecretaryStoreCache();
    expect(getGroupSecretaryChat(APP, 'oc_group')).toMatchObject({ enabledBy: USER, larkAppId: APP, botName: `Bot-${APP}` });
    expect(isGroupSecretaryChat(APP, 'oc_other')).toBe(false);

    await tryHandleSecretaryCommand(APP, msg('/secretary on'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.already_on');

    await tryHandleSecretaryCommand(APP, msg('/secretary off'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.disabled');
    expect(mockForget).toHaveBeenCalledWith('oc_group');
    resetGroupSecretaryStoreCache();
    expect(isGroupSecretaryChat(APP, 'oc_group')).toBe(false);
  });

  it('requires canOperate to toggle; status only needs canTalk', async () => {
    mockCanOperate.mockReturnValue(false);
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_x'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.owner_only');
    expect(isGroupSecretaryChat(APP, 'oc_x')).toBe(false);
    await tryHandleSecretaryCommand(APP, msg('/secretary', 'group', 'oc_x'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.status_off');
  });

  it('in a multi-bot group only the @mentioned bot handles it (swallowed silently otherwise)', async () => {
    mockIsBotMentioned.mockReturnValue(false);
    expect(await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_y'), USER, true)).toBe(true);
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(isGroupSecretaryChat(APP, 'oc_y')).toBe(false);
  });

  it('rejects DMs and session groups', async () => {
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'p2p', 'oc_dm'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.unsupported');
    mockIsSessionGroup.mockReturnValue(true);
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_sg'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.unsupported');
    expect(isGroupSecretaryChat(APP, 'oc_sg')).toBe(false);
  });

  it('works in topic groups', async () => {
    mockGetChatMode.mockResolvedValue('topic');
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_topic'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.enabled');
  });

  it('one secretary per group (across machines): a second bot must take over explicitly', async () => {
    const OTHER = 'cli_other';
    const chat = 'oc_shared';
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', chat), USER, true);
    await tryHandleSecretaryCommand(OTHER, msg('/secretary on', 'group', chat), USER, true);
    expect(lastReply()).toBe('cmd.secretary.taken');
    expect(isGroupSecretaryChat(OTHER, chat)).toBe(false);
    await tryHandleSecretaryCommand(OTHER, msg('/secretary', 'group', chat), USER, true);
    expect(lastReply()).toBe('cmd.secretary.status_other');
    await tryHandleSecretaryCommand(OTHER, msg('/secretary off', 'group', chat), USER, true);
    expect(lastReply()).toBe('cmd.secretary.not_mine');
    expect(isGroupSecretaryChat(APP, chat)).toBe(true);

    await tryHandleSecretaryCommand(OTHER, msg('/secretary takeover', 'group', chat), USER, true);
    expect(lastReply()).toBe('cmd.secretary.took_over');
    expect(isGroupSecretaryChat(OTHER, chat)).toBe(true);
    expect(isGroupSecretaryChat(APP, chat)).toBe(false);
  });

  it('takeover with no current secretary simply enables', async () => {
    await tryHandleSecretaryCommand(APP, msg('/secretary takeover', 'group', 'oc_free'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.enabled');
    expect(isGroupSecretaryChat(APP, 'oc_free')).toBe(true);
  });

  it('a bot on another machine (marker only, no local entry) blocks on and is reported in status', async () => {
    markerByChat.set('oc_remote', 'cli_on_other_machine');
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_remote'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.taken');
    await tryHandleSecretaryCommand(APP, msg('/secretary', 'group', 'oc_remote'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.status_other');
    await tryHandleSecretaryCommand(APP, msg('/secretary takeover', 'group', 'oc_remote'), USER, true);
    expect(markerByChat.get('oc_remote')).toBe(APP);
    expect(isGroupSecretaryChat(APP, 'oc_remote')).toBe(true);
  });

  it('off clears the group marker; a marker write failure leaves the local entry untouched', async () => {
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_m'), USER, true);
    expect(markerByChat.get('oc_m')).toBe(APP);
    mockWriteMarker.mockResolvedValueOnce({ ok: false, reason: 'chat_update_failed(1)' } as any);
    await tryHandleSecretaryCommand(APP, msg('/secretary off', 'group', 'oc_m'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.failed');
    expect(isGroupSecretaryChat(APP, 'oc_m')).toBe(true);
    await tryHandleSecretaryCommand(APP, msg('/secretary off', 'group', 'oc_m'), USER, true);
    expect(markerByChat.has('oc_m')).toBe(false);
    expect(isGroupSecretaryChat(APP, 'oc_m')).toBe(false);
  });
});

describe('tryHandleSecretaryCommand — bot-level switch (groupSecretaryEnabled, default off)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
    mockIsSessionGroup.mockReturnValue(false);
  });

  it('a bot config without the field cannot turn on or take over: replies not enabled, writes nothing', async () => {
    botConfig.extra = {};
    markerByChat.set('oc_sw_taken', 'cli_other');
    for (const [text, chat] of [['/secretary on', 'oc_sw'], ['/secretary takeover', 'oc_sw_taken']] as const) {
      expect(await tryHandleSecretaryCommand(APP, msg(text, 'group', chat), USER, true)).toBe(true);
      expect(lastReply()).toBe('cmd.secretary.not_enabled');
    }
    expect(mockWriteMarker).not.toHaveBeenCalled();
    expect(markerByChat.has('oc_sw')).toBe(false);
    expect(markerByChat.get('oc_sw_taken')).toBe('cli_other');
    expect(isGroupSecretaryChat(APP, 'oc_sw')).toBe(false);
  });

  it('an explicit false behaves the same as unset', async () => {
    botConfig.extra = { groupSecretaryEnabled: false };
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_sw_false'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.not_enabled');
    expect(isGroupSecretaryChat(APP, 'oc_sw_false')).toBe(false);
  });

  it('turning the switch off keeps off and status working for a group already registered to this bot', async () => {
    botConfig.extra = { groupSecretaryEnabled: true };
    await tryHandleSecretaryCommand(APP, msg('/secretary on', 'group', 'oc_sw_reg'), USER, true);
    expect(isGroupSecretaryChat(APP, 'oc_sw_reg')).toBe(true);

    botConfig.extra = {};
    await tryHandleSecretaryCommand(APP, msg('/secretary status', 'group', 'oc_sw_reg'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.status_paused');
    await tryHandleSecretaryCommand(APP, msg('/secretary off', 'group', 'oc_sw_reg'), USER, true);
    expect(lastReply()).toBe('cmd.secretary.disabled');
    expect(markerByChat.has('oc_sw_reg')).toBe(false);
    expect(isGroupSecretaryChat(APP, 'oc_sw_reg')).toBe(false);
  });
});
