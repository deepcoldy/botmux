/**
 * card-primitives 的键序契约。JSON.stringify 的结果就是线上卡片，而历史调用点的键序并不
 * 统一（header 有 title→template 与 template→title 两种），helper 必须各自保持——
 * 这里直接钉每个 helper 的序列化字符串；整张卡片的逐字节回归见 card-builder-wire-golden.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  callbackButton, cardHeader, cardHeaderTemplateFirst, larkMdDiv, plainText, simpleCard, urlButton, wideCard,
} from '../src/im/lark/card-primitives.js';

const J = JSON.stringify;

describe('card-primitives 键序', () => {
  it('plainText / larkMdDiv', () => {
    expect(J(plainText('x'))).toBe('{"tag":"plain_text","content":"x"}');
    expect(J(larkMdDiv('**x**'))).toBe('{"tag":"div","text":{"tag":"lark_md","content":"**x**"}}');
  });

  it('两种 header 键序互不混用', () => {
    expect(J(cardHeader('T', 'blue'))).toBe('{"title":{"tag":"plain_text","content":"T"},"template":"blue"}');
    expect(J(cardHeaderTemplateFirst('blue', 'T'))).toBe('{"template":"blue","title":{"tag":"plain_text","content":"T"}}');
  });

  it('按钮：tag → text → type → value / multi_url', () => {
    expect(J(callbackButton('B', 'primary', { action: 'a' })))
      .toBe('{"tag":"button","text":{"tag":"plain_text","content":"B"},"type":"primary","value":{"action":"a"}}');
    expect(J(urlButton('U', 'default', { url: 'https://x' })))
      .toBe('{"tag":"button","text":{"tag":"plain_text","content":"U"},"type":"default","multi_url":{"url":"https://x"}}');
  });

  it('wideCard：config → header → elements；无 header 时不带该键；extraConfig 排在 wide_screen_mode 之后', () => {
    expect(J(wideCard({ header: cardHeader('T', 'red'), elements: [] })))
      .toBe('{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"T"},"template":"red"},"elements":[]}');
    expect(J(wideCard({ elements: [larkMdDiv('a')] })))
      .toBe('{"config":{"wide_screen_mode":true},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"a"}}]}');
    expect(J(wideCard({ elements: [], extraConfig: { update_multi: true } })))
      .toBe('{"config":{"wide_screen_mode":true,"update_multi":true},"elements":[]}');
  });

  it('simpleCard：markdown → div → action；buttons 为空不产出 action', () => {
    const btn = callbackButton('B', 'danger', { action: 'close' });
    expect(J(simpleCard({ title: 'T', template: 'grey', markdown: 'm', buttons: [btn] }))).toBe(J({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'T' }, template: 'grey' },
      elements: [{ tag: 'markdown', content: 'm' }, { tag: 'action', actions: [btn] }],
    }));
    expect(J(simpleCard({ title: 'T', template: 'blue', div: 'd', buttons: [] }))).toBe(J({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'T' }, template: 'blue' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'd' } }],
    }));
  });
});
