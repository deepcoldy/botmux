/**
 * PR3 `/dashboard schedules` slice 1 + 2a — card builder + callback handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ScheduleCardTaskInput } from '../src/dashboard/schedule-card-model.js';
import { toScheduleDetailDto } from '../src/dashboard/schedule-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSchedulesCard,
  buildSchedulesDetailCard,
  handleSchedulesCardAction,
  SCHEDULES_ACTION_BACK_TO_LIST,
  SCHEDULES_ACTION_DELIVERY,
  SCHEDULES_ACTION_DETAIL,
  SCHEDULES_ACTION_PAGE,
  SCHEDULES_ACTION_PAUSE,
  SCHEDULES_ACTION_REFRESH,
  SCHEDULES_ACTION_RESUME,
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
    deliver: 'origin',
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
    expect(json).not.toContain('← 上');
    expect(json).not.toContain('下 →');
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

  it('pagination at >5 tasks; page=2 of 5 emits prev=1 / next=3', () => {
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    const tasks: ScheduleCardTaskInput[] = Array.from({ length: 25 }, (_, i) =>
      task({ id: `t_${i}`, name: `task-${i}`, enabled: true, nextRunAt: `2026-06-09T${String(13 + (i % 10)).padStart(2, '0')}:00:00.000Z` }),
    );
    const json = buildSchedulesCard(tasks, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('第 2/5 页');
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');
  });

  it('first/last page disable prev/next respectively', () => {
    // 8 tasks / PAGE_SIZE=5 = 2 pages → boundary test easy.
    const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const findPager = (json: string): { prev: any; next: any } => {
      const parsed = JSON.parse(json);
      // Slice 2a introduced per-row `📂 详情` action elements before the
      // pagination row, so we can't grab the first action; flatten across
      // all action elements and pick by button label instead.
      const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
      const allActions = actionRows.flatMap((r: any) => (r.actions as any[]) ?? []);
      return {
        prev: allActions.find((a: any) => String(a.text?.content ?? '').includes('← 上')),
        next: allActions.find((a: any) => String(a.text?.content ?? '').includes('下 →')),
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
    // The errored row should include the warning glyph after its bold name
    // (with the short-id badge between them).
    expect(json).toMatch(/\*\*errored-task\*\*.*⚠️/);
    // 🔴 status tone for the errored row's status dot.
    expect(json).toMatch(/🔴 \*\*errored-task\*\*/);
    // ⚪ tone for the paused row.
    expect(json).toMatch(/⚪ \*\*paused-task\*\*/);
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
      // 2 = one for the short-id badge after the name + one for the
      // secondary line. User-supplied text never injects extra `</font>`.
      expect(closingFont).toBe(2);
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

  // ─── Slice 2a per-row 📂 详情 button ─────────────────────────────────
  it('every list row carries an inline `📂 详情` button whose value.schedule_id matches that row', () => {
    const tasks: ScheduleCardTaskInput[] = [
      task({ id: 'sch_a', name: 'a', enabled: true }),
      task({ id: 'sch_b', name: 'b', enabled: true }),
      task({ id: 'sch_c', name: 'c', enabled: false }),
    ];
    const json = buildSchedulesCard(tasks, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const detailButtons = actionRows
      .flatMap((ar: any) => ar.actions ?? [])
      .filter((b: any) => b.value?.action === SCHEDULES_ACTION_DETAIL);
    expect(detailButtons.length).toBe(tasks.length);
    const seenIds = new Set(detailButtons.map((b: any) => b.value.schedule_id));
    expect(seenIds.has('sch_a')).toBe(true);
    expect(seenIds.has('sch_b')).toBe(true);
    expect(seenIds.has('sch_c')).toBe(true);
    for (const b of detailButtons) {
      expect(String(b.text?.content ?? '')).toContain('📂');
      expect(b.value.invoker_open_id).toBe(INVOKER);
      expect(b.value.page).toBe('1');
    }
  });

  /** ─── Overview drilldown ─── */
  describe('overview drilldown', () => {
    const NOW = Date.parse('2026-06-09T12:00:00.000Z');
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `sch_${i}`, name: `s${i}`, enabled: true, nextRunAt: `2026-06-09T13:0${i % 10}:00.000Z` }),
    );

    it('default PAGE_SIZE → 5 rows/page (standalone and drilldown unified 2026-06-10)', () => {
      const standalone = JSON.parse(buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1 }, NOW));
      const detailBtns = (parsed: any) => (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((a: any) => a.value?.action === SCHEDULES_ACTION_DETAIL);
      expect(detailBtns(standalone).length).toBe(5);
    });

    it('explicit pageSize override still works (caller can pick a different size)', () => {
      const overridden = JSON.parse(buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3 }, NOW));
      const detailBtns = (overridden.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((a: any) => a.value?.action === SCHEDULES_ACTION_DETAIL);
      expect(detailBtns.length).toBe(3);
    });

    it('origin=overview → footer renders "↩ 总览" with dash_overview_refresh', () => {
      const json = buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const allButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? []);
      const backBtn = allButtons.find((b: any) => b.value?.action === 'dash_overview_refresh');
      expect(backBtn).toBeDefined();
      expect(backBtn.value.invoker_open_id).toBe(INVOKER);
      expect(String(backBtn.text?.content ?? '')).toContain('↩ 总览');
    });

    it('standalone (no origin) → no back-to-overview button', () => {
      const json = buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1 }, NOW);
      expect(json).not.toContain('dash_overview_refresh');
    });

    it('origin=overview → every child button.value carries origin (page_size omitted at default)', () => {
      // After 2026-06-10 unification PAGE_SIZE=5 default. When drilldown
      // omits pageSize (or passes 5), effectivePageSize === PAGE_SIZE branch
      // → `page_size` is NOT threaded. Origin remains the canonical signal.
      const json = buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const childButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        expect(b.value.page_size).toBeUndefined();
      }
    });

    it('origin=overview + pageSize=3 (override) → button.value carries BOTH origin AND page_size', () => {
      const json = buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const childButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.origin).toBe('overview');
        expect(b.value.page_size).toBe('3');
      }
    });

    it('totalPages=3 (>2) → select_static jump-page appears, options=[1,2,3]', () => {
      const json = buildSchedulesCard(tasks, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 5, origin: 'overview' }, NOW);
      const parsed = JSON.parse(json);
      const selectStatic = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .find((a: any) => a.tag === 'select_static');
      expect(selectStatic).toBeDefined();
      expect(selectStatic.value.action).toBe(SCHEDULES_ACTION_PAGE);
      expect(selectStatic.options.map((o: any) => o.value)).toEqual(['1', '2', '3']);
    });

    it('totalPages>50 cap → NO select_static', () => {
      const many = Array.from({ length: 60 }, (_, i) => task({ id: `sch_x_${i}`, name: `s${i}` }));
      const json = buildSchedulesCard(many, { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 1, origin: 'overview' }, NOW);
      expect(json).not.toContain('select_static');
    });
  });

  /** ─── global-schedules slice (codex 2026-06-11) ────────────────────── */
  describe('global scope', () => {
    const NOW = Date.parse('2026-06-09T12:00:00.000Z');
    const mixedTasks = [
      task({ id: 'sch_claude', name: 'claude-job', enabled: true, larkAppId: 'cli_aa8f', botName: 'zkd-claude-bot' }),
      task({ id: 'sch_codex',  name: 'codex-job',  enabled: true, larkAppId: 'cli_aa80', botName: 'zkd-codex-bot' }),
    ];

    it('scope=global → every child button.value carries dashboard_scope=global', () => {
      const json = buildSchedulesCard(
        mixedTasks,
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, scope: 'global' },
        NOW,
      );
      const parsed = JSON.parse(json);
      const childButtons = (parsed.elements as any[])
        .filter((e: any) => e.tag === 'action')
        .flatMap((e: any) => e.actions ?? [])
        .filter((b: any) => b.value?.action !== 'dash_overview_refresh');
      for (const b of childButtons) {
        expect(b.value.dashboard_scope).toBe('global');
      }
    });

    it('scope=global → rows show bot label (botName)', () => {
      const json = buildSchedulesCard(
        mixedTasks,
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, scope: 'global' },
        NOW,
      );
      // Both bot labels surface so the user can tell rows apart.
      expect(json).toContain('zkd-claude-bot');
      expect(json).toContain('zkd-codex-bot');
    });

    it('scope=global → row missing botName falls back to bot:<larkAppId suffix>', () => {
      const onlyAppId = [task({ id: 'sch_x', name: 'noname-job', enabled: true, larkAppId: 'cli_aa8417992abbdcb0', botName: undefined })];
      const json = buildSchedulesCard(
        onlyAppId,
        { invokerOpenId: INVOKER, locale: 'zh', page: 1, scope: 'global' },
        NOW,
      );
      // Last 6 chars of the larkAppId: `bbdcb0`.
      expect(json).toContain('bot:bbdcb0');
    });

    it('no scope (per-bot default) → NO bot label rendered, NO dashboard_scope on values (back-compat)', () => {
      const json = buildSchedulesCard(
        mixedTasks,
        { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
        NOW,
      );
      expect(json).not.toContain('dashboard_scope');
      // The row shouldn't surface a bot label by default (per-bot view —
      // the bot is implicit). bot_label i18n inserts the "🤖" glyph.
      expect(json).not.toContain('🤖');
    });
  });
});

describe('buildSchedulesDetailCard (slice 2a)', () => {
  const NOW = Date.parse('2026-06-09T12:00:00.000Z');
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const };

  function detailFor(over: Partial<ScheduleCardTaskInput> = {}) {
    return toScheduleDetailDto(task(over), { nowMs: NOW });
  }

  it('renders the name (escaped) and id verbatim in the title', () => {
    const detail = detailFor({ id: 'sch_detail_123', name: 'my schedule', enabled: true });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    expect(json).toContain('定时任务详情');
    expect(json).toContain('my schedule');
    expect(json).toContain('sch_detail_123');
  });

  it('renders pause + resume + delivery + back buttons (all 4 present, invoker_open_id bound)', () => {
    const detail = detailFor({ id: 'sch_btns', enabled: true });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const acts = actionRow.actions as any[];
    const pause = acts.find(a => a.value?.action === SCHEDULES_ACTION_PAUSE);
    const resume = acts.find(a => a.value?.action === SCHEDULES_ACTION_RESUME);
    const delivery = acts.find(a => a.value?.action === SCHEDULES_ACTION_DELIVERY);
    const back = acts.find(a => a.value?.action === SCHEDULES_ACTION_BACK_TO_LIST);
    expect(pause).toBeDefined();
    expect(resume).toBeDefined();
    expect(delivery).toBeDefined();
    expect(back).toBeDefined();
    expect(pause.value.schedule_id).toBe('sch_btns');
    expect(resume.value.schedule_id).toBe('sch_btns');
    expect(delivery.value.schedule_id).toBe('sch_btns');
    expect(delivery.value.target_delivery).toBe('new-topic');
    expect(pause.value.invoker_open_id).toBe(INVOKER);
    expect(resume.value.invoker_open_id).toBe(INVOKER);
    expect(delivery.value.invoker_open_id).toBe(INVOKER);
    expect(back.value.invoker_open_id).toBe(INVOKER);
  });

  it('delivery=origin → shows current delivery and use-new-topic button', () => {
    const detail = detailFor({ id: 'sch_origin', deliver: 'origin' });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    expect(json).toContain('投递：原话题');
    expect(json).toContain('改为每次新话题');
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const delivery = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_DELIVERY,
    );
    expect(delivery.disabled).not.toBe(true);
    expect(delivery.value.target_delivery).toBe('new-topic');
  });

  it('scope=global → detail shows owning bot and chat', () => {
    const detail = detailFor({
      id: 'sch_global_detail',
      larkAppId: 'cli_aa80',
      botName: 'zkd-codex-bot',
      chatId: 'oc_global_chat',
    });
    const json = buildSchedulesDetailCard(detail, { ...baseOpts, scope: 'global' });
    expect(json).toContain('所属：zkd-codex-bot · oc\\\\_global\\\\_chat');
  });

  it('delivery=new-topic → shows current delivery and use-origin button', () => {
    const detail = detailFor({ id: 'sch_new_topic', deliver: 'new-topic' });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    expect(json).toContain('投递：每次新话题');
    expect(json).toContain('改为原话题');
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const delivery = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_DELIVERY,
    );
    expect(delivery.disabled).not.toBe(true);
    expect(delivery.value.target_delivery).toBe('origin');
  });

  it('delivery=local → shows local mode and disables delivery switch', () => {
    const detail = detailFor({ id: 'sch_local', deliver: 'local' });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    expect(json).toContain('投递：本地不发送');
    expect(json).toContain('本地投递模式不支持在卡片中切换');
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const delivery = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_DELIVERY,
    );
    expect(delivery.disabled).toBe(true);
  });

  it('enabled=true → pause enabled / resume disabled with alreadyEnabled note', () => {
    const detail = detailFor({ id: 'sch_enabled', enabled: true });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const pause = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_PAUSE,
    );
    const resume = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_RESUME,
    );
    // pause clickable (no disabled flag); resume disabled.
    expect(pause.disabled).not.toBe(true);
    expect(resume.disabled).toBe(true);
    // Reason note for resume disabled (mapped via mapResumeDisabledReason →
    // card.dashboard.schedules.resume.disabled.alreadyEnabled = '任务已启用').
    expect(json).toContain('任务已启用');
  });

  /** ─── Overview drilldown — detail actions propagate nav ─── */
  it('detail with origin=overview (default page size) → all actions carry origin (page_size omitted)', () => {
    // PAGE_SIZE=5 default after 2026-06-10. pageSize=5 == default → omitted.
    const detail = detailFor({ id: 'sch_nav', enabled: true });
    const json = buildSchedulesDetailCard(detail, { ...baseOpts, origin: 'overview', pageSize: 5 });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const acts = actionRow.actions as any[];
    for (const a of acts) {
      expect(a.value.origin).toBe('overview');
      expect(a.value.page_size).toBeUndefined();
    }
  });

  it('detail with origin=overview AND overridden pageSize=3 → all actions carry origin/page/page_size', () => {
    const detail = detailFor({ id: 'sch_override', enabled: true });
    const json = buildSchedulesDetailCard(detail, { ...baseOpts, origin: 'overview', pageSize: 3, sourcePage: 2 });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const acts = actionRow.actions as any[];
    for (const a of acts) {
      expect(a.value.origin).toBe('overview');
      expect(a.value.page).toBe('2');
      expect(a.value.page_size).toBe('3');
    }
  });

  it('detail without origin → no origin/page_size on values (no regression)', () => {
    const detail = detailFor({ id: 'sch_standalone', enabled: true });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_BACK_TO_LIST,
    );
    expect(back.value.origin).toBeUndefined();
    expect(back.value.page_size).toBeUndefined();
  });

  it('enabled=false → resume enabled / pause disabled with alreadyPaused note', () => {
    const detail = detailFor({ id: 'sch_paused', enabled: false });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const pause = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_PAUSE,
    );
    const resume = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === SCHEDULES_ACTION_RESUME,
    );
    expect(pause.disabled).toBe(true);
    expect(resume.disabled).not.toBe(true);
    // Reason note for pause disabled (mapped via mapPauseDisabledReason →
    // card.dashboard.schedules.pause.disabled.alreadyPaused = '任务已暂停').
    expect(json).toContain('任务已暂停');
  });

  it('escapes <at> / <font> injection in name so user-supplied chars cannot break the wrapper', () => {
    const detail = detailFor({
      id: 'sch_inject',
      name: '</font><at id=ou_evil></at> evil',
      enabled: true,
    });
    const json = buildSchedulesDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    // Find any div whose content references the (escaped) "evil" suffix.
    const evilDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && (e.text.content as string).includes('evil'),
    );
    expect(evilDivs.length).toBeGreaterThan(0);
    for (const d of evilDivs) {
      const content = d.text.content as string;
      // Raw `<at` must NOT appear anywhere (escaped form `&lt;at` is fine).
      expect(content).not.toMatch(/<at\b/);
      // `&lt;` must appear (escape took effect).
      expect(content).toContain('&lt;');
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

  it('second allowedUsers admin can refresh; rebuilt card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const deps = makeDeps({ getDashboardAdminOpenIds: () => [INVOKER, secondAdmin] });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: secondAdmin }, secondAdmin),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(r.card?.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  it('page → renders requested page', async () => {
    // PAGE_SIZE=5 → 25 / 5 = 5 pages.
    const tasks = Array.from({ length: 25 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' })) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_PAGE, invoker_open_id: INVOKER, page: '2' }),
      LARK_APP_ID, deps,
    );
    expect(JSON.stringify(r.card?.data)).toContain('第 2/5 页');
  });

  /** ─── Overview drilldown — handler nav propagation ─── */
  it('page via select_static option (no value.page) → handler reads action.option', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' })) } as any)),
    });
    const envelope = {
      operator: { open_id: INVOKER },
      action: {
        option: '3',
        value: { action: SCHEDULES_ACTION_PAGE, invoker_open_id: INVOKER, origin: 'overview', page_size: '5' },
      },
      context: { open_message_id: 'om_card' },
    } as any;
    const r = await handleSchedulesCardAction(envelope, LARK_APP_ID, deps);
    expect(JSON.stringify(r.card?.data)).toContain('第 3/3 页');
  });

  it('refresh with origin=overview → rebuilt list still has ↩ 总览 + 5/page', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' })) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_REFRESH, invoker_open_id: INVOKER, origin: 'overview', page_size: '5' }),
      LARK_APP_ID, deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 1/3 页');
    expect(cardJson).toContain('dash_overview_refresh');
    expect(cardJson).toContain('↩ 总览');
  });

  it('back_to_list with origin=overview → rebuilt list restores source page and drilldown shape', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t_${i}`, name: `task-${i}`, enabled: true }));
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' })) } as any)),
    });
    const r = await handleSchedulesCardAction(
      makeAction({ action: SCHEDULES_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER, origin: 'overview', page: '2', page_size: '5' }),
      LARK_APP_ID, deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 2/3 页');
    expect(cardJson).toContain('dash_overview_refresh');
  });

  it('non-admin → owner_only toast, no client call', async () => {
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

  // ─── Slice 2a: DETAIL ────────────────────────────────────────────────
  describe('action=dash_schedules_detail', () => {
    function makeDetailDeps(scheduleId = 'sch_a') {
      const tasks = [
        task({ id: scheduleId, name: 'visible schedule', enabled: true }),
        task({ id: 'sch_other', name: 'other', enabled: true }),
      ];
      const requestSpy = vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' }));
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
        requestSpy,
      };
    }

    it('happy: GET schedules-list and returns { card } detail body; no toast', async () => {
      const deps = makeDetailDeps('sch_a');
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(deps.requestSpy).toHaveBeenCalledOnce();
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('定时任务详情');
      // pause + resume + back action labels embedded
      expect(cardJson).toContain(SCHEDULES_ACTION_PAUSE);
      expect(cardJson).toContain(SCHEDULES_ACTION_RESUME);
      expect(cardJson).toContain(SCHEDULES_ACTION_BACK_TO_LIST);
      expect(cardJson).toContain('sch_a');
    });

    it('schedule_id not in list → toast schedule_not_found, no card', async () => {
      const deps = makeDetailDeps('sch_a');
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_ghost' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('定时任务不存在');
      expect(r.card).toBeUndefined();
    });

    it('non-admin → owner_only toast, no GET', async () => {
      const deps = { ...makeDetailDeps('sch_a'), getOwnerOpenId: () => 'ou_other' };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('missing invoker_open_id → not_invoker toast, no GET', async () => {
      const deps = makeDetailDeps('sch_a');
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no GET', async () => {
      const deps = makeDetailDeps('sch_a');
      const r = await handleSchedulesCardAction(
        makeAction(
          { action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_a' },
          'ou_stranger',
        ),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('Route B GET throws → toast list_failed (boom), no card', async () => {
      const deps = {
        createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps as any,
      );
      expect(r.toast?.content).toContain('拉取定时任务列表失败');
      expect(r.toast?.content).toContain('boom');
      expect(r.card).toBeUndefined();
    });

    it('Route B GET 500 → toast list_failed http_500, no card', async () => {
      const deps = {
        createClient: vi.fn(() => ({ request: async () => ({ status: 500, body: {}, raw: '' }) } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_DETAIL, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps as any,
      );
      expect(r.toast?.content).toContain('http_500');
      expect(r.card).toBeUndefined();
    });
  });

  // ─── Slice 2a: PAUSE ─────────────────────────────────────────────────
  describe('action=dash_schedules_pause', () => {
    function makePauseDeps(
      scheduleId = 'sch_a',
      enabled = true,
      postResp?: { status: number; body?: any },
    ) {
      const tasks = [task({ id: scheduleId, name: 'pause me', enabled })];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
          return { status: 200, body: { schedules: tasks }, raw: '' };
        }
        if (req.method === 'POST' && req.path.startsWith('/__daemon/schedules/')) {
          return postResp ?? { status: 200, body: { ok: true }, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
        requestSpy,
      };
    }

    it('happy: GET once + POST once + synth-detail (enabled=false), NO 3rd request, no toast', async () => {
      const deps = makePauseDeps('sch_a', true);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      // GET then POST — exactly 2 requests total (no second GET).
      expect(deps.requestSpy).toHaveBeenCalledTimes(2);
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/schedules/sch_a/pause' }),
      );
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      // synth-detail renders the paused state — paused icon + resume reason
      // note absent (because we just paused); the disabled pause button is
      // now rendered (with the alreadyPaused note string).
      expect(cardJson).toContain('定时任务详情');
      // disabled pause btn flag in rendered JSON
      expect(cardJson).toContain('"disabled":true');
      // alreadyPaused reason note copy.
      expect(cardJson).toContain('任务已暂停');
    });

    it('SECURITY: snapshot enabled=false → toast alreadyPaused, POST 0 times', async () => {
      const deps = makePauseDeps('sch_a', false);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('任务已暂停');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('POST 404 → toast pause_failed, no card', async () => {
      const deps = makePauseDeps('sch_a', true, { status: 404, body: { error: 'unknown_schedule' } });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('暂停失败');
      expect(r.toast?.content).toContain('unknown_schedule');
      expect(r.card).toBeUndefined();
    });

    it('POST 500 (no body.error) → toast pause_failed http_500, no card', async () => {
      const deps = makePauseDeps('sch_a', true, { status: 500, body: {} });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('暂停失败');
      expect(r.toast?.content).toContain('http_500');
      expect(r.card).toBeUndefined();
    });

    it('POST 200 with ok=false → toast pause_failed, no card', async () => {
      const deps = makePauseDeps('sch_a', true, { status: 200, body: { ok: false, error: 'not_found' } });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('暂停失败');
      expect(r.toast?.content).toContain('not_found');
      expect(r.card).toBeUndefined();
    });

    it('POST throws → toast pause_failed (err.message), no card', async () => {
      const tasks = [task({ id: 'sch_a', enabled: true })];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
          return { status: 200, body: { schedules: tasks }, raw: '' };
        }
        throw new Error('network down');
      });
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps as any,
      );
      expect(r.toast?.content).toContain('暂停失败');
      expect(r.toast?.content).toContain('network down');
      expect(r.card).toBeUndefined();
    });

    it('non-admin → owner_only toast, no POST', async () => {
      const deps = { ...makePauseDeps('sch_a', true), getOwnerOpenId: () => 'ou_other' };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(deps.requestSpy).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no POST', async () => {
      const deps = makePauseDeps('sch_a', true);
      const r = await handleSchedulesCardAction(
        makeAction(
          { action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_a' },
          'ou_stranger',
        ),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('pre-POST GET cannot find schedule → toast schedule_not_found, NO POST issued', async () => {
      const deps = makePauseDeps('sch_a', true);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_PAUSE, invoker_open_id: INVOKER, schedule_id: 'sch_GHOST' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('定时任务不存在');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });
  });

  // ─── Slice 2a: RESUME (mirror of pause) ──────────────────────────────
  describe('action=dash_schedules_resume', () => {
    function makeResumeDeps(
      scheduleId = 'sch_a',
      enabled = false,
      postResp?: { status: number; body?: any },
      postRefetchTasks?: ScheduleCardTaskInput[],
    ) {
      const initial = [task({ id: scheduleId, name: 'resume me', enabled })];
      let getCalls = 0;
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
          getCalls += 1;
          // First GET = pre-POST snapshot, second GET = refresh after resume.
          if (getCalls === 1) return { status: 200, body: { schedules: initial }, raw: '' };
          return { status: 200, body: { schedules: postRefetchTasks ?? initial.map(t => ({ ...t, enabled: true })) }, raw: '' };
        }
        if (req.method === 'POST' && req.path.startsWith('/__daemon/schedules/')) {
          return postResp ?? { status: 200, body: { ok: true }, raw: '' };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
        requestSpy,
      };
    }

    it('happy: GET + POST + refetch GET, enabled=true detail returned, no toast', async () => {
      const deps = makeResumeDeps('sch_a', false);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      // For resume, the handler does an extra GET to pick up the fresh
      // nextRunAt computed by the scheduler. Order: GET → POST → GET.
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/schedules/sch_a/resume' }),
      );
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('定时任务详情');
      // resume disabled note → 已启用 (because we just resumed)
      expect(cardJson).toContain('任务已启用');
    });

    it('SECURITY: snapshot enabled=true → toast alreadyEnabled, POST 0 times', async () => {
      const deps = makeResumeDeps('sch_a', true);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('任务已启用');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('POST 404 → toast resume_failed, no card', async () => {
      const deps = makeResumeDeps('sch_a', false, { status: 404, body: { error: 'unknown_schedule' } });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('恢复失败');
      expect(r.toast?.content).toContain('unknown_schedule');
      expect(r.card).toBeUndefined();
    });

    it('POST 500 → toast resume_failed http_500, no card', async () => {
      const deps = makeResumeDeps('sch_a', false, { status: 500, body: {} });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('恢复失败');
      expect(r.toast?.content).toContain('http_500');
      expect(r.card).toBeUndefined();
    });

    it('POST 200 with ok=false → toast resume_failed, no refetch or success redraw', async () => {
      const deps = makeResumeDeps('sch_a', false, { status: 200, body: { ok: false, error: 'not_found' } });
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('恢复失败');
      expect(r.toast?.content).toContain('not_found');
      expect(r.card).toBeUndefined();
      expect(deps.requestSpy.mock.calls.map((c: any[]) => c[0].method)).toEqual(['GET', 'POST']);
    });

    it('POST throws → toast resume_failed (err.message), no card', async () => {
      const tasks = [task({ id: 'sch_a', enabled: false })];
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
          return { status: 200, body: { schedules: tasks }, raw: '' };
        }
        throw new Error('network down');
      });
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps as any,
      );
      expect(r.toast?.content).toContain('恢复失败');
      expect(r.toast?.content).toContain('network down');
      expect(r.card).toBeUndefined();
    });

    it('non-admin → toast, no POST issued', async () => {
      const deps = { ...makeResumeDeps('sch_a', false), getOwnerOpenId: () => 'ou_other' };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('invoker mismatch → toast, no POST', async () => {
      const deps = makeResumeDeps('sch_a', false);
      const r = await handleSchedulesCardAction(
        makeAction(
          { action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_a' },
          'ou_stranger',
        ),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('pre-POST GET cannot find schedule → toast schedule_not_found, NO POST issued', async () => {
      const deps = makeResumeDeps('sch_a', false);
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_RESUME, invoker_open_id: INVOKER, schedule_id: 'sch_GHOST' }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('定时任务不存在');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });
  });

  // ─── Slice 2b: DELIVERY (origin ↔ new-topic) ─────────────────────────
  describe('action=dash_schedules_delivery', () => {
    function makeDeliveryDeps(
      scheduleId = 'sch_a',
      deliver: ScheduleCardTaskInput['deliver'] = 'origin',
      postResp?: { status: number; body?: any },
      postRefetchTasks?: ScheduleCardTaskInput[],
    ) {
      const initial = [task({ id: scheduleId, name: 'delivery me', deliver })];
      let getCalls = 0;
      const requestSpy = vi.fn(async (req: any) => {
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
          getCalls += 1;
          if (getCalls === 1) return { status: 200, body: { schedules: initial }, raw: '' };
          return {
            status: 200,
            body: {
              schedules: postRefetchTasks ?? initial.map(t => ({
                ...t,
                deliver: t.deliver === 'new-topic' ? 'origin' : 'new-topic',
              })),
            },
            raw: '',
          };
        }
        if (req.method === 'GET' && req.path === '/__daemon/schedules-list?scope=global') {
          getCalls += 1;
          if (getCalls === 1) return { status: 200, body: { schedules: initial }, raw: '' };
          return {
            status: 200,
            body: {
              schedules: postRefetchTasks ?? initial.map(t => ({
                ...t,
                deliver: t.deliver === 'new-topic' ? 'origin' : 'new-topic',
              })),
            },
            raw: '',
          };
        }
        if (req.method === 'POST' && req.path.startsWith('/__daemon/schedules/')) {
          return postResp ?? {
            status: 200,
            body: { ok: true, deliver: deliver === 'new-topic' ? 'origin' : 'new-topic' },
            raw: '',
          };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      return {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
        requestSpy,
      };
    }

    it('origin → POST delivery + refetch, card shows new-topic state', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/schedules/sch_a/delivery' }),
      );
      expect(deps.requestSpy.mock.calls[2][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(r.toast).toBeUndefined();
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('投递：每次新话题');
      expect(cardJson).toContain('改为原话题');
    });

    it('new-topic → POST delivery + refetch, card shows origin state', async () => {
      const deps = makeDeliveryDeps('sch_a', 'new-topic');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'origin',
        }),
        LARK_APP_ID, deps,
      );
      expect(deps.requestSpy.mock.calls[1][0]).toEqual(
        expect.objectContaining({ method: 'POST', path: '/__daemon/schedules/sch_a/delivery' }),
      );
      expect(r.toast).toBeUndefined();
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('投递：原话题');
      expect(cardJson).toContain('改为每次新话题');
    });

    it('scope=global → GET/POST/refetch all keep ?scope=global', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
          dashboard_scope: 'global',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast).toBeUndefined();
      expect(deps.requestSpy.mock.calls.map((c: any[]) => c[0].path)).toEqual([
        '/__daemon/schedules-list?scope=global',
        '/__daemon/schedules/sch_a/delivery?scope=global',
        '/__daemon/schedules-list?scope=global',
      ]);
    });

    it('snapshot already at target → toast alreadyNewTopic, POST 0 times', async () => {
      const deps = makeDeliveryDeps('sch_a', 'new-topic');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('已是每次新话题投递');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('snapshot local → toast local disabled, POST 0 times', async () => {
      const deps = makeDeliveryDeps('sch_a', 'local');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('本地投递模式不支持');
      expect(r.card).toBeUndefined();
      const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('invalid target_delivery → invalid_action toast, no GET/POST', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin');
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'local',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('⚠️');
      expect(r.card).toBeUndefined();
      expect(deps.requestSpy).not.toHaveBeenCalled();
    });

    it('POST 500 → toast delivery_failed, no card', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin', { status: 500, body: { error: 'delivery_boom' } });
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('修改投递方式失败');
      expect(r.toast?.content).toContain('delivery_boom');
      expect(r.card).toBeUndefined();
    });

    it('POST 200 with ok=false → toast delivery_failed, no refetch or success redraw', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin', { status: 200, body: { ok: false, error: 'local_not_toggleable' } });
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast?.content).toContain('修改投递方式失败');
      expect(r.toast?.content).toContain('local_not_toggleable');
      expect(r.card).toBeUndefined();
      expect(deps.requestSpy.mock.calls.map((c: any[]) => c[0].method)).toEqual(['GET', 'POST']);
    });

    it('refetch missing after successful POST → fallback synth renders target delivery', async () => {
      const deps = makeDeliveryDeps('sch_a', 'origin', { status: 200, body: { ok: true, deliver: 'new-topic' } }, []);
      const r = await handleSchedulesCardAction(
        makeAction({
          action: SCHEDULES_ACTION_DELIVERY,
          invoker_open_id: INVOKER,
          schedule_id: 'sch_a',
          target_delivery: 'new-topic',
        }),
        LARK_APP_ID, deps,
      );
      expect(r.toast).toBeUndefined();
      expect(JSON.stringify(r.card?.data)).toContain('投递：每次新话题');
    });
  });

  // ─── Slice 2a: BACK TO LIST ─────────────────────────────────────────
  describe('action=dash_schedules_back_to_list', () => {
    it('GET schedules-list → returns { card } with list card body at source page', async () => {
      const tasks = Array.from({ length: 25 }, (_, i) =>
        task({ id: `t_${i}`, name: `task-${i}`, enabled: true }),
      );
      const requestSpy = vi.fn(async () => ({ status: 200, body: { schedules: tasks }, raw: '' }));
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => INVOKER,
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER, page: '4' }),
        LARK_APP_ID, deps as any,
      );
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list' });
      expect(r.toast).toBeUndefined();
      expect(r.card?.type).toBe('raw');
      const cardJson = JSON.stringify(r.card?.data);
      expect(cardJson).toContain('Dashboard 定时任务');
      // Source page 4 of 5 pages (25 / 5; PAGE_SIZE=5 after 2026-06-10 unification).
      expect(cardJson).toContain('第 4/5 页');
    });

    it('non-admin → toast, no GET', async () => {
      const requestSpy = vi.fn();
      const deps = {
        createClient: vi.fn(() => ({ request: requestSpy } as any)),
        getOwnerOpenId: () => 'ou_other',
        locale: 'zh' as const,
        nowMs: () => Date.parse('2026-06-09T12:00:00.000Z'),
      };
      const r = await handleSchedulesCardAction(
        makeAction({ action: SCHEDULES_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER }),
        LARK_APP_ID, deps as any,
      );
      expect(r.toast?.content).toContain('🔒');
      expect(r.card).toBeUndefined();
      expect(deps.createClient).not.toHaveBeenCalled();
    });
  });
});
