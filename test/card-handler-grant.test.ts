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

  it('owner grant_chat WITH card id → 同步返回终态卡 patch + 后台 @notify + withdraw + persists', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();           // 同步先回「已授权」终态卡（避免 callback 超时/竞态 → 300000）
    await flushBackground();                       // 通知 + 撤卡走后台 fire-and-forget
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
    expect(deleteMock).toHaveBeenCalledWith('h1', 'om_card');
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
    expect(pending.checkNonce('h1', 'oc_1', 'ou_g', nonce)).toBe(false);
  });

  it('卡片在话题里（有 thread_id）→ 线程化回复（reply_in_thread=true）', async () => {
    const { pending, handler } = await fresh();
    getMessageDetailMock.mockResolvedValueOnce({ items: [{ thread_id: 'omt_topic' }] });
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(getMessageDetailMock).toHaveBeenCalledWith('h1', 'om_card');
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
  });

  it('普通群顶层消息（无 thread_id）→ 普通回复落到群里（reply_in_thread=false，不开新话题）', async () => {
    const { pending, handler } = await fresh();
    getMessageDetailMock.mockResolvedValueOnce({ items: [{}] });  // 无 thread_id
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', false);
  });

  it('thread_id 探测失败（API 抛错）→ 退回线程化回复（reply_in_thread=true）', async () => {
    const { pending, handler } = await fresh();
    getMessageDetailMock.mockRejectedValueOnce(new Error('lark 500'));
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
  });

  it('detail.items 为空 → 视为探测失败，退回线程化回复（不误判成普通回复）', async () => {
    const { pending, handler } = await fresh();
    getMessageDetailMock.mockResolvedValueOnce({ items: [] });
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
  });

  it('owner grant_chat WITHOUT card id → fallback in-place card patch, persists', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }), deps, 'h1');
    expect(res?.elements).toBeTruthy();           // raw card body (dispatcher wraps as patch)
    expect(deleteMock).not.toHaveBeenCalled();
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });

  it('withdraw returns false (swallowed SDK error) → fallback patch, still persisted', async () => {
    const { registry, pending, handler } = await fresh();
    deleteMock.mockResolvedValueOnce(false);   // production deleteMessage swallows errors → returns false
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_chat', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();           // fell through to in-place patch
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
  });

  it('deny → in-place result patch + cooldown, never touches grant-store', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_deny', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(pending.isThrottled('h1', 'oc_1', 'ou_g')).toBe(true);
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('owner grant_global → writes globalGrants (not chatGrants/allowedUsers), 终态卡 patch + 后台 notify + withdraw', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(action('grant_global', { nonce }, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();
    await flushBackground();
    expect(replyMock).toHaveBeenCalledWith('h1', 'om_card', expect.stringContaining('ou_g'), 'interactive', true);
    expect(deleteMock).toHaveBeenCalledWith('h1', 'om_card');
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

  it('multi grant_chat: 一次授权全部目标 + 终态卡 patch + 后台 @通知全部 + 撤卡 + 清 pending', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_a', 'ou_b', 'ou_c']);
    const res = await handler.handleCardAction(multiAction('grant_chat', ['ou_a', 'ou_b', 'ou_c'], nonce, 'om_card'), deps, 'h1');
    expect(res?.elements).toBeTruthy();
    await flushBackground();
    // 通知 @ 了全部三人
    const notify = replyMock.mock.calls.at(-1)![2] as string;
    expect(notify).toContain('ou_a'); expect(notify).toContain('ou_b'); expect(notify).toContain('ou_c');
    expect(deleteMock).toHaveBeenCalledWith('h1', 'om_card');
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
    expect(res?.elements).toBeTruthy();
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

  // 申晗实测 bug：手动 /grant 一个 bot 后，通知卡若 <at> 对方 bot 会唤醒其 daemon 误拉空会话。
  // 修复后通知卡对 bot grantee 只用纯文本名字（无 <at>），对真人仍 @。
  it('通知卡：bot grantee 用纯文本名字（无 <at>），不唤醒对方 bot', async () => {
    const { pending, handler } = await fresh();
    // 默认 isHumanMock=false → ou_bot2 判为 bot。
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_bot2'], target_names: ['Codex'], chat_id: 'oc_1', nonce } },
    };
    await handler.handleCardAction(data, deps, 'h1');
    await flushBackground();
    const notify = replyMock.mock.calls.at(-1)![2] as string;
    expect(notify).not.toContain('<at id=ou_bot2');   // bot 绝不被 <at>
    expect(notify).toContain('Codex');                 // 纯文本名字保留可读信息
  });

  it('通知卡：真人 grantee 仍 @ 点名（真人被 @ 不会自动开会话）', async () => {
    const { pending, handler } = await fresh();
    isHumanMock.mockImplementation(async (_app: string, openId: string) => openId === 'ou_human');
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_human', 'ou_bot2']);
    const data: any = {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ['ou_human', 'ou_bot2'], target_names: ['真人', 'Codex'], chat_id: 'oc_1', nonce } },
    };
    await handler.handleCardAction(data, deps, 'h1');
    await flushBackground();
    const notify = replyMock.mock.calls.at(-1)![2] as string;
    expect(notify).toContain('<at id=ou_human></at>');  // 真人 → @
    expect(notify).not.toContain('<at id=ou_bot2');      // bot → 纯文本
    expect(notify).toContain('Codex');
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
});
