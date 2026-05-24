import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';
import {
  loopGateActivityId,
  loopWorkActivityId,
} from '../src/workflows/orchestrator.js';
import {
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
} from '../src/workflows/runtime.js';
import { runLoop } from '../src/workflows/loop.js';
import { resolveWait } from '../src/workflows/wait.js';

// ─── fixtures ─────────────────────────────────────────────────────────────
//
// End-to-end tests for v0.2 loop runtime executor (Step 3 of
// feat/workflow-loop-v02 — see /tmp/wf-loop-v02.md §4.3 + §13).
//
// Scope:
//   - happy path: implement → review → decision approve → loop succeeded
//   - multi-reject → eventual approve
//   - max-iterations-exceeded → run fails with LoopMaxIterationsExceeded
//   - decision reject writes `activitySucceeded` (NOT `activityFailed`) —
//     verifies wait.ts decision-mode (N2)
//   - non-terminator humanGate.reject inside loop body still fails the
//     run (§10.8)

const RUN_ID = 'run-loop-rt-01';
const noopResolver: BotResolver = () => ({});

const successSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, code: `code-${input.botName}` },
  session: {
    sessionId: `s-${input.activityId}`,
    botName: input.botName,
    startedAt: 0,
  },
});

function reviewLoopDef(maxIterations = 3): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'code-review-loop',
    version: 1,
    nodes: {
      implement: {
        type: 'subagent',
        bot: 'cli_a',
        prompt: 'implement task',
      },
      review: {
        type: 'subagent',
        bot: 'cli_b',
        depends: ['implement'],
        prompt: 'review code',
      },
      reviewDecision: {
        type: 'decision',
        depends: ['review'],
        humanGate: {
          stage: 'before',
          prompt: 'approve?',
        },
      },
      'review-loop': {
        type: 'loop',
        maxIterations,
        body: ['implement', 'review', 'reviewDecision'],
        terminate: { node: 'reviewDecision', via: 'humanGate' },
        output: { from: 'implement' },
      },
    },
  });
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-loop-rt-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function bootstrap(
  def: WorkflowDefinition,
  spawn: WorkerSpawnFn = successSpawn,
): Promise<{ log: EventLog; ctx: WorkflowRuntimeContext }> {
  const log = new EventLog(RUN_ID, baseDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'tester',
    botResolver: noopResolver,
  });
  return { log, ctx: { log, def, spawnSubagent: spawn } };
}

async function resolveDecision(
  log: EventLog,
  def: WorkflowDefinition,
  loopId: string,
  iteration: number,
  decisionNodeId: string,
  resolution: 'approved' | 'rejected',
  by = 'ou_reviewer',
  comment?: string,
): Promise<void> {
  const decisionActId = loopGateActivityId(RUN_ID, loopId, iteration, decisionNodeId);
  const snap = replay(await log.readAll());
  const decisionAct = snap.activities.get(decisionActId);
  if (!decisionAct?.currentAttemptId) {
    throw new Error(`decision attempt missing for ${decisionActId}`);
  }
  await resolveWait(
    log,
    {
      activityId: decisionActId,
      attemptId: decisionAct.currentAttemptId,
      resolution,
      by,
      ...(comment ? { comment } : {}),
    },
    { def },
  );
}

// ─── happy path ───────────────────────────────────────────────────────────

describe('runLoop — loop v0.2 happy path', () => {
  it('iteration 1 approve → loop succeeded in one round', async () => {
    const def = reviewLoopDef();
    const { log, ctx } = await bootstrap(def);

    // First runLoop drives until decision gate is awaiting human input.
    const first = await runLoop(ctx);
    expect(first.reason).toBe('awaiting-wait');

    // Iteration 1 should be running, body activities all dispatched.
    const snap1 = first.lastSnapshot;
    const loop1 = snap1.loops.get('review-loop');
    expect(loop1?.status).toBe('running');
    expect(loop1?.iteration).toBe(1);
    expect(snap1.activities.has(
      loopWorkActivityId(RUN_ID, 'review-loop', 1, 'implement'),
    )).toBe(true);
    expect(snap1.activities.has(
      loopWorkActivityId(RUN_ID, 'review-loop', 1, 'review'),
    )).toBe(true);
    expect(snap1.activities.has(
      loopGateActivityId(RUN_ID, 'review-loop', 1, 'reviewDecision'),
    )).toBe(true);

    // Approve the decision; loop should close as succeeded.
    await resolveDecision(log, def, 'review-loop', 1, 'reviewDecision', 'approved');
    const second = await runLoop(ctx);
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('succeeded');

    const finalSnap = replay(await log.readAll());
    const finalLoop = finalSnap.loops.get('review-loop');
    expect(finalLoop?.status).toBe('succeeded');
    expect(finalLoop?.iteration).toBe(1);
    expect(finalLoop?.iterations[0]?.status).toBe('approved');
    // output.from='implement' projection
    expect(finalLoop?.output?.outputHash).toMatch(/^sha256:/);
  });
});

// ─── multi-iteration: reject then approve ─────────────────────────────────

describe('runLoop — multi-iteration reject → approve', () => {
  it('reject iter 1 → iter 2 → reject 2 → iter 3 approve → succeeded', async () => {
    const def = reviewLoopDef(3);
    const { log, ctx } = await bootstrap(def);

    // Iteration 1
    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 1, 'reviewDecision', 'rejected', 'ou_r', 'not yet');

    // Iteration 2
    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 2, 'reviewDecision', 'rejected', 'ou_r', 'still bad');

    // Iteration 3 (final allowed)
    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 3, 'reviewDecision', 'approved');

    const last = await runLoop(ctx);
    expect(last.reason).toBe('terminal');
    expect(last.lastSnapshot.run.status).toBe('succeeded');

    const snap = replay(await log.readAll());
    const loop = snap.loops.get('review-loop');
    expect(loop?.status).toBe('succeeded');
    expect(loop?.iteration).toBe(3);
    expect(loop?.iterations.map((it) => it.status)).toEqual([
      'rejected',
      'rejected',
      'approved',
    ]);
    expect(loop?.iterations[0]?.decisionComment).toBe('not yet');
    expect(loop?.iterations[1]?.decisionComment).toBe('still bad');
    // Each iteration has its own audit anchors (codex round 2 N3).
    for (const it of loop?.iterations ?? []) {
      expect(it.decisionActivityId).toMatch(/::loop::review-loop\.\d+::gate::reviewDecision$/);
      expect(it.waitResolvedEventId).toMatch(/-\d+$/);
    }
  });
});

// ─── max-iterations-exceeded ──────────────────────────────────────────────

describe('runLoop — max-iterations-exceeded', () => {
  it('reject every iteration up to maxIterations → loop failed', async () => {
    const def = reviewLoopDef(2);
    const { log, ctx } = await bootstrap(def);

    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 1, 'reviewDecision', 'rejected');
    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 2, 'reviewDecision', 'rejected');
    const last = await runLoop(ctx);
    // After exhausting attempts, the loop closes as failed (run-level
    // failure once propagated).
    expect(last.reason).toBe('terminal');

    const snap = replay(await log.readAll());
    const loop = snap.loops.get('review-loop');
    expect(loop?.status).toBe('failed');
    expect(loop?.errorCode).toBe('LoopMaxIterationsExceeded');
    expect(loop?.errorClass).toBe('userFault');
    expect(loop?.iteration).toBe(2);
    expect(loop?.iterations.map((it) => it.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(snap.run.status).toBe('failed');
  });
});

// ─── decision reject = activitySucceeded (NOT activityFailed) ─────────────

describe('runLoop — decision wait.ts semantics (N2)', () => {
  it('decision reject writes activitySucceeded with {resolution:"rejected"}', async () => {
    const def = reviewLoopDef(2);
    const { log, ctx } = await bootstrap(def);
    await runLoop(ctx);

    const decisionActId = loopGateActivityId(RUN_ID, 'review-loop', 1, 'reviewDecision');
    const beforeSnap = replay(await log.readAll());
    expect(beforeSnap.activities.get(decisionActId)?.status).not.toBe('succeeded');

    await resolveDecision(
      log,
      def,
      'review-loop',
      1,
      'reviewDecision',
      'rejected',
      'ou_r',
      'wants revision',
    );

    const afterSnap = replay(await log.readAll());
    const decisionAct = afterSnap.activities.get(decisionActId);
    // The wait terminal MUST be activitySucceeded — reject is a legal
    // decision output, not a failure.  Plain humanGate reject still
    // maps to activityFailed (covered in workflow-loop.test.ts).
    expect(decisionAct?.status).toBe('succeeded');
    const lastAt = decisionAct?.attempts[decisionAct.attempts.length - 1];
    expect(lastAt?.wait?.resolution?.kind).toBe('resolved');
    if (lastAt?.wait?.resolution?.kind === 'resolved') {
      expect(lastAt.wait.resolution.resolution).toBe('rejected');
      expect(lastAt.wait.resolution.comment).toBe('wants revision');
    }
  });
});

// ─── non-terminator humanGate inside body still fails the run ─────────────

describe('runLoop — non-terminator humanGate.reject in loop body (§10.8)', () => {
  it('reject on a body subagent (not the terminator) fails the run', async () => {
    // Add a humanGate on `implement` — non-terminator.  Reject must
    // fail-run, not open a new iteration.
    const def = parseWorkflowDefinition({
      workflowId: 'review-loop-body-gate',
      version: 1,
      nodes: {
        implement: {
          type: 'subagent',
          bot: 'cli_a',
          prompt: 'implement',
          humanGate: { stage: 'before', prompt: 'ok to implement?' },
        },
        reviewDecision: {
          type: 'decision',
          depends: ['implement'],
          humanGate: { stage: 'before', prompt: 'approve?' },
        },
        'review-loop': {
          type: 'loop',
          maxIterations: 3,
          body: ['implement', 'reviewDecision'],
          terminate: { node: 'reviewDecision', via: 'humanGate' },
        },
      },
    });
    const { log, ctx } = await bootstrap(def);

    // First runLoop pauses at the implement gate.
    await runLoop(ctx);

    const implementGateId = loopGateActivityId(RUN_ID, 'review-loop', 1, 'implement');
    const snap = replay(await log.readAll());
    const gateAct = snap.activities.get(implementGateId);
    if (!gateAct?.currentAttemptId) throw new Error('implement gate not dispatched');

    // Reject the non-terminator gate.  No `def` in ctx ⇒ plain wait
    // semantics ⇒ activityFailed.
    await resolveWait(log, {
      activityId: implementGateId,
      attemptId: gateAct.currentAttemptId,
      resolution: 'rejected',
      by: 'ou_user',
      comment: 'no',
    });

    // Subsequent runLoop must finalize the run as failed — NOT open a
    // new iteration.
    const last = await runLoop(ctx);
    expect(last.reason).toBe('terminal');
    expect(last.lastSnapshot.run.status).toBe('failed');

    const finalSnap = replay(await log.readAll());
    const loop = finalSnap.loops.get('review-loop');
    // Non-terminator body failure uses `cancelled` resolution as the
    // abnormal-termination bucket (LoopFinishedPayload doesn't yet have
    // a `'body-failed'` resolution; `max-iterations-exceeded` is locked
    // to errorCode='LoopMaxIterationsExceeded' by codex Step 2 invariant
    // — so we route through `cancelled` and rely on the run-level
    // failedNodeId propagation to surface the run as failed).
    expect(loop?.status).toBe('cancelled');
    expect(loop?.iteration).toBe(1);
    // Iteration stays `running` because `loopFinished` (codex Step 2)
    // doesn't retroactively close the in-flight iteration entry — the
    // loop-level `cancelled` status already conveys "this iteration
    // never reached a decision".  A follow-up could have loopFinished
    // null-out the in-flight iteration status; not needed for v0.2.
    expect(loop?.iterations[0]?.status).toBe('running');
  });
});

// ─── loop output projection (N4 virtual outputRef) ────────────────────────

describe('runLoop — output projection (N4)', () => {
  it('loop block output = projection of body node (implement) latest', async () => {
    const def = reviewLoopDef(2);
    const { log, ctx } = await bootstrap(def);

    await runLoop(ctx);
    await resolveDecision(log, def, 'review-loop', 1, 'reviewDecision', 'approved');
    await runLoop(ctx);

    const snap = replay(await log.readAll());
    const loop = snap.loops.get('review-loop');
    expect(loop?.status).toBe('succeeded');
    // loopFinished.outputRef is published into outputs[workActivityId(runId, loopId)]
    // so plain `${review-loop.output.x}` resolves uniformly.
    const projectedOutput = snap.outputs.get(
      'run-loop-rt-01::work::review-loop',
    );
    expect(projectedOutput).toBeDefined();
    expect(projectedOutput).toEqual(loop?.output);
    // Should match the implement body activity's own output ref.
    const implementOut = snap.outputs.get(
      loopWorkActivityId(RUN_ID, 'review-loop', 1, 'implement'),
    );
    expect(projectedOutput?.outputHash).toBe(implementOut?.outputHash);
  });
});
