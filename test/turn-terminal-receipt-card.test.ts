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

  it('uses readback for mutable controls while restoring authored markdown from the sent card', () => {
    const readback = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [
        { tag: 'markdown', content: '配置 `example.json`:```diff\n+ok\n```\n**outside swallowed**' },
        {
          tag: 'column_set',
          element_id: 'botmux_feedback',
          columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: 'feedback already clicked' }] }],
        },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const sent = JSON.stringify({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: { direction: 'vertical', elements: [
        { tag: 'markdown', content: '配置 `example.json`:\n```diff\n+ok\n```\n\n**outside**' },
        {
          tag: 'column_set',
          element_id: 'botmux_feedback',
          columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: 'old feedback' }] }],
        },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(readback, 'completed', 'zh', sent)!);
    expect(patched.body.elements[0].content).toBe('配置 `example.json`:\n```diff\n+ok\n```\n\n**outside**');
    expect(patched.body.elements[1].columns[0].elements[0].content).toBe('feedback already clicked');
    expect(patched.body.elements[2].content).toBe(
      "[botmux](url) · <font color='grey'>✓ 本轮已结束 · 等待输入</font>",
    );
  });

  it('does not restore daemon-owned runtime chrome markdown', () => {
    const readback = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成 · 2.0s**' },
        { tag: 'markdown', content: '配置 `example.json`:```diff\n+ok\n```\n**outside swallowed**' },
        { tag: 'markdown', element_id: 'botmux_feedback_status', content: '已选择：**有用**' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const sent = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中 · 0.4s**' },
        { tag: 'markdown', content: '配置 `example.json`:\n```diff\n+ok\n```\n\n**outside**' },
        { tag: 'markdown', element_id: 'botmux_feedback_status', content: '请选择反馈' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(readback, 'completed', 'zh', sent)!);
    expect(patched.body.elements[0].content).toBe('✅ **已完成 · 2.0s**');
    expect(patched.body.elements[1].content).toBe('配置 `example.json`:\n```diff\n+ok\n```\n\n**outside**');
    expect(patched.body.elements[2].content).toBe('已选择：**有用**');
  });

  it('keeps readback unchanged when authored markdown structure drifts', () => {
    const readback = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成**' },
        { tag: 'markdown', content: 'final answer from readback' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const sent = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中**' },
        { tag: 'markdown', content: 'old tool narration' },
        { tag: 'markdown', content: 'final answer from sent card' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(readback, 'completed', 'zh', sent)!);
    expect(patched.body.elements[1].content).toBe('final answer from readback');
    expect(JSON.stringify(patched)).not.toContain('old tool narration');
  });

  it('keeps readback unchanged when authored markdown paths drift with the same count', () => {
    const readback = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成**' },
        { tag: 'markdown', content: 'final answer from readback' },
        { tag: 'markdown', content: 'tail note from readback' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const sent = JSON.stringify({
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中**' },
        { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: 'old nested tool text' }] }] },
        { tag: 'markdown', content: 'final answer from sent card' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: '[botmux](url)' },
      ] },
    });
    const patched = JSON.parse(appendTurnTerminalReceiptToCard(readback, 'completed', 'zh', sent)!);
    expect(patched.body.elements[1].content).toBe('final answer from readback');
    expect(patched.body.elements[2].content).toBe('tail note from readback');
    expect(JSON.stringify(patched)).not.toContain('old nested tool text');
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
