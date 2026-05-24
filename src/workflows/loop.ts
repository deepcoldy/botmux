/**
 * Orchestrator loop runner.
 *
 * Drives `decideNextActions → dispatch* → replay → repeat` until either
 * the run reaches a terminal status or the orchestrator returns no
 * actions (which on a non-terminal run means we're paused on an open
 * `waitCreated`).
 *
 * Per-tick dispatch model (v0.1.3+):
 *   1. Split ready actions into `dispatch*` (gate / work) and `complete*`
 *      (settle node / run).  The two phases have different concurrency
 *      semantics — dispatch can race, settles must not.
 *   2. Within the dispatch phase: cap concurrency by `defaults.maxConcurrency`
 *      (default 4) and enforce per-bot serialization (one in-flight subagent
 *      per bot within a tick).  Deferred dispatches just stay in the next
 *      tick's ready set; no separate scheduling state needed.
 *   3. Run dispatches via `Promise.allSettled` so a sibling throwing doesn't
 *      starve the rest.  After settle, replay fresh and patch any non-terminal
 *      activity with an `activityFailed` (errorClass=fatal, errorCode=
 *      WorkerCrashed; closest fit in the existing enum — see payloads.ts) —
 *      but NEVER write a second terminal if the dispatch already wrote one
 *      before throwing.  If a dispatch throws BEFORE writing `attemptCreated`,
 *      we have no attempt to attach the failure to; the tick returns
 *      `no-progress` rather than re-dispatching the same action forever.
 *   4. Settle actions (`completeNode*` / `completeRun*`) run sequentially so
 *      event log order stays readable and `completeRun*` is never racy.
 *
 * Re-entry: external events (e.g. `waitResolved` written by the lark
 * card handler) don't drive this loop — the caller is responsible for
 * invoking `runLoop` again when it knows new events have landed.  See
 * `src/workflows/fanout.ts` (Slice D-4) for the daemon-side trigger.
 */

import {
  decideNextActions,
  type DispatchGateAction,
  type DispatchWorkAction,
  type OrchestratorAction,
} from './orchestrator.js';
import { replay, type Snapshot } from './events/replay.js';
import { resume } from './resume.js';
import {
  completeNodeFailed,
  completeNodeSucceeded,
  completeRunFailed,
  completeRunSucceeded,
  dispatchGate,
  dispatchWork,
  type AbortCancelReason,
  type WorkflowRuntimeContext,
} from './runtime.js';
import { logger } from '../utils/logger.js';

const DEFAULT_MAX_CONCURRENCY = 4;
const CANCEL_OBSERVER_INTERVAL_MS = 200;

type DispatchAction = DispatchGateAction | DispatchWorkAction;
type SettleAction = Exclude<OrchestratorAction, DispatchAction>;

export type RunLoopStopReason =
  | 'terminal' // run reached succeeded / failed / cancelled
  | 'awaiting-wait' // open waitCreated; need external resolveWait to continue
  | 'no-progress' // non-terminal but orchestrator emitted [] without a wait
  | 'max-ticks'; // defensive cap hit — likely a bug

export type RunLoopResult = {
  reason: RunLoopStopReason;
  ticks: number;
  lastSnapshot: Snapshot;
};

export type RunLoopOptions = {
  /**
   * Defensive cap on tick count.  A correctly modeled workflow with N
   * nodes terminates in O(N) ticks; the cap exists to keep buggy
   * orchestrator output from spinning forever.  Default 1000.
   */
  maxTicks?: number;
};

export async function runLoop(
  ctx: WorkflowRuntimeContext,
  options: RunLoopOptions = {},
): Promise<RunLoopResult> {
  const maxTicks = options.maxTicks ?? 1000;
  let ticks = 0;
  let snapshot: Snapshot = replay(await ctx.log.readAll());

  while (ticks < maxTicks) {
    if (isTerminalStatus(snapshot)) {
      return { reason: 'terminal', ticks, lastSnapshot: snapshot };
    }

    // ─── Recovery phase ────────────────────────────────────────────────
    // Side-effect family contract: `effectAttempted` written, terminal
    // missing.  Run resume() with the registered reconcilers to close
    // those out before any forward decision.  Without reconcilers we
    // CANNOT silently proceed — the dangling effect represents real
    // external state we'd be ignoring.
    const danglingCancelSet = new Set(snapshot.danglingCancels);
    const danglingRecoverableActivities = snapshot.danglingActivities.filter(
      (activityId) =>
        !snapshot.danglingWaits.includes(activityId) || danglingCancelSet.has(activityId),
    );
    if (
      snapshot.danglingEffectAttempted.length > 0 ||
      danglingRecoverableActivities.length > 0
    ) {
      if (
        snapshot.danglingEffectAttempted.length > 0 &&
        (!ctx.reconcilers || ctx.reconcilers.size === 0)
      ) {
        logger.warn?.(
          `runLoop(${ctx.log.runId}): danglingEffectAttempted=${snapshot.danglingEffectAttempted.length} but ctx.reconcilers missing/empty — stopping with no-progress.`,
        );
        return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
      }
      const before = new Set(snapshot.danglingEffectAttempted);
      const beforeRecoverable = new Set(danglingRecoverableActivities);
      await resume({
        log: ctx.log,
        runId: ctx.log.runId,
        daemonId: 'runloop',
        reconcilers: ctx.reconcilers ?? new Map(),
        loadEffectInput: ctx.loadEffectInput,
        now: ctx.now,
      });
      snapshot = replay(await ctx.log.readAll());
      // If the same set of dangling effects survived recovery, the
      // reconcilers concluded manual/transient.  Don't dispatch new work
      // — operator needs to look at the failed reconcile evidence.
      const stillDangling = snapshot.danglingEffectAttempted.filter((a) => before.has(a));
      if (before.size > 0 && stillDangling.length === before.size) {
        logger.warn?.(
          `runLoop(${ctx.log.runId}): resume() made no progress on ${stillDangling.length} dangling effect(s) — stopping with no-progress.`,
        );
        return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
      }
      if (before.size === 0 && beforeRecoverable.size > 0) {
        const afterCancelSet = new Set(snapshot.danglingCancels);
        const stillRecoverable = snapshot.danglingActivities.filter(
          (activityId) =>
            beforeRecoverable.has(activityId) &&
            (!snapshot.danglingWaits.includes(activityId) || afterCancelSet.has(activityId)),
        );
        if (stillRecoverable.length === beforeRecoverable.size) {
          logger.warn?.(
            `runLoop(${ctx.log.runId}): resume() made no progress on ${stillRecoverable.length} dangling non-effect activity/activities — stopping with no-progress.`,
          );
          return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
        }
      }
      // Progress made; re-enter loop with fresh snapshot before
      // computing actions.
      continue;
    }

    const actions = decideNextActions(snapshot, ctx.def);
    if (actions.length === 0) {
      // Empty actions on a non-terminal run: must be waiting on a
      // human gate or open wait.  Distinguish from "stuck" (no waits
      // but also no actions) via danglingWaits — at least one open.
      const stopped: RunLoopStopReason =
        snapshot.danglingWaits.length > 0 ? 'awaiting-wait' : 'no-progress';
      return { reason: stopped, ticks, lastSnapshot: snapshot };
    }

    const maxConcurrency = ctx.def.defaults?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const { dispatches, settles } = partitionActions(actions);
    const { selected, deferred } = selectDispatchBatch(dispatches, maxConcurrency);

    let anyUnpatchable = false;
    if (selected.length > 0) {
      // v0.1.4-a: per-dispatch AbortControllers so out-of-band callers
      // (cancelWorkflowRunOnDaemon → ctx.registerAborters) can fire abort
      // before the EventLog polling fallback notices `cancelRequested`.
      const aborters = new Map<string, AbortController>();
      for (const a of selected) aborters.set(a.activityId, new AbortController());
      ctx.registerAborters?.(aborters);
      const stopObserver = startCancelObserver(ctx, aborters);
      try {
        const settled = await Promise.allSettled(
          selected.map((a) =>
            runDispatch(ctx, a, snapshot, aborters.get(a.activityId)!.signal),
          ),
        );
        // Replay once before patching infrastructure failures so we don't
        // double-terminal an activity whose dispatch wrote `activityFailed`
        // and then threw on a follow-up step.
        const post = replay(await ctx.log.readAll());
        for (let i = 0; i < settled.length; i++) {
          const result = settled[i]!;
          if (result.status === 'fulfilled') continue;
          const action = selected[i]!;
          const outcome = await maybePatchInfrastructureFailure(ctx, post, action, result.reason);
          if (outcome === 'unpatchable') {
            // Dispatch blew up before writing `attemptCreated`, so there's
            // no per-attempt failure we can pin the error to.  Re-running
            // the loop would re-emit the same dispatch and infinite-loop
            // until maxTicks.  Stop here so the operator can diagnose
            // (e.g. log-write failure, blob-write OOM).  Sibling dispatches
            // that DID write events still keep their events.
            anyUnpatchable = true;
          }
        }
      } finally {
        stopObserver();
        ctx.registerAborters?.(undefined);
      }
    }

    // Settle phase: sequential so event log stays in causal order and
    // `completeRun*` is never racy with a sibling complete.
    for (const action of settles) {
      try {
        await runSettle(ctx, action);
      } catch (err) {
        logger.warn?.(
          `runLoop(${ctx.log.runId}): settle action ${action.kind} threw — stopping tick: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        snapshot = replay(await ctx.log.readAll());
        return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
      }
    }

    snapshot = replay(await ctx.log.readAll());
    ticks++;

    if (anyUnpatchable) {
      // See the `anyUnpatchable = true` branch above.  We deliberately
      // return after applying any sibling settle actions so the operator
      // sees the snapshot in its progressed-as-far-as-possible state.
      return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
    }

    // Defensive: dispatches all got deferred AND no settles ran — we'd
    // loop forever with nothing to do.  Per-bot serialization shouldn't
    // hit this in practice because decideNextActions only emits ready
    // actions, but treat as no-progress to be safe.
    if (selected.length === 0 && settles.length === 0 && deferred > 0) {
      logger.warn?.(
        `runLoop(${ctx.log.runId}): all ${deferred} dispatches deferred and no settle work — stopping with no-progress.`,
      );
      return { reason: 'no-progress', ticks, lastSnapshot: snapshot };
    }
  }

  // Edge case: the tick that hit maxTicks may itself have written the
  // run terminal.  Prefer the precise reason over the safety-cap reason.
  if (isTerminalStatus(snapshot)) {
    return { reason: 'terminal', ticks, lastSnapshot: snapshot };
  }
  return { reason: 'max-ticks', ticks, lastSnapshot: snapshot };
}

function isTerminalStatus(snapshot: Snapshot): boolean {
  return (
    snapshot.run.status === 'succeeded' ||
    snapshot.run.status === 'failed' ||
    snapshot.run.status === 'cancelled'
  );
}

function partitionActions(actions: OrchestratorAction[]): {
  dispatches: DispatchAction[];
  settles: SettleAction[];
} {
  const dispatches: DispatchAction[] = [];
  const settles: SettleAction[] = [];
  for (const a of actions) {
    if (a.kind === 'dispatchGate' || a.kind === 'dispatchWork') dispatches.push(a);
    else settles.push(a);
  }
  return { dispatches, settles };
}

/**
 * Apply per-bot serialization + global concurrency cap.  Same-bot siblings
 * are silently deferred — they survive into the next tick's ready set
 * because their nodeState stays idle (no `attemptCreated` written yet).
 */
function selectDispatchBatch(
  dispatches: DispatchAction[],
  maxConcurrency: number,
): { selected: DispatchAction[]; deferred: number } {
  const inflightBots = new Set<string>();
  const selected: DispatchAction[] = [];
  let deferred = 0;
  for (const a of dispatches) {
    if (selected.length >= maxConcurrency) {
      deferred++;
      continue;
    }
    if (a.kind === 'dispatchWork' && a.node.type === 'subagent') {
      if (inflightBots.has(a.node.bot)) {
        deferred++;
        continue;
      }
      inflightBots.add(a.node.bot);
    }
    selected.push(a);
  }
  return { selected, deferred };
}

async function runDispatch(
  ctx: WorkflowRuntimeContext,
  action: DispatchAction,
  snapshot: Snapshot,
  cancelSignal?: AbortSignal,
): Promise<void> {
  if (action.kind === 'dispatchGate') {
    // dispatchGate writes events synchronously — no long-running worker
    // to cancel, so we ignore the signal.  If a cancel arrives mid-tick
    // the orchestrator short-circuit on the next tick will stop further
    // dispatch.
    await dispatchGate(ctx, action);
    return;
  }
  await dispatchWork(ctx, action, { snapshot, cancelSignal });
}

/**
 * Polling fallback that fires abort signals when `cancelRequested` for
 * the run lands in the EventLog after the tick already started.
 *
 * Daemon-driven cancel (cancelWorkflowRunOnDaemon) fires synchronously
 * via `ctx.registerAborters` and doesn't need this observer.  The
 * observer is just a safety net for callers that write `cancelRequested`
 * directly to the log without going through the daemon (cold attach,
 * tests, future async producers).
 */
function startCancelObserver(
  ctx: WorkflowRuntimeContext,
  aborters: Map<string, AbortController>,
): () => void {
  let stopped = false;
  let firing = false;
  const tick = async (): Promise<void> => {
    if (stopped || firing) return;
    firing = true;
    try {
      const snapshot = replay(await ctx.log.readAll());
      const origin = snapshot.cancelledRunIntent?.cancelOriginEventId;
      if (!origin) return;
      const reason: AbortCancelReason = { cancelOriginEventId: origin };
      for (const ac of aborters.values()) {
        if (!ac.signal.aborted) ac.abort(reason);
      }
    } catch (err) {
      logger.warn?.(
        `runLoop(${ctx.log.runId}): cancel observer poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      firing = false;
    }
  };
  const handle = setInterval(() => void tick(), CANCEL_OBSERVER_INTERVAL_MS);
  // unref so the timer doesn't keep the process alive if the loop hangs.
  handle.unref?.();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

async function runSettle(
  ctx: WorkflowRuntimeContext,
  action: SettleAction,
): Promise<void> {
  switch (action.kind) {
    case 'completeNodeSucceeded':
      await completeNodeSucceeded(ctx, action);
      return;
    case 'completeNodeFailed':
      await completeNodeFailed(ctx, action);
      return;
    case 'completeRunSucceeded':
      await completeRunSucceeded(ctx, action);
      return;
    case 'completeRunFailed':
      await completeRunFailed(ctx, action);
      return;
    // v0.2 loop lifecycle actions — each maps 1:1 to a loop event in
    // events/payloads.ts.  Runtime side has no extra side-effects beyond
    // appending the event; replay (codex Step 2) does the heavy lifting.
    case 'startLoop':
      await ctx.log.append({
        runId: ctx.log.runId,
        type: 'loopStarted',
        actor: 'scheduler',
        payload: {
          loopId: action.loopId,
          maxIterations: action.maxIterations,
        },
      });
      return;
    case 'startLoopIteration':
      await ctx.log.append({
        runId: ctx.log.runId,
        type: 'loopIterationStarted',
        actor: 'scheduler',
        payload: {
          loopId: action.loopId,
          iteration: action.iteration,
          prevResolution: action.prevResolution,
        },
      });
      return;
    case 'finishLoopIteration':
      await ctx.log.append({
        runId: ctx.log.runId,
        type: 'loopIterationFinished',
        actor: 'scheduler',
        payload: {
          loopId: action.loopId,
          iteration: action.iteration,
          resolution: action.resolution,
          decisionActivityId: action.decisionActivityId,
          waitResolvedEventId: action.waitResolvedEventId,
          by: action.by,
          ...(action.comment !== undefined ? { comment: action.comment } : {}),
          ...(action.timedOut !== undefined ? { timedOut: action.timedOut } : {}),
        },
      });
      return;
    case 'finishLoop':
      await ctx.log.append({
        runId: ctx.log.runId,
        type: 'loopFinished',
        actor: 'scheduler',
        payload: {
          loopId: action.loopId,
          finalIteration: action.finalIteration,
          resolution: action.resolution,
          ...(action.outputRef ? { outputRef: action.outputRef } : {}),
          ...(action.errorCode ? { errorCode: action.errorCode } : {}),
          ...(action.errorClass ? { errorClass: action.errorClass } : {}),
        },
      });
      return;
  }
  // Exhaustive — TS will flag if a new settle kind appears.
  const _exhaustive: never = action;
  void _exhaustive;
}

type FallbackOutcome =
  | 'patched' // We wrote an infrastructure-failure event tying the throw to the existing attempt.
  | 'alreadyTerminal' // Dispatch had already written a terminal event before throwing — leave events alone.
  | 'unpatchable'; // Throw happened before any attemptCreated — no attemptId to attach a failure to.

/**
 * Post-`allSettled` recovery: when a dispatch threw, check whether the
 * activity is still non-terminal in the latest replay.  If yes, write one
 * `activityFailed` (errorClass=fatal, errorCode=WorkerCrashed — closest
 * existing enum fit for a dispatch-time hard throw, see payloads.ts) so
 * downstream replay stops waiting.  If the dispatch already wrote a
 * terminal event before throwing (e.g. activitySucceeded then sidecar
 * OOM), skip — appending another terminal would corrupt replay's
 * per-attempt state.
 *
 * Returns one of:
 *   - 'patched'         → infra-failure event appended; loop can continue
 *   - 'alreadyTerminal' → dispatch self-terminated already; no patch needed
 *   - 'unpatchable'     → throw happened before any attemptCreated; loop
 *                         MUST stop or it will re-dispatch the same action
 *                         on the next tick.  Caller is responsible for
 *                         turning this into `no-progress`.
 */
async function maybePatchInfrastructureFailure(
  ctx: WorkflowRuntimeContext,
  snapshot: Snapshot,
  action: DispatchAction,
  reason: unknown,
): Promise<FallbackOutcome> {
  const activityId = action.activityId;
  const activity = snapshot.activities.get(activityId);
  const status = activity?.status;
  if (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timedOut'
  ) {
    logger.warn?.(
      `runLoop(${ctx.log.runId}): dispatch ${action.kind} for ${activityId} threw after already settling (${status}); skipping infrastructure fallback: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    return 'alreadyTerminal';
  }
  const latest = activity?.attempts[activity.attempts.length - 1];
  const attemptId = latest?.attemptId;
  if (!attemptId) {
    // Dispatch threw before writing `attemptCreated` — likely a log/blob
    // write failure inside dispatchWork.  We can't tie an `activityFailed`
    // to a non-existent attempt, and re-running the loop would just
    // re-emit the same dispatch and burn through `maxTicks`.  Mark
    // unpatchable so the caller stops the run.
    logger.warn?.(
      `runLoop(${ctx.log.runId}): dispatch ${action.kind} for ${activityId} threw before attemptCreated; stopping run to avoid infinite retry: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    return 'unpatchable';
  }
  await ctx.log.append({
    runId: ctx.log.runId,
    type: 'activityFailed',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      error: {
        errorClass: 'fatal',
        errorCode: 'WorkerCrashed',
        errorMessage: reason instanceof Error ? reason.message : String(reason),
      },
    },
  });
  return 'patched';
}
