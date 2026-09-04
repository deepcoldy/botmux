/**
 * card-handler 群内授权动作：owner 强闸门 + nonce + 撤回卡/通知/兜底 patch。
 * Run: pnpm vitest run test/card-handler-grant.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const replyMock = vi.fn(async () => 'om_notify');
const deleteMock = vi.fn(async () => true);  // deleteMessage now returns boolean (success)
// 默认：卡片处于话题里（有 thread_id）→ 线程化回复。单测可 mockResolvedValueOnce 改写。
const getMessageDetailMock = vi.fn(async () => ({ items: [{ thread_id: 'omt_thread' }] }));
// 默认所有 open_id 判为「非真人」（bot）→ 全部登记花名册；需要模拟真人用 mockImplementation。
const isHumanMock = vi.fn(async () => false);
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...a: any[]) => replyMock(...a),
    deleteMessage: (...a: any[]) => deleteMock(...a),
    getMessageDetail: (...a: any[]) => getMessageDetailMock(...a),
    isHumanOpenId: (...a: any[]) => isHumanMock(...a),
  };
});

// 拦截 observed 登记（grant 成功后的自动 introduce），断言被授权目标被记进花名册。
const recordObservedMock = vi.fn();
vi.mock('../src/services/observed-bots-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/observed-bots-store.js')>();
  return { ...actual, recordObservedBots: (...a: any[]) => recordObservedMock(...a) };
});

let configPath: string;
const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

// 授权成功后，通知卡 / 撤回原卡现在走 fire-and-forget 后台：handleCardAction 先同步返回
// 「已授权」终态卡（in-place patch），避免 callback 等太久或 deleteMessage 竞态 → 飞书 300000。
// 一次宏任务（setTimeout 0）会等整条后台微任务链排空，再断言后台副作用（reply/delete）。
const flushBackground = () => new Promise(resolve => setTimeout(resolve, 0));

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const pending = await import('../src/im/lark/grant-pending.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { registry, pending, handler };
}

function action(a: string, extra: Record<string, any> = {}, openMsgId?: string) {
  const data: any = { operator: { open_id: extra.operator ?? 'ou_owner' }, action: { value: { action: a, target_open_id: 'ou_g', chat_id: 'oc_1', nonce: extra.nonce } } };
  if (openMsgId) data.context = { open_message_id: openMsgId };
  return data;
}

beforeEach(() => {
  replyMock.mockClear(); deleteMock.mockClear(); deleteMock.mockImplementation(async () => true);
  getMessageDetailMock.mockClear(); getMessageDetailMock.mockImplementation(async () => ({ items: [{ thread_id: 'omt_thread' }] }));
  recordObservedMock.mockClear();
  isHumanMock.mockClear(); isHumanMock.mockImplementation(async () => false);
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cardgrant-'));
  configPath = join(dir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] }], null, 2));
  process.env.BOTS_CONFIG = configPath;
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

describe('card-handler grant actions', () => {
  it('non-owner click → owner_only toast, no grant', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { operator: 'ou_x', nonce }), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('stale nonce → expired toast, no grant', async () => {
    const { registry, handler } = await fresh();
    const res = await handler.handleCardAction(action('grant_chat', { nonce: 'stale' }), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('persists duration and free-form quota submitted with the grant button', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const submitted: any = action('grant_chat', { nonce });
    submitted.action.form_value = {
      grant_duration: String(8 * 60 * 60 * 1000),
      grant_quota: '17',
    };
    const before = Date.now();
    await handler.handleCardAction(submitted, deps, 'h1');
    const cfg = registry.getBot('h1').config;
    expect(cfg.quotaState?.['chat:oc_1:ou_g']).toEqual({ limit: 17, used: 0 });
    const expiresAt = cfg.grantExpiryState?.['chat:oc_1:ou_g']?.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 8 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60 * 1000);
  });

  it('rejects invalid free-form quota without granting access', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const submitted: any = action('grant_chat', { nonce });
    submitted.action.form_value = {
      grant_duration: String(60 * 60 * 1000),
      grant_quota: 'abc',
    };
    const res = await handler.handleCardAction(submitted, deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(res?.toast?.content).toBe('消息额度请输入 1–1000 的整数，留空表示不限');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('rejects a quota above 1000 with an actionable error', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const submitted: any = action('grant_chat', { nonce });
    submitted.action.form_value = {
      grant_duration: String(60 * 60 * 1000),
      grant_quota: '10000',
    };
    const res = await handler.handleCardAction(submitted, deps, 'h1');
    expect(res?.toast).toEqual({
      type: 'error',
      content: '消息额度请输入 1–1000 的整数，留空表示不限',
    });
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('owner grant_chat WITH card id → 就地 patch 原卡为终态(正文 @ 被授权人)，不发通知卡、不撤回', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    // 就地 patch 的终态卡正文直接 @ 被授权人（一张卡既是结果态又 ping 到 ta）
    expect(res?.body?.elements).toBeTruthy();
    expect(JSON.stringify(res)).toContain('ou_g');
    await flushBackground();
    // 不再单独发通知卡、不再撤回原卡（申晗 2026-07-31：直接在原卡更新即可）
    expect(replyMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
    expect(pending.checkNonce('h1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });

  it('owner grant_chat WITHOUT card id → 同样就地 patch(@ 被授权人)，不撤回', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }), deps, 'h1');
    expect(res?.body?.elements).toBeTruthy();     // raw card body (dispatcher wraps as patch)
    expect(JSON.stringify(res)).toContain('ou_g');
    expect(deleteMock).not.toHaveBeenCalled();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });

  it('deny → in-place result patch + cooldown, never touches grant-store', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_deny', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.body?.elements).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(pending.isThrottled('h1', 'oc_1', 'ou_g')).toBe(true);
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('owner grant_global → writes globalGrants (not chatGrants/allowedUsers), 就地 patch 终态卡(@ 被授权人)，不发通知不撤回', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_global', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.body?.elements).toBeTruthy();
    expect(JSON.stringify(res)).toContain('ou_g');   // 终态卡正文 @ 被授权人
    await flushBackground();
    expect(replyMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    const cfg = registry.getBot('h1').config;
    expect(cfg.globalGrants).toEqual(['ou_g']);
    expect(cfg.chatGrants).toBeUndefined();
    expect(cfg.allowedUsers).toEqual(['ou_owner']);   // owner-only; never widened
  });

  it('non-owner grant_global → owner_only toast, no grant', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_global', { operator: 'ou_x', nonce }), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.globalGrants).toBeUndefined();
  });

  // ─── 多目标（一次 /grant @a @b @c → 一张卡，点一次范围对全部生效）─────────────
  function multiAction(a: string, ids: string[], nonce: string, openMsgId?: string) {
    const data: any = { operator: { open_id: 'ou_owner' }, action: { value: { action: a, target_open_ids: ids, chat_id: 'oc_1', nonce } } };
    if (openMsgId) data.context = { open_message_id: openMsgId };
    return data;
  }

  it('multi grant_chat: 一次授权全部目标 + 就地 patch 终态卡(@ 全部三人) + 清 pending', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_a', 'ou_b', 'ou_c']);
    const res = await handler.handleCardAction(multiAction('grant_chat', ['ou_a', 'ou_b', 'ou_c'], nonce, 'om_card'), deps, 'h1');
    expect(res?.body?.elements).toBeTruthy();
    await flushBackground();
    // 就地 patch 的终态卡 @ 了全部三人（不再单独发通知卡、不撤回）
    const patched = JSON.stringify(res);
    expect(patched).toContain('ou_a'); expect(patched).toContain('ou_b'); expect(patched).toContain('ou_c');
    expect(replyMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_a', 'ou_b', 'ou_c'] });
    expect(pending.checkNonce('h1', 'oc_1', 'ou_a', nonce)).toBe(false);
    expect(pending.checkNonce('h1', 'oc_1', 'ou_c', nonce)).toBe(false);
  });

  it('multi: 任一目标 nonce 不匹配 → 整卡失效 toast，零落库', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_a', 'ou_b']);  // ou_c 未开 pending
    const res = await handler.handleCardAction(multiAction('grant_chat', ['ou_a', 'ou_b', 'ou_c'], nonce, 'om_card'), deps, 'h1');
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('multi grant_deny → 全部目标进冷却，零落库，不登记花名册', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_a', 'ou_b']);
    const res = await handler.handleCardAction(multiAction('grant_deny', ['ou_a', 'ou_b'], nonce, 'om_card'), deps, 'h1');
    expect(res?.body?.elements).toBeTruthy();
    expect(pending.isThrottled('h1', 'oc_1', 'ou_a')).toBe(true);
    expect(pending.isThrottled('h1', 'oc_1', 'ou_b')).toBe(true);
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
    expect(recordObservedMock).not.toHaveBeenCalled();  // 拒绝不登记
  });

  it('grant 成功 → 自动把被授权 bot 登记进 observed 花名册（携 target_names）', async () => {
    const { pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_a', 'ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_a', 'ou_bot2'], target_names: ['张三', 'Codex'], chat_id: 'oc_1', nonce } },
    };
    await handler.handleCardAction(data, deps, 'h1');
    expect(recordObservedMock).toHaveBeenCalledTimes(1);
    const [, appId, chatId, entries, source] = recordObservedMock.mock.calls.at(-1)!;
    expect(appId).toBe('h1'); expect(chatId).toBe('oc_1'); expect(source).toBe('introduce');
    expect(entries).toEqual([{ openId: 'ou_a', name: '张三' }, { openId: 'ou_bot2', name: 'Codex' }]);
  });

  // 实测 bug：手动 /grant 一个 bot 后，若 <at> 对方 bot 会唤醒其 daemon 误拉空会话。
  // 混合规则：能拿到 bot 名字就用纯文本名字（无 <at>，不唤醒对方），对真人仍 @。
  // 现在 @ 渲染在**就地 patch 的终态卡正文**里（不再单独发通知卡）。
  it('终态卡 @：有名字的 bot grantee 用纯文本名字（无 <at>），不唤醒对方 bot', async () => {
    const { pending, handler } = await fresh();
    // 默认 isHumanMock=false → ou_bot2 判为 bot。
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_bot2'], target_names: ['Codex'], chat_id: 'oc_1', nonce } },
    };
    const res = await handler.handleCardAction(data, deps, 'h1');
    const patched = JSON.stringify(res);
    expect(patched).not.toContain('<at id=ou_bot2');   // 有名字的 bot 不被 <at>
    expect(patched).toContain('Codex');                 // 纯文本名字保留可读信息
  });

  // 名字缺失（target_names 为空）才退回 @ 兜底：飞书据 open_id 展示身份（远比裸 open_id 可读），
  // 代价=可能偶尔触发一次空会话（产品上可接受，边角情况）。
  it('终态卡 @：拿不到名字的 bot grantee 用 @ 兜底（而非裸 open_id）', async () => {
    const { pending, handler } = await fresh();
    // isHumanMock=false → ou_bot2 判为 bot；target_names 缺失 → 名字取不到。
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_bot2'], target_names: [], chat_id: 'oc_1', nonce } },
    };
    const res = await handler.handleCardAction(data, deps, 'h1');
    expect(JSON.stringify(res)).toContain('<at id=ou_bot2></at>');  // 无名字 → @ 兜底
  });

  it('终态卡 @：真人 grantee 仍 @ 点名（真人被 @ 不会自动开会话）', async () => {
    const { pending, handler } = await fresh();
    isHumanMock.mockImplementation(async (_app: string, openId: string) => openId === 'ou_human');
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_human', 'ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_human', 'ou_bot2'], target_names: ['真人', 'Codex'], chat_id: 'oc_1', nonce } },
    };
    const res = await handler.handleCardAction(data, deps, 'h1');
    const patched = JSON.stringify(res);
    expect(patched).toContain('<at id=ou_human></at>');  // 真人 → @
    expect(patched).not.toContain('<at id=ou_bot2');      // bot → 纯文本
    expect(patched).toContain('Codex');
  });

  it('grant 成功 → 查通讯录确认是真人的目标不登记花名册（避免污染 bot 列表）', async () => {
    const { registry, pending, handler } = await fresh();
    isHumanMock.mockImplementation(async (_app: string, openId: string) => openId === 'ou_human');
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_human', 'ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_human', 'ou_bot2'], target_names: ['真人', 'Codex'], chat_id: 'oc_1', nonce } },
    };
    await handler.handleCardAction(data, deps, 'h1');
    // 授权本身两个都落库（真人也能获对话权），只是花名册只收 bot
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_human', 'ou_bot2'] });
    expect(recordObservedMock).toHaveBeenCalledTimes(1);
    const [, , , entries] = recordObservedMock.mock.calls.at(-1)!;
    expect(entries).toEqual([{ openId: 'ou_bot2', name: 'Codex' }]);  // 真人 ou_human 被剔除
  });

  it('co-owner in allowedUsers (not first owner) can also grant access', async () => {
    const { registry, pending, handler } = await fresh();
    const bot = registry.getBot('h1');
    bot.resolvedAllowedUsers = ['ou_owner', 'ou_coowner'];
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { operator: 'ou_coowner', nonce }), deps, 'h1');
    expect(res?.toast?.type).toBeUndefined();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });
});
