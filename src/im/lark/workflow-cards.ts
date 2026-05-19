import { config } from '../../config.js';
import type { WaitCreatedEvent } from '../../workflows/events/types.js';
import type { Snapshot } from '../../workflows/events/replay.js';
import { isPayloadRef } from '../../workflows/events/schema.js';

export const WORKFLOW_APPROVE_ACTION = 'wf_approve';
export const WORKFLOW_REJECT_ACTION = 'wf_reject';
export const WORKFLOW_COMMENT_FIELD = 'wf_comment';
export const WORKFLOW_APPROVAL_FORM = 'wf_approval_form';

const DEFAULT_PROMPT_MAX_CHARS = 500;

export type WorkflowApprovalCardOptions = {
  webDetailUrl?: string;
  cardNonce?: string;
  promptMaxChars?: number;
};

export type WorkflowApprovalCardContext = {
  runId: string;
  workflowId?: string;
  revisionId?: string;
  nodeId: string;
  activityId: string;
  attemptId: string;
  deadlineAt?: number;
  prompt: string;
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
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#workflow/${encodeURIComponent(runId)}`;
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

  return {
    runId: event.runId,
    workflowId: snapshot.run.workflowId,
    revisionId: snapshot.run.revisionId,
    nodeId: event.payload.nodeId,
    activityId: event.payload.activityId,
    attemptId,
    deadlineAt: event.payload.deadlineAt,
    prompt: event.payload.prompt ?? '',
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
  const title = `需要审批：${titleText(ctx.nodeId)}`;
  const revision = ctx.revisionId ? short(ctx.revisionId, 12) : 'unknown';
  const workflow = ctx.workflowId ? `${ctx.workflowId} @ ${revision}` : `unknown @ ${revision}`;
  const deadline = ctx.deadlineAt ? new Date(ctx.deadlineAt).toLocaleString('zh-CN') : '无';

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
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
          content: `**审批内容**\n${escapeMd(prompt)}`,
        },
      },
      {
        tag: 'form',
        name: WORKFLOW_APPROVAL_FORM,
        elements: [
          {
            tag: 'input',
            name: WORKFLOW_COMMENT_FIELD,
            placeholder: { tag: 'plain_text', content: '可选：填写审批意见' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 通过' },
            type: 'primary',
            name: 'workflow_approve',
            action_type: 'form_submit',
            value: actionValue(ctx, WORKFLOW_APPROVE_ACTION),
          },
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
      {
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
      },
    ],
  });
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
