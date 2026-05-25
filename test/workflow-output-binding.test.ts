/**
 * Output binding tests — schema parsing, parseRef syntax,
 * resolveBindings against in-memory snapshots, and runtime integration
 * through dispatchWork / dispatchGate failure paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWorkflowDefinition,
  OutputRefSpecSchema,
  BoundJsonValueSchema,
} from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  BindingError,
  parseRef,
  resolveBindings,
  resolveOutputRef,
} from '../src/workflows/output-binding.js';
import {
  dispatchGate,
  dispatchWork,
  type WorkerSpawnFn,
  type WorkflowRuntimeContext,
} from '../src/workflows/runtime.js';
import { decideNextActions } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import { loopGateActivityId, loopWorkActivityId, workActivityId } from '../src/workflows/orchestrator.js';

const RUN_ID = 'run-binding-test';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-binding-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ─── Schema: OutputRefSpec is strict single-key ──────────────────────────

describe('OutputRefSpecSchema (strict)', () => {
  it('accepts { $ref: "..." }', () => {
    expect(OutputRefSpecSchema.parse({ $ref: 'foo.output.bar' })).toEqual({
      $ref: 'foo.output.bar',
    });
  });

  it('rejects { $ref: "..." } with extra keys', () => {
    expect(() => OutputRefSpecSchema.parse({ $ref: 'foo.output.bar', extra: 'x' })).toThrow();
  });

  it('rejects empty $ref', () => {
    expect(() => OutputRefSpecSchema.parse({ $ref: '' })).toThrow();
  });

  it('rejects non-string $ref', () => {
    expect(() => OutputRefSpecSchema.parse({ $ref: 42 })).toThrow();
  });
});

describe('BoundJsonValueSchema', () => {
  it('accepts plain JSON values', () => {
    expect(BoundJsonValueSchema.parse('s')).toBe('s');
    expect(BoundJsonValueSchema.parse(42)).toBe(42);
    expect(BoundJsonValueSchema.parse({ x: 1, y: [2, 'a'] })).toEqual({
      x: 1,
      y: [2, 'a'],
    });
  });

  it('accepts $ref leaves nested in objects/arrays', () => {
    const v = {
      content: { $ref: 'draft.output.greeting' },
      tags: [{ $ref: 'tags.output.first' }, 'static'],
    };
    expect(BoundJsonValueSchema.parse(v)).toEqual(v);
  });

  it('rejects $ref-bearing object that also has other keys', () => {
    expect(() => BoundJsonValueSchema.parse({ $ref: 'a.output.b', also: 'x' })).toThrow();
  });
});

// ─── parseRef syntax ──────────────────────────────────────────────────────

describe('parseRef', () => {
  it('splits on the first .output. occurrence', () => {
    expect(parseRef('draft.output.greeting')).toEqual({
      kind: 'output',
      nodeId: 'draft',
      pathSegments: ['greeting'],
    });
  });

  it('handles dotted nodeIds (NODE_ID_PATTERN allows dots)', () => {
    expect(parseRef('team.draft.output.x.y')).toEqual({
      kind: 'output',
      nodeId: 'team.draft',
      pathSegments: ['x', 'y'],
    });
  });

  it('splits on the first .output. only — later .output. is part of path', () => {
    expect(parseRef('node.output.output.x')).toEqual({
      kind: 'output',
      nodeId: 'node',
      pathSegments: ['output', 'x'],
    });
  });

  it('rejects missing .output. separator', () => {
    expect(() => parseRef('draft.greeting')).toThrow(BindingError);
  });

  it('rejects empty nodeId', () => {
    expect(() => parseRef('.output.x')).toThrow(BindingError);
  });

  it('rejects empty path', () => {
    expect(() => parseRef('draft.output.')).toThrow(BindingError);
  });

  it('rejects empty segment (consecutive dots)', () => {
    expect(() => parseRef('draft.output.x..y')).toThrow(BindingError);
  });

  it('rejects __proto__ / prototype / constructor segments', () => {
    expect(() => parseRef('draft.output.__proto__')).toThrow(BindingError);
    expect(() => parseRef('draft.output.x.prototype')).toThrow(BindingError);
    expect(() => parseRef('draft.output.constructor')).toThrow(BindingError);
  });

  it('rejects bracket/escape/whitespace in segments', () => {
    expect(() => parseRef('draft.output.x[0]')).toThrow(BindingError);
    expect(() => parseRef('draft.output.x\\y')).toThrow(BindingError);
    expect(() => parseRef('draft.output.x y')).toThrow(BindingError);
  });

  it('accepts numeric segments (array indices)', () => {
    expect(parseRef('draft.output.0.x')).toEqual({
      kind: 'output',
      nodeId: 'draft',
      pathSegments: ['0', 'x'],
    });
  });

  it('accepts params refs without .output. separator', () => {
    expect(parseRef('params.user.email')).toEqual({
      kind: 'params',
      nodeId: 'params',
      pathSegments: ['user', 'email'],
    });
  });

  it('accepts previous refs for loop iterations', () => {
    expect(parseRef('reviewDecision.previous.comment')).toEqual({
      kind: 'previous',
      nodeId: 'reviewDecision',
      pathSegments: ['comment'],
    });
  });
});

// ─── resolveOutputRef against a real snapshot ────────────────────────────

describe('resolveOutputRef — snapshot+blob walk', () => {
  async function seedSubagentSuccess(blob: unknown) {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        upstream: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
        downstream: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const successSpawn: WorkerSpawnFn = async () => ({
      kind: 'success',
      output: blob,
      session: { sessionId: 'fake', botName: 'claude-loopy', startedAt: 0 },
    });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: successSpawn,
    };
    const actions = decideNextActions(replay(await log.readAll()), def);
    const upstream = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'upstream');
    if (!upstream || upstream.kind !== 'dispatchWork') throw new Error('no action');
    await dispatchWork(ctx, upstream);
    return { log, def };
  }

  it('walks subagent blob (no .output wrapper) by path segments', async () => {
    const { log, def } = await seedSubagentSuccess({ greeting: 'Hello world' });
    const snap = replay(await log.readAll());
    const out = await resolveOutputRef('upstream.output.greeting', { snapshot: snap, def, log });
    expect(out).toBe('Hello world');
  });

  it('walks hostExecutor blob via the wrapping `output` key', async () => {
    // Drive a hostExecutor success to simulate the {output, externalRefs} blob.
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        h: {
          type: 'hostExecutor',
          executor: 'test-host',
          input: { msg: 'hi' },
        },
        downstream: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async () => ({ kind: 'success', output: {}, session: { sessionId: 'x', botName: 'b', startedAt: 0 } }),
      hostExecutors: new Map([
        ['test-host', {
          parseInput(i: unknown) { return i; },
          executor: {
            provider: 'test-host',
            idempotencyTtlMs: 60_000,
            canonicalInput(i: any) { return i; },
            async invoke() {
              return { output: { taskId: 'abc' }, externalRefs: { taskId: 'abc' } };
            },
          },
        }] as any,
      ]),
    };
    const actions = decideNextActions(replay(await log.readAll()), def);
    const hostAction = actions.find((a) => a.kind === 'dispatchWork' && a.nodeId === 'h')!;
    if (hostAction.kind !== 'dispatchWork') throw new Error();
    await dispatchWork(ctx, hostAction);
    const snap = replay(await log.readAll());
    expect(await resolveOutputRef('h.output.taskId', { snapshot: snap, def, log })).toBe('abc');
  });

  it('walks array indices', async () => {
    const { log, def } = await seedSubagentSuccess({ tags: ['alpha', 'beta'] });
    const snap = replay(await log.readAll());
    expect(await resolveOutputRef('upstream.output.tags.1', { snapshot: snap, def, log })).toBe('beta');
  });

  it('fails when ref targets a node not in the definition', async () => {
    const { log, def } = await seedSubagentSuccess({ greeting: 'x' });
    const snap = replay(await log.readAll());
    await expect(
      resolveOutputRef('ghost.output.greeting', { snapshot: snap, def, log }),
    ).rejects.toBeInstanceOf(BindingError);
  });

  it('fails when ref targets a node that has not succeeded yet', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        upstream: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const snap = replay(await log.readAll());
    await expect(
      resolveOutputRef('upstream.output.greeting', { snapshot: snap, def, log }),
    ).rejects.toBeInstanceOf(BindingError);
  });

  it('fails when path segment not found on object', async () => {
    const { log, def } = await seedSubagentSuccess({ greeting: 'x' });
    const snap = replay(await log.readAll());
    await expect(
      resolveOutputRef('upstream.output.missing', { snapshot: snap, def, log }),
    ).rejects.toThrow(/not found/);
  });

  it('fails when path traverses through a primitive', async () => {
    const { log, def } = await seedSubagentSuccess({ greeting: 'x' });
    const snap = replay(await log.readAll());
    await expect(
      resolveOutputRef('upstream.output.greeting.length', { snapshot: snap, def, log }),
    ).rejects.toThrow(/non-object/);
  });

  it('fails loud when upstream output blob is missing from disk (codex extra)', async () => {
    const { log, def } = await seedSubagentSuccess({ greeting: 'x' });
    const snap = replay(await log.readAll());
    const outputRef = snap.outputs.get(workActivityId(RUN_ID, 'upstream'))!;
    // Simulate someone deleting the blob file: resolver MUST not fall back
    // to the event payload externalRefs.
    unlinkSync(outputRef.outputPath!);
    await expect(
      resolveOutputRef('upstream.output.greeting', { snapshot: snap, def, log }),
    ).rejects.toThrow(/failed to read output blob/);
  });

  it('does NOT recursively resolve refs nested inside upstream output (refs are author-only)', async () => {
    // If upstream's output literally contains the substring "$ref",
    // the resolver should return it as-is, not try to deref it.
    const { log, def } = await seedSubagentSuccess({
      payload: { $ref: 'looks.output.like.a.ref' },
    });
    const snap = replay(await log.readAll());
    expect(
      await resolveOutputRef('upstream.output.payload', { snapshot: snap, def, log }),
    ).toEqual({ $ref: 'looks.output.like.a.ref' });
  });

  it('resolves params refs from runCreated inputRef', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        only: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: {
        user: { email: 'alice@example.com' },
        tags: ['alpha', 'beta'],
      },
      initiator: 't',
      botResolver: () => ({}),
    });
    const snap = replay(await log.readAll());

    expect(await resolveOutputRef('params.user.email', { snapshot: snap, def, log }))
      .toBe('alice@example.com');
    expect(await resolveOutputRef('params.tags.1', { snapshot: snap, def, log }))
      .toBe('beta');
  });

  it('fails when params path is missing', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        only: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: { user: { email: 'alice@example.com' } },
      initiator: 't',
      botResolver: () => ({}),
    });
    const snap = replay(await log.readAll());

    await expect(
      resolveOutputRef('params.user.name', { snapshot: snap, def, log }),
    ).rejects.toThrow(/not found/);
  });

  it('resolves latest successful loop iteration output for a body node', async () => {
    const def = {
      workflowId: 'wf-loop-bind',
      version: 1,
      nodes: {
        implement: { type: 'subagent', bot: 'b', prompt: 'x' },
        'review-loop': {
          type: 'loop',
          maxIterations: 2,
          body: ['implement'],
          terminate: { node: 'implement', via: 'humanGate' },
          output: { from: 'implement' },
        },
      },
    } as any;
    const log = new EventLog(RUN_ID, baseDir);
    await log.append({
      runId: RUN_ID,
      type: 'runCreated',
      actor: 'scheduler',
      payload: {
        workflowId: 'wf-loop-bind',
        revisionId: 'rev',
        inputRef: { outputHash: 'sha256:' + '1'.repeat(64), outputBytes: 1, outputSchemaVersion: 1 },
        initiator: 't',
      },
    });
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    const firstPath = join(baseDir, RUN_ID, 'blobs', 'loop-1.json');
    const secondPath = join(baseDir, RUN_ID, 'blobs', 'loop-2.json');
    writeFileSync(firstPath, JSON.stringify({ code: 'v1' }));
    writeFileSync(secondPath, JSON.stringify({ code: 'v2' }));
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'implement',
        activityId: loopWorkActivityId(RUN_ID, 'review-loop', 1, 'implement'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: { outputHash: 'sha256:' + '5'.repeat(64), outputBytes: 1, outputSchemaVersion: 1 },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: loopWorkActivityId(RUN_ID, 'review-loop', 1, 'implement'),
        attemptId: 'att-1',
        outputRef: { outputHash: 'sha256:' + '2'.repeat(64), outputBytes: 13, outputSchemaVersion: 1, outputPath: firstPath },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'implement',
        activityId: loopWorkActivityId(RUN_ID, 'review-loop', 2, 'implement'),
        attemptId: 'att-2',
        attemptNumber: 1,
        inputRef: { outputHash: 'sha256:' + '6'.repeat(64), outputBytes: 1, outputSchemaVersion: 1 },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: loopWorkActivityId(RUN_ID, 'review-loop', 2, 'implement'),
        attemptId: 'att-2',
        outputRef: { outputHash: 'sha256:' + '3'.repeat(64), outputBytes: 13, outputSchemaVersion: 1, outputPath: secondPath },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'loopFinished',
      actor: 'scheduler',
      payload: {
        loopId: 'review-loop',
        finalIteration: 2,
        resolution: 'approved',
        outputRef: { outputHash: 'sha256:' + '3'.repeat(64), outputBytes: 13, outputSchemaVersion: 1, outputPath: secondPath },
      },
    });
    const snap = replay(await log.readAll());
    await expect(resolveOutputRef('implement.output.code', { snapshot: snap, def, log }))
      .resolves.toBe('v2');
    await expect(resolveOutputRef('review-loop.output.code', { snapshot: snap, def, log }))
      .resolves.toBe('v2');
  });

  it('resolves previous output only from loop context', async () => {
    const def = {
      workflowId: 'wf-loop-bind',
      version: 1,
      nodes: {
        reviewDecision: { type: 'decision', humanGate: { stage: 'before', prompt: 'x' } },
      },
    } as any;
    const log = new EventLog(RUN_ID, baseDir);
    await log.append({
      runId: RUN_ID,
      type: 'runCreated',
      actor: 'scheduler',
      payload: {
        workflowId: 'wf-loop-bind',
        revisionId: 'rev',
        inputRef: { outputHash: 'sha256:' + '1'.repeat(64), outputBytes: 1, outputSchemaVersion: 1 },
        initiator: 't',
      },
    });
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    const prevPath = join(baseDir, RUN_ID, 'blobs', 'decision-1.json');
    writeFileSync(prevPath, JSON.stringify({ comment: 'fix tests' }));
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'reviewDecision',
        activityId: loopGateActivityId(RUN_ID, 'review-loop', 1, 'reviewDecision'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: { outputHash: 'sha256:' + '7'.repeat(64), outputBytes: 1, outputSchemaVersion: 1 },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'human',
      payload: {
        activityId: loopGateActivityId(RUN_ID, 'review-loop', 1, 'reviewDecision'),
        attemptId: 'att-1',
        outputRef: { outputHash: 'sha256:' + '4'.repeat(64), outputBytes: 23, outputSchemaVersion: 1, outputPath: prevPath },
      },
    });
    const snap = replay(await log.readAll());
    await expect(
      resolveOutputRef('reviewDecision.previous.comment', {
        snapshot: snap,
        def,
        log,
        loopContext: { loopId: 'review-loop', iteration: 2 },
      }),
    ).resolves.toBe('fix tests');
    await expect(
      resolveOutputRef('reviewDecision.previous.comment', { snapshot: snap, def, log }),
    ).rejects.toThrow(/outside a loop iteration context/);
  });
});

// ─── resolveBindings — recursive substitution ────────────────────────────

describe('resolveBindings', () => {
  it('replaces nested $refs throughout objects and arrays', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    // Hand-seed an output without actually running dispatchWork — write a
    // fake blob and synthesize the activitySucceeded event so the snapshot
    // map carries an outputRef for 'a'.  Faster than driving the runtime.
    const blobBuf = JSON.stringify({ greeting: 'Hello' });
    const blobPath = join(baseDir, RUN_ID, 'blobs', 'fakeblob.json');
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    writeFileSync(blobPath, blobBuf);
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'a',
        activityId: workActivityId(RUN_ID, 'a'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'a'.repeat(64),
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: workActivityId(RUN_ID, 'a'),
        attemptId: 'att-1',
        outputRef: {
          outputHash: 'sha256:' + 'a'.repeat(64),
          outputPath: blobPath,
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
          contentType: 'application/json',
        },
      },
    });

    const snap = replay(await log.readAll());
    const ctx = { snapshot: snap, def, log };
    const resolved = await resolveBindings(
      {
        title: 'static',
        body: { $ref: 'a.output.greeting' },
        nested: { inner: [{ $ref: 'a.output.greeting' }, 'literal'] },
      },
      ctx,
    );
    expect(resolved).toEqual({
      title: 'static',
      body: 'Hello',
      nested: { inner: ['Hello', 'literal'] },
    });
  });

  it('interpolates scalar refs inside strings', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, {
      def,
      params: { city: '上海' },
      initiator: 't',
      botResolver: () => ({}),
    });
    const blobBuf = JSON.stringify({ tempC: 23, raining: false, note: null });
    const blobPath = join(baseDir, RUN_ID, 'blobs', 'weather.json');
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    writeFileSync(blobPath, blobBuf);
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'a',
        activityId: workActivityId(RUN_ID, 'a'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'b'.repeat(64),
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: workActivityId(RUN_ID, 'a'),
        attemptId: 'att-1',
        outputRef: {
          outputHash: 'sha256:' + 'b'.repeat(64),
          outputPath: blobPath,
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
          contentType: 'application/json',
        },
      },
    });

    const snap = replay(await log.readAll());
    const resolved = await resolveBindings(
      '查 ${params.city} 天气：${a.output.tempC}C raining=${a.output.raining} note=${a.output.note}',
      { snapshot: snap, def, log },
    );

    expect(resolved).toBe('查 上海 天气：23C raining=false note=null');
  });

  it('rejects object/array refs inside string interpolation', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        upstream: { type: 'subagent', bot: 'b', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const blobBuf = JSON.stringify({ payload: { nested: true } });
    const blobPath = join(baseDir, RUN_ID, 'blobs', 'payload.json');
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    writeFileSync(blobPath, blobBuf);
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'upstream',
        activityId: workActivityId(RUN_ID, 'upstream'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'c'.repeat(64),
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: workActivityId(RUN_ID, 'upstream'),
        attemptId: 'att-1',
        outputRef: {
          outputHash: 'sha256:' + 'c'.repeat(64),
          outputPath: blobPath,
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
          contentType: 'application/json',
        },
      },
    });
    const snap = replay(await log.readAll());

    await expect(
      resolveBindings('payload=${upstream.output.payload}', { snapshot: snap, def, log }),
    ).rejects.toThrow(/use whole-field \$ref/);
  });

  it('rejects malformed string interpolation', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'b', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: { city: 'x' }, initiator: 't', botResolver: () => ({}) });
    const snap = replay(await log.readAll());

    await expect(
      resolveBindings('查 ${params.city 天气', { snapshot: snap, def, log }),
    ).rejects.toThrow(/unterminated/);
  });

  it('passes through strings without ${...} markers unchanged', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: { a: { type: 'subagent', bot: 'b', prompt: 'go' } },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const snap = replay(await log.readAll());

    // No `${` substring means the resolver should short-circuit without
    // touching the snapshot — guards against regressions where a refactor
    // forces every string through the interpolation walker.
    expect(
      await resolveBindings('plain string with $ and { but no template', {
        snapshot: snap,
        def,
        log,
      }),
    ).toBe('plain string with $ and { but no template');
  });

  it('rejects empty ${} ref', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: { a: { type: 'subagent', bot: 'b', prompt: 'go' } },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const snap = replay(await log.readAll());

    // `${}` is almost certainly a typo (forgotten ref body). The runtime
    // surfaces it as BindingError so the workflow author notices instead of
    // silently emitting the literal `${}` downstream.
    await expect(
      resolveBindings('hi ${}', { snapshot: snap, def, log }),
    ).rejects.toThrow(/empty/);
  });

  it('does not interpolate strings nested inside upstream subagent output blobs', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind',
      version: 1,
      nodes: {
        upstream: { type: 'subagent', bot: 'b', prompt: 'go' },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: { city: '上海' }, initiator: 't', botResolver: () => ({}) });
    // Upstream output contains a literal `${params.city}` string. Refs are
    // author-only: dynamic content carried through outputs must NOT be
    // re-interpreted as a template, otherwise a bot's tainted output could
    // dereference any param it knows the name of.
    const blobBuf = JSON.stringify({ note: 'literal ${params.city} stays literal' });
    const blobPath = join(baseDir, RUN_ID, 'blobs', 'upstream.json');
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(baseDir, RUN_ID, 'blobs'), { recursive: true });
    writeFileSync(blobPath, blobBuf);
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'upstream',
        activityId: workActivityId(RUN_ID, 'upstream'),
        attemptId: 'att-1',
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'd'.repeat(64),
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
        },
      },
    });
    await log.append({
      runId: RUN_ID,
      type: 'activitySucceeded',
      actor: 'worker',
      payload: {
        activityId: workActivityId(RUN_ID, 'upstream'),
        attemptId: 'att-1',
        outputRef: {
          outputHash: 'sha256:' + 'd'.repeat(64),
          outputPath: blobPath,
          outputBytes: blobBuf.length,
          outputSchemaVersion: 1,
          contentType: 'application/json',
        },
      },
    });

    const snap = replay(await log.readAll());
    // Author-side interpolation referencing upstream.output.note pulls in
    // the literal `${params.city}` text as-is — NOT '上海'.
    const resolved = await resolveBindings('note=${upstream.output.note}', {
      snapshot: snap,
      def,
      log,
    });
    expect(resolved).toBe('note=literal ${params.city} stays literal');
  });
});

// ─── End-to-end: dispatchWork hostExecutor with $ref input ───────────────

describe('dispatchWork — hostExecutor with $ref input', () => {
  it('resolves $ref, hands resolved input to parseInput, succeeds', async () => {
    const { runLoop } = await import('../src/workflows/loop.js');
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind-e2e',
      version: 1,
      nodes: {
        draft: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
        send: {
          type: 'hostExecutor',
          executor: 'echo',
          input: { content: { $ref: 'draft.output.text' } },
          depends: ['draft'],
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });

    const successSpawn: WorkerSpawnFn = async () => ({
      kind: 'success',
      output: { text: 'Hello echo' },
      session: { sessionId: 's', botName: 'b', startedAt: 0 },
    });
    const echoInvocations: Array<unknown> = [];
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: successSpawn,
      hostExecutors: new Map([
        ['echo', {
          parseInput(i: unknown) {
            if (typeof (i as any)?.content !== 'string') throw new Error('content required');
            return i;
          },
          executor: {
            provider: 'echo',
            idempotencyTtlMs: 60_000,
            canonicalInput(i: any) { return i; },
            async invoke(i: any) {
              echoInvocations.push(i);
              return { output: { echoed: i.content }, externalRefs: { id: 'echo-1' } };
            },
          },
        }] as any,
      ]),
    };
    const result = await runLoop(ctx, { maxTicks: 50 });
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');
    expect(echoInvocations).toEqual([{ content: 'Hello echo' }]);
  });

  it('binding failure → activityFailed{InputBindingFailed/userFault} without effectAttempted', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind-fail',
      version: 1,
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'echo',
          input: { content: { $ref: 'ghost.output.text' } },
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async () => ({ kind: 'success', output: {}, session: { sessionId: 'x', botName: 'b', startedAt: 0 } }),
      hostExecutors: new Map([
        ['echo', {
          parseInput(i: unknown) { return i; },
          executor: {
            provider: 'echo',
            idempotencyTtlMs: 60_000,
            canonicalInput(i: any) { return i; },
            async invoke() { return { output: {}, externalRefs: {} }; },
          },
        }] as any,
      ]),
    };
    const actions = decideNextActions(replay(await log.readAll()), def);
    const sendAction = actions.find((a) => a.kind === 'dispatchWork')!;
    if (sendAction.kind !== 'dispatchWork') throw new Error();
    const result = await dispatchWork(ctx, sendAction);

    expect(result).toMatchObject({
      kind: 'failed',
      errorCode: 'InputBindingFailed',
      errorClass: 'userFault',
    });
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'activityFailed',
    ]);
  });
});

// ─── End-to-end: dispatchGate with $ref prompt ───────────────────────────

describe('dispatchGate — bound prompt', () => {
  it('resolves $ref prompt before waitCreated', async () => {
    const { runLoop } = await import('../src/workflows/loop.js');
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind-gate',
      version: 1,
      nodes: {
        draft: { type: 'subagent', bot: 'claude-loopy', prompt: 'go' },
        confirm: {
          type: 'subagent',
          bot: 'claude-loopy',
          prompt: 'finalize',
          depends: ['draft'],
          humanGate: {
            stage: 'before',
            prompt: { $ref: 'draft.output.preview' },
          },
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async () => ({
        kind: 'success',
        output: { preview: 'Approve sending: Hello team' },
        session: { sessionId: 's', botName: 'b', startedAt: 0 },
      }),
    };
    const result = await runLoop(ctx, { maxTicks: 50 });
    // Gate created → wait, no resolver in test → loop stops awaiting-wait.
    expect(result.reason).toBe('awaiting-wait');
    const events = await log.readAll();
    const waitCreated = events.find((e) => e.type === 'waitCreated')! as any;
    expect(waitCreated.payload.prompt).toBe('Approve sending: Hello team');
  });

  it('binding failure → activityFailed without waitCreated', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-bind-gate-fail',
      version: 1,
      nodes: {
        confirm: {
          type: 'subagent',
          bot: 'claude-loopy',
          prompt: 'finalize',
          humanGate: {
            stage: 'before',
            prompt: { $ref: 'ghost.output.preview' },
          },
        },
      },
    });
    const log = new EventLog(RUN_ID, baseDir);
    await createRun(log, { def, params: {}, initiator: 't', botResolver: () => ({}) });
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async () => ({
        kind: 'success',
        output: {},
        session: { sessionId: 's', botName: 'b', startedAt: 0 },
      }),
    };
    const actions = decideNextActions(replay(await log.readAll()), def);
    const gateAction = actions.find((a) => a.kind === 'dispatchGate')!;
    if (gateAction.kind !== 'dispatchGate') throw new Error();
    const result = await dispatchGate(ctx, gateAction);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect((result.activityFailed.payload as any).error.errorCode).toBe('InputBindingFailed');
    expect((result.activityFailed.payload as any).error.errorClass).toBe('userFault');

    const events = await log.readAll();
    expect(events.find((e) => e.type === 'waitCreated')).toBeUndefined();
  });
});
