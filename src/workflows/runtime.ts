/**
 * Workflow runtime — event-writing glue for orchestrator actions.
 *
 * `decideNextActions` in `orchestrator.ts` is pure; this module performs
 * the actual side effects: writes events to the EventLog and (for
 * subagent dispatch) invokes the worker spawn callback.
 *
 * The `WorkerSpawnFn` indirection keeps tests isolated from the real
 * worker / bot-registry / daemon plumbing — Slice D wires the live
 * spawn function; tests pass a fake.
 *
 * Scope (Slice B-1):
 *   - dispatchGate  → writes attemptCreated(gate) + waitCreated
 *   - dispatchWork  → writes attemptCreated(work) + invokes spawn
 *   - completeNode* / completeRun* → terminal node/run writes
 *     (rootCauseEventId resolved from the latest activityFailed event)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { writeEffectInputSidecar } from './effect-input.js';
import { writeBlob, writeJsonBlob } from './blob.js';
import type { WorkflowDefinition } from './definition.js';
import type { EventLog } from './events/append.js';
import {
  BindingError,
  resolveBindings,
  resolveBoundString,
  type BindingContext,
} from './output-binding.js';
import type { BotSnapshot, ErrorClass, ErrorCode, OutputRef } from './events/payloads.js';
import { replay, type Snapshot } from './events/replay.js';
import type {
  ActivityFailedEvent,
  AttemptCreatedEvent,
  LoopFinishedEvent,
  NodeFailedEvent,
  NodeSucceededEvent,
  RunCanceledEvent,
  RunFailedEvent,
  RunSucceededEvent,
  WaitCreatedEvent,
} from './events/types.js';
import {
  parseActivityId,
  type CompleteNodeFailedAction,
  type CompleteNodeSucceededAction,
  type CompleteRunFailedAction,
  type CompleteRunSucceededAction,
  type DispatchGateAction,
  type DispatchWorkAction,
} from './orchestrator.js';
import { createWait } from './wait.js';
import { executeSideEffect } from './hostExecutors/protocol.js';
import type { HostExecutorRegistry, RegisteredHostExecutor } from './hostExecutors/registry.js';
import type { HostExecutorContext } from './hostExecutors/types.js';
import type { ProviderReconciler } from './resume.js';

// ─── Worker spawn contract ────────────────────────────────────────────────

export type WorkerSpawnInput = {
  botName: string;
  /** Snapshot captured at runCreated time — caller may override workingDir etc. */
  botSnapshot?: BotSnapshot;
  prompt: string;
  workingDir?: string;
  modelOverrides?: { model?: string; reasoningEffort?: string };
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** Activity context — useful for the spawner to namespace logs / ports. */
  activityId: string;
  attemptId: string;
  nodeId: string;
  runId: string;
  /** Conventional per-attempt execution log path, used by daemon-backed workers. */
  attemptLogPath?: string;
  /**
   * Cooperative cancel handle (v0.1.4-a).  Daemon-backed workers should
   * listen and initiate graceful shutdown (SIGINT) then escalate
   * (SIGKILL) per policy.  Test-stub spawns can just inspect `aborted`
   * and resolve eagerly to `kind: 'cancelled'`.
   *
   * The abort reason is `AbortCancelReason` carrying the originating
   * `cancelRequested` event id, which the spawn must echo back in
   * `WorkerSpawnResult.kind === 'cancelled'` so dispatchWork can write
   * `activityCanceled.payload.cancelOriginEventId` without re-replaying
   * the log.
   */
  cancelSignal?: AbortSignal;
};

/** Reason payload attached to `AbortController.abort()` for spawn cancel. */
export type AbortCancelReason = { cancelOriginEventId: string };

export type WorkerSessionInfo = {
  sessionId: string;
  /** CLI-native resume id when it differs from botmux's synthetic sessionId. */
  cliSessionId?: string;
  larkAppId?: string;
  botName: string;
  cliId?: string;
  workingDir?: string;
  webPort?: number;
  logPath?: string;
  startedAt: number;
  endedAt?: number;
};

export type WorkerSpawnResult =
  | {
      kind: 'success';
      /** Caller's worker produced this as the final structured output. */
      output: unknown;
      session: WorkerSessionInfo;
    }
  | {
      kind: 'failure';
      errorCode:
        | 'NetworkError'
        | 'WorkerCrashed'
        | 'OutputSchemaViolation'
        | 'InputValidationFailed'
        | 'UnknownProviderError';
      errorClass: ErrorClass;
      errorMessage: string;
      session?: WorkerSessionInfo;
    }
  | {
      /**
       * Cancel-induced terminal (v0.1.4-a).  Returned when the worker
       * observed `cancelSignal.aborted` and shut down (cleanly via SIGINT
       * or escalated via SIGKILL).  `cancelOriginEventId` must echo the
       * value from `AbortCancelReason` so dispatchWork can populate
       * `activityCanceled.payload.cancelOriginEventId` directly.
       */
      kind: 'cancelled';
      cancelOriginEventId: string;
      session?: WorkerSessionInfo;
    };

export type WorkerSpawnFn = (input: WorkerSpawnInput) => Promise<WorkerSpawnResult>;

// ─── Runtime context ──────────────────────────────────────────────────────

export type WorkflowRuntimeContext = {
  log: EventLog;
  def: WorkflowDefinition;
  spawnSubagent: WorkerSpawnFn;
  hostExecutors?: HostExecutorRegistry;
  /**
   * Per-provider reconcilers consulted by `runLoop`'s recovery phase when
   * a snapshot has `danglingEffectAttempted` entries (effectAttempted
   * written but no terminal).  Default factory:
   * `createDefaultProviderReconcilers()`.  When omitted, runLoop refuses
   * to advance past dangling effects (returns `no-progress`).
   */
  reconcilers?: Map<string, ProviderReconciler>;
  /**
   * Materializer for the effect-input sidecar used by `requiresEffectInput`
   * providers (Feishu).  Default in CLI/IM entry points wraps
   * `loadEffectInputSidecar(log, activityId, attemptId)`.
   */
  loadEffectInput?: (activityId: string, attemptId: string) => Promise<unknown>;
  /** Wall-clock source — injectable for deterministic tests. */
  now?: () => number;
  /**
   * v0.1.4-a cancel responsiveness: runLoop publishes its per-tick
   * activityId→AbortController map here so out-of-band callers (e.g.
   * `cancelWorkflowRunOnDaemon`) can fire abort signals immediately
   * without waiting for the EventLog polling fallback to notice the
   * `cancelRequested` event.  Pass `undefined` on tick exit to clear.
   */
  registerAborters?: (aborters: Map<string, AbortController> | undefined) => void;
};

function nowMs(ctx: WorkflowRuntimeContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function gateAttemptId(activityId: string): string {
  return `${activityId}::att-1`;
}

function workAttemptId(activityId: string, attemptNumber: number): string {
  return `${activityId}::att-${attemptNumber}`;
}

/**
 * Resolve the bot identity snapshot captured at runCreated.
 *
 * If caller supplies a Snapshot we read it directly (cheapest).
 * Otherwise we replay the log — slower but always available.  The
 * runtime always passes a snapshot in practice; the fallback exists so
 * tests that don't bother to compute one still get correct behavior.
 */
async function resolveBotSnapshot(
  ctx: WorkflowRuntimeContext,
  botName: string,
  snapshot?: Snapshot,
): Promise<BotSnapshot | undefined> {
  if (snapshot) return snapshot.run.botSnapshots?.[botName];
  const events = await ctx.log.readAll();
  if (events.length === 0) return undefined;
  const first = events[0]!;
  if (first.type !== 'runCreated') return undefined;
  const p = (first as { payload: unknown }).payload;
  if (typeof p !== 'object' || p === null || 'ref' in (p as Record<string, unknown>)) {
    return undefined;
  }
  const snaps = (p as { botSnapshots?: Record<string, BotSnapshot> }).botSnapshots;
  return snaps?.[botName];
}

async function attemptSidecarDir(
  log: EventLog,
  activityId: string,
  attemptId: string,
): Promise<string> {
  const dir = join(log.runDir, 'attempts', activityId, attemptId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeSessionSidecar(
  log: EventLog,
  activityId: string,
  attemptId: string,
  session: WorkerSessionInfo,
): Promise<void> {
  const dir = await attemptSidecarDir(log, activityId, attemptId);
  const file = join(dir, 'session.json');
  await fs.writeFile(file, JSON.stringify(session, null, 2), 'utf-8');
}

function withAttemptLogPath(
  session: WorkerSessionInfo,
  attemptLogPath: string,
): WorkerSessionInfo {
  return session.logPath ? session : { ...session, logPath: attemptLogPath };
}

async function resolveWorkflowIdentity(
  ctx: WorkflowRuntimeContext,
  snapshot?: Snapshot,
): Promise<{ workflowId: string; revisionId: string }> {
  const snap = snapshot ?? replay(await ctx.log.readAll());
  if (!snap.run.workflowId || !snap.run.revisionId) {
    throw new Error(`workflow identity missing for run ${ctx.log.runId}`);
  }
  return { workflowId: snap.run.workflowId, revisionId: snap.run.revisionId };
}

function bindingContext(
  ctx: WorkflowRuntimeContext,
  snapshot: Snapshot,
  activityId?: string,
): BindingContext {
  let paramsPromise: Promise<Record<string, unknown>> | undefined;
  // Loop body nodes need their iteration coordinates surfaced to the
  // binder so `${node.previous.x}` resolves against the prior iteration.
  // Caller dispatch sites (dispatchWork / dispatchHumanGate / hostExecutor
  // path) pass `action.activityId`; parseActivityId picks loop kind and
  // we forward { loopId, iteration }.  Plain activityIds leave
  // loopContext undefined and `.previous.` still fails-loud as designed.
  const parsed = activityId ? parseActivityId(activityId) : undefined;
  const loopContext = parsed?.kind === 'loop'
    ? { loopId: parsed.loopId, iteration: parsed.iteration }
    : undefined;
  return {
    snapshot,
    def: ctx.def,
    log: ctx.log,
    loadParams: () => {
      paramsPromise ??= loadRunParamsFromSnapshot(snapshot);
      return paramsPromise;
    },
    loopContext,
  };
}

async function loadRunParamsFromSnapshot(snapshot: Snapshot): Promise<Record<string, unknown>> {
  const inputPath = snapshot.run.input?.outputPath;
  if (!inputPath) {
    throw new BindingError('run input params missing outputPath');
  }
  const raw = await fs.readFile(inputPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BindingError('run input params blob is not an object');
  }
  return parsed as Record<string, unknown>;
}

async function failHostExecutor(
  ctx: WorkflowRuntimeContext,
  activityId: string,
  attemptId: string,
  error: { errorCode: ErrorCode; errorClass: ErrorClass; errorMessage: string },
): Promise<Extract<DispatchWorkResult, { kind: 'failed' }>> {
  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      error,
    },
  });
  return {
    kind: 'failed',
    attemptId,
    errorClass: error.errorClass,
    errorCode: error.errorCode,
    errorMessage: error.errorMessage,
  };
}

function executeRegisteredHostExecutor<I, O>(
  registered: RegisteredHostExecutor<I, O>,
  hostCtx: HostExecutorContext,
  input: unknown,
) {
  return executeSideEffect(hostCtx, input as I, registered.executor);
}

// ─── dispatchGate ─────────────────────────────────────────────────────────

/**
 * Open a humanGate.stage='before' wait.  Writes:
 *   1. `attemptCreated{nodeId, activityId=gate, attemptId, attemptNumber=1}`
 *      — `inputRef` carries the RAW (pre-binding) humanGate spec so an
 *      operator can still see what the workflow author wrote.
 *   2. Resolve `humanGate.prompt` against the snapshot (output bindings).
 *      Binding failure → `activityFailed{InputBindingFailed/userFault}`,
 *      no waitCreated written.  The orchestrator picks the failure up on
 *      its next tick and emits `completeNodeFailed`.
 *   3. On success: `waitCreated{prompt: <resolved>, ...}`.
 *
 * The caller (Slice C / Slice D) is responsible for actually rendering
 * the approval card to the IM channel after this returns.
 */
export type DispatchGateResult =
  | {
      kind: 'wait';
      attemptId: string;
      attemptCreated: AttemptCreatedEvent;
      waitCreated: WaitCreatedEvent;
    }
  | {
      kind: 'failed';
      attemptId: string;
      attemptCreated: AttemptCreatedEvent;
      activityFailed: ActivityFailedEvent;
    };

export async function dispatchGate(
  ctx: WorkflowRuntimeContext,
  action: DispatchGateAction,
  options: { snapshot?: Snapshot } = {},
): Promise<DispatchGateResult> {
  const attemptId = gateAttemptId(action.activityId);
  const inputRef = await writeJsonBlob(ctx.log, {
    kind: 'human-gate',
    prompt: action.humanGate.prompt,
    approvers: action.humanGate.approvers,
  });

  const attemptCreated = (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      activityId: action.activityId,
      attemptId,
      attemptNumber: 1,
      inputRef,
    },
  })) as AttemptCreatedEvent;

  let resolvedPrompt: string;
  try {
    resolvedPrompt = await resolveBoundString(
      action.humanGate.prompt,
      bindingContext(ctx, options.snapshot ?? replay(await ctx.log.readAll()), action.activityId),
    );
  } catch (err) {
    if (err instanceof BindingError) {
      const activityFailed = await writeBindingFailure(
        ctx,
        action.activityId,
        attemptId,
        err.message,
      );
      return { kind: 'failed', attemptId, attemptCreated, activityFailed };
    }
    throw err;
  }

  const deadlineAt = action.humanGate.deadlineMs
    ? nowMs(ctx) + action.humanGate.deadlineMs
    : undefined;

  const promptField = await splitHumanGatePrompt(ctx, resolvedPrompt);

  const waitCreated = await createWait(ctx.log, {
    activityId: action.activityId,
    attemptId,
    nodeId: action.nodeId,
    waitKind: 'human-gate',
    deadlineAt,
    ...promptField,
    approvers: action.humanGate.approvers,
    onTimeout: action.humanGate.onTimeout,
  });

  return { kind: 'wait', attemptId, attemptCreated, waitCreated };
}

/**
 * Producer-side split for the humanGate prompt: small prompts stay inline
 * on `waitCreated.payload.prompt`; anything over `PROMPT_INLINE_MAX_BYTES`
 * spills to a content-addressed blob and the event carries `promptRef` +
 * a short `promptPreview` for card / dashboard display.
 *
 * The schema accepts arbitrarily long inline prompts for historical
 * compatibility, so this threshold is a runtime policy, not a wire
 * contract.  Cards and dashboards MUST NOT read the blob — they render
 * `promptPreview` only — so the preview is the contract for "what an
 * approver sees" when prompts are large.
 */
async function splitHumanGatePrompt(
  ctx: WorkflowRuntimeContext,
  resolvedPrompt: string,
): Promise<{ prompt: string } | { promptRef: OutputRef; promptPreview: string }> {
  if (Buffer.byteLength(resolvedPrompt, 'utf-8') <= PROMPT_INLINE_MAX_BYTES) {
    return { prompt: resolvedPrompt };
  }
  const buf = Buffer.from(resolvedPrompt, 'utf-8');
  const promptRef = await writeBlob(ctx.log, buf, {
    contentType: 'text/plain',
    schemaVersion: 1,
  });
  return {
    promptRef,
    promptPreview: makePromptPreview(resolvedPrompt),
  };
}

/**
 * Producer policy: inline prompts <= 1 KiB; bigger spills to a blob.
 * Chosen to leave headroom under the 4 KiB inline-event cap for
 * activityId / nodeId / approvers / onTimeout and any future small
 * fields.
 */
export const PROMPT_INLINE_MAX_BYTES = 1024;

/**
 * Build the preview string carried inline on `waitCreated` when the
 * full prompt is in a blob.  Two simultaneous budgets (codex peg 2):
 *   - chars ≤ 500: schema cap from WaitCreatedPayload.promptPreview
 *   - bytes ≤ 800: UTF-8 budget so 500 CJK chars (~1.5 KiB) don't bloat
 *     the envelope past the 4 KiB inline cap
 * Whichever budget hits first wins; a trailing ellipsis flags truncation.
 */
const PROMPT_PREVIEW_MAX_CHARS = 480; // 500 - ellipsis chars, safety
const PROMPT_PREVIEW_MAX_BYTES = 800;
export function makePromptPreview(full: string): string {
  const chars = [...full];
  if (chars.length <= PROMPT_PREVIEW_MAX_CHARS && Buffer.byteLength(full, 'utf-8') <= PROMPT_PREVIEW_MAX_BYTES) {
    return full;
  }
  const ELLIPSIS = '…(完整内容见 dashboard)';
  const charBudget = PROMPT_PREVIEW_MAX_CHARS - [...ELLIPSIS].length;
  const byteBudget = PROMPT_PREVIEW_MAX_BYTES - Buffer.byteLength(ELLIPSIS, 'utf-8');
  let bytes = 0;
  let cut = chars.length;
  for (let i = 0; i < chars.length; i++) {
    if (i >= charBudget) {
      cut = i;
      break;
    }
    bytes += Buffer.byteLength(chars[i]!, 'utf-8');
    if (bytes > byteBudget) {
      cut = i;
      break;
    }
  }
  return chars.slice(0, cut).join('') + ELLIPSIS;
}

async function writeBindingFailure(
  ctx: WorkflowRuntimeContext,
  activityId: string,
  attemptId: string,
  message: string,
): Promise<ActivityFailedEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      error: {
        errorCode: 'InputBindingFailed',
        errorClass: 'userFault',
        errorMessage: truncateRuntimeErrorMessage(message),
      },
    },
  })) as ActivityFailedEvent;
}

// ─── dispatchWork ─────────────────────────────────────────────────────────

export type DispatchWorkResult =
  | { kind: 'succeeded'; attemptId: string; outputRef: OutputRef; session: WorkerSessionInfo }
  | {
      kind: 'failed';
      attemptId: string;
      errorClass: ErrorClass;
      errorCode: string;
      errorMessage: string;
      session?: WorkerSessionInfo;
    }
  | {
      /** Cancel-induced terminal (v0.1.4-a). */
      kind: 'cancelled';
      attemptId: string;
      cancelOriginEventId: string;
      session?: WorkerSessionInfo;
    };

/**
 * Run a work activity end-to-end:
 *   1. write `attemptCreated{work}`
 *   2. for `subagent`: invoke `spawnSubagent`, persist session sidecar,
 *      write `activitySucceeded` or `activityFailed`
 *   3. for `hostExecutor`: v0 placeholder — returns `unsupported` until
 *      Slice E (executor registry) lands.  Caller can decide to surface
 *      this as a manual error or skip the run.
 *
 * The function does not retry — that's resume.ts's job after a terminal
 * `activityFailed` lands.  Orchestrator will see the failed work
 * activity on its next tick and emit `completeNodeFailed`.
 */
export async function dispatchWork(
  ctx: WorkflowRuntimeContext,
  action: DispatchWorkAction,
  options: { attemptNumber?: number; snapshot?: Snapshot; cancelSignal?: AbortSignal } = {},
): Promise<DispatchWorkResult> {
  const attemptNumber = options.attemptNumber ?? 1;
  const attemptId = workAttemptId(action.activityId, attemptNumber);
  const node = action.node;

  const bindingCtx = bindingContext(
    ctx,
    options.snapshot ?? replay(await ctx.log.readAll()),
    action.activityId,
  );

  if (node.type === 'loop' || node.type === 'decision') {
    // v0.2 schema introduced these node types but their dispatch is
    // owned by the loop runtime executor (Step 3 of
    // feat/workflow-loop-v02; see /tmp/wf-loop-v02.md §13).  The
    // orchestrator (`decideNextActions`) skips them so we should never
    // get here in Step 1; throw fail-loud rather than silently no-op so
    // any regression is caught immediately in tests.
    throw new Error(
      `dispatchWork received unexpected node type '${node.type}' for node '${action.nodeId}' ` +
      `(loop runtime not yet wired in Step 1; orchestrator should intercept upstream)`,
    );
  }

  if (node.type === 'hostExecutor') {
    // attemptCreated carries the RAW (pre-binding) input.  Operator-side
    // debug can see the literal `$ref` the author wrote, while the
    // effect-input sidecar (below) holds the resolved+parsed form.
    const inputRef = await writeJsonBlob(ctx.log, {
      kind: 'hostExecutor',
      executor: node.executor,
      input: node.input,
    });
    await ctx.log.append({
      runId: ctx.log.runId,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: action.nodeId,
        activityId: action.activityId,
        attemptId,
        attemptNumber,
        inputRef,
      },
    });

    const registered = ctx.hostExecutors?.get(node.executor);
    if (!registered) {
      return failHostExecutor(ctx, action.activityId, attemptId, {
        errorCode: 'UnknownProviderError',
        errorClass: 'manual',
        errorMessage: `hostExecutor '${node.executor}' is not registered.`,
      });
    }

    let resolvedInput: unknown;
    try {
      resolvedInput = await resolveBindings(node.input, bindingCtx);
    } catch (err) {
      if (err instanceof BindingError) {
        return failHostExecutor(ctx, action.activityId, attemptId, {
          errorCode: 'InputBindingFailed',
          errorClass: 'userFault',
          errorMessage: truncateRuntimeErrorMessage(err.message),
        });
      }
      throw err;
    }

    let parsedInput: unknown;
    try {
      parsedInput = registered.parseInput(resolvedInput);
    } catch (err) {
      return failHostExecutor(ctx, action.activityId, attemptId, {
        errorCode: 'InputValidationFailed',
        errorClass: 'userFault',
        errorMessage: truncateRuntimeErrorMessage(err instanceof Error ? err.message : String(err)),
      });
    }

    await writeEffectInputSidecar(ctx.log, action.activityId, attemptId, parsedInput);
    const identity = await resolveWorkflowIdentity(ctx, options.snapshot);
    const result = await executeRegisteredHostExecutor(
      registered,
      {
        log: ctx.log,
        runId: ctx.log.runId,
        workflowId: identity.workflowId,
        revisionId: identity.revisionId,
        nodeId: action.nodeId,
        activityId: action.activityId,
        attemptId,
      },
      parsedInput,
    );
    if (result.ok) {
      if ('ref' in result.event.payload) {
        throw new Error('hostExecutor activitySucceeded unexpectedly used payload ref');
      }
      return {
        kind: 'succeeded',
        attemptId,
        outputRef: result.event.payload.outputRef,
        session: {
          sessionId: `host-${action.activityId}-${attemptId}`,
          botName: node.executor,
          startedAt: nowMs(ctx),
          endedAt: nowMs(ctx),
        },
      };
    }
    return {
      kind: 'failed',
      attemptId,
      errorClass: result.error.errorClass,
      errorCode: result.error.errorCode,
      errorMessage: result.error.errorMessage,
    };
  }

  // Subagent path: serialize the RAW (pre-binding) prompt as the input
  // blob so audit can see the literal `$ref` the author wrote.  The
  // resolved prompt is what we actually hand to the worker.
  const inputRef = await writeJsonBlob(ctx.log, {
    kind: 'subagent',
    bot: node.bot,
    prompt: node.prompt,
  });

  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      activityId: action.activityId,
      attemptId,
      attemptNumber,
      inputRef,
    },
  });

  let resolvedPrompt: string;
  try {
    resolvedPrompt = await resolveBoundString(node.prompt, bindingCtx);
  } catch (err) {
    if (err instanceof BindingError) {
      const activityFailed = await writeBindingFailure(
        ctx,
        action.activityId,
        attemptId,
        err.message,
      );
      return {
        kind: 'failed',
        attemptId,
        errorClass: 'userFault',
        errorCode: 'InputBindingFailed',
        errorMessage: activityFailed.payload && !('ref' in activityFailed.payload)
          ? activityFailed.payload.error.errorMessage
          : err.message,
      };
    }
    throw err;
  }

  // NB: still skipping `leaseSigned` in v0 — that's tied to the lease-
  // timeout enforcement path (Step 6) which we don't engage when the
  // spawn callback runs inline.  Re-introduce when leases are wired
  // (Slice D / runtime-loop slice).
  //
  // BUT we DO write `activityRunning` here (v0.1.5 slice 3 round 1):
  // replay projects it into `activity.status = 'running'` AND
  // `node.status = 'running'`, which the run-level Feishu progress card's
  // `collectRunningRows()` + `buildAttemptDeeplinkEnricher()` both gate
  // on to render the "查看当前终端" deeplink.  Without this write the
  // activity stays `pending` for the entire lifetime of a long-running
  // subagent and the card never shows the link.  `leaseId` is a stable
  // inline token so cold-attach replay is deterministic; real leases
  // arrive with Slice D.
  const botSnapshot = await resolveBotSnapshot(ctx, node.bot, options.snapshot);
  const sidecarDir = await attemptSidecarDir(ctx.log, action.activityId, attemptId);
  const attemptLogPath = join(sidecarDir, 'terminal.log');
  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityRunning',
    actor: 'scheduler',
    payload: {
      activityId: action.activityId,
      attemptId,
      leaseId: `lease-${attemptId}`,
    },
  });
  const spawnResult = await ctx.spawnSubagent({
    botName: node.bot,
    botSnapshot,
    // Per UI doc §3.4 "freeze identity": prefer the snapshot's workingDir
    // (frozen at runCreated) over current bot-registry state.  Node-level
    // override still wins — author intent on a specific step beats the
    // run-wide bot default.
    workingDir: node.workingDir ?? botSnapshot?.workingDir,
    prompt: resolvedPrompt,
    modelOverrides: node.modelOverrides,
    toolPolicy: node.toolPolicy,
    activityId: action.activityId,
    attemptId,
    nodeId: action.nodeId,
    runId: ctx.log.runId,
    attemptLogPath,
    cancelSignal: options.cancelSignal,
  });

  if (spawnResult.session) {
    spawnResult.session = withAttemptLogPath(spawnResult.session, attemptLogPath);
    await writeSessionSidecar(ctx.log, action.activityId, attemptId, spawnResult.session);
  }

  if (spawnResult.kind === 'success') {
    const outputRef = await writeJsonBlob(ctx.log, spawnResult.output);
    await ctx.log.append({
      runId: ctx.log.runId,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: action.activityId,
        attemptId,
        outputRef,
      },
    });
    return { kind: 'succeeded', attemptId, outputRef, session: spawnResult.session };
  }

  if (spawnResult.kind === 'cancelled') {
    // Worker observed `cancelSignal.aborted` and shut down (gracefully via
    // SIGINT or forcefully via SIGKILL).  Echo `cancelOriginEventId` from
    // the abort reason straight into `activityCanceled.payload` — we avoid
    // re-replaying the log here, which would otherwise miss the origin if
    // cancel landed mid-tick (the dispatch's snapshot is tick-start, before
    // `cancelRequested` was appended).
    await ctx.log.append({
      runId: ctx.log.runId,
      type: 'activityCanceled',
      actor: 'worker',
      payload: {
        activityId: action.activityId,
        attemptId,
        cancelOriginEventId: spawnResult.cancelOriginEventId,
      },
    });
    return {
      kind: 'cancelled',
      attemptId,
      cancelOriginEventId: spawnResult.cancelOriginEventId,
      session: spawnResult.session,
    };
  }

  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'worker',
    payload: {
      activityId: action.activityId,
      attemptId,
      error: {
        errorCode: spawnResult.errorCode,
        errorClass: spawnResult.errorClass,
        errorMessage: spawnResult.errorMessage,
      },
    },
  });
  return {
    kind: 'failed',
    attemptId,
    errorClass: spawnResult.errorClass,
    errorCode: spawnResult.errorCode,
    errorMessage: spawnResult.errorMessage,
    session: spawnResult.session,
  };
}

function truncateRuntimeErrorMessage(msg: string): string {
  const max = 2048;
  return msg.length > max ? msg.slice(0, max - 3) + '...' : msg;
}

// ─── completeNodeSucceeded ───────────────────────────────────────────────

export async function completeNodeSucceeded(
  ctx: WorkflowRuntimeContext,
  action: CompleteNodeSucceededAction,
): Promise<NodeSucceededEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'nodeSucceeded',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      lastActivityId: action.lastActivityId,
    },
  })) as NodeSucceededEvent;
}

// ─── completeNodeFailed ───────────────────────────────────────────────────

// NB: nodeFailed payload (events doc v0.1.2) has no rootCauseEventId
// field — that lives on runFailed only.  If/when the spec adds it to
// nodeFailed, lift `findRootCauseEventId` to take an activityId and
// reuse it here.

export async function completeNodeFailed(
  ctx: WorkflowRuntimeContext,
  action: CompleteNodeFailedAction,
): Promise<NodeFailedEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'nodeFailed',
    actor: 'scheduler',
    payload: {
      nodeId: action.nodeId,
      lastActivityId: action.lastActivityId,
      errorClass: action.errorClass,
    },
  })) as NodeFailedEvent;
}

// ─── completeRunSucceeded ─────────────────────────────────────────────────

export async function completeRunSucceeded(
  ctx: WorkflowRuntimeContext,
  action: CompleteRunSucceededAction,
): Promise<RunSucceededEvent> {
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'runSucceeded',
    actor: 'scheduler',
    payload: { outputRef: action.outputRef },
  })) as RunSucceededEvent;
}

// ─── completeRunFailed ────────────────────────────────────────────────────

async function findRootCauseEventId(
  ctx: WorkflowRuntimeContext,
  nodeId: string,
): Promise<string> {
  const events = await ctx.log.readAll();
  // Prefer the activityFailed under the failed node's last activity.
  // Fall back to the nodeFailed event itself (always exists by now).
  // For loop block failures (v0.2): loop blocks have no own attempts /
  // nodeFailed; the `loopFinished` event is the authoritative root
  // cause of a loop-level failure (codex Step 3 review Blocker 2).
  let nodeFailedEventId: string | undefined;
  let activityFailedEventId: string | undefined;
  let loopFinishedEventId: string | undefined;
  const nodeActivities = new Set<string>();
  for (const e of events) {
    if (e.type === 'attemptCreated') {
      const p = (e as AttemptCreatedEvent).payload;
      if (!('ref' in p) && p.nodeId === nodeId) nodeActivities.add(p.activityId);
    } else if (e.type === 'activityFailed') {
      const p = (e as ActivityFailedEvent).payload;
      if (!('ref' in p) && nodeActivities.has(p.activityId)) {
        activityFailedEventId = e.eventId;
      }
    } else if (e.type === 'nodeFailed') {
      const p = (e as NodeFailedEvent).payload;
      if (!('ref' in p) && p.nodeId === nodeId) {
        nodeFailedEventId = e.eventId;
      }
    } else if (e.type === 'loopFinished') {
      const p = (e as LoopFinishedEvent).payload;
      if (!('ref' in p) && p.loopId === nodeId && p.resolution !== 'approved') {
        loopFinishedEventId = e.eventId;
      }
    }
  }
  return (
    activityFailedEventId ??
    nodeFailedEventId ??
    loopFinishedEventId ??
    events[0]!.eventId
  );
}

export async function completeRunFailed(
  ctx: WorkflowRuntimeContext,
  action: CompleteRunFailedAction,
): Promise<RunFailedEvent> {
  const rootCauseEventId = await findRootCauseEventId(ctx, action.failedNodeId);
  return (await ctx.log.append({
    runId: ctx.log.runId,
    type: 'runFailed',
    actor: 'scheduler',
    payload: {
      failedNodeId: action.failedNodeId,
      rootCauseEventId,
    },
  })) as RunFailedEvent;
}

// ─── Re-export selected pieces for callers ────────────────────────────────

export type { Snapshot };
export { replay };

// `RunCanceledEvent` import kept stable for Slice D / future cancel
// fan-out wiring; intentional unused reference.
type _UnusedRunCanceled = RunCanceledEvent;
