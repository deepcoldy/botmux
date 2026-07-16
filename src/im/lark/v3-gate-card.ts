/**
 * v3 humanGate 审批卡 — 复用 v0.2 审批卡的视觉（header 配色 / 字段 / freeze 态），
 * 但**自带 action namespace + value 形态**（codex review #4）：
 *   - action: `v3_gate_approve` / `v3_gate_reject`
 *   - value: `{ action, runId, waitId, nodeId, nonce, selected }`
 * 刻意不复用已下线的 v2 wait path —— v3 的 wait 权威是
 * `waits/<id>.json + journal.ndjson`，跟 v0.2 events schema 不同（见 humanGate
 * daemon-card 设计 §4.3）。本文件**纯函数**，不碰 daemon / IO，单测友好。
 */

import { config } from '../../config.js';
import { DEFAULT_HUMAN_GATE_OPTIONS } from '../../workflows/v3/dag.js';
import { splitV3HostGatePrompt } from '../../workflows/v3/host-bindings.js';

export const V3_GATE_APPROVE_ACTION = 'v3_gate_approve';
export const V3_GATE_REJECT_ACTION = 'v3_gate_reject';

export type V3GateResolutionKind = 'approved' | 'rejected';

/** card 按钮回传的 value 形态——v3-gate-card-handler 据此解析。 */
export interface V3GateActionValue {
  action: typeof V3_GATE_APPROVE_ACTION | typeof V3_GATE_REJECT_ACTION;
  runId: string;
  /** waitId = `${nodeId}-gate`；nodeId 单独带，免得 handler 去 strip 后缀（节点名可能含 -gate）。 */
  waitId: string;
  nodeId: string;
  nonce: string;
  selected?: string;
}

export interface V3GateCardInput {
  runId: string;
  waitId: string;
  nodeId: string;
  prompt: string;
  /** 卡 nonce（防 stale 卡重复触发）；省略则按 runId/waitId 推导。 */
  nonce?: string;
  webDetailUrl?: string;
  promptMaxChars?: number;
  options?: string[];
  approveOptions?: string[];
  approvers?: string[];
  /** Host-only trusted identity. The hash is rendered independently from the
   * authored prompt so a long prompt can never truncate away what is approved. */
  hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
  /** 有值 → 渲染冻结的「已通过 / 已拒绝」卡（无按钮，防 stale UI 重复提交）。 */
  resolution?: { kind: V3GateResolutionKind; by?: string; selected?: string };
}

const DEFAULT_PROMPT_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一 wait 的卡 nonce 固定，重发卡也一致（幂等校验用）。 */
export function v3GateCardNonce(runId: string, waitId: string): string {
  return `v3gate:${runId}:${waitId}`;
}

/** v3 run 在 dashboard 的详情页 URL（跟 v0.2 的 #/workflows 对称，走 #/v3）。 */
export function v3RunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

export function buildV3GateCard(input: V3GateCardInput): string {
  const nonce = input.nonce ?? v3GateCardNonce(input.runId, input.waitId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const promptMax = input.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
  const hostPrompt = input.hostApproval ? splitV3HostGatePrompt(input.prompt) : undefined;
  const prompt = truncate(hostPrompt?.authoredPrompt ?? input.prompt, promptMax);
  const resolution = input.resolution;
  const options = input.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  const approveOptions = input.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]);

  const title = resolution
    ? `${resolutionPrefix(resolution.kind)}：${titleText(input.nodeId)}`
    : `需要审批：${titleText(input.nodeId)}`;
  const template = resolution ? (resolution.kind === 'approved' ? 'green' : 'red') : 'blue';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**节点**\n${escapeMd(input.nodeId)}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: '**审批内容**' },
    },
    {
      tag: 'div',
      // Gate prompts can contain user/agent-authored data. Keep them out of
      // lark_md so Lark tags such as <at id=all></at> cannot turn displaying
      // an approval card into a pre-approval notification side effect.
      text: { tag: 'plain_text', content: prompt },
    },
  ];

  if (input.hostApproval) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `冻结输入 Hash（本次批准对象）\n${input.hostApproval.inputHash}`,
      },
    });
    if (hostPrompt?.preview) {
      elements.push({
        tag: 'div',
        // The preview is derived from upstream result data. Rendering it as
        // plain text is a security boundary: markdown escaping alone does not
        // neutralize Lark-native tags (<at>, links, etc.).
        text: {
          tag: 'plain_text',
          content: `冻结输入预览（完整；敏感字段按键名脱敏）\n${hostPrompt.preview}`,
        },
      });
    }
  }

  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content:
          (resolution.kind === 'approved' ? '✅ 已通过' : '❌ 已拒绝') +
          (resolution.selected ? ` · ${short(resolution.selected, 20)}` : '') +
          (resolution.by ? ` · by ${short(resolution.by, 20)}` : ''),
      },
    });
  } else {
    elements.push({
      tag: 'action',
      actions: options.map((opt) => optionButton(opt, approveOptions, input, nonce)),
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Web 详情（需登录）' },
        type: 'default',
        multi_url: {
          url: webDetailUrl, pc_url: webDetailUrl, android_url: webDetailUrl, ios_url: webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

function actionValue(
  action: V3GateActionValue['action'],
  runId: string,
  waitId: string,
  nodeId: string,
  nonce: string,
  selected?: string,
): V3GateActionValue {
  return { action, runId, waitId, nodeId, nonce, selected };
}

function optionButton(
  selected: string,
  approveOptions: string[],
  input: V3GateCardInput,
  nonce: string,
): Record<string, unknown> {
  const approved = approveOptions.includes(selected);
  const label =
    selected === 'approve' ? '✅ 通过'
    : selected === 'reject' ? '❌ 拒绝'
    : selected;
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: approved ? 'primary' : 'danger',
    value: actionValue(
      approved ? V3_GATE_APPROVE_ACTION : V3_GATE_REJECT_ACTION,
      input.runId,
      input.waitId,
      input.nodeId,
      nonce,
      selected,
    ),
  };
}

function resolutionPrefix(kind: V3GateResolutionKind): string {
  return kind === 'approved' ? '已通过' : '已拒绝';
}

function titleText(nodeId: string): string {
  return `humanGate · ${nodeId}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（截断，完整见 Web 详情）`;
}

function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义 lark_md 里会被解析的字符，防 prompt 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
