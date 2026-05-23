import { config } from '../../config.js';
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
): string {
  const ctx = getWorkflowApprovalCardContext(event, snapshot, opts);
  const promptMaxChars = opts.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
  const prompt = truncatePrompt(ctx.prompt, promptMaxChars);
  const revision = ctx.revisionId ? short(ctx.revisionId, 12) : 'unknown';
  const workflow = ctx.workflowId ? `${ctx.workflowId} @ ${revision}` : `unknown @ ${revision}`;
  const deadline = ctx.deadlineAt ? new Date(ctx.deadlineAt).toLocaleString('zh-CN') : '无';

  const resolution = opts.resolution;
  const title = resolution
    ? `${resolutionTitlePrefix(resolution.kind)}：${titleText(ctx.nodeId)}`
    : `需要审批：${titleText(ctx.nodeId)}`;
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
          ? `**审批内容**（预览，完整内容见下方 Web 详情）\n${escapeMd(prompt)}`
          : `**审批内容**\n${escapeMd(prompt)}`,
      },
    },
  ];

  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: resolutionBanner(resolution) },
    });
  } else {
    elements.push({
      tag: 'form',
      name: WORKFLOW_APPROVAL_FORM,
      elements: [
        {
          tag: 'input',
          name: WORKFLOW_COMMENT_FIELD,
          placeholder: { tag: 'plain_text', content: '可选：填写审批意见' },
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
                  text: { tag: 'plain_text', content: '✅ 通过' },
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
                  text: { tag: 'plain_text', content: '❌ 拒绝' },
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
          text: { tag: 'plain_text', content: '取消 Run' },
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
        text: { tag: 'plain_text', content: 'Web 详情' },
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

function resolutionTitlePrefix(kind: WorkflowApprovalResolutionKind): string {
  switch (kind) {
    case 'approved': return '已通过';
    case 'rejected': return '已拒绝';
    case 'cancelled': return '已取消';
  }
}

function resolutionTemplate(kind: WorkflowApprovalResolutionKind): string {
  switch (kind) {
    case 'approved': return 'green';
    case 'rejected': return 'red';
    case 'cancelled': return 'grey';
  }
}

function resolutionBanner(r: WorkflowApprovalCardResolution): string {
  const label =
    r.kind === 'approved'
      ? '✅ 已通过'
      : r.kind === 'rejected'
        ? '❌ 已拒绝'
        : '🛑 已取消';
  // Open_id contains underscores that are markdown-significant; wrapping in
  // backticks would force the escape backslashes to render literally in
  // some Lark clients (codex review nit). Plain text with escapeMd keeps
  // it portable — Lark renders escaped `_` as `_` outside code spans.
  const lines = [`**${label}**`, `操作人：${escapeMd(short(r.by, 28))}`];
  if (r.comment) lines.push(`备注：${escapeMd(r.comment)}`);
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

function truncatePrompt(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s || '无';
  return `${s.slice(0, maxChars)}\n\n…（已截断，完整内容请在 Web 查看）`;
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
