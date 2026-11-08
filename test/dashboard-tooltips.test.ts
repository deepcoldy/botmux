import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FieldTitle, IconTip, InfoTip, lazyWithFallback, OverflowText } from '../src/dashboard/web/dashboard-components.js';
import { FeedGroupPicker, feedGroupPickerLabel } from '../src/dashboard/web/feed-group-picker.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const create = (element: React.ReactElement) => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer;
};
const hostNodes = (renderer: TestRenderer.ReactTestRenderer, className: string) => renderer.root.findAll(node =>
  typeof node.type === 'string' && String(node.props.className ?? '').split(' ').includes(className));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lazyWithFallback', () => {
  const Fallback = (props: { name: string }) => h('b', null, `fallback ${props.name}`);
  const Impl = (props: { name: string }) => h('i', null, `impl ${props.name}`);

  async function render(element: React.ReactElement) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(element); });
    return renderer;
  }

  it('swaps in the implementation once its chunk arrives', async () => {
    vi.stubGlobal('Element', class {});
    const Lazy = lazyWithFallback(() => Promise.resolve({ default: Impl }), Fallback, 'probe', { browserOnly: true });
    expect((await render(h(Lazy, { name: 'x' }))).toJSON()).toEqual(expect.objectContaining({ type: 'i', children: ['impl x'] }));
  });

  it('keeps the fallback and skips the chunk when there is no DOM for browser-only parts', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Impl }));
    const Lazy = lazyWithFallback(load, Fallback, 'probe', { browserOnly: true });
    expect((await render(h(Lazy, { name: 'x' }))).toJSON()).toEqual(expect.objectContaining({ type: 'b', children: ['fallback x'] }));
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the page and the fallback when the chunk fails to load', async () => {
    vi.stubGlobal('Element', class {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/chunks/info-tip-popover-OLD.js');
    const Lazy = lazyWithFallback<{ name: string }>(() => Promise.reject(failure), Fallback, 'probe', { browserOnly: true });
    const renderer = await render(h('section', null, h('h1', null, 'Settings'), h(Lazy, { name: 'x' })));
    expect(renderer.root.findByType('h1').children).toEqual(['Settings']);
    expect(renderer.root.findByType('b').children).toEqual(['fallback x']);
    expect(logged).toHaveBeenCalledWith('botmux probe failed to load', failure);
  });
});

// 下面都在没有 DOM 的 react-test-renderer 里跑：只会渲染占位，它要和 Base UI 实现长得一样，
// 且在 chunk 到位前不能改变页面行为。
describe('InfoTip before its popover loads', () => {
  it('renders the mark with the page-facing classes and label, inert and closed', () => {
    const renderer = create(h(InfoTip, { label: 'Help', className: 'bd-info-tip', children: 'Body text' }));
    const [tip] = hostNodes(renderer, 'ui-info-tip');
    expect(tip.props.className).toBe('ui-info-tip bd-info-tip');
    expect(tip.props['aria-label']).toBe('Help');
    expect(tip.props.tabIndex).toBeUndefined();
    expect(tip.findByProps({ className: 'ui-info-mark' }).children).toEqual(['?']);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Body text');
  });

  it('stops a click from toggling the control of a surrounding label unless told not to', () => {
    const preventDefault = vi.fn();
    const tip = hostNodes(create(h(InfoTip, { children: 'x' })), 'ui-info-tip')[0];
    tip.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    const passThrough = hostNodes(create(h(InfoTip, {
      children: 'x', preventClick: false, trigger: h('span', { className: 'nav-update-dot' }),
    })), 'ui-info-tip')[0];
    expect(passThrough.props.onClick).toBeUndefined();
    expect(passThrough.findByProps({ className: 'nav-update-dot' })).toBeTruthy();
  });
});

// 上了 Base UI 后 `?` 是 role=button，没名字的按钮读屏只会念「按钮」。
describe('the accessible name of the InfoTip mark', () => {
  const markLabel = (element: React.ReactElement) => hostNodes(create(element), 'ui-info-tip')[0].props['aria-label'];

  it('falls back to plain-text help when no label is given', () => {
    expect(markLabel(h(InfoTip, { label: 'Help', children: 'Body text' }))).toBe('Help');
    expect(markLabel(h(InfoTip, { children: 'Body text' }))).toBe('Body text');
    expect(markLabel(h(InfoTip, { children: h('b', null, 'Rich') }))).toBeUndefined();
  });

  it('in FieldTitle is the helpLabel, else the plain-text title, else the help', () => {
    expect(markLabel(h(FieldTitle, { help: 'Explains it', helpLabel: 'About the toggle', children: 'Toggle' }))).toBe('About the toggle');
    expect(markLabel(h(FieldTitle, { help: 'Explains it', children: 'Toggle' }))).toBe('Toggle');
    expect(markLabel(h(FieldTitle, { help: 'Explains it', children: ['Toggle', h('span', { key: 'o' }, 'optional')] }))).toBe('Explains it');
  });
});

describe('OverflowText before its tooltip loads', () => {
  it('renders the measured box and the scrolling text the CSS hooks onto', () => {
    const renderer = create(h(OverflowText, {
      text: 'Long title', className: 'wb-title', textClassName: 'wb-title-scroll', durationMs: 2600,
    }));
    const [box] = hostNodes(renderer, 'ui-overflow-text');
    expect(box.props.className).toBe('ui-overflow-text wb-title');
    expect(box.props.style).toEqual({ '--ui-overflow-duration': '2600ms' });
    expect(box.findByProps({ className: 'ui-overflow-scroll wb-title-scroll' }).children).toEqual(['Long title']);
  });
});

describe('IconTip before its tooltip loads', () => {
  it('leaves the icon control exactly as given', () => {
    const onClick = vi.fn();
    const renderer = create(h(IconTip, {
      label: 'Close',
      children: h('button', { id: 'drawer-close', type: 'button', 'aria-label': 'Close', onClick }),
    }));
    const button = renderer.root.findByType('button');
    expect(button.props).toEqual({ id: 'drawer-close', type: 'button', 'aria-label': 'Close', onClick });
  });
});

describe('FeedGroupPicker', () => {
  const groups = [{ groupId: 'g1', name: 'Alpha' }, { groupId: 'g2', name: 'Beta' }];
  const props = (over: Partial<Parameters<typeof feedGroupPickerLabel>[0]> = {}) => ({
    groups, selectedId: '', newName: '', onChange: vi.fn(), ...over,
  });

  it('labels the closed picker with the label being created, else the chosen one, else none', () => {
    expect(feedGroupPickerLabel(props())).toBe('不选择标签');
    expect(feedGroupPickerLabel(props({ selectedId: 'g2' }))).toBe('Beta');
    expect(feedGroupPickerLabel(props({ selectedId: 'gone' }))).toBe('不选择标签');
    expect(feedGroupPickerLabel(props({ selectedId: 'g2', newName: '  Gamma ' }))).toBe('新建标签：Gamma');
    expect(feedGroupPickerLabel(props({ newName: '   ' }))).toBe('不选择标签');
  });

  it('shows the same closed trigger before the popover loads', () => {
    const renderer = create(h(FeedGroupPicker, props({ selectedId: 'g1', disabled: true })));
    const [root] = hostNodes(renderer, 'feed-group-picker');
    expect(root.props.className).toBe('feed-group-picker is-disabled');
    const [trigger] = hostNodes(renderer, 'feed-group-picker-trigger');
    expect(trigger.props['aria-label']).toBe('飞书标签，当前：Alpha');
    expect(trigger.props['aria-disabled']).toBe(true);
    expect(trigger.findByType('span').children).toEqual(['Alpha']);
  });
});

// 源码结构护栏(K4)：这些浮层 portal 到 body / 打开中的 dialog，经页面祖先命中浮层的选择器会静默失效，
// 限高不带 --available-height 就会超出可视区；RTR 没有 CSS 匹配，只能扫样式表守这两条不变量。
describe('tip and picker CSS after the popups moved to a portal', () => {
  const POPUPS = ['.ui-info-pop', '.ui-overflow-popover', '.icon-tip', '.feed-group-picker-pop'];
  const style = () => readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
  /** Top-level commas only: `:is(a, b)` stays one selector. */
  const splitSelectors = (list: string) => {
    const out = [''];
    let depth = 0;
    for (const ch of list) {
      depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      if (ch === ',' && depth === 0) out.push('');
      else out[out.length - 1] += ch;
    }
    return out.map(selector => selector.trim());
  };
  const rules = () => [...style().replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map(match => ({ selectors: splitSelectors(match[1]), body: match[2] }));
  const mentions = (selector: string, popup: string) => new RegExp(`${popup.replace('.', '\\.')}(?![\\w-])`).test(selector);

  it('styles popups by their own classes and attributes, never through page ancestors', () => {
    for (const popup of POPUPS) {
      const selectors = rules().flatMap(rule => rule.selectors).filter(selector => mentions(selector, popup));
      expect(selectors.length, popup).toBeGreaterThan(0);
      for (const selector of selectors) expect(selector, selector).toMatch(/^\.(ui-info-pop|ui-overflow-popover|icon-tip|feed-group-picker-pop)\b/);
    }
  });

  it('caps the label picker by the room Base UI measured', () => {
    const caps = rules()
      .filter(rule => rule.selectors.includes('.feed-group-picker-pop'))
      .flatMap(rule => [...rule.body.matchAll(/max-height:([^;]+)/g)].map(cap => cap[1]));
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(cap).toContain('var(--available-height');
  });
});
