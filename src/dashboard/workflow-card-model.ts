/**
 * Workflow card model (PR1) — pure projection of workflow run rows and run
 * snapshots into list / detail DTOs. Self-contained: no imports from
 * `src/workflows/`, only `card-model-types.ts` shared types.
 *
 * v1 scope: cancel / approve / reject. Attempt-level resume is NOT exposed.
 */

import type { ButtonState, PaginationMeta, StatusDot } from './card-model-types.js';

/** Mirrors `src/workflows/events/replay.ts:44-50 RunStatus` — redeclared locally. */
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type WorkflowChipStatus = WorkflowRunStatus | 'all';

/** Outgoing message routing context attached to each run. */
export interface ChatBinding {
  chatId: string;
  larkAppId: string;
  rootMessageId?: string;
}

/** Minimum row shape — adapter converts ops-projection RunRow into this. */
export interface WorkflowRunInput {
  runId: string;
  workflowId?: string;
  status: WorkflowRunStatus;
  /** ms epoch — first activity timestamp. */
  startedAt?: number;
  /** ms epoch — last activity timestamp. */
  updatedAt?: number;
  /** ms epoch — terminal-state timestamp. */
  finishedAt?: number;
  nodesDone?: number;
  nodesTotal?: number;
  chatBinding?: ChatBinding;
}

export interface WorkflowRunDetailInput extends WorkflowRunInput {
  nodes?: ReadonlyArray<{ nodeId: string; name?: string; status?: string }>;
}

/** One progress bar item with a 1-based index for display. */
export interface NodeProgressItem {
  index: number;
  nodeId: string;
  name?: string;
  status?: string;
}

/** Status-dot alias for clarity at call sites. */
export type RunStatusDot = StatusDot;

/** Action availability for v1's three write paths (Cancel / Approve / Reject). */
export interface WorkflowActionAvailability {
  cancel: ButtonState;
  approve: ButtonState;
  reject: ButtonState;
}

export interface WorkflowRunRowDto {
  runId: string;
  workflowId?: string;
  status: WorkflowRunStatus;
  dot: RunStatusDot;
  /** '第 N/M 步' when both totals exist; '' otherwise. */
  progressLabel: string;
  startedAtMs?: number;
  chatBinding?: ChatBinding;
  actions: WorkflowActionAvailability;
  raw: WorkflowRunInput;
}

export interface WorkflowRunDetailDto {
  runId: string;
  workflowId?: string;
  status: WorkflowRunStatus;
  dot: RunStatusDot;
  startedAtMs?: number;
  updatedAtMs?: number;
  finishedAtMs?: number;
  elapsedMs: number;
  elapsedLabel: string;
  progressLabel: string;
  nodes: NodeProgressItem[];
  chatBinding?: ChatBinding;
  actions: WorkflowActionAvailability;
  raw: WorkflowRunDetailInput;
}

export interface WorkflowChipCounts {
  all: number;
  pending: number;
  running: number;
  waiting: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface WorkflowFilterQuery {
  search?: string;
  status?: WorkflowChipStatus;
  page?: number;
  pageSize?: number;
}

export interface WorkflowListPage {
  rows: WorkflowRunRowDto[];
  meta: PaginationMeta;
  chipCounts: WorkflowChipCounts;
}

export interface ProjectRunCtx {
  nowMs: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['succeeded', 'failed', 'cancelled']);

/** Map a RunStatus to its UI dot (tone + pulse + i18n label key). Pure, deterministic. */
export function statusToDot(status: WorkflowRunStatus | string): RunStatusDot {
  switch (status) {
    case 'pending':
      return { tone: 'neutral', pulse: false, label: 'workflows.status.pending' };
    case 'running':
      return { tone: 'info', pulse: true, label: 'workflows.status.running' };
    case 'waiting':
      return { tone: 'warning', pulse: true, label: 'workflows.status.waiting' };
    case 'succeeded':
      return { tone: 'success', pulse: false, label: 'workflows.status.succeeded' };
    case 'failed':
      return { tone: 'danger', pulse: false, label: 'workflows.status.failed' };
    case 'cancelled':
      return { tone: 'neutral', pulse: false, label: 'workflows.status.cancelled' };
    default:
      return { tone: 'neutral', pulse: false, label: 'workflows.status.unknown' };
  }
}

/** Format an elapsed-ms span into a short label, e.g. '12s' / '3m 4s' / '1h 2m' / '2d 3h'. */
export function formatElapsedMs(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return '0s';
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  if (hour < 24) return remMin > 0 ? `${hour}h ${remMin}m` : `${hour}h`;
  const day = Math.floor(hour / 24);
  const remHour = hour % 24;
  return remHour > 0 ? `${day}d ${remHour}h` : `${day}d`;
}

/**
 * Compute Cancel/Approve/Reject button availability.
 * v1: Approve+Reject only when status==='waiting'; Cancel when non-terminal.
 */
export function computeActionAvailability(status: WorkflowRunStatus): WorkflowActionAvailability {
  const isTerminal = TERMINAL_STATUSES.has(status);
  const isWaiting = status === 'waiting';
  return {
    cancel: isTerminal
      ? { enabled: false, reasonKey: 'workflows.action.cancel.terminal' }
      : { enabled: true },
    approve: isWaiting ? { enabled: true } : { enabled: false, reasonKey: 'workflows.action.approve.notWaiting' },
    reject: isWaiting ? { enabled: true } : { enabled: false, reasonKey: 'workflows.action.reject.notWaiting' },
  };
}

function progressLabel(nodesDone: number | undefined, nodesTotal: number | undefined): string {
  if (
    typeof nodesDone === 'number' && Number.isFinite(nodesDone) &&
    typeof nodesTotal === 'number' && Number.isFinite(nodesTotal) && nodesTotal > 0
  ) {
    return `第 ${nodesDone}/${nodesTotal} 步`;
  }
  return '';
}

/** Build one list-row DTO from a run input. */
export function projectRunRowDto(input: WorkflowRunInput): WorkflowRunRowDto {
  return {
    runId: input.runId,
    workflowId: input.workflowId,
    status: input.status,
    dot: statusToDot(input.status),
    progressLabel: progressLabel(input.nodesDone, input.nodesTotal),
    startedAtMs: input.startedAt,
    chatBinding: input.chatBinding,
    actions: computeActionAvailability(input.status),
    raw: input,
  };
}

/** Build the detail DTO including elapsedMs and a 1-based NodeProgressItem list. */
export function projectRunDetailDto(input: WorkflowRunDetailInput, ctx: ProjectRunCtx): WorkflowRunDetailDto {
  const startedFallback = typeof input.startedAt === 'number' ? input.startedAt : input.updatedAt;
  const elapsedMs = typeof startedFallback === 'number' && startedFallback > 0
    ? Math.max(0, ctx.nowMs - startedFallback)
    : 0;
  const nodes: NodeProgressItem[] = (input.nodes ?? []).map((node, i) => ({
    index: i + 1,
    nodeId: node.nodeId,
    name: node.name,
    status: node.status,
  }));
  return {
    runId: input.runId,
    workflowId: input.workflowId,
    status: input.status,
    dot: statusToDot(input.status),
    startedAtMs: input.startedAt,
    updatedAtMs: input.updatedAt,
    finishedAtMs: input.finishedAt,
    elapsedMs,
    elapsedLabel: formatElapsedMs(elapsedMs),
    progressLabel: progressLabel(input.nodesDone, input.nodesTotal),
    nodes,
    chatBinding: input.chatBinding,
    actions: computeActionAvailability(input.status),
    raw: input,
  };
}

function computeChipCounts(runs: ReadonlyArray<WorkflowRunInput>): WorkflowChipCounts {
  const counts: WorkflowChipCounts = {
    all: runs.length,
    pending: 0, running: 0, waiting: 0,
    succeeded: 0, failed: 0, cancelled: 0,
  };
  for (const r of runs) {
    switch (r.status) {
      case 'pending': counts.pending += 1; break;
      case 'running': counts.running += 1; break;
      case 'waiting': counts.waiting += 1; break;
      case 'succeeded': counts.succeeded += 1; break;
      case 'failed': counts.failed += 1; break;
      case 'cancelled': counts.cancelled += 1; break;
    }
  }
  return counts;
}

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(pageSize);
}

/**
 * Pipeline: search → chipCounts → status filter → paginate → row mapping.
 *
 * `chipCounts` is computed AFTER the search filter but BEFORE the status
 * chip filter, so users get accurate counts per status under their current
 * search context.
 */
export function filterAndPaginateRuns(
  runs: ReadonlyArray<WorkflowRunInput>,
  query: WorkflowFilterQuery,
): WorkflowListPage {
  let filtered: WorkflowRunInput[] = runs.slice();
  const search = query.search?.trim().toLowerCase();
  if (search && search.length > 0) {
    filtered = filtered.filter(r =>
      r.runId.toLowerCase().includes(search) ||
      (r.workflowId ?? '').toLowerCase().includes(search),
    );
  }

  const chipCounts = computeChipCounts(filtered);

  let statusFiltered: WorkflowRunInput[] = filtered;
  if (query.status && query.status !== 'all') {
    statusFiltered = filtered.filter(r => r.status === query.status);
  }

  const total = statusFiltered.length;
  const pageSize = clampPageSize(query.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let page = typeof query.page === 'number' && Number.isFinite(query.page) ? Math.floor(query.page) : 1;
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * pageSize;
  const pageItems = statusFiltered.slice(start, start + pageSize);

  return {
    rows: pageItems.map(projectRunRowDto),
    meta: { page, pageSize, total, totalPages },
    chipCounts,
  };
}
