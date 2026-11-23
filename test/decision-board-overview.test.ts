/**
 * 决策看板的总览与父子任务（纯函数）：分组和组内顺序（最该看的在最上面）、一棵树放在最该看的那一项所在的组、
 * 已结束的上级当层级显示、坏数据（环、上级不存在）不死循环也不丢项、在等谁的判断、列表按树缩进。
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_STALE_MS,
  boardCheckStatus,
  boardChildStats,
  boardOverviewGroup,
  boardWaitingOn,
  buildBoardOverview,
  effectiveParents,
  nestBoardList,
  overviewGroupCounts,
  parseParentSpec,
  readyToWrapUp,
  subtreeLatest,
  type OverviewInput,
} from '../src/core/decision-board/overview.js';
import type { BoardState } from '../src/core/decision-board/model.js';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const DAY = 86_400_000;

function item(seq: number, patch: Partial<OverviewInput> & { state?: BoardState } = {}): OverviewInput {
  return {
    seq, title: `事项 ${seq}`, state: 'active', stateAt: NOW - DAY, updatedAt: NOW - DAY, createdAt: NOW - 10 * DAY,
    pendingDecisions: 0, ...patch,
  };
}

const shape = (sections: ReturnType<typeof buildBoardOverview>) =>
  sections.map(s => [s.group, s.count, s.rows.map(r => `${'  '.repeat(r.depth)}#${r.item.seq}${r.group ? '' : '(已结束)'}`)]);

describe('parseParentSpec', () => {
  it('编号、#编号、none；别的写法报错', () => {
    expect(parseParentSpec('12')).toBe(12);
    expect(parseParentSpec(' #7 ')).toBe(7);
    expect(parseParentSpec('none')).toBeNull();
    expect(parseParentSpec('NONE')).toBeNull();
    for (const bad of ['', '0', 'abc', '12,13', '-3']) expect(parseParentSpec(bad)).toMatchObject({ error: expect.stringContaining('--parent') });
  });
});

describe('树', () => {
  it('上级不在、指向自己的当顶层；数据里有环时断开一处，每一项都还在、不死循环', () => {
    const parents = effectiveParents([
      { seq: 1, parentSeq: 3 }, { seq: 2, parentSeq: 1 }, { seq: 3, parentSeq: 2 }, // 1 → 3 → 2 → 1 成环
      { seq: 4, parentSeq: 4 }, { seq: 5, parentSeq: 99 }, { seq: 6, parentSeq: 5 },
    ]);
    expect(parents.has(4)).toBe(false);
    expect(parents.has(5)).toBe(false);
    expect(parents.get(6)).toBe(5);
    // 环里恰好断开一处，剩下的仍是链。
    expect([1, 2, 3].filter(s => parents.has(s))).toHaveLength(2);
    const rows = nestBoardList([1, 2, 3, 4, 5, 6].map(seq => ({ seq, parentSeq: ({ 1: 3, 2: 1, 3: 2, 4: 4, 5: 99, 6: 5 } as Record<number, number>)[seq] })));
    expect(rows.map(r => r.item.seq).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('子任务完成情况只数直接子任务，完成和关闭都算结束；子任务都结束、自己还没结束时可以收尾', () => {
    const items = [
      { seq: 1, state: 'active' as BoardState }, { seq: 2, parentSeq: 1, state: 'done' as BoardState },
      { seq: 3, parentSeq: 1, state: 'closed' as BoardState }, { seq: 4, parentSeq: 1, state: 'waiting' as BoardState },
      { seq: 5, parentSeq: 4, state: 'done' as BoardState },
    ];
    const stats = boardChildStats(items);
    expect(stats.get(1)).toEqual({ total: 3, done: 1, closed: 1 });
    expect(stats.get(4)).toEqual({ total: 1, done: 1, closed: 0 });
    expect(stats.has(2)).toBe(false);
    expect(readyToWrapUp({ state: 'active', childStats: stats.get(1) })).toBe(false);
    expect(readyToWrapUp({ state: 'waiting', childStats: stats.get(4) })).toBe(true);
    expect(readyToWrapUp({ state: 'done', childStats: stats.get(4) })).toBe(false);
    expect(readyToWrapUp({ state: 'active' })).toBe(false);
  });

  it('列表按树缩进：顶层保持服务端顺序，子任务紧跟上级、同级按服务端顺序；上级不在列表里的照常顶格', () => {
    const rows = nestBoardList([
      { seq: 9 }, { seq: 3, parentSeq: 1 }, { seq: 1 }, { seq: 4, parentSeq: 1 }, { seq: 5, parentSeq: 3 }, { seq: 7, parentSeq: 42 },
    ]);
    expect(rows.map(r => `${r.depth}:${r.item.seq}`)).toEqual(['0:9', '0:1', '1:3', '2:5', '1:4', '0:7']);
  });
});

describe('在等谁', () => {
  it('提交了决定等管家执行 > 待拍板 / 待验收等你 > 管家写的等谁 > 等待中（用阶段）> 管家在推进', () => {
    expect(boardWaitingOn({ state: 'decide', pendingDecisions: 1, waitingOn: 'PR 作者' })).toEqual({ kind: 'steward', what: 'execute' });
    expect(boardWaitingOn({ state: 'decide', pendingDecisions: 0, waitingOn: 'PR 作者' })).toEqual({ kind: 'owner', what: 'decide' });
    expect(boardWaitingOn({ state: 'accept', pendingDecisions: 0 })).toEqual({ kind: 'owner', what: 'accept' });
    expect(boardWaitingOn({ state: 'active', pendingDecisions: 0, waitingOn: ' 评审群双审 ' })).toEqual({ kind: 'external', who: '评审群双审' });
    expect(boardWaitingOn({ state: 'waiting', pendingDecisions: 0, stage: '等作者' })).toEqual({ kind: 'external', who: '等作者' });
    expect(boardWaitingOn({ state: 'waiting', pendingDecisions: 0 })).toEqual({ kind: 'external' });
    expect(boardWaitingOn({ state: 'active', pendingDecisions: 0, stage: '在修' })).toEqual({ kind: 'steward', what: 'work' });
  });
});

describe('总览分组', () => {
  it('每一项归哪组：要你拍板 > 过了复查 / 搁置（看复查时间）> 3 天没动 > 等待中 / 进行中；已结束的不进总览', () => {
    expect(boardOverviewGroup(item(1, { state: 'decide', nextCheckAt: NOW + DAY }), NOW)).toBe('needs_you');
    expect(boardOverviewGroup(item(1, { state: 'decide', pendingDecisions: 1 }), NOW)).toBe('active');
    expect(boardOverviewGroup(item(1, { state: 'accept', pendingDecisions: 1, nextCheckAt: NOW - 1 }), NOW)).toBe('overdue');
    expect(boardOverviewGroup(item(1, { nextCheckAt: NOW }), NOW)).toBe('overdue');
    expect(boardOverviewGroup(item(1, { state: 'waiting', nextCheckAt: NOW + 1, updatedAt: NOW - 30 * DAY }), NOW)).toBe('parked');
    // 3 天整算很久没动；差一毫秒不算。
    expect(boardOverviewGroup(item(1, { updatedAt: NOW - BOARD_STALE_MS }), NOW)).toBe('stalled');
    expect(boardOverviewGroup(item(1, { updatedAt: NOW - BOARD_STALE_MS + 1 }), NOW)).toBe('active');
    // 最近进展取历史、更新时间里晚的那个。
    expect(boardOverviewGroup(item(1, { updatedAt: NOW - 9 * DAY, lastActivityAt: NOW - DAY }), NOW)).toBe('active');
    expect(boardOverviewGroup(item(1, { state: 'waiting' }), NOW)).toBe('waiting');
    expect(boardOverviewGroup(item(1, { state: 'done' }), NOW)).toBeUndefined();
    expect(boardOverviewGroup(item(1, { state: 'closed', nextCheckAt: NOW - DAY }), NOW)).toBeUndefined();
  });

  it('组按固定顺序，组内最该看的在前：等得最久 / 过期最久 / 最久没动 / 先到复查时间', () => {
    const sections = buildBoardOverview([
      item(1, { state: 'decide', stateAt: NOW - 1 * DAY }),
      item(2, { state: 'decide', stateAt: NOW - 5 * DAY }),
      item(3, { nextCheckAt: NOW - 2 * DAY, updatedAt: NOW - 3 * DAY }),
      item(4, { nextCheckAt: NOW - 5 * DAY, updatedAt: NOW - 6 * DAY }),
      // 组内按最近进展排，不按字段更新时间：#6 字段很久没改，但历史里前天还有进展。
      item(5, { updatedAt: NOW - 4 * DAY }),
      item(6, { updatedAt: NOW - 20 * DAY, lastActivityAt: NOW - 3.5 * DAY }),
      item(7, { updatedAt: NOW - 20 * DAY, lastActivityAt: NOW - 2 * DAY }),
      item(8, { updatedAt: NOW - 1 * DAY }),
      item(9, { state: 'waiting', updatedAt: NOW - DAY }),
      item(10, { state: 'waiting', nextCheckAt: NOW + 5 * DAY }),
      item(11, { state: 'waiting', nextCheckAt: NOW + 1 * DAY }),
      item(12, { state: 'done' }),
    ], NOW);
    expect(shape(sections)).toEqual([
      ['needs_you', 2, ['#2', '#1']],
      ['overdue', 2, ['#4', '#3']],
      ['stalled', 2, ['#5', '#6']],
      ['active', 2, ['#7', '#8']],
      ['waiting', 1, ['#9']],
      ['parked', 2, ['#11', '#10']],
    ]);
  });

  it('一棵树放在它里面最该看的那一项所在的组；树里同级也按最该看的在前；组的计数只数自己属于这组的', () => {
    const sections = buildBoardOverview([
      item(1, { title: '大任务（进行中）' }),
      item(2, { parentSeq: 1, state: 'waiting', nextCheckAt: NOW + DAY }),
      item(3, { parentSeq: 1, state: 'decide' }),
      item(4, { parentSeq: 3 }),
      item(5, { parentSeq: 1, state: 'done' }),
      item(6, { title: '另一棵', state: 'waiting', nextCheckAt: NOW + 2 * DAY }),
      item(7, { parentSeq: 6, state: 'closed' }),
    ], NOW);
    expect(shape(sections)).toEqual([
      // #1 自己是进行中，但子任务 #3 要你拍板：整棵树进「要你拍板」，#3 排在 #2 前面；已完成的 #5 不列。
      ['needs_you', 1, ['#1', '  #3', '    #4', '  #2']],
      ['parked', 1, ['#6']],
    ]);
    expect(sections[0]!.rows.map(r => r.group)).toEqual(['active', 'needs_you', 'active', 'parked']);
  });

  it('已结束的上级下面还有没结束的子任务：上级灰着显示保住层级，不计数；全结束的树不进总览', () => {
    const sections = buildBoardOverview([
      item(1, { state: 'done' }),
      item(2, { parentSeq: 1, updatedAt: NOW - 6 * DAY }),
      item(3, { parentSeq: 1, state: 'done' }),
      item(4, { state: 'closed' }),
      item(5, { parentSeq: 4, state: 'done' }),
    ], NOW);
    expect(shape(sections)).toEqual([['stalled', 1, ['#1(已结束)', '  #2']]]);
  });

  it('坏数据（上级成环、上级不存在）照样分组，不死循环、不丢项', () => {
    const sections = buildBoardOverview([
      item(1, { parentSeq: 2 }), item(2, { parentSeq: 1 }), item(3, { parentSeq: 404, state: 'decide' }),
    ], NOW);
    expect(sections.flatMap(s => s.rows.map(r => r.item.seq)).sort()).toEqual([1, 2, 3]);
    expect(sections[0]!.group).toBe('needs_you');
  });

  it('复查时间到点之后有过进展（管家看过、没重设）：不再算过了复查时间，按最近进展归组；和巡检的「该看一眼」同一口径', () => {
    const checked = item(1, { nextCheckAt: NOW - 2 * DAY, updatedAt: NOW - 3 * DAY, lastActivityAt: NOW - DAY });
    expect(boardCheckStatus(checked, NOW)).toBe('passed');
    expect(boardOverviewGroup(checked, NOW)).toBe('active');
    expect(boardOverviewGroup({ ...checked, lastActivityAt: NOW - 2 * DAY + 1, }, NOW)).toBe('active');
    expect(boardOverviewGroup({ ...checked, lastActivityAt: NOW - 2 * DAY }, NOW)).toBe('overdue');
    // 到点后动过、之后又三天多没动：算很久没动。
    expect(boardOverviewGroup(item(2, { nextCheckAt: NOW - 9 * DAY, updatedAt: NOW - 5 * DAY }), NOW)).toBe('stalled');
  });

  it('顶上的计数按每一项自己的组：树被排进「要你拍板」时，树里过了复查时间的子任务照样算进「过了复查时间」', () => {
    const items = [
      item(1), item(2, { parentSeq: 1, state: 'decide' }), item(3, { parentSeq: 1, nextCheckAt: NOW - DAY, updatedAt: NOW - 2 * DAY }),
      item(4, { state: 'done' }),
    ];
    expect(buildBoardOverview(items, NOW).map(s => s.group)).toEqual(['needs_you']);
    expect([...overviewGroupCounts(items, NOW)]).toEqual([['needs_you', 1], ['overdue', 1], ['active', 1]]);
  });

  it('子树最近进展：每一项取它和所有子孙里最晚的，坏数据（环）不死循环', () => {
    const latest = subtreeLatest([{ seq: 1 }, { seq: 2, parentSeq: 1 }, { seq: 3, parentSeq: 2 }, { seq: 4 }, { seq: 5, parentSeq: 6 }, { seq: 6, parentSeq: 5 }],
      new Map([[1, 10], [2, 5], [3, 30], [4, 7], [5, 1], [6, 2]]));
    expect([...latest].sort((a, b) => a[0] - b[0])).toEqual([[1, 30], [2, 30], [3, 30], [4, 7], [5, 2], [6, 2]]);
  });
});
