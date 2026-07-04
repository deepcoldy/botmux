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
import { INLINE_PAYLOAD_MAX_BYTES } from '../src/workflows/events/schema.js';
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
import { loadEffectInputSidecar } from '../src/workflows/effect-input.js';
import type {
  HostExecutorRegistry,
  RegisteredHostExecutor,
} from '../src/workflows/hostExecutors/registry.js';

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
          approvers: ['ou_manager'],
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

function fakeHostRegistry(): HostExecutorRegistry {
  const registered: RegisteredHostExecutor<{ msg: string }, { ok: true }> = {
    parseInput(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof (input as { msg?: unknown }).msg !== 'string'
      ) {
        throw new Error('msg is required');
      }
      return { msg: (input as { msg: string }).msg };
    },
    executor: {
      provider: 'test-host',
      idempotencyTtlMs: 60_000,
      canonicalInput(input) {
        return input;
      },
      async invoke(input, idempotencyKey) {
        return {
          output: { ok: true },
          externalRefs: { idempotencyKey, msg: input.msg },
        };
      },
    },
  };
  return new Map([['test-host', registered]]);
}

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
      approvers: ['ou_manager'],
      onTimeout: 'fail',
    });
    const waitP = waitCreated.payload as { deadlineAt: number };
    expect(waitP.deadlineAt).toBe(1_700_000_000_000 + 60_000);
  });

  it('spills large humanGate prompts to a blob and writes promptRef + promptPreview', async () => {
    // v0.1.3: large prompts no longer fail; they spill to a content-addressed
    // blob. The wait event carries promptRef + a short preview, the full text
    // lives in <runDir>/blobs/<hash> and is readable on demand by the
    // dashboard / Node I/O view.
    const longPrompt = 'x'.repeat(INLINE_PAYLOAD_MAX_BYTES + 200);
    const def = parseWorkflowDefinition({
      workflowId: 'gated-large-prompt',
      version: 1,
      nodes: {
        gated: {
          type: 'subagent',
          bot: 'b2',
          prompt: 'do gated thing',
          humanGate: {
            stage: 'before',
            prompt: longPrompt,
          },
        },
      },
    });
    const { log, ctx } = await bootstrap(def, successSpawn);
    const actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate');
    if (!gateAction || gateAction.kind !== 'dispatchGate') throw new Error('no gate action');

    const result = await dispatchGate(ctx, gateAction);

    expect(result.kind).toBe('wait');
    if (result.kind !== 'wait') return;
    const wp = result.waitCreated.payload as {
      prompt?: string;
      promptRef?: { outputHash: string; outputPath?: string; outputBytes: number; contentType?: string };
      promptPreview?: string;
    };
    expect(wp.prompt).toBeUndefined();
    expect(wp.promptRef).toBeDefined();
    expect(wp.promptRef!.outputBytes).toBe(longPrompt.length);
    expect(wp.promptRef!.contentType).toBe('text/plain');
    expect(wp.promptPreview).toBeDefined();
    expect(wp.promptPreview!.length).toBeLessThanOrEqual(500); // schema cap
    expect(wp.promptPreview).toMatch(/dashboard/);

    // Blob file actually written
    const { promises: fsp } = await import('node:fs');
    expect(wp.promptRef!.outputPath).toBeDefined();
    const blobText = await fsp.readFile(wp.promptRef!.outputPath!, 'utf-8');
    expect(blobText).toBe(longPrompt);
  });

  it('keeps small humanGate prompts inline (no spill below 1 KiB)', async () => {
    const smallPrompt = 'approve?';
    const def = parseWorkflowDefinition({
      workflowId: 'gated-small-prompt',
      version: 1,
      nodes: {
        gated: {
          type: 'subagent',
          bot: 'b2',
          prompt: 'do gated thing',
          humanGate: { stage: 'before', prompt: smallPrompt },
        },
      },
    });
    const { log, ctx } = await bootstrap(def, successSpawn);
    const actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate');
    if (!gateAction || gateAction.kind !== 'dispatchGate') throw new Error('no gate action');

    const result = await dispatchGate(ctx, gateAction);
    expect(result.kind).toBe('wait');
    if (result.kind !== 'wait') return;
    const wp = result.waitCreated.payload as {
      prompt?: string; promptRef?: unknown; promptPreview?: string;
    };
    expect(wp.prompt).toBe(smallPrompt);
    expect(wp.promptRef).toBeUndefined();
    expect(wp.promptPreview).toBeUndefined();
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
      'activityRunning',
      'activitySucceeded',
    ]);
    const running = events.find((e) => e.type === 'activityRunning');
    const payload = (running?.payload ?? {}) as { activityId: string; attemptId: string; leaseId: string };
    expect(payload.leaseId).toBe(`lease-${payload.attemptId}`);

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
    expect(session.logPath).toBe(join(
      log.runDir,
      'attempts',
      workActivityId(RUN_ID, 'a'),
      result.attemptId,
      'terminal.log',
    ));
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

  it('resolves params refs into subagent prompt before spawning', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-param-subagent',
      version: 1,
      params: {
        name: { type: 'string', required: true },
      },
      nodes: {
        greet: {
          type: 'subagent',
          bot: 'b1',
          prompt: { $ref: 'params.name' },
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: { name: 'Alice' },
      initiator: 'tester',
      botResolver: noopResolver,
    });
    const prompts: string[] = [];
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async (input) => {
        prompts.push(input.prompt);
        return {
          kind: 'success',
          output: { ok: true },
          session: { sessionId: 's', botName: input.botName, startedAt: 0 },
        };
      },
    };

    await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'greet',
      activityId: workActivityId(RUN_ID, 'greet'),
      node: def.nodes.greet!,
    });

    expect(prompts).toEqual(['Alice']);
  });

  it('interpolates params refs inside subagent prompt before spawning', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-param-subagent-template',
      version: 1,
      params: {
        city: { type: 'string', required: true },
      },
      nodes: {
        weather: {
          type: 'subagent',
          bot: 'b1',
          prompt: '查询 ${params.city} 天气',
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: { city: '上海' },
      initiator: 'tester',
      botResolver: noopResolver,
    });
    const prompts: string[] = [];
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async (input) => {
        prompts.push(input.prompt);
        return {
          kind: 'success',
          output: { ok: true },
          session: { sessionId: 's', botName: input.botName, startedAt: 0 },
        };
      },
    };

    await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'weather',
      activityId: workActivityId(RUN_ID, 'weather'),
      node: def.nodes.weather!,
    });

    expect(prompts).toEqual(['查询 上海 天气']);
  });

  it('unknown hostExecutor writes attemptCreated + activityFailed{manual} terminal', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-host',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: { msg: 'hi' },
          // Test exercises dispatchWork's unknown-executor branch; gate
          // semantics are not under test — opt in so parse succeeds.
          unsafeAllowUngated: true,
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

  it('registered hostExecutor writes effectAttempted + activitySucceeded and effect-input sidecar', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-host',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'test-host',
          input: { msg: 'hi' },
        },
      },
    });
    const { log, ctx } = await bootstrap(def, successSpawn);
    ctx.hostExecutors = fakeHostRegistry();

    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'h',
      activityId: workActivityId(RUN_ID, 'h'),
      node: def.nodes.h!,
    });

    expect(result.kind).toBe('succeeded');
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'effectAttempted',
      'activitySucceeded',
    ]);
    const effect = events.find((e) => e.type === 'effectAttempted')!;
    expect(effect.payload).toMatchObject({
      provider: 'test-host',
      inputHash: expect.stringMatching(/^sha256:/),
    });
    const success = events.find((e) => e.type === 'activitySucceeded')!;
    expect(success.payload).toMatchObject({
      externalRefs: {
        msg: 'hi',
      },
    });
    expect(await loadEffectInputSidecar(log, workActivityId(RUN_ID, 'h'), result.attemptId)).toEqual({
      msg: 'hi',
    });
  });

  it('resolves params refs into hostExecutor input before parseInput', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-host-params',
      version: 1,
      params: {
        message: { type: 'string', required: true },
      },
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'test-host',
          input: { msg: { $ref: 'params.message' } },
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: { message: 'hello from params' },
      initiator: 'tester',
      botResolver: noopResolver,
    });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: successSpawn,
      hostExecutors: fakeHostRegistry(),
    };

    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'h',
      activityId: workActivityId(RUN_ID, 'h'),
      node: def.nodes.h!,
    });

    expect(result.kind).toBe('succeeded');
    const effect = (await log.readAll()).find((e) => e.type === 'effectAttempted')!;
    expect(effect.payload).toMatchObject({
      inputHash: expect.stringMatching(/^sha256:/),
    });
    if (result.kind !== 'succeeded') return;
    expect(await loadEffectInputSidecar(log, workActivityId(RUN_ID, 'h'), result.attemptId)).toEqual({
      msg: 'hello from params',
    });
  });

  it('hostExecutor input validation fails before effectAttempted', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-host',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'test-host',
          input: { wrong: 'shape' },
        },
      },
    });
    const { log, ctx } = await bootstrap(def, successSpawn);
    ctx.hostExecutors = fakeHostRegistry();

    const result = await dispatchWork(ctx, {
      kind: 'dispatchWork',
      nodeId: 'h',
      activityId: workActivityId(RUN_ID, 'h'),
      node: def.nodes.h!,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      errorCode: 'InputValidationFailed',
      errorClass: 'userFault',
    });
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'activityFailed',
    ]);
    const failed = events.find((e) => e.type === 'activityFailed')!;
    expect(failed.payload).toMatchObject({
      error: {
        errorCode: 'InputValidationFailed',
        errorClass: 'userFault',
      },
    });
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
              cliPathOverride: '/opt/botmux-mc-codex',
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
      cliPathOverride: '/opt/botmux-mc-codex',
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
