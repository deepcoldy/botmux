import { describe, it, expect } from 'vitest';
import { buildGrantCard, buildGrantResultCard, buildGrantNotifyCard, buildGrantRequesterNoticeCard, buildQuotaExhaustedCard } from '../src/im/lark/card-builder.js';
import { normalizeGrantQuotaOption } from '../src/services/grant-policy.js';

function deepFind(node: any, predicate: (value: any) => boolean): any[] {
  const out: any[] = [];
  if (predicate(node)) out.push(node);
  if (Array.isArray(node)) {
    for (const child of node) out.push(...deepFind(child, predicate));
  } else if (node && typeof node === 'object') {
    for (const child of Object.values(node)) out.push(...deepFind(child, predicate));
  }
  return out;
}

function callbackValue(node: any): any {
  return node?.behaviors?.[0]?.value ?? node?.value;
}

describe('buildGrantCard', () => {
  it('embeds @owner, requester name, and nonce-bearing actions', () => {
    const json = buildGrantCard(
      { ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_g', name: '张三' }], chatId: 'oc_1', nonce: 'n1', mode: 'request' },
      'zh',
    );
    const card = JSON.parse(json);
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_owner></at>');
    expect(flat).toContain('张三');
    expect(card.schema).toBe('2.0');
    const actions = deepFind(card, value => value?.tag === 'button');
    const byAction = Object.fromEntries(actions.map((a: any) => [callbackValue(a).action, callbackValue(a)]));
    expect(byAction.grant_chat).toMatchObject({ target_open_ids: ['ou_g'], chat_id: 'oc_1', nonce: 'n1' });
    expect(byAction.grant_deny).toMatchObject({ target_open_ids: ['ou_g'], chat_id: 'oc_1', nonce: 'n1' });
    // request mode (member self-application) offers chat-only — no global button,
    // so a member can't self-request global. (global is owner-initiated, talk-only.)
    expect(byAction.grant_global).toBeUndefined();
  });

  it('owner mode carries chat + global (talk-only) + deny actions', () => {
    const card = JSON.parse(buildGrantCard(
      { ownerOpenId: 'ou_o', targets: [{ openId: 'ou_g', name: 'Bob' }], chatId: 'oc_2', nonce: 'n2', mode: 'owner' }, 'en',
    ));
    const actions = deepFind(card, value => value?.tag === 'button');
    expect(actions).toHaveLength(3);
    const byAction = Object.fromEntries(actions.map((a: any) => [callbackValue(a).action, callbackValue(a)]));
    expect(byAction.grant_chat).toMatchObject({ target_open_ids: ['ou_g'], chat_id: 'oc_2', nonce: 'n2' });
    expect(byAction.grant_global).toMatchObject({ target_open_ids: ['ou_g'], chat_id: 'oc_2', nonce: 'n2' });
    expect(byAction.grant_deny).toMatchObject({ target_open_ids: ['ou_g'], chat_id: 'oc_2', nonce: 'n2' });
  });

  it('owner multi-target: lists every name + carries all open_ids in one card', () => {
    const card = JSON.parse(buildGrantCard(
      {
        ownerOpenId: 'ou_o',
        targets: [{ openId: 'ou_a', name: '张三' }, { openId: 'ou_b', name: '李四' }, { openId: 'ou_bot', name: 'Codex' }],
        chatId: 'oc_3', nonce: 'n3', mode: 'owner',
      }, 'zh',
    ));
    const flat = JSON.stringify(card);
    expect(flat).toContain('张三');
    expect(flat).toContain('李四');
    expect(flat).toContain('Codex');
    const actions = deepFind(card, value => value?.tag === 'button');
    const byAction = Object.fromEntries(actions.map((a: any) => [callbackValue(a).action, callbackValue(a)]));
    // one click → all three targets, shared nonce
    expect(byAction.grant_chat).toMatchObject({ target_open_ids: ['ou_a', 'ou_b', 'ou_bot'], chat_id: 'oc_3', nonce: 'n3' });
    expect(byAction.grant_global).toMatchObject({ target_open_ids: ['ou_a', 'ou_b', 'ou_bot'], chat_id: 'oc_3', nonce: 'n3' });
  });

  it('defaults to one hour and three messages in one two-column row', () => {
    const card = JSON.parse(buildGrantCard(
      { ownerOpenId: 'ou_o', targets: [{ openId: 'ou_g', name: 'Bob' }], chatId: 'oc_2', nonce: 'n2', mode: 'owner' },
      'zh',
    ));
    const expiry = deepFind(card, value => value?.tag === 'select_static' && value?.name === 'grant_duration')[0];
    const quota = deepFind(card, value => value?.tag === 'input' && value?.name === 'grant_quota')[0];
    expect(expiry.initial_option).toBe('3600000');
    expect(quota.default_value).toBe('3');
    expect(quota.options).toBeUndefined();
    expect(quota.max_length).toBeUndefined();
    expect(deepFind(card, value => value?.tag === 'collapsible_panel')).toHaveLength(0);
    const limitsRow = deepFind(card, value =>
      value?.tag === 'column_set'
      && value?.flex_mode === 'bisect'
      && deepFind(value, child => child === expiry).length === 1,
    )[0];
    expect(deepFind(limitsRow, value => value === quota)).toHaveLength(1);
    const form = deepFind(card, value => value?.tag === 'form' && value?.name === 'grant_limits_form')[0];
    expect(deepFind(form, value => value === expiry)).toHaveLength(1);
    const actions = deepFind(form, value => value?.tag === 'button');
    // v2(schema 2.0)卡片表单提交按钮**必须**用 action_type: 'form_submit'——曾误改成
    // form_action_type: 'submit' 导致点击授权按钮无任何反应(callback 不触发)。显式断言
    // 正确字段 + 拒绝错误字段,防再次静默回归。
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(action => action.action_type === 'form_submit')).toBe(true);
    expect(actions.every(action => action.form_action_type === undefined)).toBe(true);
    expect(card.header).toMatchObject({
      template: 'orange',
      title: { content: '🔑 使用授权' },
    });
    const byAction = Object.fromEntries(actions.map((action: any) => [callbackValue(action).action, action]));
    expect(byAction.grant_chat).toMatchObject({ type: 'primary', text: { content: '授权本群对话' } });
    expect(byAction.grant_deny).toMatchObject({ type: 'danger', text: { content: '拒绝' } });
  });

  it('P2: clamps an over-max default quota so the card stays submittable', () => {
    // 历史 messageQuota.defaultLimit（parser 无上限）可能 >1000；卡片初值必须夹到
    // normalize 认得的区间，否则 owner 一点授权就报「参数无效」发不出去。
    const card = JSON.parse(buildGrantCard(
      { ownerOpenId: 'ou_o', targets: [{ openId: 'ou_g', name: 'Bob' }], chatId: 'oc_2', nonce: 'n2', mode: 'owner', quota: 1001 },
      'zh',
    ));
    const quota = deepFind(card, value => value?.tag === 'input' && value?.name === 'grant_quota')[0];
    expect(quota.default_value).toBe('1000');
    // 且这个初值必须能通过服务端 normalize（不是 null=坏卡）
    expect(normalizeGrantQuotaOption(quota.default_value)).toBe(1000);
  });

  it('buildGrantNotifyCard @-mentions every granted target (legacy string[] = humans)', () => {
    const card = JSON.parse(buildGrantNotifyCard('chat', ['ou_a', 'ou_b'], 'zh'));
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_a></at>');
    expect(flat).toContain('<at id=ou_b></at>');
  });

  // 混合规则：bot grantee 有名字 → 纯文本（不 <at>，避免唤醒对方 bot 的 daemon 误拉空会话）；
  // 真人 grantee → @ 点名（真人被 @ 不会自动开会话）。
  it('buildGrantNotifyCard renders known-name bot grantees as PLAIN name (no <at>), humans as @', () => {
    const card = JSON.parse(buildGrantNotifyCard('chat', [
      { openId: 'ou_human', name: '张三', isBot: false },
      { openId: 'ou_codex', name: 'Codex', isBot: true },
    ], 'zh'));
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_human></at>');   // 真人 → @
    expect(flat).not.toContain('<at id=ou_codex');     // 有名字的 bot → 无 <at>
    expect(flat).toContain('Codex');                   // 有名字的 bot → 纯文本名字
  });

  // 名字缺失才退回 @ 兜底：飞书据 open_id 展示身份（远比裸 open_id 可读），代价=可能偶尔一次空会话（可接受）。
  it('buildGrantNotifyCard bot grantee WITHOUT name falls back to @mention (no bare open_id)', () => {
    const card = JSON.parse(buildGrantNotifyCard('chat', [{ openId: 'ou_codex', isBot: true }], 'zh'));
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_codex></at>');   // 无名字 → @ 兜底
  });

  it('buildGrantResultCard has no buttons', () => {
    const card = JSON.parse(buildGrantResultCard('chat', 'zh'));
    expect(deepFind(card, value => value?.tag === 'button')).toHaveLength(0);
  });

  it('buildGrantResultCard 带 targets 时正文 @ 被授权人 + 额度/有效期(就地 patch 即通知)', () => {
    // 申晗 2026-07-31：授权成功直接就地更新原卡即可,原卡结果态里带 @被授权人,不再单独发通知卡。
    const expiresAt = 1_800_000_000_000;
    const flat = buildGrantResultCard('chat', 'zh', 5, expiresAt, [{ openId: 'ou_g', name: '张三', isBot: false }]);
    expect(flat).toContain('<at id=ou_g></at>');   // @ 真人被授权人
    expect(flat).toContain('5');                    // 额度
    const card = JSON.parse(flat);
    expect(deepFind(card, value => value?.tag === 'button')).toHaveLength(0);  // 终态卡无按钮
    // 有名字的 bot 用纯文本(不 <at> 免唤醒),真人 <at>
    const botFlat = buildGrantResultCard('chat', 'zh', undefined, undefined, [{ openId: 'ou_bot', name: 'Codex', isBot: true }]);
    expect(botFlat).not.toContain('<at id=ou_bot');
    expect(botFlat).toContain('Codex');
  });

  it('buildGrantResultCard deny 或无 targets → 回落简单状态态(无 @)', () => {
    expect(buildGrantResultCard('deny', 'zh', undefined, undefined, [{ openId: 'ou_g', name: '张三' }]))
      .not.toContain('<at id=ou_g');  // deny 不 @
    expect(buildGrantResultCard('chat', 'zh')).not.toContain('<at');  // 无 targets 不 @
  });
});

describe('grant request card forwarded to the approver DM', () => {
  function byAction(json: string): Record<string, any> {
    const actions = deepFind(JSON.parse(json), value => value?.tag === 'button');
    return Object.fromEntries(actions.map((a: any) => [callbackValue(a).action, callbackValue(a)]));
  }

  it('dm_p2p: body names the requester without @owner, button says DM, value carries delivery', () => {
    const json = buildGrantCard(
      { ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_g', name: '张三' }], chatId: 'oc_p2p', nonce: 'n1', mode: 'request', delivery: 'dm_p2p' },
      'zh',
    );
    expect(json).toContain('张三');
    expect(json).toContain('私聊中申请');
    expect(json).not.toContain('<at id=ou_owner>');
    expect(json).toContain('授权私聊对话');
    const actions = byAction(json);
    expect(actions.grant_chat).toMatchObject({ chat_id: 'oc_p2p', nonce: 'n1', delivery: 'dm_p2p' });
    expect(actions.grant_deny).toMatchObject({ delivery: 'dm_p2p' });
    expect(actions.grant_chat.chat_name).toBeUndefined();
    // 自助申请仍然只给本会话授权，不提供全局授权
    expect(actions.grant_global).toBeUndefined();
  });

  it('dm_group: body names the origin chat, value carries delivery + chat_name', () => {
    const json = buildGrantCard(
      { ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_g', name: '张三' }], chatId: 'oc_g', nonce: 'n2', mode: 'request', delivery: 'dm_group', chatName: '值班群' },
      'zh',
    );
    expect(json).toContain('值班群');
    expect(json).toContain('授权该群对话');
    expect(json).not.toContain('<at id=ou_owner>');
    const actions = byAction(json);
    expect(actions.grant_chat).toMatchObject({ chat_id: 'oc_g', delivery: 'dm_group', chat_name: '值班群' });
    expect(actions.grant_global).toBeUndefined();
  });

  it('in-chat request card is unchanged: no delivery / chat_name in callback value', () => {
    const json = buildGrantCard(
      { ownerOpenId: 'ou_owner', targets: [{ openId: 'ou_g', name: '张三' }], chatId: 'oc_1', nonce: 'n3', mode: 'request' },
      'zh',
    );
    const actions = byAction(json);
    expect(actions.grant_chat.delivery).toBeUndefined();
    expect(actions.grant_chat.chat_name).toBeUndefined();
    expect(json).toContain('授权本群对话');
  });

  it('result card in the approver DM names the scope instead of "this chat"', () => {
    const target = [{ openId: 'ou_g', name: '张三', isBot: false }];
    const p2p = buildGrantResultCard('chat', 'zh', 3, undefined, target, { delivery: 'dm_p2p' });
    expect(p2p).toContain('私聊');
    expect(p2p).not.toContain('在本群');
    const group = buildGrantResultCard('chat', 'zh', 3, undefined, target, { delivery: 'dm_group', chatName: '值班群' });
    expect(group).toContain('值班群');
    expect(group).not.toContain('在本群');
    // global 与原文案一致
    expect(buildGrantResultCard('global', 'zh', 3, undefined, target, { delivery: 'dm_p2p' })).toContain('全局授权');
  });

  it('requester notice: p2p has no @, group @s the human requester, deny carries no quota suffix', () => {
    const human = [{ openId: 'ou_g', name: '张三', isBot: false }];
    const grantedP2p = buildGrantRequesterNoticeCard('chat', 'dm_p2p', human, 'zh', 5);
    expect(grantedP2p).not.toContain('<at');
    expect(grantedP2p).toContain('5');
    const deniedP2p = buildGrantRequesterNoticeCard('deny', 'dm_p2p', human, 'zh', 5);
    expect(deniedP2p).toContain('未通过');
    expect(deniedP2p).not.toContain('5 条');
    const grantedGroup = buildGrantRequesterNoticeCard('chat', 'dm_group', human, 'zh');
    expect(grantedGroup).toContain('<at id=ou_g></at>');
    const deniedGroupBot = buildGrantRequesterNoticeCard('deny', 'dm_group', [{ openId: 'ou_bot', name: 'Codex', isBot: true }], 'zh');
    expect(deniedGroupBot).not.toContain('<at id=ou_bot');
    expect(deniedGroupBot).toContain('Codex');
  });

  it('en locale has every new key (no raw key leaks)', () => {
    const jsons = [
      buildGrantCard({ ownerOpenId: 'ou_o', targets: [{ openId: 'ou_g', name: 'A' }], chatId: 'oc', nonce: 'n', mode: 'request', delivery: 'dm_p2p' }, 'en'),
      buildGrantCard({ ownerOpenId: 'ou_o', targets: [{ openId: 'ou_g', name: 'A' }], chatId: 'oc', nonce: 'n', mode: 'request', delivery: 'dm_group', chatName: 'G' }, 'en'),
      buildGrantResultCard('chat', 'en', 1, undefined, [{ openId: 'ou_g', name: 'A' }], { delivery: 'dm_p2p' }),
      buildGrantResultCard('chat', 'en', 1, undefined, [{ openId: 'ou_g', name: 'A' }], { delivery: 'dm_group', chatName: 'G' }),
      buildGrantRequesterNoticeCard('chat', 'dm_p2p', [{ openId: 'ou_g' }], 'en'),
      buildGrantRequesterNoticeCard('deny', 'dm_p2p', [{ openId: 'ou_g' }], 'en'),
      buildGrantRequesterNoticeCard('deny', 'dm_group', [{ openId: 'ou_g' }], 'en'),
    ];
    for (const j of jsons) expect(j).not.toMatch(/card\.grant\./);
  });
});

describe('buildQuotaExhaustedCard — auto re-apply wording', () => {
  it('default keeps "ask the owner to /grant"; autoReapply says the next message re-applies automatically', () => {
    const legacy = buildQuotaExhaustedCard('ou_g', 3, 'zh');
    expect(legacy).toContain('/grant');
    const reapply = buildQuotaExhaustedCard('ou_g', 3, 'zh', true);
    expect(reapply).toContain('自动向 Bot 管理员申请');
    expect(reapply).not.toContain('/grant');
    expect(buildQuotaExhaustedCard('ou_g', 3, 'en', true)).not.toMatch(/quota\.exhausted/);
  });
});
