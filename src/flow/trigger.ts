/**
 * 外部触发 → flow run（webhook 接入点 / `POST /api/trigger` 的 `target.kind: 'flow'`）。
 *
 * 与 turn 触发（`core/trigger-session.ts`）共用同一条前置链路：connector 校验、限流、幂等、
 * 目标群解析都在 dashboard 侧做完；这里只负责在 daemon 内把一条已校验的 TriggerRequest
 * 变成一个绑定话题的 run：
 *   1. 目标必须是本 bot 在群里的真实聊天（没有 http_wait_* 虚拟会话可退）；
 *   2. 在群里发一条话题种子消息拿 rootId（或复用请求指定的 rootMessageId）；
 *   3. 事件体作为脚本的 `input`（结构与 turn 的 `<botmux_external_event>` 一致，但不做 prompt
 *      包装——脚本作者自己决定怎么把 `input.envelope` 拼进 agent prompt，那部分是不可信数据）；
 *   4. `waitForFinalOutput` 时等 run 到终局，把脚本返回值原样带回。
 *
 * 没有真人触发者：binding.triggeredBy 记 `webhook:<connectorId>`，ownerOpenId 为 null（agent
 * 子进程按 ownerless 处理，两个 owner env 都删除）。卡片按钮的权限仍只看绑定群的 canOperate。
 */
import { randomUUID } from 'node:crypto';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { FlowFinishOutcome } from './daemon-manager.js';
import type { RunBinding, RunLimits } from './types.js';

export interface FlowTriggerManager {
  launch(req: { script: string; input: unknown; binding: RunBinding; limits?: Partial<RunLimits> }): Promise<{ ok: true; runId: string; runDir: string } | { ok: false; error: string }>;
  waitForFinish(runId: string, timeoutMs: number): Promise<FlowFinishOutcome | null>;
}

export interface FlowTriggerDeps {
  larkAppId: string;
  manager: FlowTriggerManager;
  /** bot 没有飞书传输（core-only）：flow 的卡片无处可放，拒绝。 */
  apiOnly(): boolean;
  /** bot 开了文件沙箱：脚本宿主进沙箱是 M3，先拒绝（与 `/flow run` 对沙箱会话的处理一致）。 */
  sandboxed(): boolean;
  isInChat(chatId: string): Promise<boolean>;
  /** 校验请求指定的 rootMessageId 属于哪个群；不可见返回 null。 */
  messageChatId(messageId: string): Promise<string | null>;
  /** 群里发话题种子文本消息，返回 message id（话题群会因此开一个新话题）。 */
  sendTopicSeed(chatId: string, text: string): Promise<string>;
  /** 起 run 失败时在话题里留一条说明（best-effort）。 */
  notify(anchor: string, text: string): Promise<void>;
  resolveWorkingDir(chatId: string): { ok: true; workingDir: string } | { ok: false; error: string };
  /** connector 配置的话题种子（`presentation.topicMessage`）；null = 明确不要种子。 */
  topicMessage(req: TriggerRequest): string | null;
  newTriggerId?: () => string;
  /** `waitForFinalOutput` 未指定 timeoutMs 时的默认等待。 */
  defaultWaitMs?: number;
}

export const FLOW_TRIGGER_DEFAULT_WAIT_MS = 120_000;

/** 脚本拿到的 `input`：与 turn 触发渲染给模型的事件 JSON 同构，便于同一份事件在两种目标间迁移。 */
export function buildFlowTriggerInput(req: TriggerRequest, triggerId: string): Record<string, unknown> {
  return {
    triggerId,
    source: req.source,
    envelope: req.envelope,
    ...(req.instruction?.trim() ? { instruction: req.instruction.trim() } : {}),
  };
}

export async function triggerFlowRun(req: TriggerRequest, deps: FlowTriggerDeps): Promise<TriggerResponse> {
  const triggerId = deps.newTriggerId?.() ?? `trg_${randomUUID()}`;
  const larkAppId = deps.larkAppId;
  if (req.target.botId && req.target.botId !== larkAppId) {
    return { ok: false, triggerId, errorCode: 'bot_not_found', error: 'request routed to the wrong daemon' };
  }
  if (req.target.kind !== 'flow') {
    return { ok: false, triggerId, errorCode: 'bad_request', error: 'triggerFlowRun only handles flow targets' };
  }
  const script = typeof req.target.script === 'string' ? req.target.script.trim() : '';
  if (!script) {
    return { ok: false, triggerId, errorCode: 'target_required', error: 'flow target requires script' };
  }
  if (deps.apiOnly()) {
    return { ok: false, triggerId, errorCode: 'bad_request', error: 'apiOnly bot has no Feishu transport; flow cards need a real chat' };
  }
  if (deps.sandboxed()) {
    return { ok: false, triggerId, errorCode: 'bad_request', error: 'flow triggers are not supported on a sandboxed bot yet' };
  }

  // ── 目标群与话题锚点 ────────────────────────────────────────────────────────
  const rootMessageId = typeof req.target.rootMessageId === 'string' && req.target.rootMessageId.trim() ? req.target.rootMessageId.trim() : undefined;
  let chatId = typeof req.target.chatId === 'string' && req.target.chatId.trim() ? req.target.chatId.trim() : undefined;
  if (rootMessageId) {
    const actual = await deps.messageChatId(rootMessageId);
    if (!actual) {
      return { ok: false, triggerId, errorCode: 'target_required', error: `rootMessageId is not visible or has no chat_id: ${rootMessageId}` };
    }
    if (chatId && actual !== chatId) {
      return { ok: false, triggerId, errorCode: 'chat_not_allowed', error: 'rootMessageId does not belong to target chatId' };
    }
    chatId = actual;
  }
  if (!chatId) {
    return { ok: false, triggerId, errorCode: 'target_required', error: 'flow target requires chatId or rootMessageId' };
  }
  if (!(await deps.isInChat(chatId))) {
    return { ok: false, triggerId, errorCode: 'bot_not_in_chat', error: `bot ${larkAppId} is not in chat ${chatId}` };
  }
  const wd = deps.resolveWorkingDir(chatId);
  if (!wd.ok) {
    return { ok: false, triggerId, errorCode: 'trigger_failed', error: wd.error };
  }
  const topicMessage = deps.topicMessage(req);
  const target = { kind: 'flow' as const, chatId, ...(rootMessageId ? { rootMessageId } : {}) };

  if (req.options?.dryRun) {
    return {
      ok: true,
      triggerId,
      action: 'dry_run',
      target,
      message: rootMessageId
        ? `would launch ${script} in ${wd.workingDir}, cards in topic ${rootMessageId}`
        : `would launch ${script} in ${wd.workingDir}, opening a topic in ${chatId}`,
    };
  }

  // 种子消息 = 话题根。connector 明确关掉种子（topicMessage null）时卡片平铺在群里（rootId = chatId，
  // sessionReply 对 oc_ 锚点走群发）。
  let rootId: string;
  if (rootMessageId) {
    rootId = rootMessageId;
  } else if (topicMessage === null) {
    rootId = chatId;
  } else {
    try {
      rootId = await deps.sendTopicSeed(chatId, `${topicMessage}\nflow: ${script}`);
    } catch (err) {
      return { ok: false, triggerId, errorCode: 'trigger_failed', error: `topic seed failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const binding: RunBinding = {
    larkAppId,
    chatId,
    rootId,
    sessionId: null,
    ownerOpenId: null,
    triggeredBy: `webhook:${req.source.connectorId ?? req.source.type}`,
    workingDir: wd.workingDir,
    trigger: { kind: 'webhook', connectorId: req.source.connectorId ?? null, triggerId, source: req.envelope.sourceName },
  };
  const launched = await deps.manager.launch({ script, input: buildFlowTriggerInput(req, triggerId), binding });
  if (!launched.ok) {
    await deps.notify(rootId, `❌ 外部事件触发 flow 失败：${launched.error}`).catch(() => undefined);
    return { ok: false, triggerId, errorCode: 'trigger_failed', error: launched.error, target: { ...target, rootMessageId: rootId } };
  }
  const runTarget = { ...target, flowRunId: launched.runId, rootMessageId: rootId };

  if (!req.options?.waitForFinalOutput) {
    return {
      ok: true,
      triggerId,
      action: 'queued',
      target: runTarget,
      message: `flow run ${launched.runId} launched; inspect with botmux flow inspect ${launched.runId}`,
    };
  }

  const timeoutMs = typeof req.options.timeoutMs === 'number' ? req.options.timeoutMs : (deps.defaultWaitMs ?? FLOW_TRIGGER_DEFAULT_WAIT_MS);
  const outcome = await deps.manager.waitForFinish(launched.runId, timeoutMs);
  if (!outcome) {
    return {
      ok: false,
      triggerId,
      errorCode: 'wait_timeout',
      error: `flow run ${launched.runId} still running after ${timeoutMs}ms; inspect with botmux flow inspect ${launched.runId}`,
      target: runTarget,
    };
  }
  if (outcome.kind === 'interrupted') {
    return {
      ok: false,
      triggerId,
      errorCode: 'flow_interrupted',
      error: `flow run ${launched.runId} interrupted (${outcome.reason}); resume with /flow resume ${launched.runId}`,
      target: runTarget,
      flow: { runId: launched.runId, status: 'interrupted', error: { code: 'interrupted', message: outcome.reason } },
    };
  }
  return {
    ok: true,
    triggerId,
    action: 'completed',
    target: runTarget,
    message: `flow run ${launched.runId} ${outcome.status}`,
    output: { content: outcome.returned === undefined ? '' : JSON.stringify(outcome.returned) },
    flow: { runId: launched.runId, status: outcome.status, health: outcome.health, returned: outcome.returned, error: outcome.error },
  };
}
