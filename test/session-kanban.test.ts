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
    expect(normalizeSessionTitle('a'.repeat(300))).toHaveLength(200);
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
