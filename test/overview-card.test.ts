/**
 * PR3 `/dashboard overview` slice 1 — card builder + callback handler tests.
 *
 * Mirrors the structure of sessions-card.test.ts / schedules-card.test.ts:
 * pure builder assertions for empty / populated / escape / identity, plus
 * a fully-isolated handler suite covering refresh/goto/error paths.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import type { ScheduleCardTaskInput } from '../src/dashboard/schedule-card-model.js';
import type { DashboardSettingsInput } from '../src/dashboard/settings-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildOverviewCard,
  countSessions,
  handleOverviewCardAction,
  OVERVIEW_ACTION_REFRESH,
  OVERVIEW_ACTION_GOTO_SESSIONS,
  OVERVIEW_ACTION_GOTO_SCHEDULES,
  OVERVIEW_ACTION_GOTO_SETTINGS,
  OVERVIEW_ACTION_GOTO_GROUPS,
} from '../src/im/lark/overview-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

function makeSettings(over: Partial<DashboardSettingsInput> = {}): DashboardSettingsInput {
  return {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
    ...over,
  } as DashboardSettingsInput;
}

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'sess_default',
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    chatType: 'group',
    title: 'default session',
    cliId: 'claude-code',
    workingDir: '~/work',
    status: 'idle',
    lastMessageAt: 1_000_000,
    cliVersion: 'unknown',
    webPort: 7891,
    scope: 'thread',
    spawnedAt: 0,
    larkAppId: LARK_APP_ID,
    isOncall: false,
    hasHistory: true,
    ...over,
  } as SessionRow;
}

function scheduleTask(over: Partial<ScheduleCardTaskInput> = {}): ScheduleCardTaskInput {
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

describe('buildOverviewCard', () => {
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const };

  it('empty data → renders the empty (zero-count) state + refresh button present', () => {
    const json = buildOverviewCard({ sessions: [], schedules: [], settings: makeSettings() }, baseOpts);
    expect(json).toContain('Dashboard 总览');
    // Zero-count summary still renders (active 0 / idle 0 / closed 0).
    expect(json).toContain('活跃 0');
    expect(json).toContain('空闲 0');
    expect(json).toContain('关闭 0');
    expect(json).toContain('启用 0');
    expect(json).toContain('暂停 0');
    // Refresh button always present.
    expect(json).toContain(OVERVIEW_ACTION_REFRESH);
  });

  it('populated data → rendered summary numbers correct', () => {
    const sessions: SessionRow[] = [
      sessionRow({ sessionId: 's1', status: 'working' }),
      sessionRow({ sessionId: 's2', status: 'analyzing' }),
      sessionRow({ sessionId: 's3', status: 'idle' }),
      sessionRow({ sessionId: 's4', status: 'idle' }),
      sessionRow({ sessionId: 's5', status: 'closed' }),
    ];
    const schedules: ScheduleCardTaskInput[] = [
      scheduleTask({ id: 'a', enabled: true, lastStatus: 'ok' }),
      scheduleTask({ id: 'b', enabled: true, lastStatus: 'error' }),
      scheduleTask({ id: 'c', enabled: true, lastStatus: 'error' }),
      scheduleTask({ id: 'd', enabled: false }),
    ];
    const json = buildOverviewCard(
      { sessions, schedules, settings: makeSettings({ publicReadOnly: true, openTerminalInFeishu: true }) },
      baseOpts,
    );
    // Sessions: working+analyzing → 2 active; 2 idle; 1 closed.
    expect(json).toContain('活跃 2');
    expect(json).toContain('空闲 2');
    expect(json).toContain('关闭 1');
    // Schedules: 3 enabled (2 errored), 1 paused.
    expect(json).toContain('启用 3');
    expect(json).toContain('暂停 1');
    expect(json).toContain('上次错误 2');
    // Settings summary line shows ON labels.
    expect(json).toContain('公开只读已开启');
    expect(json).toContain('终端在飞书内打开');
  });

  it('counts dormant sessions as idle, not active', () => {
    expect(countSessions([
      sessionRow({ sessionId: 's1', status: 'dormant' }),
      sessionRow({ sessionId: 's2', status: 'starting' }),
      sessionRow({ sessionId: 's3', status: 'closed' }),
    ])).toEqual({ active: 1, idle: 1, closed: 1 });
  });

  it('zh overview localizes all module sections and folder buttons', () => {
    const json = buildOverviewCard(
      { sessions: [], schedules: [], settings: makeSettings() },
      baseOpts,
    );
    const parsed = JSON.parse(json);
    const visible = JSON.stringify(parsed);
    expect(visible).toContain('🖥️ 会话');
    expect(visible).toContain('📂 会话列表');
    expect(visible).toContain('⏰ 定时任务');
    expect(visible).toContain('📂 定时任务');
    expect(visible).toContain('⚙️ 设置');
    expect(visible).toContain('📂 设置');
    expect(visible).toContain('🧑‍🤝‍🧑 群组');
    expect(visible).toContain('📂 群组');
    expect(visible).not.toContain('工作流');
  });

  // codex 2026-06-09 blocker: a paused task with lastStatus='error' must
  // also count toward `上次错误`. Otherwise overview under-reports while the
  // schedules list-card still draws ⚠️ on the same paused row — that
  // mismatch is the bug.
  it('paused tasks with lastStatus=error are counted in 上次错误 (overview must NOT undercount vs schedules list)', () => {
    const schedules: ScheduleCardTaskInput[] = [
      scheduleTask({ id: 'a', enabled: true, lastStatus: 'ok' }),
      scheduleTask({ id: 'b', enabled: true, lastStatus: 'error' }),
      scheduleTask({ id: 'c', enabled: false, lastStatus: 'error' }),  // paused + errored
      scheduleTask({ id: 'd', enabled: false, lastStatus: 'ok' }),
    ];
    const json = buildOverviewCard(
      { sessions: [], schedules, settings: makeSettings() },
      baseOpts,
    );
    expect(json).toContain('启用 2');
    expect(json).toContain('暂停 2');
    // Both errored rows count, regardless of enabled state.
    expect(json).toContain('上次错误 2');
  });

  it('escape: name/displayExpr injection in settings summary still escaped (no naked <at, exactly correct closing </font> count)', () => {
    // Inject HTML-control text via the maintenance.autoUpdate.time path —
    // the field is sanity-validated to 04:00 default, so injection lands in
    // the formatted time. Layered defense: even if all path-validation
    // bypasses, the renderer escapes user-controlled text BEFORE wrapping
    // it in <font color="grey">…</font>.
    const settings = makeSettings({
      maintenance: {
        autoUpdate: { enabled: true, time: '</font><at id=ou_x></at>' as any },
      } as any,
    });
    const json = buildOverviewCard(
      { sessions: [], schedules: [], settings },
      baseOpts,
    );
    const parsed = JSON.parse(json);
    // Find the settings section <div> (we look for content containing
    // "设置" — header-style bold).
    const settingsDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string'
        && /(自动更新|公开只读|终端)/.test(e.text.content as string),
    );
    expect(settingsDivs.length).toBeGreaterThan(0);
    for (const d of settingsDivs) {
      const content = d.text.content as string;
      // Even with the injection, no NAKED `<at` allowed.
      expect(content).not.toMatch(/<at\b/);
      // Each settings section emits exactly ONE outer `<font color="grey">…</font>` wrapper.
      const closingFontCount = (content.match(/<\/font>/g) ?? []).length;
      expect(closingFontCount).toBe(1);
    }
    // Outer grey wrapper still present in escaped JSON (`<font color=\"grey\">`).
    expect(json).toContain('<font color=\\"grey\\">');
  });

  it('every action button carries invoker_open_id bound to OWNER', () => {
    const json = buildOverviewCard(
      { sessions: [sessionRow()], schedules: [scheduleTask()], settings: makeSettings() },
      baseOpts,
    );
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    // 5 action rows: goto-sessions, goto-schedules, goto-settings,
    // goto-groups, footer refresh.
    expect(actionRows.length).toBe(5);
    let buttonCount = 0;
    for (const row of actionRows) {
      for (const btn of (row.actions as any[])) {
        buttonCount += 1;
        expect(btn.value?.invoker_open_id).toBe(INVOKER);
      }
    }
    // Each action row has exactly one button in slice 1.
    expect(buttonCount).toBe(5);
  });

  it('action.value carries action + invoker_open_id and NOTHING identity-like', () => {
    const json = buildOverviewCard(
      { sessions: [], schedules: [], settings: makeSettings() },
      baseOpts,
    );
    expect(json).not.toContain('"union_id"');
    expect(json).not.toContain('"senderUnionId"');
    expect(json).not.toContain('"user_id"');
    expect(json).not.toContain('"owner_id"');
    // Only `invoker_open_id`, never raw `open_id`.
    expect(json).not.toContain('"open_id"');
    // All overview navigation actions appear in the rendered JSON.
    expect(json).toContain(OVERVIEW_ACTION_REFRESH);
    expect(json).toContain(OVERVIEW_ACTION_GOTO_SESSIONS);
    expect(json).toContain(OVERVIEW_ACTION_GOTO_SCHEDULES);
    expect(json).toContain(OVERVIEW_ACTION_GOTO_SETTINGS);
    expect(json).toContain(OVERVIEW_ACTION_GOTO_GROUPS);
  });
});

describe('handleOverviewCardAction', () => {
  function makeDeps(over: any = {}): any {
    const overviewBody = {
      sessions: [sessionRow({ sessionId: 's1', status: 'working' })],
      schedules: [scheduleTask({ id: 'a', enabled: true })],
      settings: makeSettings(),
    };
    const requestSpy = vi.fn(async (req: any) => {
      if (req.path === '/__daemon/overview-snapshot' || req.path === '/__daemon/overview-snapshot?scope=global') {
        return { status: 200, body: overviewBody, raw: '' };
      }
      if (req.path === '/__daemon/sessions-list' || req.path === '/__daemon/sessions-list?scope=global') {
        return { status: 200, body: { sessions: [sessionRow()] }, raw: '' };
      }
      if (req.path === '/__daemon/schedules-list' || req.path === '/__daemon/schedules-list?scope=global') {
        return { status: 200, body: { schedules: [scheduleTask()] }, raw: '' };
      }
      if (req.path === '/__daemon/settings-snapshot') {
        return { status: 200, body: { settings: makeSettings() }, raw: '' };
      }
      if (req.path === '/__daemon/groups-matrix' || req.path === '/__daemon/groups-matrix?scope=global') {
        return { status: 200, body: { chats: [], bots: [] }, raw: '' };
      }
      return { status: 404, body: {}, raw: '' };
    });
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh',
      nowMs: () => 2_000_000,
      requestSpy,
      ...over,
    };
  }

  function makeAction(value: Record<string, string>, operator: string | undefined = INVOKER): CardActionData {
    return {
      operator: operator === undefined ? {} : { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  it('refresh → GET /__daemon/overview-snapshot, returns { card } only (no toast)', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    // Global dashboard scope: overview-snapshot is requested with
    // `?scope=global` so list modules surface cross-bot rows.
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/overview-snapshot?scope=global' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // Result is an overview card (has the overview title).
    expect(cardJson).toContain('Dashboard 总览');
  });

  it('goto_sessions → GET /__daemon/sessions-list, returns sessions card as { card }', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_GOTO_SESSIONS, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // Target card is the sessions list (not overview).
    expect(cardJson).toContain('Dashboard 会话');
  });

  it('second allowedUsers admin can drill down; child card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const deps = makeDeps({ getDashboardAdminOpenIds: () => [INVOKER, secondAdmin] });
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_GOTO_SESSIONS, invoker_open_id: secondAdmin }, secondAdmin),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
    expect(JSON.stringify(r.card?.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  it('goto_schedules → GET /__daemon/schedules-list, returns schedules card as { card }', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_GOTO_SCHEDULES, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list?scope=global' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('Dashboard 定时任务');
  });

  it('goto_settings → GET /__daemon/settings-snapshot, returns settings card as { card }', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_GOTO_SETTINGS, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/settings-snapshot' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('Dashboard 全局设置');
  });

  it('non-admin → owner_only toast (lock), no client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other_owner' });
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker_open_id → not_invoker toast, no client call', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('invoker mismatch (operator !== invoker_open_id) → not_invoker toast, no client call', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }, 'ou_stranger'),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('Route B throws → overview_failed toast with the error reason', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
    });
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('拉取总览快照失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });

  it('Route B returns 500 → overview_failed http_500, NO card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => ({ status: 500, body: {}, raw: '' }) } as any)),
    });
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('http_500');
    expect(r.card).toBeUndefined();
  });

  it('Route B 401 with body.error → reason uses body.error verbatim', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: async () => ({ status: 401, body: { error: 'bad_signature' }, raw: '' }),
      } as any)),
    });
    const r = await handleOverviewCardAction(
      makeAction({ action: OVERVIEW_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('bad_signature');
    expect(r.toast?.content).not.toContain('http_401');
  });

  it('unknown action → invalid_action toast, no client call', async () => {
    const deps = makeDeps();
    const r = await handleOverviewCardAction(
      makeAction({ action: 'dash_overview_evil', invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    // Same fallthrough as settings: invalid_action carries the ⚠️ glyph.
    expect(r.toast?.content).toContain('⚠️');
    // The handler still gets to create a client (admin gate passed), but it
    // should NOT make any HTTP request for an unknown action.
    expect(deps.requestSpy).not.toHaveBeenCalled();
  });
});
