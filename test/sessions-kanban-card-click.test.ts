import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { SessionsKanbanView } from '../src/dashboard/web/sessions-kanban.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOOP = (): void => {};
const ICONS = {
  close: 'c', details: 'd', feishu: 'f', history: 'h', key: 'k',
  lock: 'l', restart: 'r', terminal: 't', unlock: 'u',
};
const ROW = {
  sessionId: 's_click', chatId: 'oc_click', title: '点卡片打开详情',
  larkAppId: 'app_click', cliId: 'claude', status: 'idle', lastMessageAt: 1,
};

function render(onDetails: (row: any) => void, onToggleSelect: (row: any) => void): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionsKanbanView, {
      rows: [ROW], host: null,
      canRestartSession: () => true, icons: ICONS,
      lockActionLabel: () => 'lock', sessionStatusText: () => 'idle',
      selectedSessionIds: new Set<string>(),
      onDetails, onHistory: NOOP, onMoveRows: NOOP, onRename: NOOP, onRestart: NOOP,
      onToggleLock: NOOP, onToggleSelect,
    } as any));
  });
  return renderer;
}

function card(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => node.type === 'article' && node.props['data-id'] === ROW.sessionId);
}

// 卡片空白处的点击：target 不在任何 a/button/input/label 里。
const plainTarget = { closest: () => null };

describe('看板卡片：单击打开详情，Shift/⌘/勾选框才是选中', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: NOOP, removeItem: NOOP } });
    vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('plain click opens the details drawer and does not select', () => {
    vi.useFakeTimers();
    const onDetails = vi.fn();
    const onToggleSelect = vi.fn();
    const renderer = render(onDetails, onToggleSelect);
    act(() => { card(renderer).props.onClick({ target: plainTarget, shiftKey: false, metaKey: false, ctrlKey: false }); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onDetails.mock.calls[0][0].sessionId).toBe(ROW.sessionId);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it.each([['shiftKey'], ['metaKey'], ['ctrlKey']])('%s + click selects instead of opening', (key) => {
    vi.useFakeTimers();
    const onDetails = vi.fn();
    const onToggleSelect = vi.fn();
    const renderer = render(onDetails, onToggleSelect);
    act(() => { card(renderer).props.onClick({ target: plainTarget, shiftKey: false, metaKey: false, ctrlKey: false, [key]: true }); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onDetails).not.toHaveBeenCalled();
  });

  it('the card checkbox toggles selection without opening details', () => {
    vi.useFakeTimers();
    const onDetails = vi.fn();
    const onToggleSelect = vi.fn();
    const renderer = render(onDetails, onToggleSelect);
    const checkbox = renderer.root.find(node => node.type === 'input' && node.props.type === 'checkbox');
    act(() => { checkbox.props.onChange({}); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onDetails).not.toHaveBeenCalled();
  });

  it('keyboard: Enter opens details, Space toggles selection', () => {
    const onDetails = vi.fn();
    const onToggleSelect = vi.fn();
    const renderer = render(onDetails, onToggleSelect);
    const el = card(renderer);
    const keyEvent = (key: string) => {
      const ev: any = { key, preventDefault: NOOP };
      ev.target = ev; ev.currentTarget = ev;
      return ev;
    };
    act(() => { el.props.onKeyDown(keyEvent('Enter')); });
    act(() => { el.props.onKeyDown(keyEvent(' ')); });
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });
});
