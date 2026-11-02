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
const mockForget = vi.fn();
vi.mock('../src/services/group-secretary-runtime.js', () => ({ forgetGroupSecretaryChat: (...a: any[]) => mockForget(...a) }));
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
  });

  it('ignores unrelated text', async () => {
    expect(await tryHandleSecretaryCommand(APP, msg('/secretaryx on'), USER, true)).toBe(false);
    expect(await tryHandleSecretaryCommand(APP, msg('hello'), USER, true)).toBe(false);
  });

  it('on → persists per chat with the enabler, survives a cache reset, off removes it', async () => {
    expect(await tryHandleSecretaryCommand(APP, msg('/secretary on'), USER, true)).toBe(true);
    expect(lastReply()).toBe('cmd.secretary.enabled');
    resetGroupSecretaryStoreCache();
    expect(getGroupSecretaryChat(APP, 'oc_group')?.enabledBy).toBe(USER);
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
});
