import { beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

// loadNameMaps() 的唯一网络依赖。必须在 import ui 之前 mock，否则 ui 模块
// 加载时抓到的是真实实现。
vi.mock('../src/dashboard/web/groups-api.js', () => ({
  fetchGroupsNamesSnapshot: vi.fn(async () => ({
    bots: [{ larkAppId: 'app_memo', botName: '友好机器人', botAvatarUrl: '' }],
    chats: [],
  })),
}));

import { SessionsKanbanView } from '../src/dashboard/web/sessions-kanban.js';
import { botDisplayName, loadNameMaps, ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * KanbanCard 有一个自定义 memo 比较器（卡片数量随会话线性增长，全量重渲染实测
 * 单次点选阻塞约 2s，所以这个比较器必须留着）。它的代价是：**比较器只看 props，
 * 看不见任何模块级可变状态**——卡片渲染时真正读的 t()（locale）与
 * botDisplayName()（运行时填充的 Map）都不在 props 里。
 *
 * 这两条各自需要一个独立机制才能穿透 memo，缺一不可：
 *   locale  → KanbanCardBase 里的 useT()（订阅 ui 的 locale）
 *   名字表  → callbacks.namesVersion（页面侧 loadNameMaps().then(refresh) 的 revision）
 *
 * useT() **治不了**名字表：它只订阅 locale，而 botNameByAppId / chatNameById
 * 没有任何订阅机制，loadNameMaps() 填完不 emit。两条都在下面各自钉住。
 */

// ⚠️ 这些必须是模块级常量。比较器是逐字段比引用的，任何一个在 makeProps 里现造
// 的对象（icons 尤其）都会让比较器提前 return false —— 那样测试会「通过」，但
// 通过的原因是那个新对象，不是被测的判据，等于没测到。
const NOOP = (): void => {};
const ICONS = {
  close: 'c', details: 'd', feishu: 'f', history: 'h', key: 'k',
  lock: 'l', restart: 'r', terminal: 't', unlock: 'u',
};
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
const CAN_RESTART = (): boolean => true;
const LOCK_LABEL = (): string => 'lock';
const STATUS_TEXT = (): string => 'running';
const GET_TEAM_CHAT_IDS = (): Set<string> => new Set<string>();

const ROW = {
  sessionId: 's_memo', chatId: 'oc_memo', title: '看板卡片 memo 用例',
  larkAppId: 'app_memo', cliId: 'claude', status: 'running',
  lastMessageAt: Date.now(), locked: false,
};

function makeProps(namesVersion: number): Record<string, unknown> {
  return {
    rows: [ROW], groupBy: 'chat', teams: [], teamsLoaded: true, teamKey: '',
    teamBoardData: null, teamBoardKey: '', host: null,
    canRestartSession: CAN_RESTART, getTeamChatIds: GET_TEAM_CHAT_IDS,
    icons: ICONS, lockActionLabel: LOCK_LABEL, sessionStatusText: STATUS_TEXT,
    selectedSessionIds: EMPTY_SELECTION,
    onDetails: NOOP, onHistory: NOOP, onMoveRows: NOOP, onNeedTeamBoard: NOOP,
    onNeedTeams: NOOP, onRename: NOOP, onRestart: NOOP, onTeamScope: NOOP,
    onToggleLock: NOOP, onToggleSelect: NOOP,
    namesVersion,
  };
}

function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll(node => node.children.some(c => typeof c === 'string' && c.includes(text))).length > 0;
}

describe('KanbanCard 的 memo 比较器不能挡住模块级可变状态', () => {
  beforeAll(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        removeItem: (k: string) => { mem.delete(k); },
      },
    });
    vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
  });

  it('切语言时卡片文案跟着变（靠 useT()，不靠任何 props 变化）', () => {
    act(() => { ui.setLocale('zh'); });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(React.createElement(SessionsKanbanView, makeProps(0) as any)); });

    // 自证探针能打响：中文态下确实渲染出了中文文案。
    expect(hasText(renderer.root, '更新于')).toBe(true);

    // 只切 locale，props 一个字节都不变 —— 卡片必须自己订阅才会重渲染。
    act(() => { ui.setLocale('en'); });
    expect(hasText(renderer.root, 'Updated')).toBe(true);
    expect(hasText(renderer.root, '更新于')).toBe(false);

    act(() => { ui.setLocale('zh'); });
  });

  it('名字表异步回来后卡片换成人话名（靠 namesVersion，useT 治不了）', async () => {
    act(() => { ui.setLocale('zh'); });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(React.createElement(SessionsKanbanView, makeProps(0) as any)); });

    // 名字表未回来：卡片显示原始 id。
    expect(hasText(renderer.root, 'app_memo')).toBe(true);

    await act(async () => { await loadNameMaps(); });

    // 自证探针能打响：Map 确实被填上了，否则下面的断言是空转。
    expect(botDisplayName(ROW)).toBe('友好机器人');

    // 页面侧 loadNameMaps().then(refresh) → revision++ → namesVersion++。
    // 行对象引用不变，所以比较器只能靠 namesVersion 这一项判出「要重画」。
    act(() => { renderer.update(React.createElement(SessionsKanbanView, makeProps(1) as any)); });

    expect(hasText(renderer.root, '友好机器人')).toBe(true);
    expect(hasText(renderer.root, 'app_memo')).toBe(false);
  });
});
