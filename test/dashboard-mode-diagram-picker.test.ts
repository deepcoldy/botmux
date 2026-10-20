/**
 * 会话/目录模式的紧凑选项组 + 独立示例侧栏。
 * 单测环境无 jsdom：mock react-dom 的 createPortal 让侧栏内联渲染，
 * document 给最小 stub（addEventListener 捕获 Esc 处理器）。
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 侧栏用 createPortal 挂 document.body；测试里改成直接内联渲染
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: unknown) => node };
});

const bodyStyle: Record<string, string> = {};
type DocEvent = { key: string; shiftKey?: boolean; stopPropagation: () => void; preventDefault: () => void };
const listeners: Record<string, Array<(e: DocEvent) => void>> = {};
// body 直接子元素（模拟顶栏 / main 等整页框架）的属性记录
const frame = {
  attrs: new Map<string, string | null>(),
  setAttribute(k: string, v: string) { this.attrs.set(k, v); },
  removeAttribute(k: string) { this.attrs.delete(k); },
  hasAttribute(k: string) { return this.attrs.has(k); },
  getAttribute(k: string) { return this.attrs.get(k) ?? null; },
};
function resetDom(): void {
  for (const k of Object.keys(bodyStyle)) delete bodyStyle[k];
  frame.attrs.clear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  (globalThis as Record<string, unknown>).__activeEl = null;
}
const makeDocument = () => ({
  body: {
    style: bodyStyle,
    children: [frame],
  },
  addEventListener: (type: string, fn: (e: DocEvent) => void) => { (listeners[type] ??= []).push(fn); },
  removeEventListener: (type: string, fn: (e: DocEvent) => void) => {
    listeners[type] = (listeners[type] ?? []).filter(f => f !== fn);
  },
  getElementById: () => ({ focus: () => {} }),
  querySelector: () => null,
  get activeElement() { return (globalThis as Record<string, unknown>).__activeEl as unknown; },
});
(globalThis as Record<string, unknown>).document = makeDocument();
function dispatch(event: DocEvent): void {
  (listeners.keydown ?? []).forEach(fn => fn(event));
}

import {
  MentionMock,
  ModeOptionGroup,
  P2pMock,
  RegularMock,
  WorkingDirMock,
  type ModeOption,
} from '../src/dashboard/web/mode-diagrams.js';

function classes(node: ReactTestInstance): string[] {
  const className = node.props && node.props.className;
  return typeof className === 'string' ? className.split(/\s+/) : [];
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

function makeOptions(names: string[]): ModeOption<string>[] {
  return names.map((name, i) => ({
    value: `v${i}`,
    name,
    short: `机制说明 ${i}`,
    isDefault: i === 0,
    mock: React.createElement('div', { 'data-mock': name }),
    tags: [`场景 ${i}`],
  }));
}

function groupProps(overrides: Partial<{ value: string; onChange: ReturnType<typeof vi.fn> }> = {}) {
  return {
    dataInput: 'demo',
    groupName: '普通群',
    groupSub: '副标题',
    exampleTitle: '普通群 · 示例',
    value: 'v0',
    options: makeOptions(['混合模式', '话题模式']),
    wideCols: 2,
    narrowCols: 1,
    onChange: () => {},
    ...overrides,
  };
}

beforeEach(() => { resetDom(); });

describe('ModeOptionGroup main view', () => {
  it('renders compact radios with name + short + default tag and NO big mock on the page', () => {
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps({ value: 'v1' })));
    const radios = root.findAll(node => node.props.role === 'radio');
    expect(radios).toHaveLength(2);
    expect(radios[0].props['aria-checked']).toBe(false);
    expect(radios[1].props['aria-checked']).toBe(true);
    expect(findByClass(root, 'bd-mode-opt-name').map(n => n.children.filter((c): c is string => typeof c === 'string').join(''))).toEqual(['混合模式', '话题模式']);
    expect(findByClass(root, 'bd-mode-opt-short')).toHaveLength(2);
    expect(findByClass(root, 'bd-mode-default-tag')).toHaveLength(1); // only the default option
    expect(findByClass(root, 'bd-example-panel')).toHaveLength(0);
    expect(root.findAll(node => node.props['data-mock'])).toHaveLength(0);
  });

  it('selecting a radio calls onChange immediately (the real save path)', () => {
    const onChange = vi.fn();
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps({ onChange })));
    act(() => root.findAll(node => node.props.role === 'radio')[1].props.onClick());
    expect(onChange).toHaveBeenLastCalledWith('v1');
  });
});

describe('ModeOptionGroup example drawer', () => {
  it('opens on trigger click and renders only the previewed mock, starting on current value', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps()));
    });
    const root = renderer.root;
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    expect(findByClass(root, 'bd-example-panel')).toHaveLength(1);
    expect(findByClass(root, 'bd-example-mock')[0].findByProps({ 'data-mock': '混合模式' })).toBeTruthy();
  });

  it('switching tabs changes ONLY preview and never calls the save callback; main radio stays', () => {
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps({ onChange })));
    });
    const root = renderer.root;
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    const tabs = () => root.findAll(node => node.props.role === 'tab');
    expect(tabs()).toHaveLength(2);
    expect(findByClass(tabs()[0], 'bd-example-current')).toHaveLength(1); // v0 is current
    act(() => tabs()[1].props.onClick());
    expect(onChange).not.toHaveBeenCalled();
    const viewing = tabs().find(x => classes(x).includes('is-viewing'));
    expect(viewing?.props['aria-selected']).toBe(true);
    // preview now shows v1's mock
    expect(findByClass(root, 'bd-example-mock')[0].findByProps({ 'data-mock': '话题模式' })).toBeTruthy();
    // main-page selection unchanged
    const selected = root.findAll(node => node.props.role === 'radio').find(r => r.props['aria-checked']);
    expect(selected?.props['data-value']).toBe('v0');
  });

  it('closes on Esc (document listener) and the panel unmounts', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps()));
    });
    const root = renderer.root;
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    expect(findByClass(root, 'bd-example-panel')).toHaveLength(1);
    act(() => {
      dispatch({ key: 'Escape', stopPropagation: () => {}, preventDefault: () => {} });
    });
    expect(findByClass(root, 'bd-example-panel')).toHaveLength(0);
  });

  it('is a modal dialog with a roving-tabindex tablist (only viewing tab tabbable)', () => {
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps()));
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    const panel = findByClass(root, 'bd-example-panel')[0];
    expect(panel.props['aria-modal']).toBeTruthy();
    const tabs = root.findAll(node => node.props.role === 'tab');
    expect(tabs[0].props.tabIndex).toBe(0);
    expect(tabs[1].props.tabIndex).toBe(-1);
  });

  it('locks scroll and marks the whole background frame inert while open, restores on close', () => {
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps()));
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    expect(bodyStyle.overflow).toBe('hidden');
    expect(frame.getAttribute('inert')).toBe('');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      dispatch({ key: 'Escape', stopPropagation: () => {}, preventDefault: () => {} });
    });
    expect(bodyStyle.overflow).toBeUndefined();
    expect(frame.hasAttribute('inert')).toBe(false);
  });

  it('re-homes Tab from a focused tab that is inside the drawer but off the Tab sequence, and wraps at the ends', () => {
    // 方向键可把焦点移到 tabIndex=-1 的 tab：焦点在面板内却不在可 Tab 序列里，
    // 浏览器会继续往后找而穿出抽屉，所以必须按运行时 tabIndex 过滤并统一兜底。
    const focused: string[] = [];
    const fakeEl = (name: string, tabIndex: number) => ({
      name, tabIndex, offsetParent: {}, hasAttribute: () => false, focus: () => { focused.push(name); },
    });
    const close = fakeEl('close', 0);
    const viewingTab = fakeEl('viewing-tab', 0);
    const otherTab = fakeEl('other-tab', -1);
    const panel = { querySelectorAll: () => [close, viewingTab, otherTab] };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps()), {
        createNodeMock: el => (el.type === 'aside' ? panel : { focus: () => {} }),
      });
    });
    act(() => findByClass(renderer.root, 'bd-mode-example-trigger')[0].props.onClick());
    const pressTab = (active: unknown, shiftKey = false) => {
      (globalThis as Record<string, unknown>).__activeEl = active;
      focused.length = 0;
      const preventDefault = vi.fn();
      dispatch({ key: 'Tab', shiftKey, stopPropagation: () => {}, preventDefault });
      return { prevented: preventDefault.mock.calls.length > 0, focused: [...focused] };
    };

    expect(pressTab(otherTab)).toEqual({ prevented: true, focused: ['close'] });
    expect(pressTab(otherTab, true)).toEqual({ prevented: true, focused: ['viewing-tab'] });
    expect(pressTab(viewingTab)).toEqual({ prevented: true, focused: ['close'] });
    expect(pressTab(close, true)).toEqual({ prevented: true, focused: ['viewing-tab'] });
    expect(pressTab(close)).toEqual({ prevented: false, focused: [] });
    act(() => renderer.unmount());
  });

  it('does not steal focus on parent re-render while open (mount-once effect)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps()));
    });
    const root1 = renderer.root;
    act(() => findByClass(root1, 'bd-mode-example-trigger')[0].props.onClick());
    // switch preview to second option, then force a fresh render with new props object
    act(() => root1.findAll(node => node.props.role === 'tab')[1].props.onClick());
    act(() => {
      renderer.update(React.createElement(ModeOptionGroup<string>, { ...groupProps(), groupSub: '副标题变了' }));
    });
    const root2 = renderer.root;
    // drawer still open; preview is a controlled state inside the same instance
    expect(findByClass(root2, 'bd-example-panel')).toHaveLength(1);
    const viewing = root2.findAll(node => node.props.role === 'tab').find(t => t.props['aria-selected'] === true);
    expect(viewing?.props['data-value'] ?? (viewing?.children[0] as string)).toBeTruthy();
  });

  it('wires tabs to the tabpanel with stable ids (aria-controls / labelledby)', () => {
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps()));
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    const panel = findByClass(root, 'bd-example-body')[0];
    expect(panel.props.role).toBe('tabpanel');
    expect(panel.props['aria-labelledby']).toMatch(/^bd-example-tab-/);
    expect(panel.props.id).toMatch(/^bd-example-panel-/);
    const firstTab = root.findAll(node => node.props.role === 'tab')[0];
    expect(firstTab.props['aria-controls']).toBe(panel.props.id);
  });

  it('arrow-right in the tablist moves focus/preview via a handled key event', () => {
    const root = render(React.createElement(ModeOptionGroup<string>, groupProps()));
    act(() => findByClass(root, 'bd-mode-example-trigger')[0].props.onClick());
    const prevented = vi.fn();
    act(() => root.findAll(node => node.props.role === 'tab')[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: prevented }));
    expect(prevented).toHaveBeenCalled();
    const viewing = root.findAll(node => node.props.role === 'tab').find(x => classes(x).includes('is-viewing'));
    expect(viewing?.props['aria-selected']).toBe(true);
    expect(findByClass(root, 'bd-example-mock')[0].findByProps({ 'data-mock': '话题模式' })).toBeTruthy();
  });
});

describe('ModeOptionGroup radio keyboard', () => {
  it('roving tabindex on radios; arrow keys move focus and select', () => {
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ModeOptionGroup<string>, groupProps({ onChange })));
    });
    const root = renderer.root;
    const radios = () => root.findAll(node => node.props.role === 'radio');
    expect(radios()[0].props.tabIndex).toBe(0);
    expect(radios()[1].props.tabIndex).toBe(-1);
    const prevented = vi.fn();
    act(() => radios()[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: prevented }));
    expect(prevented).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('v1');
  });
});

describe('mode mock screenshots', () => {
  it('p2p / regular / mention / working dir each render the expected markers', () => {
    const cases: Array<[React.JSX.Element, string]> = [
      [React.createElement(P2pMock, { mode: 'chat' }), 'bd-mock'],
      [React.createElement(RegularMock, { mode: 'new-topic' }), 'bd-mock-topic-b'],
      [React.createElement(MentionMock, { mode: 'never' }), 'bd-mock-badge'],
      [React.createElement(WorkingDirMock, { mode: 'off' }), 'bd-mock-repo-card'],
    ];
    for (const [el, cls] of cases) {
      expect(findByClass(render(el), cls).length).toBeGreaterThan(0);
    }
  });

  it('regular group semantic markers', () => {
    const hybrid = render(React.createElement(RegularMock, { mode: 'chat-topic' }));
    expect(findByClass(hybrid, 'bd-mock-ctx')).toHaveLength(1);
    expect(findByClass(hybrid, 'bd-mock-topic')).toHaveLength(1);
    const fork = render(React.createElement(RegularMock, { mode: 'new-topic' }));
    expect(findByClass(fork, 'bd-mock-topic-a')).toHaveLength(1);
    expect(findByClass(fork, 'bd-mock-topic-b')).toHaveLength(1);
    const shared = render(React.createElement(RegularMock, { mode: 'shared' }));
    expect(findByClass(shared, 'bd-mock-shared-brace')).toHaveLength(1);
  });
});

// 不用 restoreAllMocks：它会恢复 vi.mock('react-dom') 的 createPortal，
// 导致后续测试抽屉无法渲染。各测试局部 spy 自行清理即可。
afterEach(() => {
  vi.clearAllMocks();
});
