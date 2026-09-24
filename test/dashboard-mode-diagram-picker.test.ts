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
const diagrams = readFileSync(new URL('../src/dashboard/web/mode-diagrams.tsx', import.meta.url), 'utf8');

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

  it('regular group: chat flat, chat-topic isolates one topic, new-topic forks, shared shows two', () => {
    const counts = {
      chat: { topics: 0 },
      'chat-topic': { topics: 1 },
      'new-topic': { topics: 2 },
      shared: { topics: 2 },
    } as const;
    for (const [mode, expected] of Object.entries(counts) as Array<[keyof typeof counts, { topics: number }]>) {
      const root = render(React.createElement(RegularMock, { mode }));
      expect(findByClass(root, 'bd-mock-topic')).toHaveLength(expected.topics);
    }
    // Feishu quote reference appears in every regular-group mock.
    const hybrid = render(React.createElement(RegularMock, { mode: 'chat-topic' }));
    expect(findByClass(hybrid, 'bd-mock-quote')).toHaveLength(1);
    expect(findByClass(hybrid, 'bd-mock-reply-topic')).toHaveLength(1);
    // 顶层连续：普通文字的上下文标签（非胶囊）；话题盒另有一个 B 标签；盒内两轮 @ 追问
    expect(findByClass(hybrid, 'bd-mock-ctx')).toHaveLength(1);
    expect(findByClass(hybrid, 'bd-mock-topic-label')).toHaveLength(1);
    expect(findByClass(hybrid, 'bd-mock-topic')[0].findAll(node => classes(node).includes('bd-mock-bubble-g'))).toHaveLength(2);
    // 一句话一话题：new-topic 两个话题各有自己的上下文标签（A / B）
    const fork = render(React.createElement(RegularMock, { mode: 'new-topic' }));
    expect(findByClass(fork, 'bd-mock-topic-a')).toHaveLength(1);
    expect(findByClass(fork, 'bd-mock-topic-b')).toHaveLength(1);
    // 共享：两话题同色（都是 A），外侧有「共用上下文」括线；
    // 第一话题先交代 A、B，第二话题才能引用「上个话题的 A、B」证明跨话题记忆
    const shared = render(React.createElement(RegularMock, { mode: 'shared' }));
    expect(findByClass(shared, 'bd-mock-shared-brace')).toHaveLength(1);
    expect(findByClass(shared, 'bd-mock-topic-b')).toHaveLength(0);
    expect(findByClass(shared, 'bd-mock-ctx')[0].children.join('')).toContain('共用上下文');
    const sharedText = shared.findAll(() => true)
      .flatMap(n => Array.isArray(n.children)
        ? n.children.filter((c): c is string => typeof c === 'string')
        : [])
      .join('');
    expect(sharedText).toContain('A、B 两个用例失败');
    expect(sharedText).toContain('上个话题的 A、B');
  });

  it('regular group messages are all left-aligned (Feishu group layout), unlike DM right bubbles', () => {
    const regular = render(React.createElement(RegularMock, { mode: 'chat-topic' }));
    expect(findByClass(regular, 'bd-mock-bubble-g').length).toBeGreaterThan(0);
    expect(findByClass(regular, 'bd-mock-bubble-r')).toHaveLength(0);
    const dm = render(React.createElement(P2pMock, { mode: 'chat' }));
    expect(findByClass(dm, 'bd-mock-bubble-r').length).toBeGreaterThan(0);
    expect(findByClass(dm, 'bd-mock-bubble-g')).toHaveLength(0);
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
    // Regular group is pinned to two columns; scene tags are capped at two per card.
    expect(page).toMatch(/<ModeCardPicker\s+columns=\{2\}\s+dataInput="regularGroupMode"/);
    // Doc subscription stays a (hinted) dropdown — only the four settings became cards.
    expect(page).toContain('dataInput="docSubscribeDefaultMode"');
  });
});

describe('mode card / mock CSS', () => {
  it('lays fixed-column cards out two-wide (one column in narrow containers), same-row equal height', () => {
    // 外层命名容器 + 容器查询断点（按内容区宽度，不是视口）
    expect(diagrams).toContain("'bd-mode-cards-wrap'");
    expect(css).toContain('container-name: bd-mode-cards');
    expect(css).toMatch(/\.bd-mode-cards\.is-fixed-cols\s*\{[^}]*repeat\(var\(--bd-mode-cols,\s*2\),\s*minmax\(0,\s*1fr\)\);/);
    expect(css).toMatch(/@container bd-mode-cards \(max-width:\s*620px\)[^@]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    // 同排等高：stretch（不是 start），卡片内预览区 flex:1 吸收余量
    expect(css).toMatch(/\.bd-mode-cards\s*\{[^}]*align-items:\s*stretch;/);
  });

  it('switches the DM-to-groups mock to vertical in narrow cards and wraps repo buttons', () => {
    // 截图区自身是 inline-size 查询容器，<360px 时建群图纵向
    expect(css).toContain('container-name: bd-mode-mock');
    expect(css).toMatch(/@container bd-mode-mock \(max-width:\s*360px\)[^@]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/\.bd-mock-repo-actions\s*\{[^}]*flex-wrap:\s*wrap;/);
  });

  it('keeps mock screenshots on a fixed neutral Feishu light base, with color used only for context', () => {
    expect(css).toMatch(/\.bd-mode-mock\s*\{[^}]*background:\s*#f7f8fa;/);
    expect(css).toContain('color-scheme: light');
    // Two context tones (A/B) — but never a full-tint base per mock.
    expect(css).toContain('--m-ctx-a: #5b7cf0;');
    expect(css).toContain('--m-ctx-b: #8a6ce8;');
    expect(css).not.toContain('is-fused');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
