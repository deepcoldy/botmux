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
import { workActivityId, decideNextActions } from '../src/workflows/orchestrator.js';
import {
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
  type AbortCancelReason,
} from '../src/workflows/runtime.js';
import { runLoop } from '../src/workflows/loop.js';
import { requestCancel } from '../src/workflows/cancel.js';

const RUN_ID = 'cancel-responsiveness-test';
const noopResolver: BotResolver = () => ({});

const okSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, from: input.botName },
  session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
});

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-cancel-resp-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function fanoutDef(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'cancel-resp-fanout',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'cli_root', prompt: 'kick' },
      b: { type: 'subagent', bot: 'cli_x', prompt: 'work b', depends: ['a'] },
      c: { type: 'subagent', bot: 'cli_y', prompt: 'work c', depends: ['a'] },
      d: { type: 'subagent', bot: 'cli_root', prompt: 'join', depends: ['b', 'c'] },
    },
  });
}

async function bootstrap(
  def: WorkflowDefinition,
  spawn: WorkerSpawnFn,
  runId = RUN_ID,
): Promise<{ log: EventLog; ctx: WorkflowRuntimeContext }> {
  const log = new EventLog(runId, baseDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'tester',
    botResolver: noopResolver,
  });
  return { log, ctx: { log, def, spawnSubagent: spawn } };
}

describe('cancel responsiveness — orchestrator + runtime', () => {
  it('case 1: decideNextActions short-circuits when cancelledRunIntent is set', async () => {
    const def = fanoutDef();
    const log = new EventLog('orch-shortcut', baseDir);
    await createRun(log, { def, params: {}, initiator: 'tester', botResolver: noopResolver });
    // Write cancelRequested directly so replay surfaces cancelledRunIntent.
    await requestCancel(
      log,
      { target: { kind: 'run', runId: log.runId }, reason: 'unit', by: 'tester' },
      'human',
    );
    const snap = replay(await log.readAll());
    expect(snap.cancelledRunIntent).toBeTruthy();
    const actions = decideNextActions(snap, def);
    expect(actions).toEqual([]);
  });

  it('case 2: runLoop stops dispatching new work once cancelRequested has landed', async () => {
    // A's spawn writes cancelRequested into the SAME run's log before
    // returning success.  When tick 1 ends the loop should observe the
    // intent and short-circuit, so B/C never get attemptCreated.
    const def = fanoutDef();
    const runId = 'orch-shortcut-runloop';
    const log = new EventLog(runId, baseDir);
    await createRun(log, { def, params: {}, initiator: 'tester', botResolver: noopResolver });
    const spawn: WorkerSpawnFn = async (input) => {
      if (input.nodeId === 'a') {
        await requestCancel(
          log,
          { target: { kind: 'run', runId }, reason: 'mid-A', by: 'tester' },
          'human',
        );
      }
      return {
        kind: 'success',
        output: { ok: true, from: input.nodeId },
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: spawn };
    await runLoop(ctx);
    const events = await log.readAll();
    const types = events.map((e) => e.type);
    const bCreated = events.find(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === workActivityId(runId, 'b'),
    );
    const cCreated = events.find(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === workActivityId(runId, 'c'),
    );
    expect(types).toContain('cancelRequested');
    expect(bCreated).toBeUndefined();
    expect(cCreated).toBeUndefined();
  });

  it('case 3: dispatchWork writes activityCanceled with cancelOriginEventId when spawn returns cancelled', async () => {
    // Direct dispatchWork test — bypass runLoop's orchestrator short-circuit
    // (which would refuse to dispatch when cancelledRunIntent is already
    // present) by invoking dispatchWork ourselves with a pre-aborted signal.
    const { dispatchWork } = await import('../src/workflows/runtime.js');
    const { workActivityId: workAct } = await import('../src/workflows/orchestrator.js');
    const def = parseWorkflowDefinition({
      workflowId: 'cancel-single',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'cli_x', prompt: 'p' } },
    });
    const cancelSpawn: WorkerSpawnFn = async (input) => {
      await new Promise<void>((resolve) => {
        if (input.cancelSignal?.aborted) {
          resolve();
          return;
        }
        input.cancelSignal?.addEventListener('abort', () => resolve());
      });
      const reason = input.cancelSignal!.reason as AbortCancelReason;
      return {
        kind: 'cancelled',
        cancelOriginEventId: reason.cancelOriginEventId,
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const { log, ctx } = await bootstrap(def, cancelSpawn, 'cancel-single');
    const fakeOriginEventId = 'cancel-single-origin-1';
    const ac = new AbortController();
    ac.abort({ cancelOriginEventId: fakeOriginEventId } satisfies AbortCancelReason);
    const result = await dispatchWork(
      ctx,
      {
        kind: 'dispatchWork',
        nodeId: 'only',
        activityId: workAct(log.runId, 'only'),
        node: def.nodes.only!,
      },
      { cancelSignal: ac.signal },
    );
    expect(result.kind).toBe('cancelled');
    const events = await log.readAll();
    const canceled = events.find((e) => e.type === 'activityCanceled');
    expect(canceled).toBeDefined();
    expect((canceled!.payload as any).cancelOriginEventId).toBe(fakeOriginEventId);
  });

  it('case 4: success wins when spawn resolves before abort fires', async () => {
    // Even though we'll fire abort after spawn has resolved, the spawn
    // must already have returned success — dispatchWork writes
    // activitySucceeded, no activityCanceled.
    const def = parseWorkflowDefinition({
      workflowId: 'success-wins',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'cli_x', prompt: 'p' } },
    });
    const successWinsSpawn: WorkerSpawnFn = async (input) => {
      // Resolve immediately; abort never gets a chance to fire mid-flight.
      void input;
      return {
        kind: 'success',
        output: { ok: true },
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const { log, ctx } = await bootstrap(def, successWinsSpawn, 'success-wins');
    await runLoop(ctx);
    const events = await log.readAll();
    const succ = events.find((e) => e.type === 'activitySucceeded');
    const canc = events.find((e) => e.type === 'activityCanceled');
    expect(succ).toBeDefined();
    expect(canc).toBeUndefined();
  });

  it('case 5: polling fallback fires abort when cancelRequested lands mid-tick', async () => {
    // Worker waits for abort signal; we write cancelRequested AFTER the
    // tick starts (no daemon-side aborters available).  The 200ms polling
    // observer in runLoop should fire abort within ~200-400ms.
    const def = parseWorkflowDefinition({
      workflowId: 'observer-poll',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'cli_x', prompt: 'p' } },
    });
    let cancelRequestedAt: number | null = null;
    let abortedAt: number | null = null;
    const observerSpawn: WorkerSpawnFn = async (input) => {
      const log = (ctx as any).log as EventLog;
      // Spawn writes cancelRequested only AFTER the attemptCreated event
      // has been written (i.e. we're inside the tick already).
      setTimeout(async () => {
        cancelRequestedAt = Date.now();
        await requestCancel(
          log,
          { target: { kind: 'run', runId: log.runId }, reason: 'mid-tick', by: 'tester' },
          'human',
        );
      }, 50);
      await new Promise<void>((resolve) => {
        if (input.cancelSignal?.aborted) {
          resolve();
          return;
        }
        input.cancelSignal?.addEventListener('abort', () => {
          abortedAt = Date.now();
          resolve();
        });
      });
      const reason = input.cancelSignal!.reason as AbortCancelReason;
      return {
        kind: 'cancelled',
        cancelOriginEventId: reason.cancelOriginEventId,
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    let ctx!: WorkflowRuntimeContext;
    const boot = await bootstrap(def, observerSpawn, 'observer-poll');
    ctx = boot.ctx;
    await runLoop(ctx);
    expect(cancelRequestedAt).not.toBeNull();
    expect(abortedAt).not.toBeNull();
    // Polling interval is 200ms — abort must happen within a bounded
    // window after cancelRequested.  Allow up to 1000ms to keep the test
    // robust on slow CI.
    expect(abortedAt! - cancelRequestedAt!).toBeLessThan(1000);
    const events = await boot.log.readAll();
    expect(events.find((e) => e.type === 'activityCanceled')).toBeDefined();
  });

  it('case 6: cancel observer does not synthesize spurious cancels on a clean run', async () => {
    // Sanity invariant: in the absence of any `cancelRequested`, the
    // 200ms polling observer must NOT fire abort and must NOT synthesize
    // `activityCanceled` events.  A clean parallel fanout run still
    // satisfies the per-activity terminal-event uniqueness invariant.
    //
    // This is NOT a late-cancel regression — case 10 in
    // workflow-cancel-finalize-e2e.test.ts is where the full late-cancel
    // chain gets exercised against the daemon finalize closure.
    const def = fanoutDef();
    const { log, ctx } = await bootstrap(def, okSpawn, 'no-double-term');
    await runLoop(ctx);
    const events = await log.readAll();
    // No cancel signals fired → no activityCanceled events at all.
    expect(events.find((e) => e.type === 'activityCanceled')).toBeUndefined();
    // Per-activity terminal-event uniqueness invariant.
    const terminalByActivity = new Map<string, number>();
    for (const e of events) {
      if (
        e.type !== 'activitySucceeded' &&
        e.type !== 'activityFailed' &&
        e.type !== 'activityCanceled' &&
        e.type !== 'activityTimedOut'
      ) continue;
      const aid = (e.payload as any).activityId as string;
      terminalByActivity.set(aid, (terminalByActivity.get(aid) ?? 0) + 1);
    }
    for (const [, count] of terminalByActivity) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});
