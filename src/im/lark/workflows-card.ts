/**
 * Workflows list card (PR3 `/dashboard workflows` slice 1 + slice 2a).
 *
 * Slice 1 — read-only list + pagination + refresh.
 * Slice 2a — per-row "📂 详情" button opens a detail card; detail card has
 *           "⏏ 取消" (with Feishu confirm dialog) + "🔙 返回" actions.
 *
 * Detail-card pattern (codex 2026-06-10 scope-cut):
 *  - List card stays read-only beyond the "📂 详情" inline button.
 *  - All action buttons live on the detail card.
 *  - Cancel is the ONLY write action this slice. Approve/Reject land in
 *    slice 2b/2c (they need an ask-token context for resolver routing).
 *
 * Sync cancel (refetch — NOT optimistic state):
 *  - The cancel callback awaits the Route B POST inline.
 *  - On 200 → cancel may land terminal asynchronously (the helper signals
 *    the run; the actual transition can happen on a separate tick). Do a
 *    2nd GET `/__daemon/workflows-runs-snapshot?all=1` and re-project the
 *    fresh row. If the 2nd GET fails OR the row vanished from the listing,
 *    fall back to a `{...before, status: 'cancelled'}` synth — the user may
 *    see a one-cycle-stale render before the next refresh catches up.
 *    Closer to schedules slice 2a RESUME (which 2nd-GETs to let
 *    `scheduler.computeNextRun` produce nextRunAt) than to PAUSE (pure
 *    synth) — workflow cancel is asymmetric the same way.
 *  - On non-200 / network throw → return ONLY a toast. We do NOT redraw the
 *    card so the user keeps their current state for retry.
 *
 * Identity / security:
 *  - `invokerOpenId` is the owner's `ou_*` and is the invoker-lock anchor.
 *  - sender union_id NEVER lands on `action.value` (red line).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - `value.run_id` is read but NEVER trusted for identity — only used as
 *    the routing key. The owner gate is the only authority. The Route B
 *    upstream further enforces `chatBinding.larkAppId` scope (and as of
 *    2026-06-10 also gates cross-bot cancel/approve/reject by
 *    `callerAppId`).
 *  - Before any POST we re-run the PR1 `computeActionAvailability` matrix
 *    against the fresh snapshot AND check `chatBinding.larkAppId` is
 *    routable. Both fail-closed defensively: a replayed event or an old
 *    card could otherwise drive a state-violating POST that the Route B
 *    gate would later reject — surface the disabled reason inline so the
 *    user sees the same string they would see on the disabled button.
 *
 * Response shape: success path returns ONLY `{ card }` (no toast) so Lark
 * renders the card in a single pass.
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type {
  WorkflowRunDetailDto,
  WorkflowRunDetailInput,
  WorkflowRunInput,
  WorkflowRunRowDto,
} from '../../dashboard/workflow-card-model.js';
import {
  computeActionAvailability,
  projectRunDetailDto,
  projectRunRowDto,
} from '../../dashboard/workflow-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const WORKFLOWS_ACTION_REFRESH = 'dash_workflows_refresh' as const;
export const WORKFLOWS_ACTION_PAGE = 'dash_workflows_page' as const;
export const WORKFLOWS_ACTION_DETAIL = 'dash_workflows_detail' as const;
export const WORKFLOWS_ACTION_CANCEL = 'dash_workflows_cancel' as const;
export const WORKFLOWS_ACTION_BACK_TO_LIST = 'dash_workflows_back_to_list' as const;

/** Default page size for `/dashboard workflows` — unified at 5/page across
 *  all dashboard list cards on user request 2026-06-10. */
const PAGE_SIZE = 5;

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

/** Build the workflows list card JSON. Pure (paginates + renders).
 *  Server-side listRuns order is preserved verbatim — no client-side resort.
 *  See module docblock for the rationale. */
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
      // Per-row action element holding ONLY the "📂 详情" button (slice 2a).
      // Each row owns its own action block so its run_id can flow through
      // `value.run_id` as the routing key (same shape as schedules slice 2a).
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.dashboard.workflows.row_detail', undefined, opts.locale) },
            type: 'default',
            value: {
              action: WORKFLOWS_ACTION_DETAIL,
              invoker_open_id: opts.invokerOpenId,
              run_id: dto.runId,
            },
          },
        ],
      });
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

/** Slice-2a options for the detail card. */
export interface BuildWorkflowsDetailCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** Override `Date.now()` so the relative-time formatter is deterministic in tests. */
  nowMs?: number;
}

/**
 * Build the detail card (slice 2a). Status icon + bold workflow label + runId
 * monospace; key/value block for status / startedAt / updatedAt / finishedAt /
 * elapsed / progress / chatBinding; optional node-progress section; action row
 * with cancel + back.
 *
 * The cancel button is disabled when EITHER:
 *   - PR1 `computeActionAvailability(status).cancel.enabled === false`
 *     (terminal status: succeeded / failed / cancelled), OR
 *   - `chatBinding.larkAppId` is missing — no routable owner for Route B to
 *     proxy to. The `runCancel` helper would 409 `needs_cli_cancel` here, so
 *     we fail-closed at the UI layer too.
 * Both disabled reasons surface as inline notes next to the button.
 */
export function buildWorkflowsDetailCard(
  detail: WorkflowRunDetailDto,
  opts: BuildWorkflowsDetailCardOpts,
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const elements: unknown[] = [];

  // ─── Title — status dot + bold workflow label + runId monospace ────────
  const icon = toneIcon(detail.dot.tone);
  const titleLabel = detail.workflowId && detail.workflowId.length > 0
    ? detail.workflowId
    : detail.runId.slice(0, 8);
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(titleLabel)}** ${escapeLarkMd(statusBadge(detail.status))}` +
        `\n\`${escapeLarkMd(detail.runId)}\``,
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Key/value block ───────────────────────────────────────────────────
  const infoLines: string[] = [];
  if (detail.workflowId) {
    infoLines.push(
      t('card.dashboard.workflows.detail.workflow_label', { workflowId: escapeLarkMd(detail.workflowId) }, opts.locale),
    );
  }
  infoLines.push(
    t('card.dashboard.workflows.detail.run_label', { runId: escapeLarkMd(detail.runId) }, opts.locale),
  );
  infoLines.push(
    t('card.dashboard.workflows.detail.status_label', { status: escapeLarkMd(detail.status) }, opts.locale),
  );
  infoLines.push(
    t(
      'card.dashboard.workflows.detail.started_label',
      { rel: escapeLarkMd(formatRelative(detail.startedAtMs, nowMs)) },
      opts.locale,
    ),
  );
  infoLines.push(
    t(
      'card.dashboard.workflows.detail.updated_label',
      { rel: escapeLarkMd(formatRelative(detail.updatedAtMs, nowMs)) },
      opts.locale,
    ),
  );
  // finished_at only surfaces on terminal states.
  if (typeof detail.finishedAtMs === 'number' && Number.isFinite(detail.finishedAtMs)) {
    infoLines.push(
      t(
        'card.dashboard.workflows.detail.finished_label',
        { rel: escapeLarkMd(formatRelative(detail.finishedAtMs, nowMs)) },
        opts.locale,
      ),
    );
  }
  if (detail.elapsedLabel) {
    infoLines.push(
      t('card.dashboard.workflows.detail.elapsed_label', { elapsed: escapeLarkMd(detail.elapsedLabel) }, opts.locale),
    );
  }
  if (detail.progressLabel) {
    infoLines.push(
      t('card.dashboard.workflows.detail.progress_label', { progress: escapeLarkMd(detail.progressLabel) }, opts.locale),
    );
  }
  if (detail.chatBinding) {
    const chatId = detail.chatBinding.chatId ?? '';
    const larkAppId = detail.chatBinding.larkAppId ?? '';
    const chatLabel = larkAppId
      ? `${chatId} · ${larkAppId}`
      : chatId;
    if (chatLabel) {
      infoLines.push(
        t('card.dashboard.workflows.detail.chat_label', { chat: escapeLarkMd(chatLabel) }, opts.locale),
      );
    }
  }
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: infoLines.map(l => `<font color="grey">${l}</font>`).join('\n'),
    },
  });

  // ─── Nodes section (if any) ────────────────────────────────────────────
  if (detail.nodes.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**${t('card.dashboard.workflows.detail.nodes_header', undefined, opts.locale)}**\n` +
          detail.nodes.map(n => {
            const name = n.name ?? n.nodeId;
            const statusBit = n.status ? ` [${escapeLarkMd(n.status)}]` : '';
            return `- ${n.index}. ${escapeLarkMd(name)}${statusBit}`;
          }).join('\n'),
      },
    });
  }

  elements.push({ tag: 'hr' });

  // ─── Action row — cancel (danger w/ confirm) + back ────────────────────
  // Two-condition disable: terminal status OR missing routable owner.
  const matrixAllows = detail.actions.cancel.enabled === true;
  const hasOwner =
    typeof detail.chatBinding?.larkAppId === 'string' && detail.chatBinding.larkAppId.length > 0;
  const cancelEnabled = matrixAllows && hasOwner;

  const cancelButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.workflows.btn.cancel', undefined, opts.locale) },
    type: 'danger',
    value: {
      action: WORKFLOWS_ACTION_CANCEL,
      invoker_open_id: opts.invokerOpenId,
      run_id: detail.runId,
    },
  };
  if (cancelEnabled) {
    // Feishu V1 card schema confirm dialog. Only attach when the button is
    // actually clickable — there is no value in confirming a disabled button.
    cancelButton.confirm = {
      title: { tag: 'plain_text', content: t('card.dashboard.workflows.confirm.cancel.title', undefined, opts.locale) },
      text: {
        tag: 'plain_text',
        content: t(
          'card.dashboard.workflows.confirm.cancel.text',
          { runId: detail.runId },
          opts.locale,
        ),
      },
    };
  } else {
    cancelButton.disabled = true;
  }

  elements.push({
    tag: 'action',
    actions: [
      cancelButton,
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.workflows.btn.back', undefined, opts.locale) },
        type: 'default',
        value: {
          action: WORKFLOWS_ACTION_BACK_TO_LIST,
          invoker_open_id: opts.invokerOpenId,
        },
      },
    ],
  });

  // Surface inline reason next to a disabled cancel button. Owner-missing
  // takes precedence over terminal — a terminal run with no owner is still
  // primarily "no routable owner" from the dashboard's POV. The mapped key
  // is one of:
  //   card.dashboard.workflows.cancel.disabled.alreadyTerminal
  //   card.dashboard.workflows.cancel.disabled.noOwner
  if (!cancelEnabled) {
    const reasonKey = !hasOwner
      ? 'card.dashboard.workflows.cancel.disabled.noOwner'
      : mapCancelDisabledReason(detail.actions.cancel.reasonKey);
    if (reasonKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: t(reasonKey, undefined, opts.locale) },
        ],
      });
    }
  }

  // Footer security note (mirrors list card).
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.workflows.detail.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/** Map PR1 cancel-disabled reasonKey to the slice-2a i18n key. */
function mapCancelDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'workflows.action.cancel.terminal':
      return 'card.dashboard.workflows.cancel.disabled.alreadyTerminal';
    default:
      return undefined;
  }
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

/** Dispatch a `dash_workflows_*` action callback. */
export async function handleWorkflowsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: WorkflowsCardHandlerDeps,
): Promise<WorkflowsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ─── 1) Invoker lock — fail-closed ──────────────────────────────────
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

  // ─── 2) Per-bot owner gate ──────────────────────────────────────────
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // Validate the action BEFORE creating the Route B client — an unknown
  // action shouldn't even open a connection (defensive, also keeps the
  // slice-1 invariant that the unknown-action path doesn't touch the
  // client).
  const validActions = new Set<string>([
    WORKFLOWS_ACTION_REFRESH,
    WORKFLOWS_ACTION_PAGE,
    WORKFLOWS_ACTION_DETAIL,
    WORKFLOWS_ACTION_CANCEL,
    WORKFLOWS_ACTION_BACK_TO_LIST,
  ]);
  if (!validActions.has(action)) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  const client = deps.createClient(larkAppId);
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ─── 3a) DETAIL — open the per-run detail card ──────────────────────
  if (action === WORKFLOWS_ACTION_DETAIL) {
    const runId = value.run_id;
    if (typeof runId !== 'string' || !runId) {
      return errorToast('card.dashboard.workflows.workflow_not_found', undefined, locale);
    }
    const r = await safeGetWorkflowsList(client, locale);
    if ('errorResult' in r) return r.errorResult;
    const row = r.runs.find(x => x.runId === runId);
    if (!row) {
      return errorToast('card.dashboard.workflows.workflow_not_found', undefined, locale);
    }
    const detail = projectRunDetailDto(row as WorkflowRunDetailInput, { nowMs: now() });
    const cardJson = buildWorkflowsDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      nowMs: now(),
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3b) CANCEL — refetch-based cancel, then redraw detail ──────────
  if (action === WORKFLOWS_ACTION_CANCEL) {
    const runId = value.run_id;
    if (typeof runId !== 'string' || !runId) {
      return errorToast('card.dashboard.workflows.workflow_not_found', undefined, locale);
    }

    // Pre-POST snapshot — needed to (a) confirm the run still exists and
    // (b) re-run both the PR1 matrix check AND the owner-routability check
    // against the freshest server state. This is the security-defense
    // layer at the IM tier; the Route B handler also gates by callerAppId.
    const pre = await safeGetWorkflowsList(client, locale);
    if ('errorResult' in pre) return pre.errorResult;
    const before = pre.runs.find(x => x.runId === runId);
    if (!before) {
      return errorToast('card.dashboard.workflows.workflow_not_found', undefined, locale);
    }

    // codex 2026-06-10 SECURITY REFINEMENT #3: TWO disabled conditions.
    // Both fail-closed BEFORE any POST.
    //   (a) PR1 matrix says cancel is enabled for this status
    //   (b) chatBinding.larkAppId is present (routable owner)
    // Surface the same i18n key the builder uses for the inline note so
    // the toast and disabled-button reason agree.
    const availability = computeActionAvailability(before.status);
    if (availability.cancel.enabled !== true) {
      const mappedKey = mapCancelDisabledReason(availability.cancel.reasonKey)
        ?? 'card.dashboard.workflows.cancel.disabled.alreadyTerminal';
      return errorToast(mappedKey, undefined, locale);
    }
    if (typeof before.chatBinding?.larkAppId !== 'string' || before.chatBinding.larkAppId.length === 0) {
      return errorToast('card.dashboard.workflows.cancel.disabled.noOwner', undefined, locale);
    }

    // POST cancel. Route B owner gate is the authority on whether THIS
    // bot's owner can cancel THIS run; the IM layer only sanitizes the
    // routing key + does the matrix check above.
    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/workflows-runs/${encodeURIComponent(runId)}/cancel`,
      });
    } catch (e) {
      return errorToast('card.dashboard.workflows.cancel_failed', { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      // Preserve user state — do NOT redraw card on failure.
      return errorToast('card.dashboard.workflows.cancel_failed', { reason }, locale);
    }

    // codex 2026-06-10 refinement #2: cancel may land terminal on a separate
    // tick (the helper signals the run; the actual transition is async). Do
    // a 2nd GET and re-project the fresh row. If the GET fails OR the row
    // vanished, fall back to `{...before, status: 'cancelled'}` synth — the
    // user may see a one-cycle-stale render before the next refresh catches
    // up, which is preferable to no card at all.
    const postRefetch = await safeGetWorkflowsList(client, locale);
    let after: WorkflowRunInput | undefined;
    if ('errorResult' in postRefetch) {
      after = undefined;
    } else {
      after = postRefetch.runs.find(x => x.runId === runId);
    }
    if (!after) {
      after = { ...before, status: 'cancelled' };
    }
    const detail = projectRunDetailDto(after as WorkflowRunDetailInput, { nowMs: now() });
    const cardJson = buildWorkflowsDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      nowMs: now(),
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3c) BACK TO LIST — rebuild list card at page 1 ─────────────────
  if (action === WORKFLOWS_ACTION_BACK_TO_LIST) {
    const r = await safeGetWorkflowsList(client, locale);
    if ('errorResult' in r) return r.errorResult;
    const cardJson = buildWorkflowsCard(
      r.runs,
      { invokerOpenId: expectedOwner, locale, page: 1 },
      now(),
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3d) Slice-1 actions — REFRESH + PAGE ───────────────────────────
  // `action` is already constrained to validActions above; the only ones
  // left here are REFRESH + PAGE (the other 3 returned early).
  let page = 1;
  if (action === WORKFLOWS_ACTION_PAGE) {
    const parsed = Number.parseInt(value.page ?? '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  }

  const r = await safeGetWorkflowsList(client, locale);
  if ('errorResult' in r) return r.errorResult;
  const cardJson = buildWorkflowsCard(
    r.runs,
    { invokerOpenId: expectedOwner, locale, page },
    now(),
  );
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

/**
 * GET `/__daemon/workflows-runs-snapshot?all=1` and surface non-200 / network
 * errors as caller-facing error toasts. `?all=1` is the slice 1 invariant —
 * default listRuns hides terminal runs (succeeded/failed/cancelled), so the
 * counters and the detail/cancel paths would miss recently-terminated runs
 * without it. Returns either `{ runs }` or `{ errorResult }` — exactly one
 * is set.
 */
async function safeGetWorkflowsList(
  client: DaemonClient,
  locale: Locale,
): Promise<{ runs: ReadonlyArray<WorkflowRunInput> } | { errorResult: WorkflowsCardHandlerResult }> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method: 'GET', path: '/__daemon/workflows-runs-snapshot?all=1' });
  } catch (e) {
    return { errorResult: errorToast('card.dashboard.workflows.list_failed', { reason: (e as Error).message }, locale) };
  }
  if (r.status !== 200) {
    const reason = String((r.body as Record<string, unknown> | undefined)?.error ?? `http_${r.status}`);
    return { errorResult: errorToast('card.dashboard.workflows.list_failed', { reason }, locale) };
  }
  const runs = ((r.body as { runs?: ReadonlyArray<WorkflowRunInput> })?.runs) ?? [];
  return { runs };
}
