/**
 * v3 loop 追加一轮卡点击处理 —— card-handler 的 v3 分支（与
 * `v3-blocked-card-handler` 同骨架）。把一次「➕ 追加 1 轮」点击翻译成：
 * 权限校验 → `requestV3LoopGrant`（幂等：pendingGrant → already-granted）
 * → 冻结卡 / toast + 触发 `driveV3Run` 跑新一轮。
 *
 * 纯逻辑 + 注入 seam（requestGrant / driveRun / canResolve），单测友好。
 */

import { join } from 'node:path';
import {
  V3_LOOP_GRANT_ACTION,
  buildV3LoopGrantCard,
  v3LoopGrantCardNonce,
  type V3LoopGrantActionValue,
} from './v3-loop-grant-card.js';
import { requestV3LoopGrant, loopExhaustedInfoFor, readV3RunChatBinding } from '../../workflows/v3/daemon-run.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { defaultBaseDir, type RunChatBinding } from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';

export function isV3LoopGrantAction(action: unknown): boolean {
  return action === V3_LOOP_GRANT_ACTION;
}

export interface V3LoopGrantCardHandlerDeps {
  baseDir?: string;
  /** Re-enter the run after a grant append.  Fire-and-forget (daemon logs errors). */
  driveRun: (runId: string) => void;
  /** Permission: may this operator grant iterations of this run?  Same
   *  semantics as the gate/blocked handlers' canResolve. */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Injectable for tests. Default = real requestV3LoopGrant. */
  requestGrant?: typeof requestV3LoopGrant;
}

/**
 * Handle a v3 loop-grant card click.  Returns the Lark card-action response:
 * a frozen「已追加」card, or a `{ toast }`.  Triggers `driveRun` on success.
 */
export async function handleV3LoopGrantAction(
  value: V3LoopGrantActionValue,
  operatorOpenId: string | undefined,
  deps: V3LoopGrantCardHandlerDeps,
): Promise<unknown> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  if (!isValidRunId(value.runId)) {
    return { toast: { type: 'warning', content: '追加已失效（非法 run）' } };
  }
  // 飞书卡片 value 回传可能把 number 落成 string —— 先归一化再比 nonce。
  const iteration =
    typeof value.iteration === 'number' ? value.iteration : parseInt(String(value.iteration), 10);
  if (!Number.isInteger(iteration) || iteration < 1) {
    return { toast: { type: 'warning', content: '追加卡已失效（轮数非法）' } };
  }
  // iteration 入 nonce：grant 被消费 / 新一轮再耗尽后，旧卡 nonce 对不上 → stale。
  if (value.nonce !== v3LoopGrantCardNonce(value.runId, value.loopId, iteration)) {
    return { toast: { type: 'warning', content: '追加卡已失效（nonce 不匹配）' } };
  }
  const runDir = join(baseDir, value.runId);
  const binding = readV3RunChatBinding(runDir);

  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: '你没有权限给这个 loop 追加轮数' } };
  }

  const requestGrant = deps.requestGrant ?? requestV3LoopGrant;
  let outcome;
  try {
    // expectedIteration（expectedAttemptId 的同款教训）：nonce 只证明这张卡
    // 自身没被改，证不了它指向的耗尽轮还是"当前这次耗尽"——core 必须再比一次。
    outcome = requestGrant(baseDir, value.runId, {
      loopId: value.loopId,
      expectedIteration: iteration,
      by: operatorOpenId,
    });
  } catch (err) {
    return {
      toast: {
        type: 'error',
        content: `追加失败，请再试：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (outcome.kind === 'stale-run') {
    return {
      toast: {
        type: 'warning',
        content:
          outcome.reason === 'missing' ? '该 run 不存在或已清理'
          : outcome.reason === 'stale-iteration' ? '该 loop 已进入新一轮，这张旧卡失效（看最新那张卡）'
          : '该 loop 已不在耗尽状态，追加卡失效',
      },
    };
  }
  if (outcome.kind === 'already-granted') {
    // Idempotent: a prior click already reserved the extra round — make sure
    // the run is actually moving (covers click → daemon crash → click after restart).
    deps.driveRun(value.runId);
    return { toast: { type: 'info', content: '已在追加重跑中' } };
  }

  // granted → drive the run (fresh replay starts iteration N+1) + freeze this card.
  deps.driveRun(value.runId);
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const info = loopExhaustedInfoFor(events, value.loopId);
  const frozen = buildV3LoopGrantCard({
    runId: value.runId,
    loopId: value.loopId,
    iteration,
    detail: info.detail,
    grantedNow: { nextIteration: outcome.nextIteration, by: operatorOpenId },
  });
  return JSON.parse(frozen);
}
