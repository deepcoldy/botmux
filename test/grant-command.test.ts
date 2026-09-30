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
import { parseGrantTarget, parseGrantTargets, parseGrantQuota, tryHandleGrantCommand, isGrantTargetOnly } from '../src/im/lark/grant-command.js';
import { registerBot, getBot, loadBotConfigs } from '../src/bot-registry.js';
import { addChatGrant } from '../src/services/grant-store.js';
import * as pending from '../src/im/lark/grant-pending.js';

function findCardCallbackValue(card: any, action: string): any {
  const visit = (node: any): any => {
    if (node?.behaviors?.[0]?.value?.action === action) return node.behaviors[0].value;
    if (node?.value?.action === action) return node.value;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const child of Object.values(node)) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(card);
}

function findCardNode(card: any, predicate: (node: any) => boolean): any {
  if (predicate(card)) return card;
  if (Array.isArray(card)) {
    for (const child of card) {
      const found = findCardNode(child, predicate);
      if (found) return found;
    }
  } else if (card && typeof card === 'object') {
    for (const child of Object.values(card)) {
      const found = findCardNode(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

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

  // REST string-form mention.id ("ou_xxx" + id_type) must parse identically to
  // the WS object form — grant is security-sensitive, so a shape change must not
  // mis-identify the target (or fail to exclude the operator bot itself).
  it('parses REST string-form mention.id, still excluding the bot', () => {
    const msg = { mentions: [
      { id: 'ou_bot', id_type: 'open_id', name: 'Claude' },
      { id: 'ou_a', id_type: 'open_id', name: '张三' },
    ] };
    expect(parseGrantTargets(msg, 'ou_bot')).toEqual([{ openId: 'ou_a', name: '张三' }]);
  });

  // post 形态 mentions 为空 → 回退到 inline `at` 节点解析（否则误判成裸 /grant）。
  it('post fallback: parses non-bot at-nodes when mentions empty', () => {
    const postMsg = {
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
        { tag: 'text', text: ' /grant ' },
        { tag: 'at', user_id: 'ou_t', user_name: '张三' },
      ]] } }),
      mentions: [],
    };
    expect(parseGrantTargets(postMsg, 'ou_bot')).toEqual([{ openId: 'ou_t', name: '张三' }]);
  });

  it('post fallback: bare /grant (only the bot @ed) → empty (whole-chat)', () => {
    const barePost = {
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
        { tag: 'text', text: ' /grant' },
      ]] } }),
      mentions: [],
    };
    expect(parseGrantTargets(barePost, 'ou_bot')).toEqual([]);
  });

  // ── 位置过滤：命令词之前的 @ 是「点名操作 bot」，不是 grantee（实测 bug 回归）─────────
  // `@Claude @Codex /grant`（两 bot 都前导 @、命令后无目标）：每个 daemon 都不该把「另一个 bot」
  // 当成 grantee，否则两 bot 互相授权。
  it('text: co-addressed operator bot BEFORE /grant is NOT a target (no mutual grant)', () => {
    // 从 Claude(ou_bot) 这个 daemon 看：自己 + Codex 都在命令词之前 → 0 个目标。
    const msg = {
      content: JSON.stringify({ text: '@_user_1 @_user_2 /grant' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },   // 本 bot（前导）
        { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },  // 另一操作 bot（前导）
      ],
    };
    expect(parseGrantTargets(msg, 'ou_bot')).toEqual([]);
  });

  it('text: only mentions AFTER /grant count as targets; leading operator dropped', () => {
    const msg = {
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2 @_user_3' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_op' }, name: 'OperatorBot' },  // 前导操作 bot → 剔除
        { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' },
        { key: '@_user_3', id: { open_id: 'ou_b' }, name: '李四' },
      ],
    };
    expect(parseGrantTargets(msg, 'ou_bot')).toEqual([
      { openId: 'ou_a', name: '张三' },
      { openId: 'ou_b', name: '李四' },
    ]);
  });

  it('text: key-prefix collision (@_user_1 leading vs @_user_10 trailing) resolved by position', () => {
    const msg = {
      content: JSON.stringify({ text: '@_user_10 /grant @_user_1' }),
      mentions: [
        { key: '@_user_10', id: { open_id: 'ou_op' }, name: 'OperatorBot' },  // 前导 → 剔除
        { key: '@_user_1', id: { open_id: 'ou_a' }, name: '张三' },           // 命令后 → 目标
      ],
    };
    expect(parseGrantTargets(msg, 'ou_bot')).toEqual([{ openId: 'ou_a', name: '张三' }]);
  });

  it('post: co-addressed operator bot BEFORE /grant node is NOT a target', () => {
    const postMsg = {
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Claude' },    // 本 bot（前导）
        { tag: 'at', user_id: 'ou_codex', user_name: 'Codex' },   // 另一操作 bot（前导）
        { tag: 'text', text: ' /grant' },
      ]] } }),
      mentions: [],
    };
    expect(parseGrantTargets(postMsg, 'ou_bot')).toEqual([]);
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
    const grantChat = findCardCallbackValue(JSON.parse(content), 'grant_chat');
    expect(pending.checkNonce('b1', 'oc_1', 'ou_z', grantChat.nonce)).toBe(true);
    expect(pending.getPendingGrantLimits('b1', 'oc_1', 'ou_z')?.durationMs).toBe(60 * 60 * 1000);
  });

  it('uses the configured finite duration for both the /grant card and pending limits', async () => {
    getBot('b1').config.grantDefaultDurationMs = 8 * 60 * 60 * 1000;

    await tryHandleGrantCommand('b1', grantMessage(), 'ou_owner');

    const [, , content] = replyMock.mock.calls.at(-1)!;
    const card = JSON.parse(content);
    const grantChat = findCardCallbackValue(card, 'grant_chat');
    const durationSelect = findCardNode(card, node => node?.tag === 'select_static' && node?.name === 'grant_duration');
    expect(durationSelect.initial_option).toBe(String(8 * 60 * 60 * 1000));
    expect(pending.getPendingGrantLimits('b1', 'oc_1', 'ou_z')).toMatchObject({
      durationMs: 8 * 60 * 60 * 1000,
    });
    expect(pending.checkNonce('b1', 'oc_1', 'ou_z', grantChat.nonce)).toBe(true);
  });

  it('non-admin: replies owner_only, no card', async () => {
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_intruder');
    expect(handled).toBe(true);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');  // text reply, not a card
    expect(content).toContain('管理员');                // owner_only message text
  });

  it('co-owner: can also execute /grant and card reflects co-owner', async () => {
    const bot = getBot('b1');
    bot.resolvedAllowedUsers = ['ou_owner', 'ou_coowner'];
    const handled = await tryHandleGrantCommand('b1', grantMessage(), 'ou_coowner');
    expect(handled).toBe(true);
    const [, , cardStr, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');
    const card = JSON.parse(cardStr);
    expect(card.body.elements[0].content).toContain('ou_coowner');
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
    const grantChat = findCardCallbackValue(JSON.parse(content), 'grant_chat');
    expect(grantChat.target_open_ids).toEqual(['ou_a', 'ou_b']);
    // one shared nonce validates every target
    expect(pending.checkNonce('bm', 'oc_1', 'ou_a', grantChat.nonce)).toBe(true);
    expect(pending.checkNonce('bm', 'oc_1', 'ou_b', grantChat.nonce)).toBe(true);
  });
});

describe('isGrantTargetOnly (text + post shapes)', () => {
  const textMsg = (text: string, mentions: any[]) => ({ content: JSON.stringify({ text }), mentions });

  it('text: bot @ after /grant → target only (true)', () => {
    const m = textMsg('@_user_1 /grant @_user_2', [
      { key: '@_user_1', id: { open_id: 'ou_op' } },
      { key: '@_user_2', id: { open_id: 'ou_bot' } },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(true);
  });

  it('text: bot @ before /grant (leading operator) → not target (false)', () => {
    const m = textMsg('@_user_1 /grant @_user_2', [
      { key: '@_user_1', id: { open_id: 'ou_bot' } },
      { key: '@_user_2', id: { open_id: 'ou_z' } },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(false);
  });

  it('text: bare /grant with no target mention of bot → false', () => {
    const m = textMsg('@_user_1 /grant', [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(false);
  });

  it('text: key-prefix collision — @_user_10 operator, @_user_1 is the target bot → true', () => {
    // indexOf('@_user_1') would wrongly hit '@_user_10' at pos 0; exact-token boundary fixes it.
    const m = textMsg('@_user_10 /grant @_user_1', [
      { key: '@_user_10', id: { open_id: 'ou_op' } },
      { key: '@_user_1', id: { open_id: 'ou_bot' } },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(true);
  });

  it('text: key-prefix collision — @_user_1 operator, @_user_10 is the target bot → true', () => {
    const m = textMsg('@_user_1 /grant @_user_10', [
      { key: '@_user_1', id: { open_id: 'ou_op' } },
      { key: '@_user_10', id: { open_id: 'ou_bot' } },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(true);
  });

  // post 形态：@ 是独立 `at` 节点（不在 text 里），mentions 可能为空 —— guard 仍须兜住。
  const postMsg = (nodes: any[]) => ({ content: JSON.stringify({ zh_cn: { content: [nodes] } }), mentions: [] });

  it('post: at(bot) after /grant text node → target only (true)', () => {
    const m = postMsg([
      { tag: 'at', user_id: 'ou_op', user_name: 'Claude' },
      { tag: 'text', text: ' /grant ' },
      { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(true);
  });

  it('post: at(bot) before /grant (leading operator) → not target (false)', () => {
    const m = postMsg([
      { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
      { tag: 'text', text: ' /grant ' },
      { tag: 'at', user_id: 'ou_z', user_name: '张三' },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(false);
  });

  it('post: no command keyword → false', () => {
    const m = postMsg([
      { tag: 'at', user_id: 'ou_op' },
      { tag: 'text', text: ' 帮我看下 ' },
      { tag: 'at', user_id: 'ou_bot' },
    ]);
    expect(isGrantTargetOnly(m, 'ou_bot')).toBe(false);
  });

  it('malformed / missing content / missing botOpenId → false', () => {
    expect(isGrantTargetOnly({ content: 'not json' }, 'ou_bot')).toBe(false);
    expect(isGrantTargetOnly({}, 'ou_bot')).toBe(false);
    expect(isGrantTargetOnly(textMsg('@_user_1 /grant @_user_2', []), undefined)).toBe(false);
  });
});

// 多 bot 群里把「另一个 bot」当 /grant 目标授权：`@OperatorBot /grant @ThisBot`。
// 目标 bot 的 daemon 也会收到这条消息（它被 @ 了），但它只是【目标】、不是被点名执行
// 命令的操作 bot——必须静默放手：不回 owner_only、不误判成裸 /grant 给整群开授权。
describe('tryHandleGrantCommand bot-as-target (@operator /grant @thisBot)', () => {
  // 本 daemon 的 bot = ou_bot，但它作为 /grant 的【目标】出现在命令词之后；
  // 前导 @ 的是另一个操作 bot ou_op。
  function targetBotMsg() {
    return {
      message_id: 'om_tb', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_op' }, name: 'Claude' },   // 操作 bot（前导 @）
        { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Codex' },   // 本 bot，作为目标
      ],
    };
  }

  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const bot = registerBot({ larkAppId: 'btb', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.allowedChatGroups = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('owner sender: swallows silently — no card, no whole-chat grant', async () => {
    const handled = await tryHandleGrantCommand('btb', targetBotMsg(), 'ou_owner');
    expect(handled).toBe(true);                                  // intercepted, not fed to CLI
    expect(replyMock).not.toHaveBeenCalled();                    // no card, no reply
    expect(getBot('btb').config.allowedChatGroups ?? []).toEqual([]);  // chat NOT opened
  });

  it('non-owner sender: does NOT reply "仅 owner 可使用 /grant"', async () => {
    const handled = await tryHandleGrantCommand('btb', targetBotMsg(), 'ou_intruder');
    expect(handled).toBe(true);
    expect(replyMock).not.toHaveBeenCalled();                    // the reported spurious owner_only must not fire
  });

  it('post shape, non-owner sender: still swallows silently (no owner_only)', async () => {
    // 富文本形态 `@OperatorBot /grant @ThisBot`，mentions 为空、@ 在 post 的 at 节点里。
    const postMsg = {
      message_id: 'om_ptb', chat_id: 'oc_1',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_op', user_name: 'Claude' },
        { tag: 'text', text: ' /grant ' },
        { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
      ]] } }),
      mentions: [],
    };
    const handled = await tryHandleGrantCommand('btb', postMsg, 'ou_intruder');
    expect(handled).toBe(true);
    expect(replyMock).not.toHaveBeenCalled();
    expect(getBot('btb').config.allowedChatGroups ?? []).toEqual([]);
  });

  it('post shape, owner sender, this bot IS operator: pops card for target, whole-chat NOT opened', async () => {
    // `@ThisBot /grant @TargetBot` 富文本：ou_bot 是前导操作 bot，ou_target 是目标。
    const opPostMsg = {
      message_id: 'om_pop', chat_id: 'oc_1',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
        { tag: 'text', text: ' /grant ' },
        { tag: 'at', user_id: 'ou_target', user_name: '张三' },
      ]] } }),
      mentions: [],
    };
    const handled = await tryHandleGrantCommand('btb', opPostMsg, 'ou_owner');
    expect(handled).toBe(true);
    const [, , content, msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');                        // 弹授权卡，不是整群授权
    expect(content).toContain('张三');                           // 目标出现在卡里
    expect(getBot('btb').config.allowedChatGroups ?? []).toEqual([]);  // 整群授权未被误触
  });

  it('still pops a card when this bot IS the leading operator (regression guard)', async () => {
    // @ThisBot /grant @someone → ou_bot is the operator, ou_z is the human target.
    const opMsg = {
      message_id: 'om_op', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Codex' },  // 本 bot 是操作 bot
        { key: '@_user_2', id: { open_id: 'ou_z' }, name: '张三' },
      ],
    };
    const handled = await tryHandleGrantCommand('btb', opMsg, 'ou_owner');
    expect(handled).toBe(true);
    const [, , , msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType).toBe('interactive');                         // card still pops for the operator
  });

  // 本 bot 以 **app_id 形态**（larkAppId=btb）作为目标出现在命令词后。这是协作 bot 被 @
  // 的常见形态。修复前 guard 只认 open_id → 漏判 → parseGrantTargets 的 .filter(openId)
  // 把 app_id-only 自身剔空 → targets 空 → 误走整群授权分支（提权，codex 警告的失败模式）。
  it('owner sender, this bot @ed as app_id after /grant → silent, whole-chat NOT opened', async () => {
    const appIdTargetMsg = {
      message_id: 'om_aid', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_op' }, name: 'Claude' },      // 操作 bot（前导 @）
        { key: '@_user_2', id: 'btb', id_type: 'app_id', name: 'Codex' },   // 本 bot，app_id 形态目标
      ],
    };
    const handled = await tryHandleGrantCommand('btb', appIdTargetMsg, 'ou_owner');
    expect(handled).toBe(true);
    expect(replyMock).not.toHaveBeenCalled();
    expect(getBot('btb').config.allowedChatGroups ?? []).toEqual([]);   // 整群授权绝不被误开
  });

  // OPERATOR 视角（codex delta-3）：本 bot 是**前导** operator（命令前），尾部目标是**别的**
  // app_id-only bot。parseGrantTargets 的 .filter 会把 app_id-only 目标剔空 → targets 空 →
  // 若据此走裸 /grant 整群授权 = 提权（owner 本意授权某 bot，误对全群开放 talk）。必须 fail
  // closed：hasAnyTargetMention 识别「命令后有目标只是不可按 open_id 授权」→ 回 usage、不开整群。
  it('owner sender, this bot is OPERATOR + tail target is another app_id-only bot → fail closed, whole-chat NOT opened', async () => {
    const opWithAppIdTarget = {
      message_id: 'om_opa', chat_id: 'oc_1',
      content: JSON.stringify({ text: '@_user_1 /grant @_user_2' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Codex' },          // 本 bot = 前导 operator
        { key: '@_user_2', id: 'cli_other', id_type: 'app_id', name: 'Other' }, // 别的 bot，app_id-only，尾部目标
      ],
    };
    const handled = await tryHandleGrantCommand('btb', opWithAppIdTarget, 'ou_owner');
    expect(handled).toBe(true);
    expect(getBot('btb').config.allowedChatGroups ?? []).toEqual([]);   // 绝不因目标被剔空而误开整群
    // 且不是静默：应回 usage 明确「不按 app_id 授权」，不能与真正裸 /grant 等价。
    const [, , content, msgType] = replyMock.mock.calls.at(-1) ?? [];
    expect(msgType ?? 'text').not.toBe('interactive');   // 不是授权卡
    expect(String(content ?? '')).not.toContain('已授权本群所有成员');   // 绝不是整群授权回执
  });
});

describe('tryHandleGrantCommand two bots co-addressed (@Claude @Codex /grant)', () => {
  // 实测 bug：`@Claude @Codex /grant`（两 bot 都在命令词之前、命令后无目标）。从本 bot=ou_bot
  // 的 daemon 看，另一个 bot 在命令词之前 = 操作 bot 点名，不是 grantee → 绝不能弹「授权对方 bot」
  // 的卡（那会导致两 bot 互相授权 + 唤醒对方拉空会话）。命令后无目标 → 落进裸 /grant 整群分支。
  function coAddressedMsg() {
    return {
      message_id: 'om_co', chat_id: 'oc_room',
      content: JSON.stringify({ text: '@_user_1 @_user_2 /grant' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },    // 本 bot（前导）
        { key: '@_user_2', id: { open_id: 'ou_codex' }, name: 'Codex' },   // 另一操作 bot（前导）
      ],
    };
  }

  let configPath: string;
  beforeEach(() => {
    replyMock.mockClear();
    pending._resetForTest();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-grant-co-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = dir; // isolate allowedUsers sidecar (revokeGrant writes it)
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: 'bco', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] },
    ], null, 2), 'utf-8');
    loadBotConfigs().forEach(c => registerBot(c));
    const bot = getBot('bco');
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; vi.restoreAllMocks(); });

  it('owner: does NOT grant the other bot — no per-target card, no chatGrants entry', async () => {
    const handled = await tryHandleGrantCommand('bco', coAddressedMsg(), 'ou_owner');
    expect(handled).toBe(true);
    // 没有针对「另一个 bot」开 pending（互相授权的核心症状）→ pending 表为空。
    expect(pending._tableSizeForTest()).toBe(0);
    // 对方 bot 绝不被写进 chatGrants（互相授权的落库症状）。
    expect(getBot('bco').config.chatGrants?.['oc_room'] ?? []).not.toContain('ou_codex');
    // 落进裸 /grant 整群分支：纯文本回执，不是「授权对方 bot」的授权卡。
    const [, , , msgType] = replyMock.mock.calls.at(-1)!;
    expect(msgType ?? 'text').not.toBe('interactive');
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
    process.env.SESSION_DATA_DIR = dir; // isolate allowedUsers sidecar (revokeGrant writes it)
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: 'b2', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] },
    ], null, 2), 'utf-8');
    loadBotConfigs().forEach(c => registerBot(c));
    const bot = getBot('b2');
    bot.botOpenId = 'ou_bot';
    bot.resolvedAllowedUsers = ['ou_owner'];
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; vi.restoreAllMocks(); });

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
