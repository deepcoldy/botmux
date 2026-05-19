import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';
import {
  decideNextActions,
  gateActivityId,
  workActivityId,
} from '../src/workflows/orchestrator.js';
import {
  completeNodeFailed,
  completeNodeSucceeded,
  completeRunFailed,
  completeRunSucceeded,
  dispatchGate,
  dispatchWork,
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
} from '../src/workflows/runtime.js';
import { resolveWait } from '../src/workflows/wait.js';

const RUN_ID = 'run-runtime-test-01';
const noopResolver: BotResolver = () => ({});

function gatedDef(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'gated',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b1', prompt: 'do a' },
      gated: {
        type: 'subagent',
        bot: 'b2',
        prompt: 'do gated thing',
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

function linearDef(): WorkflowDefinition {
  return parseWorkflowDefinition({
    workflowId: 'linear',
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'b1', prompt: 'do a' },
      b: { type: 'subagent', bot: 'b2', prompt: 'do b', depends: ['a'] },
    },
  });
}

const successSpawn: WorkerSpawnFn = async (input) => ({
  kind: 'success',
  output: { ok: true, prompt: input.prompt, bot: input.botName },
  session: {
    sessionId: `sess-${input.activityId}-${input.attemptId}`,
    botName: input.botName,
    cliId: 'claude-code',
    workingDir: input.workingDir,
    webPort: 7878,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_234,
  },
});

const crashSpawn: WorkerSpawnFn = async () => ({
  kind: 'failure',
  errorCode: 'WorkerCrashed',
  errorClass: 'retryable',
  errorMessage: 'fake crash',
});

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-runtime-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function bootstrap(
  def: WorkflowDefinition,
  spawn: WorkerSpawnFn,
): Promise<{ log: EventLog; ctx: WorkflowRuntimeContext }> {
  const log = new EventLog(RUN_ID, baseDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'tester',
    botResolver: noopResolver,
  });
  const ctx: WorkflowRuntimeContext = {
    log,
    def,
    spawnSubagent: spawn,
    now: () => 1_700_000_000_000,
  };
  return { log, ctx };
}

// ─── dispatchGate ────────────────────────────────────────────────────────

describe('dispatchGate', () => {
  it('writes attemptCreated(gate) + waitCreated', async () => {
    const def = gatedDef();
    const { log, ctx } = await bootstrap(def, successSpawn);

    // satisfy 'a' first so 'gated' is dispatchable
    await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    await completeNodeSucceeded(ctx, {
      kind: 'completeNodeSucceeded',
      nodeId: 'a',
      lastActivityId: workActivityId(RUN_ID, 'a'),
      outputRef: replay(await log.readAll()).outputs.get(workActivityId(RUN_ID, 'a'))!,
    });

    const actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate');
    if (!gateAction || gateAction.kind !== 'dispatchGate') throw new Error('no gate action');

    const { attemptId, attemptCreated, waitCreated } = await dispatchGate(ctx, gateAction);

    expect(attemptCreated.payload).toMatchObject({
      nodeId: 'gated',
      activityId: gateActivityId(RUN_ID, 'gated'),
      attemptId,
      attemptNumber: 1,
    });
    expect(waitCreated.payload).toMatchObject({
      activityId: gateActivityId(RUN_ID, 'gated'),
      waitKind: 'human-gate',
      prompt: 'approve?',
      onTimeout: 'fail',
    });
    const waitP = waitCreated.payload as { deadlineAt: number };
    expect(waitP.deadlineAt).toBe(1_700_000_000_000 + 60_000);
  });

  it('orchestrator decides dispatchGate is no longer needed after gate raised', async () => {
    const def = gatedDef();
    const { log, ctx } = await bootstrap(def, successSpawn);

    // 'a' done
    const aOut = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    if (aOut.kind !== 'succeeded') throw new Error('a should succeed');
    await completeNodeSucceeded(ctx, {
      kind: 'completeNodeSucceeded',
      nodeId: 'a',
      lastActivityId: workActivityId(RUN_ID, 'a'),
      outputRef: aOut.outputRef,
    });

    // raise gate
    const actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate')!;
    if (gateAction.kind !== 'dispatchGate') throw new Error();
    await dispatchGate(ctx, gateAction);

    // orchestrator should now return [] (gate waiting)
    expect(decideNextActions(replay(await log.readAll()), def)).toEqual([]);
  });
});

// ─── dispatchWork: subagent path ────────────────────────────────────────

describe('dispatchWork — subagent', () => {
  it('happy path writes attemptCreated → activityRunning → activitySucceeded + session sidecar', async () => {
    const def = linearDef();
    const { log, ctx } = await bootstrap(def, successSpawn);
    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    expect(result.kind).toBe('succeeded');

    const events = await log.readAll();
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'activitySucceeded',
    ]);

    // session sidecar
    if (result.kind !== 'succeeded') return;
    const sidecarPath = join(
      log.runDir,
      'attempts',
      workActivityId(RUN_ID, 'a'),
      result.attemptId,
      'session.json',
    );
    expect(existsSync(sidecarPath)).toBe(true);
    const session = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    expect(session.botName).toBe('b1');
    expect(session.webPort).toBe(7878);
  });

  it('crash path writes activityFailed', async () => {
    const def = linearDef();
    const { log, ctx } = await bootstrap(def, crashSpawn);
    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    expect(result.kind).toBe('failed');
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toContain('activityFailed');
    const failed = events.find((e) => e.type === 'activityFailed')!;
    const p = failed.payload as { error: { errorCode: string; errorClass: string } };
    expect(p.error.errorCode).toBe('WorkerCrashed');
    expect(p.error.errorClass).toBe('retryable');
  });

  it('hostExecutor writes attemptCreated + activityFailed{manual} terminal in v0', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-host',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: { msg: 'hi' },
        },
      },
    });
    const { log, ctx } = await bootstrap(def, successSpawn);
    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'h',
      activityId: workActivityId(RUN_ID, 'h'),
      node: def.nodes.h!,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.errorCode).toBe('UnknownProviderError');
    expect(result.errorClass).toBe('manual');

    const events = await log.readAll();
    const types = events.map((e) => e.type);
    expect(types).toContain('attemptCreated');
    expect(types).toContain('activityFailed');

    // Critical: orchestrator's next tick should see the terminal and emit
    // completeNodeFailed (NOT another dispatchWork → infinite loop)
    const snap = replay(events);
    const next = decideNextActions(snap, def);
    expect(next.map((a) => a.kind)).toEqual(['completeNodeFailed']);
  });
});

// ─── end-to-end loop via decideNextActions ───────────────────────────────

// ─── botSnapshot consumption ────────────────────────────────────────────

describe('botSnapshots reach the spawner', () => {
  it('snapshot frozen at runCreated is passed to spawnSubagent.botSnapshot', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'snap-bot',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'pinned-bot', prompt: 'do it' },
      },
    });

    const captured: Array<{ botName: string; botSnapshot?: unknown; workingDir?: string }> = [];
    const captureSpawn: WorkerSpawnFn = async (input) => {
      captured.push({
        botName: input.botName,
        botSnapshot: input.botSnapshot,
        workingDir: input.workingDir,
      });
      return {
        kind: 'success',
        output: { ok: true },
        session: {
          sessionId: 'sess',
          botName: input.botName,
          startedAt: 0,
        },
      };
    };

    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'tester',
      botResolver: (name) =>
        name === 'pinned-bot'
          ? {
              larkAppId: 'cli_pinned',
              cliId: 'codex',
              displayName: 'Pinned',
              workingDir: '/runs/pinned-cwd',
            }
          : undefined,
    });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: captureSpawn,
    };

    const snapshot = replay(await log.readAll());
    await dispatchWork(
      ctx,
      {
        kind: 'dispatchWork',
        nodeId: 'a',
        activityId: workActivityId(RUN_ID, 'a'),
        node: def.nodes.a!,
      },
      { snapshot },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.botSnapshot).toEqual({
      larkAppId: 'cli_pinned',
      cliId: 'codex',
      displayName: 'Pinned',
      workingDir: '/runs/pinned-cwd',
    });
    expect(captured[0]!.workingDir).toBe('/runs/pinned-cwd');
  });

  it('node.workingDir wins over snapshot.workingDir', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'snap-override',
      version: 1,
      nodes: {
        a: {
          type: 'subagent',
          bot: 'pinned-bot',
          prompt: 'do it',
          workingDir: '/override-cwd',
        },
      },
    });
    const captured: Array<{ workingDir?: string }> = [];
    const captureSpawn: WorkerSpawnFn = async (input) => {
      captured.push({ workingDir: input.workingDir });
      return {
        kind: 'success',
        output: {},
        session: { sessionId: 's', botName: input.botName, startedAt: 0 },
      };
    };
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'tester',
      botResolver: () => ({ workingDir: '/snapshot-cwd' }),
    });
    const ctx: WorkflowRuntimeContext = { log, def, spawnSubagent: captureSpawn };
    await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    expect(captured[0]!.workingDir).toBe('/override-cwd');
  });
});

// ─── end-to-end ──────────────────────────────────────────────────────────

describe('end-to-end: orchestrator + runtime drive humanGate flow', () => {
  it('a → gate → approve → gated work → succeed → run succeeded', async () => {
    const def = gatedDef();
    const { log, ctx } = await bootstrap(def, successSpawn);

    // tick 1 — dispatch 'a'
    let actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['dispatchWork']);
    await dispatchWork(ctx, actions[0] as any);

    // tick 2 — completeNodeSucceeded for 'a'
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['completeNodeSucceeded']);
    await completeNodeSucceeded(ctx, actions[0] as any);

    // tick 3 — dispatchGate for 'gated'
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['dispatchGate']);
    const gateDispatched = await dispatchGate(ctx, actions[0] as any);

    // tick 4 — gate waiting, no actions
    expect(decideNextActions(replay(await log.readAll()), def)).toEqual([]);

    // resolve the gate (human approves)
    await resolveWait(log, {
      activityId: gateActivityId(RUN_ID, 'gated'),
      attemptId: gateDispatched.attemptId,
      resolution: 'approved',
      by: 'ou_user',
    });

    // tick 5 — dispatchWork for 'gated'
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['dispatchWork']);
    await dispatchWork(ctx, actions[0] as any);

    // tick 6 — completeNodeSucceeded for 'gated'
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['completeNodeSucceeded']);
    await completeNodeSucceeded(ctx, actions[0] as any);

    // tick 7 — completeRunSucceeded
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['completeRunSucceeded']);
    await completeRunSucceeded(ctx, actions[0] as any);

    // final
    const snap = replay(await log.readAll());
    expect(snap.run.status).toBe('succeeded');
    expect(snap.run.output?.outputHash).toMatch(/^sha256:/);
  });

  it('gate rejection → completeNodeFailed → run failed', async () => {
    const def = gatedDef();
    const { log, ctx } = await bootstrap(def, successSpawn);

    // drive 'a' to succeed
    const aResult = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'a',
      activityId: workActivityId(RUN_ID, 'a'),
      node: def.nodes.a!,
    });
    if (aResult.kind !== 'succeeded') throw new Error();
    await completeNodeSucceeded(ctx, {
      kind: 'completeNodeSucceeded',
      nodeId: 'a',
      lastActivityId: workActivityId(RUN_ID, 'a'),
      outputRef: aResult.outputRef,
    });

    // raise gate
    let actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate')!;
    const { attemptId: gateAttId } = await dispatchGate(ctx, gateAction as any);

    // human rejects
    await resolveWait(log, {
      activityId: gateActivityId(RUN_ID, 'gated'),
      attemptId: gateAttId,
      resolution: 'rejected',
      by: 'ou_user',
      comment: 'no thanks',
    });

    // tick — completeNodeFailed
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['completeNodeFailed']);
    await completeNodeFailed(ctx, actions[0] as any);

    // tick — completeRunFailed
    actions = decideNextActions(replay(await log.readAll()), def);
    expect(actions.map((a) => a.kind)).toEqual(['completeRunFailed']);
    const failedEvent = await completeRunFailed(ctx, actions[0] as any);
    const fp = failedEvent.payload as { failedNodeId: string; rootCauseEventId: string };
    expect(fp.failedNodeId).toBe('gated');
    expect(fp.rootCauseEventId).toMatch(/run-runtime-test-01-\d+/);

    const snap = replay(await log.readAll());
    expect(snap.run.status).toBe('failed');
  });
});
