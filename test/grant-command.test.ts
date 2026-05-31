/**
 * grant-command：parseGrantTarget 纯函数 + tryHandleGrantCommand 端到端（@bot /grant @user）。
 * Run: pnpm vitest run test/grant-command.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

// 拦截发卡/回执，避免真实 Lark API 调用。
const replyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, replyMessage: (...a: any[]) => replyMock(...a) };
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGrantTarget, parseGrantTargets, parseGrantQuota, tryHandleGrantCommand } from '../src/im/lark/grant-command.js';
import { registerBot, getBot, loadBotConfigs } from '../src/bot-registry.js';
import { addChatGrant } from '../src/services/grant-store.js';
import * as pending from '../src/im/lark/grant-pending.js';

describe('parseGrantTarget', () => {
  it('extracts first non-bot human mention', () => {
    const msg = { mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_g' }, name: '张三' },
    ] };
    expect(parseGrantTarget(msg, 'ou_bot')).toEqual({ openId: 'ou_g', name: '张三' });
  });

  it('returns undefined when only the bot itself is mentioned', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_bot' }, name: 'Claude' }] }, 'ou_bot')).toBeUndefined();
  });

  it('returns undefined when no mentions', () => {
    expect(parseGrantTarget({ mentions: [] }, 'ou_bot')).toBeUndefined();
    expect(parseGrantTarget({}, 'ou_bot')).toBeUndefined();
  });

  it('falls back to open_id as name when name missing', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_x' } }] }, 'ou_bot')).toEqual({ openId: 'ou_x', name: 'ou_x' });
  });
});

describe('parseGrantQuota', () => {
  const m = [{ name: '张三' }];
  it('parses a trailing positive integer after stripping the @mention', () => {
    expect(parseGrantQuota('/grant @张三 5', m)).toEqual({ ok: true, quota: 5 });
  });
  it('no number → ok with undefined quota', () => {
    expect(parseGrantQuota('/grant @张三', m)).toEqual({ ok: true, quota: undefined });
  });
  it('handles mention names containing spaces', () => {
    expect(parseGrantQuota('/grant @张 三 7', [{ name: '张 三' }])).toEqual({ ok: true, quota: 7 });
  });
  it('rejects 0 / negative / decimal / non-numeric / extra tail', () => {
    expect(parseGrantQuota('/grant @张三 0', m)).toEqual({ ok: false });
    expect(parseGrantQuota('/grant @张三 -1', m)).toEqual({ ok: false });
    expect(parseGrantQuota('/grant @张三 2.5', m)).toEqual({ ok: false });
    expect(parseGrantQuota('/grant @张三 abc', m)).toEqual({ ok: false });
    expect(parseGrantQuota('/grant @张三 5 oops', m)).toEqual({ ok: false });
  });
});

describe('parseGrantTargets (multi)', () => {
  it('returns all non-bot mentions, in order, deduped by open_id', () => {
    const msg = { mentions: [
      { id: { open_id: 'ou_bot' }, name: 'Claude' },
      { id: { open_id: 'ou_a' }, name: '张三' },
      { id: { open_id: 'ou_b' }, name: '李四' },
      { id: { open_id: 'ou_a' }, name: '张三再次' },   // dup → dropped
    ] };
    expect(parseGrantTargets(msg, 'ou_bot')).toEqual([
      { openId: 'ou_a', name: '张三' },
      { openId: 'ou_b', name: '李四' },
    ]);
  });

  it('empty when only the bot is mentioned', () => {
    expect(parseGrantTargets({ mentions: [{ id: { open_id: 'ou_bot' }, name: 'Claude' }] }, 'ou_bot')).toEqual([]);
  });
});

describe('tryHandleGrantCommand (@bot /grant @user)', () => {
  function grantMessage() {
    return {
      message_id: 'om_x', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_z' }, name: '张三' },
      ],
    };
  }

  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const bot = registerBot({ larkAppId: 'b1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => vi.restoreAllMocks());

  it('owner: leading @bot is stripped, command matches → pops interactive card + opens pending', async () => {
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_owner');
    expect(handled).toBe(true);
    // last reply is the interactive card (msgType 'interactive')
    expect(replyMock).toHaveBeenCalled();
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');
    expect(content).toContain('grant_chat');           // card carries grant actions
    expect(pending.checkNonce('b1', 'oc_1', 'ou_z', JSON.parse(content).elements.find((e: any)=>e.tag==='action').actions[0].value.nonce)).toBe(true);
  });

  it('non-owner: replies owner_only, no card', async () => {
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_intruder');
    expect(handled).toBe(true);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');  // text reply, not a card
    expect(content).toContain('owner');                 // owner_only message text
  });

  it('unrelated message is not intercepted', async () => {
    const msg = { message_id: 'om_y', chat_id: 'oc_1', content: JSON.stringify({ text: '@_user_1 帮我看下代码' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' }] };
    expect(await tryHandleGrantCommand('b1', msg, 'ou_owner')).toBe(false);
  });
});

describe('tryHandleGrantCommand multi-target (@bot /grant @a @b)', () => {
  function multiGrantMsg() {
    return {
      message_id: 'om_m', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2 @_user_3' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
        { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' },
        { key: '@_user_3', id: { open_id: 'ou_b' }, name: '李四' },
      ],
    };
  }

  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const bot = registerBot({ larkAppId: 'bm', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => vi.restoreAllMocks());

  it('owner: pops ONE card listing both targets, both pending under one shared nonce', async () => {
    const handled = await tryHandleGrantCommand('bm', multiGrantMsg(), 'ou_owner');
    expect(handled).toBe(true);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');
    expect(content).toContain('张三');
    expect(content).toContain('李四');
    const grantChat = JSON.parse(content).elements.find((e: any) => e.tag === 'action').actions[0].value;
    expect(grantChat.target_open_ids).toEqual(['ou_a', 'ou_b']);
    // one shared nonce validates every target
    expect(pending.checkNonce('bm', 'oc_1', 'ou_a', grantChat.nonce)).toBe(true);
    expect(pending.checkNonce('bm', 'oc_1', 'ou_b', grantChat.nonce)).toBe(true);
  });
});

describe('tryHandleGrantCommand whole-chat grant (@bot /grant, no target)', () => {
  let configPath: string;

  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-grant-cmd-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: 'b2', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] },
    ], null, 2), 'utf-8');
    loadBotConfigs().forEach(c => registerBot(c));
    const bot = getBot('b2');
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

  // only the bot is @mentioned, no human target → whole-chat grant
  const bareMsg = (text: string, chatId = 'oc_room') => ({
    message_id: 'om_b', chat_id: chatId,
    content: JSON.stringify({ text: `@_user_1 ${text}` }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' }],
  });

  it('owner: bare /grant opens the whole chat to talk + replies (no card)', async () => {
    const handled = await tryHandleGrantCommand('b2', bareMsg('/grant'), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups).toEqual(['oc_room']);
    const [, , , msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');
  });

  it('owner: "/grant all" is also treated as whole-chat grant', async () => {
    const handled = await tryHandleGrantCommand('b2', bareMsg('/grant all'), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups).toEqual(['oc_room']);
  });

  it('owner: "/grant 5" (forgot to @ someone) does NOT open the whole chat', async () => {
    const handled = await tryHandleGrantCommand('b2', bareMsg('/grant 5'), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups).toBeUndefined();  // 关键：绝不把"漏@的额度命令"误执行成整群开放
    const [, , , msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');             // 文本回执（bad_quota），非授权卡
  });

  it('owner: "/grant random" (junk, no target) does NOT open the whole chat', async () => {
    const handled = await tryHandleGrantCommand('b2', bareMsg('/grant random'), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups).toBeUndefined();
  });

  it('owner: bare /revoke removes the whole-chat grant', async () => {
    await tryHandleGrantCommand('b2', bareMsg('/grant'), 'ou_owner');
    expect(getBot('b2').config.allowedChatGroups).toEqual(['oc_room']);
    const handled = await tryHandleGrantCommand('b2', bareMsg('/revoke'), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups ?? []).toEqual([]);
  });

  it('non-owner: bare /grant is rejected, chat not opened', async () => {
    const handled = await tryHandleGrantCommand('b2', bareMsg('/grant'), 'ou_intruder');
    expect(handled).toBe(true);
    expect(getBot('b2').config.allowedChatGroups ?? []).toEqual([]);
  });

  // /revoke @a @b：逐个撤销，合并成一条「撤销结果」清单回复（无卡片）。
  const revokeMultiMsg = (chatId = 'oc_room') => ({
    message_id: 'om_rv', chat_id: chatId,
    content: JSON.stringify({ text: '@_user_1 /revoke @_user_2 @_user_3' }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' },
      { key: '@_user_3', id: { open_id: 'ou_b' }, name: '李四' },
    ],
  });

  it('owner: /revoke @a @b removes both chat grants + replies a combined list (no card)', async () => {
    await addChatGrant('b2', 'oc_room', 'ou_a');
    await addChatGrant('b2', 'oc_room', 'ou_b');
    expect(getBot('b2').config.chatGrants).toEqual({ oc_room: ['ou_a', 'ou_b'] });

    const handled = await tryHandleGrantCommand('b2', revokeMultiMsg(), 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('b2').config.chatGrants?.oc_room ?? []).toEqual([]);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');
    // combined list mentions both names, header present, not raw JSON
    expect(content).toContain('张三');
    expect(content).toContain('李四');
    expect(content).not.toContain('{"text"');
  });
});
