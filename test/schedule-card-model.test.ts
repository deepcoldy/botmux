import { describe, expect, it } from 'vitest';

import type { ParsedSchedule } from '../src/types.js';
import {
  computeButtonAvailability,
  computeNextNRuns,
  filterAndPaginateSchedules,
  filterSchedules,
  kindCounts,
  paginateSchedules,
  toScheduleDetailDto,
  toScheduleRowDto,
  type ScheduleCardTaskInput,
} from '../src/dashboard/schedule-card-model.js';

const FIXED_NOW = Date.parse('2025-04-15T08:00:00Z');
const TZ = 'Asia/Shanghai';

function once(runAt: string): ParsedSchedule {
  return { kind: 'once', runAt, display: `once @ ${runAt}` };
}
function interval(minutes: number): ParsedSchedule {
  return { kind: 'interval', minutes, display: `every ${minutes}m` };
}
function cron(expr: string): ParsedSchedule {
  return { kind: 'cron', expr, display: `cron ${expr}` };
}

function makeTask(overrides: Partial<ScheduleCardTaskInput> = {}): ScheduleCardTaskInput {
  return {
    id: 'task-1',
    name: 'demo task',
    prompt: 'do something',
    parsed: interval(30),
    enabled: true,
    larkAppId: 'cli_demo',
    chatId: 'oc_demo',
    ...overrides,
  };
}

describe('schedule-card-model · filterSchedules', () => {
  it('enabledOnly removes tasks with enabled=false', () => {
    const tasks = [
      makeTask({ id: 'a', enabled: true }),
      makeTask({ id: 'b', enabled: false }),
    ];
    expect(filterSchedules(tasks, { enabledOnly: true }).map(t => t.id)).toEqual(['a']);
    expect(filterSchedules(tasks, { enabledOnly: false }).map(t => t.id)).toEqual(['a', 'b']);
  });

  it('search is case-insensitive and matches both name and prompt', () => {
    const tasks = [
      makeTask({ id: 'a', name: 'Daily Report', prompt: 'do summary' }),
      makeTask({ id: 'b', name: 'mute', prompt: 'CRON the SUMMARY' }),
      makeTask({ id: 'c', name: 'other', prompt: 'nothing' }),
    ];
    const out = filterSchedules(tasks, { search: 'SUMMARY' });
    expect(out.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('kind=cron keeps only tasks whose parsed.kind is cron', () => {
    const tasks = [
      makeTask({ id: 'i', parsed: interval(15) }),
      makeTask({ id: 'c', parsed: cron('0 * * * *') }),
      makeTask({ id: 'o', parsed: once('2025-04-15T12:00:00Z') }),
    ];
    expect(filterSchedules(tasks, { kind: 'cron' }).map(t => t.id)).toEqual(['c']);
    expect(filterSchedules(tasks, { kind: 'all' }).map(t => t.id)).toEqual(['i', 'c', 'o']);
  });
});

describe('schedule-card-model · paginateSchedules clamp (M4)', () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it('page < 1 clamps to 1', () => {
    const p = paginateSchedules(items, 0, 10);
    expect(p.page).toBe(1);
    expect(p.items[0]).toBe(1);

    const neg = paginateSchedules(items, -3, 10);
    expect(neg.page).toBe(1);
  });

  it('page > totalPages clamps to totalPages', () => {
    const p = paginateSchedules(items, 99, 10);
    expect(p.totalPages).toBe(5);
    expect(p.page).toBe(5);
    expect(p.items[0]).toBe(41);
  });

  it('pageSize < 1 falls back to default 20', () => {
    expect(paginateSchedules(items, 1, 0).pageSize).toBe(20);
    expect(paginateSchedules(items, 1, -5).pageSize).toBe(20);
    expect(paginateSchedules(items, 1, undefined).pageSize).toBe(20);
  });

  it('pageSize > 100 clamps to 100', () => {
    expect(paginateSchedules(items, 1, 999).pageSize).toBe(100);
  });
});

describe('schedule-card-model · toScheduleRowDto', () => {
  it("nextRunAt in the future renders 'in Xm'; missing renders '—'", () => {
    const future = makeTask({ nextRunAt: new Date(FIXED_NOW + 5 * 60_000).toISOString() });
    const row = toScheduleRowDto(future, { nowMs: FIXED_NOW });
    expect(row.nextRunRelative).toBe('in 5m');

    const missing = makeTask({ nextRunAt: undefined });
    expect(toScheduleRowDto(missing, { nowMs: FIXED_NOW }).nextRunRelative).toBe('—');
  });

  it('lastStatus=error sets errorIndicator=true; enabled=false maps to {runNow:on, resume:on, pause:off} (no glyph in DTO)', () => {
    const errored = makeTask({ lastStatus: 'error', enabled: false });
    const row = toScheduleRowDto(errored, { nowMs: FIXED_NOW });
    expect(row.errorIndicator).toBe(true);
    expect(row.actions.runNow.enabled).toBe(true);
    expect(row.actions.resume.enabled).toBe(true);
    expect(row.actions.pause.enabled).toBe(false);
    // Critically: ButtonState only carries semantic flags. Renderer adds glyph.
    expect(JSON.stringify(row.actions)).not.toContain('▶');
    expect(JSON.stringify(row.actions)).not.toContain('⏸');

    const enabledTask = makeTask({ enabled: true });
    const enabledRow = toScheduleRowDto(enabledTask, { nowMs: FIXED_NOW });
    expect(enabledRow.actions.pause.enabled).toBe(true);
    expect(enabledRow.actions.resume.enabled).toBe(false);
  });
});

describe('schedule-card-model · toScheduleDetailDto', () => {
  it('truncates a prompt longer than promptTruncateAt and sets promptTruncated=true', () => {
    const longPrompt = 'x'.repeat(250);
    const task = makeTask({ prompt: longPrompt });
    const detail = toScheduleDetailDto(task, { nowMs: FIXED_NOW, promptTruncateAt: 100 });
    expect(detail.promptTruncated).toBe(true);
    expect(detail.prompt?.length).toBe(101); // 100 chars + '…'
    expect(detail.prompt?.endsWith('…')).toBe(true);

    const short = makeTask({ prompt: 'short' });
    const sd = toScheduleDetailDto(short, { nowMs: FIXED_NOW, promptTruncateAt: 100 });
    expect(sd.promptTruncated).toBe(false);
    expect(sd.prompt).toBe('short');
  });
});

describe('schedule-card-model · computeNextNRuns', () => {
  it('returns strictly increasing ISO timestamps for a cron task (fixed nowMs + Asia/Shanghai)', () => {
    const task = makeTask({ parsed: cron('0 9 * * *') }); // 09:00 daily, Shanghai
    const runs = computeNextNRuns(task, 3, { nowMs: FIXED_NOW, timezone: TZ });
    expect(runs).toHaveLength(3);
    const ms = runs.map(r => Date.parse(r));
    expect(ms[0]).toBeLessThan(ms[1]);
    expect(ms[1]).toBeLessThan(ms[2]);
    // All Future runs must be after nowMs.
    expect(ms.every(t => t > FIXED_NOW)).toBe(true);
  });

  it('returns [] when once.lastRunAt is set', () => {
    const t = makeTask({
      parsed: once(new Date(FIXED_NOW + 3600_000).toISOString()),
      lastRunAt: new Date(FIXED_NOW - 60_000).toISOString(),
    });
    expect(computeNextNRuns(t, 5, { nowMs: FIXED_NOW })).toEqual([]);
  });

  it('returns [] for interval=0 (degenerate)', () => {
    const t = makeTask({ parsed: interval(0) });
    expect(computeNextNRuns(t, 5, { nowMs: FIXED_NOW })).toEqual([]);
  });

  it('skips long-overdue interval runs arithmetically and returns future timestamps', () => {
    const t = makeTask({
      parsed: interval(1),
      lastRunAt: new Date(FIXED_NOW - 400_000 * 60_000).toISOString(),
    });
    const runs = computeNextNRuns(t, 3, { nowMs: FIXED_NOW });
    expect(runs.map(r => Date.parse(r))).toEqual([
      FIXED_NOW + 60_000,
      FIXED_NOW + 120_000,
      FIXED_NOW + 180_000,
    ]);
  });
});

describe('schedule-card-model · invariants', () => {
  it('filter / paginate / toRow do not mutate the input list', () => {
    const tasks = [
      makeTask({ id: 'a', enabled: true, parsed: interval(15) }),
      makeTask({ id: 'b', enabled: false, parsed: cron('* * * * *') }),
    ];
    const frozen = Object.freeze(tasks.slice());
    const snapshot = frozen.map(t => t.id);
    filterSchedules(frozen, { search: 'foo', kind: 'cron', enabledOnly: true });
    paginateSchedules(frozen, 1, 10);
    frozen.forEach(t => toScheduleRowDto(t, { nowMs: FIXED_NOW }));
    expect(frozen.map(t => t.id)).toEqual(snapshot);
  });

  it('filterAndPaginateSchedules composes filter/paginate/counts and is JSON-serialisable', () => {
    const tasks = [
      makeTask({ id: 'a', parsed: cron('0 * * * *') }),
      makeTask({ id: 'b', parsed: interval(30), enabled: false }),
      makeTask({ id: 'c', parsed: once(new Date(FIXED_NOW + 3600_000).toISOString()) }),
    ];
    const page = filterAndPaginateSchedules(
      tasks,
      { kind: 'all', page: 1, pageSize: 10 },
      { nowMs: FIXED_NOW, timezone: TZ },
    );
    expect(page.meta.total).toBe(3);
    expect(page.kindCounts).toEqual({ all: 3, once: 1, interval: 1, cron: 1 });
    expect(page.rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
  });

  it('computeButtonAvailability is consistent with toScheduleRowDto.actions', () => {
    const t = makeTask({ enabled: false });
    expect(toScheduleRowDto(t, { nowMs: FIXED_NOW }).actions).toEqual(computeButtonAvailability(t));
  });

  it('kindCounts tallies parsed.kind across the full pool (not just one page)', () => {
    const tasks = [
      makeTask({ parsed: cron('0 * * * *') }),
      makeTask({ parsed: cron('15 * * * *') }),
      makeTask({ parsed: interval(5) }),
    ];
    expect(kindCounts(tasks)).toEqual({ all: 3, once: 0, interval: 1, cron: 2 });
  });

  it('row and detail DTOs pass `repeat` through unchanged (object shape matches ScheduledTask.repeat)', () => {
    const finite = makeTask({ repeat: { times: 5, completed: 2 } });
    const forever = makeTask({ repeat: { times: null, completed: 17 } });
    const absent = makeTask({ repeat: undefined });

    const ctx = { nowMs: FIXED_NOW };
    expect(toScheduleRowDto(finite, ctx).repeat).toEqual({ times: 5, completed: 2 });
    expect(toScheduleRowDto(forever, ctx).repeat).toEqual({ times: null, completed: 17 });
    expect(toScheduleRowDto(absent, ctx).repeat).toBeUndefined();

    expect(toScheduleDetailDto(finite, ctx).repeat).toEqual({ times: 5, completed: 2 });
    expect(toScheduleDetailDto(forever, ctx).repeat).toEqual({ times: null, completed: 17 });
    expect(toScheduleDetailDto(absent, ctx).repeat).toBeUndefined();
  });
});
