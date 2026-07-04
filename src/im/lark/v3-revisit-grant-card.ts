/**
 * v3 回溯预算耗尽卡 —— 一个节点想回溯某祖先,但 per-pair / per-run 预算用尽
 * (nodeBlocked errorCode=REVISIT_BUDGET_EXHAUSTED → run blocked)时的飞书入口。
 * 和 blocked 重试卡是两张卡:这里没有"失败",只是回溯次数到顶——按钮语义是
 * 「准许再回溯 1 次」(append revisitBudgetGranted + 原子 retry blocked 节点),
 * 不是「重跑某 attempt」。
 *
 * stale 防护与 loop grant 卡同构:nonce 以 blocked `attemptId` 为 freshness key
 * —— grant+retry 后 blocked 节点进入新 attempt,旧卡 attemptId 对不上 core 的
 * expectedAttemptId 比对,天然失效。
 *
 * scope 正确性(菲菲 review):卡片明确标出耗尽的是 pair 还是 run-wide,并据此
 * 让按钮带对应 scope —— pair grant 带 source/target,run grant 都不带。给错
 * scope 会出现"grant 了但 retry 后又因另一层预算继续 blocked"。
 */

import { config } from '../../config.js';

export const V3_REVISIT_GRANT_ACTION = 'v3_revisit_grant';

/** card 按钮回传的 value 形态——v3-revisit-grant-card-handler 据此解析。 */
export interface V3RevisitGrantActionValue {
  action: typeof V3_REVISIT_GRANT_ACTION;
  runId: string;
  /** 发起回溯(被 blocked)的节点。 */
  sourceNodeId: string;
  /** 回溯目标祖先。 */
  toNodeId: string;
  /** 耗尽的层级 —— 决定 grant scope:'pair' 带 source/target,'run' 都不带。 */
  tier: 'pair' | 'run';
  /** blocked attemptId —— nonce + core expectedAttemptId 的 freshness key。 */
  attemptId: string;
  nonce: string;
}

export interface V3RevisitGrantCardInput {
  runId: string;
  sourceNodeId: string;
  toNodeId: string;
  tier: 'pair' | 'run';
  attemptId: string;
  /** 预算耗尽 detail(如 `... (1/1) — grant +1 ...`)。 */
  detail?: string;
  /** 省略则按 runId/sourceNodeId/attemptId 推导。 */
  nonce?: string;
  webDetailUrl?: string;
  detailMaxChars?: number;
  /** 有值 → 渲染冻结的「已准许」卡(无按钮,防 stale UI 重复提交)。 */
  grantedNow?: { by?: string };
}

const DEFAULT_DETAIL_MAX_CHARS = 500;

/** 稳定 nonce:同一 run 同一节点同一 blocked attempt 的卡 nonce 固定(重发一致);
 *  attemptId 入 nonce —— grant+retry 消费后 blocked 节点进入新 attempt,旧卡失效。 */
export function v3RevisitGrantCardNonce(runId: string, sourceNodeId: string, attemptId: string): string {
  return `v3revisitgrant:${runId}:${sourceNodeId}:${attemptId}`;
}

function v3RunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

export function buildV3RevisitGrantCard(input: V3RevisitGrantCardInput): string {
  const nonce = input.nonce ?? v3RevisitGrantCardNonce(input.runId, input.sourceNodeId, input.attemptId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const detailMax = input.detailMaxChars ?? DEFAULT_DETAIL_MAX_CHARS;
  const granted = input.grantedNow;

  const scopeLabel = input.tier === 'pair' ? `${input.sourceNodeId} → ${input.toNodeId}` : '整个 run';
  const title = granted ? `已准许回溯：${scopeLabel}` : `回溯预算耗尽：${scopeLabel}`;
  // 与 loop grant 卡同款语义色:耗尽=橙(可恢复),准许后转绿。
  const template = granted ? 'green' : 'orange';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**回溯**\n${escapeMd(input.sourceNodeId)} → ${escapeMd(input.toNodeId)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**耗尽层级**\n${input.tier === 'pair' ? 'per-pair（这条边）' : 'per-run（全局）'}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**情况**\n节点 ${escapeMd(input.sourceNodeId)} 想回溯到 ${escapeMd(input.toNodeId)},但回溯次数已到上限` +
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
        content: `➕ 已准许再回溯 1 次（${input.tier === 'pair' ? '本边' : '全局'}）` +
          (granted.by ? ` · by ${escapeMd(short(granted.by, 20))}` : ''),
      },
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '点「准许回溯 +1」会放行这次回溯并自动重跑该节点；若觉得不该再回溯,留着不点即可（run 保持受阻）。',
      },
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '➕ 准许回溯 +1' },
          type: 'primary',
          value: {
            action: V3_REVISIT_GRANT_ACTION,
            runId: input.runId,
            sourceNodeId: input.sourceNodeId,
            toNodeId: input.toNodeId,
            tier: input.tier,
            attemptId: input.attemptId,
            nonce,
          } satisfies V3RevisitGrantActionValue,
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
        multi_url: { url: webDetailUrl, pc_url: webDetailUrl, android_url: webDetailUrl, ios_url: webDetailUrl },
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

/** 转义 lark_md 里会被解析的字符,防 detail 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
