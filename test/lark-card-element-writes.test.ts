/**
 * Element-level CardKit writes used by the reply card's「下一步」row, at the
 * real Lark SDK boundary: request shape, and that callback buttons are stamped
 * like every whole-card write (the parser drops stamped buttons when another
 * bot reads the card).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor(public opts: Record<string, unknown>) {} },
}));

import { getBot, registerBot } from '../src/bot-registry.js';
import { deleteCardElement, insertCardElements, replaceCardElement } from '../src/im/lark/client.js';
import { hasBotmuxCallbackMarker } from '../src/im/lark/callback-button-marker.js';
import { buildNextStepElement } from '../src/im/lark/next-step-card.js';

function capture() {
  const app = 'card-element-writes';
  registerBot({ larkAppId: app, larkAppSecret: 's', cliId: 'claude-code' });
  const calls: Array<{ op: string; args: any }> = [];
  const record = (op: string) => async (args: any) => { calls.push({ op, args }); return { code: 0, data: {} }; };
  getBot(app).client = {
    cardkit: { v1: { cardElement: { create: record('create'), update: record('update'), delete: record('delete') } } },
  } as any;
  return { app, calls };
}

const element = buildNextStepElement({ text: 'CI 绿了就合', payload: 'p', sig: 's' });
const button = (node: any) => node.columns[1].elements[0];

describe('CardKit element writes', () => {
  it('inserts before a target element with a stamped callback button', async () => {
    const { app, calls } = capture();
    await insertCardElements(app, 'card_1', { type: 'insert_before', targetElementId: 'botmux_reply_actions' }, [element], 27_000_001, 'nxs_1');
    expect(calls).toHaveLength(1);
    const { path, data } = calls[0].args;
    expect(path).toEqual({ card_id: 'card_1' });
    expect(data).toMatchObject({ type: 'insert_before', target_element_id: 'botmux_reply_actions', sequence: 27_000_001, uuid: 'nxs_1' });
    const [sent] = JSON.parse(data.elements);
    expect(sent.element_id).toBe('botmux_next_step');
    expect(hasBotmuxCallbackMarker(button(sent))).toBe(true);
    // The caller's element is not mutated.
    expect(hasBotmuxCallbackMarker(button(element))).toBe(false);
  });

  it('appends without a target', async () => {
    const { app, calls } = capture();
    await insertCardElements(app, 'card_1', { type: 'append' }, [element], 2, 'nxs_2');
    expect(calls[0].args.data.type).toBe('append');
    expect(calls[0].args.data).not.toHaveProperty('target_element_id');
  });

  it('replaces and deletes by element id', async () => {
    const { app, calls } = capture();
    await replaceCardElement(app, 'card_1', 'botmux_next_step', element, 3, 'nxs_3');
    await deleteCardElement(app, 'card_1', 'botmux_next_step', 4, 'nxs_4');
    expect(calls.map(call => [call.op, call.args.path])).toEqual([
      ['update', { card_id: 'card_1', element_id: 'botmux_next_step' }],
      ['delete', { card_id: 'card_1', element_id: 'botmux_next_step' }],
    ]);
    expect(hasBotmuxCallbackMarker(button(JSON.parse(calls[0].args.data.element)))).toBe(true);
    expect(calls[1].args.data).toEqual({ sequence: 4, uuid: 'nxs_4' });
  });

  it('surfaces a provider rejection', async () => {
    const { app } = capture();
    getBot(app).client = { cardkit: { v1: { cardElement: {
      create: async () => ({ code: 300317, msg: 'sequence number compare failed' }),
    } } } } as any;
    await expect(insertCardElements(app, 'card_1', { type: 'append' }, [element], 2, 'nxs_5')).rejects.toThrow(/300317|sequence/);
  });
});
