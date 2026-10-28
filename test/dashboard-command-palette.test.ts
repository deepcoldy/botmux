/**
 * ⌘K 全局搜索（src/dashboard/web/command-palette*.ts[x]）的行为契约：
 *
 *   - model：匹配分档 / 多词 AND / 高亮区间 / 分组排序与截断 / 最近记录 / 唤起键
 *   - sources：会话推荐顺序与跳转目标、设置索引都有译文且能落到真实区块
 *   - 面板交互：键盘上下选择、回车与 ⌘↵ 两种动作、Tab 切分类、输入法组字、Esc、
 *     无分类 tab 的组原地展开、登录态确认前不拉管理数据、加载中空态、名称映射晚到
 *
 * 面板用原生 <dialog>：react-test-renderer 没有 DOM 宿主，ref 恒为 null，ModalDialog
 * 与面板里的 focus / scroll effect 都有 null 兜底；只 stub 面板真正碰到的浏览器全局
 * （location / localStorage / setTimeout / fetch / window 上的 keydown 监听）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXPAND_TIERS,
  PALETTE_RECENT_LIMIT,
  PALETTE_RECENT_STORAGE_KEY,
  SCOPE_RESULT_LIMIT,
  expandGroup,
  isPaletteHotkey,
  matchItem,
  matchToken,
  nextScope,
  paletteVisibility,
  pushRecentKey,
  readRecentKeys,
  searchPalette,
  splitHighlights,
  type PaletteItem,
} from '../src/dashboard/web/command-palette-model.js';
import {
  buildSessionItems,
  buildSettingItems,
  orderSessionsForPalette,
} from '../src/dashboard/web/command-palette-sources.js';
import { SETTINGS_SECTIONS } from '../src/dashboard/web/settings-sections.js';
import {
  CommandPalette,
  __testOnly_resetPaletteRemoteCache,
  type CommandPaletteProps,
} from '../src/dashboard/web/command-palette.js';
import type { PaletteShellContext } from '../src/dashboard/web/command-palette-sources.js';
import { clearHashQueryParam } from '../src/dashboard/web/dashboard-routes.js';
import { setLeaveGuard } from '../src/dashboard/web/leave-guard.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { store } from '../src/dashboard/web/store.js';
import { loadNameMaps, ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** 界面文案一律从翻译表取，改文案不该让行为测试变红。 */
const copy = createDashboardTranslator('zh');

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'key' | 'kind' | 'title'>): PaletteItem {
  return { primary: { label: 'open', href: `#/${partial.key}` }, ...partial };
}

describe('command palette model: matching', () => {
  it('ranks exact > prefix > word start > mid-word substring > fuzzy', () => {
    const exact = matchToken('agent', 'agent')!.score;
    const prefix = matchToken('agents page', 'agent')!.score;
    const wordStart = matchToken('my agent', 'agent')!.score;
    const midWord = matchToken('reagents', 'agent')!.score;
    const fuzzy = matchToken('a great entry', 'agent')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(midWord);
    expect(midWord).toBeGreaterThan(fuzzy);
  });

  it('highlights the word-start occurrence when a token appears more than once', () => {
    expect(matchToken('xbot bot', 'bot')!.ranges).toEqual([{ start: 5, end: 8 }]);
    // CJK 与拉丁字母交界也算词首：「飞书bot」里的 bot。
    expect(matchToken('飞书bot', 'bot')!.ranges).toEqual([{ start: 2, end: 5 }]);
  });

  it('only fuzzy-matches ASCII tokens of 3+ chars and rejects widely scattered letters', () => {
    expect(matchToken('session control', 'sesctl')).toMatchObject({ tier: 'fuzzy' });
    expect(matchToken('会话控制', '会控')).toBeNull();
    expect(matchToken('a stream group', 'ag')).toBeNull();
    expect(matchToken(`a${'x'.repeat(40)}b${'x'.repeat(40)}c`, 'abc')).toBeNull();
  });

  it('hidden fields need a real hit: no fuzzy, and short Latin tokens must start a word', () => {
    const listeners = item({ key: 'page:message-listeners', kind: 'page', title: '消息监听', keywords: ['Message Listener'] });
    expect(matchItem(listeners, ['ag'])).toBeNull();
    expect(matchItem(listeners, ['mess'])).not.toBeNull();
    expect(matchItem(listeners, ['listen'])).not.toBeNull();
    const proxy = item({ key: 'setting:proxy', kind: 'setting', title: 'GitHub 下载代理', subtitle: '全局设置 › 自动维护', keywords: ['GitHub download proxy'] });
    expect(matchItem(proxy, ['dwnld'])).toBeNull();
    // CJK 没有词边界：副标题 / 关键词里的中文子串照常命中。
    expect(matchItem(proxy, ['维护'])).not.toBeNull();
    // 粗筛不能误杀标题上的模糊匹配。
    const control = item({ key: 'page:sessions', kind: 'page', title: 'Session Control' });
    expect(matchItem(control, ['sesctl'])!.titleRanges.length).toBeGreaterThan(0);
  });

  it('requires every query word to match (AND) and keeps title highlights per word', () => {
    const it1 = item({ key: 'session:1', kind: 'session', title: 'Deploy staging api', subtitle: 'bot-a · repo' });
    expect(matchItem(it1, ['deploy', 'missing'])).toBeNull();
    const match = matchItem(it1, ['api', 'deploy'])!;
    expect(match.titleRanges).toEqual([{ start: 0, end: 6 }, { start: 15, end: 18 }]);
    expect(match.subtitleRanges).toEqual([]);
  });

  it('matches hidden keywords (the other locale) without inventing title highlights', () => {
    const settings = item({ key: 'page:settings', kind: 'page', title: '全局设置', keywords: ['Global Settings'] });
    const match = matchItem(settings, ['settings'])!;
    expect(match.score).toBeGreaterThan(0);
    expect(match.titleRanges).toEqual([]);
  });

  it('counts a hit inside the inherited title prefix as context, preferring the item\'s own name', () => {
    const titleContext = 'Bot Config › '.length;
    const child = item({ key: 'setting:child', kind: 'setting', title: 'Bot Config › Model', titleContext });
    const sibling = item({ key: 'setting:sibling', kind: 'setting', title: 'Bot Config › Common' });
    // 只命中继承来的前缀：比把前缀当成自己名字的同级条目弱，前缀里的命中照样高亮。
    expect(matchItem(child, ['bot', 'config'])!.score).toBeLessThan(matchItem(sibling, ['bot', 'config'])!.score);
    expect(matchItem(child, ['bot'])!.titleRanges).toEqual([{ start: 0, end: 3 }]);
    // 自己的名字里也有这个词时用那一处，按它在整个标题里的位置计分，不降权。
    const own = item({ key: 'setting:own', kind: 'setting', title: 'Bot Config › Config directory', titleContext });
    const ownMatch = matchItem(own, ['config'])!;
    expect(ownMatch.titleRanges).toEqual([{ start: titleContext, end: titleContext + 'config'.length }]);
    expect(ownMatch.score).toBe(matchToken('bot config › config directory', 'config', titleContext)!.score);
  });

  it('treats a quick action\'s multi-word alias typed in full like a one-word alias typed in full', () => {
    const phrase = item({ key: 'action:phrase', kind: 'action', title: '创建会话', keywords: ['new session'] });
    const word = item({ key: 'action:word', kind: 'action', title: '创建会话', keywords: ['newsession'] });
    expect(matchItem(phrase, ['new', 'session'])!.score).toBe(matchItem(word, ['newsession'])!.score);
    // 只打了一部分，不算整句。
    expect(matchItem(phrase, ['new', 'sess'])!.score).toBeLessThan(matchItem(word, ['newsession'])!.score);
    // 别的条目的多词关键词多是父级名字（「Global Settings」挂在一串设置区块上），不抬成全等。
    const block = item({ key: 'setting:block', kind: 'setting', title: '访问权限', keywords: ['global settings'] });
    expect(matchItem(block, ['global', 'settings'])!.score).toBeLessThan(matchItem(phrase, ['new', 'session'])!.score);
  });

  it('splits text into highlighted and plain parts', () => {
    expect(splitHighlights('hello world', [{ start: 0, end: 2 }, { start: 6, end: 11 }])).toEqual([
      { text: 'he', hit: true },
      { text: 'llo ', hit: false },
      { text: 'world', hit: true },
    ]);
    expect(splitHighlights('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('command palette model: search & grouping', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => item({ key: `session:${i}`, kind: 'session', title: `alpha session ${i}` }));
  const items: PaletteItem[] = [
    ...sessions,
    item({ key: 'skill:alpha', kind: 'skill', title: 'alpha' }),
    item({ key: 'setting:access', kind: 'setting', title: 'Access' }),
    item({ key: 'action:create', kind: 'action', title: 'Create session' }),
    item({ key: 'page:settings', kind: 'page', title: 'Settings' }),
  ];

  it('empty query in "all": recent first, then a few session suggestions with a "show all" row, actions, pages', () => {
    const result = searchPalette({ items, query: '', scope: 'all', recentKeys: ['page:settings', 'gone:key'] });
    expect(result.groups.map(group => group.id)).toEqual(['recent', 'session', 'action']);
    const sessionGroup = result.groups[1]!;
    expect(sessionGroup.rows.filter(row => row.type === 'item')).toHaveLength(5);
    expect(sessionGroup.rows.at(-1)).toMatchObject({ type: 'more', scope: 'session', count: 7 });
    // 已在「最近使用」里的条目不在下面的分组重复出现。
    expect(result.rows.filter(row => row.type === 'item' && row.item.key === 'page:settings')).toHaveLength(1);
  });

  it('empty query in a single scope lists only that kind', () => {
    const result = searchPalette({ items, query: '', scope: 'setting' });
    expect(result.groups.map(group => group.id)).toEqual(['setting']);
  });

  it('orders groups by their best score and caps each group in "all" with a "show all" row', () => {
    const result = searchPalette({ items, query: 'alpha', scope: 'all' });
    // skill「alpha」是全等命中，排在只有前缀命中的会话组前面。
    expect(result.groups.map(group => group.id)).toEqual(['skill', 'session']);
    const sessionGroup = result.groups[1]!;
    expect(sessionGroup.total).toBe(7);
    expect(sessionGroup.rows.at(-1)).toMatchObject({ type: 'more', scope: 'session', count: 7 });
    expect(result.counts).toMatchObject({ all: 8, session: 7, skill: 1, agent: 0, setting: 0 });
  });

  it('a single scope returns every match of that kind and still reports cross-scope counts', () => {
    const result = searchPalette({ items, query: 'alpha', scope: 'session' });
    expect(result.groups.map(group => group.id)).toEqual(['session']);
    expect(result.rows.every(row => row.type === 'item')).toBe(true);
    expect(result.rows).toHaveLength(7);
    expect(result.counts.skill).toBe(1);
  });

  it('groups without a category tab get an in-place expand row instead of being cut off', () => {
    const bots = Array.from({ length: 5 }, (_, i) => item({ key: `bot:${i}`, kind: 'bot', title: `helper bot ${i}` }));
    const capped = searchPalette({ items: bots, query: 'helper', scope: 'all' });
    expect(capped.groups[0]!.rows.at(-1)).toMatchObject({ type: 'more', scope: null, kind: 'bot', count: 5, next: 2 });
    const expanded = searchPalette({ items: bots, query: 'helper', scope: 'all', expanded: expandGroup(new Map(), 'bot') });
    expect(expanded.rows).toHaveLength(5);
    expect(expanded.rows.every(row => row.type === 'item')).toBe(true);
  });

  it('a single category reveals the rest tier by tier (60 → 180 → 600 → all) and the "show more" row ends with the last tier', () => {
    const total = EXPAND_TIERS[2]! + 100;
    const sessions = Array.from({ length: total }, (_, i) => item({ key: `session:${i}`, kind: 'session', title: `deploy job ${i}` }));
    for (const query of ['deploy', '']) {
      let expanded = new Map<PaletteItem['kind'], number>();
      const rows = () => searchPalette({ items: sessions, query, scope: 'session', expanded }).rows;
      const shown = () => rows().filter(row => row.type === 'item').length;
      // 每一档都从同一个常量派生：首屏 SCOPE_RESULT_LIMIT，之后 EXPAND_TIERS 逐档放开。
      expect(EXPAND_TIERS[0]).toBe(SCOPE_RESULT_LIMIT);
      expect(shown()).toBe(EXPAND_TIERS[0]);
      expect(rows().at(-1)).toMatchObject({ type: 'more', scope: null, kind: 'session', count: total, next: EXPAND_TIERS[1]! - EXPAND_TIERS[0]! });
      expanded = expandGroup(expanded, 'session');
      expect(shown()).toBe(EXPAND_TIERS[1]);
      expect(rows().at(-1)).toMatchObject({ type: 'more', next: EXPAND_TIERS[2]! - EXPAND_TIERS[1]! });
      expanded = expandGroup(expanded, 'session');
      expect(shown()).toBe(EXPAND_TIERS[2]);
      expect(rows().at(-1)).toMatchObject({ type: 'more', next: total - EXPAND_TIERS[2]! });
      expanded = expandGroup(expanded, 'session');
      // 最后一档：全部可达，「再显示」行消失。
      expect(rows()).toHaveLength(total);
      expect(rows().every(row => row.type === 'item')).toBe(true);
    }
  });

  it('reports visible and hidden counts that match the rendered rows, with or without a query, in "all" and in a category', () => {
    const sessions = Array.from({ length: SCOPE_RESULT_LIMIT + 5 }, (_, i) => item({ key: `session:${i}`, kind: 'session', title: `alpha session ${i}` }));
    const others = [
      item({ key: 'skill:alpha', kind: 'skill', title: 'alpha' }),
      item({ key: 'action:create', kind: 'action', title: 'Create session' }),
      item({ key: 'page:settings', kind: 'page', title: 'Settings' }),
    ];
    const all = [...sessions, ...others];
    const check = (input: Parameters<typeof searchPalette>[0]) => {
      const result = searchPalette(input);
      const { visible, hidden } = paletteVisibility(result);
      expect(visible).toBe(result.rows.filter(row => row.type === 'item').length);
      return { visible, hidden };
    };
    // 有查询 · 全部：会话组截到 5 条。
    expect(check({ items: all, query: 'alpha', scope: 'all' })).toEqual({ visible: 6, hidden: SCOPE_RESULT_LIMIT });
    // 有查询 · 单一分类：首屏 60 条。
    expect(check({ items: all, query: 'alpha', scope: 'session' })).toEqual({ visible: SCOPE_RESULT_LIMIT, hidden: 5 });
    // 空查询 · 全部：推荐 5 个会话 + 快捷操作 + 页面。
    expect(check({ items: all, query: '', scope: 'all' })).toEqual({ visible: 7, hidden: SCOPE_RESULT_LIMIT });
    // 空查询 · 单一分类且没截断：没有隐藏条目。
    expect(check({ items: all, query: '', scope: 'skill' })).toEqual({ visible: 1, hidden: 0 });
  });

  it('breaks score ties with the item boost (active / recent sessions first)', () => {
    const tied = [
      item({ key: 'session:old', kind: 'session', title: 'build', boost: 0.1 }),
      item({ key: 'session:new', kind: 'session', title: 'build', boost: 0.9 }),
    ];
    const result = searchPalette({ items: tied, query: 'build', scope: 'session' });
    expect(result.rows.map(row => row.type === 'item' && row.item.key)).toEqual(['session:new', 'session:old']);
  });

  it('cycles scopes within the available list', () => {
    expect(nextScope('all', 1)).toBe('session');
    expect(nextScope('all', -1)).toBe('setting');
    expect(nextScope('session', 1, ['all', 'session', 'setting'])).toBe('setting');
    expect(nextScope('skill', 1, ['all', 'session', 'setting'])).toBe('all');
  });
});

describe('command palette model: recent & hotkey', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    };
  }

  it('keeps the most recent keys first, deduped and capped', () => {
    const storage = memoryStorage();
    for (let i = 0; i < PALETTE_RECENT_LIMIT + 2; i++) pushRecentKey(storage, `page:${i}`);
    pushRecentKey(storage, 'page:3');
    const keys = readRecentKeys(storage);
    expect(keys[0]).toBe('page:3');
    expect(keys).toHaveLength(PALETTE_RECENT_LIMIT);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('treats corrupt storage as empty', () => {
    expect(readRecentKeys(memoryStorage({ [PALETTE_RECENT_STORAGE_KEY]: '{oops' }))).toEqual([]);
    expect(readRecentKeys(memoryStorage({ [PALETTE_RECENT_STORAGE_KEY]: '[1,"page:a"]' }))).toEqual(['page:a']);
  });

  it('opens with ⌘K on macOS and Ctrl+K elsewhere, never with Shift / Alt combos', () => {
    const key = (init: Partial<KeyboardEvent>) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
    expect(isPaletteHotkey(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteHotkey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteHotkey(key({ metaKey: true }), false)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteHotkey(key({ ctrlKey: true, key: 'K' }), false)).toBe(true);
  });
});

describe('command palette sources', () => {
  const now = Date.UTC(2026, 9, 21, 12);

  it('suggests sessions waiting on the user first, then active by recency, then closed', () => {
    const rows = [
      { sessionId: 'closed', status: 'closed', lastMessageAt: now },
      { sessionId: 'idle-old', status: 'idle', lastMessageAt: now - 5_000 },
      { sessionId: 'working-new', status: 'working', lastMessageAt: now - 1_000 },
      { sessionId: 'waiting', status: 'idle', lastMessageAt: now - 9_000, agentAttention: { reason: 'needs approval', at: now - 9_000 } },
    ];
    expect(orderSessionsForPalette(rows).map(row => row.sessionId)).toEqual(['waiting', 'working-new', 'idle-old', 'closed']);
  });

  it('opens session details by default; active sessions offer the cockpit, closed ones the Feishu thread', () => {
    const [active, closed, closedNoLink] = buildSessionItems([
      { sessionId: 'a/1', status: 'working', title: '@bot fix login', lastMessageAt: now },
      { sessionId: 'c1', status: 'closed', title: 'old', lastMessageAt: now - 10, feishuThreadLink: 'https://applink.feishu.cn/x' },
      { sessionId: 'c2', status: 'closed', title: 'older', lastMessageAt: now - 20, feishuThreadLink: 'javascript:alert(1)' },
    ], now);
    expect(active!.title).toBe('fix login');
    expect(active!.primary.href).toBe('#/sessions?session=a%2F1');
    expect(active!.secondary).toMatchObject({ href: '#/agent-workbench/a%2F1' });
    expect(closed!.secondary).toMatchObject({ href: 'https://applink.feishu.cn/x', external: true });
    expect(closedNoLink!.secondary).toBeUndefined();
  });

  it('rebuilds only the session rows that changed when given a cache', () => {
    const rows = [
      { sessionId: 'a', status: 'working', title: 'one', lastMessageAt: now },
      { sessionId: 'b', status: 'idle', title: 'two', lastMessageAt: now - 1 },
    ];
    const cache = new WeakMap<object, PaletteItem>();
    const first = buildSessionItems(rows, now, cache);
    const updated = [rows[0]!, { ...rows[1]!, title: 'two renamed' }];
    const second = buildSessionItems(updated, now, cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.title).toBe('two renamed');
  });

  it('every indexed settings key is translated in both locales', () => {
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');
    for (const entry of SETTINGS_SECTIONS) {
      for (const key of [entry.module, entry.section, ...entry.fields]) {
        expect(zh(key), key).not.toBe(key);
        expect(en(key), key).not.toBe(key);
      }
    }
    const items = buildSettingItems();
    expect(items.find(it => it.key === 'setting:settings-maintenance:settings.httpProxy')!.primary.href)
      .toBe('#/settings?section=settings-maintenance&field=settings.httpProxy');
  });

  // 源码结构护栏(K4)：搜索索引的区块 id 要落到 settings-page.tsx 里 SettingsBlock 的 DOM id 上，
  // 深链才滚得过去；区块 JSX 是页面组件内部结构、import 不出来，只能读文本比对。
  it('every indexed settings section is a real block id on the settings page', () => {
    const source = readFileSync(new URL('../src/dashboard/web/settings-page.tsx', import.meta.url), 'utf8');
    for (const entry of SETTINGS_SECTIONS) {
      expect(source, entry.id).toContain(`id="${entry.id}"`);
    }
  });
});

describe('clearHashQueryParam', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('drops one param in place without touching the rest of the hash', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('location', { pathname: '/', search: '?x=1', hash: '#/settings?section=a&field=b' });
    vi.stubGlobal('history', { state: null, replaceState });
    clearHashQueryParam('section');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?x=1#/settings?field=b');
    replaceState.mockClear();
    clearHashQueryParam('missing');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

// ── 面板交互 ─────────────────────────────────────────────────────────────────

describe('CommandPalette interaction', () => {
  const now = Date.now();
  let storageData: Map<string, string>;
  let fakeLocation: { hash: string; href: string };
  let windowKeyListeners: Array<{ fn: (event: any) => void; capture: boolean }>;
  let apiResponses: Record<string, () => Promise<unknown>>;
  const mounted: TestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    storageData = new Map();
    fakeLocation = { hash: '#/', href: 'http://dash.local/#/' };
    vi.stubGlobal('location', fakeLocation);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => { storageData.set(key, value); },
      },
      setTimeout: (fn: () => void) => { fn(); return 0; },
      open: vi.fn(),
      dispatchEvent: vi.fn(),
      addEventListener: (type: string, fn: (event: any) => void, capture?: boolean) => {
        if (type === 'keydown') windowKeyListeners.push({ fn, capture: capture === true });
      },
      removeEventListener: (type: string, fn: (event: any) => void) => {
        if (type === 'keydown') windowKeyListeners = windowKeyListeners.filter(entry => entry.fn !== fn);
      },
    });
    windowKeyListeners = [];
    apiResponses = {
      '/api/skills': async () => ({ skills: [{ name: 'lark-calendar', description: 'Feishu calendar helper' }] }),
      '/api/agents': async () => ({ agents: [{ id: 'reviewer', name: 'Code Reviewer' }], links: {} }),
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = await (apiResponses[url]?.() ?? Promise.resolve({}));
      return { ok: url in apiResponses, json: async () => body };
    }));
    __testOnly_resetPaletteRemoteCache();
    ui.authed = true;
    ui.workbenchAuthed = true;
    store.replaceSnapshot([
      { sessionId: 's-work', status: 'working', title: 'Deploy staging api', lastMessageAt: now - 60_000 },
      { sessionId: 's-wait', status: 'idle', title: 'Review login PR', lastMessageAt: now - 120_000, agentAttention: { reason: 'approve', at: now - 120_000 } },
      { sessionId: 's-closed', status: 'closed', title: 'Old deploy notes', lastMessageAt: now - 86_400_000 },
    ], []);
  });

  afterEach(() => {
    act(() => { for (const r of mounted) r.unmount(); });
    mounted.length = 0;
    vi.unstubAllGlobals();
    ui.authed = true;
  });

  function mount(overrides: Partial<CommandPaletteProps> = {}, contextOverrides: Partial<PaletteShellContext> = {}) {
    const onClose = vi.fn();
    const context: PaletteShellContext = {
      pages: [{ id: 'settings', href: '#/settings', label: '全局设置', labelKey: 'nav.settings' }],
      manageDataReady: true,
      setLocale: vi.fn(),
      openCreateSession: vi.fn(),
      openCreateBot: vi.fn(),
      ...contextOverrides,
    };
    const props = (): CommandPaletteProps => ({ open: true, onClose, context, mac: true, ...overrides });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(CommandPalette, props()));
    });
    mounted.push(renderer);
    const input = () => renderer.root.findByProps({ role: 'combobox' });
    const textOf = (node: TestRenderer.ReactTestInstance | string): string => (
      typeof node === 'string' ? node : node.children.map(textOf).join('')
    );
    const options = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props.role === 'option');
    const activeTitle = () => {
      const active = options().find(node => node.props['aria-selected'] === true);
      return active ? textOf(active.findByProps({ className: 'cmdk-item-title' })) : null;
    };
    const tabs = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props.role === 'tab');
    const selectedTab = () => textOf(tabs().find(node => node.props['aria-selected'] === true)!.children[0]!);
    const type = (value: string) => act(() => { input().props.onChange({ currentTarget: { value } }); });
    const press = (key: string, init: Record<string, unknown> = {}) => {
      const event = {
        key,
        keyCode: 0,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
        ...init,
      };
      act(() => { input().props.onKeyDown(event); });
      return event;
    };
    /** 走 window 上注册的捕获阶段 keydown 监听（面板的 Esc 在那里）。 */
    const pressWindow = (key: string, init: Record<string, unknown> = {}) => {
      const event = { key, keyCode: 0, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init };
      act(() => { for (const entry of windowKeyListeners.filter(item => item.capture)) entry.fn(event); });
      return event;
    };
    const rerender = (contextPatch: Partial<PaletteShellContext> = {}) => {
      Object.assign(context, contextPatch);
      act(() => { renderer.update(createElement(CommandPalette, { ...props(), context: { ...context } })); });
    };
    return { renderer, onClose, context, input, options, activeTitle, tabs, selectedTab, type, press, pressWindow, rerender, textOf };
  }

  it('starts with the session waiting on you selected and walks the list with arrow keys (wrapping)', () => {
    const palette = mount();
    expect(palette.activeTitle()).toBe('Review login PR');
    palette.press('ArrowDown');
    expect(palette.activeTitle()).toBe('Deploy staging api');
    palette.press('ArrowUp');
    palette.press('ArrowUp');
    // 从第一条再往上回绕到最后一条（页面组的最后一项）。
    expect(palette.activeTitle()).toBe('全局设置');
  });

  it('typing filters and highlights; Enter opens session details, ⌘↵ the cockpit', () => {
    const palette = mount();
    palette.type('deploy');
    expect(palette.activeTitle()).toBe('Deploy staging api');
    const marks = palette.renderer.root.findAllByType('mark').map(node => palette.textOf(node));
    expect(marks).toContain('Deploy');
    palette.press('Enter');
    expect(palette.onClose).toHaveBeenCalledTimes(1);
    expect(fakeLocation.hash).toBe('#/sessions?session=s-work');

    const second = mount();
    second.type('deploy');
    second.press('Enter', { metaKey: true });
    expect(fakeLocation.hash).toBe('#/agent-workbench/s-work');
  });

  it('remembers what was opened and shows it under "recent" next time', () => {
    const palette = mount();
    palette.type(copy('settings.sectionAccess'));
    palette.press('Enter');
    expect(fakeLocation.hash).toBe('#/settings?section=settings-access');
    const next = mount();
    expect(next.activeTitle()).toBe(copy('settings.sectionAccess'));
  });

  it('Tab cycles categories, Backspace on an empty query goes back to "all"', () => {
    const palette = mount();
    expect(palette.selectedTab()).toBe(copy('palette.scopeAll'));
    palette.press('Tab');
    expect(palette.selectedTab()).toBe(copy('palette.scopeSession'));
    palette.press('Tab', { shiftKey: true });
    palette.press('Tab', { shiftKey: true });
    expect(palette.selectedTab()).toBe(copy('palette.scopeSetting'));
    palette.press('Backspace');
    expect(palette.selectedTab()).toBe(copy('palette.scopeAll'));
  });

  it('fetches skills and agents when opened and makes them searchable', async () => {
    const palette = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    palette.type('calendar');
    expect(palette.activeTitle()).toBe('lark-calendar');
    palette.press('Enter');
    expect(fakeLocation.hash).toBe('#/skills?skill=lark-calendar');
  });

  it('hides the Skill / Agent categories from visitors without dashboard auth', () => {
    ui.authed = false;
    const palette = mount();
    expect(palette.tabs().map(tab => palette.textOf(tab.children[0]!)))
      .toEqual(['palette.scopeAll', 'palette.scopeSession', 'palette.scopeSetting'].map(key => copy(key)));
  });

  it('ignores Enter while an IME is composing', () => {
    const palette = mount();
    palette.type('deploy');
    palette.press('Enter', { nativeEvent: { isComposing: true } });
    expect(palette.onClose).not.toHaveBeenCalled();
    expect(fakeLocation.hash).toBe('#/');
  });

  it('closes on Escape from the window capture phase, ahead of pages that swallow Escape on document', () => {
    const palette = mount();
    // 输入法组字中的 Esc 属于候选框。
    palette.pressWindow('Escape', { isComposing: true });
    expect(palette.onClose).not.toHaveBeenCalled();
    const event = palette.pressWindow('Escape');
    expect(palette.onClose).toHaveBeenCalledTimes(1);
    // 拦下传播，Skill 库多选态等 document 捕获监听就不会先把 Esc 吃掉。
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('expands groups without a category tab in place, so every match stays reachable', () => {
    const pages = ['角色管理', '群组管理', 'Skill 管理', 'Bot 管理', '插件管理', '团队管理'].map((label, i) => ({
      id: `page-${i}`, href: `#/page-${i}`, label,
    }));
    const palette = mount({}, { pages });
    palette.type('管理');
    const expandLabel = copy('palette.moreExpand', { count: 2, total: 6 });
    const more = palette.options().find(node => palette.textOf(node).includes(expandLabel))!;
    expect(more).toBeDefined();
    act(() => { more.props.onClick(); });
    // 只数这 6 个页面：别的分组（例如 Bot 配置里的配置项）也可能含「管理」。
    expect(palette.options().filter(node => pages.some(page => palette.textOf(node).includes(page.label)))).toHaveLength(6);
    // 选中项落在展开出来的第一条（原先被截掉的第 5 个），而不是跳回顶部。
    expect(palette.activeTitle()).toBe('插件管理');
    expect(palette.selectedTab()).toBe(copy('palette.scopeAll'));
    expect(fakeLocation.hash).toBe('#/');
    // 换了查询，展开针对的是上一组结果，收回去。
    palette.type('管');
    expect(palette.options().some(node => palette.textOf(node).includes(expandLabel))).toBe(true);
  });

  it('waits for the auth state before fetching skills and agents', () => {
    const palette = mount({}, { manageDataReady: false });
    expect(fetch).not.toHaveBeenCalled();
    palette.rerender({ manageDataReady: true });
    expect(fetch).toHaveBeenCalledWith('/api/skills', expect.anything());
  });

  it('backs off briefly after a failed fetch, then retries on a later open', async () => {
    delete apiResponses['/api/skills'];
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const skillCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === '/api/skills').length;
    const reopen = async () => {
      act(() => { for (const r of mounted.splice(0)) r.unmount(); });
      mount();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    };
    try {
      mount();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(skillCalls()).toBe(1);
      // 一路持续失败（例如旧 daemon 没有该接口）时，紧接着反复唤起不该每次都重拉。
      await reopen();
      expect(skillCalls()).toBe(1);
      clock.mockReturnValue(t0 + 6_000);
      await reopen();
      expect(skillCalls()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('re-opening the current page goes through the unsaved-edits guard instead of remounting blindly', () => {
    vi.stubGlobal('HashChangeEvent', class { constructor(readonly type: string) {} });
    fakeLocation.hash = '#/settings';
    const release = setLeaveGuard(() => ({ title: 'Unsaved', message: 'Leave anyway?' }));
    try {
      const guarded = mount();
      guarded.type('全局设置');
      guarded.press('Enter');
      // 确认框还没回答：不能补发 hashchange 重挂载页面（那会丢掉未保存的编辑）。
      expect(window.dispatchEvent).not.toHaveBeenCalled();
    } finally {
      release();
    }
    const free = mount();
    free.type('全局设置');
    free.press('Enter');
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'hashchange' }));
  });

  it('bounds the skill / agent requests with a timeout so loading cannot hang forever', () => {
    mount();
    for (const url of ['/api/skills', '/api/agents']) {
      expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });

  it('shows a loading state instead of "no results" while skills and agents are still loading', () => {
    apiResponses['/api/skills'] = () => new Promise(() => {});
    const palette = mount();
    palette.type('calendar');
    const text = palette.textOf(palette.renderer.root.findByProps({ role: 'listbox' }));
    expect(text).toContain(copy('palette.loading'));
    expect(text).not.toContain(copy('palette.empty', { query: 'calendar' }));
  });

  it('inside a category, "show more" reveals sessions beyond the first page in place', () => {
    const total = SCOPE_RESULT_LIMIT + 5;
    store.replaceSnapshot(Array.from({ length: total }, (_, i) => ({
      sessionId: `many-${i}`, status: 'working', title: `many job ${i}`, lastMessageAt: now - i * 1_000,
    })), []);
    const palette = mount();
    palette.press('Tab');
    expect(palette.selectedTab()).toBe(copy('palette.scopeSession'));
    const moreLabel = copy('palette.moreExpand', { count: 5, total });
    const more = palette.options().find(node => palette.textOf(node).includes(moreLabel))!;
    expect(more).toBeDefined();
    act(() => { more.props.onClick(); });
    expect(palette.options()).toHaveLength(total);
    expect(palette.activeTitle()).toBe(`many job ${SCOPE_RESULT_LIMIT}`);
  });

  it('opens new tabs and external links inside the gesture, before the palette closes (Safari blocks deferred popups)', () => {
    const deferred: Array<() => void> = [];
    (window as any).setTimeout = (fn: () => void) => { deferred.push(fn); return 0; };
    const open = window.open as unknown as ReturnType<typeof vi.fn>;
    const openedBeforeClose = (onClose: ReturnType<typeof vi.fn>) => {
      expect(open).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      expect(open.mock.invocationCallOrder.at(-1)!).toBeLessThan(onClose.mock.invocationCallOrder.at(-1)!);
    };

    // 普通回车：外链（打开文档）。
    const docs = mount();
    docs.type(copy('palette.cmdDocs'));
    docs.press('Enter');
    expect(open).toHaveBeenLastCalledWith('https://deepcoldy.github.io/botmux/', '_blank', 'noopener,noreferrer');
    openedBeforeClose(docs.onClose);

    // ⌘↵：已关闭会话的次要动作是飞书话题外链。
    store.replaceSnapshot([
      { sessionId: 's-old', status: 'closed', title: 'archived chat', lastMessageAt: now - 1_000, feishuThreadLink: 'https://applink.feishu.cn/thread' },
    ], []);
    const closed = mount();
    closed.type('archived chat');
    closed.press('Enter', { metaKey: true });
    expect(open).toHaveBeenLastCalledWith('https://applink.feishu.cn/thread', '_blank', 'noopener,noreferrer');
    openedBeforeClose(closed.onClose);

    // 中键：站内条目在新标签打开。
    const middle = mount();
    middle.type('archived chat');
    const row = middle.options().find(node => node.props['aria-selected'] === true)!;
    act(() => { row.props.onAuxClick({ button: 1 }); });
    expect(open).toHaveBeenLastCalledWith('http://dash.local/#/sessions?session=s-old', '_blank', 'noopener,noreferrer');
    openedBeforeClose(middle.onClose);

    // 以上都不该排进定时器。
    expect(deferred).toHaveLength(0);
  });

  it('still runs in-place actions only after the palette has closed', () => {
    const deferred: Array<() => void> = [];
    (window as any).setTimeout = (fn: () => void) => { deferred.push(fn); return 0; };
    const palette = mount();
    palette.type(copy('nav.createSession'));
    palette.press('Enter');
    expect(palette.onClose).toHaveBeenCalled();
    // 创建会话会再弹一个原生模态框：要等面板的 <dialog> 关掉之后才执行。
    expect(palette.context.openCreateSession).not.toHaveBeenCalled();
    act(() => { for (const fn of deferred.splice(0)) fn(); });
    const openCreate = palette.context.openCreateSession as unknown as ReturnType<typeof vi.fn>;
    expect(openCreate).toHaveBeenCalledTimes(1);
    expect(palette.onClose.mock.invocationCallOrder[0]!).toBeLessThan(openCreate.mock.invocationCallOrder[0]!);
  });

  it('announces visible and remaining rows to screen readers, in Chinese and English', () => {
    const total = SCOPE_RESULT_LIMIT + 5;
    store.replaceSnapshot(Array.from({ length: total }, (_, i) => ({
      sessionId: `sr-${i}`, status: 'working', title: `sr job ${i}`, lastMessageAt: now - i * 1_000,
    })), []);
    const announced = (palette: ReturnType<typeof mount>) => palette.textOf(
      palette.renderer.root.findByProps({ className: 'cmdk-sr-only' }),
    );
    for (const locale of ['zh', 'en'] as const) {
      const tr = createDashboardTranslator(locale);
      vi.stubGlobal('document', { documentElement: {} });
      act(() => { ui.setLocale(locale); });
      try {
        const palette = mount();
        palette.press('Tab');
        // 空查询 · 单一分类被截断：播报可见 / 剩余。
        expect(announced(palette)).toBe(tr('palette.srVisibleHidden', { visible: SCOPE_RESULT_LIMIT, hidden: 5 }));
        const more = palette.options().find(node => palette.textOf(node).includes(tr('palette.moreExpand', { count: 5, total })))!;
        act(() => { more.props.onClick(); });
        // 空查询且已全部展开：不播报。
        expect(announced(palette)).toBe('');
        palette.type('sr job');
        // 有查询：首屏截断时同样播报剩余，展开后只报可见数。
        expect(announced(palette)).toBe(tr('palette.srVisibleHidden', { visible: SCOPE_RESULT_LIMIT, hidden: 5 }));
        const moreQ = palette.options().find(node => palette.textOf(node).includes(tr('palette.moreExpand', { count: 5, total })))!;
        act(() => { moreQ.props.onClick(); });
        expect(announced(palette)).toBe(tr('palette.srVisible', { visible: total }));
      } finally {
        act(() => { ui.setLocale('zh'); });
      }
    }
  });

  it('every new palette string is translated in both locales and fills its placeholders', () => {
    for (const locale of ['zh', 'en'] as const) {
      const tr = createDashboardTranslator(locale);
      const params = { count: 7, total: 65, visible: 60, hidden: 5 };
      for (const key of ['palette.moreExpand', 'palette.srVisible', 'palette.srVisibleHidden']) {
        const text = tr(key, params);
        expect(text, `${locale}:${key}`).not.toBe(key);
        expect(text, `${locale}:${key}`).not.toMatch(/\{\w+\}/);
      }
    }
    expect(createDashboardTranslator('en')('palette.srVisibleHidden', { visible: 60, hidden: 5 }))
      .not.toBe(createDashboardTranslator('zh')('palette.srVisibleHidden', { visible: 60, hidden: 5 }));
  });

  it('"show all" switches to the category instead of navigating', () => {
    store.replaceSnapshot(Array.from({ length: 8 }, (_, i) => ({
      sessionId: `bulk-${i}`, status: 'working', title: `bulk job ${i}`, lastMessageAt: now - i * 1_000,
    })), []);
    const palette = mount();
    palette.type('bulk');
    const more = palette.options().find(node => palette.textOf(node).includes('8'))!;
    act(() => { more.props.onClick(); });
    expect(palette.selectedTab()).toBe(copy('palette.scopeSession'));
    expect(palette.options()).toHaveLength(8);
    expect(fakeLocation.hash).toBe('#/');
  });

  it('refreshes cached session rows once bot names arrive late', async () => {
    store.replaceSnapshot([
      { sessionId: 's-late', status: 'working', title: 'late names', larkAppId: 'cli_late_name', lastMessageAt: now },
    ], []);
    apiResponses['/api/groups?view=names'] = async () => ({ bots: [{ larkAppId: 'cli_late_name', botName: '晚到的名字' }], chats: [] });
    const palette = mount();
    palette.type('late names');
    const subtitle = () => palette.textOf(palette.renderer.root.findAllByProps({ className: 'cmdk-item-sub' })[0]!);
    expect(subtitle()).toContain('cli_late_name');
    await act(async () => { await loadNameMaps(); });
    palette.rerender();
    expect(subtitle()).toContain('晚到的名字');
  });
});
