/**
 * v3 回溯预算准许卡点击处理 —— card-handler 的 v3 分支(与
 * `v3-loop-grant-card-handler` 同骨架)。把一次「➕ 准许回溯 +1」点击翻译成:
 * 权限校验 → `requestRevisitGrant`(原子 grant + retry;幂等:已恢复 →
 * not-budget-blocked) → 冻结卡 / toast + 触发 `driveV3Run` 重跑被卡节点。
 *
 * scope 正确性:按钮 value 带 tier —— pair grant 带 source/target,run grant
 * 都不带,交给 core 的 partial-pair / pair-source-mismatch 守卫兜底。
 */

import { join } from 'node:path';
import {
  V3_REVISIT_GRANT_ACTION,
  buildV3RevisitGrantCard,
  v3RevisitGrantCardNonce,
  type V3RevisitGrantActionValue,
} from './v3-revisit-grant-card.js';
import { requestRevisitGrant, revisitBudgetBlockedInfoFor, readV3RunChatBinding } from '../../workflows/v3/daemon-run.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { defaultBaseDir, type RunChatBinding } from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';

export function isV3RevisitGrantAction(action: unknown): boolean {
  return action === V3_REVISIT_GRANT_ACTION;
}

export interface V3RevisitGrantCardHandlerDeps {
  baseDir?: string;
  /** Re-enter the run after grant + retry.  Fire-and-forget (daemon logs errors). */
  driveRun: (runId: string) => void;
  /** Permission: may this operator grant revisits of this run?  Same semantics
   *  as the gate/blocked/loop-grant handlers' canResolve. */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Injectable for tests. Default = real requestRevisitGrant. */
  requestGrant?: typeof requestRevisitGrant;
}

/**
 * Handle a v3 revisit-grant card click.  Returns the Lark card-action response:
 * a frozen「已准许」card, or a `{ toast }`.  Triggers `driveRun` on success.
 */
export async function handleV3RevisitGrantAction(
  value: V3RevisitGrantActionValue,
  operatorOpenId: string | undefined,
  deps: V3RevisitGrantCardHandlerDeps,
): Promise<unknown> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  if (!isValidRunId(value.runId)) {
    return { toast: { type: 'warning', content: '准许已失效（非法 run）' } };
  }
  // attemptId 入 nonce:grant+retry 消费后节点进入新 attempt,旧卡 nonce 对不上 → stale。
  if (value.nonce !== v3RevisitGrantCardNonce(value.runId, value.sourceNodeId, value.attemptId)) {
    return { toast: { type: 'warning', content: '准许卡已失效（nonce 不匹配，看最新那张卡）' } };
  }
  const tier = value.tier === 'run' ? 'run' : 'pair';
  const runDir = join(baseDir, value.runId);
  const binding = readV3RunChatBinding(runDir);

  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: '你没有权限准许这个 run 的回溯' } };
  }

  const requestGrant = deps.requestGrant ?? requestRevisitGrant;
  let outcome;
  try {
    // pair grant 带 source/target;run grant 都不带。expectedAttemptId(同
    // expectedAttemptId 教训):nonce 只证卡自身没改,证不了它指向的耗尽 attempt
    // 还是"当前这次"——core 必须再比一次。
    outcome = requestGrant(baseDir, value.runId, {
      ...(tier === 'pair' ? { sourceNodeId: value.sourceNodeId, toNodeId: value.toNodeId } : {}),
      by: operatorOpenId ?? 'system',
      expectedAttemptId: value.attemptId,
    });
  } catch (err) {
    return {
      toast: { type: 'error', content: `准许失败，请再试：${err instanceof Error ? err.message : String(err)}` },
    };
  }

  if (outcome.kind === 'invalid') {
    return {
      toast: {
        type: 'warning',
        content: outcome.reason === 'partial-pair' ? '准许卡参数不完整（pair 信息缺失）' : '准许卡与当前受阻节点不匹配',
      },
    };
  }
  if (outcome.kind === 'stale-run') {
    // Idempotent recovery (codex nit #13): `not-budget-blocked` means a prior
    // grant already extended the budget and the node is no longer blocked. If
    // that grant's driveRun didn't land (transient), a re-click should re-drive
    // rather than dead-end at a warning. driveRun is terminal-safe, so re-driving
    // a run that genuinely moved on (or finished) is harmless. This mirrors the
    // blocked/loop grant handlers' already-granted branch.
    if (outcome.reason === 'not-budget-blocked') deps.driveRun(value.runId);
    return {
      toast: {
        type: 'warning',
        content:
          outcome.reason === 'missing' ? '该 run 不存在或已清理'
          : outcome.reason === 'stale-attempt' ? '该节点已进入新一次尝试，这张旧卡失效（看最新那张卡）'
          : '该 run 已不在回溯预算受阻状态，准许卡失效',
      },
    };
  }

  // granted → drive the run (blocked node retries within extended budget) + freeze card.
  deps.driveRun(value.runId);
  const info = revisitBudgetBlockedInfoFor(readJournal(join(runDir, 'journal.ndjson')), value.sourceNodeId);
  const frozen = buildV3RevisitGrantCard({
    runId: value.runId,
    sourceNodeId: value.sourceNodeId,
    toNodeId: value.toNodeId,
    tier,
    attemptId: value.attemptId,
    detail: info?.detail,
    grantedNow: { by: operatorOpenId },
  });
  return JSON.parse(frozen);
}
