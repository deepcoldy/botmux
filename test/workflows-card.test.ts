/**
 * PR3 `/dashboard workflows` slice 1 + slice 2a — card builder + callback handler tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  computeActionAvailability,
  projectRunDetailDto,
  type WorkflowRunDetailInput,
  type WorkflowRunInput,
} from '../src/dashboard/workflow-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildWorkflowsCard,
  buildWorkflowsDetailCard,
  handleWorkflowsCardAction,
  WORKFLOWS_ACTION_BACK_TO_LIST,
  WORKFLOWS_ACTION_CANCEL,
  WORKFLOWS_ACTION_DETAIL,
  WORKFLOWS_ACTION_PAGE,
  WORKFLOWS_ACTION_REFRESH,
} from '../src/im/lark/workflows-card.js';

const INVOKER = 'ou_owner';
const LARK_APP_ID = 'cli_test';

function run(over: Partial<WorkflowRunInput> = {}): WorkflowRunInput {
  return {
    runId: 'r_default',
    workflowId: 'wf_default',
    status: 'running',
    startedAt: 1_000_000,
    updatedAt: 1_500_000,
    nodesDone: 1,
    nodesTotal: 3,
    ...over,
  };
}

describe('buildWorkflowsCard', () => {
  const NOW = 2_000_000;
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, page: 1 };

  it('empty list → renders the empty state, no pagination, refresh button still present', () => {
    const json = buildWorkflowsCard([], baseOpts, NOW);
    expect(json).toContain('Dashboard 工作流');
    expect(json).toContain('_当前没有工作流运行_');
    // Pagination buttons absent on single page (no rows).
    expect(json).not.toContain('← 上');
    expect(json).not.toContain('下 →');
    // Refresh button always present.
    expect(json).toContain(WORKFLOWS_ACTION_REFRESH);
  });

  it('preserves the server-side listRuns order verbatim (no client-side resort)', () => {
    // codex 2026-06-09: workflows slice 1 MUST NOT introduce its own sort.
    // The dashboard web UI already consumes /api/workflows/runs in the
    // canonical order returned by listRuns, and the card should match.
    // workflowIds avoid underscores so we can grep without markdown escape
    // tripping us.
    const rows: WorkflowRunInput[] = [
      run({ runId: 'rA', workflowId: 'wfA', status: 'succeeded', startedAt: 100 }),
      run({ runId: 'rB', workflowId: 'wfB', status: 'waiting', startedAt: 900 }),
      run({ runId: 'rC', workflowId: 'wfC', status: 'running', startedAt: 200 }),
      run({ runId: 'rD', workflowId: 'wfD', status: 'failed', startedAt: 800 }),
    ];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    const idx = (s: string) => json.indexOf(s);
    // Render order MUST match input order (no rank-based sort).
    expect(idx('wfA')).toBeGreaterThan(0);
    expect(idx('wfA')).toBeLessThan(idx('wfB'));
    expect(idx('wfB')).toBeLessThan(idx('wfC'));
    expect(idx('wfC')).toBeLessThan(idx('wfD'));
  });

  it('count summary: 进行中 N · 完成 M · 失败 K · page indicator (running = pending|running|waiting, done = succeeded, failed = failed|cancelled)', () => {
    // 7 rows / PAGE_SIZE=5 = 2 pages (unified 2026-06-10).
    const rows: WorkflowRunInput[] = [
      run({ runId: 'a', status: 'running' }),
      run({ runId: 'b', status: 'waiting' }),
      run({ runId: 'c', status: 'pending' }),
      run({ runId: 'd', status: 'succeeded' }),
      run({ runId: 'e', status: 'succeeded' }),
      run({ runId: 'f', status: 'failed' }),
      run({ runId: 'g', status: 'cancelled' }),
    ];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    expect(json).toContain('进行中 3');
    expect(json).toContain('完成 2');
    expect(json).toContain('失败 2');
    expect(json).toContain('第 1/2 页');
  });

  it('pagination: > 5 rows → prev/next; page=2 of 5 with 25 rows', () => {
    // PAGE_SIZE=5 → 25 / 5 = 5 pages.
    const rows: WorkflowRunInput[] = Array.from({ length: 25 }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running', startedAt: 1_000 - i }),
    );
    const json = buildWorkflowsCard(rows, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('← 上');
    expect(json).toContain('下 →');
    expect(json).toContain('第 2/5 页');
    // prev → 1, next → 3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');

    const findPagerButtons = (j: string): { prev: any; next: any } => {
      const parsed = JSON.parse(j);
      // Slice 2a introduced per-row `📂 详情` action elements before the
      // pagination row, so we can't grab the first action; flatten across
      // all action elements and pick by button label instead.
      const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
      const allActions = actionRows.flatMap((r: any) => (r.actions as any[]) ?? []);
      const prev = allActions.find((a: any) => String(a.text?.content ?? '').includes('← 上'));
      const next = allActions.find((a: any) => String(a.text?.content ?? '').includes('下 →'));
      return { prev, next };
    };

    // On page=1, prev disabled
    const page1 = buildWorkflowsCard(rows, { ...baseOpts, page: 1 }, NOW);
    const { prev: p1prev, next: p1next } = findPagerButtons(page1);
    expect(p1prev.disabled).toBe(true);
    expect(p1next.disabled).toBe(false);

    // On page=5 (last), next disabled
    const page5 = buildWorkflowsCard(rows, { ...baseOpts, page: 5 }, NOW);
    const { prev: p5prev, next: p5next } = findPagerButtons(page5);
    expect(p5prev.disabled).toBe(false);
    expect(p5next.disabled).toBe(true);
  });

  it('escapes HTML control chars in workflowId / runId — no naked <at, exactly correct closing </font> count', () => {
    const rows: WorkflowRunInput[] = [
      run({
        runId: '<at id=ou_evil></at>',
        workflowId: '<at id=ou_x></at>',
        status: 'running',
        nodesDone: 1, nodesTotal: 3,
      }),
      run({
        runId: 'r_safe',
        workflowId: '</font><at id=ou_y></at>',
        status: 'failed',
        nodesDone: 1, nodesTotal: 1,
      }),
    ];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const rowDivs = (parsed.elements as any[]).filter((e: any) =>
      e.tag === 'div' && typeof e.text?.content === 'string' &&
      /(&lt;at|wf_default)/.test(e.text.content as string),
    );
    expect(rowDivs.length).toBeGreaterThanOrEqual(2);
    for (const d of rowDivs) {
      const content = d.text.content as string;
      expect(content).not.toMatch(/<at\b/);
      // Each row that emits the grey wrapper has exactly one closing </font>.
      const closingFontCount = (content.match(/<\/font>/g) ?? []).length;
      expect(closingFontCount).toBeLessThanOrEqual(1);
      expect(content).toContain('&lt;');
    }
  });

  it('escape order — `&` is escaped first so `<` does NOT become `&amp;lt;`', () => {
    const rows: WorkflowRunInput[] = [
      run({ runId: 'r_amp', workflowId: 'A & B<x>', status: 'running' }),
    ];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    expect(json).toContain('A &amp; B');
    expect(json).not.toContain('&amp;lt;');
    expect(json).not.toContain('&amp;amp;');
  });

  it('every action button carries invoker_open_id bound to the OWNER', () => {
    const rows: WorkflowRunInput[] = Array.from({ length: 15 }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running' }),
    );
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const elements = parsed.elements as any[];
    const actionRow = elements.find((e: any) => e.tag === 'action');
    expect(actionRow).toBeDefined();
    for (const btn of actionRow.actions) {
      expect(btn.value?.invoker_open_id).toBe(INVOKER);
    }
  });

  it('NEVER leaks `union_id` or `senderUnionId` in the rendered JSON', () => {
    const rows: WorkflowRunInput[] = [run({ status: 'running' })];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    expect(json).not.toContain('"union_id"');
    expect(json).not.toContain('"senderUnionId"');
  });
});

describe('handleWorkflowsCardAction', () => {
  function makeDeps(over: any = {}): any {
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { runs: [run({ runId: 'r1', workflowId: 'wf_one', status: 'running' })] },
      raw: '',
    }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh',
      nowMs: () => 2_000_000,
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

  it('refresh → GET /__daemon/workflows-runs-snapshot?all=1, returns { card } only (no toast)', async () => {
    const deps = makeDeps();
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    // codex 2026-06-09 blocker: ?all=1 is required so the response includes
    // terminal runs; otherwise the card's done/failed counts are empty.
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/workflows-runs-snapshot?all=1' });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
  });

  it('refresh with dashboard_scope=global → GET ?all=1&scope=global and keeps scope on rebuilt card', async () => {
    const deps = makeDeps();
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER, dashboard_scope: 'global' }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1&scope=global',
    });
    expect(JSON.stringify(r.card?.data)).toContain('"dashboard_scope":"global"');
  });

  it('second allowedUsers admin can refresh; rebuilt card keeps that admin as invoker', async () => {
    const secondAdmin = 'ou_second_admin';
    const deps = makeDeps({ getDashboardAdminOpenIds: () => [INVOKER, secondAdmin] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: secondAdmin }, secondAdmin),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(r.card?.data)).toContain(`"invoker_open_id":"${secondAdmin}"`);
  });

  it('page=2 with 25 rows → 第 2/5 页', async () => {
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    const rows = Array.from({ length: 25 }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running', startedAt: 1_000 - i }),
    );
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: vi.fn(async () => ({ status: 200, body: { runs: rows }, raw: '' })),
      } as any)),
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_PAGE, invoker_open_id: INVOKER, page: '2' }),
      LARK_APP_ID,
      deps,
    );
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('第 2/5 页');
  });

  it('non-admin → toast `owner_only`, NO client call', async () => {
    const deps = makeDeps({ getOwnerOpenId: () => 'ou_other' });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker_open_id → toast `not_invoker`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('invoker_open_id !== operator.open_id → toast `not_invoker`', async () => {
    const deps = makeDeps();
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }, 'ou_stranger'),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('Route B throws → toast `list_failed` with the error reason', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({ request: async () => { throw new Error('boom'); } } as any)),
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('拉取工作流列表失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });

  it('Route B returns 500 → toast `list_failed` with http_500, NO empty list card', async () => {
    const deps = makeDeps({
      createClient: vi.fn(() => ({
        request: async () => ({ status: 500, body: {}, raw: '' }),
      } as any)),
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }),
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
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_REFRESH, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('bad_signature');
    expect(r.toast?.content).not.toContain('http_401');
  });

  it('unknown action → toast `invalid_action`, no client call', async () => {
    const deps = makeDeps();
    const r = await handleWorkflowsCardAction(
      makeAction({ action: 'dash_workflows_evil', invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('⚠️');
    expect(deps.createClient).not.toHaveBeenCalled();
  });
});

/** ─── Slice 2a: buildWorkflowsCard list rows ──────────────────────────── */

describe('buildWorkflowsCard — slice 2a inline 📂 详情 buttons', () => {
  const NOW = 2_000_000;
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, page: 1 };

  it('every list row gets a 📂 详情 button whose value.run_id matches the row runId', () => {
    const rows: WorkflowRunInput[] = [
      run({ runId: 'r_one', workflowId: 'wfOne', status: 'running' }),
      run({ runId: 'r_two', workflowId: 'wfTwo', status: 'waiting' }),
      run({ runId: 'r_three', workflowId: 'wfThree', status: 'succeeded' }),
    ];
    const json = buildWorkflowsCard(rows, baseOpts, NOW);
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const detailButtons = actionRows
      .flatMap((ar: any) => ar.actions ?? [])
      .filter((b: any) => b.value?.action === WORKFLOWS_ACTION_DETAIL);

    expect(detailButtons.length).toBe(rows.length);
    const seenIds = new Set(detailButtons.map((b: any) => b.value.run_id));
    expect(seenIds.has('r_one')).toBe(true);
    expect(seenIds.has('r_two')).toBe(true);
    expect(seenIds.has('r_three')).toBe(true);
    for (const b of detailButtons) {
      expect(String(b.text?.content ?? '')).toContain('📂');
      expect(b.value.invoker_open_id).toBe(INVOKER);
      expect(b.value.page).toBe('1');
    }
  });
});

/** ─── Slice 2: buildWorkflowsCard — overview drilldown ──────────────── */

describe('buildWorkflowsCard — overview drilldown', () => {
  const NOW = 2_000_000;

  function makeRows(n: number): WorkflowRunInput[] {
    return Array.from({ length: n }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running', startedAt: 1_000 - i }),
    );
  }

  /** Helper: parse the card JSON and return every button.value + select_static.value across all action rows. */
  function allActionValues(json: string): any[] {
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    return actionRows.flatMap((ar: any) => (ar.actions as any[]) ?? []).map((a: any) => a.value);
  }

  it('default PAGE_SIZE → 5 rows per page (regression guard)', () => {
    const rows = makeRows(7);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
      NOW,
    );
    // 7 rows / 5 = 2 pages.
    expect(json).toContain('第 1/2 页');
  });

  it('explicit pageSize=3 override → 3 rows per page', () => {
    const rows = makeRows(7);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 3 },
      NOW,
    );
    // 7 rows / 3 = 3 pages.
    expect(json).toContain('第 1/3 页');
  });

  it('origin=overview → footer renders ↩ 总览 button with dash_overview_refresh action', () => {
    const rows = makeRows(2);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1, origin: 'overview' },
      NOW,
    );
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const allBtns = actionRows.flatMap((ar: any) => (ar.actions as any[]) ?? []);
    const backToOverview = allBtns.find((a: any) => a.value?.action === 'dash_overview_refresh');
    expect(backToOverview).toBeDefined();
    expect(String(backToOverview.text?.content ?? '')).toContain('↩ 总览');
    expect(backToOverview.value.invoker_open_id).toBe(INVOKER);
  });

  it('standalone (no origin) → NO ↩ 总览 button', () => {
    const rows = makeRows(2);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
      NOW,
    );
    expect(json).not.toContain('dash_overview_refresh');
    expect(json).not.toContain('↩ 总览');
  });

  it('origin=overview (default pageSize) → every child button.value carries origin; page_size omitted', () => {
    // 16 rows / default 5 = 4 pages → prev/next AND jump-page select also emitted.
    const rows = makeRows(16);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 2, origin: 'overview' },
      NOW,
    );
    const values = allActionValues(json);
    // Filter out the back-to-overview button (it intentionally does NOT carry
    // origin since it IS the back-to-overview action). All OTHER buttons /
    // selects within the workflows card must carry origin=overview.
    const ownValues = values.filter((v: any) => v?.action !== 'dash_overview_refresh');
    expect(ownValues.length).toBeGreaterThan(0);
    for (const v of ownValues) {
      expect(v.origin).toBe('overview');
      // page_size should be omitted because we used default PAGE_SIZE.
      expect(v.page_size).toBeUndefined();
    }
  });

  it('origin=overview + pageSize=3 → every child button.value carries both origin AND page_size', () => {
    // 7 rows / 3 = 3 pages → prev/next AND jump-page select.
    const rows = makeRows(7);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1, origin: 'overview', pageSize: 3 },
      NOW,
    );
    const values = allActionValues(json);
    const ownValues = values.filter((v: any) => v?.action !== 'dash_overview_refresh');
    expect(ownValues.length).toBeGreaterThan(0);
    for (const v of ownValues) {
      expect(v.origin).toBe('overview');
      expect(v.page_size).toBe('3');
    }
  });

  it('totalPages=3 (>2 and ≤50) → select_static jump-page rendered with option count = totalPages', () => {
    // 12 rows / default 5 = 3 pages.
    const rows = makeRows(12);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
      NOW,
    );
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const allBtns = actionRows.flatMap((ar: any) => (ar.actions as any[]) ?? []);
    const jumpSelects = allBtns.filter((a: any) => a.tag === 'select_static');
    expect(jumpSelects.length).toBe(1);
    const jumpSel = jumpSelects[0];
    expect(Array.isArray(jumpSel.options)).toBe(true);
    expect(jumpSel.options.length).toBe(3);
    for (const opt of jumpSel.options) {
      expect(typeof opt.value).toBe('string');
      expect(opt.text?.tag).toBe('plain_text');
    }
    expect(jumpSel.value?.action).toBe(WORKFLOWS_ACTION_PAGE);
  });

  it('totalPages > JUMP_PAGE_MAX_OPTIONS (50) cap → NO select_static rendered', () => {
    // pageSize=1 with 60 rows → 60 pages, > 50 cap.
    const rows = makeRows(60);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1, pageSize: 1 },
      NOW,
    );
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const allBtns = actionRows.flatMap((ar: any) => (ar.actions as any[]) ?? []);
    const jumpSelects = allBtns.filter((a: any) => a.tag === 'select_static');
    expect(jumpSelects.length).toBe(0);
    // Prev/next still present.
    expect(json).toContain('← 上');
    expect(json).toContain('下 →');
  });

  it('totalPages <= 2 → NO select_static rendered (prev/next still on totalPages=2)', () => {
    // 7 rows / default 5 = 2 pages → prev/next yes, jump-page no.
    const rows = makeRows(7);
    const json = buildWorkflowsCard(
      rows,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
      NOW,
    );
    const parsed = JSON.parse(json);
    const actionRows = (parsed.elements as any[]).filter((e: any) => e.tag === 'action');
    const allBtns = actionRows.flatMap((ar: any) => (ar.actions as any[]) ?? []);
    const jumpSelects = allBtns.filter((a: any) => a.tag === 'select_static');
    expect(jumpSelects.length).toBe(0);
    // 1 page → also no select_static.
    const rowsOnePage = makeRows(3);
    const jsonOne = buildWorkflowsCard(
      rowsOnePage,
      { invokerOpenId: INVOKER, locale: 'zh', page: 1 },
      NOW,
    );
    const parsedOne = JSON.parse(jsonOne);
    const allBtnsOne = (parsedOne.elements as any[])
      .filter((e: any) => e.tag === 'action')
      .flatMap((ar: any) => (ar.actions as any[]) ?? []);
    expect(allBtnsOne.filter((a: any) => a.tag === 'select_static').length).toBe(0);
  });
});

/** ─── Slice 2a: buildWorkflowsDetailCard ──────────────────────────────── */

describe('buildWorkflowsDetailCard (slice 2a)', () => {
  const NOW = 2_000_000;
  const baseOpts = { invokerOpenId: INVOKER, locale: 'zh' as const, nowMs: NOW };

  function detailFor(over: Partial<WorkflowRunDetailInput> = {}) {
    const input: WorkflowRunDetailInput = {
      runId: 'r_detail',
      workflowId: 'wfDetail',
      status: 'running',
      startedAt: 1_000_000,
      updatedAt: 1_500_000,
      nodesDone: 1,
      nodesTotal: 3,
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
      ...over,
    };
    return projectRunDetailDto(input, { nowMs: NOW });
  }

  it('renders header (detail title) + status block + action row with cancel + back', () => {
    const detail = detailFor();
    const json = buildWorkflowsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    // Header has the detail title.
    expect(parsed.header?.title?.content).toBe('🧩 工作流详情');
    // Status block: status_label key was used.
    expect(json).toContain('状态：running');
    // Action row: cancel + back buttons.
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const acts = actionRow.actions as any[];
    const cancel = acts.find((a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL);
    const back = acts.find((a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST);
    expect(cancel).toBeDefined();
    expect(back).toBeDefined();
    expect(cancel.value.run_id).toBe('r_detail');
    expect(cancel.value.invoker_open_id).toBe(INVOKER);
    expect(back.value.invoker_open_id).toBe(INVOKER);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'terminal status %s → cancel disabled with alreadyTerminal reason note',
    (terminalStatus) => {
      // Sanity: computeActionAvailability says cancel.enabled === false.
      expect(computeActionAvailability(terminalStatus).cancel.enabled).toBe(false);
      const detail = detailFor({ status: terminalStatus });
      const json = buildWorkflowsDetailCard(detail, baseOpts);
      const parsed = JSON.parse(json);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const cancel = (actionRow.actions as any[]).find(
        (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
      );
      expect(cancel.disabled).toBe(true);
      // Inline reason note rendered (already-terminal message string from i18n)
      expect(json).toContain('运行已处于终态，无法取消');
    },
  );

  it('cancel button confirm dialog has non-empty title + text when enabled', () => {
    const detail = detailFor({ status: 'running' });
    const json = buildWorkflowsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    expect(cancel.disabled).not.toBe(true);
    expect(cancel.confirm).toBeDefined();
    expect(String(cancel.confirm.title?.content ?? '')).not.toBe('');
    expect(String(cancel.confirm.text?.content ?? '')).not.toBe('');
    // Must mention runId in the confirm text.
    expect(String(cancel.confirm.text?.content ?? '')).toContain('r_detail');
  });

  it('escapes <at>/<font> injection in runId / workflowId / chatBinding text', () => {
    const detail = detailFor({
      runId: '<at id=ou_evil></at>',
      workflowId: '</font><at id=ou_y></at>',
      chatBinding: { chatId: '<at id=ou_z></at>', larkAppId: 'cli_demo' },
    });
    const json = buildWorkflowsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const textDivs = (parsed.elements as any[]).filter(
      (e: any) => e.tag === 'div' && typeof e.text?.content === 'string',
    );
    expect(textDivs.length).toBeGreaterThan(0);
    for (const d of textDivs) {
      const content = d.text.content as string;
      // No naked <at must appear; escaped &lt;at is fine.
      expect(content).not.toMatch(/<at\b/);
    }
    // &lt; must appear somewhere in the rendered body (escape took effect).
    expect(json).toContain('&lt;');
  });

  it('origin=overview + default pageSize → cancel/back values carry origin; page_size omitted', () => {
    const detail = detailFor({ status: 'running' });
    const json = buildWorkflowsDetailCard(detail, { ...baseOpts, origin: 'overview' });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST,
    );
    expect(cancel.value.origin).toBe('overview');
    expect(cancel.value.page_size).toBeUndefined();
    expect(back.value.origin).toBe('overview');
    expect(back.value.page_size).toBeUndefined();
    // Detail card itself does NOT render a back-to-overview button.
    expect(json).not.toContain('dash_overview_refresh');
  });

  it('origin=overview + pageSize=3 override → cancel/back values carry origin/page/page_size', () => {
    const detail = detailFor({ status: 'running' });
    const json = buildWorkflowsDetailCard(detail, {
      ...baseOpts,
      origin: 'overview',
      pageSize: 3,
      sourcePage: 2,
    });
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST,
    );
    expect(cancel.value.origin).toBe('overview');
    expect(cancel.value.page).toBe('2');
    expect(cancel.value.page_size).toBe('3');
    expect(back.value.origin).toBe('overview');
    expect(back.value.page).toBe('2');
    expect(back.value.page_size).toBe('3');
  });

  it('no origin → cancel/back values carry NEITHER origin NOR page_size (no regression)', () => {
    const detail = detailFor({ status: 'running' });
    const json = buildWorkflowsDetailCard(detail, baseOpts);
    const parsed = JSON.parse(json);
    const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST,
    );
    expect(cancel.value.origin).toBeUndefined();
    expect(cancel.value.page_size).toBeUndefined();
    expect(back.value.origin).toBeUndefined();
    expect(back.value.page_size).toBeUndefined();
  });
});

/** ─── Slice 2a: handleWorkflowsCardAction — dash_workflows_detail ───── */

describe('handleWorkflowsCardAction — dash_workflows_detail', () => {
  function makeDetailDeps(runId = 'r_a') {
    const runs: WorkflowRunInput[] = [
      run({
        runId,
        workflowId: 'wfDetail',
        status: 'running',
        chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
      }),
      run({ runId: 'r_other', workflowId: 'wfOther', status: 'running' }),
    ];
    const requestSpy = vi.fn(async () => ({ status: 200, body: { runs }, raw: '' }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh' as const,
      nowMs: () => 2_000_000,
      requestSpy,
    };
  }

  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  it('happy: GET workflows-runs-snapshot?all=1 once + returns { card } detail body', async () => {
    const deps = makeDetailDeps('r_a');
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_DETAIL, invoker_open_id: INVOKER, run_id: 'r_a' }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledOnce();
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1',
    });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('工作流详情');
    expect(cardJson).toContain(WORKFLOWS_ACTION_CANCEL);
    expect(cardJson).toContain(WORKFLOWS_ACTION_BACK_TO_LIST);
    expect(cardJson).toContain('r_a');
  });

  it('run_id not in list → toast workflow_not_found, no card', async () => {
    const deps = makeDetailDeps('r_a');
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_DETAIL, invoker_open_id: INVOKER, run_id: 'r_ghost' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('运行不存在');
    expect(r.card).toBeUndefined();
  });

  it('non-admin → owner_only toast, no GET', async () => {
    const deps = { ...makeDetailDeps('r_a'), getOwnerOpenId: () => 'ou_other' };
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_DETAIL, invoker_open_id: INVOKER, run_id: 'r_a' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('missing invoker_open_id → not_invoker toast, no GET', async () => {
    const deps = makeDetailDeps('r_a');
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_DETAIL, run_id: 'r_a' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('Route B throws → list_failed toast (boom), no card', async () => {
    const deps = {
      createClient: vi.fn(() => ({
        request: async () => { throw new Error('boom'); },
      } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh' as const,
      nowMs: () => 2_000_000,
    };
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_DETAIL, invoker_open_id: INVOKER, run_id: 'r_a' }),
      LARK_APP_ID,
      deps as any,
    );
    expect(r.toast?.content).toContain('拉取工作流列表失败');
    expect(r.toast?.content).toContain('boom');
    expect(r.card).toBeUndefined();
  });
});

/** ─── Slice 2a: handleWorkflowsCardAction — dash_workflows_cancel ───── */

describe('handleWorkflowsCardAction — dash_workflows_cancel', () => {
  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  function makeCancelDeps(opts: {
    /** runs returned by the first GET (pre-POST snapshot) */
    preRuns: WorkflowRunInput[];
    /** runs returned by the second GET (post-POST refetch); if undefined uses preRuns */
    postRuns?: WorkflowRunInput[];
    /** mock POST response; default 200 ok */
    postResp?: { status: number; body?: any };
    /** if true, POST throws */
    postThrows?: Error;
  }) {
    let getCalls = 0;
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/workflows-runs-snapshot?all=1') {
        getCalls += 1;
        const runs = getCalls === 1 ? opts.preRuns : (opts.postRuns ?? opts.preRuns);
        return { status: 200, body: { runs }, raw: '' };
      }
      if (req.method === 'POST' && req.path.endsWith('/cancel')) {
        if (opts.postThrows) throw opts.postThrows;
        return opts.postResp ?? { status: 200, body: { ok: true }, raw: '' };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh' as const,
      nowMs: () => 2_000_000,
      requestSpy,
    };
  }

  it('happy: GET (snapshot) + POST + 2nd GET → fresh row drives cancelled detail with disabled cancel; 3 requests', async () => {
    const before = run({
      runId: 'r_cancel',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const after = run({
      runId: 'r_cancel',
      workflowId: 'wf',
      status: 'cancelled',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({ preRuns: [before], postRuns: [after] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_cancel' }),
      LARK_APP_ID,
      deps,
    );
    expect(deps.requestSpy).toHaveBeenCalledTimes(3);
    expect(deps.requestSpy.mock.calls[0][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1',
    });
    expect(deps.requestSpy.mock.calls[1][0]).toEqual(
      expect.objectContaining({ method: 'POST', path: '/__daemon/workflows-runs/r_cancel/cancel' }),
    );
    expect(deps.requestSpy.mock.calls[2][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1',
    });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // Detail rendered with cancelled status → cancel button disabled.
    expect(cardJson).toContain('工作流详情');
    expect(cardJson).toContain('"disabled":true');
    expect(cardJson).toContain('运行已处于终态，无法取消');
  });

  it('2nd GET cannot find runId (vanished) → falls back to synth {...before, status: cancelled}', async () => {
    const before = run({
      runId: 'r_vanish',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    // Second GET returns no rows — runId vanished.
    const deps = makeCancelDeps({ preRuns: [before], postRuns: [] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_vanish' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // Synth fallback renders cancelled state.
    expect(cardJson).toContain('工作流详情');
    expect(cardJson).toContain('"disabled":true');
    expect(cardJson).toContain('运行已处于终态，无法取消');
  });

  it('inline comment in impl flags the stale-render risk of the synth fallback', () => {
    // Verify the implementation carries the documented inline comment about
    // the one-cycle-stale render fallback so refactors don't silently drop it.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const implPath = path.resolve(here, '..', 'src', 'im', 'lark', 'workflows-card.ts');
    const src = fs.readFileSync(implPath, 'utf8');
    expect(src).toMatch(/stale/i);
  });

  it('SECURITY: snapshot already terminal → toast cancel.disabled.alreadyTerminal, POST 0 times', async () => {
    const before = run({
      runId: 'r_done',
      workflowId: 'wf',
      status: 'succeeded',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({ preRuns: [before] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_done' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('运行已处于终态，无法取消');
    expect(r.card).toBeUndefined();
    const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('SECURITY: snapshot missing chatBinding.larkAppId → toast cancel.disabled.noOwner, POST 0 times', async () => {
    const before = run({
      runId: 'r_no_owner',
      workflowId: 'wf',
      status: 'running',
      // no chatBinding deliberately
    });
    const deps = makeCancelDeps({ preRuns: [before] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_no_owner' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('运行缺少所属群信息');
    expect(r.card).toBeUndefined();
    const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('POST 404 → toast cancel_failed, no card', async () => {
    const before = run({
      runId: 'r_post404',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({
      preRuns: [before],
      postResp: { status: 404, body: { error: 'unknown_run' } },
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_post404' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('取消失败');
    expect(r.toast?.content).toContain('unknown_run');
    expect(r.card).toBeUndefined();
  });

  it('POST 500 (no body.error) → toast cancel_failed http_500, no card', async () => {
    const before = run({
      runId: 'r_post500',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({
      preRuns: [before],
      postResp: { status: 500, body: {} },
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_post500' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('取消失败');
    expect(r.toast?.content).toContain('http_500');
    expect(r.card).toBeUndefined();
  });

  it('POST throws → toast cancel_failed (err.message), no card', async () => {
    const before = run({
      runId: 'r_throw',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({
      preRuns: [before],
      postThrows: new Error('network down'),
    });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_throw' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('取消失败');
    expect(r.toast?.content).toContain('network down');
    expect(r.card).toBeUndefined();
  });

  it('non-admin → owner_only toast, no POST', async () => {
    const before = run({
      runId: 'r_nonowner',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = { ...makeCancelDeps({ preRuns: [before] }), getOwnerOpenId: () => 'ou_other' };
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_nonowner' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.requestSpy).not.toHaveBeenCalled();
  });

  it('invoker mismatch → toast, no POST', async () => {
    const before = run({
      runId: 'r_invoker',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({ preRuns: [before] });
    const r = await handleWorkflowsCardAction(
      makeAction(
        { action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_invoker' },
        'ou_stranger',
      ),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('🔒');
    expect(r.card).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('pre-POST GET cannot find runId → toast workflow_not_found, NO POST issued', async () => {
    const before = run({
      runId: 'r_other',
      workflowId: 'wf',
      status: 'running',
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    });
    const deps = makeCancelDeps({ preRuns: [before] });
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_CANCEL, invoker_open_id: INVOKER, run_id: 'r_missing' }),
      LARK_APP_ID,
      deps,
    );
    expect(r.toast?.content).toContain('运行不存在');
    expect(r.card).toBeUndefined();
    const postCalls = deps.requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
    expect(postCalls.length).toBe(0);
  });
});

/** ─── Slice 2a: handleWorkflowsCardAction — dash_workflows_back_to_list ─ */

describe('handleWorkflowsCardAction — dash_workflows_back_to_list', () => {
  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  it('happy: GET workflows-runs-snapshot?all=1 → list card', async () => {
    const runs: WorkflowRunInput[] = [
      run({ runId: 'r_back_one', workflowId: 'wfBackOne', status: 'running' }),
      run({ runId: 'r_back_two', workflowId: 'wfBackTwo', status: 'succeeded' }),
    ];
    const requestSpy = vi.fn(async () => ({ status: 200, body: { runs }, raw: '' }));
    const deps = {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh' as const,
      nowMs: () => 2_000_000,
    };
    const r = await handleWorkflowsCardAction(
      makeAction({ action: WORKFLOWS_ACTION_BACK_TO_LIST, invoker_open_id: INVOKER }),
      LARK_APP_ID,
      deps as any,
    );
    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy.mock.calls[0][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1',
    });
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // List card title (not detail).
    expect(cardJson).toContain('Dashboard 工作流');
    expect(cardJson).toContain('wfBackOne');
    expect(cardJson).toContain('wfBackTwo');
  });
});

/** ─── Slice 2: handleWorkflowsCardAction — overview drilldown plumbing ── */

describe('handleWorkflowsCardAction — overview drilldown', () => {
  function makeAction(value: Record<string, string>, operator = INVOKER): CardActionData {
    return {
      operator: { open_id: operator },
      action: { value },
      context: { open_message_id: 'om_card' },
    } as any;
  }

  function makeListDeps(runs: WorkflowRunInput[]) {
    const requestSpy = vi.fn(async () => ({ status: 200, body: { runs }, raw: '' }));
    return {
      createClient: vi.fn(() => ({ request: requestSpy } as any)),
      getOwnerOpenId: () => INVOKER,
      locale: 'zh' as const,
      nowMs: () => 2_000_000,
      requestSpy,
    };
  }

  it('PAGE via select_static (action.option, no value.page) → uses option page in rebuild', async () => {
    // 12 rows / default 5 = 3 pages.
    const runs = Array.from({ length: 12 }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running', startedAt: 1_000 - i }),
    );
    const deps = makeListDeps(runs);
    // action.option is the select_static jump-page dispatch field (no value.page).
    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: WORKFLOWS_ACTION_PAGE, invoker_open_id: INVOKER }, option: '3' },
      context: { open_message_id: 'om_card' },
    } as any;
    const r = await handleWorkflowsCardAction(data, LARK_APP_ID, deps);
    expect(r.toast).toBeUndefined();
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    // 12 rows / 5 = 3 pages, jumped to page 3.
    expect(cardJson).toContain('第 3/3 页');
  });

  it('REFRESH with origin=overview → rebuilt list card has ↩ 总览', async () => {
    const runs: WorkflowRunInput[] = [
      run({ runId: 'r_o', workflowId: 'wfOver', status: 'running' }),
    ];
    const deps = makeListDeps(runs);
    const r = await handleWorkflowsCardAction(
      makeAction({
        action: WORKFLOWS_ACTION_REFRESH,
        invoker_open_id: INVOKER,
        origin: 'overview',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('↩ 总览');
    expect(cardJson).toContain('dash_overview_refresh');
  });

  it('BACK_TO_LIST with origin=overview → rebuilt list restores source page and threads origin onto child buttons', async () => {
    const runs: WorkflowRunInput[] = Array.from({ length: 12 }, (_, i) =>
      run({ runId: `r_b${i}`, workflowId: `wfB${i}`, status: 'running' }),
    );
    const deps = makeListDeps(runs);
    const r = await handleWorkflowsCardAction(
      makeAction({
        action: WORKFLOWS_ACTION_BACK_TO_LIST,
        invoker_open_id: INVOKER,
        origin: 'overview',
        page: '2',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.card?.type).toBe('raw');
    const cardJson = JSON.stringify(r.card?.data);
    expect(cardJson).toContain('↩ 总览');
    expect(cardJson).toContain('第 2/3 页');
    // Detail button (per-row) and refresh button must both carry origin=overview.
    const card: any = r.card?.data;
    const allBtns = (card.elements as any[])
      .filter((e: any) => e.tag === 'action')
      .flatMap((ar: any) => (ar.actions as any[]) ?? []);
    const ownBtns = allBtns.filter((a: any) => a.value?.action !== 'dash_overview_refresh');
    expect(ownBtns.length).toBeGreaterThan(0);
    for (const b of ownBtns) {
      expect(b.value?.origin).toBe('overview');
    }
  });

  it('DETAIL with origin=overview → rebuilt detail card carries origin on back+cancel button values', async () => {
    const runs: WorkflowRunInput[] = [
      run({
        runId: 'r_d',
        workflowId: 'wfD',
        status: 'running',
        chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
      }),
    ];
    const deps = makeListDeps(runs);
    const r = await handleWorkflowsCardAction(
      makeAction({
        action: WORKFLOWS_ACTION_DETAIL,
        invoker_open_id: INVOKER,
        run_id: 'r_d',
        origin: 'overview',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.card?.type).toBe('raw');
    const card: any = r.card?.data;
    const actionRow = (card.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST,
    );
    expect(cancel.value.origin).toBe('overview');
    expect(back.value.origin).toBe('overview');
  });

  it('DETAIL with origin=overview + page_size → detail card cancel/back values carry both', async () => {
    const runs: WorkflowRunInput[] = [
      run({
        runId: 'r_dp',
        workflowId: 'wfDP',
        status: 'running',
        chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
      }),
    ];
    const deps = makeListDeps(runs);
    const r = await handleWorkflowsCardAction(
      makeAction({
        action: WORKFLOWS_ACTION_DETAIL,
        invoker_open_id: INVOKER,
        run_id: 'r_dp',
        origin: 'overview',
        page: '2',
        page_size: '3',
      }),
      LARK_APP_ID,
      deps,
    );
    expect(r.card?.type).toBe('raw');
    const card: any = r.card?.data;
    const actionRow = (card.elements as any[]).find((e: any) => e.tag === 'action');
    const cancel = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_CANCEL,
    );
    const back = (actionRow.actions as any[]).find(
      (a: any) => a.value?.action === WORKFLOWS_ACTION_BACK_TO_LIST,
    );
    expect(cancel.value.origin).toBe('overview');
    expect(cancel.value.page).toBe('2');
    expect(cancel.value.page_size).toBe('3');
    expect(back.value.origin).toBe('overview');
    expect(back.value.page).toBe('2');
    expect(back.value.page_size).toBe('3');
  });
});
