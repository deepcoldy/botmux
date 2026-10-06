import { describe, expect, it } from 'vitest';
import { buildTurnTerminalReceiptCard } from '../src/im/lark/card-builder.js';

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
