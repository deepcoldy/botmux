/**
 * v3 blocked-node 重试卡 —— blocked/failed 两档里 blocked（契约性失败，可恢复）
 * 的飞书入口。daemon 驱动的 run 走到 runBlocked 时发这张卡；点「重试」=
 * `requestV3Retry`（append nodeRetryRequested）+ 重驱动，幂等沿 humanGate wait
 * 那套思路（codex 拍的第一版边界：卡只带 runId/nodeId/attemptId/errorCode/
 * message + Retry，不塞 live 终端 / 复杂诊断）。
 *
 * 自带 action namespace（`v3_blocked_retry`），不与 gate 卡混用。纯函数，单测友好。
 */

import { config } from '../../config.js';

export const V3_BLOCKED_RETRY_ACTION = 'v3_blocked_retry';
/** 运行时 human-ask 选项按钮的 action（与「重试」同卡不同 namespace）。 */
export const V3_BLOCKED_ASK_ANSWER_ACTION = 'v3_blocked_ask_answer';
export const V3_BLOCKED_ASK_TEXT_FIELD = 'v3_blocked_ask_text';

/** card 按钮回传的 value 形态——v3-blocked-card-handler 据此解析。 */
export interface V3BlockedActionValue {
  action: typeof V3_BLOCKED_RETRY_ACTION;
  runId: string;
  nodeId: string;
  /** 受阻的 attemptId —— nonce 按它推导，旧 attempt 的 stale 卡天然失效。 */
  attemptId: string;
  nonce: string;
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
}

const DEFAULT_MESSAGE_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一节点同一 attempt 的卡 nonce 固定（重发卡一致）；
 *  attempt 入 nonce —— 重试后旧卡的 nonce 对不上新 attempt，不会误触。 */
export function v3BlockedCardNonce(runId: string, nodeId: string, attemptId: string): string {
  return `v3blocked:${runId}:${nodeId}:${attemptId}`;
}

function v3RunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

export function buildV3BlockedCard(input: V3BlockedCardInput): string {
  const nonce = input.nonce ?? v3BlockedCardNonce(input.runId, input.nodeId, input.attemptId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const msgMax = input.messageMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
  const { retried, ask, answered } = input;

  // 四态共用一张卡，header 决定语气：蓝=等人拍板 / 绿=已回答·已重试 / 橙=受阻待重试。
  let title: string;
  let template: string;
  if (answered) { title = `已回答：节点 ${input.nodeId}`; template = 'green'; }
  else if (ask) { title = `需要你拍板：节点 ${input.nodeId}`; template = 'blue'; }
  else if (retried) { title = `已重试：节点 ${input.nodeId}`; template = 'green'; }
  else { title = `节点受阻：${input.nodeId}`; template = 'orange'; }

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
    } else {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '处理掉阻塞原因（如完成鉴权）后点重试，会以新 attempt 重跑该节点。' },
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
    }
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Web 详情' },
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（截断，完整见 Web 详情）`;
}

function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义 lark_md 里会被解析的字符，防 message 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
