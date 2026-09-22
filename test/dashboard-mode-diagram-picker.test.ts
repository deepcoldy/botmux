/**
 * 会话模式下拉的「选项副文案 + 悬停预览图」：
 * - DropdownMenu 新增 hint（仅弹层内显示）与 preview（钉在弹层底部）能力；
 * - mode-diagrams 为四种设置各模式画迷你聊天示意图。
 * 用 react-test-renderer 直接断言组件行为（不依赖 DOM），CSS/接线走源码静态断言，
 * 与仓库里其它 dashboard 测试一致。
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { DropdownMenu } from '../src/dashboard/web/dashboard-components.js';
import {
  MentionModeDiagram,
  P2pModeDiagram,
  RegularGroupModeDiagram,
  WorkingDirModeDiagram,
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

function textOf(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => n.children.filter((c): c is string => typeof c === 'string'))
    .join('');
}

/** Render and keep the renderer alive (useT subscribes to an external store;
 *  a dropped renderer unmounts before assertions run). */
function render(element: React.ReactElement): ReactTestInstance {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!.root;
}

type Opt = { value: string; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean };

function renderMenu(props: {
  options: Opt[];
  value?: string;
  preview?: React.ReactNode;
  onOptionPreview?: (v: string) => void;
  onPreviewEnd?: () => void;
}) {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(DropdownMenu, {
        id: 'menu',
        label: props.options[0]?.label,
        value: props.value ?? (props.options[0]?.value as string),
        options: props.options,
        onChange: () => {},
        onOptionPreview: props.onOptionPreview,
        onPreviewEnd: props.onPreviewEnd,
        preview: props.preview,
      }),
    );
  });
  return renderer!.root;
}

describe('DropdownMenu option hints and preview panel', () => {
  const opts: Opt[] = [
    { value: 'a', label: '模式 A', hint: '一句话说明 A' },
    { value: 'b', label: '模式 B', hint: '一句话说明 B' },
    { value: 'c', label: '模式 C', hint: '一句话说明 C', disabled: true },
  ];

  it('shows the hint only inside popup options, never on the collapsed trigger', () => {
    const root = renderMenu({ options: opts, value: 'a' });
    // Trigger summary carries just the label.
    const summary = root.findByType('summary');
    expect(textOf(summary)).toBe('模式 A');
    expect(textOf(summary)).not.toContain('一句话说明');
    expect(findByClass(summary, 'sect-sort-option')).toHaveLength(0);
    // Every enabled option renders the two-line title+hint body.
    const hintNodes = findByClass(root, 'sect-sort-option-hint');
    expect(hintNodes.map(n => n.children.join(''))).toEqual(['一句话说明 A', '一句话说明 B', '一句话说明 C']);
    const titles = findByClass(root, 'sect-sort-option-title');
    expect(titles.map(n => n.children.join(''))).toEqual(['模式 A', '模式 B', '模式 C']);
  });

  it('previews an option on pointer hover and keyboard focus, but never for disabled entries', () => {
    const onPreview = vi.fn();
    const root = renderMenu({ options: opts, value: 'a', onOptionPreview: onPreview });
    const buttons = root.findAllByType('button');
    act(() => buttons[1].props.onMouseEnter());
    act(() => buttons[1].props.onFocus());
    expect(onPreview.mock.calls).toEqual([['b'], ['b']]);
    onPreview.mockClear();
    act(() => buttons[2].props.onMouseEnter());
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('renders the preview panel and signals preview end while the popup is closed', () => {
    const onEnd = vi.fn();
    const root = renderMenu({
      options: opts,
      value: 'a',
      onPreviewEnd: onEnd,
      preview: React.createElement('div', { 'data-preview': true }, '图示'),
    });
    // Mounted with open=false → stale preview is cleared immediately.
    expect(onEnd).toHaveBeenCalledTimes(1);
    const panel = findByClass(root, 'sect-sort-preview');
    expect(panel).toHaveLength(1);
    expect(panel[0].findByProps({ 'data-preview': true }).children.join('')).toBe('图示');
  });
});

describe('mode diagrams', () => {
  it('p2p: chat shows one continuous lane, thread shows three sessions, group shows session groups', () => {
    const cases = {
      chat: { lanes: 1, groups: 0 },
      thread: { lanes: 3, groups: 0 },
      group: { lanes: 0, groups: 2 },
    } as const;
    for (const [mode, expected] of Object.entries(cases) as Array<[keyof typeof cases, { lanes: number; groups: number }]>) {
      const root = render(React.createElement(P2pModeDiagram, { mode }));
      expect(findByClass(root, 'bd-md-lane')).toHaveLength(expected.lanes);
      expect(findByClass(root, 'bd-md-session-group')).toHaveLength(expected.groups);
      expect(findByClass(root, 'bd-md-caption')[0].children.join('')).toBe(
        t(`botDefaults.diagram.p2p${mode[0].toUpperCase()}${mode.slice(1)}Cap`),
      );
    }
  });

  it('regular group: chat folds the native topic, chat-topic isolates it, new-topic forks, shared reuses', () => {
    const counts = {
      'chat-topic': { lanes: 1, topics: 1, fused: 0 },
      chat: { lanes: 1, topics: 1, fused: 1 },
      'new-topic': { lanes: 3, topics: 0, fused: 0 },
      shared: { lanes: 1, topics: 2, fused: 0 },
    } as const;
    for (const [mode, expected] of Object.entries(counts) as Array<[keyof typeof counts, { lanes: number; topics: number; fused: number }]>) {
      const root = render(React.createElement(RegularGroupModeDiagram, { mode }));
      expect(findByClass(root, 'bd-md-lane')).toHaveLength(expected.lanes);
      expect(findByClass(root, 'bd-md-topic')).toHaveLength(expected.topics);
      expect(findByClass(root, 'bd-md-topic-fused')).toHaveLength(expected.fused);
    }
  });

  it('mention: always/topic show the silent tag for non-@ messages, ambient yields, never answers all', () => {
    const silentByMode = { always: 1, topic: 1, never: 0, ambient: 1 } as const;
    for (const [mode, silent] of Object.entries(silentByMode) as Array<[keyof typeof silentByMode, number]>) {
      const root = render(React.createElement(MentionModeDiagram, { mode }));
      expect(findByClass(root, 'bd-md-silent-row')).toHaveLength(silent);
      // Every variant shows the frame (group chat) and a caption explaining it.
      expect(findByClass(root, 'bd-md-frame')).toHaveLength(1);
      expect(findByClass(root, 'bd-md-caption')[0].children.join('')).toContain(
        t(`botDefaults.diagram.mention${mode[0].toUpperCase()}${mode.slice(1)}Cap`),
      );
    }
    // never carries the explicit "no @ needed" badge.
    const never = render(React.createElement(MentionModeDiagram, { mode: 'never' }));
    expect(findByClass(never, 'bd-md-frame-badge')[0].children.join('')).toBe(t('botDefaults.diagram.badgeNoMention'));
  });

  it('working dir: off runs three flow steps, default/oncall two; oncall carries the open-chat badge', () => {
    const nodeCounts = { off: 3, default: 2, oncall: 2 } as const;
    for (const [mode, n] of Object.entries(nodeCounts) as Array<[keyof typeof nodeCounts, number]>) {
      const root = render(React.createElement(WorkingDirModeDiagram, { mode }));
      expect(findByClass(root, 'bd-md-node')).toHaveLength(n);
    }
    const oncall = render(React.createElement(WorkingDirModeDiagram, { mode: 'oncall' }));
    const badges = findByClass(oncall, 'bd-md-node-badge').map(x => x.children.join(''));
    expect(badges).toContain(t('botDefaults.diagram.badgeOpenChat'));
  });
});

describe('bot defaults page wiring', () => {
  it('passes per-option hints and a live diagram preview for the four hard-to-name pickers', () => {
    for (const dataInput of ['workingDirMode', 'p2pMode', 'regularGroupMode', 'regularGroupMentionMode']) {
      expect(page).toContain(`dataInput="${dataInput}"`);
    }
    expect(page).toContain('preview={<P2pModeDiagram');
    expect(page).toContain('preview={<RegularGroupModeDiagram');
    expect(page).toContain('preview={<MentionModeDiagram');
    expect(page).toContain('preview={<WorkingDirModeDiagram');
    // Hint strings exist on every option of the four pickers...
    for (const key of [
      'botDefaults.p2pChatHint',
      'botDefaults.p2pThreadHint',
      'botDefaults.p2pGroupHint',
      'botDefaults.regularGroupModeChatHint',
      'botDefaults.regularGroupModeChatTopicHint',
      'botDefaults.regularGroupModeNewTopicHint',
      'botDefaults.regularGroupModeSharedHint',
      'botDefaults.mentionModeAlwaysHint',
      'botDefaults.mentionModeTopicHint',
      'botDefaults.mentionModeNeverHint',
      'botDefaults.mentionModeAmbientHint',
      'botDefaults.workingDirModeOffHint',
      'botDefaults.workingDirModeDefaultHint',
      'botDefaults.workingDirModeOncallHint',
      'botDefaults.docSubscribeModeMentionHint',
      'botDefaults.docSubscribeModeAllHint',
    ]) {
      expect(page, `option uses hint key ${key}`).toContain(`hint: tr('${key}')`);
    }
    // ...and the backend picker (module-level table maps hintKey -> hint).
    expect(page).toContain("hintKey: 'botDefaults.backendPtyHint'");
    expect(page).toContain('hint: tr(o.hintKey)');
  });
});

describe('mode diagram / dropdown CSS', () => {
  it('keeps option buttons single-line by default and switches to a two-line card only with a hint', () => {
    expect(css).toMatch(/\.sect-sort-pop button:has\(\.sect-sort-option\)\s*\{/);
    expect(css).toContain('.sect-sort-option-hint');
  });

  it('pins the preview panel to the popup and grows the bot-defaults popup only when a preview exists', () => {
    expect(css).toMatch(/\.sect-sort-pop \.sect-sort-preview\s*\{[^}]*position:\s*sticky;/);
    expect(css).toMatch(
      /\.bot-defaults-page \.bd-field-menu \.sect-sort-pop:has\(\.sect-sort-preview\)\s*\{[^}]*max-height:\s*min\(640px,\s*82vh,\s*var\(--dropdown-popover-space,\s*100vh\)\);/,
    );
  });

  it('styles the mini-chat vocabulary (frames, lanes, topics, three tones) with theme tokens', () => {
    for (const rule of ['.bd-md-frame', '.bd-md-lane', '.bd-md-topic', '.bd-md-bubble', '.bd-md-split']) {
      expect(css, `missing ${rule}`).toContain(rule);
    }
    expect(css).toContain('.bd-md-tone-a { --md-tone: var(--accent); }');
    expect(css).toContain('.bd-md-tone-b { --md-tone: var(--success); }');
    expect(css).toContain('.bd-md-tone-c { --md-tone: var(--info); }');
    // No hard-coded theme colors inside the diagram block: it rides design
    // tokens so dark mode follows automatically.
    const blockStart = css.indexOf('.bd-md-diagram');
    const arrowRule = css.indexOf('.bd-md-flow-arrow {', blockStart);
    const blockEnd = css.indexOf('}', arrowRule) + 1;
    const block = css.slice(blockStart, blockEnd);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
