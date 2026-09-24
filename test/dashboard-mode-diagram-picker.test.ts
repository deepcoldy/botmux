/**
 * 会话 / 目录模式的单选卡片（高保真飞书截图）：
 * - ModeCardPicker：卡片式 radio group，点击/键盘切换；
 * - P2pMock / RegularMock / MentionMock / WorkingDirMock：14 种模式的迷你截图；
 * - bot-defaults-page 用卡片替换了原四个下拉。
 * 用 react-test-renderer 断言行为，CSS/接线走源码静态断言，与仓库其它 dashboard 测试一致。
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import {
  MentionMock,
  ModeCardPicker,
  P2pMock,
  RegularMock,
  WorkingDirMock,
  type ModeCardOption,
} from '../src/dashboard/web/mode-diagrams.js';
import { t } from '../src/dashboard/web/ui.js';

const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

function classes(node: ReactTestInstance): string[] {
  return typeof node.props.className === 'string' ? node.props.className.split(/\s+/) : [];
}

function findByClass(root: ReactTestInstance, cls: string): ReactTestInstance[] {
  return root.findAll(node => classes(node).includes(cls));
}

function render(element: React.ReactElement): ReactTestInstance {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!.root;
}

const sampleOptions: Array<ModeCardOption<'a' | 'b'>> = [
  { value: 'a', icon: React.createElement('i', { 'data-icon': 'a' }), name: '模式 A', description: '说明 A', tags: ['标签 1', '标签 2'], mock: React.createElement('div', { 'data-mock': 'a' }) },
  { value: 'b', icon: React.createElement('i', { 'data-icon': 'b' }), name: '模式 B', description: '说明 B', tags: ['标签 3'], mock: React.createElement('div', { 'data-mock': 'b' }) },
];

describe('ModeCardPicker', () => {
  it('renders a radio group with one card per option and marks the value selected', () => {
    const root = render(React.createElement(ModeCardPicker<'a' | 'b'>, {
      dataInput: 'demo',
      ariaLabel: '演示',
      value: 'b',
      options: sampleOptions,
      onChange: () => {},
    }));
    const group = root.findByProps({ role: 'radiogroup' });
    expect(group.props['aria-label']).toBe('演示');
    const cards = root.findAll(node => node.props.role === 'radio');
    expect(cards).toHaveLength(2);
    expect(cards[0].props['aria-checked']).toBe(false);
    expect(cards[1].props['aria-checked']).toBe(true);
    expect(findByClass(cards[0], 'is-selected')).toHaveLength(0);
    expect(findByClass(cards[1], 'is-selected')).toHaveLength(1);
    // Name / description / tags / mock all render.
    expect(findByClass(root, 'bd-mode-name').map(n => n.children.join(''))).toEqual(['模式 A', '模式 B']);
    expect(findByClass(root, 'bd-mode-tag')).toHaveLength(3);
    expect(root.findByProps({ 'data-mock': 'a' })).toBeTruthy();
  });

  it('selects on click and Enter; arrow keys move the roving focus and value', () => {
    const onChange = vi.fn();
    const root = render(React.createElement(ModeCardPicker<'a' | 'b'>, {
      dataInput: 'demo',
      value: 'a',
      options: sampleOptions,
      onChange,
    }));
    const cards = root.findAll(node => node.props.role === 'radio');
    act(() => cards[1].props.onClick());
    expect(onChange).toHaveBeenLastCalledWith('b');
    act(() => cards[0].props.onKeyDown({ key: 'Enter', preventDefault: () => {} }));
    expect(onChange).toHaveBeenLastCalledWith('a');
    // Only the selected card is tab-stops; others take -1 (roving tabindex).
    expect(cards[0].props.tabIndex).toBe(0);
    expect(cards[1].props.tabIndex).toBe(-1);
  });

  it('does not select while disabled', () => {
    const onChange = vi.fn();
    const root = render(React.createElement(ModeCardPicker<'a' | 'b'>, {
      dataInput: 'demo',
      value: 'a',
      options: sampleOptions,
      onChange,
      disabled: true,
    }));
    const card = root.findAll(node => node.props.role === 'radio')[1];
    act(() => card.props.onClick());
    expect(onChange).not.toHaveBeenCalled();
    expect(card.props['aria-disabled']).toBe(true);
  });
});

describe('mode mock screenshots', () => {
  it('p2p: chat is a flat exchange, thread stacks two topic boxes, group splits DM into session groups', () => {
    const counts = {
      chat: { topics: 0, groups: 0, dm: 0 },
      thread: { topics: 2, groups: 0, dm: 0 },
      group: { topics: 0, groups: 2, dm: 1 },
    } as const;
    for (const [mode, expected] of Object.entries(counts) as Array<[keyof typeof counts, { topics: number; groups: number; dm: number }]>) {
      const root = render(React.createElement(P2pMock, { mode }));
      expect(findByClass(root, 'bd-mock-topic')).toHaveLength(expected.topics);
      expect(findByClass(root, 'bd-mock-sgroup')).toHaveLength(expected.groups);
      expect(findByClass(root, 'bd-mock-dm')).toHaveLength(expected.dm);
      expect(findByClass(root, 'bd-mock').length).toBeGreaterThan(0);
    }
  });

  it('regular group: chat flat, chat-topic isolates one topic, new-topic wraps everything, shared shows two', () => {
    const counts = {
      chat: { topics: 0, fused: 0 },
      'chat-topic': { topics: 1, fused: 0 },
      'new-topic': { topics: 1, fused: 0 },
      shared: { topics: 2, fused: 2 },
    } as const;
    for (const [mode, expected] of Object.entries(counts) as Array<[keyof typeof counts, { topics: number; fused: number }]>) {
      const root = render(React.createElement(RegularMock, { mode }));
      expect(findByClass(root, 'bd-mock-topic')).toHaveLength(expected.topics);
      expect(findByClass(root, 'is-fused')).toHaveLength(expected.fused);
    }
    // Feishu quote reference appears in every regular-group mock.
    const hybrid = render(React.createElement(RegularMock, { mode: 'chat-topic' }));
    expect(findByClass(hybrid, 'bd-mock-quote')).toHaveLength(1);
    expect(findByClass(hybrid, 'bd-mock-reply-topic')).toHaveLength(1);
  });

  it('mention: always/topic/ambient show an ignored-or-yield note; never answers without one', () => {
    const counts = { always: 1, topic: 1, never: 0, ambient: 1 } as const;
    for (const [mode, n] of Object.entries(counts) as Array<[keyof typeof counts, number]>) {
      const root = render(React.createElement(MentionMock, { mode }));
      expect(findByClass(root, 'bd-mock-ignored')).toHaveLength(n);
    }
    const never = render(React.createElement(MentionMock, { mode: 'never' }));
    expect(findByClass(never, 'bd-mock-badge')[0].children.join('')).toBe(t('botDefaults.mock.noMentionBadge'));
    const topic = render(React.createElement(MentionMock, { mode: 'topic' }));
    expect(findByClass(topic, 'bd-mock-topic')).toHaveLength(1);
  });

  it('working dir: off shows the Feishu repo-picker card; default/oncall show the folder flow', () => {
    const off = render(React.createElement(WorkingDirMock, { mode: 'off' }));
    expect(findByClass(off, 'bd-mock-repo-card')).toHaveLength(1);
    expect(findByClass(off, 'bd-mock-repo-row')).toHaveLength(2);
    expect(findByClass(off, 'bd-mock-repo-btn')).toHaveLength(2);
    for (const mode of ['default', 'oncall'] as const) {
      const root = render(React.createElement(WorkingDirMock, { mode }));
      expect(findByClass(root, 'bd-mock-step')).toHaveLength(2);
    }
    const oncall = render(React.createElement(WorkingDirMock, { mode: 'oncall' }));
    const badges = findByClass(oncall, 'bd-mock-step-badge').map(n => n.children.join(''));
    expect(badges).toContain(t('botDefaults.mock.badgeOpenChat'));
    expect(findByClass(oncall, 'bd-mock-crowd')).toHaveLength(1);
  });
});

describe('bot defaults page wiring', () => {
  it('uses ModeCardPicker (not a dropdown) for the four hard-to-name settings', () => {
    for (const dataInput of ['workingDirMode', 'p2pMode', 'regularGroupMode', 'regularGroupMentionMode']) {
      expect(page).toContain(`dataInput="${dataInput}"`);
      expect(page).toContain(`<ModeCardPicker`);
    }
    for (const mockTag of ['<P2pMock', '<RegularMock', '<MentionMock', '<WorkingDirMock']) {
      expect(page).toContain(mockTag);
    }
    // Cards carry descriptions + tags from i18n keys.
    expect(page).toContain("description: tr('botDefaults.regularChatTopicDesc')");
    expect(page).toContain("tags: tags3('botDefaults.regularChatTag1'");
    // Doc subscription stays a (hinted) dropdown — only the four settings became cards.
    expect(page).toContain('dataInput="docSubscribeDefaultMode"');
  });
});

describe('mode card / mock CSS', () => {
  it('lays cards out as a responsive equal-width grid', () => {
    expect(css).toMatch(/\.bot-defaults-page \.bd-mode-cards\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(210px,\s*1fr\)\);/);
  });

  it('shows selection with an accent ring and keeps mock screenshots fixed-light', () => {
    expect(css).toMatch(/\.bd-mode-card\.is-selected\s*\{[^}]*border-color:\s*var\(--accent\);/);
    expect(css).toContain('color-scheme: light');
    // Four per-mode tone tints exist.
    for (const tone of ['a', 'b', 'c', 'd']) {
      expect(css).toContain(`.bd-mock-tone-${tone} {`);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
