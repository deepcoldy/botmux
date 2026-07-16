/**
 * v3 blocked 重试卡点击处理 —— card-handler 的 v3 分支（对称于
 * `v3-gate-card-handler`）。把一次「🔄 重试」点击翻译成：
 * 权限校验 → `requestV3Retry`（幂等：unconsumed reservation → already-requested）
 * → 冻结卡 / toast + 触发 `driveV3Run` 以新 attempt 重跑。
 *
 * 纯逻辑 + 注入 seam（requestRetry / driveRun / canResolve），单测友好。
 */

import { join } from 'node:path';
import {
  V3_BLOCKED_RETRY_ACTION,
  V3_BLOCKED_ASK_ANSWER_ACTION,
  V3_BLOCKED_ASK_TEXT_FIELD,
  buildV3BlockedCard,
  v3BlockedCardNonce,
  type V3BlockedActionValue,
  type V3AskAnswerActionValue,
} from './v3-blocked-card.js';
import { requestV3Retry, blockedInfoFor, readV3RunChatBinding } from '../../workflows/v3/daemon-run.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { defaultBaseDir, type RunChatBinding } from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';

export function isV3BlockedAction(action: unknown): boolean {
  return action === V3_BLOCKED_RETRY_ACTION || action === V3_BLOCKED_ASK_ANSWER_ACTION;
}

function isV3AskAnswerValue(
  value: V3BlockedActionValue | V3AskAnswerActionValue,
): value is V3AskAnswerActionValue {
  return value.action === V3_BLOCKED_ASK_ANSWER_ACTION;
}

export interface V3BlockedCardHandlerDeps {
  baseDir?: string;
  /** Re-enter the run after a retry append.  Fire-and-forget (daemon logs errors). */
  driveRun: (runId: string) => void;
  /** Permission: may this operator retry nodes of this run?  Same semantics as
   *  the gate handler's canResolve (daemon injects a canOperate-backed check). */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Injectable for tests. Default = real requestV3Retry. */
  requestRetry?: typeof requestV3Retry;
}

/**
 * Handle a v3 blocked-card retry click.  Returns the Lark card-action response:
 * a frozen「已重试」card, or a `{ toast }`.  Triggers `driveRun` on success.
 */
export async function handleV3BlockedAction(
  value: V3BlockedActionValue | V3AskAnswerActionValue,
  operatorOpenId: string | undefined,
  deps: V3BlockedCardHandlerDeps,
  formValue?: Record<string, unknown>,
): Promise<unknown> {
  // 同一张卡两条 action：普通重试 / human-ask 选项答题。后者额外带 selected，
  // 走同一条 requestV3Retry 通道（带 answer），只是冻结卡渲染不同。
  const isAsk = isV3AskAnswerValue(value);
  const verb = isAsk ? '回答' : '重试';
  const baseDir = deps.baseDir ?? defaultBaseDir();
  if (!isValidRunId(value.runId)) {
    return { toast: { type: 'warning', content: `${verb}已失效（非法 run）` } };
  }
  // attempt 入 nonce：重试过的节点（attempt 已前进）的旧卡 nonce 对不上 → stale。
  if (value.nonce !== v3BlockedCardNonce(value.runId, value.nodeId, value.attemptId)) {
    return { toast: { type: 'warning', content: `这张卡已失效（nonce 不匹配）` } };
  }
  const runDir = join(baseDir, value.runId);
  const binding = readV3RunChatBinding(runDir);

  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: `你没有权限${verb}这个节点` } };
  }

  const requestRetry = deps.requestRetry ?? requestV3Retry;
  let outcome;
  let answer:
    | { selected: string; by: string }
    | { text: string; by: string }
    | undefined;
  try {
    // Only accept a genuine string: `String(obj)` would coerce a forged object/
    // array form value to "[object Object]"/"a,b" — non-empty, so it would slip
    // past the "请先填写答案" guard and feed garbage to the agent (codex nit #16).
    const rawTextAnswer = formValue?.[V3_BLOCKED_ASK_TEXT_FIELD];
    const textAnswer =
      isAsk && 'answerKind' in value && value.answerKind === 'text'
        ? (typeof rawTextAnswer === 'string' ? rawTextAnswer.trim() : '')
        : undefined;
    if (isAsk && 'answerKind' in value && value.answerKind === 'text' && !textAnswer) {
      return { toast: { type: 'warning', content: '请先填写答案' } };
    }
    if (isAsk) {
      if (textAnswer !== undefined) {
        answer = { text: textAnswer, by: operatorOpenId ?? 'unknown' };
      } else if ('selected' in value) {
        answer = { selected: value.selected, by: operatorOpenId ?? 'unknown' };
      } else {
        return { toast: { type: 'warning', content: '这张卡已失效（答案类型不匹配）' } };
      }
    }
    // expectedAttemptId（codex blocker）：nonce 只证明这张卡自身没被改，证不了
    // 它指向的 attempt 还是"当前 blocked 的那个"——core 必须再比一次，否则
    // 001 的旧卡能把 002 的 blocked 推进到 003。
    outcome = requestRetry(baseDir, value.runId, {
      nodeId: value.nodeId,
      expectedAttemptId: value.attemptId,
      ...(answer ? { answer } : {}),
    });
  } catch (err) {
    return {
      toast: {
        type: 'error',
        content: `${verb}失败，请再试：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (outcome.kind === 'stale-run') {
    return {
      toast: {
        type: 'warning',
        content:
          outcome.reason === 'missing' ? '该 run 不存在或已清理'
          : outcome.reason === 'stale-attempt' ? '该节点已进入新一轮 attempt，这张旧卡失效（看最新那张卡）'
          : outcome.reason === 'invalid-answer' ? '这个选项不属于当前问题，卡片已失效'
          : outcome.reason === 'host-effect-uncertain' ? '该节点可能已产生外部副作用，禁止普通重试；请先完成 host effect 对账'
          : `该节点已不在受阻状态，${verb}卡失效`,
      },
    };
  }
  if (outcome.kind === 'already-requested') {
    // Idempotent: a prior click already reserved the retry — make sure the
    // run is actually moving (covers click → daemon crash → click after restart).
    deps.driveRun(value.runId);
    return { toast: { type: 'info', content: isAsk ? '已回答，正在重跑' : '已在重试中' } };
  }

  // requested → drive the run (fresh replay re-dispatches with the reserved
  // attempt) + freeze this card.
  deps.driveRun(value.runId);
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const info = blockedInfoFor(events, value.nodeId);
  const frozen = isAsk
    ? buildV3BlockedCard({
        runId: value.runId,
        nodeId: value.nodeId,
        attemptId: value.attemptId,
        // 带上 ask 仅为在冻结卡里复现问题文案（answered 优先于 options 渲染）。
        ask: info.ask,
        answered: {
          ...(answer && 'text' in answer
            ? { text: answer.text }
            : { selected: answer?.selected ?? '' }),
          nextAttemptId: outcome.nextAttemptId,
          by: operatorOpenId,
        },
      })
    : buildV3BlockedCard({
        runId: value.runId,
        nodeId: value.nodeId,
        attemptId: value.attemptId,
        errorClass: info.errorClass,
        errorCode: info.errorCode,
        message: info.message,
        retried: { nextAttemptId: outcome.nextAttemptId, by: operatorOpenId },
      });
  return JSON.parse(frozen);
}
