/**
 * `/assistant` 归属命令（个人助理模式）。pre-routing、sessionless，与 /mention-mode 同形。
 *
 * Run: npx vitest run --project unit test/assistant-command.test.ts
 *      bun test test/assistant-command.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mocks ────────────────────────────────────────────────────────────────────
let assistantMode = true;
const BOT_OPEN_ID = 'ou_' + 'f'.repeat(32);
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { assistantMode } }),
  getBotOpenId: () => BOT_OPEN_ID,
}));

const mockIsBotMentioned = vi.fn(() => true);
const mockCanOperate = vi.fn(() => false);
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  isBotMentioned: (...a: any[]) => mockIsBotMentioned(...a),
  canOperate: (...a: any[]) => mockCanOperate(...a),
  extractMessageTextForRouting: (m: any) => {
    try { return JSON.parse(m.content ?? '{}').text ?? ''; } catch { return ''; }
  },
}));
// mentionOpenId 按真实实现的形状 mock（bun test 不支持 importOriginal）：/assistant owner
// 读的是飞书原始事件里 mention 的 `id.open_id`，不是 LarkMention.openId。
vi.mock('../src/im/lark/message-parser.js', () => ({
  stripLeadingMentions: (s: string) => s,
  mentionOpenId: (m: any) => (m && typeof m.id === 'object' && m.id ? (m.id.open_id || undefined) : undefined),
}));

const mockReplyMessage = vi.fn(async () => 'msg-id');
vi.mock('../src/im/lark/client.js', () => ({
  replyMessage: (...a: any[]) => mockReplyMessage(...a),
}));

// t() 回显 key + 参数，便于断言消息 id 与 @ 对象。
vi.mock('../src/i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => params ? `${key} ${JSON.stringify(params)}` : key,
  localeForBot: () => 'zh',
}));

let sessionGroupOwner: string | undefined;
vi.mock('../src/services/session-groups-store.js', () => ({
  getSessionGroup: () => (sessionGroupOwner ? { ownerOpenId: sessionGroupOwner } : undefined),
}));

let dataDir = '';
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return dataDir; } } },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tryHandleAssistantCommand } from '../src/im/lark/assistant-command.js';
import { getAssistantOwner } from '../src/services/assistant-owner-store.js';

const APP = 'cli_a1b2c3d4e5f60718';
const ALICE = 'ou_' + 'a'.repeat(32);
const BOB = 'ou_' + 'b'.repeat(32);
const CHAT = 'oc_' + '1'.repeat(32);

/** 飞书原始 mention 形态（dispatcher 传进来的是原始 message，不是 LarkMention）。 */
const rawMention = (openId?: string) => ({ key: '@_user_1', name: 'x', id: { open_id: openId }, ...(openId ? {} : { id_type: 'app_id' }) });
function msg(text: string, opts: { chatType?: 'group' | 'p2p'; mentions?: Array<{ openId?: string }> } = {}) {
  return {
    chat_id: opts.chatType === 'p2p' ? 'oc_dm' : CHAT,
    message_id: 'om_1',
    chat_type: opts.chatType ?? 'group',
    content: JSON.stringify({ text }),
    mentions: [rawMention(BOT_OPEN_ID), ...(opts.mentions ?? []).map(m => rawMention(m.openId))],
  };
}
const lastReply = (): string | undefined => (mockReplyMessage.mock.calls.at(-1) as any[] | undefined)?.[2];
const run = (text: string, sender: string | undefined = ALICE, opts?: Parameters<typeof msg>[1], canTalk = true) =>
  tryHandleAssistantCommand(APP, msg(text, opts), sender, canTalk);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'assistant-cmd-'));
  assistantMode = true;
  sessionGroupOwner = undefined;
  mockReplyMessage.mockClear();
  mockIsBotMentioned.mockReturnValue(true);
  mockCanOperate.mockReturnValue(false);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('/assistant routing', () => {
  it('ignores unrelated text', async () => {
    expect(await run('hello /assistant')).toBe(false);
    expect(await run('/assistants')).toBe(false);
    expect(mockReplyMessage).not.toHaveBeenCalled();
  });
  it('consumes silently when another bot was addressed in a group', async () => {
    mockIsBotMentioned.mockReturnValue(false);
    expect(await run('/assistant claim')).toBe(true);
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('consumes silently without talk permission', async () => {
    expect(await run('/assistant claim', ALICE, undefined, false)).toBe(true);
    expect(mockReplyMessage).not.toHaveBeenCalled();
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('says disabled when the bot is not in assistant mode (and never writes)', async () => {
    assistantMode = false;
    expect(await run('/assistant claim')).toBe(true);
    expect(lastReply()).toBe('cmd.assistant.disabled');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('p2p: nothing to claim', async () => {
    await run('/assistant claim', ALICE, { chatType: 'p2p' });
    expect(lastReply()).toBe('cmd.assistant.p2p');
  });
});

describe('/assistant status', () => {
  it('reports unclaimed, then the owner', async () => {
    await run('/assistant');
    expect(lastReply()).toBe('cmd.assistant.unclaimed');
    await run('/assistant claim');
    await run('/assistant status', BOB);
    expect(lastReply()).toContain('cmd.assistant.status');
    expect(lastReply()).toContain(ALICE);
  });
  it('session groups report the fixed session-group owner', async () => {
    sessionGroupOwner = BOB;
    await run('/assistant');
    expect(lastReply()).toContain(BOB);
  });
});

describe('/assistant claim', () => {
  it('first claimer becomes owner (how=claimed)', async () => {
    await run('/assistant claim');
    expect(lastReply()).toContain('cmd.assistant.claimed');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toMatchObject({ openId: ALICE, how: 'claimed' });
  });
  it('a second person cannot take over a claimed group', async () => {
    await run('/assistant claim');
    await run('/assistant claim', BOB);
    expect(lastReply()).toContain('cmd.assistant.already_claimed');
    expect(getAssistantOwner(dataDir, APP, CHAT)?.openId).toBe(ALICE);
  });
  it('the owner re-claiming is a no-op', async () => {
    await run('/assistant claim');
    await run('/assistant claim');
    expect(lastReply()).toBe('cmd.assistant.already_yours');
  });
  it('refuses a malformed sender id', async () => {
    await run('/assistant claim', 'not-an-open-id');
    expect(lastReply()).toBe('cmd.assistant.no_sender');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('a session group cannot be claimed by someone else', async () => {
    sessionGroupOwner = BOB;
    await run('/assistant claim');
    expect(lastReply()).toContain('cmd.assistant.already_claimed');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
});

describe('/assistant owner @x', () => {
  it('non-admins are refused', async () => {
    await run('/assistant owner @Bob', ALICE, { mentions: [{ openId: BOB }] });
    expect(lastReply()).toBe('cmd.assistant.admin_only');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('admin assigns (how=admin) and can reassign over an existing owner', async () => {
    await run('/assistant claim');
    mockCanOperate.mockReturnValue(true);
    await run('/assistant owner @Bob', ALICE, { mentions: [{ openId: BOB }] });
    expect(lastReply()).toContain('cmd.assistant.owner_set');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toMatchObject({ openId: BOB, how: 'admin' });
  });
  it('requires exactly one human @ target (bot app_id mentions do not count)', async () => {
    mockCanOperate.mockReturnValue(true);
    await run('/assistant owner', ALICE, { mentions: [] });
    expect(lastReply()).toBe('cmd.assistant.owner_usage');
    await run('/assistant owner @a @b', ALICE, { mentions: [{ openId: BOB }, { openId: 'ou_' + 'c'.repeat(32) }] });
    expect(lastReply()).toBe('cmd.assistant.owner_usage');
    await run('/assistant owner @bot', ALICE, { mentions: [{ openId: undefined }] });
    expect(lastReply()).toBe('cmd.assistant.owner_usage');
    expect(getAssistantOwner(dataDir, APP, CHAT)).toBeUndefined();
  });
  it('session-group owner is fixed even for admins', async () => {
    sessionGroupOwner = BOB;
    mockCanOperate.mockReturnValue(true);
    await run('/assistant owner @Alice', BOB, { mentions: [{ openId: ALICE }] });
    expect(lastReply()).toBe('cmd.assistant.session_group_fixed');
  });
  it('unknown subcommand → usage', async () => {
    await run('/assistant frobnicate');
    expect(lastReply()).toBe('cmd.assistant.usage');
  });
});
