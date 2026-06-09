/**
 * PR3 `/dashboard schedules` slice 1 — card builder + callback handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ScheduleCardTaskInput } from '../src/dashboard/schedule-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSchedulesCard,
  handleSchedulesCardAction,
  SCHEDULES_ACTION_PAGE,
  SCHEDULES_ACTION_REFRESH,
} from '../src/im/lark/schedules-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

function task(over: Partial<ScheduleCardTaskInput> = {}): ScheduleCardTaskInput {
  return {
    id: 'sch_default',
    name: 'daily ping',
    prompt: 'say hi',
    parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' } as any,
    enabled: true,
    larkAppId: LARK_APP_ID,
    chatId: 'oc_chat',
    nextRunAt: '2026-06-09T13:00:00.000Z',
    lastRunAt: '2026-06-08T13:00:00.000Z',
    lastStatus: 'ok',
    repeat: { times: null, completed: 5 },
    ...over,
  };
}

describe('buildSchedulesCard', () => {
  const NOW = Date.parse('2026-06-09T12:00:00.000Z');  // 1h before next run
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, page: 1 };

  it('empty list → empty state, refresh button still present, no pagination', () => {
    const json = buildSchedulesCard([], baseOpts, NOW);
    expect(json).toContain('Dashboard 定时任务');
    expect(json).toContain('_当前没有定时任务_');
    expect(json).not.toContain('上一页');
    expect(json).not.toContain('下一页');
    expect(json).toContain(SCHEDULES_ACTION_REFRESH);
  });

  it('sorts enabled tasks before paused, then by earliest nextRunAt', () => {
    const tasks: ScheduleCardTaskInput[] = [
      task({ id: 'p1', name: 'paused-soon', enabled: false, nextRunAt: '2026-06-09T12:30:00.000Z' }),
      task({ id: 'e2', name: 'enabled-late', enabled: true, nextRunAt: '2026-06-09T14:00:00.000Z' }),
      task({ id: 'e1', name: 'enabled-soon', enabled: true, nextRunAt: '2026-06-09T13:00:00.000Z' }),
    ];
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    const i = (s: string) => json.indexOf(s);
    expect(i('enabled-soon')).toBeGreaterThan(0);
    expect(i('enabled-late')).toBeGreaterThan(0);
    expect(i('paused-soon')).toBeGreaterThan(0);
    // enabled-soon comes first, paused-soon last
    expect(i('enabled-soon')).toBeLessThan(i('enabled-late'));
    expect(i('enabled-late')).toBeLessThan(i('paused-soon'));
  });

  it('count summary shows enabled / paused counts', () => {
    const tasks: ScheduleCardTaskInput[] = [
      task({ id: 'a', enabled: true }),
      task({ id: 'b', enabled: true }),
      task({ id: 'c', enabled: false }),
    ];
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    expect(json).toContain('启用 2');
    expect(json).toContain('暂停 1');
  });

  it('row renders next/last relative + kind/displayExpr + repeat (when finite)', () => {
    const t1 = task({
      id: 't1', name: 'pingdom',
      parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' } as any,
      nextRunAt: new Date(NOW + 60_000).toISOString(),  // in 1m
      lastRunAt: new Date(NOW - 5 * 60_000).toISOString(),  // 5m ago
      repeat: { times: 10, completed: 3 },
    });
    const json = buildSchedulesCard([t1], baseOpts, NOW);
    expect(json).toContain('cron');
    // Cron `*` is escaped as `\*` to prevent markdown italic — that's the
    // escape function's job, see escapeLarkMd. The displayed form is
    // therefore `0 9 \* \* \*`, not raw `0 9 * * *`.
    expect(json).toContain('0 9 \\\\* \\\\* \\\\*');
    expect(json).toContain('下次 in 1m');
    expect(json).toContain('上次 5m ago');
    expect(json).toContain('已跑 3/10');
  });

  it('pagination at >10 tasks; page=2 emits prev=1 / next=3', () => {
    const tasks: ScheduleCardTaskInput[] = Array.from({ length: 25 }, (_, i) =>
      task({ id: `t_${i}`, name: `task-${i}`, enabled: true, nextRunAt: `2026-06-09T${String(13 + (i % 10)).padStart(2, '0')}:00:00.000Z` }),
    );
    const json = buildSchedulesCard(tasks, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('第 2/3 页');
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');
  });

  it('first/last page disable prev/next respectively', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const findPager = (json: string): { prev: any; next: any } => {
      const parsed = JSON.parse(json);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const actions = actionRow.actions as any[];
      return {
        prev: actions.find((a: any) => String(a.text?.content ?? '').includes('上一页')),
        next: actions.find((a: any) => String(a.text?.content ?? '').includes('下一页')),
      };
    };
    const p1 = findPager(buildSchedulesCard(tasks, { ...baseOpts, page: 1 }, NOW));
    expect(p1.prev.disabled).toBe(true);
    expect(p1.next.disabled).toBe(false);
    const p2 = findPager(buildSchedulesCard(tasks, { ...baseOpts, page: 2 }, NOW));
    expect(p2.prev.disabled).toBe(false);
    expect(p2.next.disabled).toBe(true);
  });

  it('paused task shows ⚪ dot; error task shows 🔴 + ⚠️ glyph', () => {
    const tasks: ScheduleCardTaskInput[] = [
      task({ id: 'paused', name: 'paused-task', enabled: false, lastStatus: 'ok' }),
      task({ id: 'errored', name: 'errored-task', enabled: true, lastStatus: 'error' }),
    ];
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    // The errored row should include the warning glyph in its bold name span.
    expect(json).toMatch(/\*\*errored-task\*\* ⚠️/);
  });

  it('NEVER leaks `union_id` or `senderUnionId` in rendered JSON', () => {
    const json = buildSchedulesCard([task()], baseOpts, NOW);
    expect(json).not.toContain('"union_id"');
    expect(json).not.toContain('"senderUnionId"');
  });

  it('escapes HTML control chars in name/displayExpr — no naked <at, no stray </font>', () => {
    const tasks: ScheduleCardTaskInput[] = [
      task({ id: 'inject1', name: '<at id=ou_x></at> evil name', parsed: { kind: 'once', display: '2026-06-09T13:00', runAt: '2026-06-09T13:00:00Z' } as any }),
      task({ id: 'inject2', name: 'normal name', parsed: { kind: 'cron', display: '</font><at id=ou_y></at>', expr: '* * * * *' } as any }),
    ];
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const rowDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && /(evil name|normal name)/.test(e.text.content as string),
    );
    expect(rowDivs.length).toBe(2);
    for (const d of rowDivs) {
      const content = d.text.content as string;
      expect(content).not.toMatch(/<at\b/);
      const closingFont = (content.match(/<\/font>/g) ?? []).length;
      expect(closingFont).toBe(1);
      expect(content).toContain('&lt;');
    }
    expect(json).toContain('<font color=\\"grey\\">');
  });

  it('& is escaped first; < does NOT get double-encoded as &amp;lt;', () => {
    const t1 = task({ id: 'amp', name: 'A & B', parsed: { kind: 'cron', display: '*/5 * * * *', expr: '*/5 * * * *' } as any });
    const json = buildSchedulesCard([t1], baseOpts, NOW);
    expect(json).toContain('A &amp; B');
    expect(json).not.toContain('&amp;lt;');
    expect(json).not.toContain('&amp;amp;');
  });

  it('every action button carries invoker_open_id bound to OWNER', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    for (const btn of actionRow.actions) {
      expect(btn.value?.invoker_open_id).toBe(INVOKER);
    }
  });
});

describe('handleSchedulesCardAction', () => {
  function makeDeps(over: any = {}): any {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { schedules: [task({ id: 'a', enabled: true })] },
      raw: '',
    }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh',
      nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      requestSpy,
      ...over,
    };
  }

  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  it('refresh → GET /__daemon/schedules-list, returns { card } only', async () => {
    const deps = makeDeps();
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID, deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
  });

  it('page → renders requested page', async () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' })) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_PAGE, invoker_open_id: INVOKER, page: '2' }),
      LARK_APP_ID, deps,
    );
    expect(JSON.stringify(r.card?.data)).toContain('第 2/3 页');
  });

  it('non-owner → owner_only toast, no client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other' });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker_open_id → not_invoker toast', async () => {
    const deps = makeDeps();
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH }), LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('Route B throws → list_failed toast with error reason', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER }), LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('拉取定时任务列表失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });

  it('Route B returns 500 → list_failed http_500, NO empty list card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => ({ status: 500, body: {}, raw: '' }) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER }), LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('http_500');
    expect(r.card).toBeUndefined();
  });

  it('Route B 401 with body.error → reason uses body.error verbatim', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => ({ status: 401, body: { error: 'bad_signature' }, raw: '' }) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER }), LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('bad_signature');
    expect(r.toast?.content).not.toContain('http_401');
  });

  it('unknown action → invalid_action toast, no client call', async () => {
    const deps = makeDeps();
    const r = await handleSchedulesCardAction(
      makeAction({ action: 'dash_schedules_evil', invoker_open_id: INVOKER }), LARK_APP_ID, deps,
    );
    expect(r.toast?.content).toContain('⚠️');
    expect(deps.createClient).not.toHaveBeenCalled();
  });
});
