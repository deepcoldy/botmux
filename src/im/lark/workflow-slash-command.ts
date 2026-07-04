import { loadBotConfigs, getAllBots } from '../../bot-registry.js';
import { EventLog } from '../../workflows/events/append.js';
import { loadWorkflowDefinition } from '../../workflows/loader.js';
import { getRunsDir } from '../../workflows/runs-dir.js';
import { mintWorkflowRunId } from '../../workflows/run-id.js';
import { createRun, type BotResolver } from '../../workflows/run-init.js';
import { runLoop, type RunLoopResult } from '../../workflows/loop.js';
import { createStubSpawnFn } from '../../workflows/spawn-bot.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../../workflows/hostExecutors/registry.js';
import { loadEffectInputSidecar } from '../../workflows/effect-input.js';
import type { WorkflowDefinition } from '../../workflows/definition.js';
import { coerceWorkflowParamsFromStrings as coerceWorkflowParams } from '../../workflows/params.js';
// Re-export from the shared params module so existing IM tests + callers keep
// the same import path. New code should pull from `src/workflows/params.ts`.
export { coerceWorkflowParams };
import type { BotSnapshot } from '../../workflows/events/payloads.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from '../../workflows/runtime.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';

// v3 即兴 grill 引擎占用 /workflow 主语义。
export const WORKFLOW_USAGE =
  '用法：/workflow new <目标>（或直接 /workflow <目标>）——我会先拷问澄清需求，再自动编排成流程跑完。\n跑已存好的模板用 /template run <id>。';
// 旧 /workflow run|cancel 软降级：仍能跑，但提示已改名（迁移期友好，不直接断老用户）。
export const WORKFLOW_V2_RENAME_NOTICE =
  '⚠️ /workflow run|cancel 已改名为 /template run|cancel（/workflow 现用于即兴 workflow）。本次仍照旧执行，请尽快改用 /template。';
// v2「跑已存模板」引擎命令（/template run|cancel）出错时回显的用法（i18n，已随 C 方案改名）。
function workflowUsage(locale?: Locale): string {
  return t('card.wf.usage', undefined, locale);
}
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type WorkflowCommand =
  | { kind: 'run'; workflowId: string; rawParams: Record<string, string> }
  | { kind: 'cancel'; runId: string }
  | { kind: 'invalid'; error: string; usage: string };

/** v3 grill 触发结果（仅 `/workflow` 命名空间，不含 run/cancel 那套 v2 子命令）。
 *  `goal` = 用户描述的模糊目标，daemon 会转成触发 botmux-workflow skill 的 prompt。 */
export type WorkflowGrillTrigger =
  | { kind: 'goal'; goal: string }
  | { kind: 'usage' };

export type WorkflowRunCreatedInfo = {
  runId: string;
  workflowId: string;
  params: Record<string, unknown>;
  ctx: WorkflowRuntimeContext;
};

export type WorkflowCommandResult =
  | { handled: false }
  | { handled: true; ok: false; error: string; usage?: string }
  | {
      handled: true;
      ok: true;
      command: 'run';
      runId: string;
      workflowId: string;
      params: Record<string, unknown>;
      loopResult: RunLoopResult;
    }
  | {
      handled: true;
      ok: true;
      command: 'cancel';
      runId: string;
      status: string;
      alreadyTerminal: boolean;
      pending?: boolean;
      cancelEventId?: string;
      lastSeq: number;
    };

export type WorkflowCommandDeps = {
  loadWorkflowDefinitionFn?: (workflowId: string) => Promise<WorkflowDefinition>;
  makeRunId?: (workflowId: string) => string;
  makeEventLog?: (runId: string) => EventLog;
  createRunFn?: typeof createRun;
  botResolver?: BotResolver;
  spawnSubagent?: WorkerSpawnFn;
  attachWorkflowEventWatcher?: (runId: string, ctx: WorkflowRuntimeContext) => { ready?: Promise<unknown> };
  runLoopFn?: (ctx: WorkflowRuntimeContext) => Promise<RunLoopResult>;
  cancelWorkflowRunFn?: (runId: string, reason: string, opts?: {
    expectedChatId?: string;
    by?: string;
  }) => Promise<{
    ok: true;
    runId: string;
    status: string;
    alreadyTerminal: boolean;
    pending?: boolean;
    cancelEventId?: string;
    lastSeq: number;
  } | {
    ok: false;
    error: string;
    status?: string;
  }>;
  onRunCreated?: (info: WorkflowRunCreatedInfo) => Promise<void> | void;
};

export type ExecuteWorkflowCommandInput = {
  content: string;
  chatId: string;
  larkAppId: string;
  initiator: string;
};

/**
 * Parse the v3 grill trigger on the `/workflow` namespace.
 *
 *  - `/workflow new <目标>` / 裸 `/workflow <目标>` → `{ kind:'goal', goal }`
 *  - `/workflow`（无目标）→ `{ kind:'usage' }`
 *  - `/workflow run|cancel …` → `null`（那是 v2 模板的 legacy 入口，交给
 *    `parseWorkflowCommand` 处理；这里刻意不吞）
 *  - 非 `/workflow` → `null`
 *
 * 注意 word-boundary：`/workflowfoo` 不匹配（避免误吞别的命令）。
 */
export function parseWorkflowGrillTrigger(content: string): WorkflowGrillTrigger | null {
  const trimmed = content.trim();
  const m = /^\/workflow(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const tail = (m[1] ?? '').trim();
  if (!tail) return { kind: 'usage' };
  const firstTok = tail.split(/\s+/)[0];
  // run/cancel 归 v2（legacy），不当作 grill 目标。
  if (firstTok === 'run' || firstTok === 'cancel') return null;
  // 显式 `new` 前缀可选：剥掉后剩下的就是目标；否则整段 tail 即目标。
  const goal = firstTok === 'new' ? tail.slice(firstTok.length).trim() : tail;
  if (!goal) return { kind: 'usage' };
  return { kind: 'goal', goal };
}

/**
 * 把用户 `/workflow new <目标>` 的目标包成一条触发 `botmux-workflow` skill 的
 * prompt。daemon 用它改写消息内容后 fall-through 到正常 session 创建，让本话题
 * 的 agent 接管整条 grill→编排→执行链路（daemon 自己不会拷问）。
 */
export function buildWorkflowGrillPrompt(goal: string): string {
  return [
    '[/workflow new] 用户通过 `/workflow new` 显式发起了一个即兴 workflow。',
    '请使用 `botmux-workflow` skill 处理下面这个目标：直接进入 grill（用户已显式发起，"确认意图"那步可省略），',
    '在当前飞书话题里一问一答澄清需求，然后自动编排成 DAG 流程并跑完。',
    '',
    `目标：${goal}`,
  ].join('\n');
}

export function parseWorkflowCommand(content: string, locale?: Locale): WorkflowCommand | null {
  const trimmed = content.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  // v2 模板主入口 = /template；/workflow 仅保留 run|cancel 作 legacy 软降级
  // （其余 /workflow 子命令是 v3 grill，由 parseWorkflowGrillTrigger 处理）。
  const isTemplate = cmd === '/template';
  const isLegacyWorkflow = cmd === '/workflow';
  if (!isTemplate && !isLegacyWorkflow) return null;
  const sub = parts[1];
  // /workflow 仅 run|cancel 作 legacy（其余 /workflow 子命令是 v3 grill）。legacy 与
  // /template 解析结果相同——legacy 的「改名提示」由 daemon 从原始 content 判定，
  // 这里不需要再带标记（单一检测来源，避免双重机制）。
  if (isLegacyWorkflow && sub !== 'run' && sub !== 'cancel') return null;

  if (sub === 'cancel') {
    const runId = parts[2];
    if (!runId) return invalid(t('wf.err.missing_run_id', undefined, locale), locale);
    if (parts.length > 3) return invalid(t('wf.err.cancel_only_run_id', undefined, locale), locale);
    if (!WORKFLOW_ID_PATTERN.test(runId)) {
      return invalid(t('wf.err.run_id_charset', undefined, locale), locale);
    }
    return { kind: 'cancel', runId };
  }
  if (sub !== 'run') {
    return invalid(t('wf.err.unknown_subcommand', undefined, locale), locale);
  }

  const workflowId = parts[2];
  if (!workflowId) return invalid(t('wf.err.missing_workflow_id', undefined, locale), locale);
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    return invalid(t('wf.err.workflow_id_charset', undefined, locale), locale);
  }

  const rawParams: Record<string, string> = {};
  for (const token of parts.slice(3)) {
    const eq = token.indexOf('=');
    if (eq <= 0) return invalid(t('wf.err.param_format', { token }, locale), locale);
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!WORKFLOW_ID_PATTERN.test(key)) {
      return invalid(t('wf.err.param_name_charset', { key }, locale), locale);
    }
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      return invalid(t('wf.err.duplicate_param', { key }, locale), locale);
    }
    rawParams[key] = value;
  }

  return { kind: 'run', workflowId, rawParams };
}


export async function executeWorkflowCommand(
  input: ExecuteWorkflowCommandInput,
  deps: WorkflowCommandDeps = {},
): Promise<WorkflowCommandResult> {
  const locale = localeForBot(input.larkAppId);
  const command = parseWorkflowCommand(input.content, locale);
  if (!command) return { handled: false };
  if (command.kind === 'invalid') {
    return { handled: true, ok: false, error: command.error, usage: command.usage };
  }
  if (command.kind === 'cancel') {
    if (!deps.cancelWorkflowRunFn) {
      return {
        handled: true,
        ok: false,
        error: '/template cancel requires daemon runtime context',
        usage: workflowUsage(locale),
      };
    }
    const result = await deps.cancelWorkflowRunFn(
      command.runId,
      'cancelled via /template cancel',
      { expectedChatId: input.chatId, by: input.initiator },
    );
    if (!result.ok) {
      return { handled: true, ok: false, error: formatCancelError(result.error), usage: workflowUsage(locale) };
    }
    return {
      handled: true,
      ok: true,
      command: 'cancel',
      runId: result.runId,
      status: result.status,
      alreadyTerminal: result.alreadyTerminal,
      pending: result.pending,
      cancelEventId: result.cancelEventId,
      lastSeq: result.lastSeq,
    };
  }

  try {
    const loadDefinition = deps.loadWorkflowDefinitionFn ?? loadWorkflowDefinition;
    const def = await loadDefinition(command.workflowId);
    const params = coerceWorkflowParams(def, command.rawParams);
    const runId = (deps.makeRunId ?? createWorkflowRunId)(def.workflowId);
    const log = deps.makeEventLog ? deps.makeEventLog(runId) : new EventLog(runId, getRunsDir());
    const botResolver = deps.botResolver ?? resolveBotSnapshot;
    const create = deps.createRunFn ?? createRun;
    const spawnSubagent = deps.spawnSubagent ?? defaultStubSpawn;
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent,
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (activityId, attemptId) =>
        loadEffectInputSidecar(log, activityId, attemptId),
    };

    await create(log, {
      def,
      params,
      initiator: input.initiator,
      botResolver,
      chatBinding: { chatId: input.chatId, larkAppId: input.larkAppId },
    });

    const watcher = deps.attachWorkflowEventWatcher?.(runId, ctx);
    if (watcher?.ready) await watcher.ready;
    await deps.onRunCreated?.({ runId, workflowId: def.workflowId, params, ctx });

    const loopResult = await (deps.runLoopFn ?? runLoop)(ctx);
    return {
      handled: true,
      ok: true,
      command: 'run',
      runId,
      workflowId: def.workflowId,
      params,
      loopResult,
    };
  } catch (err) {
    return {
      handled: true,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usage: workflowUsage(locale),
    };
  }
}

export function createWorkflowRunId(workflowId: string, nowMs = Date.now()): string {
  return mintWorkflowRunId(workflowId, nowMs);
}

export function resolveBotSnapshot(botName: string): BotSnapshot | undefined {
  const registered = getAllBots().find((bot) =>
    botMatches(bot.config.name, botName) ||
    botMatches(bot.botName, botName) ||
    botMatches(bot.config.larkAppId, botName)
  );
  if (registered) return snapshotFromConfig(botName, registered.config);

  try {
    const cfg = loadBotConfigs().find((bot) => botMatches(bot.name, botName) || botMatches(bot.larkAppId, botName));
    return cfg ? snapshotFromConfig(botName, cfg) : undefined;
  } catch {
    return undefined;
  }
}

function invalid(error: string, locale?: Locale): WorkflowCommand {
  return { kind: 'invalid', error, usage: workflowUsage(locale) };
}

function formatCancelError(error: string): string {
  if (error === 'wrong_chat') return 'this run belongs to a different chat';
  return error;
}

function botMatches(value: string | undefined, botName: string): boolean {
  return value === botName;
}

function snapshotFromConfig(
  requestedName: string,
  cfg: {
    larkAppId: string;
    cliId: string;
    name?: string;
    workingDir?: string;
    cliPathOverride?: string;
  },
): BotSnapshot {
  return {
    larkAppId: cfg.larkAppId,
    cliId: cfg.cliId,
    displayName: cfg.name ?? requestedName,
    ...(cfg.workingDir ? { workingDir: cfg.workingDir } : {}),
    ...(cfg.cliPathOverride ? { cliPathOverride: cfg.cliPathOverride } : {}),
  };
}

const defaultStubSpawn = createStubSpawnFn(async (input) => ({
  workflowStub: true,
  bot: input.botName,
  runId: input.runId,
  nodeId: input.nodeId,
  prompt: input.prompt,
}));
