import { describe, it, expect, beforeEach, vi } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => true);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
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

// t() echoes the key so assertions can target the message id; localeForBot fixed.
vi.mock('../src/i18n/index.js', () => ({
  t: (key: string) => key,
  localeForBot: () => 'zh',
}));

vi.mock('../src/services/session-groups-store.js', () => ({
  isSessionGroup: () => false,
}));

const mockSetChatMentionMode = vi.fn(async (_a: string, _c: string, mode: string) => ({ ok: true as const, mode }));
// Keep the pure helpers real; only stub the fs-writing setter + resolver.
vi.mock('../src/services/chat-reply-mode-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/chat-reply-mode-store.js')>();
  return {
    ...actual,
    setChatMentionMode: (...a: any[]) => mockSetChatMentionMode(...a),
    resolveGroupMentionMode: () => 'always' as const,
  };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tryHandleMentionModeCommand } from '../src/im/lark/mention-mode-command.js';

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

describe('tryHandleMentionModeCommand — regular groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBot.mockReturnValue({ config: { larkAppId: APP }, botOpenId: 'ou_bot' });
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
  });

  it('not a /mention-mode message → returns false (lets dispatch continue)', async () => {
    const handled = await tryHandleMentionModeCommand(APP, msg('hello'), USER, true);
    expect(handled).toBe(false);
  });

  it.each(['always', 'topic', 'never', 'ambient'] as const)(
    '`/mention-mode %s` (owner) → setChatMentionMode + updated',
    async (mode) => {
      const handled = await tryHandleMentionModeCommand(APP, msg(`/mention-mode ${mode}`), USER, true);
      expect(handled).toBe(true);
      expect(mockSetChatMentionMode).toHaveBeenCalledWith(APP, 'oc_group', mode);
      expect(lastReply()).toBe('cmd.mention_mode.updated');
    },
  );

  it('`/mention-mode bogus` → usage, no write', async () => {
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode bogus'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.mention_mode.usage');
  });

  it('`/mention-mode` status (canTalk) → status, no write', async () => {
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.mention_mode.status');
  });

  it('set by non-owner → owner_only, no write', async () => {
    mockCanOperate.mockReturnValue(false);
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode never'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.mention_mode.owner_only');
  });

  it('without @mention → silently owned by the @mentioned bot only (no write, no reply)', async () => {
    mockIsBotMentioned.mockReturnValue(false);
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode never'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });

  it('p2p DM → unsupported, no write', async () => {
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode never', 'p2p'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.mention_mode.unsupported');
  });

  it('topic group (getChatMode=topic) → unsupported, no write', async () => {
    mockGetChatMode.mockResolvedValue('topic');
    const handled = await tryHandleMentionModeCommand(APP, msg('/mention-mode never'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatMentionMode).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.mention_mode.unsupported');
  });
});
