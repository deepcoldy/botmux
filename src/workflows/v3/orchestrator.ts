/**
 * v3 orchestrator — pure decision layer.
 *
 * Mirrors v0.2's `orchestrator.ts` pattern: a pure function maps the current
 * run state + DAG to a list of action descriptors.  The runtime (`runtime.ts`)
 * owns every side effect — journal/STATE writes, ephemeral-worker dispatch via
 * `runNode`, humanGate card posting — and the per-bot/per-CLI/global
 * concurrency caps.  Keeping the decision pure makes the critical-path
 * semantics testable without spawning workers or touching the filesystem.
 *
 * MVP scope: static DAG, fail-fast.  No loops / decisions / dynamic expand
 * (those are deferred — design Q3/§7).  Gate set is frozen at authoring time;
 * the orchestrator never invents or skips a gate (design Q10).
 */

import { isLoopNode, loopInstanceId, topologicalOrder, type V3Dag, type V3Node } from './dag.js';
import type { V3RunFailureReason } from './journal.js';
import type { V3LoopRef } from './journal.js';

// ─── Run state (materialized from the journal by state.ts) ──────────────────

export type V3NodeStatus =
  | 'pending'      // not yet dispatched (deps may or may not be ready)
  | 'gateWaiting'  // humanGate dispatched, awaiting human resolution
  | 'running'      // worker dispatched, in flight
  | 'done'         // succeeded (work + manifest validated)
  | 'skipped'      // triggerRule unsatisfied; acceptable terminal if a sink still reaches done
  | 'cancelled'    // early-release loser; neutral terminal, not fail-fast
  | 'blocked'      // semantic/contract failure — recoverable via retry (new attempt)
  | 'superseded'   // an INSTANCE refreshed by a cross-node revisit; the node gets
                   //   a fresh instance and re-dispatches.  A settled-terminal for
                   //   that instance, NOT a failure (instance restoration 2026-06-08)
  | 'failed';      // infrastructure failure / gate rejected / timed out — needs intervention

export interface V3NodeState {
  status: V3NodeStatus;
  /** True once an approved humanGate cleared this node — so after approval the
   *  next tick dispatches work instead of re-dispatching the gate.  A rejected
   *  gate transitions the node straight to `failed` (set by the runtime), so
   *  this flag only ever records the approved case. */
  gateCleared?: boolean;
  /** The current live runtime instance of this DEFINITION node (`A#002`).
   *  Set on dispatch; cleared when a revisit supersedes it (the node then
   *  re-dispatches a fresh instance).  Absent on the pre-instance-layer path
   *  (plain nodeId-keyed events) and loop body expansions. */
  effectiveInstanceId?: string;
}

/** nodeId → state.  A node absent from the map is treated as `pending`. */
export type V3RunState = Map<string, V3NodeState>;

/**
 * Per-loop composite state, folded from the loop lifecycle events.  A loop
 * absent from the map has not started.  The loop's coarse status (running /
 * blocked / done) lives in the regular node-state map under the loop's id;
 * this struct carries what that one enum can't: where the iteration cursor is
 * and what the last decision said.
 */
export interface V3LoopState {
  /** Current iteration, 1-based; 0 between loopStarted and the first
   *  loopIterationStarted. */
  iteration: number;
  /** True once the CURRENT iteration's decision event is recorded (reset by
   *  the next loopIterationStarted). */
  decided: boolean;
  /** The latest decision — drives what the orchestrator does next. */
  lastDecision?: 'exit' | 'continue' | 'exhausted';
  /** Extra iterations granted (each loopIterationGranted adds one); the
   *  effective budget is maxIterations + granted. */
  granted: number;
  /** An appended-but-unconsumed grant (cleared by the next
   *  loopIterationStarted) — the idempotency key for "already granted". */
  pendingGrant: boolean;
}

/** loopId → loop state. */
export type V3LoopRunState = Map<string, V3LoopState>;

export interface V3EdgeState {
  active: boolean;
  sourceAttemptId: string;
}

/** `${from}->${to}` → conditional edge state. */
export type V3EdgeRunState = Map<string, V3EdgeState>;

export interface V3OmittedInput {
  from: string;
  reason: 'edgeInactive' | 'sourceSkipped' | 'sourceCancelled' | 'earlyRelease';
}

// ─── Actions (runtime translates each into journal writes + side effects) ───

export type V3Action =
  /** Read one source result.json once and append edgeResolved. */
  | { kind: 'resolveEdge'; from: string; to: string }
  /** Mark a node skipped because its triggerRule cannot be satisfied. */
  | { kind: 'skipNode'; nodeId: string; detail?: string }
  /** Abort an early-release loser whose remaining products are no longer used. */
  | { kind: 'cancelNode'; nodeId: string; byNodeId: string; detail?: string }
  /** Post the humanGate approval card + persist a `waits/<id>.json` (Q10). */
  | { kind: 'dispatchGate'; nodeId: string; instanceId?: string }
  /** Spawn an ephemeral worker via `runNode` for this node's goal.  `loop` is
   *  set for body-instance dispatches (the runtime synthesizes the instance
   *  node from the loop's body definition).  `instanceId` is set when this is a
   *  cross-node-revisit RE-DISPATCH (`A#002`): the prior instance was
   *  superseded, so decideNext computes the next instance number deterministically
   *  from `state.instances` (constraint 4 — the action carries it, the runtime
   *  does not guess).  Absent on a first dispatch / loop body (those keep the
   *  pre-instance-layer path until the runtime brick threads instances through). */
  | { kind: 'dispatchWork'; nodeId: string; instanceId?: string; loop?: V3LoopRef; omitted?: V3OmittedInput[] }
  // ── loop control (the runtime translates each into ONE journal append) ──
  /** Outer deps of a loop are done → append loopStarted. */
  | { kind: 'startLoop'; loopId: string }
  /** Begin iteration N (first, after a continue-decision, or after a grant). */
  | { kind: 'startLoopIteration'; loopId: string; iteration: number }
  /** Current iteration's body is fully done and undecided → the runtime reads
   *  the exit node's result.json, evaluates exit.when, appends the decision. */
  | { kind: 'evaluateLoopIteration'; loopId: string; iteration: number }
  /** Decision was 'exit' → seal the loop with a nodeSucceeded on the LOOP id
   *  carrying the output projection's manifest (downstream inputs/deps then
   *  treat the loop like any done node — zero special-casing). */
  | { kind: 'completeLoop'; loopId: string; iteration: number }
  /** Terminal: every node done; the run's product is the sink set. */
  | { kind: 'completeRunSucceeded' }
  /** Terminal (fail-fast): a node failed, so the run cannot proceed. */
  | { kind: 'completeRunFailed'; failedNodeId?: string; reason?: V3RunFailureReason; detail?: string }
  /** Terminal-for-now: a node is blocked (contract failure, recoverable).
   *  Halts dispatch like failed, but the run can resume via a retry event. */
  | { kind: 'completeRunBlocked'; blockedNodeId: string };

// ─── Decision function ──────────────────────────────────────────────────────

/**
 * Pure decision: given the current `state`, return every action that can be
 * taken *now*.  The runtime applies concurrency caps by acting on a prefix of
 * the returned dispatch actions and re-invoking on the next tick — this
 * function intentionally returns ALL ready dispatches (it does not throttle).
 *
 * Ordering follows topological order so callers see deps-ready nodes first.
 * Fail-fast: the moment any node is `failed`, the only action is
 * `completeRunFailed` (in-flight peers are torn down by the runtime / cancel).
 * When no dispatch is possible and nothing is pending, the run is complete.
 */
export function decideNext(
  dag: V3Dag,
  state: V3RunState,
  loops: V3LoopRunState = new Map(),
  edges: V3EdgeRunState = new Map(),
  instances: V3RunState = new Map(),
): V3Action[] {
  const order = topologicalOrder(dag);
  const nodes = new Map(dag.nodes.map((n) => [n.id, n]));

  // Fail-fast sweep first: a single failed node ends the run.  Pick the
  // earliest in topo order for a deterministic `failedNodeId`.  `failed`
  // (infrastructure, needs intervention) takes priority over `blocked`
  // (contract failure, retryable) when both exist.  Loop body instances are
  // swept too — only the CURRENT iteration can be non-done (a decision is
  // only ever recorded once the whole iteration completed).
  for (const id of order) {
    const node = nodes.get(id)!;
    for (const sweepId of [id, ...currentInstanceIds(node, loops)]) {
      if (
        st(state, sweepId).status === 'failed' &&
        (sweepId !== id || isFailureRelevant(id, dag, state, edges))
      ) {
        return [{ kind: 'completeRunFailed', failedNodeId: sweepId }];
      }
    }
  }
  for (const id of order) {
    const node = nodes.get(id)!;
    for (const sweepId of [id, ...currentInstanceIds(node, loops)]) {
      if (
        st(state, sweepId).status === 'blocked' &&
        (sweepId !== id || isFailureRelevant(id, dag, state, edges))
      ) {
        return [{ kind: 'completeRunBlocked', blockedNodeId: sweepId }];
      }
    }
  }

  const actions: V3Action[] = [];
  let pending = 0; // nodes not yet terminal — gates the success sweep

  for (const id of order) {
    const node = nodes.get(id)!;
    const s = st(state, id);

    if (isAcceptableTerminal(id, s.status, dag, state, edges)) continue;

    if (isLoopNode(node)) {
      pending++;
      const ls = loops.get(id);
      if (!ls) {
        const readiness = readinessFor(node, state, edges);
        if (readiness.kind === 'wait') continue;
        if (readiness.kind === 'resolveEdge') {
          actions.push({ kind: 'resolveEdge', from: readiness.from, to: id });
          continue;
        }
        if (readiness.kind === 'skip') {
          actions.push({ kind: 'skipNode', nodeId: id, detail: readiness.detail });
          continue;
        }
        // Not started: deps/trigger satisfied, start the composite node.
        actions.push({ kind: 'startLoop', loopId: id });
        continue;
      }
      if (ls.iteration === 0) {
        actions.push({ kind: 'startLoopIteration', loopId: id, iteration: 1 });
        continue;
      }
      if (ls.decided) {
        if (ls.lastDecision === 'exit') {
          actions.push({ kind: 'completeLoop', loopId: id, iteration: ls.iteration });
        } else if (
          ls.lastDecision === 'continue' ||
          // After an exhausted-block, a grant re-opens exactly one round.  An
          // exhausted loop WITHOUT a pending grant never reaches here — its
          // node status is 'blocked' and the sweep above already returned.
          (ls.lastDecision === 'exhausted' && ls.pendingGrant)
        ) {
          actions.push({ kind: 'startLoopIteration', loopId: id, iteration: ls.iteration + 1 });
        }
        continue;
      }
      // Undecided current iteration: schedule the body like a mini-DAG over
      // instance ids; once every body instance is done, ask for the decision.
      const bodyOrder = topologicalOrder({ runId: id, nodes: node.body.nodes });
      const bodyById = new Map(node.body.nodes.map((b) => [b.id, b]));
      let allDone = true;
      for (const bodyId of bodyOrder) {
        const instId = loopInstanceId(id, ls.iteration, bodyId);
        const bs = st(state, instId);
        if (bs.status === 'done') continue;
        allDone = false;
        if (bs.status === 'running' || bs.status === 'gateWaiting') continue;
        const bodyDef = bodyById.get(bodyId)!;
        const depsOk = bodyDef.depends.every(
          (dep) => st(state, loopInstanceId(id, ls.iteration, dep.from)).status === 'done',
        );
        if (!depsOk) continue;
        actions.push({
          kind: 'dispatchWork',
          nodeId: instId,
          loop: { loopId: id, iteration: ls.iteration, bodyNodeId: bodyId },
        });
      }
      if (allDone) {
        actions.push({ kind: 'evaluateLoopIteration', loopId: id, iteration: ls.iteration });
      }
      continue;
    }

    // In-flight: a dispatched worker or an open gate. Nothing to emit; the
    // node is still pending completion.
    if (s.status === 'running' || s.status === 'gateWaiting') {
      pending++;
      continue;
    }

    // s.status === 'pending'
    pending++;
    const readiness = readinessFor(node, state, edges);
    if (readiness.kind === 'wait') continue;
    if (readiness.kind === 'resolveEdge') {
      actions.push({ kind: 'resolveEdge', from: readiness.from, to: id });
      continue;
    }
    if (readiness.kind === 'skip') {
      actions.push({ kind: 'skipNode', nodeId: id, detail: readiness.detail });
      continue;
    }

    if (node.humanGate && !s.gateCleared) {
      // The gate belongs to the instance that will run on approval — same
      // id resolution as dispatchWork (constraint 6), so gate + work share it.
      actions.push({ kind: 'dispatchGate', nodeId: id, instanceId: s.effectiveInstanceId ?? nextInstanceId(id, instances) });
      continue;
    }
    // Every plain-node dispatch runs under a runtime instance (constraint 4 +
    // design rule: 首派也要 #001).  decideNext — not the runtime — owns the id:
    //   - blocked / human-ask RETRY stays in the SAME instance (constraint 5):
    //     the node still carries `effectiveInstanceId`, so reuse it (the retry
    //     is a new attempt INSIDE it, e.g. A#001/attempts/002).
    //   - first dispatch (no effective) → #001; a revisit re-dispatch (supersede
    //     cleared the effective) → next #NNN from state.instances.
    // (loop body dispatches use loopInstanceId, handled above.)
    const instanceId = s.effectiveInstanceId ?? nextInstanceId(id, instances);
    actions.push({
      kind: 'dispatchWork',
      nodeId: id,
      instanceId,
      ...(readiness.omitted ? { omitted: readiness.omitted } : {}),
    });
    for (const loser of readiness.earlyLosers ?? []) {
      if (canCancelLoser(loser, id, dag, state, edges)) {
        actions.push({
          kind: 'cancelNode',
          nodeId: loser,
          byNodeId: id,
          detail: `early-release loser for "${id}"`,
        });
      }
    }
  }

  if (actions.length === 0 && pending === 0) {
    const sinks = findSinks(dag);
    if (sinks.some((id) => st(state, id).status === 'done')) {
      return [{ kind: 'completeRunSucceeded' }];
    }
    return [{
      kind: 'completeRunFailed',
      reason: 'allSinksSkipped',
      detail: sinkOmissionDetail(sinks, state),
    }];
  }
  return actions;
}

type EdgeActivity =
  | { kind: 'active'; from: string }
  | { kind: 'inactive'; from: string; reason: 'edgeInactive' | 'sourceSkipped' | 'sourceCancelled' }
  | { kind: 'unresolved'; from: string }
  | { kind: 'unsettled'; from: string };

type NodeReadiness =
  | { kind: 'ready'; omitted?: V3OmittedInput[]; earlyLosers?: string[] }
  | { kind: 'skip'; detail: string }
  | { kind: 'resolveEdge'; from: string }
  | { kind: 'wait' };

function readinessFor(node: V3Node, state: V3RunState, edges: V3EdgeRunState): NodeReadiness {
  if (node.depends.length === 0) return { kind: 'ready' };
  const activities = node.depends.map((dep): EdgeActivity => {
    const source = st(state, dep.from);
    if (source.status === 'done') {
      if (!dep.when) return { kind: 'active', from: dep.from };
      const edge = edges.get(currentEdgeKey(dep.from, node.id, state));
      if (!edge) return { kind: 'unresolved', from: dep.from };
      return edge.active
        ? { kind: 'active', from: dep.from }
        : { kind: 'inactive', from: dep.from, reason: 'edgeInactive' };
    }
    if (source.status === 'skipped') return { kind: 'inactive', from: dep.from, reason: 'sourceSkipped' };
    if (source.status === 'cancelled') return { kind: 'inactive', from: dep.from, reason: 'sourceCancelled' };
    return { kind: 'unsettled', from: dep.from };
  });

  const active = activities.filter((a) => a.kind === 'active').length;
  const triggerRule = node.triggerRule ?? 'all_success';
  const required =
    triggerRule === 'all_success' ? node.depends.length
    : triggerRule === 'one_success' ? 1
    : triggerRule.quorum;

  if (triggerRule === 'all_success') {
    if (activities.some((a) => a.kind === 'unsettled')) return { kind: 'wait' };
    const unresolved = firstUnresolved(activities);
    if (unresolved) return { kind: 'resolveEdge', from: unresolved.from };
  } else if (active < required) {
    const unresolved = firstUnresolved(activities);
    if (unresolved) return { kind: 'resolveEdge', from: unresolved.from };
  }

  const maybe = activities.filter((a) => a.kind === 'unsettled' || a.kind === 'unresolved').length;
  if (active >= required) {
    const omitted = activities
      .filter((a): a is Exclude<EdgeActivity, { kind: 'active' }> => a.kind !== 'active')
      .map((a) => ({
        from: a.from,
        reason: a.kind === 'inactive' ? a.reason : 'earlyRelease' as const,
      }));
    const earlyLosers = activities
      .filter((a): a is Extract<EdgeActivity, { kind: 'unsettled' }> => a.kind === 'unsettled')
      .map((a) => a.from);
    return {
      kind: 'ready',
      ...(omitted.length > 0 ? { omitted } : {}),
      ...(earlyLosers.length > 0 ? { earlyLosers } : {}),
    };
  }
  if (active + maybe >= required) return { kind: 'wait' };

  const detail = activities
    .map((a, idx) => {
      const dep = node.depends[idx]!;
      if (a.kind === 'active') return `${dep.from}:active`;
      if (a.kind === 'inactive') return `${dep.from}:inactive(${a.reason})`;
      return `${dep.from}:${a.kind}`;
    })
    .join(', ');
  return { kind: 'skip', detail: `triggerRule=${JSON.stringify(triggerRule)} unsatisfied; ${detail}` };
}

function firstUnresolved(activities: EdgeActivity[]): Extract<EdgeActivity, { kind: 'unresolved' }> | undefined {
  return activities.find((a): a is Extract<EdgeActivity, { kind: 'unresolved' }> => a.kind === 'unresolved');
}

/** The edge key for the source's CURRENT effective instance — mirrors the key
 *  materialize stores edgeResolved under (verdict bound to SOURCE instance, per code
 *  review).  A source revisit (`A#001`→`A#002`) reads a fresh `A#002->B`, never
 *  the superseded `A#001->B`.  Target is keyed by nodeId (it has no instance at
 *  edge-resolve time); a target-only revisit reusing the verdict is a known,
 *  documented limitation. */
function currentEdgeKey(from: string, to: string, state: V3RunState): string {
  const fromInst = st(state, from).effectiveInstanceId ?? from;
  return `${fromInst}->${to}`;
}

/** The CURRENT iteration's expanded instance ids of a loop node (empty for
 *  plain nodes / unstarted loops) — the sweep surface for failed/blocked. */
function currentInstanceIds(node: V3Node, loops: V3LoopRunState): string[] {
  if (!isLoopNode(node)) return [];
  const ls = loops.get(node.id);
  if (!ls || ls.iteration === 0) return [];
  return node.body.nodes.map((b) => loopInstanceId(node.id, ls.iteration, b.id));
}

function isAcceptableTerminal(
  id: string,
  status: V3NodeStatus,
  dag: V3Dag,
  state: V3RunState,
  edges: V3EdgeRunState,
): boolean {
  if (status === 'done' || status === 'skipped' || status === 'cancelled') return true;
  if (status === 'failed' || status === 'blocked') return !isFailureRelevant(id, dag, state, edges);
  return false;
}

function canCancelLoser(
  candidateId: string,
  byNodeId: string,
  dag: V3Dag,
  state: V3RunState,
  edges: V3EdgeRunState,
): boolean {
  const candidate = dag.nodes.find((n) => n.id === candidateId);
  if (!candidate || isLoopNode(candidate)) return false;
  const status = st(state, candidateId).status;
  if (status !== 'pending' && status !== 'gateWaiting' && status !== 'running') return false;

  for (const downstream of downstreamsOf(candidateId, dag)) {
    const ds = st(state, downstream.id).status;
    if (terminalStatus(ds)) continue;
    if (downstream.id === byNodeId) continue;
    if (isSatisfiedWithoutSource(downstream, candidateId, state, edges)) continue;
    if (isImpossibleNow(downstream, state, edges)) continue;
    return false;
  }
  return true;
}

function isFailureRelevant(
  failedNodeId: string,
  dag: V3Dag,
  state: V3RunState,
  edges: V3EdgeRunState,
): boolean {
  const downstreams = downstreamsOf(failedNodeId, dag);
  if (downstreams.length === 0) return true;
  for (const downstream of downstreams) {
    const ds = st(state, downstream.id).status;
    if (terminalStatus(ds)) continue;
    if (!isSatisfiedWithoutSource(downstream, failedNodeId, state, edges)) return true;
  }
  return false;
}

function isSatisfiedWithoutSource(
  node: V3Node,
  ignoredSourceId: string,
  state: V3RunState,
  edges: V3EdgeRunState,
): boolean {
  const activities = node.depends
    .filter((dep) => dep.from !== ignoredSourceId)
    .map((dep) => edgeActivityFor(dep.from, node.id, dep.when !== undefined, state, edges));
  const active = activities.filter((a) => a.kind === 'active').length;
  return active >= requiredFor(node);
}

function isImpossibleNow(node: V3Node, state: V3RunState, edges: V3EdgeRunState): boolean {
  const activities = node.depends.map((dep) =>
    edgeActivityFor(dep.from, node.id, dep.when !== undefined, state, edges));
  const active = activities.filter((a) => a.kind === 'active').length;
  const maybe = activities.filter((a) => a.kind === 'unsettled' || a.kind === 'unresolved').length;
  return active + maybe < requiredFor(node);
}

function edgeActivityFor(
  from: string,
  to: string,
  conditional: boolean,
  state: V3RunState,
  edges: V3EdgeRunState,
): EdgeActivity {
  const source = st(state, from);
  if (source.status === 'done') {
    if (!conditional) return { kind: 'active', from };
    const edge = edges.get(currentEdgeKey(from, to, state));
    if (!edge) return { kind: 'unresolved', from };
    return edge.active
      ? { kind: 'active', from }
      : { kind: 'inactive', from, reason: 'edgeInactive' };
  }
  if (source.status === 'skipped') return { kind: 'inactive', from, reason: 'sourceSkipped' };
  if (source.status === 'cancelled') return { kind: 'inactive', from, reason: 'sourceCancelled' };
  return { kind: 'unsettled', from };
}

function requiredFor(node: V3Node): number {
  const triggerRule = node.triggerRule ?? 'all_success';
  return triggerRule === 'all_success' ? node.depends.length
    : triggerRule === 'one_success' ? 1
    : triggerRule.quorum;
}

function downstreamsOf(nodeId: string, dag: V3Dag): V3Node[] {
  return dag.nodes.filter((n) => n.depends.some((dep) => dep.from === nodeId));
}

function terminalStatus(status: V3NodeStatus): boolean {
  return status === 'done' ||
    status === 'skipped' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'blocked' ||
    // A superseded INSTANCE is settled (it won't change); the DEFINITION node
    // re-dispatches under a fresh instance, but that is tracked at the node
    // level (effectiveInstanceId), not by this per-instance status.
    status === 'superseded';
}

function sinkOmissionDetail(sinks: string[], state: V3RunState): string {
  let skipped = 0;
  let cancelled = 0;
  for (const id of sinks) {
    const status = st(state, id).status;
    if (status === 'skipped') skipped++;
    if (status === 'cancelled') cancelled++;
  }
  return `${skipped} skipped, ${cancelled} cancelled`;
}

/** Sink nodes — no other node depends on them.  Their products are the run's
 *  output.  Pure helper for the runtime's success path. */
export function findSinks(dag: V3Dag): string[] {
  const referenced = new Set<string>();
  for (const node of dag.nodes) for (const dep of node.depends) referenced.add(dep.from);
  return dag.nodes.map((n) => n.id).filter((id) => !referenced.has(id));
}

function st(state: V3RunState, id: string): V3NodeState {
  return state.get(id) ?? { status: 'pending' };
}

/** The next runtime instance id for a definition node, computed from every
 *  instance that has EVER appeared for it (`running/done/blocked/superseded`,
 *  per code review — not just the effective/terminal ones, else a re-dispatch
 *  could collide with an existing `A#002`).  First dispatch (no instances) →
 *  `#001`; a revisit re-dispatch → `#002`, … — instance is the real runtime
 *  node, so EVERY plain-node dispatch gets one (design rule: 首派也要 #001).  Instance
 *  ids are `<nodeId>#NNN`, zero-padded to mirror attempt `001`. */
function nextInstanceId(nodeId: string, instances: V3RunState): string {
  const prefix = `${nodeId}#`;
  let max = 0;
  for (const instanceId of instances.keys()) {
    if (!instanceId.startsWith(prefix)) continue;
    const n = Number.parseInt(instanceId.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
