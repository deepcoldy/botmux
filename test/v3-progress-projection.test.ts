import { describe, expect, it } from 'vitest';

import { validateDag, type V3Dag } from '../src/workflows/v3/dag.js';
import type { Spec } from '../src/workflows/v3/contract.js';
import type { StoredEvent, V3Event } from '../src/workflows/v3/journal.js';
import { projectV3Progress } from '../src/workflows/v3/progress-projection.js';
import type { V3RunEnvelope } from '../src/workflows/v3/run-envelope.js';

const CREATED_AT = '2026-07-10T08:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function spec(runId = 'progress-run', title = 'Weekly delivery'): Spec {
  return {
    schemaVersion: 1,
    runId,
    title,
    requirement: 'deliver',
    nodes: [{
      sketchId: 'research',
      goal: 'research',
      input_needs: [],
      expected_outputs: ['report'],
      acceptance: 'done',
      risk_gate: false,
      unknowns: [],
    }],
  };
}

function at(ts: number, event: V3Event): StoredEvent {
  return { ...event, ts };
}

function dag(runId = 'progress-run'): V3Dag {
  return validateDag({
    runId,
    nodes: [
      { id: 'research', type: 'goal', goal: 'read /root/private/params.resolved.json', depends: [], inputs: [] },
      { id: 'publish', type: 'goal', goal: 'publish ${params.secret}', depends: ['research'], inputs: [] },
    ],
  });
}

function envelope(
  source: 'ad_hoc' | 'saved_definition' | 'manual_cli' | 'legacy_v3' = 'ad_hoc',
  runId = 'progress-run',
): V3RunEnvelope {
  const base = {
    schemaVersion: 1 as const,
    engine: 'workflow-v3' as const,
    runId,
    createdAt: CREATED_AT,
  };
  if (source === 'saved_definition') {
    return {
      ...base,
      source: {
        kind: 'saved_definition',
        workflowId: 'wf_0123456789abcdef0123456789abcdef',
        revisionId: `rev_${'b'.repeat(64)}`,
        humanVersion: 7,
      },
      artifacts: {
        dag: { path: 'dag.json', sha256: DIGEST },
        spec: { path: 'spec.json', sha256: DIGEST },
        botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
        resolvedParams: { path: 'params.resolved.json', sha256: DIGEST },
        definitionSnapshot: { path: 'definition.snapshot.json', sha256: DIGEST },
      },
      authorization: {
        kind: 'published_revision',
        authorizedAt: CREATED_AT,
        workflowId: 'wf_0123456789abcdef0123456789abcdef',
        revisionId: `rev_${'b'.repeat(64)}`,
        definitionSnapshotSha256: DIGEST,
        dagSha256: DIGEST,
        specSha256: DIGEST,
      },
    } as V3RunEnvelope;
  }
  if (source === 'manual_cli') {
    return {
      ...base,
      source: { kind: 'manual_cli' },
      artifacts: {
        dag: { path: 'dag.json', sha256: DIGEST },
        botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
      },
      authorization: { kind: 'local_cli', authorizedAt: CREATED_AT, dagSha256: DIGEST },
    };
  }
  if (source === 'legacy_v3') {
    return {
      ...base,
      source: { kind: 'legacy_v3', original: 'grill' },
      artifacts: { dag: { path: 'dag.json', sha256: DIGEST } },
      authorization: {
        kind: 'legacy_backfill',
        backfilledAt: CREATED_AT,
        basis: 'runtime_started',
        integrity: 'unverifiable_before_backfill',
        dagSha256: DIGEST,
      },
    };
  }
  return {
    ...base,
    source: { kind: 'ad_hoc', grillStatePath: 'grill.state.json' },
    artifacts: {
      dag: { path: 'dag.json', sha256: DIGEST },
      spec: { path: 'spec.json', sha256: DIGEST },
      botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
    },
    authorization: {
      kind: 'gate2',
      authorizedAt: CREATED_AT,
      dagSha256: DIGEST,
      specSha256: DIGEST,
    },
  };
}

describe('projectV3Progress', () => {
  it('projects an authorized but not-yet-dispatched run as starting with a fixed outer total', () => {
    const view = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      spec: spec(),
      events: [at(1_720_000_000_000, { type: 'runStarted', runId: 'progress-run' })],
    });

    expect(view).toMatchObject({
      runId: 'progress-run',
      title: 'Weekly delivery',
      status: 'starting',
      source: { kind: 'ad_hoc' },
      counts: {
        total: 2,
        pending: 2,
        done: 0,
        running: 0,
        waiting: 0,
        blocked: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      currentNodeIds: [],
      waitingNodeIds: [],
      revisit: { count: 0, refreshedNodeIds: [] },
      updatedAt: '2024-07-03T09:46:40.000Z',
    });
  });

  it('uses running while parallel work continues, then waiting when only a gate remains', () => {
    const base = [
      at(1, { type: 'runStarted', runId: 'progress-run' }),
      at(2, { type: 'nodeDispatched', nodeId: 'research', instanceId: 'research#001', attemptId: '001' }),
      at(3, { type: 'gateDispatched', nodeId: 'publish', instanceId: 'publish#001', waitId: 'publish#001-gate' }),
    ];
    const running = projectV3Progress({ envelope: envelope(), dag: dag(), events: base });
    expect(running.status).toBe('running');
    expect(running.currentNodeIds).toEqual(['research']);
    expect(running.waitingNodeIds).toEqual(['publish']);

    const waiting = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [
        ...base,
        at(4, { type: 'nodeSucceeded', nodeId: 'research', instanceId: 'research#001', attemptId: '001', manifestPath: '/root/private/manifest.json' }),
      ],
    });
    expect(waiting.status).toBe('waiting');
    expect(waiting.counts).toMatchObject({ total: 2, done: 1, waiting: 1 });
  });

  it('projects replay-correct blocked, failed, and succeeded terminal states', () => {
    const blockedEvents: StoredEvent[] = [
      at(1, { type: 'runStarted', runId: 'progress-run' }),
      at(2, { type: 'nodeDispatched', nodeId: 'research', attemptId: '001' }),
      at(3, {
        type: 'nodeBlocked',
        nodeId: 'research',
        attemptId: '001',
        errorClass: 'workerError',
        errorCode: 'AUTH_REQUIRED',
        message: 'read /root/private/token',
      }),
      at(4, { type: 'runBlocked', blockedNodeId: 'research' }),
    ];
    const blocked = projectV3Progress({ envelope: envelope(), dag: dag(), events: blockedEvents });
    expect(blocked.status).toBe('blocked');
    expect(blocked.issue).toEqual({
      nodeId: 'research',
      errorClass: 'workerError',
      errorCode: 'AUTH_REQUIRED',
    });

    const retried = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [
        ...blockedEvents,
        at(5, {
          type: 'nodeRetryRequested',
          nodeId: 'research',
          previousAttemptId: '001',
          nextAttemptId: '002',
          reason: 'blockedRetry',
        }),
      ],
    });
    expect(retried.status).toBe('running');
    expect(retried.counts.pending).toBe(2);
    expect(retried.issue).toBeUndefined();

    const failed = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [
        at(1, { type: 'runStarted', runId: 'progress-run' }),
        at(2, { type: 'nodeFailed', nodeId: 'research', attemptId: '001', errorClass: 'timeout', errorCode: '/root/private' }),
        at(3, { type: 'runFailed', failedNodeId: 'research', detail: 'secret /root/private' }),
      ],
    });
    expect(failed.status).toBe('failed');
    expect(failed.issue).toEqual({ nodeId: 'research', errorClass: 'timeout' });

    const succeeded = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [
        at(1, { type: 'runStarted', runId: 'progress-run' }),
        at(2, { type: 'nodeSucceeded', nodeId: 'research', attemptId: '001', manifestPath: '/private/a' }),
        at(3, { type: 'nodeSkipped', nodeId: 'publish', reason: 'triggerRuleUnsatisfied', detail: '/private/b' }),
        at(4, { type: 'runSucceeded' }),
      ],
    });
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.counts).toMatchObject({ total: 2, done: 1, skipped: 1 });

    const cancellingEvents: StoredEvent[] = [
      at(1, { type: 'runStarted', runId: 'progress-run' }),
      at(2, { type: 'nodeDispatched', nodeId: 'research', attemptId: '001' }),
      at(3, {
        type: 'runCancelRequested',
        cancelRequestId: 'cancel-progress',
        by: 'ou_user',
      }),
    ];
    const cancelling = projectV3Progress({ envelope: envelope(), dag: dag(), events: cancellingEvents });
    expect(cancelling.status).toBe('cancelling');

    const cancelled = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [
        ...cancellingEvents,
        at(4, {
          type: 'hostEffectUncertain',
          nodeId: 'research',
          instanceId: 'research#001',
          attemptId: 'research#001/attempts/001',
          executor: 'feishu-send',
          reason: 'ttlExpired',
          errorCode: 'HOST_EFFECT_TTL_EXPIRED',
        }),
        at(5, {
          type: 'nodeCancelled',
          nodeId: 'research',
          attemptId: '001',
          reason: 'runCancelled',
          cancelRequestId: 'cancel-progress',
        }),
        at(6, {
          type: 'nodeCancelled',
          nodeId: 'publish',
          reason: 'runCancelled',
          cancelRequestId: 'cancel-progress',
        }),
        at(7, {
          type: 'runCancelled',
          cancelRequestId: 'cancel-progress',
          by: 'ou_user',
          uncertainHostEffects: [{
            nodeId: 'research',
            instanceId: 'research#001',
            attemptId: 'research#001/attempts/001',
            executor: 'feishu-send',
            errorCode: 'HOST_EFFECT_TTL_EXPIRED',
          }],
        }),
      ],
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.counts.cancelled).toBe(2);
    expect(cancelled.uncertainHostEffectCount).toBe(1);
  });

  it('keeps loop body instances outside the outer total while exposing bounded loop metadata', () => {
    const loopDag = validateDag({
      runId: 'loop-run',
      nodes: [{
        id: 'repair',
        type: 'loop',
        depends: [],
        inputs: [],
        maxIterations: 2,
        body: {
          nodes: [
            { id: 'code', type: 'goal', goal: 'code', depends: [], inputs: [], resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] } },
            { id: 'test', type: 'goal', goal: 'test', depends: ['code'], inputs: [], resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] } },
          ],
        },
        exit: { node: 'test', when: { path: 'result.passed', equals: true } },
        feedback: [],
        output: { from: 'code' },
      }],
    });
    const events: StoredEvent[] = [
      at(1, { type: 'runStarted', runId: 'loop-run' }),
      at(2, { type: 'loopStarted', loopId: 'repair' }),
      at(3, { type: 'loopIterationStarted', loopId: 'repair', iteration: 1 }),
      at(4, {
        type: 'nodeDispatched',
        nodeId: 'repair.i001.code',
        attemptId: '001',
        loop: { loopId: 'repair', iteration: 1, bodyNodeId: 'code' },
      }),
      at(5, { type: 'loopIterationDecision', loopId: 'repair', iteration: 1, decision: 'exhausted', detail: '/root/private' }),
      at(6, { type: 'loopIterationGranted', loopId: 'repair', fromIteration: 1 }),
    ];
    const view = projectV3Progress({
      envelope: envelope('ad_hoc', 'loop-run'),
      dag: loopDag,
      events,
    });

    expect(view.counts.total).toBe(1);
    expect(Object.values(view.counts).reduce((sum, value) => sum + value, -view.counts.total)).toBe(1);
    expect(view.currentNodeIds).toEqual(['repair']);
    expect(view.loops).toEqual([{
      loopId: 'repair',
      iteration: 1,
      maxIterations: 2,
      granted: 1,
      lastDecision: 'exhausted',
    }]);
  });

  it('reports revisit refreshes without expanding counts or leaking the reason', () => {
    const events: StoredEvent[] = [
      at(1, { type: 'runStarted', runId: 'progress-run' }),
      at(2, { type: 'nodeDispatched', nodeId: 'research', instanceId: 'research#001', attemptId: '001' }),
      at(3, { type: 'nodeSucceeded', nodeId: 'research', instanceId: 'research#001', attemptId: '001', manifestPath: '/private/a' }),
      at(4, { type: 'nodeDispatched', nodeId: 'publish', instanceId: 'publish#001', attemptId: '001' }),
      at(5, {
        type: 'nodeRevisitRequested',
        nodeId: 'publish',
        instanceId: 'publish#001',
        attemptId: '001',
        toNodeId: 'research',
        reason: 'inspect /root/private',
        reasonPath: '/root/private/reason.txt',
      }),
      at(6, { type: 'nodeInstanceSuperseded', nodeId: 'research', instanceId: 'research#001', byNodeId: 'research', reason: 'refresh' }),
      at(7, { type: 'nodeInstanceSuperseded', nodeId: 'publish', instanceId: 'publish#001', byNodeId: 'research', reason: 'refresh' }),
      at(8, { type: 'nodeDispatched', nodeId: 'research', instanceId: 'research#002', attemptId: '002' }),
    ];
    const view = projectV3Progress({ envelope: envelope(), dag: dag(), events });

    expect(view.revisit).toEqual({ count: 1, refreshedNodeIds: ['research', 'publish'] });
    expect(view.counts).toMatchObject({ total: 2, running: 1, pending: 1 });
    expect(view.currentNodeIds).toEqual(['research']);
  });

  it('classifies saved/manual/legacy sources without projecting revision ids or private payloads', () => {
    const saved = projectV3Progress({ envelope: envelope('saved_definition'), dag: dag(), events: [] });
    expect(saved.source).toEqual({
      kind: 'saved_definition',
      workflowId: 'wf_0123456789abcdef0123456789abcdef',
      revisionId: `rev_${'b'.repeat(64)}`,
      humanVersion: 7,
    });
    expect(projectV3Progress({ envelope: envelope('manual_cli'), dag: dag(), events: [] }).source).toEqual({ kind: 'manual_cli' });
    expect(projectV3Progress({ envelope: envelope('legacy_v3'), dag: dag(), events: [] }).source).toEqual({ kind: 'legacy_v3' });

    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain('/root/');
    expect(serialized).not.toContain('/private/');
    expect(serialized).not.toContain('${params');
    expect(serialized).not.toContain('goal');
    expect(serialized).not.toContain('params');
  });

  it('falls back to run.json.createdAt when journal timestamps are unusable', () => {
    const view = projectV3Progress({
      envelope: envelope(),
      dag: dag(),
      events: [at(Number.NaN, { type: 'runStarted', runId: 'progress-run' })],
    });
    expect(view.updatedAt).toBe(CREATED_AT);
  });
});
