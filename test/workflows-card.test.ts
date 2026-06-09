/**
 * PR3 `/dashboard workflows` slice 1 — card builder + callback handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WorkflowRunInput } from '../src/dashboard/workflow-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildWorkflowsCard,
  handleWorkflowsCardAction,
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
    expect(json).not.toContain('上一页');
    expect(json).not.toContain('下一页');
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

  it('count summary: 进行中 N · 完成 M · 失败 K · 第 1/1 页 (running = pending|running|waiting, done = succeeded, failed = failed|cancelled)', () => {
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
    expect(json).toContain('第 1/1 页');
  });

  it('pagination: > 10 rows → prev/next; page=2 of 3 with 25 rows', () => {
    const rows: WorkflowRunInput[] = Array.from({ length: 25 }, (_, i) =>
      run({ runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running', startedAt: 1_000 - i }),
    );
    const json = buildWorkflowsCard(rows, { ...baseOpts, page: 2 }, NOW);
    expect(json).toContain('上一页');
    expect(json).toContain('下一页');
    expect(json).toContain('第 2/3 页');
    // prev → 1, next → 3
    expect(json).toContain('"page":"1"');
    expect(json).toContain('"page":"3"');

    const findPagerButtons = (j: string): { prev: any; next: any } => {
      const parsed = JSON.parse(j);
      const actionRow = (parsed.elements as any[]).find((e: any) => e.tag === 'action');
      const actions = actionRow.actions as any[];
      const prev = actions.find((a: any) => String(a.text?.content ?? '').includes('上一页'));
      const next = actions.find((a: any) => String(a.text?.content ?? '').includes('下一页'));
      return { prev, next };
    };

    // On page=1, prev disabled
    const page1 = buildWorkflowsCard(rows, { ...baseOpts, page: 1 }, NOW);
    const { prev: p1prev, next: p1next } = findPagerButtons(page1);
    expect(p1prev.disabled).toBe(true);
    expect(p1next.disabled).toBe(false);

    // On page=3 (last), next disabled
    const page3 = buildWorkflowsCard(rows, { ...baseOpts, page: 3 }, NOW);
    const { prev: p3prev, next: p3next } = findPagerButtons(page3);
    expect(p3prev.disabled).toBe(false);
    expect(p3next.disabled).toBe(true);
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

  it('page=2 with 25 rows → 第 2/3 页', async () => {
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
    expect(cardJson).toContain('第 2/3 页');
  });

  it('non-owner → toast `owner_only`, NO client call', async () => {
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
