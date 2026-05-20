import { describe, it, expect } from 'vitest';
import { buildGrantCard, buildGrantResultCard } from '../src/im/lark/card-builder.js';

describe('buildGrantCard', () => {
  it('embeds @owner, requester name, and nonce-bearing actions', () => {
    const json = buildGrantCard(
      { ownerOpenId: 'ou_owner', requesterOpenId: 'ou_g', requesterName: '张三', chatId: 'oc_1', nonce: 'n1', mode: 'request' },
      'zh',
    );
    const card = JSON.parse(json);
    const flat = JSON.stringify(card);
    expect(flat).toContain('<at id=ou_owner></at>');
    expect(flat).toContain('张三');
    const actions = card.elements.find((e: any) => e.tag === 'action').actions;
    const byAction = Object.fromEntries(actions.map((a: any) => [a.value.action, a.value]));
    expect(byAction.grant_chat).toMatchObject({ target_open_id: 'ou_g', chat_id: 'oc_1', nonce: 'n1' });
    expect(byAction.grant_global).toMatchObject({ target_open_id: 'ou_g', chat_id: 'oc_1', nonce: 'n1' });
    expect(byAction.grant_deny).toMatchObject({ target_open_id: 'ou_g', chat_id: 'oc_1', nonce: 'n1' });
  });

  it('owner mode renders without crashing and still carries actions', () => {
    const card = JSON.parse(buildGrantCard(
      { ownerOpenId: 'ou_o', requesterOpenId: 'ou_g', requesterName: 'Bob', chatId: 'oc_2', nonce: 'n2', mode: 'owner' }, 'en',
    ));
    expect(card.elements.find((e: any) => e.tag === 'action').actions).toHaveLength(3);
  });

  it('buildGrantResultCard has no buttons', () => {
    const card = JSON.parse(buildGrantResultCard('chat', 'zh'));
    expect(card.elements.some((e: any) => e.tag === 'action')).toBe(false);
  });
});
