/**
 * v3 blocked-node 重试卡 —— blocked/failed 两档里 blocked（契约性失败，可恢复）
 * 的飞书入口。daemon 驱动的 run 走到 runBlocked 时发这张卡；点「重试」=
 * `requestV3Retry`（append nodeRetryRequested）+ 重驱动，幂等沿 humanGate wait
 * 那套思路（codex 拍的第一版边界：卡只带 runId/nodeId/attemptId/errorCode/
 * message + Retry，不塞 live 终端 / 复杂诊断）。
 *
 * 自带 action namespace（`v3_blocked_retry`），不与 gate 卡混用。纯函数，单测友好。
 */

import { short, truncate, escapeMd, v3RunDetailUrl } from './v3-card-common.js';

export const V3_BLOCKED_RETRY_ACTION = 'v3_blocked_retry';
/** 运行时 human-ask 选项按钮的 action（与「重试」同卡不同 namespace）。 */
export const V3_BLOCKED_ASK_ANSWER_ACTION = 'v3_blocked_ask_answer';
export const V3_BLOCKED_ASK_TEXT_FIELD = 'v3_blocked_ask_text';
/** 「改派」确认按钮的 action（只在节点交给群里 Bot 执行的 run 上出现）。 */
export const V3_BLOCKED_REASSIGN_ACTION = 'v3_blocked_reassign';
/** 改派下拉框的 form 字段名：选中的是目标 Bot 的 larkAppId。 */
export const V3_BLOCKED_REASSIGN_FIELD = 'v3_blocked_reassign_bot';

/** card 按钮回传的 value 形态——v3-blocked-card-handler 据此解析。 */
export interface V3BlockedActionValue {
  action: typeof V3_BLOCKED_RETRY_ACTION;
  runId: string;
  nodeId: string;
  /** 受阻的 attemptId —— nonce 按它推导，旧 attempt 的 stale 卡天然失效。 */
  attemptId: string;
  nonce: string;
}

/** 改派回传的 value —— 目标 Bot 走 form_value[V3_BLOCKED_REASSIGN_FIELD]，
 *  不塞进 button value；nonce 与重试按钮同一个（按受阻 attempt 推导）。 */
export interface V3ReassignActionValue {
  action: typeof V3_BLOCKED_REASSIGN_ACTION;
  runId: string;
  nodeId: string;
  attemptId: string;
  nonce: string;
}

/** 节点交给群里 Bot 执行的 run 上，受阻卡附带的改派选项（渲染时现查）。 */
export interface V3BlockedReassignOffer {
  /** 当前执行这个节点的 Bot 名。 */
  currentName: string;
  /** 现在能改派过去的 Bot（本 run 批准时选定的 Bot 里、当前合格的）。 */
  candidates: Array<{ larkAppId: string; label: string }>;
  /** 批准时选定、但现在不能用的 Bot 及原因。 */
  unavailable: Array<{ label: string; why: string }>;
}

/** ask 回传的 value —— 人的答案 + 受阻 attempt（freshness）。 */
export type V3AskAnswerActionValue =
  | {
      action: typeof V3_BLOCKED_ASK_ANSWER_ACTION;
      runId: string;
      nodeId: string;
      attemptId: string;
      /** 选中的选项文本（= GoalAsk.options 之一），落库为 answer.selected。 */
      selected: string;
      nonce: string;
    }
  | {
      action: typeof V3_BLOCKED_ASK_ANSWER_ACTION;
      runId: string;
      nodeId: string;
      attemptId: string;
      /** 自由文本答案走 form_value[V3_BLOCKED_ASK_TEXT_FIELD]，不塞进 button value。 */
      answerKind: 'text';
      nonce: string;
    };

export interface V3BlockedCardInput {
  runId: string;
  nodeId: string;
  attemptId: string;
  errorClass?: string;
  errorCode?: string;
  message?: string;
  retryForbidden?: 'host-effect-uncertain' | 'revise-workflow-required';
  /** 省略则按 runId/nodeId/attemptId 推导（幂等校验用）。 */
  nonce?: string;
  webDetailUrl?: string;
  messageMaxChars?: number;
  /** 有值 → 渲染冻结的「已重试」卡（无按钮，防 stale UI 重复提交）。 */
  retried?: { nextAttemptId: string; by?: string };
  /** 运行时 human-ask：agent 的问题 → 渲染选项按钮或自由文本输入卡。 */
  ask?: { question: string; options?: string[]; freeText?: boolean };
  /** 有值 → 渲染冻结的「已回答」卡（ask 专用，无按钮）。 */
  answered?: { selected?: string; text?: string; nextAttemptId: string; by?: string };
  /** 节点交给群里 Bot 执行的 run 才有：在重试下方加「改派」区。 */
  reassign?: V3BlockedReassignOffer;
  /** 有值 → 渲染冻结的「已改派」卡（无按钮）。 */
  reassigned?: { toName: string; nextAttemptId?: string; by?: string };
}

const DEFAULT_MESSAGE_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一节点同一 attempt 的卡 nonce 固定（重发卡一致）；
 *  attempt 入 nonce —— 重试后旧卡的 nonce 对不上新 attempt，不会误触。 */
export function v3BlockedCardNonce(runId: string, nodeId: string, attemptId: string): string {
  return `v3blocked:${runId}:${nodeId}:${attemptId}`;
}

/** 「改派」区：说明 + 下拉框 + 确认按钮（form 提交，选中项走 form_value）。 */
function reassignElements(input: V3BlockedCardInput, nonce: string): Array<Record<string, unknown>> {
  const offer = input.reassign!;
  const unavailable = offer.unavailable.map((entry) =>
    `\n· ${escapeMd(short(entry.label, 40))}：${escapeMd(short(entry.why, 80))}`).join('');
  const out: Array<Record<string, unknown>> = [
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**改派**（只有发起人能操作）\n当前执行：${escapeMd(short(offer.currentName, 40))}。` +
          '只能改派给本 run 批准时选定的 Bot，暂不支持改派给其他 Bot。' +
          (unavailable ? `\n以下 Bot 现在不能接手：${unavailable}` : ''),
      },
    },
  ];
  if (offer.candidates.length === 0) {
    out.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '没有可以改派的 Bot。' },
    });
    return out;
  }
  out.push({
    tag: 'form',
    name: 'v3_blocked_reassign_form',
    elements: [
      {
        tag: 'select_static',
        name: V3_BLOCKED_REASSIGN_FIELD,
        placeholder: { tag: 'plain_text', content: '选择接手的 Bot' },
        options: offer.candidates.map((candidate) => ({
          text: { tag: 'plain_text', content: short(candidate.label, 60) },
          value: candidate.larkAppId,
        })),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔀 确认改派' },
        type: 'default',
        name: 'v3_blocked_reassign_submit',
        action_type: 'form_submit',
        value: {
          action: V3_BLOCKED_REASSIGN_ACTION,
          runId: input.runId,
          nodeId: input.nodeId,
          attemptId: input.attemptId,
          nonce,
        } satisfies V3ReassignActionValue,
      },
    ],
  });
  return out;
}

export function buildV3BlockedCard(input: V3BlockedCardInput): string {
  const nonce = input.nonce ?? v3BlockedCardNonce(input.runId, input.nodeId, input.attemptId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const msgMax = input.messageMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
  const { retried, ask, answered, reassigned } = input;

  // 四态共用一张卡，header 决定语气：蓝=等人拍板 / 绿=已回答·已重试 / 橙=受阻待重试。
  let title: string;
  let template: string;
  if (answered) { title = `已回答：节点 ${input.nodeId}`; template = 'green'; }
  else if (ask) { title = `需要你拍板：节点 ${input.nodeId}`; template = 'blue'; }
  else if (retried) { title = `已重试：节点 ${input.nodeId}`; template = 'green'; }
  else if (reassigned) { title = `已改派：节点 ${input.nodeId}`; template = 'green'; }
  else if (input.retryForbidden === 'host-effect-uncertain') {
    title = `外部效果待核实：${input.nodeId}`;
    template = 'red';
  } else if (input.retryForbidden === 'revise-workflow-required') {
    title = `需要修订 Workflow：${input.nodeId}`;
    template = 'red';
  } else { title = `节点受阻：${input.nodeId}`; template = 'orange'; }

  const attemptNNN = input.attemptId.slice(input.attemptId.lastIndexOf('/') + 1);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**节点 / attempt**\n${escapeMd(input.nodeId)} · ${escapeMd(attemptNNN)}` } },
      ],
    },
    { tag: 'hr' },
  ];

  if (ask || answered) {
    // ── 运行时 human-ask：渲染问题 + 选项按钮（或冻结的「已回答」）──
    const question = ask?.question;
    if (question) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**${escapeMd(truncate(question, msgMax))}**` },
      });
    }
    if (answered) {
      const answerPreview = answered.text ?? answered.selected ?? '';
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `✅ 已回答 → **${escapeMd(truncate(answerPreview, msgMax))}**` +
            (answered.by ? ` · by ${escapeMd(short(answered.by, 20))}` : '') +
            ` · 重跑 ${escapeMd(answered.nextAttemptId.slice(answered.nextAttemptId.lastIndexOf('/') + 1))}`,
        },
      });
    } else if (ask?.freeText) {
      elements.push({
        tag: 'form',
        name: 'v3_blocked_ask_text_form',
        elements: [
          {
            tag: 'input',
            name: V3_BLOCKED_ASK_TEXT_FIELD,
            placeholder: { tag: 'plain_text', content: '填写答案' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '提交并重跑' },
            type: 'primary',
            name: 'v3_blocked_ask_text_submit',
            action_type: 'form_submit',
            value: {
              action: V3_BLOCKED_ASK_ANSWER_ACTION,
              runId: input.runId,
              nodeId: input.nodeId,
              attemptId: input.attemptId,
              answerKind: 'text',
              nonce,
            } satisfies V3AskAnswerActionValue,
          },
        ],
      });
    } else if (ask) {
      // 一个选项一个按钮，选中文本回传为 answer.selected（按 attempt 入 nonce 防 stale）。
      elements.push({
        tag: 'action',
        actions: (ask.options ?? []).map((opt) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: short(opt, 80) },
          type: 'primary',
          value: {
            action: V3_BLOCKED_ASK_ANSWER_ACTION,
            runId: input.runId,
            nodeId: input.nodeId,
            attemptId: input.attemptId,
            selected: opt,
            nonce,
          } satisfies V3AskAnswerActionValue,
        })),
      });
    }
  } else {
    // ── 普通受阻 / 已重试 ──
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**原因**\n${escapeMd(input.errorClass ?? 'blocked')}` +
          (input.errorCode ? ` · \`${escapeMd(input.errorCode)}\`` : '') +
          (input.message ? `\n${escapeMd(truncate(input.message, msgMax))}` : ''),
      },
    });
    if (retried) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `🔄 已重试 → ${escapeMd(retried.nextAttemptId.slice(retried.nextAttemptId.lastIndexOf('/') + 1))}` +
            (retried.by ? ` · by ${escapeMd(short(retried.by, 20))}` : ''),
        },
      });
    } else if (reassigned) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `🔀 已改派给 ${escapeMd(short(reassigned.toName, 40))}` +
            (reassigned.nextAttemptId
              ? ` → ${escapeMd(reassigned.nextAttemptId.slice(reassigned.nextAttemptId.lastIndexOf('/') + 1))}`
              : '') +
            (reassigned.by ? ` · by ${escapeMd(short(reassigned.by, 20))}` : ''),
        },
      });
    } else if (input.retryForbidden === 'host-effect-uncertain') {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            '⚠️ 该 attempt 可能已产生外部副作用。请先在目标系统对账；为避免重复发送/创建，不提供普通重试。' +
            ` P0 暂不支持手工补写 provider 回执，对账后请用 \`/workflow cancel ${escapeMd(input.runId)}\` 收口并保留审计记录。`,
        },
      });
    } else if (input.retryForbidden === 'revise-workflow-required') {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            '⛔ 公开产物契约与实际 Manifest 不一致，普通重试不会改变定义。' +
            '请修订 Workflow 的 outputs / output key 后创建或发布新版本；当前 run 保留用于审计。',
        },
      });
    } else {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '处理掉阻塞原因（如完成鉴权）后点重试，会以新 attempt 重跑该节点；为避免旧 worker 与重试重叠，进入受阻状态时被中止的并行节点也会重新执行。',
        },
      });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重试' },
            type: 'primary',
            value: {
              action: V3_BLOCKED_RETRY_ACTION,
              runId: input.runId,
              nodeId: input.nodeId,
              attemptId: input.attemptId,
              nonce,
            } satisfies V3BlockedActionValue,
          },
        ],
      });
      if (input.reassign) elements.push(...reassignElements(input, nonce));
    }
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

