import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { KANBAN_COLUMN_PAGE, SessionsKanbanView } from '../src/dashboard/web/sessions-kanban.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOOP = (): void => {};
const ICONS = {
  close: 'c', feishu: 'f', history: 'h', lock: 'l',
  restart: 'r', terminal: 't', unlock: 'u',
};

function idleRow(sessionId: string, chatId: string, lastMessageAt: number): any {
  return { sessionId, chatId, status: 'idle', cliId: 'codex', title: sessionId, lastMessageAt };
}

function render(rows: any[]): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionsKanbanView, {
      rows, host: null,
      canRestartSession: () => true,
      icons: ICONS,
      lockActionLabel: () => 'lock',
      sessionStatusText: () => 'idle',
      selectedSessionIds: new Set<string>(),
      onDetails: NOOP, onHistory: NOOP, onMoveRows: NOOP, onRename: NOOP, onRestart: NOOP,
      onToggleLock: NOOP, onToggleSelect: NOOP,
    } as any));
  });
  return renderer;
}

function todoColumn(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => node.type === 'section' && node.props['data-col'] === 'todo');
}

const cards = (col: ReactTestInstance): number =>
  col.findAll(node => node.type === 'article').length;
const showMore = (col: ReactTestInstance): ReactTestInstance | undefined =>
  col.findAll(node =>
    node.type === 'button'
    && typeof node.props.children === 'string'
    && node.props.children.includes('显示更多'))[0];
const cluster = (col: ReactTestInstance, chatId: string): ReactTestInstance =>
  col.find(node => node.props['data-chat'] === chatId);
const expandToggle = (col: ReactTestInstance, chatId: string): ReactTestInstance =>
  cluster(col, chatId).find(node =>
    node.type === 'button' && String(node.props.className).includes('kanban-cluster-toggle'));

describe('看板列分页按成员卡计数，群簇不绕过渲染上限', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: NOOP, removeItem: NOOP } });
    vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
  });
  afterEach(() => vi.useRealTimers());

  it('单会话流：首屏 60 张，点「显示更多」补齐剩余', () => {
    const rows = Array.from({ length: KANBAN_COLUMN_PAGE + 7 }, (_, i) =>
      idleRow(`solo-${i}`, `oc_solo_${i}`, 1000 - i));
    const renderer = render(rows);
    let col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE);
    const btn = showMore(col);
    expect(btn?.props.children).toContain('7');
    act(() => btn!.props.onClick());
    col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE + 7);
    expect(showMore(col)).toBeUndefined();
  });

  it('60 个单会话 + 一个 5 人群：加页后群簇以折叠头出现，展开才渲染成员，按钮不谎报', () => {
    const rows: any[] = Array.from({ length: KANBAN_COLUMN_PAGE }, (_, i) =>
      idleRow(`solo-${i}`, `oc_solo_${i}`, 1000 - i));
    for (let i = 0; i < 5; i++) rows.push(idleRow(`grp-${i}`, 'oc_big', 500 - i));
    const renderer = render(rows);
    let col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE);
    expect(showMore(col)?.props.children).toContain('5');
    act(() => showMore(col)!.props.onClick());
    col = todoColumn(renderer);
    // 第二页只多出折叠的群标题：5 张成员卡尚未渲染，列底也不再谎报剩余数
    // （展开该群即可到达，不算「需要再加一页」）。
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE);
    expect(cluster(col, 'oc_big')).toBeTruthy();
    expect(showMore(col)).toBeUndefined();
    act(() => expandToggle(col, 'oc_big').props.onClick({ stopPropagation: NOOP }));
    col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE + 5);
  });

  it('单个 400 人群：折叠时零卡片，展开后按 60 截断并逐页补齐，不一次性渲染全部', () => {
    const rows: any[] = Array.from({ length: 400 }, (_, i) =>
      idleRow(`big-${i}`, 'oc_400', 1000 - i));
    const renderer = render(rows);
    let col = todoColumn(renderer);
    expect(cluster(col, 'oc_400')).toBeTruthy();
    expect(cards(col)).toBe(0);
    expect(showMore(col)).toBeUndefined();
    act(() => expandToggle(col, 'oc_400').props.onClick({ stopPropagation: NOOP }));
    col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE);
    expect(showMore(col)?.props.children).toContain('340');
    act(() => showMore(col)!.props.onClick());
    col = todoColumn(renderer);
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE * 2);
    expect(showMore(col)?.props.children).toContain('280');
  });

  it('大折叠群在列首时只占一个标题位：单会话首屏照常铺满，加一页即可见全部', () => {
    // effectiveKanbanPosition 让最近活跃的群恒在列首。3000 人群（最新一条比所有
    // 单卡新）+ 100 个单会话：折叠群绝不能按 3000 成员吃掉整列预算。
    const rows: any[] = [];
    for (let i = 0; i < 3000; i++) rows.push(idleRow(`busy-${i}`, 'oc_busy', 4000 - i));
    for (let i = 0; i < 100; i++) rows.push(idleRow(`solo-${i}`, `oc_solo_${i}`, 1000 - i));
    const renderer = render(rows);
    let col = todoColumn(renderer);
    expect(cluster(col, 'oc_busy')).toBeTruthy();
    // 群标题占 1 个渲染单位，剩余 59 个位置给单卡。
    expect(cards(col)).toBe(KANBAN_COLUMN_PAGE - 1);
    expect(showMore(col)?.props.children).toContain('41');
    act(() => showMore(col)!.props.onClick());
    col = todoColumn(renderer);
    expect(cards(col)).toBe(100);
    expect(showMore(col)).toBeUndefined();
  });
});
