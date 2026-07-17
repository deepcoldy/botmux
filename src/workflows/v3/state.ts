/**
 * v3 state — materialize the journal into a run snapshot + STATE checkpoint.
 *
 * Two-layer truth (codex v1-review blocker #1):
 *   - `journal.ndjson` (journal.ts) = append-only audit truth
 *   - `STATE` (this file) = materialized checkpoint, derived by replaying the
 *     journal.  Cheap to grep, fast for the dashboard / a human to read, and
 *     re-derivable at any time so it never becomes an independent source of
 *     truth that can drift from the journal.
 *
 * Resume after a daemon restart replays the journal through `materialize`
 * (correctness first); the on-disk STATE file is an observability artifact and
 * a fast-path the runtime refreshes after every event.
 */

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  StoredEvent,
  V3RunFailureReason,
  V3UncertainHostEffect,
} from './journal.js';
import type {
  V3EdgeRunState,
  V3LoopRunState,
  V3LoopState,
  V3NodeState,
  V3NodeStatus,
  V3RunState,
} from './orchestrator.js';

export type V3RunStatus =
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export interface V3RunSnapshot {
  runStatus: V3RunStatus;
  /** First-wins durable cancellation boundary. Once present, later ordinary
   *  dispatch/settle events are audit-only and cannot revive the run. */
  cancelRequestId?: string;
  cancelRequestedBy?: string;
  /** External effects that may have been applied even though the run reached
   *  cancellation. Safe, bounded identities only — never provider payloads. */
  uncertainHostEffects?: V3UncertainHostEffect[];
  /** Set once `runFailed` is observed — the node that triggered fail-fast. */
  failedNodeId?: string;
  /** Workflow-level failure reason; ordinary node failures keep using
   *  `failedNodeId`. */
  failureReason?: V3RunFailureReason;
  /** Human-readable detail for workflow-level failures. */
  failureDetail?: string;
  /** Set once `runBlocked` is observed — the blocked node (cleared back to
   *  running by a subsequent `nodeRetryRequested` on replay). */
  blockedNodeId?: string;
  /** nodeId → current node state (the input `decideNext` consumes).  For a
   *  node with runtime instances, `.effectiveInstanceId` points at its live
   *  instance. */
  nodes: V3RunState;
  /** instanceId (`A#001`) → that runtime instance's state (incl. `superseded`).
   *  Empty for runs that never used the instance layer (plain nodeId events). */
  instances: V3RunState;
  /** nodeId → the attemptId of its latest dispatch — or, after a
   *  `nodeRetryRequested`, the reserved `nextAttemptId` the retry will use. */
  attempts: Map<string, string>;
  /** loopId → composite loop state (iteration cursor / decision / grants). */
  loops: V3LoopRunState;
  /** `${from}->${to}` → conditional edge verdicts folded from edgeResolved. */
  edges: V3EdgeRunState;
}

// ─── Materialize (replay) ────────────────────────────────────────────────

/**
 * Fold the journal into a snapshot.  Pure — same events always yield the same
 * snapshot, which is what makes STATE safe to throw away and re-derive.
 *
 * Node status transitions:
 *   nodeDispatched     → running   (preserve gateCleared across the transition)
 *   nodeSucceeded      → done
 *   nodeFailed         → failed
 *   nodeBlocked        → blocked
 *   nodeRetryRequested → pending  (+ attempt reservation; run blocked→running)
 *   gateDispatched     → gateWaiting
 *   gateResolved/ok    → pending + gateCleared (next tick dispatches work)
 *   gateResolved/no    → failed
 *   edgeResolved       → edges[first `${from}->${to}`] (first-wins)
 *   nodeSkipped        → skipped
 *   nodeCancelled      → cancelled (settle-wins; late same-attempt settle ignored)
 *   nodeAttemptDrained → pending only when the exact current attempt was
 *                        still running; otherwise resource-audit only
 */
export function materialize(events: StoredEvent[]): V3RunSnapshot {
  const nodes: V3RunState = new Map();
  const instances: V3RunState = new Map();
  const attempts = new Map<string, string>();
  const loops: V3LoopRunState = new Map();
  const edges: V3EdgeRunState = new Map();
  let runStatus: V3RunStatus = 'running';
  let cancelRequestId: string | undefined;
  let cancelRequestedBy: string | undefined;
  let failedNodeId: string | undefined;
  let failureReason: V3RunFailureReason | undefined;
  let failureDetail: string | undefined;
  let blockedNodeId: string | undefined;
  let uncertainHostEffects: V3UncertainHostEffect[] | undefined;
  const cancelledAttempts = new Map<string, string | undefined>();
  const resolvedWaitIds = new Set<string>();

  const set = (id: string, status: V3NodeStatus, gateCleared?: boolean): void => {
    const prev = nodes.get(id);
    const next: V3NodeState = { status };
    // Carry an approved-gate flag forward unless this transition sets it.
    const carried = gateCleared ?? prev?.gateCleared;
    if (carried) next.gateCleared = true;
    // Preserve the node's effective instance pointer across status changes.
    if (prev?.effectiveInstanceId) next.effectiveInstanceId = prev.effectiveInstanceId;
    nodes.set(id, next);
  };

  // Instance-layer mirror (instance restoration 2026-06-08): when a lifecycle
  // event carries `instanceId`, record that instance's status AND point the
  // definition node's `effectiveInstanceId` at it.  Events without instanceId
  // (loop body expansions, pre-instance-layer) skip this entirely and keep the
  // plain nodeId-keyed behavior above.
  const recordInstance = (nodeId: string, instanceId: string, status: V3NodeStatus, makeEffective: boolean): void => {
    // A superseded instance is FROZEN: a stale late settle from its old worker
    // (nodeSucceeded/Failed/Blocked) must NOT revive it to done/failed — the
    // refresh state is what the dashboard shows (review blocker 1).
    if (instances.get(instanceId)?.status === 'superseded') return;
    instances.set(instanceId, { status });
    if (makeEffective) {
      const prev = nodes.get(nodeId);
      nodes.set(nodeId, { ...(prev ?? { status }), status, effectiveInstanceId: instanceId });
    } else if (nodes.get(nodeId)?.effectiveInstanceId === instanceId) {
      // settle of the CURRENT effective instance → reflect on the node view.
      const prev = nodes.get(nodeId)!;
      nodes.set(nodeId, { ...prev, status });
    }
  };

  const loop = (id: string): V3LoopState => {
    let ls = loops.get(id);
    if (!ls) {
      ls = { iteration: 0, decided: false, granted: 0, pendingGrant: false };
      loops.set(id, ls);
    }
    return ls;
  };

  const terminal = (id: string): boolean => {
    const status = nodes.get(id)?.status;
    return status === 'done' ||
      status === 'skipped' ||
      status === 'cancelled' ||
      status === 'failed' ||
      status === 'blocked';
  };

  // Keyed by `(instanceId ?? nodeId)` so cancelling `A#001` (an early-release
  // loser) never suppresses `A#002`'s settle after a revisit re-dispatch.
  const cancelledCovers = (key: string, attemptId?: string): boolean => {
    if (!cancelledAttempts.has(key)) return false;
    const cancelledAttemptId = cancelledAttempts.get(key);
    return cancelledAttemptId === undefined || cancelledAttemptId === attemptId;
  };

  for (const e of events) {
    // A durable cancel request is a journal cut: work already committed before
    // it stays committed, while every later ordinary worker/gate/control event
    // is stale audit data. Only cancellation convergence records may mutate the
    // folded state after the cut. This makes request-vs-settle races linear by
    // journal order, including two-daemon overlap windows.
    if (
      cancelRequestId !== undefined &&
      e.type !== 'runCancelRequested' &&
      e.type !== 'nodeCancelled' &&
      e.type !== 'nodeAttemptDrained' &&
      e.type !== 'hostEffectUncertain' &&
      e.type !== 'hostEffectRetryDeferred' &&
      e.type !== 'runCancelled'
    ) continue;
    switch (e.type) {
      case 'runStarted':
        runStatus = 'running';
        break;
      case 'nodeDispatched':
        // Don't resurrect a cancelled early-release loser via a late dispatch.
        // Instance-aware: only the SAME cancelled instance is blocked — a fresh
        // instance (`A#002` after a revisit) dispatches even though `A#001` was
        // cancelled.  Legacy (no instance) keeps the node-view guard.
        if (e.instanceId) {
          if (instances.get(e.instanceId)?.status === 'cancelled') break;
        } else if (nodes.get(e.nodeId)?.status === 'cancelled') break;
        // Dispatch makes this instance the node's effective one.
        if (e.instanceId) recordInstance(e.nodeId, e.instanceId, 'running', true);
        else set(e.nodeId, 'running');
        attempts.set(e.instanceId ?? e.nodeId, e.attemptId); // constraint 3: key by instance when present
        break;
      case 'hostInputPrepared':
        // Preparation reserves an attempt id but is not execution: no provider
        // call can start before hostEffectIntent. It DOES establish the
        // instance as the node's effective pending instance so a preparation
        // failure can settle the authored node instead of only an orphan
        // instance record.
        instances.set(e.instanceId, { status: 'pending' });
        nodes.set(e.nodeId, {
          status: 'pending',
          effectiveInstanceId: e.instanceId,
        });
        attempts.set(e.instanceId, e.attemptId);
        break;
      case 'hostEffectIntent':
        if (instances.get(e.instanceId)?.status === 'cancelled') break;
        recordInstance(e.nodeId, e.instanceId, 'running', true);
        attempts.set(e.instanceId, e.attemptId);
        break;
      case 'hostEffectUncertain': {
        const identity: V3UncertainHostEffect = {
          nodeId: e.nodeId,
          instanceId: e.instanceId,
          attemptId: e.attemptId,
          executor: e.executor,
          errorCode: e.errorCode,
        };
        const prior = uncertainHostEffects ?? [];
        if (!prior.some((item) => item.attemptId === e.attemptId)) {
          uncertainHostEffects = [...prior, identity];
        }
        // After a cancellation cut this is audit/terminal-warning state only;
        // the finalizer still neutral-cancels the materialized running node.
        if (cancelRequestId !== undefined) break;
        if (e.instanceId) recordInstance(e.nodeId, e.instanceId, 'blocked', false);
        else set(e.nodeId, 'blocked');
        break;
      }
      case 'nodeSucceeded':
        if (cancelledCovers(e.instanceId ?? e.nodeId, e.attemptId)) break;
        if (e.instanceId) recordInstance(e.nodeId, e.instanceId, 'done', false);
        else set(e.nodeId, 'done');
        break;
      case 'nodeFailed':
        if (cancelledCovers(e.instanceId ?? e.nodeId, e.attemptId)) break;
        if (e.instanceId) recordInstance(e.nodeId, e.instanceId, 'failed', false);
        else set(e.nodeId, 'failed');
        break;
      case 'nodeBlocked':
        if (cancelledCovers(e.instanceId ?? e.nodeId, e.attemptId)) break;
        if (e.instanceId) {
          // A crash can leave an invalid host-input sidecar before the normal
          // hostInputPrepared event establishes the instance pointer. Its
          // integrity block is the first durable observation of that instance;
          // make it effective so the run really blocks and operator retry can
          // reserve attempt 002. Never promote a late settle over an existing
          // node, and recordInstance still rejects superseded instances.
          const firstObservation = !nodes.has(e.nodeId) && !instances.has(e.instanceId);
          recordInstance(e.nodeId, e.instanceId, 'blocked', firstObservation);
          if (firstObservation) attempts.set(e.instanceId, e.attemptId);
        }
        else set(e.nodeId, 'blocked');
        break;
      case 'nodeRetryRequested':
        // Replay-correct unblock (codex blocker #1 of the blocked design):
        // the retry is a journal event, so a fresh materialize() yields
        // pending — NOT a memory-only patch that evaporates on next replay.
        // Constraint 5: retry is a new ATTEMPT inside the SAME instance — the
        // node keeps its effectiveInstanceId; only its status goes pending.
        if (e.resetGate) {
          nodes.set(e.nodeId, {
            status: 'pending',
            ...(e.instanceId ? { effectiveInstanceId: e.instanceId } : {}),
          });
          if (e.instanceId) instances.set(e.instanceId, { status: 'pending' });
        } else {
          set(e.nodeId, 'pending');
          if (e.instanceId) instances.set(e.instanceId, { status: 'pending' });
        }
        attempts.set(e.instanceId ?? e.nodeId, e.nextAttemptId); // constraint 3
        if (runStatus === 'blocked') {
          runStatus = 'running';
          blockedNodeId = undefined;
        }
        break;
      // ── cross-node revisit / instance refresh ──
      case 'nodeRevisitRequested':
        // Audit only: the nodeInstanceSuperseded events the runtime appends
        // right after do the actual state change.  Recorded for replay /
        // dashboard "why did this node refresh".
        break;
      case 'nodeInstanceSuperseded': {
        instances.set(e.instanceId, { status: 'superseded' });
        // If the superseded instance was the node's live one, the node re-
        // dispatches a fresh instance: drop effectiveInstanceId + gateCleared
        // (constraint 6: the fresh instance must re-approve its gate) and go
        // pending so decideNext re-dispatches.
        if (nodes.get(e.nodeId)?.effectiveInstanceId === e.instanceId) {
          nodes.set(e.nodeId, { status: 'pending' });
        }
        // A refresh during a blocked run re-opens scheduling (analogue of
        // nodeRetryRequested / loopIterationGranted).
        if (runStatus === 'blocked' && blockedNodeId === e.nodeId) {
          runStatus = 'running';
          blockedNodeId = undefined;
        }
        break;
      }
      case 'gateDispatched':
        if (resolvedWaitIds.has(e.waitId)) break;
        if (nodes.get(e.nodeId)?.status === 'cancelled') break;
        // Gate is per-INSTANCE (constraint 6): A#001's approval must not clear
        // A#002.  When the event carries instanceId, the gate state lives on
        // the instance + (when effective) mirrors to the node.
        if (e.instanceId) {
          instances.set(e.instanceId, {
            status: 'gateWaiting',
          });
          nodes.set(e.nodeId, {
            ...(nodes.get(e.nodeId) ?? {}),
            status: 'gateWaiting',
            effectiveInstanceId: e.instanceId,
          });
        } else set(e.nodeId, 'gateWaiting');
        break;
      case 'gateResolved': {
        // The wait file uses the same first-wins rule. Replay must not let a
        // later contradictory click flip an already-authorized decision.
        if (resolvedWaitIds.has(e.waitId)) break;
        resolvedWaitIds.add(e.waitId);
        if (nodes.get(e.nodeId)?.status === 'cancelled') break;
        const approved = e.resolution === 'approved';
        if (e.instanceId) {
          instances.set(e.instanceId, approved ? {
            status: 'pending',
            gateCleared: true,
            ...(e.hostApproval ? { approvedHostInput: e.hostApproval } : {}),
          } : { status: 'failed' });
          // Only mirror to the node view if this instance is the live one.
          if (nodes.get(e.nodeId)?.effectiveInstanceId === e.instanceId) {
            const prev = nodes.get(e.nodeId)!;
            nodes.set(e.nodeId, approved ? {
              ...prev,
              status: 'pending',
              gateCleared: true,
              ...(e.hostApproval ? { approvedHostInput: e.hostApproval } : {}),
            } : { ...prev, status: 'failed' });
          }
        } else if (approved) set(e.nodeId, 'pending', true);
        else set(e.nodeId, 'failed');
        break;
      }
      case 'edgeResolved': {
        // Verdict is bound to the SOURCE effective instance only (code review):
        // the edge resolves BEFORE the target dispatches, so the target has no
        // instance yet — key is `<sourceInstance>-><targetNodeId>`.  This makes
        // `A#001->B` and `A#002->B` distinct, so a SOURCE revisit's fresh verdict
        // is never first-wins-shadowed by the superseded one.  KNOWN LIMITATION:
        // a TARGET-only revisit (B refreshed, A unchanged) reuses `A#001->B` — to
        // be upgraded when target-specific edge semantics actually arise.
        // `toInstanceId` stays on the event as record-only, NOT part of the key.
        const key = `${e.fromInstanceId ?? e.from}->${e.to}`;
        if (!edges.has(key)) {
          edges.set(key, { active: e.active, sourceAttemptId: e.sourceAttemptId });
        }
        break;
      }
      case 'nodeSkipped':
        if (terminal(e.nodeId)) break;
        set(e.nodeId, 'skipped');
        break;
      case 'nodeCancelled':
        if (terminal(e.nodeId)) break;
        // Suppress by instance (or nodeId fallback) so a later instance settles freely.
        cancelledAttempts.set(e.instanceId ?? e.nodeId, e.attemptId);
        if (e.instanceId) recordInstance(e.nodeId, e.instanceId, 'cancelled', false);
        else set(e.nodeId, 'cancelled');
        break;
      case 'nodeAttemptDrained': {
        // A drained peer must be retryable after a blocked run is reopened or
        // after crash recovery. Never revive an obsolete/settled instance, and
        // A legacy runBlocked may precede peer close; reset that exact peer so
        // a later retry re-dispatches it. True terminals/cancellation stay
        // audit-only, and runStatus/blockedNodeId themselves are unchanged.
        if (runStatus !== 'running' && runStatus !== 'blocked') break;
        const key = e.instanceId ?? e.nodeId;
        if (attempts.get(key) !== e.attemptId) break;
        if (e.instanceId) {
          if (instances.get(e.instanceId)?.status !== 'running') break;
          instances.set(e.instanceId, { status: 'pending' });
          const current = nodes.get(e.nodeId);
          if (current?.effectiveInstanceId === e.instanceId && current.status === 'running') {
            nodes.set(e.nodeId, {
              status: 'pending',
              effectiveInstanceId: e.instanceId,
              ...(current.gateCleared ? { gateCleared: true } : {}),
            });
          }
        } else if (nodes.get(e.nodeId)?.status === 'running') {
          set(e.nodeId, 'pending');
        }
        break;
      }
      case 'runCancelRequested':
        // First request wins. A true terminal event committed before it wins
        // instead; requestV3RunCancel normally prevents that combination, but
        // replay stays fail-safe for legacy/corrupt histories too.
        if (
          cancelRequestId === undefined &&
          runStatus !== 'succeeded' &&
          runStatus !== 'failed' &&
          runStatus !== 'cancelled'
        ) {
          cancelRequestId = e.cancelRequestId;
          cancelRequestedBy = e.by;
          runStatus = 'cancelling';
          blockedNodeId = undefined;
        }
        break;
      case 'runCancelled':
        if (cancelRequestId !== undefined && e.cancelRequestId === cancelRequestId) {
          runStatus = 'cancelled';
          blockedNodeId = undefined;
          uncertainHostEffects = e.uncertainHostEffects ?? uncertainHostEffects;
        }
        break;
      case 'runSucceeded':
        runStatus = 'succeeded';
        break;
      case 'runFailed':
        runStatus = 'failed';
        failedNodeId = e.failedNodeId;
        failureReason = e.reason;
        failureDetail = e.detail;
        break;
      case 'runBlocked':
        runStatus = 'blocked';
        blockedNodeId = e.blockedNodeId;
        break;
      // ── structured loop lifecycle ──
      case 'loopStarted':
        loop(e.loopId);
        set(e.loopId, 'running');
        break;
      case 'loopIterationStarted': {
        const ls = loop(e.loopId);
        ls.iteration = e.iteration;
        ls.decided = false;
        ls.pendingGrant = false; // an unconsumed grant is consumed here
        set(e.loopId, 'running');
        break;
      }
      case 'loopIterationDecision': {
        const ls = loop(e.loopId);
        ls.decided = true;
        ls.lastDecision = e.decision;
        // 'exhausted' blocks the LOOP node (the run-level runBlocked is
        // appended by the orchestrator's blocked sweep on the next tick).
        // 'exit' keeps the node 'running' until the orchestrator seals it
        // with a nodeSucceeded on the loop id (output projection manifest).
        if (e.decision === 'exhausted') set(e.loopId, 'blocked');
        break;
      }
      case 'loopIterationGranted': {
        // Replay-correct unblock — the loop analogue of nodeRetryRequested:
        // a journal event, so a fresh materialize() yields a running loop.
        const ls = loop(e.loopId);
        ls.granted += 1;
        ls.pendingGrant = true;
        set(e.loopId, 'running');
        if (runStatus === 'blocked') {
          runStatus = 'running';
          blockedNodeId = undefined;
        }
        break;
      }
    }
  }

  return {
    runStatus,
    cancelRequestId,
    cancelRequestedBy,
    uncertainHostEffects,
    failedNodeId,
    failureReason,
    failureDetail,
    blockedNodeId,
    nodes,
    instances,
    attempts,
    loops,
    edges,
  };
}

// ─── STATE checkpoint (atomic write / read) ────────────────────────────────

/** On-disk shape of the STATE file — Maps flattened to plain objects so it's
 *  human-readable and `jq`-able. */
interface StateFile {
  runStatus: V3RunStatus;
  cancelRequestId?: string;
  cancelRequestedBy?: string;
  uncertainHostEffects?: V3UncertainHostEffect[];
  failedNodeId?: string;
  failureReason?: V3RunFailureReason;
  failureDetail?: string;
  blockedNodeId?: string;
  nodes: Record<string, V3NodeState>;
  instances?: Record<string, V3NodeState>;
  attempts: Record<string, string>;
  loops?: Record<string, V3LoopState>;
  edges?: Record<string, { active: boolean; sourceAttemptId: string }>;
  updatedAt: number;
}

/**
 * Write the snapshot to `statePath` atomically: write a sibling `.tmp` then
 * `rename` over the target (rename is atomic on the same filesystem), so a
 * crash mid-write never leaves a half-written STATE — readers see either the
 * old or the new file, never a torn one.
 */
export function writeState(statePath: string, snap: V3RunSnapshot): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file: StateFile = {
    runStatus: snap.runStatus,
    cancelRequestId: snap.cancelRequestId,
    cancelRequestedBy: snap.cancelRequestedBy,
    uncertainHostEffects: snap.uncertainHostEffects,
    failedNodeId: snap.failedNodeId,
    failureReason: snap.failureReason,
    failureDetail: snap.failureDetail,
    blockedNodeId: snap.blockedNodeId,
    nodes: Object.fromEntries(snap.nodes),
    instances: snap.instances.size > 0 ? Object.fromEntries(snap.instances) : undefined,
    attempts: Object.fromEntries(snap.attempts),
    loops: snap.loops.size > 0 ? Object.fromEntries(snap.loops) : undefined,
    edges: snap.edges.size > 0 ? Object.fromEntries(snap.edges) : undefined,
    updatedAt: Date.now(),
  };
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, statePath);
}

/** Read a previously-written STATE checkpoint back into a snapshot.  Returns
 *  `undefined` when absent.  Resume normally prefers `materialize(readJournal)`
 *  (the journal is authoritative); this is for fast reads / observability. */
export function readState(statePath: string): V3RunSnapshot | undefined {
  if (!existsSync(statePath)) return undefined;
  const file = JSON.parse(readFileSync(statePath, 'utf-8')) as StateFile;
  return {
    runStatus: file.runStatus,
    cancelRequestId: file.cancelRequestId,
    cancelRequestedBy: file.cancelRequestedBy,
    uncertainHostEffects: file.uncertainHostEffects,
    failedNodeId: file.failedNodeId,
    failureReason: file.failureReason,
    failureDetail: file.failureDetail,
    blockedNodeId: file.blockedNodeId,
    nodes: new Map(Object.entries(file.nodes)),
    instances: new Map(Object.entries(file.instances ?? {})),
    attempts: new Map(Object.entries(file.attempts)),
    loops: new Map(Object.entries(file.loops ?? {})),
    edges: new Map(Object.entries(file.edges ?? {})),
  };
}
