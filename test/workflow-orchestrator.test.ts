import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';
import { createWait, resolveWait } from '../src/workflows/wait.js';
import {
  decideNextActions,
  gateActivityId,
  loopGateActivityId,
  loopWorkActivityId,
  parseActivityId,
  workActivityId,
  type OrchestratorAction,
} from '../src/workflows/orchestrator.js';
import { isValidPathSegment } from '../src/workflows/ops-projection.js';

const RUN_ID = 'run-orch-test-01';
const SHA = 'sha256:' + 'a'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 16,
  outputSchemaVersion: 1,
};
const noopResolver: BotResolver = () => ({});

// ─── fixtures ─────────────────────────────────────────────────────────────

function twoStepLinear(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'two-step',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b1', prompt: 'a' },
      b: { type: 'subagent', bot: 'b2', prompt: 'b', depends: ['a'] },
    },
  });
}

function gatedTwoStep(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'gated',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b1', prompt: 'a' },
      gated: {
        type: 'subagent',
        bot: 'b2',
        prompt: 'b',
        depends: ['a'],
        humanGate: {
          stage: 'before',
          prompt: 'approve?',
          deadlineMs: 60_000,
          onTimeout: 'fail',
        },
      },
    },
  });
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-orch-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function startedLog(def: WorkflowDefinition): Promise<EventLog> {
  const log = new EventLog(RUN_ID, baseDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'tester',
    botResolver: noopResolver,
  });
  return log;
}

async function snapshotOf(log: EventLog) {
  return replay(await log.readAll());
}

// Helpers to splice ad-hoc events into the log for fixturing.
async function writeAttemptCreated(
  log: EventLog,
  activityId: string,
  attemptId: string,
  nodeId: string,
  attemptNumber = 1,
) {
  await log.append({
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      attemptNumber,
      nodeId,
      inputRef: sampleOutputRef,
    },
  });
}

async function writeActivitySucceeded(
  log: EventLog,
  activityId: string,
  attemptId: string,
  output: { outputHash: string; outputBytes: number; outputSchemaVersion: number },
) {
  await log.append({
    runId: RUN_ID,
    type: 'activitySucceeded',
    actor: 'worker',
    payload: {
      activityId,
      attemptId,
      outputRef: output,
    },
  });
}

async function writeActivityFailed(
  log: EventLog,
  activityId: string,
  attemptId: string,
  errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual',
) {
  await log.append({
    runId: RUN_ID,
    type: 'activityFailed',
    actor: 'worker',
    payload: {
      activityId,
      attemptId,
      error: {
        errorCode: 'NetworkError',
        errorClass,
        errorMessage: 'fake fail for test',
      },
    },
  });
}

async function writeNodeSucceeded(log: EventLog, nodeId: string, lastActivityId: string) {
  await log.append({
    runId: RUN_ID,
    type: 'nodeSucceeded',
    actor: 'scheduler',
    payload: { nodeId, lastActivityId },
  });
}

async function writeNodeFailed(
  log: EventLog,
  nodeId: string,
  lastActivityId: string,
  errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual',
) {
  await log.append({
    runId: RUN_ID,
    type: 'nodeFailed',
    actor: 'scheduler',
    payload: {
      nodeId,
      lastActivityId,
      errorClass,
      rootCauseEventId: 'irrelevant-for-replay',
    },
  });
}

function actionsKind(actions: OrchestratorAction[]): Array<{ kind: string; nodeId?: string }> {
  return actions.map((a) => {
    if ('nodeId' in a) return { kind: a.kind, nodeId: a.nodeId };
    if (a.kind === 'completeRunFailed') return { kind: a.kind, nodeId: a.failedNodeId };
    if (a.kind === 'completeRunSucceeded') return { kind: a.kind, nodeId: a.sinkNodeId };
    return { kind: (a as { kind: string }).kind };
  });
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('decideNextActions — fresh run, no humanGate', () => {
  it('dispatches root node only', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actionsKind(actions)).toEqual([{ kind: 'dispatchWork', nodeId: 'a' }]);
    const aAction = actions[0]!;
    expect(aAction.kind).toBe('dispatchWork');
    if (aAction.kind === 'dispatchWork') {
      expect(aAction.activityId).toBe(workActivityId(RUN_ID, 'a'));
    }
  });

  it('after root succeeds, advances node-completion then next node dispatch', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', {
      outputHash: 'sha256:' + 'b'.repeat(64),
      outputBytes: 8,
      outputSchemaVersion: 1,
    });
    // node still in `triggered` (no nodeSucceeded yet) → orchestrator
    // should advance with completeNodeSucceeded, NOT yet dispatch 'b'
    const first = decideNextActions(await snapshotOf(log), def);
    expect(actionsKind(first)).toEqual([
      { kind: 'completeNodeSucceeded', nodeId: 'a' },
    ]);

    // simulate node terminal write, then re-decide
    await writeNodeSucceeded(log, 'a', aActId);
    const second = decideNextActions(await snapshotOf(log), def);
    expect(actionsKind(second)).toEqual([{ kind: 'dispatchWork', nodeId: 'b' }]);
  });

  it('all nodes succeeded → completeRunSucceeded with sink output', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    // node a
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', sampleOutputRef);
    await writeNodeSucceeded(log, 'a', aActId);
    // node b
    const bActId = workActivityId(RUN_ID, 'b');
    const bOutput = {
      outputHash: 'sha256:' + 'c'.repeat(64),
      outputBytes: 99,
      outputSchemaVersion: 1,
    };
    await writeAttemptCreated(log, bActId, 'b-att-1', 'b');
    await writeActivitySucceeded(log, bActId, 'b-att-1', bOutput);
    await writeNodeSucceeded(log, 'b', bActId);

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'completeRunSucceeded',
      sinkNodeId: 'b',
      outputRef: bOutput,
    });
  });

  it('any node failed (terminal) → completeRunFailed', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivityFailed(log, aActId, 'a-att-1', 'fatal');
    // node-level fail must land too
    await writeNodeFailed(log, 'a', aActId, 'fatal');

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actionsKind(actions)).toEqual([
      { kind: 'completeRunFailed', nodeId: 'a' },
    ]);
  });
});

// ─── humanGate branches ───────────────────────────────────────────────────

describe('decideNextActions — humanGate.stage="before"', () => {
  it('gated node ready → dispatchGate (not dispatchWork)', async () => {
    const def = gatedTwoStep();
    const log = await startedLog(def);
    // unblock 'a'
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', sampleOutputRef);
    await writeNodeSucceeded(log, 'a', aActId);

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('dispatchGate');
    if (action.kind === 'dispatchGate') {
      expect(action.nodeId).toBe('gated');
      expect(action.activityId).toBe(gateActivityId(RUN_ID, 'gated'));
      expect(action.humanGate.stage).toBe('before');
    }
  });

  it('gate in-flight (waitCreated, not resolved) → no actions', async () => {
    const def = gatedTwoStep();
    const log = await startedLog(def);
    // satisfy dep
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', sampleOutputRef);
    await writeNodeSucceeded(log, 'a', aActId);

    // raise gate activity
    const gateActId = gateActivityId(RUN_ID, 'gated');
    const gateAttId = 'gated-gate-att-1';
    await writeAttemptCreated(log, gateActId, gateAttId, 'gated');
    await createWait(log, {
      activityId: gateActId,
      attemptId: gateAttId,
      nodeId: 'gated',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actions).toEqual([]);
  });

  it('gate approved → dispatchWork for gated node', async () => {
    const def = gatedTwoStep();
    const log = await startedLog(def);
    // satisfy dep
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', sampleOutputRef);
    await writeNodeSucceeded(log, 'a', aActId);

    // raise + resolve gate
    const gateActId = gateActivityId(RUN_ID, 'gated');
    const gateAttId = 'gated-gate-att-1';
    await writeAttemptCreated(log, gateActId, gateAttId, 'gated');
    await createWait(log, {
      activityId: gateActId,
      attemptId: gateAttId,
      nodeId: 'gated',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });
    await resolveWait(log, {
      activityId: gateActId,
      attemptId: gateAttId,
      resolution: 'approved',
      by: 'ou_user',
    });

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'dispatchWork',
      nodeId: 'gated',
      activityId: workActivityId(RUN_ID, 'gated'),
    });
  });

  it('gate rejected → completeNodeFailed (userFault) on gated node', async () => {
    const def = gatedTwoStep();
    const log = await startedLog(def);
    const aActId = workActivityId(RUN_ID, 'a');
    await writeAttemptCreated(log, aActId, 'a-att-1', 'a');
    await writeActivitySucceeded(log, aActId, 'a-att-1', sampleOutputRef);
    await writeNodeSucceeded(log, 'a', aActId);

    const gateActId = gateActivityId(RUN_ID, 'gated');
    const gateAttId = 'gated-gate-att-1';
    await writeAttemptCreated(log, gateActId, gateAttId, 'gated');
    await createWait(log, {
      activityId: gateActId,
      attemptId: gateAttId,
      nodeId: 'gated',
      waitKind: 'human-gate',
      prompt: 'approve?',
    });
    await resolveWait(log, {
      activityId: gateActId,
      attemptId: gateAttId,
      resolution: 'rejected',
      by: 'ou_user',
      comment: 'nope',
    });

    const actions = decideNextActions(await snapshotOf(log), def);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'completeNodeFailed',
      nodeId: 'gated',
      lastActivityId: gateActId,
      errorClass: 'userFault',
    });
  });
});

// ─── termination guards ───────────────────────────────────────────────────

describe('decideNextActions — termination', () => {
  it('returns [] when run already succeeded', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    // hack: write runSucceeded directly
    await log.append({
      runId: RUN_ID,
      type: 'runSucceeded',
      actor: 'scheduler',
      payload: { outputRef: sampleOutputRef },
    });
    expect(decideNextActions(await snapshotOf(log), def)).toEqual([]);
  });

  it('returns [] when run cancelled', async () => {
    const def = twoStepLinear();
    const log = await startedLog(def);
    await log.append({
      runId: RUN_ID,
      type: 'cancelRequested',
      actor: 'human',
      payload: {
        target: { kind: 'run', runId: RUN_ID },
        by: 'ou_user',
        reason: 'no longer needed',
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'runCanceled',
      actor: 'scheduler',
      payload: { cancelOriginEventId: `${RUN_ID}-3` },
    });
    expect(decideNextActions(await snapshotOf(log), def)).toEqual([]);
  });
});

// ─── loop iteration activity IDs (v0.2 Step 1) ─────────────────────────────
//
// 4 directions codex round 3 asked us to lock:
//   1. work/gate generation produces expected shape
//   2. every segment passes the existing `isValidPathSegment` regex
//      (so attempt sidecar paths + dashboard raw-log routes keep working)
//   3. parser can recover {runId, loopId, iteration, kind, nodeId}
//   4. plain `<runId>::work::<nodeId>` ids continue to parse correctly
//      (no regression on v0.1 activities)

describe('loop iteration activity IDs', () => {
  it('loopWorkActivityId / loopGateActivityId compose the expected shape', () => {
    const w = loopWorkActivityId('run-x-01', 'review-loop', 3, 'implement');
    const g = loopGateActivityId('run-x-01', 'review-loop', 3, 'reviewDecision');
    expect(w).toBe('run-x-01::loop::review-loop.3::work::implement');
    expect(g).toBe('run-x-01::loop::review-loop.3::gate::reviewDecision');
  });

  it('rejects non-positive iteration', () => {
    expect(() => loopWorkActivityId('r', 'l', 0, 'n')).toThrow();
    expect(() => loopWorkActivityId('r', 'l', -1, 'n')).toThrow();
    expect(() => loopWorkActivityId('r', 'l', 1.5, 'n')).toThrow();
    expect(() => loopGateActivityId('r', 'l', 0, 'n')).toThrow();
  });

  it('every segment satisfies isValidPathSegment (no path-guard escape)', () => {
    const ids = [
      loopWorkActivityId('run-x-01', 'review-loop', 1, 'implement'),
      loopWorkActivityId('run-x-01', 'review-loop', 12, 'implement.v2'),
      loopGateActivityId('r2', 'L', 7, 'dec'),
    ];
    for (const id of ids) {
      // Split into `::` separated segments and verify each one would
      // survive the attempt-sidecar path guard.
      for (const seg of id.split('::')) {
        expect(isValidPathSegment(seg), `segment '${seg}' of '${id}' must pass isValidPathSegment`).toBe(true);
      }
    }
  });

  it('parseActivityId round-trips loop work ids', () => {
    const id = loopWorkActivityId('run-7', 'inner-loop', 4, 'implement');
    expect(parseActivityId(id)).toEqual({
      kind: 'loop',
      runId: 'run-7',
      loopId: 'inner-loop',
      iteration: 4,
      activityKind: 'work',
      nodeId: 'implement',
    });
  });

  it('parseActivityId round-trips loop gate ids', () => {
    const id = loopGateActivityId('run-7', 'inner-loop', 4, 'dec');
    expect(parseActivityId(id)).toEqual({
      kind: 'loop',
      runId: 'run-7',
      loopId: 'inner-loop',
      iteration: 4,
      activityKind: 'gate',
      nodeId: 'dec',
    });
  });

  it('parseActivityId still parses plain v0.1 work / gate ids', () => {
    expect(parseActivityId(workActivityId('run-1', 'foo'))).toEqual({
      kind: 'plain',
      runId: 'run-1',
      activityKind: 'work',
      nodeId: 'foo',
    });
    expect(parseActivityId(gateActivityId('run-1', 'foo'))).toEqual({
      kind: 'plain',
      runId: 'run-1',
      activityKind: 'gate',
      nodeId: 'foo',
    });
  });

  it('parseActivityId returns undefined for malformed ids', () => {
    expect(parseActivityId('not-an-activity-id')).toBeUndefined();
    expect(parseActivityId('run::weird::foo')).toBeUndefined();
    // Iteration 0 is not a valid loop activity — parser rejects.
    expect(parseActivityId('run::loop::L.0::work::foo')).toBeUndefined();
  });

  it('plain v0.1 ids do NOT collide with the loop shape parser', () => {
    // A workflow author may legitimately name a node `loop.1` (dots and
    // digits are allowed in NODE_ID_PATTERN).  Make sure that doesn't
    // get mistakenly classified as a loop activity id.
    const plain = workActivityId('run-1', 'loop.1');
    expect(plain).toBe('run-1::work::loop.1');
    const parsed = parseActivityId(plain);
    expect(parsed?.kind).toBe('plain');
    expect(parsed).toEqual({
      kind: 'plain',
      runId: 'run-1',
      activityKind: 'work',
      nodeId: 'loop.1',
    });
  });
});

describe('decideNextActions — loop / decision pass-through (Step 1 boundary)', () => {
  it('loop and decision node types are skipped by the legacy scheduler', async () => {
    // Schema has landed in v0.2 Step 1 but the loop runtime executor
    // isn't wired yet.  `decideNextActions` recognizes `loop` /
    // `decision` and silently pushes them into `pending` rather than
    // failing/succeeding.  Step 3 will intercept these upstream so
    // they never reach this branch.
    //
    // NOTE: Step 1 does NOT yet remove body-internal subagent /
    // hostExecutor nodes from top-level dispatch.  That carve-out
    // ("scheduler does not see body nodes") is part of Step 3 (see
    // /tmp/wf-loop-v02.md §4.1).  Until then a body subagent like
    // `implement` still gets dispatched normally, which is fine — the
    // loop runtime will be the only thing emitting events for it once
    // wired.
    const def = parseWorkflowDefinition({
      workflowId: 'wf-loop-step1',
      version: 1,
      nodes: {
        implement: { type: 'subagent', bot: 'b', prompt: 'x' },
        dec: {
          type: 'decision',
          depends: ['implement'],
          humanGate: { stage: 'before', prompt: 'ok?' },
        },
        'review-loop': {
          type: 'loop',
          maxIterations: 2,
          body: ['implement', 'dec'],
          terminate: { node: 'dec', via: 'humanGate' },
          output: { from: 'implement' },
        },
      },
    });
    const baseDir = mkdtempSync(join(tmpdir(), 'wf-orch-loop-step1-'));
    try {
      const log = new EventLog(RUN_ID, baseDir);
      await createRun(log, {
        def,
        params: {},
        initiator: 'tester',
        botResolver: noopResolver,
      });
      const snap = replay(await log.readAll());
      const actions = decideNextActions(snap, def);
      const dispatchedNodes = actions
        .filter((a) => a.kind === 'dispatchWork' || a.kind === 'dispatchGate')
        .map((a) => (a as { nodeId: string }).nodeId);
      // The `loop` block and the `decision` node MUST NOT be dispatched
      // by the legacy scheduler.  (Step 3 will additionally hide body
      // nodes; until then `implement` may show up here.)
      expect(dispatchedNodes).not.toContain('review-loop');
      expect(dispatchedNodes).not.toContain('dec');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
