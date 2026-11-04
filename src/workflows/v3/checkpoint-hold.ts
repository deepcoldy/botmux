/**
 * Checkpoint holds (design 2026-11-03 §13.6): in a run whose goal nodes run
 * on bots, a node marked `checkpoint: true` is "look at the result before
 * deciding how the rest goes". When it completes, the nodes that depend on
 * it are not dispatched until that checkpoint is RELEASED — normally when the
 * main bot's turn for its wake-up ends (it may change the rest of the flow in
 * that turn; if it changes nothing, the flow goes on as it was).
 *
 * Everything is derived from the journal, so a restart loses nothing:
 *   - a checkpoint success is the CURRENT `nodeSucceeded` of a marked node —
 *     the latest attempt of its effective instance, recorded after the mark
 *     took effect (a node marked while running counts; one marked after it
 *     had already completed does not wake anybody about that old result);
 *   - it holds its dependants until a `checkpointReleased` names its attempt;
 *   - a run that is no longer running (succeeded, failed, cancelled or being
 *     cancelled) holds nothing: an unreleased success there is left out, so
 *     nothing polls it, releases it into an ended journal, or shows it as
 *     holding.
 *
 * A revisit or re-run of the node makes a new instance whose completion is a
 * new success (new result, downstream re-runs on it): it holds again. Those
 * are bounded by the revisit budget, unlike loop rounds, which is why loop
 * bodies cannot be checkpoints.
 *
 * Kept free of host / IM code (it runs inside the workflow-core runtime).
 */

import { latestAttemptIdFor } from './attempt-numbering.js';
import { isGoalNode, type V3Dag } from './dag.js';
import { foldV3Revisions, readVerifiedV3Revision } from './dag-revision.js';
import type { StoredEvent, V3CheckpointReleaseReason } from './event-contract.js';
import { withJournalMutationSync } from './journal.js';
import { materialize } from './state.js';

export type { V3CheckpointReleaseReason } from './event-contract.js';

export interface V3CheckpointSuccess {
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  /** 1-based journal position of the `nodeSucceeded`. */
  eventSeq: number;
  /** Engine clock of the success. */
  at: number;
  released?: { reason: V3CheckpointReleaseReason; at: number };
}

/** Journal position (number of events before it) from which `nodeId` has
 *  carried the mark without a gap, or undefined when it is not marked now. */
export type V3CheckpointMarkedSince = (nodeId: string) => number | undefined;

function marked(dag: V3Dag, nodeId: string): boolean {
  const node = dag.nodes.find((candidate) => candidate.id === nodeId);
  return !!node && isGoalNode(node) && node.checkpoint === true;
}

/**
 * When each node's mark took effect, from the approved DAG and every applied
 * revision (verified files, read lazily, once per node). A revision that
 * cannot be verified counts as "not marked": the runtime fails closed on it
 * anyway, and no hold is better than an unexplained one.
 */
export function v3CheckpointMarkedSince(
  runDir: string,
  authorizedDag: V3Dag,
  events: readonly StoredEvent[],
): V3CheckpointMarkedSince {
  const cache = new Map<string, number | undefined>();
  let revisions: Array<{ dag: V3Dag; position: number }> | undefined | null;
  const loadRevisions = (): Array<{ dag: V3Dag; position: number }> | null => {
    if (revisions !== undefined) return revisions;
    try {
      const positions = new Map<number, number>();
      events.forEach((event, index) => {
        if (event.type === 'dagRevised') positions.set(event.revision, index + 1);
      });
      revisions = foldV3Revisions(events).applied.map((record) => ({
        dag: readVerifiedV3Revision(runDir, record, authorizedDag).dag,
        position: positions.get(record.revision) ?? 0,
      }));
    } catch {
      revisions = null;
    }
    return revisions;
  };
  return (nodeId) => {
    if (cache.has(nodeId)) return cache.get(nodeId);
    let since: number | undefined = marked(authorizedDag, nodeId) ? 0 : undefined;
    if (events.some((event) => event.type === 'dagRevised')) {
      const list = loadRevisions();
      if (list === null) since = undefined;
      else {
        for (const revision of list) {
          if (!marked(revision.dag, nodeId)) since = undefined;
          else if (since === undefined) since = revision.position;
        }
      }
    }
    cache.set(nodeId, since);
    return since;
  };
}

/** The current success of every marked node of `dag` (see the module doc),
 *  with its release when there is one. In a run that is not running or
 *  blocked only the released ones are listed: nothing is held there. */
export function v3CheckpointSuccesses(input: {
  events: readonly StoredEvent[];
  dag: V3Dag;
  markedSince: V3CheckpointMarkedSince;
}): V3CheckpointSuccess[] {
  const events = [...input.events];
  const snap = materialize(events);
  const live = snap.runStatus === 'running' || snap.runStatus === 'blocked';
  const releases = new Map<string, { reason: V3CheckpointReleaseReason; at: number }>();
  for (const event of events) {
    if (event.type === 'checkpointReleased' && !releases.has(event.attemptId)) {
      releases.set(event.attemptId, { reason: event.reason, at: event.ts });
    }
  }
  const out: V3CheckpointSuccess[] = [];
  for (const node of input.dag.nodes) {
    if (!isGoalNode(node) || node.checkpoint !== true) continue;
    const state = snap.nodes.get(node.id);
    if (state?.status !== 'done') continue;
    const key = state.effectiveInstanceId ?? node.id;
    const attemptId = latestAttemptIdFor(events, key);
    if (!attemptId) continue;
    let index = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === 'nodeSucceeded' && event.attemptId === attemptId && (event.instanceId ?? event.nodeId) === key) {
        index = i;
        break;
      }
    }
    if (index < 0) continue;
    const since = input.markedSince(node.id);
    // Completed before the mark took effect: nobody asked to look at that.
    if (since === undefined || index < since) continue;
    const released = releases.get(attemptId);
    if (!released && !live) continue;
    out.push({
      nodeId: node.id,
      ...(state.effectiveInstanceId ? { instanceId: state.effectiveInstanceId } : {}),
      attemptId,
      eventSeq: index + 1,
      at: events[index]!.ts,
      ...(released ? { released } : {}),
    });
  }
  return out;
}

/** Nodes of `dag` that may not be dispatched yet: those depending on a
 *  checkpoint success nobody released. */
export function v3CheckpointHeldNodes(dag: V3Dag, successes: readonly V3CheckpointSuccess[]): Set<string> {
  const unreleased = new Set(successes.filter((success) => !success.released).map((success) => success.nodeId));
  const held = new Set<string>();
  if (unreleased.size === 0) return held;
  for (const node of dag.nodes) {
    if (node.depends.some((dep) => unreleased.has(dep.from))) held.add(node.id);
  }
  return held;
}

/**
 * Release one checkpoint success (named by its journal position) in the
 * journal lock: written once, only while that success is still current and
 * unreleased. The caller re-drives the run afterwards.
 */
export function releaseV3Checkpoint(
  journalPath: string,
  input: {
    eventSeq: number;
    reason: V3CheckpointReleaseReason;
    dag: V3Dag;
    markedSince: (events: readonly StoredEvent[]) => V3CheckpointMarkedSince;
  },
): 'released' | 'not-held' {
  return withJournalMutationSync(journalPath, ({ events, append }) => {
    const success = v3CheckpointSuccesses({ events, dag: input.dag, markedSince: input.markedSince(events) })
      .find((candidate) => candidate.eventSeq === input.eventSeq);
    if (!success || success.released) return 'not-held';
    append({
      type: 'checkpointReleased',
      nodeId: success.nodeId,
      ...(success.instanceId ? { instanceId: success.instanceId } : {}),
      attemptId: success.attemptId,
      eventSeq: success.eventSeq,
      reason: input.reason,
    }, { durable: true });
    return 'released';
  });
}
