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

function workflowUsage(locale?: Locale): string {
  return t('card.wf.usage', undefined, locale);
}
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

export function parseWorkflowCommand(content: string, locale?: Locale): WorkflowCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/workflow')) return null;

  const parts = trimmed.split(/\s+/);
  if (parts[0] !== '/workflow') return null;
  const sub = parts[1];
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
        error: '/workflow cancel requires daemon runtime context',
        usage: workflowUsage(locale),
      };
    }
    const result = await deps.cancelWorkflowRunFn(
      command.runId,
      'cancelled via /workflow cancel',
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
