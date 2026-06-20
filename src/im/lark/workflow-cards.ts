import { config } from '../../config.js';
import { t, type Locale } from '../../i18n/index.js';
import type { WaitCreatedEvent } from '../../workflows/events/types.js';
import type { Snapshot } from '../../workflows/events/replay.js';
import { isPayloadRef } from '../../workflows/events/schema.js';

export const WORKFLOW_APPROVE_ACTION = 'wf_approve';
export const WORKFLOW_REJECT_ACTION = 'wf_reject';
export const WORKFLOW_CANCEL_ACTION = 'wf_cancel';
export const WORKFLOW_COMMENT_FIELD = 'wf_comment';
export const WORKFLOW_APPROVAL_FORM = 'wf_approval_form';

const DEFAULT_PROMPT_MAX_CHARS = 500;

export type WorkflowApprovalResolutionKind = 'approved' | 'rejected' | 'cancelled';

export type WorkflowApprovalCardResolution = {
  kind: WorkflowApprovalResolutionKind;
  by: string;
  comment?: string;
};

export type WorkflowApprovalCardOptions = {
  webDetailUrl?: string;
  cardNonce?: string;
  promptMaxChars?: number;
  /** When present, render a frozen "已通过 / 已拒绝 / 已取消" card — no form,
   *  no clickable approve/reject/cancel buttons — so the same surface that
   *  triggered the action can't be re-submitted from a stale UI. */
  resolution?: WorkflowApprovalCardResolution;
};

export type WorkflowApprovalCardContext = {
  runId: string;
  workflowId?: string;
  revisionId?: string;
  nodeId: string;
  activityId: string;
  attemptId: string;
  deadlineAt?: number;
  /** Body text for the card.  Either the full inline prompt (small case)
   *  or the inline promptPreview (large case).  Cards must NEVER read
   *  promptRef blob files — see `hasFullBehindRef`. */
  prompt: string;
  /** True when the upstream waitCreated event spilled its prompt to a
   *  blob (promptRef set).  Card-builder uses this to render a hint
   *  pointing the approver to the dashboard for the complete text. */
  hasFullBehindRef: boolean;
  cardNonce: string;
  webDetailUrl: string;
};

export function workflowApprovalCardNonce(
  runId: string,
  activityId: string,
  attemptId: string,
): string {
  return `wf:${runId}:${activityId}:${attemptId}`;
}

export function workflowRunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/workflows/${encodeURIComponent(runId)}`;
}

export function getWorkflowApprovalCardContext(
  event: WaitCreatedEvent,
  snapshot: Snapshot,
  opts: WorkflowApprovalCardOptions = {},
): WorkflowApprovalCardContext {
  if (isPayloadRef(event.payload)) {
    throw new Error('buildWorkflowApprovalCard: payload ref is not supported for waitCreated cards');
  }
  if (event.payload.waitKind !== 'human-gate') {
    throw new Error(`buildWorkflowApprovalCard: expected human-gate, got ${event.payload.waitKind}`);
  }

  const activity = snapshot.activities.get(event.payload.activityId);
  const attemptId = activity?.currentAttemptId ?? activity?.attempts.at(-1)?.attemptId;
  if (!attemptId) {
    throw new Error(
      `buildWorkflowApprovalCard: no attempt found for activity ${event.payload.activityId}`,
    );
  }

  // Promptref / promptPreview split (v0.1.3): the card never reads the
  // blob — promptPreview exists specifically so cards can render without
  // touching disk and the dashboard owns the full-text path.
  const hasFullBehindRef = event.payload.promptRef !== undefined;
  const promptBody = event.payload.prompt ?? event.payload.promptPreview ?? '';

  return {
    runId: event.runId,
    workflowId: snapshot.run.workflowId,
    revisionId: snapshot.run.revisionId,
    nodeId: event.payload.nodeId,
    activityId: event.payload.activityId,
    attemptId,
    deadlineAt: event.payload.deadlineAt,
    prompt: promptBody,
    hasFullBehindRef,
    cardNonce: opts.cardNonce ?? workflowApprovalCardNonce(event.runId, event.payload.activityId, attemptId),
    webDetailUrl: opts.webDetailUrl ?? workflowRunDetailUrl(event.runId),
  };
}

export function buildWorkflowApprovalCard(
  event: WaitCreatedEvent,
  snapshot: Snapshot,
  opts: WorkflowApprovalCardOptions = {},
  locale?: Locale,
): string {
  const ctx = getWorkflowApprovalCardContext(event, snapshot, opts);
  const promptMaxChars = opts.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
  const prompt = truncatePrompt(ctx.prompt, promptMaxChars, locale);
  const revision = ctx.revisionId ? short(ctx.revisionId, 12) : 'unknown';
  const workflow = ctx.workflowId ? `${ctx.workflowId} @ ${revision}` : `unknown @ ${revision}`;
  const deadline = ctx.deadlineAt ? new Date(ctx.deadlineAt).toLocaleString('zh-CN') : t('card.wf.none', undefined, locale);

  const resolution = opts.resolution;
  const title = resolution
    ? t('card.wf.title_resolved', { prefix: resolutionTitlePrefix(resolution.kind, locale), node: titleText(ctx.nodeId) }, locale)
    : t('card.wf.title_pending', { node: titleText(ctx.nodeId) }, locale);
  const template = resolution ? resolutionTemplate(resolution.kind) : 'blue';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Workflow**\n${escapeMd(workflow)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(ctx.runId, 16))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Step**\n${escapeMd(ctx.nodeId)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Deadline**\n${escapeMd(deadline)}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: ctx.hasFullBehindRef
          ? `**${t('card.wf.review_content', undefined, locale)}**${t('card.wf.review_preview_suffix', undefined, locale)}\n${escapeMd(prompt)}`
          : `**${t('card.wf.review_content', undefined, locale)}**\n${escapeMd(prompt)}`,
      },
    },
  ];

  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: resolutionBanner(resolution, locale) },
    });
  } else {
    elements.push({
      tag: 'form',
      name: WORKFLOW_APPROVAL_FORM,
      elements: [
        {
          tag: 'input',
          name: WORKFLOW_COMMENT_FIELD,
          placeholder: { tag: 'plain_text', content: t('card.wf.comment_placeholder', undefined, locale) },
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: 'default',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: t('card.wf.btn_approve', undefined, locale) },
                  type: 'primary',
                  name: 'workflow_approve',
                  action_type: 'form_submit',
                  value: actionValue(ctx, WORKFLOW_APPROVE_ACTION),
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'center',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: t('card.wf.btn_reject', undefined, locale) },
                  type: 'danger',
                  name: 'workflow_reject',
                  action_type: 'form_submit',
                  value: actionValue(ctx, WORKFLOW_REJECT_ACTION),
                },
              ],
            },
          ],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.wf.btn_cancel_run', undefined, locale) },
          type: 'default',
          name: 'workflow_cancel',
          action_type: 'form_submit',
          value: actionValue(ctx, WORKFLOW_CANCEL_ACTION),
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.wf.btn_web_detail', undefined, locale) },
        type: 'default',
        multi_url: {
          url: ctx.webDetailUrl,
          pc_url: ctx.webDetailUrl,
          android_url: ctx.webDetailUrl,
          ios_url: ctx.webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements,
  });
}

function resolutionTitlePrefix(kind: WorkflowApprovalResolutionKind, locale?: Locale): string {
  switch (kind) {
    case 'approved': return t('card.wf.resolved.approved', undefined, locale);
    case 'rejected': return t('card.wf.resolved.rejected', undefined, locale);
    case 'cancelled': return t('card.wf.resolved.cancelled', undefined, locale);
  }
}

function resolutionTemplate(kind: WorkflowApprovalResolutionKind): string {
  switch (kind) {
    case 'approved': return 'green';
    case 'rejected': return 'red';
    case 'cancelled': return 'grey';
  }
}

function resolutionBanner(r: WorkflowApprovalCardResolution, locale?: Locale): string {
  const label =
    r.kind === 'approved'
      ? t('card.wf.banner.approved', undefined, locale)
      : r.kind === 'rejected'
        ? t('card.wf.banner.rejected', undefined, locale)
        : t('card.wf.banner.cancelled', undefined, locale);
  // Open_id contains underscores that are markdown-significant; wrapping in
  // backticks would force the escape backslashes to render literally in
  // some Lark clients (codex review nit). Plain text with escapeMd keeps
  // it portable — Lark renders escaped `_` as `_` outside code spans.
  const lines = [`**${label}**`, t('common.operator', { by: escapeMd(short(r.by, 28)) }, locale)];
  if (r.comment) lines.push(t('card.wf.comment_label', { comment: escapeMd(r.comment) }, locale));
  return lines.join('\n');
}

function actionValue(ctx: WorkflowApprovalCardContext, action: string): Record<string, string> {
  return {
    action,
    run_id: ctx.runId,
    workflow_id: ctx.workflowId ?? '',
    revision_id: ctx.revisionId ?? '',
    node_id: ctx.nodeId,
    activity_id: ctx.activityId,
    attempt_id: ctx.attemptId,
    card_nonce: ctx.cardNonce,
  };
}

function truncatePrompt(s: string, maxChars: number, locale?: Locale): string {
  if (s.length <= maxChars) return s || t('card.wf.none', undefined, locale);
  return `${s.slice(0, maxChars)}\n\n${t('card.wf.truncated', undefined, locale)}`;
}

function escapeMd(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/_/g, '\\_').replace(/`/g, '\\`');
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function titleText(nodeId: string): string {
  return short(nodeId, 48);
}
