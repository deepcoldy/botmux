import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachColdWorkflowRunsForDaemon } from '../src/workflows/cold-attach.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { computeInputHash } from '../src/workflows/events/idempotency.js';
import { replay } from '../src/workflows/events/replay.js';
import { runLoop } from '../src/workflows/loop.js';
import { workActivityId } from '../src/workflows/orchestrator.js';
import type { ProviderReconciler } from '../src/workflows/resume.js';
import { createRun } from '../src/workflows/run-init.js';
import type { WorkflowRuntimeContext } from '../src/workflows/runtime.js';

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-cold-attach-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const outputRef = {
  outputHash: 'sha256:' + '1'.repeat(64),
  outputBytes: 2,
  outputSchemaVersion: 1,
};

const ownerBinding = { chatId: 'oc_owner', larkAppId: 'cli_owner' };

describe('attachColdWorkflowRunsForDaemon', () => {
  it('attaches an owned dangling effect run and lets recovery settle it', async () => {
    const runId = 'cold-effect-run';
    const def = parseWorkflowDefinition({
      workflowId: 'wf-cold-effect',
      version: 1,
      nodes: {
        only: {
          type: 'hostExecutor',
          executor: 'mock-effect',
          input: { ok: true },
        },
      },
    });
    const log = new EventLog(runId, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: ownerBinding,
    });
    const activityId = workActivityId(runId, 'only');
    const attemptId = `${activityId}::att-1`;
    await log.append({
      runId,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'only',
        activityId,
        attemptId,
        attemptNumber: 1,
        inputRef: outputRef,
      },
    });
    await log.append({
      runId,
      type: 'effectAttempted',
      actor: 'hostExecutor',
      payload: {
        activityId,
        attemptId,
        idempotencyKey: 'wf_cold_effect',
        inputHash: computeInputHash({ ok: true }),
        idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
        provider: 'mock-provider',
      },
    });

    const reconciler: ProviderReconciler = {
      provider: 'mock-provider',
      async readOnlyLookup() {
        return { found: true, externalRefs: { recovered: true } };
      },
    };
    const attached: string[] = [];

    const result = await attachColdWorkflowRunsForDaemon({
      runsDir,
      ownerLarkAppId: 'cli_owner',
      makeContext: (run, attachedLog) => ({
        log: attachedLog,
        def: run.def,
        spawnSubagent: async () => {
          throw new Error('spawnSubagent should not run for effect recovery');
        },
        reconcilers: new Map([[reconciler.provider, reconciler]]),
      }),
      attachWatcher: (attachedRunId) => {
        attached.push(attachedRunId);
        return { ready: Promise.resolve() };
      },
      driveRun: (_runId, ctx) => runLoop(ctx),
      awaitDrive: true,
    });

    expect(result).toEqual({ discovered: 1, attached: [runId] });
    expect(attached).toEqual([runId]);
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toContain('reconcileResult');
    expect(events.map((e) => e.type)).toContain('activitySucceeded');
    expect(replay(events).run.status).toBe('succeeded');
  });

  it('attaches an owned in-flight subagent and marks it WorkerCrashed without respawn', async () => {
    const runId = 'cold-subagent-run';
    const def = parseWorkflowDefinition({
      workflowId: 'wf-cold-subagent',
      version: 1,
      nodes: {
        only: { type: 'subagent', bot: 'b', prompt: 'work' },
      },
    });
    const log = new EventLog(runId, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: ownerBinding,
    });
    const activityId = workActivityId(runId, 'only');
    const attemptId = `${activityId}::att-1`;
    await log.append({
      runId,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'only',
        activityId,
        attemptId,
        attemptNumber: 1,
        inputRef: outputRef,
      },
    });

    let spawnCalls = 0;
    await attachColdWorkflowRunsForDaemon({
      runsDir,
      ownerLarkAppId: 'cli_owner',
      makeContext: (run, attachedLog): WorkflowRuntimeContext => ({
        log: attachedLog,
        def: run.def,
        spawnSubagent: async () => {
          spawnCalls++;
          return {
            kind: 'failure',
            errorCode: 'WorkerCrashed',
            errorClass: 'manual',
            errorMessage: 'unexpected respawn',
          };
        },
        reconcilers: new Map(),
      }),
      attachWatcher: () => ({ ready: Promise.resolve() }),
      driveRun: (_runId, ctx) => runLoop(ctx),
      awaitDrive: true,
    });

    const events = await log.readAll();
    const failure = events.find((e) => e.type === 'activityFailed');
    expect(spawnCalls).toBe(0);
    expect(failure?.payload).toMatchObject({
      activityId,
      attemptId,
      error: {
        errorCode: 'WorkerCrashed',
        errorClass: 'retryable',
      },
    });
    expect(replay(events).run.status).toBe('failed');
  });

  it('does not attach runs owned by another daemon', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-cold-other-owner',
      version: 1,
      nodes: { only: { type: 'subagent', bot: 'b', prompt: 'x' } },
    });
    const log = new EventLog('cold-other-owner-run', runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'test',
      botResolver: () => ({}),
      chatBinding: { chatId: 'oc_other', larkAppId: 'cli_other' },
    });
    const beforeEvents = await log.readAll();
    const skipped: Array<{ runId: string; reason: string }> = [];
    let attachCalls = 0;

    const result = await attachColdWorkflowRunsForDaemon({
      runsDir,
      ownerLarkAppId: 'cli_owner',
      makeContext: (run, attachedLog) => ({
        log: attachedLog,
        def: run.def,
        spawnSubagent: async () => {
          throw new Error('spawnSubagent should not run for skipped owner');
        },
      }),
      attachWatcher: () => {
        attachCalls++;
        return { ready: Promise.resolve() };
      },
      driveRun: (_runId, ctx) => runLoop(ctx),
      awaitDrive: true,
      onSkip: (runId, reason) => skipped.push({ runId, reason }),
    });

    expect(result).toEqual({ discovered: 0, attached: [] });
    expect(attachCalls).toBe(0);
    expect(skipped).toEqual([
      { runId: 'cold-other-owner-run', reason: 'owned-by-another-lark-app' },
    ]);
    expect(await log.readAll()).toEqual(beforeEvents);
  });
});
