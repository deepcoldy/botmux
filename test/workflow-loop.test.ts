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
import { gateActivityId, workActivityId } from '../src/workflows/orchestrator.js';
import {
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
} from '../src/workflows/runtime.js';
import { runLoop } from '../src/workflows/loop.js';
import { resolveWait } from '../src/workflows/wait.js';

const RUN_ID = 'run-loop-test-01';
const noopResolver: BotResolver = () => ({});

const successSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, from: input.botName },
  session: {
    sessionId: `s-${input.activityId}`,
    botName: input.botName,
    startedAt: 0,
  },
});

function linear(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'linear-loop',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b', prompt: 'a' },
      b: { type: 'subagent', bot: 'b', prompt: 'b', depends: ['a'] },
    },
  });
}

function gated(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'gated-loop',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b', prompt: 'a' },
      gated: {
        type: 'subagent',
        bot: 'b',
        prompt: 'gated',
        depends: ['a'],
        humanGate: { stage: 'before', prompt: 'ok?', onTimeout: 'fail' },
      },
    },
  });
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-loop-'));
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

// ─── linear, no gate ─────────────────────────────────────────────────────

describe('runLoop — linear workflow', () => {
  it('drives run to terminal success in finite ticks', async () => {
    const def = linear();
    const { log, ctx } = await bootstrap(def);
    const result = await runLoop(ctx);
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');
    expect(result.ticks).toBeGreaterThan(0);

    const snap = replay(await log.readAll());
    expect(snap.run.output?.outputHash).toMatch(/^sha256:/);
  });
});

// ─── humanGate flow ───────────────────────────────────────────────────────

describe('runLoop — humanGate', () => {
  it('pauses at awaiting-wait when gate raised, resumes after approval', async () => {
    const def = gated();
    const { log, ctx } = await bootstrap(def);

    const first = await runLoop(ctx);
    expect(first.reason).toBe('awaiting-wait');
    expect(first.lastSnapshot.run.status).toBe('running');

    // External event: human approves
    const snap = first.lastSnapshot;
    const gateActId = gateActivityId(RUN_ID, 'gated');
    const gateAct = snap.activities.get(gateActId);
    if (!gateAct?.currentAttemptId) throw new Error('gate attempt missing');
    await resolveWait(log, {
      activityId: gateActId,
      attemptId: gateAct.currentAttemptId,
      resolution: 'approved',
      by: 'ou_user',
    });

    const second = await runLoop(ctx);
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('succeeded');
  });

  it('gate rejection terminates run as failed', async () => {
    const def = gated();
    const { log, ctx } = await bootstrap(def);
    const first = await runLoop(ctx);
    expect(first.reason).toBe('awaiting-wait');

    const gateActId = gateActivityId(RUN_ID, 'gated');
    const gateAct = first.lastSnapshot.activities.get(gateActId);
    if (!gateAct?.currentAttemptId) throw new Error();
    await resolveWait(log, {
      activityId: gateActId,
      attemptId: gateAct.currentAttemptId,
      resolution: 'rejected',
      by: 'ou_user',
      comment: 'no',
    });

    const second = await runLoop(ctx);
    expect(second.reason).toBe('terminal');
    expect(second.lastSnapshot.run.status).toBe('failed');
  });
});

// ─── safety ──────────────────────────────────────────────────────────────

describe('runLoop — safety', () => {
  it('respects maxTicks cap', async () => {
    const def = linear();
    const { ctx } = await bootstrap(def);
    const result = await runLoop(ctx, { maxTicks: 1 });
    // 1 tick is not enough to finish; expect either max-ticks or
    // a paused state — both indicate the cap held.
    expect(['max-ticks', 'terminal', 'awaiting-wait', 'no-progress']).toContain(
      result.reason,
    );
    expect(result.ticks).toBeLessThanOrEqual(1);
  });

  it('reports terminal even if maxTicks coincides with last terminal tick', async () => {
    // Tiny workflow: 1 step.  Each "tick" writes 2 events at most
    // (dispatchWork + completeNodeSucceeded + completeRunSucceeded
    // spread across ticks).  Pick a cap that makes the last tick the
    // one that writes runSucceeded; verify we report `terminal`, not
    // `max-ticks`.
    const def = parseWorkflowDefinition({
      workflowId: 'one-step',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', prompt: 'x' } },
    });
    const { ctx } = await bootstrap(def);
    // Compute the actual tick count needed by running without cap once,
    // then re-running with the cap set to that exact value.
    const drySnapBaseDir = mkdtempSync(join(tmpdir(), 'wf-loop-dry-'));
    try {
      const dryLog = new EventLog('dry', drySnapBaseDir);
      await createRun(dryLog, {
        def,
        params: {},
        initiator: 't',
        botResolver: noopResolver,
      });
      const dry = await runLoop({ log: dryLog, def, spawnSubagent: successSpawn });
      const exactCap = dry.ticks;
      const result = await runLoop(ctx, { maxTicks: exactCap });
      expect(result.reason).toBe('terminal');
    } finally {
      rmSync(drySnapBaseDir, { recursive: true, force: true });
    }
  });

  it('hostExecutor failure propagates to run failed', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'host-loop',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: { msg: 'hi' },
          // Test is exercising the loop's hostExecutor-failure path, not the
          // side-effect gate semantics.  Opt in so parse succeeds.
          unsafeAllowUngated: true,
        },
      },
    });
    const { ctx } = await bootstrap(def);
    const result = await runLoop(ctx);
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('failed');
  });

  it('recovers a dangling non-effect activity as WorkerCrashed before deciding next actions', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'dangling-subagent',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', prompt: 'x' } },
    });
    const { log, ctx } = await bootstrap(def);
    const activityId = workActivityId(RUN_ID, 'only');
    const attemptId = `${activityId}::att-1`;
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'only',
        activityId,
        attemptId,
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + '1'.repeat(64),
          outputBytes: 1,
          outputSchemaVersion: 1,
        },
      },
    });

    const result = await runLoop(ctx);

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('failed');
    const events = await log.readAll();
    const failed = events.find((e) => e.type === 'activityFailed');
    expect(failed?.payload).toMatchObject({
      activityId,
      attemptId,
      error: {
        errorCode: 'WorkerCrashed',
        errorClass: 'retryable',
      },
    });
  });
});
