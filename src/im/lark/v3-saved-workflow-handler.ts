/**
 * Host-neutral execution seam for Saved Workflow IM commands.
 *
 * This module deliberately returns a notification payload instead of sending
 * it.  Persistence/launch completion is therefore never reclassified as a
 * business failure merely because the Lark reply failed afterwards.
 */

import type { BotConfig } from '../../bot-registry.js';
import type { RawParamInput } from '../../workflows/shared/params.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import {
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  loadVisibleSavedWorkflow,
  resolveOwnedTerminalRunDir,
  saveTerminalRunAsWorkflow,
  type SavedWorkflowActorContext,
} from '../../workflows/v3/library-service.js';
import {
  readV3RunChatBinding,
  requestV3RunCancel,
  safeRunDir,
} from '../../workflows/v3/daemon-run.js';
import type { V3SavedWorkflowCommand } from './v3-saved-workflow-command.js';
import { v3SavedWorkflowAdHocRunEscapeHint } from './v3-saved-workflow-command.js';

export type ExecutableV3SavedWorkflowCommand = Exclude<V3SavedWorkflowCommand, { kind: 'invalid' }>;

function savedWorkflowScopeLabel(scope: { kind: 'chat' | 'global' }): string {
  return scope.kind === 'global' ? '当前 Bot 全局' : '本群';
}

export interface V3SavedWorkflowMessageTargetsInput {
  /** Existing daemon routing anchor; it may be an oc_ chat id in chat scope. */
  anchor: string;
  /** Real thread/fold-back root supplied by the event dispatcher, when any. */
  replyRootId?: string;
  /** Stable inbound message id. */
  messageId: string;
}

export interface V3SavedWorkflowMessageTargets {
  /** Where every user-visible reply for this invocation must land. */
  replyAnchor: string;
  /** Binding frozen into run.json. Always a message id, never the chat id. */
  runRootMessageId: string;
  /** Stable id used by quota deduplication. */
  quotaMessageId: string;
}

export function resolveV3SavedWorkflowMessageTargets(
  input: V3SavedWorkflowMessageTargetsInput,
): V3SavedWorkflowMessageTargets {
  const messageId = input.messageId.trim();
  if (!messageId) throw new Error('Saved Workflow invocation requires a stable messageId');
  const replyRootId = input.replyRootId?.trim();
  const runRootMessageId = replyRootId || messageId;
  if (runRootMessageId.startsWith('oc_')) {
    throw new Error('Saved Workflow run binding requires a message root, not a chat id');
  }
  return {
    replyAnchor: replyRootId || input.anchor,
    runRootMessageId,
    quotaMessageId: messageId,
  };
}

export type V3SavedWorkflowPolicyResult =
  | { ok: true }
  | { ok: false; reason: 'global_requires_operate' | 'quota_denied' };

/**
 * One authorization seam shared by all Saved Workflow verbs. Read commands
 * consume quota too, so a command can never accidentally become a free CLI
 * path merely by moving code between read/write branches. Cancellation is the
 * deliberate exception: it only reduces already-authorized work and must stay
 * available after the run-launching message exhausts a user's last quota.
 */
export async function authorizeV3SavedWorkflowInvocation(
  command: ExecutableV3SavedWorkflowCommand,
  deps: {
    canPublishGlobal(): boolean;
    consumeMessageQuotaOnce(): Promise<boolean>;
  },
): Promise<V3SavedWorkflowPolicyResult> {
  if (command.kind === 'save' && command.global && !deps.canPublishGlobal()) {
    return { ok: false, reason: 'global_requires_operate' };
  }
  if (command.kind === 'cancel') return { ok: true };
  if (!await deps.consumeMessageQuotaOnce()) return { ok: false, reason: 'quota_denied' };
  return { ok: true };
}

export interface V3SavedWorkflowExecutionInput {
  command: ExecutableV3SavedWorkflowCommand;
  dataDir: string;
  baseDir: string;
  context: SavedWorkflowActorContext;
  /** Host-authorized operate permission for run-level mutations. Ownership is
   * checked independently against the immutable run binding. */
  operatorCanOperate?: boolean;
}

export interface V3SavedWorkflowExecutionDeps {
  listVisible: typeof listVisibleSavedWorkflows;
  loadVisible: typeof loadVisibleSavedWorkflow;
  resolveOwnedRun: typeof resolveOwnedTerminalRunDir;
  saveRun: typeof saveTerminalRunAsWorkflow;
  instantiate: typeof instantiatePublishedSavedWorkflow;
  loadBots(): BotConfig[];
  persistStartIntent(runId: string, runDir: string): void;
  driveDetached(runId: string): void;
  readRunBinding(runDir: string): RunChatBinding | undefined;
  requestCancel: typeof requestV3RunCancel;
  cancelAndDrive(runId: string, cancelRequestId: string): void;
}

export type V3SavedWorkflowExecutionEffect =
  | 'read_completed'
  | 'save_committed'
  | 'run_started'
  | 'run_materialized_not_started'
  | 'cancel_requested'
  | 'cancel_terminal'
  | 'failed';

export interface V3SavedWorkflowExecutionResult {
  effect: V3SavedWorkflowExecutionEffect;
  message: string;
}

/** Best-effort transport boundary kept outside the business execution try/catch. */
export async function deliverV3SavedWorkflowNotification(
  result: V3SavedWorkflowExecutionResult,
  send: (message: string) => Promise<void>,
  onError: (error: unknown, effect: V3SavedWorkflowExecutionEffect) => void,
): Promise<void> {
  try {
    await send(result.message);
  } catch (err) {
    onError(err, result.effect);
  }
}

function formatExecutionError(command: ExecutableV3SavedWorkflowCommand, err: unknown): string {
  const errorText = err instanceof Error ? err.message : String(err);
  const matches = (err as { matches?: Array<{ displayName: string; workflowId: string }> }).matches;
  const candidates = matches?.length
    ? `\n候选：\n${matches.map((item) => `- ${item.displayName} — ${item.workflowId}`).join('\n')}`
    : '';
  const runHint = command.kind === 'run' ? `\n${v3SavedWorkflowAdHocRunEscapeHint()}` : '';
  const unsafeSaveHint = command.kind === 'save' &&
    !command.acknowledgeUnsafeLiterals &&
    /Saved Workflow lint requires confirmation|acknowledgeUnsafeLiterals/.test(errorText)
    ? '\n若提示包含疑似 secret 或本机绝对路径，请先审查/脱敏；确认安全后在原命令末尾加 `--ack-unsafe` 重试。'
    : '';
  return `❌ Saved Workflow 命令失败：${errorText}${candidates}${runHint}${unsafeSaveHint}`;
}

export async function executeV3SavedWorkflowCommand(
  input: V3SavedWorkflowExecutionInput,
  deps: V3SavedWorkflowExecutionDeps,
): Promise<V3SavedWorkflowExecutionResult> {
  const { command, dataDir, baseDir, context } = input;
  try {
    if (command.kind === 'list') {
      const listed = await deps.listVisible({ dataDir, context });
      const lines = listed.entries.length === 0
        ? ['还没有 Saved Workflow。成功跑完后发 `/workflow save last [名称]` 即可固化。']
        : listed.entries.map((entry) =>
            `- ${entry.displayName} — \`${entry.workflowId}\` · ${savedWorkflowScopeLabel(entry.scope)} · ${entry.status}`,
          );
      return { effect: 'read_completed', message: lines.join('\n') };
    }

    if (command.kind === 'show') {
      const loaded = await deps.loadVisible({ dataDir, ref: command.ref, context });
      const metadata = loaded.metadata;
      const params = Object.keys(loaded.revision.payload.inputs);
      return {
        effect: 'read_completed',
        message: [
          `Saved Workflow：${metadata.displayName}`,
          `workflowId: ${metadata.workflowId}`,
          `scope: ${savedWorkflowScopeLabel(metadata.scope)}`,
          `status: ${metadata.status}`,
          `revision: v${loaded.revision.payload.humanVersion} (${loaded.revision.revisionId})`,
          `params: ${params.length > 0 ? params.join(', ') : '(无)'}`,
        ].join('\n'),
      };
    }

    if (command.kind === 'cancel') {
      const runDir = safeRunDir(baseDir, command.runId);
      const binding = deps.readRunBinding(runDir);
      if (!binding) {
        throw new Error(
          '该 v3 run 不存在、完整性校验失败，或没有可验证的聊天绑定。' +
          `若 \`${command.runId}\` 是 v2 run，它已不可变；请查看离线静态归档。`,
        );
      }
      if (binding.larkAppId !== context.actor.larkAppId || binding.chatId !== context.chatId) {
        throw new Error('该 v3 run 不属于当前群或当前机器人');
      }
      const isOwner = binding.ownerOpenId === context.actor.openId;
      if (!isOwner && !input.operatorCanOperate) {
        throw new Error('只有 run owner 或本群可操作成员才能取消该 v3 run');
      }

      const outcome = deps.requestCancel(baseDir, command.runId, {
        by: context.actor.openId,
        reason: 'cancelled via /workflow cancel',
      });
      if (outcome.kind === 'stale-run') {
        throw new Error('该 v3 run 不存在或已清理');
      }
      if (outcome.kind === 'already-terminal') {
        return {
          effect: 'cancel_terminal',
          message: `ℹ️ v3 workflow \`${command.runId}\` 已是终态（${outcome.status}），未写入取消请求。`,
        };
      }
      if (outcome.kind === 'already-cancelled') {
        return {
          effect: 'cancel_terminal',
          message: `⏹️ v3 workflow \`${command.runId}\` 已取消。`,
        };
      }

      let wakeWarning = '';
      try {
        // Both first and repeated requests wake the runner: this repairs the
        // durable-intent -> process-crash window without creating a new intent.
        deps.cancelAndDrive(command.runId, outcome.cancelRequestId);
      } catch {
        // The journal intent is already durable. Never report a false failure
        // that would encourage repeated mutation; cold attach will converge it.
        wakeWarning = '\n⚠️ 即时中断信号未送达；取消意图已落盘，daemon 恢复后会继续收敛。';
      }
      return {
        effect: 'cancel_requested',
        message:
          `${outcome.kind === 'already-requested' ? '⏳ 取消请求已存在' : '⏹️ 已提交取消请求'}：` +
          `\`${command.runId}\`\nstatus: cancelling${wakeWarning}`,
      };
    }

    if (command.kind === 'save') {
      if (command.distill) {
        throw new Error('参数蒸馏必须由飞书提案审批链处理，不能回退为普通精确保存');
      }
      const runDir = await deps.resolveOwnedRun({ baseDir, source: command.source, context });
      const result = await deps.saveRun({
        dataDir,
        runDir,
        context,
        ...(command.displayName ? { displayName: command.displayName } : {}),
        scope: command.global ? 'global' : 'chat',
        acknowledgeUnsafeLiterals: command.acknowledgeUnsafeLiterals,
      });
      return {
        effect: 'save_committed',
        message: [
          `✅ 已固化 Saved Workflow：${result.metadata.displayName}`,
          `workflowId: ${result.metadata.workflowId}`,
          `revision: v${result.revision.payload.humanVersion} (${result.revision.revisionId})`,
          `scope: ${savedWorkflowScopeLabel(result.metadata.scope)}`,
          `status: ${result.metadata.status}`,
        ].join('\n'),
      };
    }

    const rawParams = Object.create(null) as Record<string, RawParamInput>;
    for (const [name, value] of Object.entries(command.rawParams)) {
      rawParams[name] = { kind: 'string', value };
    }
    const materialized = await deps.instantiate({
      dataDir,
      ref: command.ref,
      context,
      rawParams,
      bots: deps.loadBots(),
      baseDir,
    });
    try {
      deps.persistStartIntent(materialized.runId, materialized.runDir);
      deps.driveDetached(materialized.runId);
    } catch (err) {
      return {
        effect: 'run_materialized_not_started',
        message:
          `⚠️ Saved Workflow 已物化但未启动：${materialized.runId}\n` +
          `原因：${err instanceof Error ? err.message : String(err)}\n` +
          `修复后可执行 botmux workflow start ${materialized.runId}，不要重复创建。`,
      };
    }
    return {
      effect: 'run_started',
      message:
        `✅ Saved Workflow 已启动：${materialized.runId}\n` +
        `definition: ${materialized.envelope.source.workflowId} v${materialized.envelope.source.humanVersion}`,
    };
  } catch (err) {
    return { effect: 'failed', message: formatExecutionError(command, err) };
  }
}

export const defaultV3SavedWorkflowExecutionServices = {
  listVisible: listVisibleSavedWorkflows,
  loadVisible: loadVisibleSavedWorkflow,
  resolveOwnedRun: resolveOwnedTerminalRunDir,
  saveRun: saveTerminalRunAsWorkflow,
  instantiate: instantiatePublishedSavedWorkflow,
  readRunBinding: readV3RunChatBinding,
  requestCancel: requestV3RunCancel,
} satisfies Pick<
  V3SavedWorkflowExecutionDeps,
  | 'listVisible'
  | 'loadVisible'
  | 'resolveOwnedRun'
  | 'saveRun'
  | 'instantiate'
  | 'readRunBinding'
  | 'requestCancel'
>;
