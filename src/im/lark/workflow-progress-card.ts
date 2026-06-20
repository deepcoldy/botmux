/**
 * Run-level workflow progress card (v0.1.5 slice 1).
 *
 * Single Feishu card per workflow run that gets PATCHed on every state
 * change so a chat thread sees one self-updating tile instead of a wall
 * of per-event replies.
 *
 * Codex co-designed the public hook contract:
 *   - `enrichWithTerminalLink(activityId, attemptId)` returns a
 *     `WorkflowProgressCardTerminalLink` when the workflow-attempt
 *     terminal sidecar (slice 2, owned by codex) has something
 *     openable.  Slice 1 ships without ever wiring this; the field is
 *     a placeholder so slice 3 plugs in without re-shaping the JSON.
 *   - Card-update failures must never disturb workflow runtime — every
 *     send/patch site is wrapped in try/catch + logger.warn.
 *   - daemon-internal Map only (no on-disk persistence) — daemon
 *     restart losing the cardMessageId is an accepted limitation for
 *     this slice.
 */

import type { Snapshot, RunStatus, NodeStatus, ActivityStatus } from '../../workflows/events/replay.js';
import { t, type Locale } from '../../i18n/index.js';
import { workflowRunDetailUrl } from './workflow-cards.js';

export { workflowRunDetailUrl };

export type WorkflowProgressCardTerminalLink = {
  url: string;
  /** UI label.  Defaults derive from `kind` when omitted. */
  label?: string;
  /** `live-terminal` = attempt still in-flight; `execution-log` = attempt ended. */
  kind: 'live-terminal' | 'execution-log';
};

export type WorkflowProgressCardOptions = {
  /** Codex slice-2 hook.  Returning undefined hides the per-attempt button. */
  enrichWithTerminalLink?: (
    activityId: string,
    attemptId: string,
  ) => WorkflowProgressCardTerminalLink | undefined;
  /** Override the dashboard link (mostly tests). */
  webDetailUrl?: string;
  /** Max running/waiting nodes to inline.  Excess collapses to "+N more". */
  maxInlineRows?: number;
  /**
   * Total number of nodes in the workflow definition.  Used as the
   * denominator in the "X / Y 节点完成" progress line.  Falls back to
   * `snapshot.nodes.size` when omitted — that only counts TRIGGERED
   * nodes so the fraction grows misleadingly (1/2 → 2/3 …) on
   * longer workflows.
   */
  totalNodes?: number;
  /** UI locale for card chrome (labels/sections). Falls back to the process
   *  default when omitted. */
  locale?: Locale;
};

const DEFAULT_MAX_INLINE_ROWS = 6;

/**
 * Build the initial "starting" card body (no events past `runCreated`).
 *
 * Called once at IM-side `/workflow run` time so the user sees the tile
 * BEFORE the first `attemptCreated` lands — otherwise there's a multi-
 * second hole between "I sent the command" and "card shows up".
 */
export function buildWorkflowStartingCard(input: {
  runId: string;
  workflowId: string;
  webDetailUrl?: string;
  locale?: Locale;
}): string {
  const webDetailUrl = input.webDetailUrl ?? workflowRunDetailUrl(input.runId);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `🔄 Workflow · ${input.workflowId}` },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**runId**\n${escapeMd(short(input.runId, 28))}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**${t('card.wf.field.status', undefined, input.locale)}**\n⏳ starting` } },
        ],
      },
      detailButton(webDetailUrl, input.locale),
    ],
  });
}

/**
 * Build the card body from the current snapshot — called every time
 * the fanout watcher sees a state-changing event for this run.
 */
export function buildWorkflowProgressCard(
  snapshot: Snapshot,
  opts: WorkflowProgressCardOptions = {},
): string {
  const webDetailUrl = opts.webDetailUrl ?? workflowRunDetailUrl(snapshot.run.runId);
  const maxRows = opts.maxInlineRows ?? DEFAULT_MAX_INLINE_ROWS;
  const loc = opts.locale;
  const status = snapshot.run.status;
  const template = headerTemplateForStatus(status);
  const title = `${headerEmoji(status)} Workflow · ${snapshot.run.workflowId ?? 'unknown'}`;

  const counts = summarizeNodes(snapshot);
  // Use the workflow-definition total when supplied; falls back to
  // observed-triggered count (the old behaviour) only when the caller
  // doesn't know.  Either way clamp to `max(observed, total)` so a
  // stale def can't claim fewer nodes than we've actually seen events
  // for.
  const denominator = opts.totalNodes != null
    ? Math.max(opts.totalNodes, counts.total)
    : counts.total;
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  // Run-terminal state hides the 🏃 进行中 list — otherwise a parallel
  // branch whose `activityCanceled` hasn't been written yet would
  // appear "still running" on a card that's already red/grey, which
  // contradicts the header status.
  const runningRows = isTerminal ? [] : collectRunningRows(snapshot);
  const waitingRows = isTerminal ? [] : collectWaitingRows(snapshot);
  const loopRows = isTerminal ? [] : collectLoopRows(snapshot);
  const failureSummary = summarizeFailure(snapshot, loc);

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**runId**\n${escapeMd(short(snapshot.run.runId, 28))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**${t('card.wf.field.status', undefined, loc)}**\n${statusBadge(status)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**${t('card.wf.field.progress', undefined, loc)}**\n${t('card.wf.progress_value', { done: counts.succeeded, total: denominator }, loc)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**${t('card.wf.field.failed', undefined, loc)}**\n${counts.failed}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**${t('card.wf.resolved.cancelled', undefined, loc)}**\n${counts.cancelled}` } },
      ],
    },
  ];

  if (runningRows.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**🏃 ${t('card.wf.section.running', undefined, loc)}** (${runningRows.length})` },
    });
    appendRows(elements, runningRows, maxRows, opts);
  }

  if (waitingRows.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**⏸ ${t('card.wf.section.waiting', undefined, loc)}** (${waitingRows.length})` },
    });
    appendRows(elements, waitingRows, maxRows, opts);
  }

  // v0.2 loop iteration view (collapsible-style summary line per active
  // loop block).  See /tmp/wf-loop-v02.md §9 — terminal status hides
  // this section the same way `running` / `waiting` are hidden once
  // the run reaches a terminal state.
  if (loopRows.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**🔁 ${t('card.wf.section.loop', undefined, loc)}** (${loopRows.length})` },
    });
    appendLoopRows(elements, loopRows);
  }

  if (failureSummary) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: failureSummary },
    });
  }

  elements.push(detailButton(webDetailUrl, loc));

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

// ─── Internal helpers ──────────────────────────────────────────────────────

type AttemptRow = {
  nodeId: string;
  activityId: string;
  attemptId?: string;
  status: ActivityStatus | NodeStatus;
};

function summarizeNodes(snap: Snapshot): {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
} {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  for (const node of snap.nodes.values()) {
    if (node.status === 'succeeded') succeeded++;
    else if (node.status === 'failed') failed++;
    else if (node.status === 'cancelled') cancelled++;
  }
  return { total: snap.nodes.size, succeeded, failed, cancelled };
}

function collectRunningRows(snap: Snapshot): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (const node of snap.nodes.values()) {
    if (node.status !== 'running' && node.status !== 'retrying') continue;
    const activity = node.activityId ? snap.activities.get(node.activityId) : undefined;
    rows.push({
      nodeId: node.nodeId,
      activityId: activity?.activityId ?? node.activityId ?? '',
      attemptId: activity?.currentAttemptId,
      status: activity?.status ?? node.status,
    });
  }
  return rows;
}

function collectWaitingRows(snap: Snapshot): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (const node of snap.nodes.values()) {
    if (node.status !== 'waiting') continue;
    const activity = node.activityId ? snap.activities.get(node.activityId) : undefined;
    rows.push({
      nodeId: node.nodeId,
      activityId: activity?.activityId ?? node.activityId ?? '',
      attemptId: activity?.currentAttemptId,
      status: activity?.status ?? node.status,
    });
  }
  return rows;
}

type LoopRow = {
  loopId: string;
  iteration: number;
  maxIterations: number;
  iterStatus: 'running' | 'approved' | 'rejected' | 'failed' | 'cancelled';
};

/**
 * One row per active loop block (status === 'running').  Settled loops
 * (succeeded / failed / cancelled) are NOT included because the parent
 * card hides this whole section once the run reaches a terminal status.
 * Body-node in-flight activities still show up in the run-level
 * `running` rows; the loop section is the "where are we in the
 * iteration cycle" overlay.
 */
function collectLoopRows(snap: Snapshot): LoopRow[] {
  if (!snap.loops || snap.loops.size === 0) return [];
  const rows: LoopRow[] = [];
  for (const loop of snap.loops.values()) {
    if (loop.status !== 'running') continue;
    // iteration === 0 means startLoop emitted but startLoopIteration
    // hasn't yet — clamp to 1 so the user-facing "iteration N/M"
    // doesn't show 0/M during that microsecond window.
    const iter = Math.max(1, loop.iteration);
    const currentIterState = loop.iterations[iter - 1];
    rows.push({
      loopId: loop.loopId,
      iteration: iter,
      maxIterations: loop.maxIterations,
      iterStatus: currentIterState?.status ?? 'running',
    });
  }
  return rows;
}

function appendLoopRows(
  elements: Array<Record<string, unknown>>,
  rows: LoopRow[],
): void {
  const lines: string[] = [];
  for (const row of rows) {
    const iterText = `iteration ${row.iteration}/${row.maxIterations}`;
    lines.push(`• \`${escapeMd(row.loopId)}\` · ${iterText} (${row.iterStatus})`);
  }
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: lines.join('\n') },
  });
}

function summarizeFailure(snap: Snapshot, locale?: Locale): string | undefined {
  if (snap.run.status === 'failed' && snap.run.failedNodeId) {
    return `**💥 ${t('card.wf.failure_summary', undefined, locale)}**\nnode: \`${escapeMd(snap.run.failedNodeId)}\``;
  }
  if (snap.run.status === 'cancelled' && snap.run.cancelOriginEventId) {
    return `**🛑 ${t('card.wf.resolved.cancelled', undefined, locale)}**\norigin: \`${escapeMd(short(snap.run.cancelOriginEventId, 32))}\``;
  }
  return undefined;
}

function appendRows(
  elements: Array<Record<string, unknown>>,
  rows: AttemptRow[],
  maxRows: number,
  opts: WorkflowProgressCardOptions,
): void {
  const shown = rows.slice(0, maxRows);
  const lines: string[] = [];
  for (const row of shown) {
    const terminalLink =
      row.attemptId && opts.enrichWithTerminalLink
        ? safeEnrich(opts.enrichWithTerminalLink, row.activityId, row.attemptId)
        : undefined;
    const linkText = terminalLink
      ? ` · [${escapeMd(terminalLink.label ?? defaultTerminalLabel(terminalLink.kind, opts.locale))}](${terminalLink.url})`
      : '';
    lines.push(`• \`${escapeMd(row.nodeId)}\` (${row.status})${linkText}`);
  }
  if (rows.length > maxRows) {
    lines.push(`…(+${rows.length - maxRows} more)`);
  }
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: lines.join('\n') },
  });
}

function safeEnrich(
  fn: NonNullable<WorkflowProgressCardOptions['enrichWithTerminalLink']>,
  activityId: string,
  attemptId: string,
): WorkflowProgressCardTerminalLink | undefined {
  try {
    return fn(activityId, attemptId);
  } catch {
    // Codex contract boundary 1: card-side enrichment never breaks
    // runtime — silently drop the link, let the row render anyway.
    return undefined;
  }
}

function defaultTerminalLabel(kind: WorkflowProgressCardTerminalLink['kind'], locale?: Locale): string {
  return kind === 'live-terminal'
    ? t('card.wf.terminal.live', undefined, locale)
    : t('card.wf.terminal.log', undefined, locale);
}

function detailButton(url: string, locale?: Locale): Record<string, unknown> {
  return {
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.wf.btn_web_detail', undefined, locale) },
        type: 'default',
        multi_url: { url, pc_url: url, android_url: url, ios_url: url },
      },
    ],
  };
}

function headerTemplateForStatus(status: RunStatus): string {
  switch (status) {
    case 'succeeded': return 'green';
    case 'failed': return 'red';
    case 'cancelled': return 'grey';
    case 'waiting': return 'orange';
    case 'running': return 'blue';
    case 'pending': default: return 'blue';
  }
}

function headerEmoji(status: RunStatus): string {
  switch (status) {
    case 'succeeded': return '✅';
    case 'failed': return '❌';
    case 'cancelled': return '🛑';
    case 'waiting': return '⏸';
    case 'running': return '🔄';
    case 'pending': default: return '⏳';
  }
}

function statusBadge(status: RunStatus): string {
  return `${headerEmoji(status)} ${status}`;
}

/**
 * Slice 3 default enricher: pair the run-level card's per-row link with a
 * deeplink into Run Detail focused on the given attempt.  The dashboard
 * side (slice 2, codex 3335adc) reads `attemptIO[attemptId].terminal` and
 * renders the iframe — this enricher just constructs the URL.
 *
 * Only `running` activities get a link: that is the state where a
 * subagent worker has spawned and is expected to expose `terminal.json`
 * with a live web port.  `effectAttempting` is hostExecutor-side work
 * with no worker sidecar; `acquired` / `waiting` / `pending` skip for
 * the same "no sidecar yet" reason.
 */
export function buildAttemptDeeplinkEnricher(
  runId: string,
  snapshot: Snapshot,
): NonNullable<WorkflowProgressCardOptions['enrichWithTerminalLink']> {
  return (activityId, attemptId) => {
    const activity = snapshot.activities.get(activityId);
    if (!activity) return undefined;
    // Only subagent activities own a worker + web-terminal sidecar.
    // `effectAttempting` is a hostExecutor-side state (no worker, no
    // sidecar) — handing the user a live-terminal link there would land
    // them on an attempt with no terminal block.  `acquired` / `pending`
    // / `waiting` skip for the same "no sidecar yet" reason.
    if (activity.status !== 'running') return undefined;
    return {
      url: `${workflowRunDetailUrl(runId)}?attempt=${encodeURIComponent(attemptId)}`,
      kind: 'live-terminal',
    };
  };
}

function escapeMd(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/_/g, '\\_').replace(/`/g, '\\`');
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
