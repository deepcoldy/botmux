/**
 * Privacy-safe v3 progress projection for the Lark run card.
 *
 * This is deliberately a pure fold over immutable run identity (`run.json`),
 * the validated outer DAG, and journal events. The journal remains the state
 * truth; `materialize` supplies the replay-correct snapshot. In particular,
 * this DTO never reads attempts, manifests, resolved parameters, or arbitrary
 * files from disk.
 *
 * The card is intentionally less detailed than the dashboard projection:
 * - the outer DAG fixes `counts.total` (loop body instances and revisit
 *   instances never inflate progress);
 * - only path-safe DAG ids and enum/token metadata are exposed;
 * - goals, parameters, free-form errors/reasons, and filesystem paths are not
 *   part of the output type at all.
 */

import { isLoopNode, type V3Dag } from './dag.js';
import type { Spec } from './contract.js';
import type { StoredEvent, V3ErrorClass } from './journal.js';
import type { V3NodeStatus } from './orchestrator.js';
import type { V3RunEnvelope } from './run-envelope.js';
import { materialize } from './state.js';

export type V3ProgressStatus =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'waiting'
  | 'blocked'
  | 'succeeded'
  | 'failed';

export type V3ProgressSource =
  | { kind: 'ad_hoc' }
  | { kind: 'saved_definition'; workflowId: string; revisionId: string; humanVersion: number }
  | { kind: 'manual_cli' }
  | { kind: 'legacy_v3' };

export interface V3ProgressCounts {
  /** Authored outer nodes only. Dynamic loop/revisit instances never count. */
  total: number;
  done: number;
  running: number;
  waiting: number;
  blocked: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
}

export interface V3ProgressLoop {
  loopId: string;
  /** 0 before the first iteration starts; otherwise 1-based. */
  iteration: number;
  maxIterations: number;
  granted: number;
  lastDecision?: 'exit' | 'continue' | 'exhausted';
}

export interface V3ProgressIssue {
  /** Always an authored outer-DAG id, never an attempt/manifest path. */
  nodeId?: string;
  errorClass?: V3ErrorClass;
  /** Included only when it is a bounded machine token, never free text. */
  errorCode?: string;
}

export interface V3ProgressView {
  runId: string;
  /** Digest-pinned canonical spec title. The card owns display truncation. */
  title?: string;
  status: V3ProgressStatus;
  source: V3ProgressSource;
  counts: V3ProgressCounts;
  /** Running outer node ids, in authored DAG order. */
  currentNodeIds: string[];
  /** Human-gated outer node ids, in authored DAG order. */
  waitingNodeIds: string[];
  /** Every authored outer loop, in DAG order; body instances stay private. */
  loops: V3ProgressLoop[];
  revisit: {
    /** Number of accepted revisit requests recorded in the journal. */
    count: number;
    /** Authored nodes whose prior instance was refreshed, in DAG order. */
    refreshedNodeIds: string[];
  };
  issue?: V3ProgressIssue;
  /** Number only: external payloads and provider errors never enter the card. */
  uncertainHostEffectCount?: number;
  /** Last usable journal timestamp, falling back to run.json.createdAt. */
  updatedAt: string;
}

export interface V3ProgressProjectionInput {
  envelope: V3RunEnvelope;
  dag: V3Dag;
  /** The verified spec returned by `loadAuthorizedV3Run`, when this source has one. */
  spec?: Spec;
  events: readonly StoredEvent[];
}

type CountKey = Exclude<keyof V3ProgressCounts, 'total'>;

const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

function sourceView(envelope: V3RunEnvelope): V3ProgressSource {
  switch (envelope.source.kind) {
    case 'saved_definition':
      return {
        kind: 'saved_definition',
        workflowId: envelope.source.workflowId,
        revisionId: envelope.source.revisionId,
        humanVersion: envelope.source.humanVersion,
      };
    case 'ad_hoc':
      return { kind: 'ad_hoc' };
    case 'manual_cli':
      return { kind: 'manual_cli' };
    case 'legacy_v3':
      return { kind: 'legacy_v3' };
  }
}

function countKey(status: V3NodeStatus | undefined): CountKey {
  switch (status) {
    case 'done': return 'done';
    case 'running': return 'running';
    case 'gateWaiting': return 'waiting';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'cancelled': return 'cancelled';
    // A superseded runtime instance is not an authored outer-node terminal.
    // materialize normally resets the definition node to pending; treating an
    // unexpected outer superseded value as pending keeps the total honest.
    case 'superseded':
    case 'pending':
    case undefined:
      return 'pending';
  }
}

function progressStatus(
  runStatus: ReturnType<typeof materialize>['runStatus'],
  counts: V3ProgressCounts,
  hasExecutionActivity: boolean,
): V3ProgressStatus {
  if (runStatus === 'cancelled') return 'cancelled';
  if (runStatus === 'cancelling') return 'cancelling';
  if (runStatus === 'succeeded') return 'succeeded';
  if (runStatus === 'failed' || counts.failed > 0) return 'failed';
  if (runStatus === 'blocked' || counts.blocked > 0) return 'blocked';
  // A parallel branch may still be working while another waits at a gate. In
  // that case the run as a whole is running, not wholly waiting on a human.
  if (counts.running > 0) return 'running';
  if (counts.waiting > 0) return 'waiting';
  return hasExecutionActivity ? 'running' : 'starting';
}

function usableEventTimestamp(events: readonly StoredEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ts = events[i]?.ts;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 && ts <= MAX_DATE_MS) return ts;
  }
  return undefined;
}

function latestIssue(
  events: readonly StoredEvent[],
  outerIds: ReadonlySet<string>,
  status: V3ProgressStatus,
  preferredNodeId?: string,
): V3ProgressIssue | undefined {
  if (status !== 'blocked' && status !== 'failed') return undefined;
  const eventType = status === 'blocked' ? 'nodeBlocked' : 'nodeFailed';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      status === 'blocked' &&
      event.type === 'hostEffectUncertain' &&
      outerIds.has(event.nodeId) &&
      (preferredNodeId === undefined || event.nodeId === preferredNodeId)
    ) {
      return {
        nodeId: event.nodeId,
        errorClass: 'workerError',
        ...(ERROR_CODE_RE.test(event.errorCode) ? { errorCode: event.errorCode } : {}),
      };
    }
    if (event.type !== eventType || !outerIds.has(event.nodeId)) continue;
    if (preferredNodeId !== undefined && event.nodeId !== preferredNodeId) continue;
    return {
      nodeId: event.nodeId,
      errorClass: event.errorClass,
      ...(event.errorCode && ERROR_CODE_RE.test(event.errorCode)
        ? { errorCode: event.errorCode }
        : {}),
    };
  }
  return preferredNodeId && outerIds.has(preferredNodeId)
    ? { nodeId: preferredNodeId }
    : undefined;
}

/**
 * Build the stable, privacy-safe progress DTO consumed by the Lark card.
 * Callers must pass the envelope/DAG bytes already verified by
 * `loadAuthorizedV3Run`; this layer performs no I/O and cannot widen trust.
 */
export function projectV3Progress(input: V3ProgressProjectionInput): V3ProgressView {
  const { envelope, dag, spec, events } = input;
  const snapshot = materialize([...events]);
  const outerIds = new Set(dag.nodes.map((node) => node.id));
  const counts: V3ProgressCounts = {
    total: dag.nodes.length,
    done: 0,
    running: 0,
    waiting: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    pending: 0,
  };
  const currentNodeIds: string[] = [];
  const waitingNodeIds: string[] = [];

  for (const node of dag.nodes) {
    const key = countKey(snapshot.nodes.get(node.id)?.status);
    counts[key] += 1;
    if (key === 'running') currentNodeIds.push(node.id);
    if (key === 'waiting') waitingNodeIds.push(node.id);
  }

  const loops: V3ProgressLoop[] = dag.nodes.filter(isLoopNode).map((node) => {
    const state = snapshot.loops.get(node.id);
    return {
      loopId: node.id,
      iteration: state?.iteration ?? 0,
      maxIterations: node.maxIterations,
      granted: state?.granted ?? 0,
      ...(state?.lastDecision ? { lastDecision: state.lastDecision } : {}),
    };
  });

  let revisitCount = 0;
  const refreshed = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'nodeRevisitRequested' &&
      outerIds.has(event.nodeId) &&
      outerIds.has(event.toNodeId)
    ) {
      revisitCount += 1;
    } else if (event.type === 'nodeInstanceSuperseded' && outerIds.has(event.nodeId)) {
      refreshed.add(event.nodeId);
    }
  }
  const refreshedNodeIds = dag.nodes
    .map((node) => node.id)
    .filter((nodeId) => refreshed.has(nodeId));

  // runStarted is a durable start intent, not evidence that any worker/gate
  // actually began. A retry/revisit with every node temporarily pending is
  // still active because it has journal activity beyond that boundary.
  const hasExecutionActivity = events.some((event) => event.type !== 'runStarted');
  const status = progressStatus(snapshot.runStatus, counts, hasExecutionActivity);
  const preferredIssueNodeId = status === 'blocked'
    ? snapshot.blockedNodeId ?? dag.nodes.find((node) => countKey(snapshot.nodes.get(node.id)?.status) === 'blocked')?.id
    : snapshot.failedNodeId ?? dag.nodes.find((node) => countKey(snapshot.nodes.get(node.id)?.status) === 'failed')?.id;
  const issue = latestIssue(events, outerIds, status, preferredIssueNodeId);
  const lastTs = usableEventTimestamp(events);

  return {
    runId: envelope.runId,
    ...(spec ? { title: spec.title } : {}),
    status,
    source: sourceView(envelope),
    counts,
    currentNodeIds,
    waitingNodeIds,
    loops,
    revisit: { count: revisitCount, refreshedNodeIds },
    ...(issue ? { issue } : {}),
    ...(snapshot.uncertainHostEffects && snapshot.uncertainHostEffects.length > 0
      ? { uncertainHostEffectCount: snapshot.uncertainHostEffects.length }
      : {}),
    updatedAt: lastTs === undefined ? envelope.createdAt : new Date(lastTs).toISOString(),
  };
}
