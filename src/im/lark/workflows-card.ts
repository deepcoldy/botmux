/**
 * Workflows list card (PR3 `/dashboard workflows` slice 1).
 *
 * Read-only list + pagination + refresh. NO cancel / approve / reject /
 * search / status filter / chip filters in this slice. Codex scope-cut on
 * 2026-06-09: those need an action-state pattern (optimistic-state +
 * rollback) plus filter design which we'll land in slice 2.
 *
 * Identity / security mirrors sessions-card.ts (slice 1):
 *  - `invokerOpenId` is the owner's `ou_*` (invoker-lock anchor).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - sender union_id NEVER lands on action.value.
 *
 * Response: success returns `{ card }` only (no toast) — single-pass render,
 * no stale-frame flash. Errors / permission denials return `{ toast }`.
 *
 * Sort order: active group (running/waiting/pending) before terminal group
 * (succeeded/failed/cancelled); within each group, ordered by startedAtMs
 * descending. Rows without startedAt sink to the bottom of their group.
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type {
  WorkflowRunInput,
  WorkflowRunRowDto,
} from '../../dashboard/workflow-card-model.js';
import { projectRunRowDto } from '../../dashboard/workflow-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const WORKFLOWS_ACTION_REFRESH = 'dash_workflows_refresh' as const;
export const WORKFLOWS_ACTION_PAGE = 'dash_workflows_page' as const;

const PAGE_SIZE = 10;

/** Mapping from `StatusDot.tone` to a stable colour-emoji prefix. Pure. */
function toneIcon(tone: string): string {
  switch (tone) {
    case 'success': return '🟢';
    case 'info':    return '🔵';
    case 'warning': return '🟡';
    case 'danger':  return '🔴';
    case 'neutral': return '⚪';
    default:        return '⚫';
  }
}

/** Short status badge used after the title — '[running]' / '[failed]' etc. */
function statusBadge(status: string): string {
  return `[${status}]`;
}

/** Relative-time formatter: 'just now' / 'Ns ago' / 'Nm ago' / 'Nh ago' / 'Nd ago'. */
function formatRelative(fromMs: number | undefined, nowMs: number): string {
  if (typeof fromMs !== 'number' || !Number.isFinite(fromMs) || fromMs <= 0) return '—';
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}

export interface BuildWorkflowsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
}

/** Tally counts across the (unfiltered) run pool. Pure.
 *  Buckets follow slice 1 spec:
 *    running = pending | running | waiting
 *    done    = succeeded
 *    failed  = failed | cancelled
 */
function countByStatus(rows: ReadonlyArray<WorkflowRunInput>): {
  running: number;
  done: number;
  failed: number;
} {
  let running = 0, done = 0, failed = 0;
  for (const r of rows) {
    switch (r.status) {
      case 'running':
      case 'waiting':
      case 'pending':
        running += 1; break;
      case 'succeeded':
        done += 1; break;
      case 'failed':
      case 'cancelled':
        failed += 1; break;
    }
  }
  return { running, done, failed };
}

/** Paginate a row list. Mirrors paginateSchedules semantics.
 *
 *  codex 2026-06-09 refinement: workflows slice 1 deliberately does NOT
 *  re-sort. The Route B `listWorkflowRuns` already returns rows in the
 *  canonical order used by the dashboard web UI; resorting here would
 *  silently diverge from that order, which is harder to reason about than
 *  having the daemon own the canonical sort. Slice 2 may revisit if a
 *  ranking model is introduced for action buttons. */
function paginate<T>(
  items: ReadonlyArray<T>,
  page: number,
  pageSize: number,
): { items: T[]; page: number; totalPages: number; total: number } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let active = Number.isFinite(page) ? Math.floor(page) : 1;
  if (active < 1) active = 1;
  if (active > totalPages) active = totalPages;
  const start = (active - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: active,
    totalPages,
    total,
  };
}

/** Build the workflows list card JSON. Pure (sorts + paginates + renders).
 *
 *  Sort: active group (running/waiting/pending) before terminal
 *  (succeeded/failed/cancelled); within each group, startedAtMs descending.
 */
export function buildWorkflowsCard(
  rows: ReadonlyArray<WorkflowRunInput>,
  opts: BuildWorkflowsCardOpts,
  nowMs: number,
): string {
  const { running, done, failed } = countByStatus(rows);
  // Server order from listRuns is preserved verbatim — paginate directly.
  const paged = paginate(rows, opts.page, PAGE_SIZE);

  const elements: unknown[] = [];

  // Sub-header — counts + page indicator.
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t(
        'card.dashboard.workflows.count_summary',
        {
          running: String(running),
          done: String(done),
          failed: String(failed),
          page: String(paged.page),
          totalPages: String(paged.totalPages),
        },
        opts.locale,
      ),
    },
  });

  elements.push({ tag: 'hr' });

  if (paged.items.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: t('card.dashboard.workflows.empty', undefined, opts.locale),
      },
    });
  } else {
    for (const run of paged.items) {
      const dto = projectRunRowDto(run);
      elements.push(renderRow(dto, opts.locale, nowMs));
    }
  }

  elements.push({ tag: 'hr' });

  // Pagination + refresh.
  const actions: unknown[] = [];
  if (paged.totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.workflows.prev', undefined, opts.locale) },
      type: 'default',
      disabled: paged.page <= 1,
      value: {
        action: WORKFLOWS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.max(1, paged.page - 1)),
      },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.workflows.next', undefined, opts.locale) },
      type: 'default',
      disabled: paged.page >= paged.totalPages,
      value: {
        action: WORKFLOWS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.min(paged.totalPages, paged.page + 1)),
      },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.workflows.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: WORKFLOWS_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
    },
  });
  elements.push({ tag: 'action', actions });

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.workflows.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(row: WorkflowRunRowDto, locale: Locale, nowMs: number): unknown {
  const icon = toneIcon(row.dot.tone);
  // Primary: status icon + bold (workflowId || runId[0..8]) + ' ' + [status]
  const primaryLabel = row.workflowId && row.workflowId.length > 0
    ? row.workflowId
    : row.runId.slice(0, 8);
  const badge = statusBadge(row.status);

  // Secondary: progress + started + updated. Only show if at least one is present.
  const raw = row.raw;
  const secondaryParts: string[] = [];
  if (
    typeof raw.nodesDone === 'number' && Number.isFinite(raw.nodesDone) &&
    typeof raw.nodesTotal === 'number' && Number.isFinite(raw.nodesTotal) && raw.nodesTotal > 0
  ) {
    secondaryParts.push(
      t('card.dashboard.workflows.progress_label', {
        done: String(raw.nodesDone),
        total: String(raw.nodesTotal),
      }, locale),
    );
  }
  if (typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)) {
    secondaryParts.push(
      t('card.dashboard.workflows.started_label', { rel: formatRelative(raw.startedAt, nowMs) }, locale),
    );
  }
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) {
    secondaryParts.push(
      t('card.dashboard.workflows.updated_label', { rel: formatRelative(raw.updatedAt, nowMs) }, locale),
    );
  }

  const secondary = secondaryParts.length > 0
    ? `\n<font color="grey">${escapeLarkMd(secondaryParts.join(' · '))}</font>`
    : '';

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(primaryLabel)}** ${escapeLarkMd(badge)}` + secondary,
    },
  };
}

/**
 * Sanitize user-/CLI-supplied text for inclusion in lark_md. See
 * `sessions-card.ts:escapeLarkMd` for the order rationale: `&` first to
 * avoid `&` → `&amp;` then `<` → `&lt;` getting re-encoded as `&amp;lt;`.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface WorkflowsCardHandlerDeps {
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  createClient: (larkAppId: string) => DaemonClient;
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export interface WorkflowsCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): WorkflowsCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(
  textKey: string,
  params: Record<string, string> | undefined,
  locale: Locale,
): WorkflowsCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/** Dispatch a `dash_workflows_*` action callback. Mirrors sessions-card. */
export async function handleWorkflowsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: WorkflowsCardHandlerDeps,
): Promise<WorkflowsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // Invoker lock — fail-closed.
  const invokerOpenId = value.invoker_open_id;
  if (typeof invokerOpenId !== 'string' || !invokerOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (typeof operatorOpenId !== 'string' || !operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (invokerOpenId !== operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }

  // Per-bot owner gate.
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // Resolve target page.
  let page = 1;
  if (action === WORKFLOWS_ACTION_PAGE) {
    const parsed = Number.parseInt(value.page ?? '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  } else if (action !== WORKFLOWS_ACTION_REFRESH) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  // GET list + rebuild card. Same non-200 handling as sessions slice 1
  // (codex blocker #1, 2026-06-09): 4xx/5xx → error toast, NOT empty list.
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    const client = deps.createClient(larkAppId);
    r = await client.request({ method: 'GET', path: '/__daemon/workflows-runs-snapshot' });
  } catch (e) {
    return errorToast('card.dashboard.workflows.list_failed', { reason: (e as Error).message }, locale);
  }
  if (r.status !== 200) {
    const reason = String((r.body as any)?.error ?? `http_${r.status}`);
    return errorToast('card.dashboard.workflows.list_failed', { reason }, locale);
  }
  const rows = ((r.body as { runs?: ReadonlyArray<WorkflowRunInput> })?.runs) ?? [];
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const cardJson = buildWorkflowsCard(rows, { invokerOpenId: expectedOwner, locale, page }, nowMs);
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}
