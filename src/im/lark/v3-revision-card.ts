/**
 * 「流程修改确认」卡（design §13.5 / M2）。运行中的流程修改命中确认清单，或由
 * 发起人以外的人触发时，主话题里发这张卡；只有发起人能点「同意」/「拒绝」。
 *
 * 纯函数：不碰 daemon / IO。节点 id 是 DAG 校验过的路径安全段；修改说明是自由
 * 文本，一律放 plain_text，避免 lark_md 解析出 @ 等副作用。
 */

import type { V3RevisionConfirmReason } from '../../workflows/v3/event-contract.js';
import type { V3RevisionCardView } from '../../workflows/v3/run-edit.js';
import { short, v3RunDetailUrl } from './v3-card-common.js';
import { buildWorkflowSidebarEntryV1Button, type WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

export const V3_REVISION_APPROVE_ACTION = 'v3_revision_approve';
export const V3_REVISION_REJECT_ACTION = 'v3_revision_reject';

export interface V3RevisionActionValue {
  action: typeof V3_REVISION_APPROVE_ACTION | typeof V3_REVISION_REJECT_ACTION;
  runId: string;
  revision: number;
  nonce: string;
}

export type V3RevisionCardResolution =
  | { kind: 'approved'; by?: string }
  | { kind: 'rejected'; by?: string }
  /** The flow moved on (another revision, the proposal no longer applies,
   *  a newer proposal, or the run ended) before anyone decided. */
  | { kind: 'void'; detail?: string };

export interface V3RevisionCardInput {
  runId: string;
  view: V3RevisionCardView;
  webDetailUrl?: string;
  resolution?: V3RevisionCardResolution;
  /** §11.1: a run whose nodes are handed to bots in the chat gets the「工作流 ›」
   *  sidebar entry in place of「Web 详情（需登录）」. Absent = the card is exactly
   *  what it always was. */
  workflowEntry?: WorkflowSidebarEntryLink;
}

/** The card's bottom link row: the run's sidebar entry when it has one,
 *  otherwise the Dashboard run page as before. */
function detailRow(webDetailUrl: string, entry: WorkflowSidebarEntryLink | undefined): Record<string, unknown> {
  return {
    tag: 'action',
    actions: [entry ? buildWorkflowSidebarEntryV1Button(entry) : {
      tag: 'button',
      text: { tag: 'plain_text', content: 'Web 详情（需登录）' },
      type: 'default',
      multi_url: { url: webDetailUrl, pc_url: webDetailUrl, android_url: webDetailUrl, ios_url: webDetailUrl },
    }],
  };
}

/** 稳定 nonce：同一 run 同一提案的卡重发时一致。 */
export function v3RevisionCardNonce(runId: string, revision: number): string {
  return `v3rev:${runId}:${revision}`;
}

export const V3_REVISION_REASON_LABELS: Record<V3RevisionConfirmReason, string> = {
  callerNotInitiator: '由发起人以外的人提出',
  newBot: '用到了未批准的 Bot',
  hostNode: '新增或修改了对外动作（宿主节点）',
  gateRelaxed: '去掉或放宽了人工确认',
  budgetExpanded: '扩大了额度（超时 / 轮数 / 节点总数）',
};

function list(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join('、') : '';
}

/** Who proposed a revision, as a role. The stored value is the proposer's
 *  open_id (or `main_bot`); a raw open_id means nothing to people in the
 *  chat, so the card shows the role instead and never prints the id. */
export function v3RevisionProposerLabel(view: Pick<V3RevisionCardView, 'proposedBy' | 'reasons'>): string {
  if (view.proposedBy === 'main_bot') return '主 Bot（自行调整）';
  return view.reasons.includes('callerNotInitiator') ? '群成员（非发起人）' : '发起人';
}

export function buildV3RevisionCard(input: V3RevisionCardInput): string {
  const { view, resolution } = input;
  const nonce = v3RevisionCardNonce(input.runId, view.revision);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const title = resolution
    ? resolution.kind === 'approved' ? `流程修改已生效：第 ${view.revision} 版`
      : resolution.kind === 'rejected' ? `流程修改已拒绝：第 ${view.revision} 版`
      : `流程修改已作废：第 ${view.revision} 版`
    : `流程修改确认：第 ${view.revision} 版`;
  const template = resolution
    ? resolution.kind === 'approved' ? 'green' : resolution.kind === 'rejected' ? 'red' : 'grey'
    : 'orange';

  const changes = view.changes;
  const lines: string[] = [];
  lines.push(`基于第 ${view.baseRevision} 版：${view.summary}`);
  if (view.note) lines.push(`说明：${short(view.note, 200)}`);
  if (changes.added.length) lines.push(`新增节点：${list(changes.added)}`);
  if (changes.removed.length) lines.push(`删除节点：${list(changes.removed)}`);
  if (changes.changed.length) lines.push(`修改节点：${list(changes.changed)}`);
  if (changes.dependsChanged.length) lines.push(`改依赖：${list(changes.dependsChanged)}`);
  if (changes.reassigned.length) {
    // `from` is who executes the node now (a blocked-card 改派 included).
    lines.push(`改派：${changes.reassigned.map((item) =>
      `${item.nodeId}（${item.from ? `${item.from} → ` : ''}${item.to}）`).join('、')}`);
  }
  if (changes.rerun.length) lines.push(`重做：${list(changes.rerun)}`);
  if (changes.newBots.length) lines.push(`新 Bot：${list(changes.newBots)}`);
  if (changes.hostNodes.length) lines.push(`新的对外动作：${list(changes.hostNodes)}`);
  if (changes.gateChanges.length) {
    const label = { added: '新增', removed: '去掉', changed: '修改' } as const;
    lines.push(`人工确认变化：${changes.gateChanges.map((item) => `${item.nodeId}（${label[item.change]}）`).join('、')}`);
  }

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'plain_text', content: `Run\n${short(input.runId, 24)}` } },
        { is_short: true, text: { tag: 'plain_text', content: `提出者\n${v3RevisionProposerLabel(view)}` } },
      ],
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } },
  ];
  if (view.reasons.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `需要确认的原因：\n${view.reasons.map((reason) => `· ${V3_REVISION_REASON_LABELS[reason]}`).join('\n')}`,
      },
    });
  }
  elements.push({ tag: 'hr' });
  if (resolution) {
    const text = resolution.kind === 'approved'
      ? `✅ 已同意，第 ${view.revision} 版已生效${resolution.by ? ` · by ${short(resolution.by, 20)}` : ''}`
      : resolution.kind === 'rejected'
        ? `❌ 已拒绝，流程保持第 ${view.baseRevision} 版${resolution.by ? ` · by ${short(resolution.by, 20)}` : ''}`
        : `⏹️ 流程已变化，本次确认作废${resolution.detail ? `（${short(resolution.detail, 120)}）` : ''}`;
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: text } });
  } else {
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: '只有发起人能确认。待确认期间，涉及的节点暂停派发，其余节点照常运行。' },
    });
    elements.push({
      tag: 'action',
      actions: [
        button('✅ 同意', 'primary', { action: V3_REVISION_APPROVE_ACTION, runId: input.runId, revision: view.revision, nonce }),
        button('❌ 拒绝', 'danger', { action: V3_REVISION_REJECT_ACTION, runId: input.runId, revision: view.revision, nonce }),
      ],
    });
  }
  elements.push(detailRow(webDetailUrl, input.workflowEntry));

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

function button(label: string, type: 'primary' | 'danger', value: V3RevisionActionValue | V3RerunGrantActionValue): Record<string, unknown> {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value };
}

// ─── 「追加重做额度」card (rerunNode refused for revisit budget) ─────────────

export const V3_REVISION_RERUN_GRANT_ACTION = 'v3_revision_rerun_grant';

export interface V3RerunGrantActionValue {
  action: typeof V3_REVISION_RERUN_GRANT_ACTION;
  runId: string;
  nodeId: string;
  /** The exhaustion this card was posted for: budget tier + epoch. */
  tier: 'pair' | 'run';
  epoch: number;
  nonce: string;
}

export function v3RerunGrantCardNonce(runId: string, nodeId: string, tier: 'pair' | 'run', epoch: number): string {
  return `v3revrerun:${runId}:${nodeId}:${tier}:${epoch}`;
}

export function buildV3RerunGrantCard(input: {
  runId: string;
  nodeId: string;
  tier: 'pair' | 'run';
  epoch: number;
  webDetailUrl?: string;
  resolution?: { kind: 'granted' | 'void'; by?: string; detail?: string };
  /** §11.1: see {@link V3RevisionCardInput.workflowEntry}. */
  workflowEntry?: WorkflowSidebarEntryLink;
}): string {
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const resolution = input.resolution;
  const scope = input.tier === 'pair' ? `节点 ${input.nodeId} 的` : '整个 run 的';
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `Run ${short(input.runId, 24)} 想重做节点 ${input.nodeId}，但${scope} Revisit 额度已用完。` +
          '追加 1 次后，主 Bot 可以重新提交这次修改。只有发起人能追加。',
      },
    },
    { tag: 'hr' },
  ];
  if (resolution) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: resolution.kind === 'granted'
          ? `✅ 已追加 1 次重做额度${resolution.by ? ` · by ${short(resolution.by, 20)}` : ''}`
          : `⏹️ 本卡已失效${resolution.detail ? `（${short(resolution.detail, 120)}）` : ''}`,
      },
    });
  } else {
    const value: V3RerunGrantActionValue = {
      action: V3_REVISION_RERUN_GRANT_ACTION,
      runId: input.runId,
      nodeId: input.nodeId,
      tier: input.tier,
      epoch: input.epoch,
      nonce: v3RerunGrantCardNonce(input.runId, input.nodeId, input.tier, input.epoch),
    };
    elements.push({ tag: 'action', actions: [button('➕ 追加 1 次', 'primary', value)] });
  }
  elements.push(detailRow(webDetailUrl, input.workflowEntry));
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: resolution ? (resolution.kind === 'granted' ? 'green' : 'grey') : 'orange',
      title: { tag: 'plain_text', content: resolution?.kind === 'granted' ? '已追加重做额度' : '重做额度已用完' },
    },
    elements,
  });
}
