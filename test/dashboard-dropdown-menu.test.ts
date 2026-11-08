import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDropdownMenu, DropdownMenu } from '../src/dashboard/web/dashboard-components.js';
import {
  commitDropdownChoice,
  dropdownRootClassName,
  filterDropdownOptions,
  swallowClosedTypeahead,
  type DropdownMenuProps,
} from '../src/dashboard/web/dropdown-shared.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function style(): string {
  return readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
}

function menuProps(over: Partial<DropdownMenuProps<string>> = {}): DropdownMenuProps<string> {
  return {
    label: 'Alpha',
    value: 'a',
    options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
    onChange: vi.fn(),
    ...over,
  };
}

describe('DropdownMenu choice', () => {
  it('drops a re-pick of the current value, so auto-saving menus do not write twice', () => {
    const props = menuProps();
    commitDropdownChoice(props, 'a');
    expect(props.onChange).not.toHaveBeenCalled();
    commitDropdownChoice(props, 'b');
    expect(props.onChange).toHaveBeenCalledWith('b');
  });

  it('reports a re-pick when the menu asks for it (manual-save selectors)', () => {
    const props = menuProps({ notifyOnReselect: true });
    commitDropdownChoice(props, 'a');
    expect(props.onChange).toHaveBeenCalledWith('a');
  });

  it('filters on the value and on plain-text labels', () => {
    const options = [
      { value: 'claude-code', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
      { value: 'gemini', label: React.createElement('b', null, 'Gemini') },
    ];
    expect(filterDropdownOptions(options, '  CLAUDE ').map(option => option.value)).toEqual(['claude-code']);
    expect(filterDropdownOptions(options, '-code').map(option => option.value)).toEqual(['claude-code']);
    // A JSX label cannot be searched; only its value can.
    expect(filterDropdownOptions(options, 'Gem').map(option => option.value)).toEqual(['gemini']);
    expect(filterDropdownOptions(options, 'Gemini!')).toEqual([]);
    expect(filterDropdownOptions(options, ' ')).toBe(options);
  });
});

describe('closed trigger typeahead', () => {
  function key(init: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>>) {
    return { key: '', ctrlKey: false, metaKey: false, altKey: false, stopPropagation: vi.fn(), ...init };
  }

  it('swallows printable keys while closed', () => {
    for (const k of ['a', 'Z', '7', '/']) {
      const event = key({ key: k });
      swallowClosedTypeahead(event as never, false);
      expect(event.stopPropagation, k).toHaveBeenCalled();
    }
  });

  it('lets opening keys, shortcuts and the open popup through', () => {
    const passes = [
      [key({ key: ' ' }), false],
      [key({ key: 'Enter' }), false],
      [key({ key: 'ArrowDown' }), false],
      [key({ key: 'a', metaKey: true }), false],
      [key({ key: 'a', ctrlKey: true }), false],
      [key({ key: 'a' }), true],
    ] as const;
    for (const [event, open] of passes) {
      swallowClosedTypeahead(event as never, open);
      expect(event.stopPropagation, `${event.key} open=${open}`).not.toHaveBeenCalled();
    }
  });
});

describe('DropdownMenu shell', () => {
  it('keeps the page-facing root classes the CSS hooks onto', () => {
    expect(dropdownRootClassName(menuProps({ className: 'bd-field-menu' }), false)).toBe('sect-sort-menu bd-field-menu');
    expect(dropdownRootClassName(menuProps({ disabled: true }), true)).toBe('sect-sort-menu is-disabled is-open');
  });

  it('renders the same closed trigger before and after the Base UI chunk arrives', async () => {
    await import('../src/dashboard/web/dropdown-select.js');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DropdownMenu<string>, menuProps({
        id: 'tz', className: 'settings-field-menu', ariaLabel: 'Time zone', disabled: true,
      })));
    });
    const root = renderer.root.find(node => typeof node.type === 'string' && node.props.id === 'tz');
    expect(root.props.className).toBe('sect-sort-menu is-disabled settings-field-menu');
    const trigger = renderer.root.find(node => node.props.className === 'sect-sort-trigger' && typeof node.type === 'string');
    expect(trigger.props.role).toBe('combobox');
    expect(trigger.props['aria-label']).toBe('Time zone');
    expect(trigger.findByProps({ className: 'sect-sort-value' }).children).toEqual(['Alpha']);
    act(() => renderer.unmount());
  });

  it('keeps the page and an inert trigger when an implementation chunk fails to load', async () => {
    // An open tab outlives a dashboard upgrade that deletes the old hashed chunk.
    const combobox = await import('../src/dashboard/web/dropdown-combobox.js');
    const Menu = createDropdownMenu({
      select: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/chunks/dropdown-select-OLD.js')),
      combobox: () => Promise.resolve(combobox),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement('section', null,
          React.createElement('h1', null, 'Settings'),
          React.createElement(Menu<string>, menuProps({ id: 'tz', ariaLabel: 'Time zone' })),
          React.createElement(Menu<string>, menuProps({ id: 'cli', ariaLabel: 'CLI', searchable: true }))));
      });
      const trigger = (label: string) => renderer.root.find(node => typeof node.type === 'string'
        && node.props.className === 'sect-sort-trigger' && node.props['aria-label'] === label);

      expect(renderer.root.findByType('h1').children).toEqual(['Settings']);
      expect(trigger('Time zone').findByProps({ className: 'sect-sort-value' }).children).toEqual(['Alpha']);
      expect(trigger('Time zone').props.tabIndex).toBeUndefined();
      expect(trigger('CLI').props.tabIndex).toBe(0);
      expect(logged).toHaveBeenCalledWith('botmux dropdown failed to load', expect.any(TypeError));
      act(() => renderer.unmount());
    } finally {
      logged.mockRestore();
    }
  });
});

// 源码结构护栏(K4)：弹层 portal 到 body / 打开中的 dialog，经页面祖先命中弹层的选择器会静默失效，
// 限高不带 --available-height 就会超出可视区；RTR 没有 CSS 匹配，只能扫样式表守这两条不变量。
describe('dropdown CSS after the popup moved to a portal', () => {
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
  /** Style rules (selector list + body) that mention the popup, comments stripped. */
  const popupRules = () => [...style().replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map(match => ({ selectors: splitSelectors(match[1]), body: match[2] }))
    .filter(rule => rule.selectors.some(selector => selector.includes('.sect-sort-pop')));

  it('styles popups by their own attributes, never through page ancestors', () => {
    // The popup now lives under <body> (or the open <dialog>): a rule like
    // `.bd-field-menu .sect-sort-pop` silently stops matching.
    const selectors = popupRules().flatMap(rule => rule.selectors);
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector, selector).toMatch(/^\.sect-sort-pop\b/);
  });

  it('caps every popup height by the room Base UI measured', () => {
    const onPopup = /^\.sect-sort-pop(\[[^\]]*\]|:is\([^)]*\))*$/;
    const caps = popupRules()
      .filter(rule => rule.selectors.every(selector => onPopup.test(selector)))
      .flatMap(rule => [...rule.body.matchAll(/max-height:([^;]+)/g)].map(cap => ({ rule: rule.selectors.join(', '), cap: cap[1] })));
    expect(caps.length).toBeGreaterThan(2);
    for (const { rule, cap } of caps) expect(cap, rule).toContain('var(--available-height');
  });
});
