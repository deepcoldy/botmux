/**
 * Shared workflow trigger — used by the dashboard catalog `POST .../run`
 * route on the daemon side.  Wraps the load/coerce/createRun/drive sequence
 * with injectable deps so the orchestration can be unit-tested without the
 * full daemon process.
 *
 * IM `/workflow run` still goes through `executeWorkflowCommand`; this helper
 * is the dashboard-trigger path that consumes pre-decoded JSON params and
 * fires the workflow loop in the background.
 */

import { coerceWorkflowParams, ParamCoerceFailure, type RawParamInput } from './params.js';
import { EventLog } from './events/append.js';
import { loadWorkflowDefinition as defaultLoadWorkflowDefinition } from './loader.js';
import { mintWorkflowRunId } from './run-id.js';
import { createRun, type BotResolver } from './run-init.js';
import { replay } from './events/replay.js';
import { getRunsDir } from './runs-dir.js';
import type { WorkflowDefinition } from './definition.js';
import type { WorkflowRuntimeContext, WorkerSpawnFn } from './runtime.js';

export type TriggerInput = {
  workflowId: string;
  rawParams: Record<string, RawParamInput>;
  chatBinding: { chatId: string; larkAppId: string };
  initiator: string;
};

export type TriggerDeps = {
  spawnSubagent: WorkerSpawnFn;
  botResolver: BotResolver;
  /** Build the ctx scaffolding (hostExecutors, reconcilers, loadEffectInput). */
  makeRuntimeContext: (
    log: EventLog,
    def: WorkflowDefinition,
    spawnSubagent: WorkerSpawnFn,
  ) => WorkflowRuntimeContext;
  /** Daemon side registers the ctx so future cancel/approve can find it. */
  attachRuntime: (runId: string, ctx: WorkflowRuntimeContext) => { ready?: Promise<unknown> };
  /** Fire-and-forget loop drive — daemon owns the actual scheduling. */
  driveRun: (runId: string) => void;
  /** Test seam: override the file lookup. */
  loadWorkflowDefinition?: (workflowId: string) => Promise<WorkflowDefinition>;
  /** Test seam: deterministic run id. */
  makeRunId?: (def: WorkflowDefinition) => string;
  /** Test seam: explicit runs dir override. */
  makeEventLog?: (runId: string) => EventLog;
};

export type TriggerSuccess = {
  ok: true;
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
};

export type TriggerFailure =
  | {
      ok: false;
      error: 'unknown_workflow';
      message: string;
    }
  | {
      ok: false;
      error: 'invalid_params';
      message: string;
      issues: Array<{ path: string[]; code: string; message: string }>;
    }
  | {
      ok: false;
      error: 'load_definition_failed' | 'internal_error';
      message: string;
    };

export type TriggerResult = TriggerSuccess | TriggerFailure;

export async function triggerWorkflowRun(
  input: TriggerInput,
  deps: TriggerDeps,
): Promise<TriggerResult> {
  const loadDef = deps.loadWorkflowDefinition ?? defaultLoadWorkflowDefinition;
  let def: WorkflowDefinition;
  try {
    def = await loadDef(input.workflowId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(`Workflow '${input.workflowId}' not found`)) {
      return { ok: false, error: 'unknown_workflow', message };
    }
    return { ok: false, error: 'load_definition_failed', message };
  }

  let coerced: Record<string, unknown>;
  try {
    coerced = coerceWorkflowParams(def, input.rawParams);
  } catch (err) {
    if (err instanceof ParamCoerceFailure) {
      return {
        ok: false,
        error: 'invalid_params',
        message: err.message,
        issues: err.issues.map((i) => ({
          path: i.name ? [i.name] : [],
          code: i.code,
          message: i.message,
        })),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'internal_error', message };
  }

  try {
    const runId = (deps.makeRunId ?? ((d) => mintWorkflowRunId(d.workflowId, Date.now())))(def);
    const log = deps.makeEventLog ? deps.makeEventLog(runId) : new EventLog(runId, getRunsDir());
    const ctx = deps.makeRuntimeContext(log, def, deps.spawnSubagent);
    await createRun(log, {
      def,
      params: coerced,
      initiator: input.initiator,
      botResolver: deps.botResolver,
      chatBinding: input.chatBinding,
    });
    const watcher = deps.attachRuntime(runId, ctx);
    if (watcher.ready) {
      try {
        await watcher.ready;
      } catch {
        // watcher start failures are logged by the daemon; the run is still
        // valid and will keep producing events the watcher can re-pick on
        // restart, so don't abort the trigger here.
      }
    }
    deps.driveRun(runId);
    const snapshot = replay(await log.readAll());
    return {
      ok: true,
      runId,
      workflowId: def.workflowId,
      status: snapshot.run.status,
      lastSeq: snapshot.lastSeq,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'internal_error', message };
  }
}
