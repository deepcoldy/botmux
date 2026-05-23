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
import { workActivityId } from '../src/workflows/orchestrator.js';
import {
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
} from '../src/workflows/runtime.js';
import { runLoop } from '../src/workflows/loop.js';

const RUN_ID = 'parallel-loop-test';
const noopResolver: BotResolver = () => ({});

const okSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, from: input.botName },
  session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
});

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-parallel-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function fanoutDef(opts: { maxConcurrency?: number; bot?: { x: string; y: string } } = {}): WorkflowDefinition {
  const botX = opts.bot?.x ?? 'cli_x';
  const botY = opts.bot?.y ?? 'cli_y';
  return parseWorkflowDefinition({
    workflowId: 'parallel-fanout',
    version: 1,
    ...(opts.maxConcurrency !== undefined
      ? { defaults: { maxConcurrency: opts.maxConcurrency } }
      : {}),
    nodes: {
      a: { type: 'subagent', bot: 'cli_root', prompt: 'kick' },
      b: { type: 'subagent', bot: botX, prompt: 'do b', depends: ['a'] },
      c: { type: 'subagent', bot: botY, prompt: 'do c', depends: ['a'] },
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

describe('runLoop — parallel dispatch', () => {
  it('fans out sibling work concurrently and joins on success', async () => {
    const entered: string[] = [];
    let releaseB: () => void = () => {};
    let releaseC: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      // Resolve only once both b and c have entered their spawn.  This is
      // the strong proof that the loop dispatched them concurrently — if
      // the loop awaited b before starting c we'd deadlock here.
      const seen = new Set<string>();
      const onEnter = (nodeId: string) => {
        seen.add(nodeId);
        if (seen.has('b') && seen.has('c')) resolve();
      };
      (entered as any).onEnter = onEnter;
    });
    const bPromise = new Promise<void>((r) => (releaseB = r));
    const cPromise = new Promise<void>((r) => (releaseC = r));
    const spawn: WorkerSpawnFn = async (input) => {
      entered.push(input.nodeId);
      (entered as any).onEnter?.(input.nodeId);
      if (input.nodeId === 'b') await bPromise;
      if (input.nodeId === 'c') await cPromise;
      return {
        kind: 'success',
        output: { ok: true, from: input.nodeId },
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const def = fanoutDef();
    const { log, ctx } = await bootstrap(def, spawn);
    // Release b/c once both have entered to prove concurrency, then let
    // the loop finish.
    const releaser = bothEntered.then(() => {
      releaseB();
      releaseC();
    });
    const result = await runLoop(ctx);
    await releaser;
    expect(result.reason).toBe('terminal');
    const events = await log.readAll();
    const types = events.map((e) => e.type);
    // d must succeed only after both b and c succeeded
    const idx = (predicate: (e: any) => boolean) => events.findIndex(predicate);
    const bSuccess = idx((e) => e.type === 'activitySucceeded' && (e.payload as any).activityId === workActivityId(log.runId, 'b'));
    const cSuccess = idx((e) => e.type === 'activitySucceeded' && (e.payload as any).activityId === workActivityId(log.runId, 'c'));
    const dCreated = idx((e) => e.type === 'attemptCreated' && (e.payload as any).nodeId === 'd');
    expect(bSuccess).toBeGreaterThan(-1);
    expect(cSuccess).toBeGreaterThan(-1);
    expect(dCreated).toBeGreaterThan(Math.max(bSuccess, cSuccess));
    expect(types).toContain('runSucceeded');
  });

  it('isolates a hard throw in one sibling — others still settle', async () => {
    const spawn: WorkerSpawnFn = async (input) => {
      if (input.nodeId === 'b') {
        throw new Error('worker exploded on b');
      }
      return {
        kind: 'success',
        output: { ok: true, from: input.nodeId },
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const def = fanoutDef();
    const { log, ctx } = await bootstrap(def, spawn);
    const result = await runLoop(ctx);
    // c succeeded; b should be infra-failed; d never dispatched because b failed
    const events = await log.readAll();
    const cActId = workActivityId(log.runId, 'c');
    const bActId = workActivityId(log.runId, 'b');
    const cSuccess = events.find(
      (e) => e.type === 'activitySucceeded' && (e.payload as any).activityId === cActId,
    );
    const bFailed = events.find(
      (e) => e.type === 'activityFailed' && (e.payload as any).activityId === bActId,
    );
    expect(cSuccess).toBeDefined();
    expect(bFailed).toBeDefined();
    expect((bFailed!.payload as any).error.errorClass).toBe('fatal');
    expect((bFailed!.payload as any).error.errorCode).toBe('WorkerCrashed');
    expect(['failed', 'no-progress', 'terminal']).toContain(result.reason);
    const snapshot = replay(events);
    expect(snapshot.run.status).toBe('failed');
  });

  it('serializes same-bot siblings into separate ticks', async () => {
    const def = fanoutDef({ bot: { x: 'cli_shared', y: 'cli_shared' } });
    const entered: string[] = [];
    const spawn: WorkerSpawnFn = async (input) => {
      entered.push(input.nodeId);
      return {
        kind: 'success',
        output: { ok: true, from: input.nodeId },
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const { log, ctx } = await bootstrap(def, spawn);
    const result = await runLoop(ctx);
    expect(result.reason).toBe('terminal');
    // b and c both happen, but `entered` shows them in distinct order
    // (no interleave) — the second one only starts after the first
    // attemptCreated landed in the previous tick.
    const events = await log.readAll();
    const bActId = workActivityId(log.runId, 'b');
    const cActId = workActivityId(log.runId, 'c');
    const bCreated = events.findIndex(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === bActId,
    );
    const cCreated = events.findIndex(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === cActId,
    );
    const bSucceeded = events.findIndex(
      (e) => e.type === 'activitySucceeded' && (e.payload as any).activityId === bActId,
    );
    const cSucceeded = events.findIndex(
      (e) => e.type === 'activitySucceeded' && (e.payload as any).activityId === cActId,
    );
    // The later attemptCreated must come AFTER the earlier succeeded —
    // same-bot work cannot overlap.
    const firstCreated = Math.min(bCreated, cCreated);
    const firstSucceeded = bCreated < cCreated ? bSucceeded : cSucceeded;
    const secondCreated = Math.max(bCreated, cCreated);
    expect(firstCreated).toBeGreaterThan(-1);
    expect(firstSucceeded).toBeGreaterThan(firstCreated);
    expect(secondCreated).toBeGreaterThan(firstSucceeded);
  });

  it('honors maxConcurrency=1 by single-stepping siblings', async () => {
    // With cap=1, b and c can't both dispatch in the same tick even though
    // they're on different bots.  Verify by attemptCreated ordering.
    const def = fanoutDef({ maxConcurrency: 1 });
    const def2 = def; // alias just to keep naming consistent
    const { log, ctx } = await bootstrap(def2, okSpawn);
    const result = await runLoop(ctx);
    expect(result.reason).toBe('terminal');
    const events = await log.readAll();
    const bActId = workActivityId(log.runId, 'b');
    const cActId = workActivityId(log.runId, 'c');
    const bCreated = events.findIndex(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === bActId,
    );
    const cCreated = events.findIndex(
      (e) => e.type === 'attemptCreated' && (e.payload as any).activityId === cActId,
    );
    const earlierSucceeded = events.findIndex(
      (e, idx) =>
        e.type === 'activitySucceeded' &&
        idx > Math.min(bCreated, cCreated) &&
        idx < Math.max(bCreated, cCreated),
    );
    expect(earlierSucceeded).toBeGreaterThan(-1);
  });

  // NOTE: cancel-during-parallel-inflight semantics are deliberately NOT
  // exercised here.  The orchestrator does not check `cancelledRunIntent`
  // before emitting fresh dispatches, so a cancel that arrives between
  // tick start and the next replay can be racefully overrun by late
  // `activitySucceeded` events from in-flight workers.  Pre-dispatch
  // cancel chains are driven by `cancelWorkflowRun()` from
  // `cancel-run.ts`, not `runLoop`, and are covered by
  // `workflow-cancel.test.ts`.  Tightening the orchestrator to honor
  // `cancelledRunIntent` mid-loop is a v0.1.4 follow-up.

  it('does not double-terminal an activity when dispatch wrote terminal then threw', async () => {
    // Targeted regression for the allSettled fallback path: monkey-patch
    // EventLog.append so that the moment dispatchWork tries to append
    // `activitySucceeded` for node b, the real event is written THEN the
    // append throws a synthetic error.  That propagates through
    // dispatchWork → allSettled-reject.  Replay must then see b's
    // activity already succeeded, and `maybePatchInfrastructureFailure`
    // must return `alreadyTerminal` instead of appending a second
    // terminal event.
    const def = fanoutDef();
    const { log, ctx } = await bootstrap(def, okSpawn);

    const bActivityId = workActivityId(log.runId, 'b');
    const origAppend = log.append.bind(log);
    let injected = false;
    (log as any).append = async (draft: any) => {
      const event = await origAppend(draft);
      if (
        !injected &&
        draft.type === 'activitySucceeded' &&
        draft.payload?.activityId === bActivityId
      ) {
        injected = true;
        throw new Error('synthetic post-terminal failure');
      }
      return event;
    };

    await runLoop(ctx);
    expect(injected).toBe(true);

    // Restore so the readAll below doesn't go through the patched fn.
    (log as any).append = origAppend;
    const events = await log.readAll();

    // Per-activity terminal-event uniqueness invariant.  b should have
    // exactly ONE activitySucceeded (the one we wrote before throwing),
    // and ZERO follow-up activityFailed from the fallback path.
    let bSucceededCount = 0;
    let bFailedCount = 0;
    for (const e of events) {
      const aid = (e.payload as any).activityId;
      if (aid !== bActivityId) continue;
      if (e.type === 'activitySucceeded') bSucceededCount++;
      if (e.type === 'activityFailed') bFailedCount++;
    }
    expect(bSucceededCount).toBe(1);
    expect(bFailedCount).toBe(0);
  });

  it('stops the run when dispatch throws before attemptCreated (pre-attempt throw)', async () => {
    // M1 regression: if dispatch blows up before writing attemptCreated,
    // there's no attemptId to pin a failure to.  Without the unpatchable
    // path, the loop would re-emit the same dispatch every tick until
    // maxTicks.  Verify we bail out as no-progress promptly.
    const def = fanoutDef();
    const { log, ctx } = await bootstrap(def, okSpawn);

    const bActivityId = workActivityId(log.runId, 'b');
    const origAppend = log.append.bind(log);
    (log as any).append = async (draft: any) => {
      if (
        draft.type === 'attemptCreated' &&
        draft.payload?.activityId === bActivityId
      ) {
        throw new Error('synthetic pre-attempt log write failure');
      }
      return origAppend(draft);
    };

    const result = await runLoop(ctx, { maxTicks: 50 });
    expect(result.reason).toBe('no-progress');
    // ticks should be small (we caught it on the first tick that tried
    // to dispatch b); definitely not anywhere near the cap.
    expect(result.ticks).toBeLessThan(5);
  });

  it('concurrent EventLog.append calls maintain seq monotonicity and NDJSON integrity', async () => {
    const log = new EventLog('concurrent-append-test', baseDir);
    await createRun(log, {
      def: parseWorkflowDefinition({
        workflowId: 'append-safety',
        version: 1,
        nodes: { z: { type: 'subagent', bot: 'b', prompt: 'z' } },
      }),
      params: {},
      initiator: 't',
      botResolver: noopResolver,
    });
    // Hammer the log: 30 concurrent appends.  Use cancelRequested whose
    // payload is the simplest run-targeted shape (target + reason + by).
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.append({
          runId: log.runId,
          type: 'cancelRequested',
          actor: 'system',
          payload: {
            target: { kind: 'run', runId: log.runId },
            reason: `hammer ${i}`,
            by: 'tester',
          },
        }),
      ),
    );
    const events = await log.readAll();
    // seq is encoded in eventId as `<runId>-<seq>`.  Verify strictly
    // monotonic seq + every line parses cleanly (no NDJSON corruption).
    let lastSeq = -1;
    for (const e of events) {
      expect(typeof e.eventId).toBe('string');
      expect(typeof e.type).toBe('string');
      const match = e.eventId.match(/-(\d+)$/);
      expect(match).not.toBeNull();
      const seq = Number(match![1]);
      expect(seq).toBeGreaterThan(lastSeq);
      lastSeq = seq;
    }
    // 30 hammer appends + the 2 runCreated/runStarted from createRun.
    expect(events.length).toBe(N + 2);
  });
});

