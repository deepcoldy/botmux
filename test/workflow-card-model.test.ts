import { describe, expect, it } from 'vitest';

import {
  computeActionAvailability,
  filterAndPaginateRuns,
  formatElapsedMs,
  projectRunDetailDto,
  projectRunRowDto,
  statusToDot,
  type WorkflowRunDetailInput,
  type WorkflowRunInput,
  type WorkflowRunStatus,
} from '../src/dashboard/workflow-card-model.js';

const FIXED_NOW = 1_700_000_000_000;

function makeRun(overrides: Partial<WorkflowRunInput> = {}): WorkflowRunInput {
  return {
    runId: 'run-1',
    workflowId: 'wf-default',
    status: 'running',
    startedAt: FIXED_NOW - 60_000,
    updatedAt: FIXED_NOW - 30_000,
    nodesDone: 2,
    nodesTotal: 5,
    chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    ...overrides,
  };
}

describe('workflow-card-model · statusToDot', () => {
  it('maps each of the 6 RunStatus values to a unique (tone, label) pair', () => {
    const all: WorkflowRunStatus[] = ['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];
    const labels = new Set<string>();
    const tones = new Set<string>();
    for (const s of all) {
      const dot = statusToDot(s);
      labels.add(dot.label);
      tones.add(`${dot.tone}/${dot.pulse}/${dot.label}`); // composite key
    }
    expect(labels.size).toBe(6); // all 6 labels distinct
    expect(tones.size).toBe(6);  // all 6 composite keys distinct
  });

  it('maps unknown statuses to a neutral fallback dot', () => {
    expect(statusToDot('mystery')).toEqual({
      tone: 'neutral',
      pulse: false,
      label: 'workflows.status.unknown',
    });
  });
});

describe('workflow-card-model · formatElapsedMs', () => {
  it('handles seconds / m+s / h+m / d+h, and clamps non-positive input to 0s', () => {
    expect(formatElapsedMs(12_000)).toBe('12s');
    expect(formatElapsedMs(184_000)).toBe('3m 4s');
    expect(formatElapsedMs(60_000)).toBe('1m');
    expect(formatElapsedMs(3_720_000)).toBe('1h 2m');
    expect(formatElapsedMs(3_600_000)).toBe('1h');
    expect(formatElapsedMs(183_600_000)).toBe('2d 3h');
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(-50)).toBe('0s');
    expect(formatElapsedMs(NaN)).toBe('0s');
  });
});

describe('workflow-card-model · computeActionAvailability', () => {
  it('approve+reject only on waiting; cancel on non-terminal; all false on terminal statuses', () => {
    const waiting = computeActionAvailability('waiting');
    expect(waiting.approve.enabled).toBe(true);
    expect(waiting.reject.enabled).toBe(true);
    expect(waiting.cancel.enabled).toBe(true);

    for (const s of ['pending', 'running'] as WorkflowRunStatus[]) {
      const a = computeActionAvailability(s);
      expect(a.cancel.enabled).toBe(true);
      expect(a.approve.enabled).toBe(false);
      expect(a.reject.enabled).toBe(false);
    }

    for (const s of ['succeeded', 'failed', 'cancelled'] as WorkflowRunStatus[]) {
      const a = computeActionAvailability(s);
      expect(a.cancel.enabled).toBe(false);
      expect(a.approve.enabled).toBe(false);
      expect(a.reject.enabled).toBe(false);
    }
  });
});

describe('workflow-card-model · projectRunRowDto', () => {
  it("fills progressLabel '第 N/M 步' when both totals present, '' when missing; forwards chatBinding unchanged", () => {
    const bound = makeRun({ nodesDone: 3, nodesTotal: 7 });
    const row = projectRunRowDto(bound);
    expect(row.progressLabel).toBe('第 3/7 步');
    expect(row.chatBinding).toEqual({ chatId: 'oc_demo', larkAppId: 'cli_demo' });
    expect(row.chatBinding).toBe(bound.chatBinding); // forwarded (no deep clone)

    const noTotals = makeRun({ nodesDone: undefined, nodesTotal: undefined });
    expect(projectRunRowDto(noTotals).progressLabel).toBe('');

    const halfMissing = makeRun({ nodesDone: 3, nodesTotal: 0 });
    expect(projectRunRowDto(halfMissing).progressLabel).toBe('');
  });
});

describe('workflow-card-model · filterAndPaginateRuns search + chipCounts', () => {
  it('search matches runId OR workflowId substring case-insensitively; total reflects filtered count', () => {
    const runs = [
      makeRun({ runId: 'run-Alpha-001', workflowId: 'wf-fast' }),
      makeRun({ runId: 'run-002',       workflowId: 'wf-ALPHA-build' }),
      makeRun({ runId: 'run-other',     workflowId: 'wf-noise' }),
    ];
    const page = filterAndPaginateRuns(runs, { search: 'ALPHA' });
    expect(page.rows.map(r => r.runId)).toEqual(['run-Alpha-001', 'run-002']);
    expect(page.meta.total).toBe(2);
  });

  it('chipCounts reflects search-filtered (not status-filtered) totals', () => {
    const runs: WorkflowRunInput[] = [
      makeRun({ runId: 'pending-1',   status: 'pending', workflowId: 'wf-keep' }),
      makeRun({ runId: 'running-1',   status: 'running', workflowId: 'wf-keep' }),
      makeRun({ runId: 'succeeded-1', status: 'succeeded', workflowId: 'wf-keep' }),
      makeRun({ runId: 'noise',       status: 'failed',   workflowId: 'wf-discard' }),
    ];
    const page = filterAndPaginateRuns(runs, { search: 'wf-keep', status: 'running' });
    // search drops 'noise'; chipCounts based on 3 remaining; rows further filtered to running.
    expect(page.chipCounts.all).toBe(3);
    expect(page.chipCounts.pending).toBe(1);
    expect(page.chipCounts.running).toBe(1);
    expect(page.chipCounts.succeeded).toBe(1);
    expect(page.chipCounts.failed).toBe(0); // 'noise' was dropped by search
    expect(page.rows.map(r => r.runId)).toEqual(['running-1']);
  });
});

describe('workflow-card-model · filterAndPaginateRuns clamp', () => {
  const big = Array.from({ length: 45 }, (_, i) => makeRun({ runId: `r-${i}` }));

  it('clamps invalid page values (0, negative, > totalPages) and respects pageSize default 20 + max 100', () => {
    expect(filterAndPaginateRuns(big, { page: 0, pageSize: 10 }).meta.page).toBe(1);
    expect(filterAndPaginateRuns(big, { page: -5, pageSize: 10 }).meta.page).toBe(1);

    const overshoot = filterAndPaginateRuns(big, { page: 99, pageSize: 10 });
    expect(overshoot.meta.totalPages).toBe(5);
    expect(overshoot.meta.page).toBe(5);

    expect(filterAndPaginateRuns(big, { pageSize: 0 }).meta.pageSize).toBe(20);
    expect(filterAndPaginateRuns(big, { pageSize: -1 }).meta.pageSize).toBe(20);
    expect(filterAndPaginateRuns(big, { pageSize: 9999 }).meta.pageSize).toBe(100);
  });
});

describe('workflow-card-model · projectRunDetailDto', () => {
  it('computes elapsedMs from nowMs-startedAt, falls back to updatedAt, emits 1-based node indexes', () => {
    const withStartedAt: WorkflowRunDetailInput = {
      ...makeRun({ startedAt: FIXED_NOW - 5_000 }),
      nodes: [
        { nodeId: 'n1', name: 'first', status: 'succeeded' },
        { nodeId: 'n2', name: 'second', status: 'running' },
      ],
    };
    const a = projectRunDetailDto(withStartedAt, { nowMs: FIXED_NOW });
    expect(a.elapsedMs).toBe(5_000);
    expect(a.elapsedLabel).toBe('5s');
    expect(a.nodes.map(n => n.index)).toEqual([1, 2]);
    expect(a.nodes[0]).toEqual({ index: 1, nodeId: 'n1', name: 'first', status: 'succeeded' });

    const noStartedAt: WorkflowRunDetailInput = {
      ...makeRun({ startedAt: undefined, updatedAt: FIXED_NOW - 12_000 }),
    };
    const b = projectRunDetailDto(noStartedAt, { nowMs: FIXED_NOW });
    expect(b.elapsedMs).toBe(12_000);
    expect(b.elapsedLabel).toBe('12s');

    const neither: WorkflowRunDetailInput = {
      ...makeRun({ startedAt: undefined, updatedAt: undefined }),
    };
    expect(projectRunDetailDto(neither, { nowMs: FIXED_NOW }).elapsedMs).toBe(0);
  });
});

describe('workflow-card-model · invariants', () => {
  it('filterAndPaginateRuns does not mutate the input runs list', () => {
    const runs = [
      makeRun({ runId: 'a' }),
      makeRun({ runId: 'b', status: 'succeeded' }),
    ];
    const frozen = Object.freeze(runs.slice());
    const snapshot = frozen.map(r => r.runId);
    filterAndPaginateRuns(frozen, { search: 'a', status: 'running', page: 99, pageSize: 5 });
    expect(frozen.map(r => r.runId)).toEqual(snapshot);
  });

  it('outputs are JSON-serialisable: list page + detail DTO round-trip', () => {
    const list = filterAndPaginateRuns([makeRun()], {});
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);

    const detail = projectRunDetailDto(
      { ...makeRun(), nodes: [{ nodeId: 'n', name: 'only', status: 'pending' }] },
      { nowMs: FIXED_NOW },
    );
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });
});
