/**
 * 群组页「普通群 / 会话群」两个视图：
 *  - 工具栏左侧切换取代页面底部的会话群折叠区，当前视图写进地址；
 *  - 两个视图各自记着搜索 / 机器人筛选；
 *  - 会话群行没有「添加 bot」「复制为新群」，默认按最近活跃排序，可改按创建时间。
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderGroupsPage } from '../src/dashboard/web/groups-page.js';
import { __testOnly_resetGroupsSnapshotCache } from '../src/dashboard/web/groups-api.js';
import {
  filterGroupChats,
  formatSessionGroupTime,
  sortSessionGroups,
  type GroupChat,
} from '../src/dashboard/web/groups.js';
import { setHashQueryParam } from '../src/dashboard/web/dashboard-routes.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pageMount = vi.hoisted(() => ({ node: null as unknown }));
vi.mock('../src/dashboard/web/react-mount.js', () => ({
  mountReactPage: (_root: HTMLElement, node: unknown) => { pageMount.node = node; return () => undefined; },
}));
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

const tr = createDashboardTranslator('zh');
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;

type Member = GroupChat['memberBots'][number];
const member = (larkAppId: string, botName: string, inChat = true): Member => ({ larkAppId, botName, inChat });

function sessionChat(chatId: string, name: string, meta?: GroupChat['sessionGroupMeta'], bot = member('cli_a', 'Alpha')): GroupChat {
  return { chatId, name, sessionGroup: true, ...(meta ? { sessionGroupMeta: meta } : {}), memberBots: [bot] };
}

const ROOM: GroupChat = { chatId: 'oc_room', name: 'Room', ownerId: 'cli_a', memberBots: [member('cli_a', 'Alpha'), member('cli_b', 'Beta')] };
// 快照顺序故意 ≠ 最近活跃顺序
const S_OLD = sessionChat('oc_s_old', '整理日志', { createdAt: NOW - 1 * HOUR, lastActiveAt: NOW - 10 * HOUR, sessionId: 'sess-old', sessionStatus: 'closed' });
const S_NEW = sessionChat('oc_s_new', '修复登录', { createdAt: NOW - 30 * HOUR, lastActiveAt: NOW - 1 * HOUR, sessionId: 'sess-new', sessionStatus: 'active' }, member('cli_b', 'Beta'));
const S_NOMETA = sessionChat('oc_s_nometa', '升级依赖');

describe('session-view helpers', () => {
  it('search also matches the names of bots in the chat', () => {
    expect(filterGroupChats([ROOM, S_NEW], { q: 'beta', botId: '' }).map(c => c.chatId)).toEqual(['oc_room', 'oc_s_new']);
    // 不在群的 bot 不算
    const left: GroupChat = { ...ROOM, chatId: 'oc_left', memberBots: [member('cli_a', 'Alpha'), member('cli_b', 'Beta', false)] };
    expect(filterGroupChats([left], { q: 'beta', botId: '' })).toEqual([]);
  });

  it('sorts session chats newest-first by activity or creation; chats without a summary go last in original order', () => {
    const other = sessionChat('oc_s_nometa2', '其它');
    expect(sortSessionGroups([S_NOMETA, S_OLD, other, S_NEW], 'active').map(c => c.chatId))
      .toEqual(['oc_s_new', 'oc_s_old', 'oc_s_nometa', 'oc_s_nometa2']);
    expect(sortSessionGroups([S_NOMETA, S_NEW, S_OLD], 'created').map(c => c.chatId))
      .toEqual(['oc_s_old', 'oc_s_new', 'oc_s_nometa']);
  });

  it('formats times relatively within a week and as a date beyond', () => {
    expect(formatSessionGroupTime(NOW - 20_000, NOW, tr)).toBe('刚刚');
    expect(formatSessionGroupTime(NOW - 5 * 60_000, NOW, tr)).toBe('5 分钟前');
    expect(formatSessionGroupTime(NOW - 3 * HOUR, NOW, tr)).toBe('3 小时前');
    expect(formatSessionGroupTime(NOW - 2 * 24 * HOUR, NOW, tr)).toBe('2 天前');
    const old = new Date(2026, 4, 9, 10).getTime();
    expect(formatSessionGroupTime(old, NOW, tr)).toBe('05-09');
    expect(formatSessionGroupTime(new Date(2025, 11, 31).getTime(), NOW, tr)).toBe('2025-12-31');
    expect(formatSessionGroupTime(undefined, NOW, tr)).toBe('—');
  });
});

describe('setHashQueryParam', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubAddress(hash: string) {
    const replaceState = vi.fn();
    vi.stubGlobal('location', { hash, pathname: '/dash', search: '?t=1' });
    vi.stubGlobal('history', { state: { k: 1 }, replaceState });
    return replaceState;
  }

  it('sets, replaces and removes a parameter without touching the rest of the address', () => {
    let replaceState = stubAddress('#/groups');
    setHashQueryParam('view', 'session');
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/dash?t=1#/groups?view=session');

    replaceState = stubAddress('#/groups?x=1&view=standard');
    setHashQueryParam('view', 'session');
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/dash?t=1#/groups?x=1&view=session');

    replaceState = stubAddress('#/groups?view=session');
    setHashQueryParam('view', null);
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/dash?t=1#/groups');
  });

  it('does nothing when there is no hash route to write into', () => {
    const replaceState = stubAddress('');
    setHashQueryParam('view', 'session');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('GroupsPage — standard / session views', () => {
  let replaceState: ReturnType<typeof vi.fn>;

  function stubPage(hash = '#/groups') {
    __testOnly_resetGroupsSnapshotCache();
    replaceState = vi.fn();
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } });
    vi.stubGlobal('location', { hash, pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/groups') {
        return { ok: true, status: 200, json: async () => ({
          bots: [{ larkAppId: 'cli_a', botName: 'Alpha' }, { larkAppId: 'cli_b', botName: 'Beta' }],
          chats: [S_OLD, ROOM, S_NOMETA, S_NEW],
        }) };
      }
      throw new Error(`unexpected ${url}`);
    }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(): Promise<TestRenderer.ReactTestRenderer> {
    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(pageMount.node as React.ReactElement); });
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(renderer.root.findAll(node => node.type === 'li' && node.props['data-chat']).length).toBeGreaterThan(0);
    });
    return renderer;
  }

  const rowIds = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAll(node => node.type === 'li' && typeof node.props['data-chat'] === 'string').map(node => node.props['data-chat']);
  const viewButton = (renderer: TestRenderer.ReactTestRenderer, view: string) =>
    renderer.root.find(node => node.type === 'button' && node.props['data-group-view'] === view);
  const searchInput = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findByProps({ name: 'q' });
  const typeSearch = (renderer: TestRenderer.ReactTestRenderer, value: string) =>
    act(() => { searchInput(renderer).props.onChange({ currentTarget: { value } }); });

  it('replaces the bottom section with a view switch; session rows drop add-bots / duplicate and sort by recent activity', async () => {
    stubPage();
    const renderer = await mount();

    expect(renderer.root.findAll(node => node.props['data-session-groups'] !== undefined)).toHaveLength(0);
    expect(rowIds(renderer)).toEqual(['oc_room']);
    expect(viewButton(renderer, 'standard').props['aria-pressed']).toBe(true);
    expect(viewButton(renderer, 'session').findByType('small').children.join('')).toBe('3');

    act(() => { viewButton(renderer, 'session').props.onClick(); });
    expect(rowIds(renderer)).toEqual(['oc_s_new', 'oc_s_old', 'oc_s_nometa']);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/#/groups?view=session');

    const sessionRows = renderer.root.findAll(node => node.type === 'li' && typeof node.props['data-chat'] === 'string');
    for (const row of sessionRows) {
      const classes = row.findAll(node => typeof node.props.className === 'string').map(node => node.props.className as string);
      expect(classes.some(name => name.includes('add-bots'))).toBe(false);
      expect(classes.some(name => name.includes('clone-chat'))).toBe(false);
      expect(classes.some(name => name.includes('manage-chat'))).toBe(true);
    }
    const newest = sessionRows[0];
    expect(newest.findByProps({ 'data-session-state': 'active' })).toBeTruthy();
    expect(newest.find(node => node.type === 'a' && String(node.props.className).includes('open-session')).props.href)
      .toBe('#/sessions?session=sess-new');
    expect(newest.findByProps({ 'data-session-active-at': true }).children.join('')).toBe('最近活跃 1 小时前');

    // 拿不到摘要的会话群：不渲染状态徽标，也没有「查看会话」入口
    const noMetaRow = sessionRows.find(r => r.props['data-chat'] === 'oc_s_nometa')!;
    expect(noMetaRow.findAll(node => node.props['data-session-state'] !== undefined)).toHaveLength(0);
    expect(noMetaRow.findAll(node => node.type === 'a' && String(node.props.className).includes('open-session'))).toHaveLength(0);

    act(() => { renderer.root.findByProps({ className: 'groups-session-sort' }).props.onChange('created'); });
    expect(rowIds(renderer)).toEqual(['oc_s_old', 'oc_s_new', 'oc_s_nometa']);

    act(() => { viewButton(renderer, 'standard').props.onClick(); });
    expect(rowIds(renderer)).toEqual(['oc_room']);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/#/groups');
    act(() => renderer.unmount());
  });

  it('keeps each view\'s own search', async () => {
    stubPage();
    const renderer = await mount();
    typeSearch(renderer, 'Room');
    act(() => { viewButton(renderer, 'session').props.onClick(); });
    expect(searchInput(renderer).props.value).toBe('');
    typeSearch(renderer, '日志');
    expect(rowIds(renderer)).toEqual(['oc_s_old']);

    act(() => { viewButton(renderer, 'standard').props.onClick(); });
    expect(searchInput(renderer).props.value).toBe('Room');
    expect(rowIds(renderer)).toEqual(['oc_room']);
    act(() => { viewButton(renderer, 'session').props.onClick(); });
    expect(searchInput(renderer).props.value).toBe('日志');
    expect(rowIds(renderer)).toEqual(['oc_s_old']);
    act(() => renderer.unmount());
  });

  it('opens on the session view when the address asks for it', async () => {
    stubPage('#/groups?view=session');
    const renderer = await mount();
    expect(viewButton(renderer, 'session').props['aria-pressed']).toBe(true);
    expect(rowIds(renderer)).toEqual(['oc_s_new', 'oc_s_old', 'oc_s_nometa']);
    act(() => renderer.unmount());
  });

  it('switches back to the standard view after creating a chat while on the session view', async () => {
    stubPage();
    const renderer = await mount();
    act(() => { viewButton(renderer, 'session').props.onClick(); });
    expect(viewButton(renderer, 'session').props['aria-pressed']).toBe(true);

    // 新建群聊对话框提交成功（新群总是普通群，留在会话群视图里看不到它）
    const dialogHost = renderer.root.findAll(node => typeof node.props?.onCreated === 'function')[0];
    act(() => { dialogHost.props.onCreated({ chatId: 'oc_new_2661' }, ['cli_a'], '新群'); });
    expect(viewButton(renderer, 'standard').props['aria-pressed']).toBe(true);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/#/groups');
    act(() => renderer.unmount());
  });

  it('resets the current view to page 1 when searching from a later page', async () => {
    __testOnly_resetGroupsSnapshotCache();
    // 35 个会话群、名字都含「批量」，搜索后仍是 2 页——这是页码重置唯一可见的场景
    const many: GroupChat[] = Array.from({ length: 35 }, (_, i) =>
      sessionChat(`oc_m_${i}`, `批量群 ${i}`, { createdAt: NOW - i * HOUR, lastActiveAt: NOW - i * HOUR, sessionId: `sess-m-${i}`, sessionStatus: 'active' }));
    replaceState = vi.fn();
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } });
    vi.stubGlobal('location', { hash: '#/groups?view=session', pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ bots: [{ larkAppId: 'cli_a', botName: 'Alpha' }], chats: many }),
    })));

    const renderer = await mount();
    expect(viewButton(renderer, 'session').props['aria-pressed']).toBe(true);
    expect(rowIds(renderer)).toHaveLength(30);
    const nextPage = renderer.root.find(node =>
      node.type === 'button' && Array.isArray(node.children) && node.children.join('') === '下一页');
    act(() => { nextPage.props.onClick(); });
    expect(rowIds(renderer)[0]).toBe('oc_m_30');

    typeSearch(renderer, '批量');
    expect(rowIds(renderer)).toHaveLength(30);
    expect(rowIds(renderer)[0]).toBe('oc_m_0');
    act(() => renderer.unmount());
  });
});
