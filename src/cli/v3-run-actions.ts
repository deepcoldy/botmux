/**
 * `botmux workflow retry --reason` / `botmux workflow ask-human` — the main
 * bot's automatic handling and hand-over (design 2026-11-03 §13.6, M3).
 * Parsing and response formatting live here so they are testable without
 * spawning the CLI; cli.ts wires authorization and daemon IPC.
 */

import { V3_DAG_SEGMENT_RE } from '../workflows/v3/dag.js';
import { parseV3ReasonFlag } from './v3-run-edit.js';

export const V3_RUN_RETRY_USAGE =
  '用法: botmux workflow retry <runId> [--node <nodeId>] [--reason "<为什么重试>"] [--bot <larkAppId>]';
export const V3_RUN_ASK_HUMAN_USAGE =
  '用法: botmux workflow ask-human <runId> --node <nodeId> --reason "<为什么交给人>"';

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

export type V3AskHumanCliOptions =
  | { ok: true; nodeId: string; reason: string }
  | { ok: false; error: string };

export function parseV3AskHumanCliOptions(rest: readonly string[]): V3AskHumanCliOptions {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    if (arg !== '--node' && arg !== '--reason') return { ok: false, error: `未知参数 ${arg}` };
    i++;
  }
  const nodeId = flagValue(rest, '--node');
  if (!nodeId) return { ok: false, error: '缺少 --node <nodeId>' };
  if (!V3_DAG_SEGMENT_RE.test(nodeId)) return { ok: false, error: `--node 不是合法的节点 id（收到 ${nodeId}）` };
  const reason = parseV3ReasonFlag(rest);
  if (!reason.ok) return reason;
  if (!reason.reason) return { ok: false, error: '缺少 --reason "<为什么交给人>"：交给人时必须写明理由' };
  return { ok: true, nodeId, reason: reason.reason };
}

const ASK_HUMAN_ERROR_TEXT: Record<string, string> = {
  unknown_run: '找不到这个 run',
  unknown_run_or_no_binding: '找不到这个 run，或它没有绑定群聊',
  not_bot_run: '只有「节点交给群里的 Bot 执行」的 run 能交给人',
  'not-bot-run': '只有「节点交给群里的 Bot 执行」的 run 能交给人',
  'run-not-running': 'run 已结束',
  'unknown-node': '流程里没有这个节点',
  'never-dispatched': '这个节点还没开始过，没有可交给人的执行；要先补信息，就用 workflow edit 改它的定义',
  'not-handable': '只能交给人：正在执行、或已受阻的节点（已完成、等待中、已跳过的不行）',
  'stale-attempt': '节点刚刚有了结果（提交、超时或被别人处理），先用 workflow status 看最新状态',
  'revision-pending': '有待发起人确认的修改涉及这个节点，先等确认卡处理',
  reason_required: '缺少 --reason',
  bad_reason: '--reason 不合法（不能为空，最多 500 字）',
};

const SETTLED_TEXT: Record<string, string> = {
  blocked: '受阻或超时',
  reassigned: '改派',
  cancelled: '取消',
  drained: '被替代或取消',
  succeeded: '已完成',
  failed: '失败',
};

/** Map the daemon's ask-human response to CLI output + exit code. */
export function formatV3AskHumanResponse(
  runId: string,
  nodeId: string,
  response: { ok: boolean; status: number; bodyRaw: string },
): { exitCode: number; text: string } {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(response.bodyRaw) as Record<string, unknown>;
  } catch {
    // fall through with the raw body
  }
  if (response.ok && body.ok === true) {
    if (typeof body.settledMeanwhile === 'string') {
      return {
        exitCode: 0,
        text: `🙋 run ${runId} 的节点 ${nodeId} 在停下的过程中已被其他操作结束（${SETTLED_TEXT[body.settledMeanwhile] ?? body.settledMeanwhile}），` +
          '以那次结果为准；交给人的理由已记录。先用 workflow status 看最新状态。',
      };
    }
    return {
      exitCode: 0,
      text: body.closedOpenAttempt === true
        ? `🙋 run ${runId} 的节点 ${nodeId} 已停下并交给人决定；主话题会出现受阻卡（重试 / 改派 / 取消），理由已写进节点卡和运行记录。`
        : `🙋 run ${runId} 的节点 ${nodeId} 已受阻，已记为交给人决定；理由已写进节点卡和运行记录，主话题的受阻卡照常可用。`,
    };
  }
  const code = typeof body.error === 'string' ? body.error : '';
  const known = ASK_HUMAN_ERROR_TEXT[code];
  return {
    exitCode: 1,
    text: known
      ? `❌ ask-human 失败：${known}${typeof body.detail === 'string' ? `（${body.detail}）` : ''}`
      : `❌ ask-human 失败 (HTTP ${response.status}): ${response.bodyRaw}`,
  };
}
