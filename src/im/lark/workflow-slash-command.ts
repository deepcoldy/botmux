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
import type { WorkflowDefinition, ParamDef } from '../../workflows/definition.js';
import type { BotSnapshot } from '../../workflows/events/payloads.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from '../../workflows/runtime.js';

const USAGE = '用法：/workflow run <id> [key=value ...]\n或：/workflow cancel <runId>';
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type WorkflowCommand =
  | { kind: 'run'; workflowId: string; rawParams: Record<string, string> }
  | { kind: 'cancel'; runId: string }
  | { kind: 'invalid'; error: string; usage: string };

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

export function parseWorkflowCommand(content: string): WorkflowCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/workflow')) return null;

  const parts = trimmed.split(/\s+/);
  if (parts[0] !== '/workflow') return null;
  const sub = parts[1];
  if (sub === 'cancel') {
    const runId = parts[2];
    if (!runId) return invalid('缺少 runId');
    if (parts.length > 3) return invalid('/workflow cancel 只接受 runId');
    if (!WORKFLOW_ID_PATTERN.test(runId)) {
      return invalid('runId 只能包含字母、数字、下划线、点和短横线');
    }
    return { kind: 'cancel', runId };
  }
  if (sub !== 'run') {
    return invalid('只支持 /workflow run / cancel 子命令');
  }

  const workflowId = parts[2];
  if (!workflowId) return invalid('缺少 workflow id');
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    return invalid('workflow id 只能包含字母、数字、下划线、点和短横线');
  }

  const rawParams: Record<string, string> = {};
  for (const token of parts.slice(3)) {
    const eq = token.indexOf('=');
    if (eq <= 0) return invalid(`参数必须是 key=value 形式：${token}`);
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!WORKFLOW_ID_PATTERN.test(key)) {
      return invalid(`参数名只能包含字母、数字、下划线、点和短横线：${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      return invalid(`重复参数：${key}`);
    }
    rawParams[key] = value;
  }

  return { kind: 'run', workflowId, rawParams };
}

export function coerceWorkflowParams(
  def: WorkflowDefinition,
  rawParams: Record<string, string>,
): Record<string, unknown> {
  const paramDefs = def.params ?? {};
  for (const key of Object.keys(rawParams)) {
    if (!Object.prototype.hasOwnProperty.call(paramDefs, key)) {
      throw new Error(`未知参数：${key}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(paramDefs)) {
    const hasRaw = Object.prototype.hasOwnProperty.call(rawParams, name);
    if (!hasRaw) {
      if (param.default !== undefined) {
        out[name] = param.default;
        continue;
      }
      if (param.required) throw new Error(`缺少必填参数：${name}`);
      continue;
    }
    out[name] = coerceParam(name, param, rawParams[name]!);
  }
  return out;
}

export async function executeWorkflowCommand(
  input: ExecuteWorkflowCommandInput,
  deps: WorkflowCommandDeps = {},
): Promise<WorkflowCommandResult> {
  const command = parseWorkflowCommand(input.content);
  if (!command) return { handled: false };
  if (command.kind === 'invalid') {
    return { handled: true, ok: false, error: command.error, usage: command.usage };
  }
  if (command.kind === 'cancel') {
    if (!deps.cancelWorkflowRunFn) {
      return {
        handled: true,
        ok: false,
        error: '/workflow cancel requires daemon runtime context',
        usage: USAGE,
      };
    }
    const result = await deps.cancelWorkflowRunFn(
      command.runId,
      'cancelled via /workflow cancel',
      { expectedChatId: input.chatId, by: input.initiator },
    );
    if (!result.ok) {
      return { handled: true, ok: false, error: formatCancelError(result.error), usage: USAGE };
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
      usage: USAGE,
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

function invalid(error: string): WorkflowCommand {
  return { kind: 'invalid', error, usage: USAGE };
}

function formatCancelError(error: string): string {
  if (error === 'wrong_chat') return 'this run belongs to a different chat';
  return error;
}

function coerceParam(name: string, param: ParamDef, raw: string): unknown {
  switch (param.type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是 number`);
      return n;
    }
    case 'boolean':
      return coerceBoolean(name, raw);
    case 'object':
    case 'array':
      throw new Error(`参数 ${name} 的 ${param.type} 类型暂不支持 IM key=value 输入`);
  }
}

function coerceBoolean(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`参数 ${name} 必须是 boolean`);
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
  },
): BotSnapshot {
  return {
    larkAppId: cfg.larkAppId,
    cliId: cfg.cliId,
    displayName: cfg.name ?? requestedName,
    ...(cfg.workingDir ? { workingDir: cfg.workingDir } : {}),
  };
}

const defaultStubSpawn = createStubSpawnFn(async (input) => ({
  workflowStub: true,
  bot: input.botName,
  runId: input.runId,
  nodeId: input.nodeId,
  prompt: input.prompt,
}));
