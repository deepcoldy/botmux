import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const mockApplyConfigField = vi.fn(async () => ({ ok: true as const }));
const mockSetChatReplyMode = vi.fn(async (_a: string, _c: string, mode: string) => ({ ok: true as const, mode }));
vi.mock('../src/services/bot-config-store.js', () => ({
  findConfigField: () => ({ key: 'p2pMode' }),
  applyConfigField: (...a: any[]) => mockApplyConfigField(...a),
}));
// Keep the pure helpers real; only stub the fs-writing setter + resolver.
vi.mock('../src/services/chat-reply-mode-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/chat-reply-mode-store.js')>();
  return {
    ...actual,
    setChatReplyMode: (...a: any[]) => mockSetChatReplyMode(...a),
    resolveRegularGroupMode: () => 'chat',
  };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tryHandleReplyModeCommand } from '../src/im/lark/reply-mode-command.js';

const APP = 'app-x';
const USER = 'ou_user';

function msg(text: string, chatType: 'group' | 'p2p') {
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

describe('tryHandleReplyModeCommand — DM (p2p) session mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, p2pMode: undefined }, botOpenId: 'ou_bot' });
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
  });

  it('not a /reply-mode message → returns false (lets dispatch continue)', async () => {
    const handled = await tryHandleReplyModeCommand(APP, msg('hello', 'p2p'), USER, true);
    expect(handled).toBe(false);
  });

  it('DM `/reply-mode chat` (owner) → applyConfigField p2pMode=chat + dm_updated', async () => {
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode chat', 'p2p'), USER, true);
    expect(handled).toBe(true);
    expect(mockApplyConfigField).toHaveBeenCalledWith(APP, expect.objectContaining({ key: 'p2pMode' }), 'chat');
    expect(lastReply()).toBe('cmd.reply_mode.dm_updated');
  });

  it('DM `/reply-mode topic` (owner) → clears p2pMode to default (null) + dm_updated', async () => {
    await tryHandleReplyModeCommand(APP, msg('/reply-mode topic', 'p2p'), USER, true);
    expect(mockApplyConfigField).toHaveBeenCalledWith(APP, expect.objectContaining({ key: 'p2pMode' }), null);
    expect(lastReply()).toBe('cmd.reply_mode.dm_updated');
  });

  it('DM `/reply-mode shared` → rejected (shared unsupported in DM), no write', async () => {
    await tryHandleReplyModeCommand(APP, msg('/reply-mode shared', 'p2p'), USER, true);
    expect(mockApplyConfigField).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.reply_mode.dm_shared_unsupported');
  });

  it('DM `/reply-mode` status (canTalk) → dm_status, no write, no @ required', async () => {
    mockIsBotMentioned.mockReturnValue(false); // DMs need no @mention
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, p2pMode: 'chat' }, botOpenId: 'ou_bot' });
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode', 'p2p'), USER, true);
    expect(handled).toBe(true);
    expect(mockApplyConfigField).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.reply_mode.dm_status');
  });

  it('DM set by non-owner → owner_only, no write', async () => {
    mockCanOperate.mockReturnValue(false);
    await tryHandleReplyModeCommand(APP, msg('/reply-mode chat', 'p2p'), USER, true);
    expect(mockApplyConfigField).not.toHaveBeenCalled();
    expect(lastReply()).toBe('cmd.reply_mode.owner_only');
  });
});

describe('tryHandleReplyModeCommand — group (tri-state incl. shared)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBot.mockReturnValue({ config: { larkAppId: APP }, botOpenId: 'ou_bot' });
    mockIsBotMentioned.mockReturnValue(true);
    mockCanOperate.mockReturnValue(true);
    mockGetChatMode.mockResolvedValue('group');
  });

  it('group `/reply-mode topic` (owner) → setChatReplyMode("shared") + updated', async () => {
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode topic', 'group'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatReplyMode).toHaveBeenCalledWith(APP, 'oc_group', 'shared');
    expect(mockApplyConfigField).not.toHaveBeenCalled(); // group path never touches p2pMode
    expect(lastReply()).toBe('cmd.reply_mode.updated');
  });

  it('group `/reply-mode shared` remains a compatibility alias for topic/shared semantics', async () => {
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode shared', 'group'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatReplyMode).toHaveBeenCalledWith(APP, 'oc_group', 'shared');
    expect(mockApplyConfigField).not.toHaveBeenCalled(); // group path never touches p2pMode
    expect(lastReply()).toBe('cmd.reply_mode.updated');
  });

  it('group `/reply-mode new-topic` is the explicit independent-session mode', async () => {
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode new-topic', 'group'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatReplyMode).toHaveBeenCalledWith(APP, 'oc_group', 'new-topic');
    expect(lastReply()).toBe('cmd.reply_mode.updated');
  });

  it('group without @mention → silently owned by the @mentioned bot only', async () => {
    mockIsBotMentioned.mockReturnValue(false);
    const handled = await tryHandleReplyModeCommand(APP, msg('/reply-mode shared', 'group'), USER, true);
    expect(handled).toBe(true);
    expect(mockSetChatReplyMode).not.toHaveBeenCalled();
  });
});
