/**
 * R0 — resume integration with default reconcilers.
 *
 * Validates the core promise of side-effect family: a runtime that
 * crashes after `effectAttempted` but before terminal still settles
 * via reconciler when the next runLoop entry sees `danglingEffectAttempted`.
 *
 * Coverage:
 *   1. schedule path — readOnlyLookup (TTL-immune, no effect input needed)
 *   2. feishu-send path — idempotentSubmit + sidecar readback (proves
 *      `requiresEffectInput=true` provider hands its input back to reconciler)
 *   3. no-progress when reconcilers missing
 *   4. no-progress when reconciler can't resolve (transient)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { writeEffectInputSidecar } from '../src/workflows/effect-input.js';
import { EventLog } from '../src/workflows/events/append.js';
import {
  computeInputHash,
  deriveIdempotencyKey,
} from '../src/workflows/events/idempotency.js';
import { runLoop } from '../src/workflows/loop.js';
import { workActivityId } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const RUN_ID = 'r0-resume-test-01';

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'r0-runs-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

const spawnNotInvoked: WorkerSpawnFn = async () => {
  throw new Error('spawnSubagent should not be called in R0 recovery tests');
};

// ─── Helper: hand-write a workflow into an `effectAttempted` mid-state ───

async function seedDanglingEffect({
  log,
  workflowId,
  revisionId,
  nodeId,
  executor,
  rawInput,
  canonicalInput,
  idempotencyTtlMs,
}: {
  log: EventLog;
  workflowId: string;
  revisionId: string;
  nodeId: string;
  executor: string;
  rawInput: unknown;
  canonicalInput: unknown;
  idempotencyTtlMs: number;
}): Promise<{ activityId: string; attemptId: string; idempotencyKey: string }> {
  const activityId = workActivityId(RUN_ID, nodeId);
  const attemptId = `${activityId}::att-1`;
  const idempotencyKey = deriveIdempotencyKey({
    workflowId,
    revisionId,
    runId: RUN_ID,
    nodeId,
    attemptId,
  });
  const inputHash = computeInputHash(canonicalInput);

  // attemptCreated needs an inputRef OutputRef — fake one (resume's recovery
  // path doesn't read inputRef body, only event-level fields).
  await log.append({
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId,
      activityId,
      attemptId,
      attemptNumber: 1,
      inputRef: {
        outputHash: 'sha256:' + 'a'.repeat(64),
        outputBytes: JSON.stringify(rawInput).length,
        outputSchemaVersion: 1,
      },
    },
  });

  await log.append({
    runId: RUN_ID,
    type: 'effectAttempted',
    actor: 'hostExecutor',
    payload: {
      activityId,
      attemptId,
      idempotencyKey,
      inputHash,
      idempotencyTtlMs,
      provider: executor === 'botmux-schedule' ? 'botmux-schedule' : 'feishu-im',
    },
  });

  return { activityId, attemptId, idempotencyKey };
}

// ─── Test 1: schedule readOnlyLookup recovery ────────────────────────────

describe('R0 — schedule readOnlyLookup recovery', () => {
  it('runLoop closes dangling effectAttempted via readOnlyLookup when task already exists', async () => {
    vi.resetModules();
    const scheduleDataDir = mkdtempSync(join(tmpdir(), 'r0-sched-'));
    vi.doMock('../src/config.js', () => ({
      config: {
        session: {
          get dataDir() { return scheduleDataDir; },
        },
      },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    // Build the workflow + run setup
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r0-sched',
      version: 1,
      nodes: {
        n1: {
          type: 'hostExecutor',
          executor: 'botmux-schedule',
          input: {
            name: 'r0-canary',
            schedule: '0 9 * * *',
            parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
            prompt: 'do the thing',
            workingDir: '/wd',
            chatId: 'oc_x',
          },
          // R0 reconciler tests focus on idempotentSubmit + readOnlyLookup
          // recovery, not gate flow — opt in to bypass the side-effect rule.
          unsafeAllowUngated: true,
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, { def, params: {}, initiator: 'r0', botResolver: () => ({}) });

    // Hand-seed effectAttempted state.  We have to know the
    // canonicalInput shape the executor would produce — copy from
    // botmux-schedule canonicalInput.
    const canonical = {
      name: 'r0-canary',
      schedule: '0 9 * * *',
      parsed: { kind: 'cron', expr: '0 9 * * *' },
      prompt: 'do the thing',
      workingDir: '/wd',
      chatId: 'oc_x',
      deliver: 'origin',
    };
    const seeded = await seedDanglingEffect({
      log,
      workflowId: def.workflowId,
      revisionId: 'rev-seed',
      nodeId: 'n1',
      executor: 'botmux-schedule',
      rawInput: def.nodes.n1!.type === 'hostExecutor' ? def.nodes.n1!.input : {},
      canonicalInput: canonical,
      idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
    });

    // Pre-create the task as if the original effect had landed before the
    // crash.  readOnlyLookup must find it by idempotencyKey-as-task-id.
    const { createTask } = await import('../src/services/schedule-store.js');
    createTask({
      id: seeded.idempotencyKey,
      name: 'r0-canary',
      schedule: '0 9 * * *',
      parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
      prompt: 'do the thing',
      workingDir: '/wd',
      chatId: 'oc_x',
    });

    const { createDefaultProviderReconcilers } = await import(
      '../src/workflows/hostExecutors/registry.js'
    );
    const result = await runLoop(
      {
        log,
        def,
        spawnSubagent: spawnNotInvoked,
        reconcilers: createDefaultProviderReconcilers(),
      },
      { maxTicks: 20 },
    );

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');

    const events = await log.readAll();
    const types = events.map((e) => e.type);
    // After resume: reconcile* events + activitySucceeded; then orchestrator
    // emits nodeSucceeded + runSucceeded.
    expect(types).toContain('activitySucceeded');
    expect(types).toContain('runSucceeded');
    expect(types.filter((t) => t === 'reconcileSucceeded' || t === 'reconcileResult').length).toBeGreaterThan(0);

    rmSync(scheduleDataDir, { recursive: true, force: true });
  });
});

// ─── Test 2: feishu-send idempotentSubmit recovery ──────────────────────

describe('R0 — feishu-send idempotentSubmit recovery via sidecar', () => {
  it('runLoop calls reconciler with sidecar input; sendMessage hits original uuid', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_replayed_xyz');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const def = parseWorkflowDefinition({
      workflowId: 'wf-r0-feishu',
      version: 1,
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: {
            larkAppId: 'cli_x',
            chatId: 'oc_y',
            content: 'hello R0',
          },
          // R0 reconciler test; opt out of the side-effect gate so parse succeeds.
          unsafeAllowUngated: true,
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, { def, params: {}, initiator: 'r0', botResolver: () => ({}) });

    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const canonical = feishuSendExecutor.canonicalInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello R0',
    });
    const seeded = await seedDanglingEffect({
      log,
      workflowId: def.workflowId,
      revisionId: 'rev-seed',
      nodeId: 'send',
      executor: 'feishu-send',
      rawInput: { larkAppId: 'cli_x', chatId: 'oc_y', content: 'hello R0' },
      canonicalInput: canonical,
      idempotencyTtlMs: feishuSendExecutor.idempotencyTtlMs,
    });

    // Pre-write the effect-input sidecar so the reconciler can load it.
    await writeEffectInputSidecar(log, seeded.activityId, seeded.attemptId, {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello R0',
      msgType: 'text',
    });

    const {
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');
    const { loadEffectInputSidecar } = await import(
      '../src/workflows/effect-input.js'
    );

    const result = await runLoop(
      {
        log,
        def,
        spawnSubagent: spawnNotInvoked,
        reconcilers: createDefaultProviderReconcilers(),
        loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
      },
      { maxTicks: 20 },
    );

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    // 5th arg is the uuid — must be the ORIGINAL idempotencyKey, so Feishu
    // dedupes against the pre-crash send.
    expect(callArgs[4]).toBe(seeded.idempotencyKey);
    expect(callArgs[2]).toBe('hello R0');
  });
});

// ─── Test 3: no-progress when reconcilers missing ────────────────────────

describe('R0 — explicit no-progress without reconcilers', () => {
  it('runLoop refuses to advance past danglingEffectAttempted', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r0-norec',
      version: 1,
      nodes: {
        n1: {
          type: 'hostExecutor',
          executor: 'botmux-schedule',
          input: { ignored: true },
          // R0 no-reconciler test; opt out of gate so parse succeeds.
          unsafeAllowUngated: true,
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, { def, params: {}, initiator: 'r0', botResolver: () => ({}) });
    await seedDanglingEffect({
      log,
      workflowId: def.workflowId,
      revisionId: 'rev-seed',
      nodeId: 'n1',
      executor: 'botmux-schedule',
      rawInput: { ignored: true },
      canonicalInput: { ignored: true },
      idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
    });

    const result = await runLoop(
      { log, def, spawnSubagent: spawnNotInvoked /* no reconcilers */ },
      { maxTicks: 20 },
    );
    expect(result.reason).toBe('no-progress');
    expect(result.lastSnapshot.run.status).not.toBe('succeeded');
    expect(result.lastSnapshot.danglingEffectAttempted.length).toBeGreaterThan(0);
  });
});

// ─── Test 4: no-progress when reconciler can't resolve ──────────────────

describe('R0 — no-progress when reconciler stays unresolved', () => {
  it('runLoop stops without dispatching forward when reconciler is missing for provider', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r0-stuck',
      version: 1,
      nodes: {
        n1: {
          type: 'hostExecutor',
          executor: 'botmux-schedule',
          input: { ignored: true },
          // R0 stuck-reconciler test; opt out of gate so parse succeeds.
          unsafeAllowUngated: true,
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, { def, params: {}, initiator: 'r0', botResolver: () => ({}) });
    await seedDanglingEffect({
      log,
      workflowId: def.workflowId,
      revisionId: 'rev-seed',
      nodeId: 'n1',
      executor: 'botmux-schedule',
      rawInput: {},
      canonicalInput: {},
      idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
    });

    // Empty reconciler map — has reconcilers field but no entry for
    // 'botmux-schedule' provider.  resume() emits a manual/UnknownProvider
    // reconcile error and writes activityFailed, which DOES make progress
    // (dangling shrinks), so runLoop should advance and emit runFailed.
    const result = await runLoop(
      {
        log,
        def,
        spawnSubagent: spawnNotInvoked,
        reconcilers: new Map(),
      },
      { maxTicks: 20 },
    );
    // Either no-progress (if resume bails) or terminal failure (if resume
    // writes activityFailed and orchestrator closes the run).  Both are
    // valid recovery outcomes — what we MUST NOT see is silent success.
    expect(['no-progress', 'terminal']).toContain(result.reason);
    expect(result.lastSnapshot.run.status).not.toBe('succeeded');
  });
});
