import { describe, expect, it } from 'vitest';
import {
  buildTurnTerminalFooterPatch,
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

describe('buildTurnTerminalFooterPatch', () => {
  it('returns only footer content even when the provider readback has normalized the body', () => {
    const body = '- item**Next heading**\n- another item';
    const card = { schema: '2.0', body: { elements: [
      { tag: 'markdown', content: body },
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{
        tag: 'markdown', element_id: 'botmux_reply_footer', content: 'brand · 发送给：<at id=ou_user></at>',
      }] }] },
      { tag: 'button', value: { action: 'feedback' } },
    ] } };
    const input = JSON.stringify(card);
    const patch = buildTurnTerminalFooterPatch(input, 'completed', 'zh');
    expect(patch).toEqual({ content: "brand · 发送给：<at id=ou_user></at> · <font color='grey'>✓ 本轮已结束 · 等待输入</font>" });
    expect(JSON.stringify(card)).toBe(input);
    expect(JSON.stringify(patch)).not.toContain(body);
    expect(buildTurnTerminalFooterPatch(JSON.stringify({ schema: '2.0', body: { elements: [{
      tag: 'markdown', element_id: 'botmux_reply_footer', ...patch,
    }] } }), 'completed', 'zh')).toEqual(patch);
  });

  it.each(['not json', '{}', JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    JSON.stringify({ schema: '2.0', body: { elements: [{ element_id: 'botmux_reply_footer', content: '' }] } }),
  ])('declines a missing or invalid footer: %s', input => {
    expect(buildTurnTerminalFooterPatch(input, 'completed', 'zh')).toBeUndefined();
  });
});
