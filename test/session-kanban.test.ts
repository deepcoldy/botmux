import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listTeamGroups, recordTeamGroup } from '../src/services/team-groups-store.js';
import {
  listTeamReports,
  readTeamBoard,
  recordTeamSessions,
  sanitizeReportedSessions,
  setTeamBoardEntry,
  TEAM_REPORT_MAX_SESSIONS,
} from '../src/services/team-board-store.js';
import {
  KANBAN_COLUMN_IDS,
  normalizeKanbanColumn,
  normalizeKanbanPosition,
  normalizeSessionTitle,
} from '../src/core/session-board.js';
import {
  computeDropPosition,
  deriveKanbanColumn,
  effectiveKanbanPosition,
  paginateColumnEntries,
} from '../src/dashboard/web/kanban-model.js';

describe('session-board normalizers', () => {
  it('accepts only known kanban columns', () => {
    for (const id of KANBAN_COLUMN_IDS) expect(normalizeKanbanColumn(id)).toBe(id);
    expect(normalizeKanbanColumn('doing')).toBeNull();
    expect(normalizeKanbanColumn('')).toBeNull();
    expect(normalizeKanbanColumn(undefined)).toBeNull();
    expect(normalizeKanbanColumn(3)).toBeNull();
  });

  it('accepts only finite numbers as positions', () => {
    expect(normalizeKanbanPosition(0)).toBe(0);
    expect(normalizeKanbanPosition(1536.5)).toBe(1536.5);
    expect(normalizeKanbanPosition(-1024)).toBe(-1024);
    expect(normalizeKanbanPosition(Number.NaN)).toBeNull();
    expect(normalizeKanbanPosition(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeKanbanPosition('5')).toBeNull();
    expect(normalizeKanbanPosition(undefined)).toBeNull();
  });

  it('trims, flattens newlines, and caps the title; rejects empty/non-string', () => {
    expect(normalizeSessionTitle('  修复登录 bug  ')).toBe('修复登录 bug');
    expect(normalizeSessionTitle('第一行\n  第二行')).toBe('第一行 第二行');
    expect(normalizeSessionTitle('安全\r\n标题\t\u001b[31m\u0000\u009b')).toBe('安全 标题 [31m');
    expect(normalizeSessionTitle('\x1b]52;c;payload\x07安全\t标题\u009b2J')).toBe(']52;c;payload 安全 标题 2J');
    expect(normalizeSessionTitle('a'.repeat(300))).toHaveLength(200);
    const emojiBoundary = normalizeSessionTitle('a'.repeat(199) + '😀x');
    expect(emojiBoundary?.isWellFormed()).toBe(true);
    expect(emojiBoundary).toBe('a'.repeat(199));
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('')).toBeNull();
    expect(normalizeSessionTitle(42)).toBeNull();
    expect(normalizeSessionTitle(undefined)).toBeNull();
  });
});

describe('deriveKanbanColumn', () => {
  it('forces closed sessions into done, ignoring manual placement', () => {
    expect(deriveKanbanColumn({ status: 'closed' })).toBe('done');
    expect(deriveKanbanColumn({ status: 'closed', kanbanColumn: 'in_progress' })).toBe('done');
  });

  it('manual placement wins over runtime derivation', () => {
    expect(deriveKanbanColumn({ status: 'working', kanbanColumn: 'backlog' })).toBe('backlog');
    expect(deriveKanbanColumn({ status: 'idle', kanbanColumn: 'done' })).toBe('done');
  });

  it('falls back to runtime derivation when manual value is invalid', () => {
    expect(deriveKanbanColumn({ status: 'working', kanbanColumn: 'nope' })).toBe('in_progress');
  });

  it('routes needs-you signals to in_review', () => {
    expect(deriveKanbanColumn({ status: 'working', pendingRepo: true })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'idle', tuiPromptActive: true })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'idle', agentAttention: { kind: 'x', reason: 'y', at: 1 } })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'limited' })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'stalled' })).toBe('in_review');
  });

  it('maps runtime states to default columns', () => {
    for (const status of ['starting', 'working', 'analyzing', 'active']) {
      expect(deriveKanbanColumn({ status })).toBe('in_progress');
    }
    expect(deriveKanbanColumn({ status: 'idle' })).toBe('todo');
    expect(deriveKanbanColumn({ status: 'dormant' })).toBe('todo');
  });
});

describe('effectiveKanbanPosition', () => {
  it('pinned positions sort before unpinned cards', () => {
    const pinned = effectiveKanbanPosition({ kanbanPosition: 99999, lastMessageAt: Date.now() });
    const unpinned = effectiveKanbanPosition({ lastMessageAt: Date.now() });
    expect(pinned).toBeLessThan(unpinned);
  });

  it('orders unpinned cards by recency (newer first = smaller key)', () => {
    const newer = effectiveKanbanPosition({ lastMessageAt: 2_000 });
    const older = effectiveKanbanPosition({ lastMessageAt: 1_000 });
    expect(newer).toBeLessThan(older);
  });

  it('ignores non-finite stored positions', () => {
    expect(effectiveKanbanPosition({ kanbanPosition: Number.NaN, lastMessageAt: 0 }))
      .toBe(effectiveKanbanPosition({ lastMessageAt: 0 }));
  });
});

describe('team-groups-store', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('records and lists team↔chat bindings, deduped', () => {
    dir = mkdtempSync(join(tmpdir(), 'team-groups-'));
    expect(listTeamGroups(dir)).toEqual([]);
    recordTeamGroup(dir, 'team-a', 'oc_1', 1000);
    recordTeamGroup(dir, 'team-a', 'oc_2', 2000);
    recordTeamGroup(dir, 'team-b', 'oc_1', 3000);
    recordTeamGroup(dir, 'team-a', 'oc_1', 4000); // 重复绑定不追加
    expect(listTeamGroups(dir)).toHaveLength(3);
    expect(listTeamGroups(dir, 'team-a').map(b => b.chatId)).toEqual(['oc_1', 'oc_2']);
    expect(listTeamGroups(dir, 'team-b').map(b => b.chatId)).toEqual(['oc_1']);
  });

  it('ignores empty ids and survives a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'team-groups-'));
    recordTeamGroup(dir, '', 'oc_1');
    recordTeamGroup(dir, 'team-a', '');
    expect(listTeamGroups(dir)).toEqual([]);
  });
});

describe('team-board-store', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('writes and reads shared board entries with validation', () => {
    dir = mkdtempSync(join(tmpdir(), 'team-board-'));
    expect(setTeamBoardEntry(dir, 't1', 'sid-1', 'in_progress', 1024, 5)).toEqual({ column: 'in_progress', position: 1024, updatedAt: 5 });
    expect(setTeamBoardEntry(dir, 't1', 'sid-1', 'nope', 1)).toBeNull();
    expect(setTeamBoardEntry(dir, 't1', 'sid-1', 'done', Number.NaN)).toBeNull();
    expect(setTeamBoardEntry(dir, 't1', '', 'done', 1)).toBeNull();
    expect(readTeamBoard(dir, 't1')).toEqual({ 'sid-1': { column: 'in_progress', position: 1024, updatedAt: 5 } });
    expect(readTeamBoard(dir, 't2')).toEqual({});
  });

  it('records per-deployment session reports, overwriting previous snapshots', () => {
    dir = mkdtempSync(join(tmpdir(), 'team-board-'));
    recordTeamSessions(dir, 't1', 'dep-a', 'A 部署', [
      { sessionId: 's1', chatId: 'oc_1', botName: 'B', cliId: 'codex', status: 'working', lastMessageAt: 1 },
    ], 100);
    recordTeamSessions(dir, 't1', 'dep-a', 'A 部署', [], 200);
    const reports = listTeamReports(dir, 't1');
    expect(reports).toHaveLength(1);
    expect(reports[0].reportedAt).toBe(200);
    expect(reports[0].sessions).toEqual([]);
  });

  it('sanitizes reported sessions: whitelists fields, drops invalid, caps count', () => {
    const raw: any[] = [
      { sessionId: 's1', chatId: 'oc_1', botName: 'B', cliId: 'codex', status: 'working', title: 'x', lastMessageAt: 9, webPort: 1234, workingDir: '/secret' },
      { sessionId: '', chatId: 'oc_1' },
      { chatId: 'oc_1' },
      'junk',
    ];
    const out = sanitizeReportedSessions(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('webPort');
    expect(out[0]).not.toHaveProperty('workingDir');
    expect(out[0].title).toBe('x');
    const many = Array.from({ length: TEAM_REPORT_MAX_SESSIONS + 50 }, (_, i) => ({ sessionId: `s${i}`, chatId: 'oc' }));
    expect(sanitizeReportedSessions(many)).toHaveLength(TEAM_REPORT_MAX_SESSIONS);
  });
});

describe('computeDropPosition', () => {
  it('uses the midpoint between two neighbours', () => {
    expect(computeDropPosition(1024, 2048)).toBe(1536);
  });

  it('steps outward at column edges', () => {
    expect(computeDropPosition(1024, null)).toBe(2048);
    expect(computeDropPosition(null, 1024)).toBe(0);
  });

  it('seeds an empty column with a constant', () => {
    expect(computeDropPosition(null, null)).toBe(1024);
  });
});

describe('paginateColumnEntries', () => {
  const card = (): { size: number; expanded: boolean } => ({ size: 1, expanded: false });

  it('admits whole entries up to the budget and counts the rest as hidden', () => {
    const entries = Array.from({ length: 67 }, card);
    expect(paginateColumnEntries(entries, 60)).toMatchObject({
      visibleCount: 60,
      hiddenUnits: 7,
    });
    expect(paginateColumnEntries(entries, 120)).toMatchObject({ visibleCount: 67, hiddenUnits: 0 });
  });

  it('never excludes the first entry: an oversized collapsed cluster stays reachable', () => {
    // 折叠簇只渲染一个标题，按 1 个渲染单位占位；后面的单卡照常填满剩余预算。
    const page = paginateColumnEntries([{ size: 400, expanded: false }, card()], 60);
    expect(page.visibleCount).toBe(2);
    expect(page.memberCaps[0]).toBe(-1);
    expect(page.hiddenUnits).toBe(0);
  });

  it('a large collapsed cluster at the head costs one render unit, not its member count', () => {
    // 真实主路径：最近活跃的大群恒在列首。3000 人折叠群 + 100 个单会话，
    // 首屏必须是「群标题 + 59 个单卡」，而不是只剩一个群标题、单卡要点几十次才出现。
    const entries = [{ size: 3000, expanded: false }, ...Array.from({ length: 100 }, card)];
    const page1 = paginateColumnEntries(entries, 60);
    expect(page1.visibleCount).toBe(60);
    expect(page1.memberCaps[0]).toBe(-1);
    expect(page1.hiddenUnits).toBe(41);
    // 第二页（预算 120）：群标题 + 100 单卡共 101 个渲染单位，全部可见，无隐藏。
    const page2 = paginateColumnEntries(entries, 120);
    expect(page2.visibleCount).toBe(101);
    expect(page2.hiddenUnits).toBe(0);
  });

  it('a collapsed group at the head sized at/over one page still leaves room for every card', () => {
    // 60 人群 + 50 单卡：群只占 1，50 张单卡全部留在首屏（旧实现按 size 占位时只剩群标题）。
    for (const groupSize of [59, 60, 400]) {
      const entries = [{ size: groupSize, expanded: false }, ...Array.from({ length: 50 }, card)];
      const page = paginateColumnEntries(entries, 60);
      expect(page.visibleCount).toBe(51);
      expect(page.hiddenUnits).toBe(0);
    }
  });

  it('truncates the expanded first cluster to the remaining budget and pages the rest', () => {
    const page = paginateColumnEntries([{ size: 400, expanded: true }, card()], 60);
    expect(page.visibleCount).toBe(1);
    expect(page.memberCaps[0]).toBe(60);
    expect(page.hiddenUnits).toBe(341);
    const page2 = paginateColumnEntries([{ size: 400, expanded: true }, card()], 420);
    expect(page2.memberCaps[0]).toBe(400);
    expect(page2.visibleCount).toBe(2);
    expect(page2.hiddenUnits).toBe(0);
  });

  it('expanding a collapsed cluster after cards truncates its members by the remaining budget', () => {
    // 40 个单卡 + 一个 60 人群：折叠时群标题也在首屏（41 个单位）；展开后成员卡
    // 只拿到剩余 20 个位置，其余 40 个成员走「显示更多」，单卡一个都不被挤走。
    const collapsed = [...Array.from({ length: 40 }, card), { size: 60, expanded: false }];
    expect(paginateColumnEntries(collapsed, 60)).toMatchObject({ visibleCount: 41, hiddenUnits: 0 });
    const expanded = [...Array.from({ length: 40 }, card), { size: 60, expanded: true }];
    const page1 = paginateColumnEntries(expanded, 60);
    expect(page1.visibleCount).toBe(41);
    expect(page1.memberCaps[40]).toBe(20);
    expect(page1.hiddenUnits).toBe(40);
    const page2 = paginateColumnEntries(expanded, 120);
    expect(page2.memberCaps[40]).toBe(60);
    expect(page2.hiddenUnits).toBe(0);
  });

  it('excludes entries only when no render unit fits and counts their members as hidden', () => {
    // 60 个单卡填满预算后，第 61 个条目（哪怕只画标题）放不下：未纳入群簇的成员不可达。
    const entries = [...Array.from({ length: 60 }, card), { size: 5, expanded: false }];
    const page = paginateColumnEntries(entries, 60);
    expect(page.visibleCount).toBe(60);
    expect(page.hiddenUnits).toBe(5);
    const wider = paginateColumnEntries(entries, 120);
    expect(wider.visibleCount).toBe(61);
    expect(wider.memberCaps[60]).toBe(-1);
    expect(wider.hiddenUnits).toBe(0);
  });

  it('does not render an expanded cluster header with zero cards when the budget is exactly spent', () => {
    // 60 张单卡恰好填满预算，后面紧跟一个展开簇：cap=0 时必须整条留给下一页
    // （否则会渲染一个 0 成员的展开簇空壳）。
    const entries = [...Array.from({ length: 60 }, card), { size: 5, expanded: true }];
    const page = paginateColumnEntries(entries, 60);
    expect(page.visibleCount).toBe(60);
    expect(page.memberCaps).not.toContain(0);
    expect(page.hiddenUnits).toBe(5);
  });
});
