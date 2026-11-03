/**
 * 「流程修改确认」卡点击 → decideV3RevisionProposal（发起人校验 + 首次决定生效 +
 * 按当前状态重新校验）→ 冻结卡 / toast，并重驱动 run 让暂停的节点继续。
 */

import {
  decideV3RevisionProposal,
  grantV3RerunBudget,
  type V3RevisionDecisionOutcome,
  type V3VoidedGate,
} from '../../workflows/v3/run-edit.js';
import { defaultBaseDir } from '../../workflows/v3/grill-state.js';
import { readV3RunChatBinding } from '../../workflows/v3/daemon-run.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import { join } from 'node:path';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';
import {
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_REJECT_ACTION,
  V3_REVISION_RERUN_GRANT_ACTION,
  buildV3RerunGrantCard,
  buildV3RevisionCard,
  v3RerunGrantCardNonce,
  v3RevisionCardNonce,
  type V3RerunGrantActionValue,
  type V3RevisionActionValue,
} from './v3-revision-card.js';
import { V3_DAG_SEGMENT_RE } from '../../workflows/v3/dag.js';

export function isV3RevisionAction(action: unknown): boolean {
  return action === V3_REVISION_APPROVE_ACTION ||
    action === V3_REVISION_REJECT_ACTION ||
    action === V3_REVISION_RERUN_GRANT_ACTION;
}

export interface V3RevisionCardHandlerDeps {
  baseDir?: string;
  driveRun: (runId: string) => void;
  /** Permission gate for the card's owning app/group (canOperate). The
   *  initiator equality check below is app-scoped open_id; this binds the
   *  click to the run's own app and group, same as every other v3 card. */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Freeze the cards of gates the approved revision voided (best effort). */
  onVoidedGates?: (runId: string, gates: V3VoidedGate[]) => void;
  /** Test seam. */
  decide?: typeof decideV3RevisionProposal;
}

export async function handleV3RevisionAction(
  value: V3RevisionActionValue | V3RerunGrantActionValue,
  operatorOpenId: string | undefined,
  deps: V3RevisionCardHandlerDeps,
): Promise<unknown> {
  if (value.action === V3_REVISION_RERUN_GRANT_ACTION) return handleRerunGrant(value, operatorOpenId, deps);
  return handleDecision(value, operatorOpenId, deps);
}

async function handleRerunGrant(
  value: V3RerunGrantActionValue,
  operatorOpenId: string | undefined,
  deps: V3RevisionCardHandlerDeps,
): Promise<unknown> {
  if (!isValidRunId(value.runId) || typeof value.nodeId !== 'string' || !V3_DAG_SEGMENT_RE.test(value.nodeId) ||
    (value.tier !== 'pair' && value.tier !== 'run') || !Number.isSafeInteger(value.epoch) ||
    value.nonce !== v3RerunGrantCardNonce(value.runId, value.nodeId, value.tier, value.epoch)) {
    return { toast: { type: 'warning', content: '重做额度卡已失效' } };
  }
  if (!operatorOpenId) return { toast: { type: 'warning', content: '无法识别操作人' } };
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const binding = readV3RunChatBinding(join(baseDir, value.runId));
  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: '你没有权限操作这个流程的重做额度' } };
  }
  const outcome = grantV3RerunBudget({
    baseDir,
    runId: value.runId,
    nodeId: value.nodeId,
    tier: value.tier,
    epoch: value.epoch,
    by: operatorOpenId,
  });
  switch (outcome.kind) {
    case 'expired':
      return {
        toast: {
          type: 'warning',
          content: outcome.newerCardPosted
            ? '这张卡已过期，请看主话题里最新的「追加重做额度」卡'
            : '这张卡已过期，请让主 Bot 重新提交这次修改',
        },
      };
    case 'unauthorized':
      return { toast: { type: 'warning', content: '只有本流程的发起人能追加重做额度' } };
    case 'missing':
      return { toast: { type: 'warning', content: '找不到这个 run' } };
    case 'already-granted':
      return { toast: { type: 'info', content: '额度已经够用，请重新提交修改' } };
    case 'stale':
      return JSON.parse(buildV3RerunGrantCard({
        runId: value.runId, nodeId: value.nodeId, tier: value.tier, epoch: value.epoch, resolution: { kind: 'void', detail: outcome.detail },
      }));
    case 'granted':
      return JSON.parse(buildV3RerunGrantCard({
        runId: value.runId, nodeId: value.nodeId, tier: outcome.tier, epoch: value.epoch, resolution: { kind: 'granted', by: operatorOpenId },
      }));
  }
}

async function handleDecision(
  value: V3RevisionActionValue,
  operatorOpenId: string | undefined,
  deps: V3RevisionCardHandlerDeps,
): Promise<unknown> {
  if (!isValidRunId(value.runId) || !Number.isSafeInteger(value.revision) || value.revision < 2) {
    return { toast: { type: 'warning', content: '流程修改卡已失效' } };
  }
  if (value.nonce !== v3RevisionCardNonce(value.runId, value.revision)) {
    return { toast: { type: 'warning', content: '流程修改卡已失效（nonce 不匹配）' } };
  }
  if (!operatorOpenId) return { toast: { type: 'warning', content: '无法识别操作人' } };
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const binding = readV3RunChatBinding(join(baseDir, value.runId));
  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: '你没有权限确认这个流程的修改' } };
  }
  const decide = deps.decide ?? decideV3RevisionProposal;
  let outcome: V3RevisionDecisionOutcome;
  try {
    outcome = decide({
      baseDir,
      runId: value.runId,
      revision: value.revision,
      decision: value.action === V3_REVISION_APPROVE_ACTION ? 'approve' : 'reject',
      by: operatorOpenId,
    });
  } catch (err) {
    return { toast: { type: 'error', content: `处理失败，请重试：${err instanceof Error ? err.message : String(err)}` } };
  }
  switch (outcome.kind) {
    case 'unauthorized':
      return { toast: { type: 'warning', content: '只有本流程的发起人能确认修改' } };
    case 'missing':
      return { toast: { type: 'warning', content: '找不到这条流程修改' } };
    case 'already-decided':
      if (outcome.view && outcome.status !== 'pending') {
        return JSON.parse(buildV3RevisionCard({
          runId: value.runId,
          view: outcome.view,
          resolution: outcome.status === 'approved' ? { kind: 'approved' }
            : outcome.status === 'rejected' ? { kind: 'rejected' }
            : { kind: 'void' },
        }));
      }
      return { toast: { type: 'info', content: '这条修改已经处理过了' } };
    case 'approved':
      if (outcome.voidedGates.length > 0) deps.onVoidedGates?.(value.runId, outcome.voidedGates);
      deps.driveRun(value.runId);
      return outcome.view
        ? JSON.parse(buildV3RevisionCard({ runId: value.runId, view: outcome.view, resolution: { kind: 'approved', by: operatorOpenId } }))
        : { toast: { type: 'success', content: `第 ${outcome.revision} 版已生效` } };
    case 'rejected':
      // Held nodes are released: drive so they dispatch on the old flow.
      deps.driveRun(value.runId);
      return outcome.view
        ? JSON.parse(buildV3RevisionCard({ runId: value.runId, view: outcome.view, resolution: { kind: 'rejected', by: operatorOpenId } }))
        : { toast: { type: 'info', content: '已拒绝' } };
    case 'stale':
      deps.driveRun(value.runId);
      return outcome.view
        ? JSON.parse(buildV3RevisionCard({ runId: value.runId, view: outcome.view, resolution: { kind: 'void', detail: outcome.detail } }))
        : { toast: { type: 'warning', content: `流程已变化，本次确认作废：${outcome.detail}` } };
  }
}
