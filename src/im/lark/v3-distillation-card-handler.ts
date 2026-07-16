/** Authenticated Lark callback boundary for v3 parameter-distillation cards. */

import {
  acceptV3WorkflowDistillation,
  rejectV3WorkflowDistillation,
} from '../../workflows/v3/distillation-service.js';
import { loadProposal } from '../../workflows/v3/distillation-store.js';
import {
  V3_DISTILL_ACCEPT_ACTION,
  V3_DISTILL_REJECT_ACTION,
  buildV3DistillationCommittedCard,
  buildV3DistillationRejectedCard,
  isV3DistillationAction,
  parseV3DistillationActionValue,
} from './v3-distillation-card.js';

export { isV3DistillationAction } from './v3-distillation-card.js';

export interface V3DistillationCardHandlerDeps {
  dataDir: string;
  baseDir: string;
  resolveMessageChatId(larkAppId: string, messageId: string): Promise<string | null>;
  onError?(proposalId: string, error: unknown): void;
}

function stale(): unknown {
  return { toast: { type: 'warning', content: '参数化提案已失效，请重新发起。' } };
}

function denied(): unknown {
  return { toast: { type: 'error', content: '无法验证操作人、Bot 或提案所在群。' } };
}

/** Safe fixed copy only. Never reflect model, source, path, or provider text. */
export function v3DistillationUserErrorMessage(
  error: unknown,
  phase: 'prepare' | 'generate' | 'approve',
): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  switch (code) {
    case 'unsafe_display_name':
      return '模板名称可能包含身份、凭据或机器本地信息，请换一个名称。';
    case 'source_changed':
    case 'SOURCE_CHANGED':
    case 'SOURCE_NOT_ELIGIBLE':
    case 'SOURCE_NOT_FOUND':
      return '源 Workflow 已变化，或不是当前群中由你发起且已成功的 v3 run，请重新发起。';
    case 'UNSUPPORTED_PLATFORM':
    case 'UNSUPPORTED_CLI':
      return '参数蒸馏目前只支持 Linux 上未使用启动 wrapper 的 Claude Code Bot。';
    case 'INVALID_MODEL_INPUT':
      return '当前 Bot 的模型凭据模式暂不支持参数蒸馏；请配置独立 API Key、Bedrock 直连凭据或 Foundry API Key。';
    case 'MANAGED_POLICY_UNSUPPORTED':
      return '当前机器启用了 Claude 托管策略，无法证明无工具蒸馏边界，因此已拒绝运行。';
    case 'SCRATCH_SETUP_FAILED':
    case 'SCRATCH_CLEANUP_FAILED':
      return '参数蒸馏隔离环境不可用或未能安全清理；未创建 Saved Workflow，请联系管理员检查后重试。';
    case 'MODEL_FAILED':
    case 'MODEL_OUTPUT_INVALID':
      return '模型未能生成有效的参数提案；未创建 Saved Workflow，可以重新发起。';
    case 'IDENTITY_BUSY':
      return '该源 Workflow 已有提案正在确认或提交，请先完成当前提案。';
    case 'STALE_PROPOSAL':
    case 'STATE_CONFLICT':
    case 'proposal_not_ready':
      return '参数化提案已失效，请重新发起。';
    case 'approval_denied':
      return '只有源 Workflow 的发起人可以在原群和原 Bot 下确认该提案。';
    case 'commit_conflict':
    case 'CONTENT_CONFLICT':
      return '提案与现有 Saved Workflow 不一致，已停止写入；请重新发起。';
    default:
      return phase === 'prepare'
        ? '无法从该 run 生成参数化提案；请检查源 run 后重试。'
        : phase === 'generate'
          ? '参数化提案生成失败；未创建或修改任何 Saved Workflow。'
          : '参数化提案无法继续处理，请重新发起。';
  }
}

export async function handleV3DistillationAction(
  rawValue: unknown,
  operatorOpenId: string | undefined,
  receivingLarkAppId: string | undefined,
  cardMessageId: string | undefined,
  deps: V3DistillationCardHandlerDeps,
): Promise<unknown> {
  const value = parseV3DistillationActionValue(rawValue);
  if (!value) return stale();
  if (!operatorOpenId || !receivingLarkAppId || !cardMessageId) return denied();

  try {
    const chatId = await deps.resolveMessageChatId(receivingLarkAppId, cardMessageId);
    if (!chatId) return denied();
    const loaded = loadProposal(deps.dataDir, value.proposalId);
    if (!loaded.proposal) return stale();
    const proposalHash = loaded.proposal.proposalHash;
    if (value.action === V3_DISTILL_REJECT_ACTION) {
      rejectV3WorkflowDistillation({
        dataDir: deps.dataDir,
        proposalId: value.proposalId,
        proposalHash,
        nonce: value.nonce,
        operatorOpenId,
        larkAppId: receivingLarkAppId,
        chatId,
      });
      return JSON.parse(buildV3DistillationRejectedCard());
    }
    if (value.action !== V3_DISTILL_ACCEPT_ACTION) return stale();
    const result = await acceptV3WorkflowDistillation({
      dataDir: deps.dataDir,
      baseDir: deps.baseDir,
      proposalId: value.proposalId,
      proposalHash,
      nonce: value.nonce,
      operatorOpenId,
      larkAppId: receivingLarkAppId,
      chatId,
    });
    return JSON.parse(buildV3DistillationCommittedCard(result));
  } catch (error) {
    deps.onError?.(value.proposalId, error);
    return {
      toast: {
        type: 'warning',
        content: v3DistillationUserErrorMessage(error, 'approve'),
      },
    };
  }
}
