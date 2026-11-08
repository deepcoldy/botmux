/**
 * Cross-node revisit planning, shared by the in-process worker settle path
 * and the external-submission path. Pure apart from persisting the reason
 * file the target's fresh instance reads.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { V3Dag } from './dag.js';
import type { StoredEvent, V3Event } from './event-contract.js';
import { materialize } from './state.js';

/** A node's transitive downstream cone (the node itself + every node reachable
 *  via `depends` edges).  The set a revisit to `root` must refresh: `root`'s
 *  product changed, so every result derived from it is stale. */
export function affectedNodesFrom(dag: V3Dag, root: string): string[] {
  const reachable = new Set<string>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of dag.nodes) {
      if (reachable.has(n.id)) continue;
      if (n.depends.some((d) => reachable.has(d.from))) {
        reachable.add(n.id);
        changed = true;
      }
    }
  }
  return [...reachable];
}

export interface V3RevisitPlan {
  /** `nodeRevisitRequested` followed by one `nodeInstanceSuperseded` per
   *  dispatched node in the target's downstream cone, in append order. */
  events: V3Event[];
  supersededInstanceIds: string[];
}

/**
 * A node requested a cross-node revisit to ancestor `request.toNodeId`: plan
 * the request record, then supersede the CURRENT effective instance of the
 * target AND its whole downstream cone (mark-only, files kept).  `events` is
 * the journal the plan is computed against; callers that need atomicity pass
 * the events read under the journal mutation lock and append the plan there.
 */
export function planV3Revisit(input: {
  runDir: string;
  dag: V3Dag;
  events: readonly StoredEvent[];
  nodeId: string;
  instanceId: string;
  attemptId: string;
  request: { toNodeId: string; reason?: string };
  sourceManifestPath: string;
}): V3RevisitPlan {
  const { runDir, request } = input;
  // Capture feedback paths BEFORE the supersede sweep, while the target's
  // current effective instance + its successful manifest are still resolvable.
  const snap = materialize([...input.events]);
  const targetEff = snap.nodes.get(request.toNodeId)?.effectiveInstanceId;
  const targetSucc = targetEff
    ? [...input.events].reverse().find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
        e.type === 'nodeSucceeded' && (e.instanceId ?? e.nodeId) === targetEff)
    : undefined;
  // Persist the reason as a file the target's fresh instance can Read.  The
  // journal stores runDir-RELATIVE paths (run-dir portability + no abs-path
  // leakage into projections/cards); buildInputs resolves to absolute on read.
  let reasonPathRel: string | undefined;
  if (request.reason) {
    const dir = join(runDir, 'revisits');
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${input.instanceId.replace(/[#/]/g, '-')}-reason.md`);
    writeFileSync(abs, `# Revisit reason (from ${input.nodeId} / ${input.instanceId})\n\n${request.reason}\n`);
    reasonPathRel = relative(runDir, abs);
  }
  const events: V3Event[] = [{
    type: 'nodeRevisitRequested',
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    attemptId: input.attemptId,
    toNodeId: request.toNodeId,
    ...(request.reason ? { reason: request.reason } : {}),
    ...(reasonPathRel ? { reasonPath: reasonPathRel } : {}),
    sourceManifestPath: relative(runDir, input.sourceManifestPath),
    ...(targetSucc ? { targetPreviousManifestPath: relative(runDir, targetSucc.manifestPath) } : {}),
  }];
  const supersededInstanceIds: string[] = [];
  for (const affectedNodeId of affectedNodesFrom(input.dag, request.toNodeId)) {
    const eff = snap.nodes.get(affectedNodeId)?.effectiveInstanceId;
    if (!eff) continue; // never-dispatched downstream node has nothing to supersede
    events.push({
      type: 'nodeInstanceSuperseded',
      nodeId: affectedNodeId,
      instanceId: eff,
      byNodeId: request.toNodeId,
      reason: 'refresh',
    });
    supersededInstanceIds.push(eff);
  }
  return { events, supersededInstanceIds };
}
