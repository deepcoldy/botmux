/**
 * v3 耗尽 loop 追加一轮卡 —— loop 跑满 maxIterations 仍没达成 exit 条件时
 * （decision=exhausted → loop blocked）的飞书入口。和 blocked 重试卡是两张卡、
 * 两个 action：这里没有任何东西"失败"，只是不收敛——按钮语义是「追加 1 轮」
 * （append loopIterationGranted）而不是「重跑某 attempt」。
 *
 * stale 防护与 blocked 卡同构（expectedAttemptId 的同款教训）：nonce 以
 * `iteration` 为 freshness key —— 一旦 grant 被消费 / 新一轮再次耗尽，旧卡的
 * iteration 对不上 core 的 expectedIteration 比对，天然失效。
 */

import { config } from '../../config.js';

export const V3_LOOP_GRANT_ACTION = 'v3_loop_grant';

/** card 按钮回传的 value 形态——v3-loop-grant-card-handler 据此解析。 */
export interface V3LoopGrantActionValue {
  action: typeof V3_LOOP_GRANT_ACTION;
  runId: string;
  loopId: string;
  /** 耗尽时的 iteration —— nonce + core expectedIteration 的 freshness key。 */
  iteration: number;
  nonce: string;
}

export interface V3LoopGrantCardInput {
  runId: string;
  loopId: string;
  /** 耗尽时的 iteration。 */
  iteration: number;
  /** 编排时的轮数上限（展示用，可缺）。 */
  maxIterations?: number;
  /** 已追加过的轮数。 */
  granted?: number;
  /** 最后一轮 decision detail（如 `result.passed=false (iteration 3/3)`）。 */
  detail?: string;
  /** 省略则按 runId/loopId/iteration 推导。 */
  nonce?: string;
  webDetailUrl?: string;
  detailMaxChars?: number;
  /** 有值 → 渲染冻结的「已追加」卡（无按钮，防 stale UI 重复提交）。 */
  grantedNow?: { nextIteration: number; by?: string };
}

const DEFAULT_DETAIL_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一 loop 同一耗尽轮的卡 nonce 固定（重发卡一致）；
 *  iteration 入 nonce —— 追加被消费后旧卡对不上新耗尽轮，不会误触。 */
export function v3LoopGrantCardNonce(runId: string, loopId: string, iteration: number): string {
  return `v3loopgrant:${runId}:${loopId}:${iteration}`;
}

function v3RunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

export function buildV3LoopGrantCard(input: V3LoopGrantCardInput): string {
  const nonce = input.nonce ?? v3LoopGrantCardNonce(input.runId, input.loopId, input.iteration);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const detailMax = input.detailMaxChars ?? DEFAULT_DETAIL_MAX_CHARS;
  const granted = input.grantedNow;

  const title = granted ? `已追加一轮：loop ${input.loopId}` : `loop 轮数耗尽：${input.loopId}`;
  // 与 blocked 重试卡同款语义色：耗尽=橙（可恢复），追加后转绿。
  const template = granted ? 'green' : 'orange';

  const budget =
    input.maxIterations !== undefined
      ? `${input.iteration}/${input.maxIterations + (input.granted ?? 0)}`
      : `${input.iteration}`;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Loop / 轮数**\n${escapeMd(input.loopId)} · ${escapeMd(budget)}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**最后一轮结果**\n未达成 exit 条件` +
          (input.detail ? `\n${escapeMd(truncate(input.detail, detailMax))}` : ''),
      },
    },
  ];

  if (granted) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `➕ 已追加 → 第 ${granted.nextIteration} 轮` +
          (granted.by ? ` · by ${escapeMd(short(granted.by, 20))}` : ''),
      },
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '点「追加 1 轮」会带着上一轮反馈再跑一轮；若结果已无修复价值，留着不点即可（run 保持受阻）。',
      },
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '➕ 追加 1 轮' },
          type: 'primary',
          value: {
            action: V3_LOOP_GRANT_ACTION,
            runId: input.runId,
            loopId: input.loopId,
            iteration: input.iteration,
            nonce,
          } satisfies V3LoopGrantActionValue,
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

/** 转义 lark_md 里会被解析的字符，防 detail 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
