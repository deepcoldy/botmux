import { describe, expect, it } from 'vitest';
import {
  appendTurnTerminalReceiptToCard,
  buildTurnTerminalReceiptCard,
} from '../src/im/lark/card-builder.js';

describe('buildTurnTerminalReceiptCard', () => {
  it.each([
    ['completed', '✓ 本轮已结束 · 等待输入'],
    ['silent', '✓ 本轮已结束（AI 判断无需回复） · 等待输入'],
  ] as const)('renders a compact %s card', (kind, expected) => {
    const card = JSON.parse(buildTurnTerminalReceiptCard(kind, 'zh'));
    expect(card).toMatchObject({
      schema: '2.0',
      config: { width_mode: 'default' },
      body: {
        padding: '8px 12px 8px 12px',
        elements: [{
          tag: 'markdown',
          text_size: 'notation_small_v2',
          content: `<font color='grey'>${expected}</font>`,
        }],
      },
    });
    expect(card.header).toBeUndefined();
  });
});

describe('appendTurnTerminalReceiptToCard', () => {
  it('adds the terminal line to a Card 2.0 reply without replacing its body', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: 'answer' }] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!);
    expect(patched.body.elements[0]).toEqual({ tag: 'markdown', content: 'answer' });
    expect(patched.body.elements.at(-1)).toMatchObject({
      tag: 'markdown',
      element_id: 'botmux_turn_terminal_receipt',
      content: "<font color='grey'>✓ 本轮已结束 · 等待输入</font>",
    });
  });

  it('updates an existing terminal line idempotently', () => {
    const first = appendTurnTerminalReceiptToCard(JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [] },
    }), 'completed', 'zh')!;
    const second = JSON.parse(appendTurnTerminalReceiptToCard(first, 'silent', 'zh')!);
    expect(second.body.elements.filter((e: any) => e.element_id === 'botmux_turn_terminal_receipt')).toHaveLength(1);
    expect(second.body.elements.at(-1).content)
      .toContain('✓ 本轮已结束（AI 判断无需回复） · 等待输入');
  });

  it.each(['not json', JSON.stringify({ schema: '1.0', elements: [] })])(
    'rejects an unpatchable payload',
    input => expect(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')).toBeUndefined(),
  );
});
