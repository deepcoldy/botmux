import { describe, it, expect } from 'vitest';
import { buildGrantCard, buildGrantResultCard, buildGrantNotifyCard } from '../src/im/lark/card-builder.js';

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
    const actions = card.elements.find((e: any) => e.tag === 'action').actions;
    const byAction = Object.fromEntries(actions.map((a: any) => [a.value.action, a.value]));
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
    const actions = card.elements.find((e: any) => e.tag === 'action').actions;
    expect(actions).toHaveLength(3);
    const byAction = Object.fromEntries(actions.map((a: any) => [a.value.action, a.value]));
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
    const actions = card.elements.find((e: any) => e.tag === 'action').actions;
    const byAction = Object.fromEntries(actions.map((a: any) => [a.value.action, a.value]));
    // one click → all three targets, shared nonce
    expect(byAction.grant_chat).toMatchObject({ target_open_ids: ['ou_a', 'ou_b', 'ou_bot'], chat_id: 'oc_3', nonce: 'n3' });
    expect(byAction.grant_global).toMatchObject({ target_open_ids: ['ou_a', 'ou_b', 'ou_bot'], chat_id: 'oc_3', nonce: 'n3' });
  });

  it('buildGrantNotifyCard @-mentions every granted target', () => {
    const card = JSON.parse(buildGrantNotifyCard('chat', ['ou_a', 'ou_b'], 'zh'));
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_a></at>');
    expect(flat).toContain('<at id=ou_b></at>');
  });

  it('buildGrantResultCard has no buttons', () => {
    const card = JSON.parse(buildGrantResultCard('chat', 'zh'));
    expect(card.elements.some((e: any) => e.tag === 'action')).toBe(false);
  });
});
