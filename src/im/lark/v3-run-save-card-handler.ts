/** Terminal progress-card action: save one succeeded ad-hoc v3 run. */

import { join } from 'node:path';

import {
  saveTerminalRunAsWorkflowIdempotent,
  type SavedWorkflowActorContext,
} from '../../workflows/v3/library-service.js';
import { SavedWorkflowUnsafeLiteralError } from '../../workflows/v3/library-materialize.js';
import { loadAuthorizedV3Run } from '../../workflows/v3/run-envelope.js';
import { defaultBaseDir } from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { materialize } from '../../workflows/v3/state.js';
import { freezeV3ProgressCard } from './v3-progress-card-manager.js';
import {
  V3_RUN_SAVE_ACTION,
  V3_RUN_SAVE_CONFIRM_ACTION,
  buildV3RunSavedCard,
  buildV3RunSaveWarningCard,
  v3RunSaveNonce,
  type V3RunSaveActionValue,
} from './v3-run-save-card.js';

export function isV3RunSaveAction(action: unknown): boolean {
  return action === V3_RUN_SAVE_ACTION || action === V3_RUN_SAVE_CONFIRM_ACTION;
}

export interface V3RunSaveCardHandlerDeps {
  baseDir?: string;
  dataDir: string;
  saveRun?: typeof saveTerminalRunAsWorkflowIdempotent;
  onError?: (runId: string, error: unknown) => void;
}

export async function handleV3RunSaveAction(
  value: V3RunSaveActionValue,
  operatorOpenId: string | undefined,
  receivingLarkAppId: string | undefined,
  deps: V3RunSaveCardHandlerDeps,
): Promise<unknown> {
  if (!isV3RunSaveAction(value.action)) return stale('非法 action');
  if (!isValidRunId(value.runId)) return stale('非法 run');
  if (value.scope !== 'chat' && value.scope !== 'global') return stale('非法 scope');
  if (!operatorOpenId || !receivingLarkAppId) return denied('无法验证操作人或 bot');

  const baseDir = deps.baseDir ?? defaultBaseDir();
  const runDir = join(baseDir, value.runId);
  let loaded;
  try {
    loaded = loadAuthorizedV3Run(runDir, {
      expectedRunId: value.runId,
      allowedSources: ['ad_hoc', 'legacy_v3'],
    });
  } catch (err) {
    deps.onError?.(value.runId, err);
    return stale('run 完整性校验失败');
  }

  const binding = loaded.envelope.chatBinding;
  if (
    !binding?.ownerOpenId ||
    binding.ownerOpenId !== operatorOpenId ||
    binding.larkAppId !== receivingLarkAppId
  ) {
    return denied('只有发起该 run 的用户，才能在原 bot 下保存');
  }
  if (loaded.envelope.source.kind === 'legacy_v3' && loaded.envelope.source.original !== 'grill') {
    return stale('该 legacy run 没有可证明的聊天来源');
  }

  let status: string;
  try {
    status = materialize(readJournal(join(runDir, 'journal.ndjson'))).runStatus;
  } catch (err) {
    deps.onError?.(value.runId, err);
    return stale('journal 校验失败');
  }
  if (status !== 'succeeded') return stale(`run 状态为 ${status}`);

  const warningDigest = value.action === V3_RUN_SAVE_CONFIRM_ACTION
    ? value.warningDigest
    : undefined;
  if (
    value.action === V3_RUN_SAVE_CONFIRM_ACTION &&
    (typeof warningDigest !== 'string' || !/^[0-9a-f]{64}$/.test(warningDigest))
  ) return stale('warning digest 不合法');
  if (
    value.nonce !== v3RunSaveNonce(loaded.envelope, value.scope, warningDigest) ||
    (value.action === V3_RUN_SAVE_CONFIRM_ACTION && !warningDigest)
  ) {
    return stale('nonce 不匹配');
  }
  if (value.scope === 'global') {
    return denied(
      `卡片不再直接发布当前 Bot 全局 Workflow；请显式发送 ` +
      `\`/workflow save ${value.runId} [名称] --global\``,
    );
  }

  const context: SavedWorkflowActorContext = {
    actor: { openId: operatorOpenId, larkAppId: receivingLarkAppId },
    chatId: binding.chatId,
    ...(binding.rootMessageId ? { rootMessageId: binding.rootMessageId } : {}),
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
  };
  const saveRun = deps.saveRun ?? saveTerminalRunAsWorkflowIdempotent;

  // Confirmation clicks must recompute the warnings from immutable artifacts;
  // warningDigest from action.value is never trusted on its own.
  if (value.action === V3_RUN_SAVE_CONFIRM_ACTION) {
    try {
      const alreadySaved = await saveRun({
        dataDir: deps.dataDir,
        runDir,
        context,
        scope: value.scope,
        acknowledgeUnsafeLiterals: false,
      });
      // A code upgrade may have removed the warning rule since this card was
      // rendered. ack=false is the real save seam, so a successful probe has
      // already committed (or replayed) the idempotent definition — report it
      // honestly instead of claiming the action went stale.
      await freezeV3ProgressCard(runDir).catch((freezeErr) => deps.onError?.(value.runId, freezeErr));
      return JSON.parse(buildV3RunSavedCard({
        runId: value.runId,
        displayName: alreadySaved.metadata.displayName,
        workflowId: alreadySaved.metadata.workflowId,
        humanVersion: alreadySaved.revision.payload.humanVersion,
        revisionId: alreadySaved.revision.revisionId,
        scope: alreadySaved.metadata.scope.kind,
        requestedScope: value.scope,
      }));
    } catch (err) {
      if (!(err instanceof SavedWorkflowUnsafeLiteralError)) {
        deps.onError?.(value.runId, err);
        return failed(value.runId);
      }
      if (err.warningDigest !== warningDigest) {
        return stale('风险项已经变化，请重新确认');
      }
    }
  }

  try {
    const result = await saveRun({
      dataDir: deps.dataDir,
      runDir,
      context,
      scope: value.scope,
      acknowledgeUnsafeLiterals: value.action === V3_RUN_SAVE_CONFIRM_ACTION,
    });
    await freezeV3ProgressCard(runDir).catch((err) => deps.onError?.(value.runId, err));
    return JSON.parse(buildV3RunSavedCard({
      runId: value.runId,
      displayName: result.metadata.displayName,
      workflowId: result.metadata.workflowId,
      humanVersion: result.revision.payload.humanVersion,
      revisionId: result.revision.revisionId,
      scope: result.metadata.scope.kind,
      requestedScope: value.scope,
    }));
  } catch (err) {
    if (err instanceof SavedWorkflowUnsafeLiteralError) {
      await freezeV3ProgressCard(runDir).catch((freezeErr) => deps.onError?.(value.runId, freezeErr));
      return JSON.parse(buildV3RunSaveWarningCard({
        envelope: loaded.envelope,
        scope: value.scope,
        warnings: err.warnings,
        warningDigest: err.warningDigest,
      }));
    }
    deps.onError?.(value.runId, err);
    return failed(value.runId);
  }
}

function stale(reason: string): unknown {
  return { toast: { type: 'warning', content: `保存入口已失效：${reason}` } };
}

function denied(reason: string): unknown {
  return { toast: { type: 'warning', content: reason } };
}

function failed(runId: string): unknown {
  return {
    toast: {
      type: 'error',
      content: `保存失败，请改用 \`/workflow save ${runId}\` 查看详细错误`,
    },
  };
}
