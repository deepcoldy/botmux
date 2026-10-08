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
  it('merges the terminal state into the existing reply footer without adding a second divider', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [
        { tag: 'markdown', content: 'answer' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          element_id: 'botmux_reply_footer',
          content: "<font color='grey'>[botmux](https://github.com/deepcoldy/botmux)</font>",
        },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!);
    expect(patched.body.elements[0]).toEqual({ tag: 'markdown', content: 'answer' });
    expect(patched.body.elements.filter((e: any) => e.tag === 'hr')).toHaveLength(1);
    expect(patched.body.elements).toHaveLength(3);
    expect(patched.body.elements.at(-1)).toMatchObject({
      element_id: 'botmux_reply_footer',
      content: "<font color='grey'>[botmux](https://github.com/deepcoldy/botmux) · ✓ 本轮已结束 · 等待输入</font>",
    });
  });

  it('updates a server-normalized footer idempotently', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{
        tag: 'markdown',
        element_id: 'botmux_reply_footer',
        content: '[botmux](https://github.com/deepcoldy/botmux)',
      }] },
    });
    const first = appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!;
    const second = JSON.parse(appendTurnTerminalReceiptToCard(first, 'silent', 'zh')!);
    expect(second.body.elements).toHaveLength(1);
    expect(second.body.elements[0].content).toBe(
      "[botmux](https://github.com/deepcoldy/botmux) · <font color='grey'>✓ 本轮已结束（AI 判断无需回复） · 等待输入</font>",
    );
  });

  it('finds a footer nested in the voice-control row', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{
        tag: 'column_set',
        columns: [{ tag: 'column', elements: [{
          tag: 'markdown', element_id: 'botmux_reply_footer', content: '发送给：<at id=ou_user></at>',
        }] }],
      }] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!);
    expect(patched.body.elements[0].columns[0].elements[0].content).toBe(
      "发送给：<at id=ou_user></at> · <font color='grey'>✓ 本轮已结束 · 等待输入</font>",
    );
    expect(patched.body.elements).toHaveLength(1);
  });

  it('migrates the old standalone terminal row into the existing footer', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [
        { tag: 'markdown', content: 'answer' },
        { tag: 'hr' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
        { tag: 'hr' },
        { tag: 'markdown', element_id: 'botmux_turn_terminal_receipt', content: 'old' },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!);
    expect(patched.body.elements.filter((e: any) => e.tag === 'hr')).toHaveLength(1);
    expect(patched.body.elements.some((e: any) => e.element_id === 'botmux_turn_terminal_receipt')).toBe(false);
    expect(patched.body.elements.at(-1).content).toContain('✓ 本轮已结束 · 等待输入');
  });

  it('uses one trailing line without adding a divider when a reply has no footer', () => {
    const input = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: 'answer' }] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')!);
    expect(patched.body.elements.filter((e: any) => e.tag === 'hr')).toHaveLength(0);
    expect(patched.body.elements.at(-1)).toMatchObject({
      element_id: 'botmux_turn_terminal_receipt',
      content: "<font color='grey'>✓ 本轮已结束 · 等待输入</font>",
    });
  });

  it.each(['not json', JSON.stringify({ schema: '1.0', elements: [] })])(
    'rejects an unpatchable payload',
    input => expect(appendTurnTerminalReceiptToCard(input, 'completed', 'zh')).toBeUndefined(),
  );
});
