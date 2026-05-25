/**
 * Workflow orchestrator (pure decision layer).
 *
 * Given a current `Snapshot` and the `WorkflowDefinition`, decide what
 * the runtime should do next.  Returns a list of `OrchestratorAction`
 * descriptors — the executor (Slice D) is responsible for translating
 * those into event-log writes and side-effect dispatches.  Keeping the
 * decision function pure makes the critical-path semantics easy to test
 * without spinning up workers / IM / file IO.
 *
 * v0 scope (UI doc §7 landing #1): focus on the humanGate.stage='before'
 * loop.  Retries / cancel coordination / reconcile already live in
 * `resume.ts`; the orchestrator only emits forward-progress decisions
 * and lets resume own recovery.
 *
 * ────────────────────────────────────────────────────────────────────
 * Activity ID convention
 *
 *   gate activity: `<runId>::gate::<nodeId>`
 *   work activity: `<runId>::work::<nodeId>`
 *
 * One node may own at most one gate (before-gate) and one work
 * activity in v0.  After-gates and re-runs are deferred.
 *
 * v0.2 loop body activities are scoped by a `loop::<loopId>.<N>` segment:
 *
 *   loop work activity: `<runId>::loop::<loopId>.<N>::work::<bodyNodeId>`
 *   loop gate activity: `<runId>::loop::<loopId>.<N>::gate::<bodyNodeId>`
 *
 * `<N>` is the 1-indexed iteration; `<loopId>` is the loop block's
 * nodeId.  All segments stay within `SEGMENT_RE` (allows
 * `[A-Za-z0-9._:-]`), so existing `isValidPathSegment` / attempt-
 * sidecar path guards continue to apply without modification.
 * ────────────────────────────────────────────────────────────────────
 */

import {
  topologicalOrder,
  type HumanGate,
  type WorkflowDefinition,
  type WorkflowNode,
} from './definition.js';
import type { ErrorClass, OutputRef } from './events/payloads.js';
import type { Snapshot } from './events/replay.js';

// ─── Activity ID helpers ──────────────────────────────────────────────────

export function gateActivityId(runId: string, nodeId: string): string {
  return `${runId}::gate::${nodeId}`;
}

export function workActivityId(runId: string, nodeId: string): string {
  return `${runId}::work::${nodeId}`;
}

// ─── Loop iteration activity IDs (v0.2) ───────────────────────────────────
//
// See /tmp/wf-loop-v02.md §4.2 and the top-of-file ASCII spec.
//
// Iteration `N` is 1-indexed.  We refuse to encode `N < 1` so callers
// never accidentally emit `loop::foo.0` ids (the iteration counter is a
// real loop-state position, not a placeholder).

export function loopWorkActivityId(
  runId: string,
  loopId: string,
  iteration: number,
  bodyNodeId: string,
): string {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `loopWorkActivityId: iteration must be a positive integer (got ${iteration})`,
    );
  }
  return `${runId}::loop::${loopId}.${iteration}::work::${bodyNodeId}`;
}

export function loopGateActivityId(
  runId: string,
  loopId: string,
  iteration: number,
  bodyNodeId: string,
): string {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `loopGateActivityId: iteration must be a positive integer (got ${iteration})`,
    );
  }
  return `${runId}::loop::${loopId}.${iteration}::gate::${bodyNodeId}`;
}

/**
 * Parsed activity id.  `kind: 'plain'` corresponds to the v0.1 forms
 * (`<runId>::work::<nodeId>` / `<runId>::gate::<nodeId>`).  `kind:
 * 'loop'` corresponds to v0.2 loop-iteration forms.  Returns `undefined`
 * if `s` doesn't match any known shape — callers can treat that as
 * "not a workflow activity id" without throwing.
 */
export type ParsedActivityId =
  | {
      kind: 'plain';
      runId: string;
      activityKind: 'work' | 'gate';
      nodeId: string;
    }
  | {
      kind: 'loop';
      runId: string;
      loopId: string;
      iteration: number;
      activityKind: 'work' | 'gate';
      nodeId: string;
    };

const PLAIN_RE = /^([^:]+(?:::?[^:]+)*?)::(work|gate)::([A-Za-z0-9_.-]+)$/;
const LOOP_RE = /^(.+)::loop::([A-Za-z0-9_.-]+)\.(\d+)::(work|gate)::([A-Za-z0-9_.-]+)$/;

export function parseActivityId(s: string): ParsedActivityId | undefined {
  // Loop form first — the `::loop::` segment is unambiguous and would
  // also accidentally satisfy a greedy plain match if we tried plain
  // first (`runId` would absorb `::loop::<id>.<N>::work`).
  const loopMatch = LOOP_RE.exec(s);
  if (loopMatch) {
    const [, runId, loopId, iterStr, activityKind, nodeId] = loopMatch;
    const iteration = Number(iterStr);
    if (!Number.isFinite(iteration) || iteration < 1) return undefined;
    return {
      kind: 'loop',
      runId,
      loopId,
      iteration,
      activityKind: activityKind as 'work' | 'gate',
      nodeId,
    };
  }
  const plainMatch = PLAIN_RE.exec(s);
  if (plainMatch) {
    const [, runId, activityKind, nodeId] = plainMatch;
    return {
      kind: 'plain',
      runId,
      activityKind: activityKind as 'work' | 'gate',
      nodeId,
    };
  }
  return undefined;
}

// ─── Actions ──────────────────────────────────────────────────────────────

/**
 * `dispatchGate` — caller writes `attemptCreated` (for the gate activity)
 * + `waitCreated{waitKind:'human-gate'}` + (optionally) `nodeWaiting`.
 */
export type DispatchGateAction = {
  kind: 'dispatchGate';
  nodeId: string;
  activityId: string;
  humanGate: HumanGate;
};

/**
 * `dispatchWork` — caller writes `attemptCreated` for the work activity
 * and spawns the bot worker (subagent) or invokes the executor
 * (hostExecutor).
 */
export type DispatchWorkAction = {
  kind: 'dispatchWork';
  nodeId: string;
  activityId: string;
  node: WorkflowNode;
};

/**
 * `completeNodeSucceeded` — work activity reached terminal success.
 * Caller writes `nodeSucceeded{nodeId, lastActivityId}`.
 */
export type CompleteNodeSucceededAction = {
  kind: 'completeNodeSucceeded';
  nodeId: string;
  lastActivityId: string;
  outputRef: OutputRef;
};

/**
 * `completeNodeFailed` — work activity or gate activity reached terminal
 * failure (incl. gate rejection / deadline).  Caller writes
 * `nodeFailed{nodeId, lastActivityId, errorClass}` and locates
 * `rootCauseEventId` from the underlying terminal event.
 */
export type CompleteNodeFailedAction = {
  kind: 'completeNodeFailed';
  nodeId: string;
  lastActivityId: string;
  errorClass: ErrorClass;
};

/**
 * `completeRunSucceeded` — every node is succeeded and there's a single
 * sink whose output represents the run's product.  Multi-sink workflows
 * are deferred (caller can refuse / extend).
 */
export type CompleteRunSucceededAction = {
  kind: 'completeRunSucceeded';
  outputRef: OutputRef;
  sinkNodeId: string;
};

/**
 * `completeRunFailed` — at least one node failed; the run cannot proceed.
 * Caller writes `runFailed{failedNodeId, rootCauseEventId}` after
 * locating the original failure event.
 */
export type CompleteRunFailedAction = {
  kind: 'completeRunFailed';
  failedNodeId: string;
};

// ─── Loop lifecycle actions (v0.2) ────────────────────────────────────────
//
// These four actions are emitted only by the loop branch of
// `decideNextActions`.  Each maps 1:1 to a loop lifecycle event in
// `events/payloads.ts`; the runtime layer translates the action into a
// `log.append({...})` call (no other side effects).  Per
// /tmp/wf-loop-v02.md §4.3 + codex round 3 ack: when the loop branch
// emits one of these, it returns it as the SOLE action for the tick so
// that event ordering — `loopStarted` → `loopIterationStarted` → body
// attempts — is deterministic and never interleaves with body dispatch.

export type StartLoopAction = {
  kind: 'startLoop';
  loopId: string;
  maxIterations: number;
};

export type StartLoopIterationAction = {
  kind: 'startLoopIteration';
  loopId: string;
  iteration: number;
  prevResolution: 'initial' | 'rejected';
};

export type FinishLoopIterationAction = {
  kind: 'finishLoopIteration';
  loopId: string;
  iteration: number;
  resolution: 'approved' | 'rejected';
  decisionActivityId: string;
  waitResolvedEventId: string;
  by: string;
  comment?: string;
  timedOut?: boolean;
};

export type FinishLoopAction = {
  kind: 'finishLoop';
  loopId: string;
  finalIteration: number;
  resolution:
    | 'approved'
    | 'max-iterations-exceeded'
    | 'body-failed'
    | 'cancelled'
    | 'timeout';
  errorCode?: string;
  errorClass?: ErrorClass;
  outputRef?: OutputRef;
};

export type OrchestratorAction =
  | DispatchGateAction
  | DispatchWorkAction
  | CompleteNodeSucceededAction
  | CompleteNodeFailedAction
  | CompleteRunSucceededAction
  | CompleteRunFailedAction
  | StartLoopAction
  | StartLoopIterationAction
  | FinishLoopIterationAction
  | FinishLoopAction;

// ─── Decision function ───────────────────────────────────────────────────

/**
 * Pure decision function.  Read-only — never throws on graph cycles
 * (the caller is responsible for using `parseWorkflowDefinition` to
 * validate the graph upstream).  Returns `[]` when:
 *   - run is already terminal (succeeded / failed / cancelled)
 *   - all nodes are pending on dependencies / open waits / in-flight
 *     activities and no advancement is possible
 *
 * Ordering: node-scoped actions follow topological order so callers
 * see deps-ready nodes first.  Run-scoped actions (completeRun*) come
 * only if no per-node actions remain — they're the terminal sweep.
 */
export function decideNextActions(
  snapshot: Snapshot,
  def: WorkflowDefinition,
): OrchestratorAction[] {
  if (
    snapshot.run.status === 'succeeded' ||
    snapshot.run.status === 'failed' ||
    snapshot.run.status === 'cancelled'
  ) {
    return [];
  }

  // cancel-intent short-circuit (v0.1.4-a): once `cancelRequested` for the
  // whole run has been written, we stop emitting fresh dispatches.  Letting
  // the loop continue would let late `activitySucceeded` from workers that
  // hadn't yet observed the cancel walk the run past the cancel into a
  // terminal-success — exactly the race that parallel dispatch widens.
  // `cancelWorkflowRun` (called from `cancelWorkflowRunOnDaemon` after this
  // returns []) is responsible for fanning out cancelDelivered →
  // activityCanceled → nodeCanceled → runCanceled.
  if (snapshot.cancelledRunIntent) {
    return [];
  }

  const actions: OrchestratorAction[] = [];
  const runId = snapshot.run.runId;
  const order = topologicalOrder(def);

  // v0.2: compute loop body membership once so the top-level scheduler
  // skips body nodes (they're dispatched by the loop branch only).
  const bodyOwner = buildBodyOwnerMap(def);

  let failedNodeId: string | undefined;
  let pendingCount = 0;

  // ─── Loop lifecycle + body dispatch pass (v0.2) ──────────────────────
  //
  // For each loop block in topo order, this pass owns:
  //   1. emitting `startLoop` when the loop's `depends` first go green
  //   2. emitting `startLoopIteration` to open each iteration
  //   3. dispatching body activities under loop-iteration activityIds
  //   4. emitting `finishLoopIteration` once the terminator decision
  //      attempt settles (approve or reject)
  //   5. emitting `finishLoop` once iteration loop closes (approved /
  //      max-iterations-exceeded / non-terminator body failure / decision
  //      humanGate timeout)
  //
  // Per codex round 3: lifecycle actions are returned as the SOLE action
  // of the tick so event ordering — `loopStarted` → `loopIterationStarted`
  // → body attempts — is deterministic and never interleaves with body
  // dispatches.  Body dispatches batch up only when no lifecycle action
  // fires this tick.
  for (const nodeId of order) {
    const node = def.nodes[nodeId]!;
    if (node.type !== 'loop') continue;
    const loopId = nodeId;
    const loopState = snapshot.loops.get(loopId);
    const depsOk = (node.depends ?? []).every(
      (dep) => snapshot.nodes.get(dep)?.status === 'succeeded',
    );

    // (1) Loop not yet entered.
    if (!loopState) {
      if (!depsOk) {
        pendingCount++;
        continue;
      }
      return [{ kind: 'startLoop', loopId, maxIterations: node.maxIterations }];
    }

    // Loop already finalized — nothing else to do.
    if (loopState.status !== 'running') continue;

    // (2) Loop started but no iteration opened yet.
    if (loopState.iteration === 0) {
      return [
        { kind: 'startLoopIteration', loopId, iteration: 1, prevResolution: 'initial' },
      ];
    }

    // Active iteration in progress.
    const currentIter = loopState.iteration;
    const iterState = loopState.iterations[currentIter - 1];
    if (!iterState) {
      pendingCount++;
      continue; // anomalous — shouldn't happen, skip safely
    }

    // (4) Current iteration already has a settled resolution:
    if (iterState.status === 'approved') {
      const outputRef = computeLoopOutputRef(snapshot, runId, node, loopId, currentIter);
      return [
        {
          kind: 'finishLoop',
          loopId,
          finalIteration: currentIter,
          resolution: 'approved',
          outputRef,
        },
      ];
    }
    if (iterState.status === 'rejected') {
      if (currentIter < loopState.maxIterations) {
        return [
          {
            kind: 'startLoopIteration',
            loopId,
            iteration: currentIter + 1,
            prevResolution: 'rejected',
          },
        ];
      }
      return [
        {
          kind: 'finishLoop',
          loopId,
          finalIteration: currentIter,
          resolution: 'max-iterations-exceeded',
          errorCode: 'LoopMaxIterationsExceeded',
          errorClass: 'userFault',
        },
      ];
    }
    if (iterState.status === 'failed' || iterState.status === 'cancelled') {
      // Non-terminator failure already finalized this iteration; close
      // the loop block with `body-failed` resolution (codex Step 3
      // review Medium).  `cancelled` is reserved for user-initiated
      // cancel; `body-failed` distinguishes "this loop died because a
      // body node failed" from "user clicked cancel".
      return [
        {
          kind: 'finishLoop',
          loopId,
          finalIteration: currentIter,
          resolution: 'body-failed',
          errorCode: 'LoopBodyFailed',
          errorClass: 'fatal',
        },
      ];
    }

    // (3) Iteration is `running` — dispatch body / terminator.
    //
    // Step through body nodes in topo order *within* this iteration.
    // Use a small per-iteration helper map: bodyId → succeeded?  so we
    // can resolve intra-body deps without touching the v0.1 node-level
    // status (which never advances for body nodes in v0.2).
    const bodySet = new Set(node.body);
    const bodyDone = new Map<string, boolean>();
    let bodyFailureFinish: FinishLoopAction | undefined;
    const iterDispatch: OrchestratorAction[] = [];

    for (const bodyId of orderForBody(order, bodySet)) {
      const bodyNode = def.nodes[bodyId]!;
      // Intra-body dep check: all body-side deps must have a succeeded
      // activity in *this* iteration; loop-external deps were guaranteed
      // already by the loop block's own `depends` gate.
      const intraDepsOk = (bodyNode.depends ?? [])
        .filter((d) => bodySet.has(d))
        .every((d) => bodyDone.get(d) === true);
      if (!intraDepsOk) {
        pendingCount++;
        continue;
      }

      const isTerminator = bodyId === node.terminate.node;
      const bodyGateActId = loopGateActivityId(runId, loopId, currentIter, bodyId);
      const bodyWorkActId = loopWorkActivityId(runId, loopId, currentIter, bodyId);
      const advance = decideNodeAdvancement(
        snapshot,
        bodyNode,
        bodyId,
        bodyGateActId,
        bodyWorkActId,
      );

      if (advance.isSucceeded) {
        bodyDone.set(bodyId, true);
        if (isTerminator) {
          // Terminator settled — read its wait resolution out of the
          // activity attempt, then return `finishLoopIteration` as the
          // sole action this tick so the iteration advances cleanly.
          const decisionAct = snapshot.activities.get(bodyGateActId);
          const lastAt = decisionAct?.attempts[decisionAct.attempts.length - 1];
          const wait = lastAt?.wait?.resolution;
          if (
            wait &&
            wait.kind === 'resolved' &&
            (wait.resolution === 'approved' || wait.resolution === 'rejected')
          ) {
            return [
              {
                kind: 'finishLoopIteration',
                loopId,
                iteration: currentIter,
                resolution: wait.resolution,
                decisionActivityId: bodyGateActId,
                waitResolvedEventId: wait.eventId,
                by: wait.by,
                comment: wait.comment,
              },
            ];
          }
          if (wait && wait.kind === 'deadlineExceeded') {
            return [
              {
                kind: 'finishLoopIteration',
                loopId,
                iteration: currentIter,
                resolution: 'rejected',
                decisionActivityId: bodyGateActId,
                waitResolvedEventId: wait.eventId,
                by: 'system',
                timedOut: true,
              },
            ];
          }
          // Decision attempt succeeded but no resolution found — defer.
          pendingCount++;
        }
        continue;
      }

      if (advance.isFailed) {
        if (isTerminator) {
          // Terminator humanGate timed out / failed → finish the loop
          // with `timeout` + WaitDeadlineExceeded (codex Step 3 review
          // Medium — schema invariant requires this errorCode pairing).
          bodyFailureFinish = {
            kind: 'finishLoop',
            loopId,
            finalIteration: currentIter,
            resolution: 'timeout',
            errorCode: 'WaitDeadlineExceeded',
            errorClass: 'userFault',
          };
        } else {
          // Non-terminator body node failed (subagent crash / hostExecutor
          // error / non-terminator humanGate.reject = fail-run per
          // /tmp/wf-loop-v02.md §10.8) → close as `body-failed`.
          bodyFailureFinish = {
            kind: 'finishLoop',
            loopId,
            finalIteration: currentIter,
            resolution: 'body-failed',
            errorCode: 'LoopBodyFailed',
            errorClass: 'fatal',
          };
        }
        break; // stop iterating body; we'll close the loop instead
      }

      // Not yet succeeded / failed — accumulate dispatch actions.
      iterDispatch.push(...advance.actions);
      pendingCount += advance.actions.length === 0 ? 1 : 0;
    }

    if (bodyFailureFinish) {
      return [bodyFailureFinish];
    }
    // Body dispatches accumulate into the outer `actions` array; the
    // legacy plain-node pass below will also push into it, so a single
    // tick can dispatch multiple body nodes + plain nodes together.
    // Lifecycle actions never reach this branch (they early-return
    // above).
    for (const a of iterDispatch) actions.push(a);
  }

  // ─── Loop terminal propagation ────────────────────────────────────────
  //
  // After the loop branch may have emitted `finishLoop`, the next tick
  // sees `loopState.status` settled but the legacy node-level state
  // machine doesn't know about it.  Propagate failed / cancelled loop
  // blocks into `failedNodeId` so the actions.length===0 sweep below
  // can emit `completeRunFailed`.  Succeeded loop blocks expose their
  // projected output via `outputs[workActivityId(runId, loopId)]` and
  // are handled naturally by the sink sweep.
  for (const [loopId, loopState] of snapshot.loops) {
    if (loopState.status === 'failed' || loopState.status === 'cancelled') {
      failedNodeId = failedNodeId ?? loopId;
    }
  }

  // ─── Plain (non-loop, non-body) node pass ────────────────────────────
  //
  // Same logic as v0.1: dispatch gate → dispatch work → settle node.
  // Skips loop blocks (already handled) + decision nodes (only valid in
  // loop body) + body nodes (dispatched only by the loop branch above).
  for (const nodeId of order) {
    const node = def.nodes[nodeId]!;
    if (node.type === 'loop') continue;
    if (node.type === 'decision') continue; // validateLoopBlocks guarantees in-body
    if (bodyOwner.has(nodeId)) continue; // dispatched by loop branch

    const nstatus = snapshot.nodes.get(nodeId)?.status ?? 'idle';
    if (nstatus === 'succeeded' || nstatus === 'skipped' || nstatus === 'cancelled') {
      continue;
    }
    if (nstatus === 'failed') {
      failedNodeId = failedNodeId ?? nodeId;
      continue;
    }

    // Dependencies gate dispatch.  Loop blocks are treated as "succeeded"
    // for the purpose of downstream deps when their snapshot status is
    // 'succeeded'.  This is how `${review-loop.output.x}` and direct
    // body-node refs become resolvable for downstream plain nodes.
    const depsOk = (node.depends ?? []).every((dep) => {
      const depNode = def.nodes[dep];
      if (depNode?.type === 'loop') {
        return snapshot.loops.get(dep)?.status === 'succeeded';
      }
      return snapshot.nodes.get(dep)?.status === 'succeeded';
    });
    if (!depsOk) {
      pendingCount++;
      continue;
    }

    const gateActId = gateActivityId(runId, nodeId);
    const workActId = workActivityId(runId, nodeId);
    const advance = decideNodeAdvancement(snapshot, node, nodeId, gateActId, workActId);
    if (advance.isSucceeded) {
      for (const a of advance.actions) actions.push(a);
      continue;
    }
    if (advance.isFailed) {
      for (const a of advance.actions) actions.push(a);
      // completeNodeFailed action records nodeId in actions; the
      // downstream sweep uses node.status='failed' from the next
      // replay to fail the run.
      continue;
    }
    for (const a of advance.actions) actions.push(a);
    if (advance.actions.length === 0) pendingCount++;
  }

  if (actions.length === 0) {
    if (failedNodeId) {
      actions.push({ kind: 'completeRunFailed', failedNodeId });
    } else if (pendingCount === 0) {
      const sinks = findSinks(def);
      if (sinks.length === 1) {
        const sinkId = sinks[0]!;
        const sinkNode = def.nodes[sinkId];
        const sinkActId = workActivityId(runId, sinkId);
        const sinkOutput = sinkNode?.type === 'loop'
          ? snapshot.outputs.get(sinkActId) // loopFinished projection (codex Step 2)
          : snapshot.outputs.get(sinkActId);
        if (sinkOutput) {
          actions.push({
            kind: 'completeRunSucceeded',
            outputRef: sinkOutput,
            sinkNodeId: sinkId,
          });
        }
      }
    }
  }

  return actions;
}

/**
 * Per-node advancement decision used by both the top-level scheduler
 * (plain nodes) and the v0.2 loop branch (body / decision nodes).  The
 * caller supplies the gate and work activityIds so the same logic
 * applies to plain `runId::work::node` ids and loop iteration
 * `runId::loop::loopId.N::work::node` ids without leaking the
 * activityId convention into this helper.
 *
 * Returns the actions the caller should emit plus a small status
 * triplet — exactly one of `isSucceeded` / `isFailed` is true when
 * the node has reached its terminal; otherwise the call is "pending"
 * (in-flight) and the returned actions are dispatch instructions for
 * gate/work that haven't yet been emitted.
 */
function decideNodeAdvancement(
  snapshot: Snapshot,
  node: WorkflowNode,
  nodeId: string,
  gateActId: string,
  workActId: string,
): {
  actions: OrchestratorAction[];
  isSucceeded: boolean;
  isFailed: boolean;
} {
  const actions: OrchestratorAction[] = [];

  // Decision node: gate-only.  Both reject and approve resolve to
  // `activitySucceeded` per wait.ts decision-mode (see N2 in
  // /tmp/wf-loop-v02.md §4.3); only humanGate timeout produces a
  // failed activity.
  if (node.type === 'decision') {
    const gateAct = snapshot.activities.get(gateActId);
    if (!gateAct) {
      actions.push({
        kind: 'dispatchGate',
        nodeId,
        activityId: gateActId,
        humanGate: node.humanGate,
      });
      return { actions, isSucceeded: false, isFailed: false };
    }
    if (gateAct.status === 'succeeded') {
      return { actions, isSucceeded: true, isFailed: false };
    }
    if (gateAct.status === 'failed' || gateAct.status === 'timedOut') {
      return { actions, isSucceeded: false, isFailed: true };
    }
    return { actions, isSucceeded: false, isFailed: false };
  }

  // Loop blocks are not handled by this helper.
  if (node.type === 'loop') {
    return { actions, isSucceeded: false, isFailed: false };
  }

  const gateAct = snapshot.activities.get(gateActId);
  const workAct = snapshot.activities.get(workActId);

  if (node.humanGate) {
    if (!gateAct) {
      actions.push({
        kind: 'dispatchGate',
        nodeId,
        activityId: gateActId,
        humanGate: node.humanGate,
      });
      return { actions, isSucceeded: false, isFailed: false };
    }
    if (gateAct.status === 'failed' || gateAct.status === 'timedOut') {
      actions.push({
        kind: 'completeNodeFailed',
        nodeId,
        lastActivityId: gateActId,
        errorClass: 'userFault',
      });
      return { actions, isSucceeded: false, isFailed: true };
    }
    if (gateAct.status !== 'succeeded') {
      // gate in-flight — caller treats this as pending
      return { actions, isSucceeded: false, isFailed: false };
    }
    // gate cleared → fall through to work
  }

  if (!workAct) {
    actions.push({
      kind: 'dispatchWork',
      nodeId,
      activityId: workActId,
      node,
    });
    return { actions, isSucceeded: false, isFailed: false };
  }

  if (workAct.status === 'succeeded') {
    const output = snapshot.outputs.get(workActId);
    if (output) {
      actions.push({
        kind: 'completeNodeSucceeded',
        nodeId,
        lastActivityId: workActId,
        outputRef: output,
      });
      return { actions, isSucceeded: true, isFailed: false };
    }
    return { actions, isSucceeded: false, isFailed: false };
  }

  if (workAct.status === 'failed' || workAct.status === 'timedOut') {
    const errorClass: ErrorClass =
      workAct.status === 'timedOut' ? 'retryable' : deriveErrorClass(workAct);
    actions.push({
      kind: 'completeNodeFailed',
      nodeId,
      lastActivityId: workActId,
      errorClass,
    });
    return { actions, isSucceeded: false, isFailed: true };
  }

  // running / waiting / acquired / effectAttempting — pending.
  return { actions, isSucceeded: false, isFailed: false };
}

/**
 * Build `bodyNodeId → owningLoopId` map for fast carve-out lookups.
 * Mirrors `validateLoopBlocks`'s body collection but built every tick
 * because the orchestrator is a pure function and doesn't carry state.
 */
function buildBodyOwnerMap(def: WorkflowDefinition): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [id, node] of Object.entries(def.nodes)) {
    if (node.type !== 'loop') continue;
    for (const bodyId of node.body) owner.set(bodyId, id);
  }
  return owner;
}

/**
 * Filter a workflow-level topological order down to body nodes only,
 * preserving the global order.  Used to dispatch body nodes inside an
 * active loop iteration in deterministic order.
 */
function orderForBody(allOrder: string[], bodySet: Set<string>): string[] {
  return allOrder.filter((id) => bodySet.has(id));
}

/**
 * Resolve `loop.output.from` to the OutputRef of the body node's
 * latest successful iteration so `finishLoop` can carry it forward.
 * Returns `undefined` if the loop did not declare `output.from`, or if
 * the body node hasn't produced a succeeded output in `iteration` yet
 * (which shouldn't happen if the terminator already approved — but
 * defensive against partial replay state).
 */
function computeLoopOutputRef(
  snapshot: Snapshot,
  runId: string,
  loopNode: { output?: { from: string } },
  loopId: string,
  iteration: number,
): OutputRef | undefined {
  const from = loopNode.output?.from;
  if (!from) return undefined;
  const bodyWorkActId = loopWorkActivityId(runId, loopId, iteration, from);
  return snapshot.outputs.get(bodyWorkActId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function deriveErrorClass(activity: {
  attempts: Array<{ error?: { errorClass: ErrorClass } }>;
}): ErrorClass {
  const last = activity.attempts[activity.attempts.length - 1];
  return last?.error?.errorClass ?? 'fatal';
}

function findSinks(def: WorkflowDefinition): string[] {
  const bodyOwner = buildBodyOwnerMap(def);
  // Only consider top-level (non-body) nodes when computing sinks.  Body
  // nodes are dispatched by their owning loop block; the outside view of
  // a loop is "the loop block itself produces output" so body nodes must
  // never count as workflow-level sinks even if no peer depends on them
  // directly.  (`reviewDecision` is the canonical example — nothing
  // outside the loop depends on it, but it's structurally internal.)
  const referenced = new Set<string>();
  for (const [id, node] of Object.entries(def.nodes)) {
    if (bodyOwner.has(id)) continue;
    for (const dep of node.depends ?? []) referenced.add(dep);
  }
  return Object.keys(def.nodes).filter(
    (id) => !bodyOwner.has(id) && !referenced.has(id),
  );
}
