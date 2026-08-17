import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_GROUP_DIMENSIONS,
  WORKBENCH_RAIL_DEFAULT,
  attentionSummary,
  buildWorkbenchHash,
  classifyWorkbenchSession,
  computeVirtualWindow,
  defaultWorkbenchLayout,
  deriveResponsiveWorkbenchLayout,
  flattenWorkbenchGroups,
  formatWorkbenchRelativeTime,
  groupWorkbenchSessions,
  groupWorkbenchSessionsForDimension,
  isValidPaneTree,
  isWorkbenchGroupDimension,
  normalizeWorkbenchLayout,
  paneTreeForLayout,
  parseWorkbenchHash,
  safeWorkbenchReturnTo,
  workbenchExternalTerminalHref,
  workbenchListItemHeight,
  workbenchPreviewHref,
  workbenchSessionKind,
  workbenchTerminalHref,
  type WorkbenchGroupDimension,
  type WorkbenchListItem,
  type WorkbenchSessionRow,
} from '../src/dashboard/web/agent-workbench-model.js';

function session(index: number, patch: Partial<WorkbenchSessionRow> = {}): WorkbenchSessionRow {
  return {
    sessionId: `session-${index}`,
    status: 'working',
    title: `Complete searchable title ${index}`,
    botName: index % 2 ? 'Reviewer' : 'Builder',
    cliId: 'codex',
    lastMessageAt: 1_700_000_000_000 + index,
    ...patch,
  };
}

describe('Agent Workbench pure model', () => {
  it('builds and parses independent main/Dock routes without catching malformed ids', () => {
    expect(buildWorkbenchHash('main', 'a/b c')).toBe('#/agent-workbench/a%2Fb%20c');
    expect(buildWorkbenchHash('dock', 'a/b c')).toBe('#/agent-workbench-dock/a%2Fb%20c');
    expect(parseWorkbenchHash('#/agent-workbench/a%2Fb%20c')).toEqual({ surface: 'main', sessionId: 'a/b c' });
    expect(parseWorkbenchHash('#/agent-workbench-dock/a%2Fb%20c')).toEqual({ surface: 'dock', sessionId: 'a/b c' });
    expect(parseWorkbenchHash('#/agent-workbench/%E0%A4%A')).toBeNull();
    expect(safeWorkbenchReturnTo('/#/agent-workbench-dock/a%2Fb')).toBe('/#/agent-workbench-dock/a%2Fb');
    expect(safeWorkbenchReturnTo('/#/settings')).toBe('/');
  });

  it('keeps a 200px default rail, clamps persistence, and limits the pane tree to Terminal/Web', () => {
    const defaults = defaultWorkbenchLayout();
    expect(defaults.railWidth).toBe(WORKBENCH_RAIL_DEFAULT);
    expect(normalizeWorkbenchLayout({ railWidth: 2, splitRatio: 99, focus: 'chat', paneMode: 'split' })).toMatchObject({
      railWidth: 176,
      splitRatio: 0.72,
      focus: 'terminal',
      paneMode: 'split',
    });
    const tree = paneTreeForLayout({ ...defaults, paneMode: 'split', splitAxis: 'vertical' });
    expect(isValidPaneTree(tree)).toBe(true);
    expect(JSON.stringify(tree)).toContain('terminal');
    expect(JSON.stringify(tree)).toContain('web');
    expect(JSON.stringify(tree)).not.toContain('chat');
    expect(JSON.stringify(tree)).not.toContain('info');
    expect(isValidPaneTree({ type: 'pane', pane: 'chat' })).toBe(false);
    expect(isValidPaneTree({ type: 'pane', pane: 'info' })).toBe(false);
  });

  it('applies the ordered 1280px degradation and fixed mobile stack', () => {
    const requested = { ...defaultWorkbenchLayout(), paneMode: 'split' as const, chatRequested: true };
    expect(deriveResponsiveWorkbenchLayout(1440, requested)).toMatchObject({ step: 'full', railCollapsed: false, paneMode: 'split', chatMode: 'native-split' });
    // Width degrades chat mode and pane splitting, but never collapses the rail
    // on the user's behalf — the session list is the primary surface, and
    // auto-collapsing left narrow windows showing only an expand handle.
    expect(deriveResponsiveWorkbenchLayout(1279, requested)).toMatchObject({ step: 'rail-collapsed', railCollapsed: false, paneMode: 'split', chatMode: 'native-split' });
    expect(deriveResponsiveWorkbenchLayout(1119, requested)).toMatchObject({ step: 'focus', railCollapsed: false, paneMode: 'focus', chatMode: 'native-split' });
    expect(deriveResponsiveWorkbenchLayout(959, requested)).toMatchObject({ step: 'chat-jump', railCollapsed: false, paneMode: 'focus', chatMode: 'jump' });
    expect(deriveResponsiveWorkbenchLayout(700, { ...requested, railCollapsed: true }))
      .toMatchObject({ railCollapsed: true });
    expect(deriveResponsiveWorkbenchLayout(610, requested)).toEqual({ mode: 'mobile', step: 'mobile-stack', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' });
  });

  it('groups NEEDS YOU / ACTIVE / RECENT with reason summaries and full-text search', () => {
    const rows = [
      session(1, { agentAttention: { reason: 'Approve migration', at: 1_800_000_000_030 } }),
      session(2, { pendingRepo: true }),
      session(3),
      session(4, { status: 'dormant' }),
      session(5, { status: 'closed' }),
    ];
    const groups = groupWorkbenchSessions(rows);
    expect(groups['needs-you'].map(row => row.sessionId)).toEqual(['session-1', 'session-2']);
    expect(groups.active.map(row => row.sessionId)).toEqual(['session-3']);
    expect(groups.recent.map(row => row.sessionId)).toEqual(['session-5', 'session-4']);
    expect(attentionSummary(rows[0])).toBe('Approve migration');
    expect(classifyWorkbenchSession(rows[4])).toBe('recent');
    expect(groupWorkbenchSessions(rows, 'searchable title 4').recent.map(row => row.sessionId)).toEqual(['session-4']);
    expect(flattenWorkbenchGroups(groups).filter(item => item.kind === 'header')).toHaveLength(3);
  });

  it('derives the session-kind badge from chatType/scope, and stays silent when neither is known', () => {
    // p2p 先于 scope 判定：单聊里开的话题仍然标「单聊」。反过来标成「话题」会
    // 让用户以为有个群可以回跳，而单聊根本没有话题锚点。
    expect(workbenchSessionKind(session(1, { chatType: 'p2p', scope: 'thread' }))).toBe('p2p');
    expect(workbenchSessionKind(session(2, { chatType: 'p2p', scope: 'chat' }))).toBe('p2p');
    expect(workbenchSessionKind(session(3, { chatType: 'p2p' }))).toBe('p2p');
    // 话题会话：只有这一类会拿到定位按钮，见 components 测试。
    expect(workbenchSessionKind(session(4, { chatType: 'group', scope: 'thread' }))).toBe('thread');
    expect(workbenchSessionKind(session(5, { scope: 'thread' }))).toBe('thread');
    // 群会话（整群 chat scope）标「群」，但不给定位。
    expect(workbenchSessionKind(session(6, { chatType: 'group', scope: 'chat' }))).toBe('group');
    expect(workbenchSessionKind(session(7, { scope: 'chat' }))).toBe('group');
    // 缺失分支：旧 daemon 只给了 chatType 或什么都没给，两者都推不出会话类型。
    // 这里必须是 null 而不是兜底猜一个，否则界面会稳定地显示一个错标签。
    expect(workbenchSessionKind(session(8))).toBeNull();
    expect(workbenchSessionKind(session(9, { chatType: 'group' }))).toBeNull();
    expect(workbenchSessionKind(session(10, { scope: undefined, chatType: undefined }))).toBeNull();
  });

  it('windows 300+ sessions to a bounded render slice', () => {
    const rows = Array.from({ length: 320 }, (_, index) => session(index));
    const items = flattenWorkbenchGroups(groupWorkbenchSessions(rows));
    const window = computeVirtualWindow(items, 8_000, 640);
    expect(items.length).toBe(323);
    // 精确值而不是「大于某个数」：总高度是 3 个组头 + 320 行的桌面行高，
    // 和 style.css 的 `.wb-session-row { height: 54px }` 是同一份契约，
    // 改行高必须同时改这里和 CSS，虚拟滚动才不会滚过自己的末尾。
    expect(window.totalHeight).toBe(3 * 30 + 320 * 54);
    expect(window.end - window.start).toBeLessThan(24);
    expect(window.start).toBeGreaterThan(100);
  });

  it('formats relative times and keeps terminal URLs on the signed same-origin front proxy', () => {
    const now = 10_000_000;
    expect(formatWorkbenchRelativeTime(now, now + 10, 'en')).toBe('just now');
    expect(formatWorkbenchRelativeTime(now - 3_600_000, now, 'en')).toContain('hr');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000, proxyPort: 8080 }),
      { protocol: 'https:', origin: 'https://dashboard.example', hostname: 'dashboard.example' },
    )).toBe('https://dashboard.example/s/session-1');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000, proxyPort: 8080 }),
      { protocol: 'http:', origin: 'http://dashboard.local:24000', hostname: 'dashboard.local' },
    )).toBe('http://dashboard.local:24000/s/session-1');
    expect(workbenchTerminalHref(
      session(1, { webPort: 9000 }),
      { protocol: 'http:', origin: 'http://dashboard.local:24000', hostname: 'dashboard.local' },
    )).toBeNull();
    expect(workbenchExternalTerminalHref(session(1, { riffAccessUrl: 'javascript:alert(1)' }))).toBeNull();
    expect(workbenchPreviewHref(session(1, {
      preview: { path: '/preview/session-2/', registeredAt: new Date().toISOString() },
    }))).toBeNull();
    expect(workbenchPreviewHref(session(1, {
      preview: { path: '/preview/session-1/', registeredAt: new Date().toISOString() },
    }))).toBe('/preview/session-1/');
  });
});

/** 本地时区的某天正午。时间分桶按本地零点切，写死 epoch 毫秒会在别的时区翻车。 */
function localNoon(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day, 12, 0, 0, 0).getTime();
}

/** 本地时区的某天零点，用来精确压边界。 */
function localMidnight(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day, 0, 0, 0, 0).getTime();
}

function keysOf(groups: readonly { key: string }[]): string[] {
  return groups.map(group => group.key);
}

function labelsOf(groups: readonly { label: string }[]): string[] {
  return groups.map(group => group.label);
}

function idsIn(groups: readonly { key: string; sessions: WorkbenchSessionRow[] }[], key: string): string[] {
  return (groups.find(group => group.key === key)?.sessions ?? []).map(row => row.sessionId);
}

describe('Agent Workbench 六维分组', () => {
  it('status 维度沿用旧三组语义，并且空桶不产出组头', () => {
    const rows = [
      session(1, { agentAttention: { reason: '等你拍板', at: 1_800_000_000_030 } }),
      session(2),
      session(3, { status: 'closed' }),
      session(4, { status: 'dormant' }),
    ];
    const groups = groupWorkbenchSessionsForDimension(rows, { dimension: 'status' });
    expect(keysOf(groups)).toEqual(['needs-you', 'active', 'recent']);
    expect(labelsOf(groups)).toEqual(['待你处理', '进行中', '最近']);
    expect(groups[0].kind).toBe('needs-you');
    expect(groups.slice(1).map(group => group.kind)).toEqual(['plain', 'plain']);
    expect(idsIn(groups, 'active')).toEqual(['session-2']);
    // 组内按最新活跃降序：dormant(…004) 比 closed(…003) 新。
    expect(idsIn(groups, 'recent')).toEqual(['session-4', 'session-3']);

    // 没有待处理的会话时，「待你处理」整组消失，而不是留一个 0 的组头。
    const calm = groupWorkbenchSessionsForDimension([session(2)], { dimension: 'status' });
    expect(keysOf(calm)).toEqual(['active']);

    // 白名单外的维度回落到 status，而不是产出一堆 undefined 组。
    const bogus = groupWorkbenchSessionsForDimension(rows, { dimension: 'repo' as WorkbenchGroupDimension });
    expect(keysOf(bogus)).toEqual(keysOf(groups));
  });

  it('bot / chat / cli 三个自由文本维度按最新活跃排组，缺字段落到兜底组名', () => {
    const rows = [
      session(1, { botName: 'Reviewer', cliId: 'claude', chatDisplayName: '前端群', lastMessageAt: 300 }),
      session(2, { botName: 'Builder', cliId: 'codex', chatDisplayName: '后端群', lastMessageAt: 900 }),
      session(3, { botName: 'Builder', cliId: 'codex', chatDisplayName: '后端群', lastMessageAt: 100 }),
      session(4, { botName: '   ', cliId: '', chatDisplayName: '', lastMessageAt: 50 }),
    ];

    const byBot = groupWorkbenchSessionsForDimension(rows, { dimension: 'bot' });
    // 组间顺序 = 组里最新那条的时间：Builder(900) > Reviewer(300) > 兜底(50)。
    expect(keysOf(byBot)).toEqual(['bot:Builder', 'bot:Reviewer', 'bot:未知机器人']);
    expect(labelsOf(byBot)).toEqual(['Builder', 'Reviewer', '未知机器人']);
    expect(idsIn(byBot, 'bot:Builder')).toEqual(['session-2', 'session-3']);
    expect(byBot.every(group => group.kind === 'plain')).toBe(true);

    const byChat = groupWorkbenchSessionsForDimension(rows, { dimension: 'chat' });
    expect(keysOf(byChat)).toEqual(['chat:后端群', 'chat:前端群', 'chat:未知会话']);
    expect(idsIn(byChat, 'chat:未知会话')).toEqual(['session-4']);

    const byCli = groupWorkbenchSessionsForDimension(rows, { dimension: 'cli' });
    expect(keysOf(byCli)).toEqual(['cli:codex', 'cli:claude', 'cli:unknown']);
    expect(idsIn(byCli, 'cli:claude')).toEqual(['session-1']);

    // 组 key 一律带维度前缀：真有个机器人叫 active，也不会和保留 key 串组。
    expect(keysOf(groupWorkbenchSessionsForDimension([session(9, { botName: 'active' })], { dimension: 'bot' })))
      .toEqual(['bot:active']);

    // 搜索过滤在任何维度下都照旧生效。
    expect(idsIn(
      groupWorkbenchSessionsForDimension(rows, { dimension: 'bot', query: 'searchable title 2' }),
      'bot:Builder',
    )).toEqual(['session-2']);
  });

  it('kind 维度按 话题/群/单聊/其他 的固定语义顺序分组，不看活跃时间', () => {
    const rows = [
      session(1, { chatType: 'p2p' }),
      session(2, { chatType: 'group', scope: 'chat' }),
      session(3, { chatType: 'group', scope: 'thread' }),
      // 最新的一条（…004），但推不出会话类型，仍然排在最后的「其他」。
      session(4),
    ];
    const groups = groupWorkbenchSessionsForDimension(rows, { dimension: 'kind' });
    expect(keysOf(groups)).toEqual(['kind:话题', 'kind:群', 'kind:单聊', 'kind:其他']);
    expect(labelsOf(groups)).toEqual(['话题', '群', '单聊', '其他']);
    expect(idsIn(groups, 'kind:话题')).toEqual(['session-3']);
    expect(idsIn(groups, 'kind:其他')).toEqual(['session-4']);
  });

  it('time 维度用调用方给的 now 切 今天/昨天/本周/更早', () => {
    const now = localNoon(2026, 0, 15);
    const rows = [
      session(1, { lastMessageAt: now - 60_000 }),
      session(2, { lastMessageAt: localNoon(2026, 0, 14) }),
      session(3, { lastMessageAt: localNoon(2026, 0, 10) }),
      session(4, { lastMessageAt: localNoon(2025, 11, 20) }),
      // 一个时间字段都没有的会话不该凭空落进「今天」。
      session(5, { lastMessageAt: undefined }),
    ];
    const groups = groupWorkbenchSessionsForDimension(rows, { dimension: 'time', now });
    expect(keysOf(groups)).toEqual(['time:今天', 'time:昨天', 'time:本周', 'time:更早']);
    expect(idsIn(groups, 'time:今天')).toEqual(['session-1']);
    expect(idsIn(groups, 'time:昨天')).toEqual(['session-2']);
    expect(idsIn(groups, 'time:本周')).toEqual(['session-3']);
    expect(idsIn(groups, 'time:更早')).toEqual(['session-4', 'session-5']);

    // 边界压在本地零点上：今天从零点整开始，「本周」= 含今天在内的最近 7 个自然日。
    const startOfToday = localMidnight(2026, 0, 15);
    const startOfWeek = localMidnight(2026, 0, 9);
    const edges = groupWorkbenchSessionsForDimension([
      session(11, { lastMessageAt: startOfToday }),
      session(12, { lastMessageAt: startOfToday - 1 }),
      session(13, { lastMessageAt: startOfWeek }),
      session(14, { lastMessageAt: startOfWeek - 1 }),
    ], { dimension: 'time', now });
    expect(idsIn(edges, 'time:今天')).toEqual(['session-11']);
    expect(idsIn(edges, 'time:昨天')).toEqual(['session-12']);
    expect(idsIn(edges, 'time:本周')).toEqual(['session-13']);
    expect(idsIn(edges, 'time:更早')).toEqual(['session-14']);

    // 分桶完全由传进来的 now 决定：把 now 推后一天，同一批会话整体后移一格。
    const tomorrow = groupWorkbenchSessionsForDimension(rows, { dimension: 'time', now: localNoon(2026, 0, 16) });
    expect(idsIn(tomorrow, 'time:今天')).toEqual([]);
    expect(idsIn(tomorrow, 'time:昨天')).toEqual(['session-1']);
    expect(idsIn(tomorrow, 'time:本周')).toEqual(['session-2', 'session-3']);
  });

  it('unreadIds 并入「待你处理」并置顶，已关闭的会话除外', () => {
    const rows = [
      session(1),
      session(2),
      session(3, { status: 'closed' }),
      session(4, { agentAttention: { reason: '等你拍板', at: 1_800_000_000_000 } }),
    ];
    const unreadIds = new Set(['session-2', 'session-3']);
    const groups = groupWorkbenchSessionsForDimension(rows, { dimension: 'bot', unreadIds });

    expect(groups[0].key).toBe('needs-you');
    expect(groups[0].kind).toBe('needs-you');
    expect(groups[0].label).toBe('待你处理');
    // attention(…000 最新) 在前，纯未读的 session-2 在后。
    expect(idsIn(groups, 'needs-you')).toEqual(['session-4', 'session-2']);
    // 已关闭的会话不会再有新回复：标了未读也不许被抽上来，否则蓝点和分组自相矛盾。
    expect(idsIn(groups, 'needs-you')).not.toContain('session-3');
    // 它照常待在自己的 bot 桶里（session-1/3 都是 Reviewer），按活跃时间降序。
    expect(idsIn(groups, 'bot:Reviewer')).toEqual(['session-3', 'session-1']);

    // 不传 unreadIds 时只有 attention 会话进「待你处理」——旧调用行为不变。
    expect(idsIn(groupWorkbenchSessionsForDimension(rows, { dimension: 'bot' }), 'needs-you'))
      .toEqual(['session-4']);

    // 六个维度都认未读，且「待你处理」永远是第一组。
    for (const option of WORKBENCH_GROUP_DIMENSIONS) {
      const perDimension = groupWorkbenchSessionsForDimension(rows, { dimension: option.value, unreadIds });
      expect(perDimension[0].key, option.value).toBe('needs-you');
      expect(idsIn(perDimension, 'needs-you'), option.value).toEqual(['session-4', 'session-2']);
    }
    expect(WORKBENCH_GROUP_DIMENSIONS.map(option => option.value))
      .toEqual(['status', 'bot', 'chat', 'kind', 'cli', 'time']);
    expect(WORKBENCH_GROUP_DIMENSIONS.every(option => isWorkbenchGroupDimension(option.value))).toBe(true);
    for (const bad of ['repo', '', 'STATUS', null, 42, ['bot']]) {
      expect(isWorkbenchGroupDimension(bad), String(bad)).toBe(false);
    }
  });

  it('拍平动态组时组头带 groupKey，行前状态点仍跟会话自己的状态走', () => {
    const rows = [
      session(1, { agentAttention: { reason: '等你拍板', at: 1_800_000_000_000 } }),
      session(3, { status: 'closed' }),
    ];
    const items = flattenWorkbenchGroups(groupWorkbenchSessionsForDimension(rows, { dimension: 'bot' }));
    const headers = items.filter(item => item.kind === 'header');
    expect(headers.map(item => item.groupKey)).toEqual(['needs-you', 'bot:Reviewer']);
    expect(headers.map(item => item.isNeedsYou)).toEqual([true, false]);
    expect(headers.map(item => item.count)).toEqual([1, 1]);

    const closedRow = items.find(item => item.kind === 'session' && item.session.sessionId === 'session-3')!;
    // 它待在 bot 桶里，但行前的点按它自己的状态画成「最近」，而不是按所在桶。
    expect(closedRow.groupKey).toBe('bot:Reviewer');
    expect(closedRow.group).toBe('recent');
    expect(closedRow.isNeedsYou).toBe(false);
    // 旧的三组记录仍然能拍平，dock 和老脚本的调用不受影响。
    expect(flattenWorkbenchGroups(groupWorkbenchSessions(rows)).filter(item => item.kind === 'header'))
      .toHaveLength(3);
  });
});

/** 拍平结果里某一组名下的会话 id。折叠掉的组在这里天然是空的。 */
function idsUnder(items: readonly WorkbenchListItem[], groupKey: string): string[] {
  return items
    .filter(item => item.kind === 'session' && item.groupKey === groupKey)
    .map(item => (item as Extract<WorkbenchListItem, { kind: 'session' }>).session.sessionId);
}

function headersOf(items: readonly WorkbenchListItem[]): Extract<WorkbenchListItem, { kind: 'header' }>[] {
  return items.filter((item): item is Extract<WorkbenchListItem, { kind: 'header' }> => item.kind === 'header');
}

describe('Agent Workbench 分组折叠', () => {
  const rows = [
    session(1, { botName: 'Builder', lastMessageAt: 900 }),
    session(2, { botName: 'Builder', lastMessageAt: 800 }),
    session(3, { botName: 'Reviewer', lastMessageAt: 700 }),
  ];
  const groups = groupWorkbenchSessionsForDimension(rows, { dimension: 'bot' });

  it('折叠的组只留组头，组头上的 count 仍是折叠前的真实条数', () => {
    const items = flattenWorkbenchGroups(groups, new Set(['bot:Builder']));
    // 组头一个不少：折叠是把行藏起来，不是把组删掉——否则用户没地方点回来。
    expect(headersOf(items).map(item => item.groupKey)).toEqual(['bot:Builder', 'bot:Reviewer']);
    expect(headersOf(items).map(item => item.collapsed)).toEqual([true, false]);
    // count 说的是「这组里有几个会话」，折起来也不变，收起时才看得出还压着多少东西。
    expect(headersOf(items).map(item => item.count)).toEqual([2, 1]);
    // 折叠组的会话行一条都不在列表里，这正是虚拟滚动能把高度缩回去的原因。
    expect(idsUnder(items, 'bot:Builder')).toEqual([]);
    expect(idsUnder(items, 'bot:Reviewer')).toEqual(['session-3']);
    expect(items).toHaveLength(3);
  });

  it('不传折叠集合时行为和以前完全一致，未知 key 不影响任何组', () => {
    for (const collapsed of [undefined, new Set<string>(), new Set(['bot:GoneBot', 'cli:codex', 'active'])]) {
      const items = flattenWorkbenchGroups(groups, collapsed);
      // collapsed 字段一直有，只是全为 false —— 组头渲染时靠它决定 aria-expanded。
      expect(headersOf(items).every(item => item.collapsed === false)).toBe(true);
      expect(idsUnder(items, 'bot:Builder')).toEqual(['session-1', 'session-2']);
      expect(idsUnder(items, 'bot:Reviewer')).toEqual(['session-3']);
    }
  });

  it('每个组都能单独折叠，全折叠后列表只剩组头', () => {
    const onlyReviewer = flattenWorkbenchGroups(groups, new Set(['bot:Reviewer']));
    expect(idsUnder(onlyReviewer, 'bot:Builder')).toEqual(['session-1', 'session-2']);
    expect(idsUnder(onlyReviewer, 'bot:Reviewer')).toEqual([]);
    expect(headersOf(onlyReviewer).map(item => item.collapsed)).toEqual([false, true]);

    const all = flattenWorkbenchGroups(groups, new Set(['bot:Builder', 'bot:Reviewer']));
    expect(all.every(item => item.kind === 'header')).toBe(true);
    expect(all).toHaveLength(2);
  });

  it('置顶的「待你处理」和旧三组记录一样能折叠，dock 的老调用形态也认', () => {
    const attention = [
      session(4, { agentAttention: { reason: '等你拍板', at: 1_800_000_000_000 } }),
      session(5),
      session(6, { status: 'closed' }),
    ];
    const dynamic = flattenWorkbenchGroups(
      groupWorkbenchSessionsForDimension(attention, { dimension: 'bot' }),
      new Set(['needs-you']),
    );
    expect(headersOf(dynamic)[0]).toMatchObject({ groupKey: 'needs-you', collapsed: true, count: 1 });
    expect(idsUnder(dynamic, 'needs-you')).toEqual([]);

    // dock 和老脚本传的是三组记录，同一个折叠集合照样生效。
    const legacy = flattenWorkbenchGroups(groupWorkbenchSessions(attention), new Set(['recent']));
    expect(headersOf(legacy).map(item => item.groupKey)).toEqual(['needs-you', 'active', 'recent']);
    expect(headersOf(legacy).map(item => item.collapsed)).toEqual([false, false, true]);
    expect(idsUnder(legacy, 'recent')).toEqual([]);
    expect(idsUnder(legacy, 'active')).toEqual(['session-5']);
  });

  it('折叠掉的会话不占虚拟滚动的高度', () => {
    const many = Array.from({ length: 40 }, (_, index) => session(index, { botName: 'Builder' }));
    const byBot = groupWorkbenchSessionsForDimension(many, { dimension: 'bot' });
    const open = computeVirtualWindow(flattenWorkbenchGroups(byBot), 0, 640);
    const shut = computeVirtualWindow(flattenWorkbenchGroups(byBot, new Set(['bot:Builder'])), 0, 640);
    expect(open.totalHeight).toBe(30 + 40 * 54);
    // 折起来只剩一个组头：滚动条立刻缩回去，这才是折叠真正省下的滚动距离。
    expect(shut.totalHeight).toBe(30);
    expect(shut.end - shut.start).toBe(1);
  });
});

describe('Agent Workbench 行高契约', () => {
  const header: WorkbenchListItem = {
    kind: 'header', key: 'header-active', group: 'active', groupKey: 'active',
    label: '进行中', count: 1, isNeedsYou: false, collapsed: false,
  };
  const row: WorkbenchListItem = {
    kind: 'session', key: 'active-session-1', group: 'active', groupKey: 'active',
    label: '进行中', isNeedsYou: false, session: session(1),
  };

  it('桌面行高 54px、触屏 84px，组头两边都是 30px', () => {
    // 54 必须和 style.css 的 `.wb-session-row { height: 54px }` 一字不差：
    // 虚拟滚动按这个数摆放每一行，对不上列表就会滚过自己的末尾。
    expect(workbenchListItemHeight(row)).toBe(54);
    expect(workbenchListItemHeight(row, false)).toBe(54);
    // 触屏那条（620px 断点里的 min-height: 84px）不受桌面收窄影响，
    // 44px 的点击目标是无障碍底线，不能跟着桌面一起变矮。
    expect(workbenchListItemHeight(row, true)).toBe(84);
    // 组头不分触屏桌面。
    expect(workbenchListItemHeight(header)).toBe(30);
    expect(workbenchListItemHeight(header, true)).toBe(30);
  });

  it('虚拟滚动的总高按同一份行高算，触屏更高所以窗口里装得更少', () => {
    const items = [header, ...Array.from({ length: 10 }, () => row)];
    expect(computeVirtualWindow(items, 0, 640).totalHeight).toBe(30 + 10 * 54);
    expect(computeVirtualWindow(items, 0, 640, 240, true).totalHeight).toBe(30 + 10 * 84);
    expect(computeVirtualWindow(items, 0, 200, 0, true).end)
      .toBeLessThan(computeVirtualWindow(items, 0, 200, 0, false).end);
  });
});
