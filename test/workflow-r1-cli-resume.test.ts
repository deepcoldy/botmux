/**
 * R1 — `botmux workflow resume <runId>` cold-resume tests.
 *
 * The CLI command is a thin wrapper around `runLoop` with a specific ctx
 * shape: hostExecutors + reconcilers + loadEffectInputSidecar + a
 * throw-FREE `spawnSubagent` stub that returns `WorkerCrashed/manual`.
 * These tests exercise that ctx shape end-to-end against on-disk runDirs.
 *
 * Coverage (codex-loopy review 2026-05-20):
 *   1. dangling `feishu-send` effectAttempted → resume reconciles via
 *      idempotentSubmit with the ORIGINAL idempotencyKey → terminal.
 *   2. open humanGate (waitCreated dangling) → resume returns
 *      `awaiting-wait` with zero `waitResolved` and zero new IM side
 *      effects.
 *   3. subagent dispatch reachable during resume (orchestrator emits
 *      `dispatchWork` on a fresh run) → throw-free stub returns
 *      `WorkerCrashed/manual` → runLoop writes activityFailed + advances
 *      orchestrator to terminal failed.  Verifies the CLI does NOT crash
 *      on a JS exception when subagent work is reached.
 *   4. **cold-start in-flight subagent edge** — runDir has `attemptCreated`
 *      for a subagent activity but NO terminal and NO `effectAttempted`.
 *      R0 recovery only handles the side-effect family, so resume() does
 *      not touch this; orchestrator sees the activity in flight and emits
 *      no actions → runLoop returns `no-progress`.  R1 deliberately does
 *      NOT mark these as WorkerCrashed (R2 daemon cold-scan owns that
 *      decision); this test locks the current behavior so R2's change is
 *      a deliberate flip, not silent drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { writeEffectInputSidecar } from '../src/workflows/effect-input.js';
import { EventLog } from '../src/workflows/events/append.js';
import {
  computeInputHash,
  deriveIdempotencyKey,
} from '../src/workflows/events/idempotency.js';
import { replay } from '../src/workflows/events/replay.js';
import { runLoop } from '../src/workflows/loop.js';
import { workActivityId, gateActivityId } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import { createWait } from '../src/workflows/wait.js';
import type {
  WorkerSpawnFn,
  WorkflowRuntimeContext,
} from '../src/workflows/runtime.js';

const RUN_ID = 'r1-cli-resume-test-01';

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'r1-runs-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

// ─── The throw-free stub that cmdWorkflowResume installs ────────────────
// Mirror of cli/workflow.ts cmdWorkflowResume's spawnSubagent — kept in
// sync deliberately.  If the production stub shape changes, this test
// fixture must change too.
const resumeSpawnStub: WorkerSpawnFn = async (input) => ({
  kind: 'failure',
  errorCode: 'WorkerCrashed',
  errorClass: 'manual',
  errorMessage:
    `subagent '${input.botName}' (node=${input.nodeId}, activity=${input.activityId}) ` +
    `is not resumable via 'botmux workflow resume' — CLI does not spawn workers. ` +
    `Use IM /template run for full execution, or restart the run.`,
});

// Helper to write effectAttempted state matching what dispatchWork would
// have written before a crash.
async function seedEffectAttempted({
  log,
  workflowId,
  revisionId,
  nodeId,
  provider,
  rawInput,
  canonicalInput,
  idempotencyTtlMs,
}: {
  log: EventLog;
  workflowId: string;
  revisionId: string;
  nodeId: string;
  provider: string;
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
      provider,
    },
  });

  return { activityId, attemptId, idempotencyKey };
}

// ─── Test 1: dangling feishu-send → reconcile via idempotentSubmit ──────

describe('R1 — feishu-send cold resume from runDir', () => {
  it('reconciles dangling effectAttempted via reconciler.idempotentSubmit with the recorded idempotencyKey', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_replayed_after_crash');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage: vi.fn(),
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const def = parseWorkflowDefinition({
      workflowId: 'wf-r1-feishu',
      version: 1,
      nodes: {
        send: {
          type: 'hostExecutor',
          executor: 'feishu-send',
          input: {
            larkAppId: 'cli_x',
            chatId: 'oc_y',
            content: 'hello R1 resume',
          },
          // R1 cold-resume test focuses on reconciler idempotency, not gate
          // flow — opt in to bypass the side-effect gate rule.
          unsafeAllowUngated: true,
        },
      },
    });

    // createRun does the on-disk side: writes runDir/workflow.json,
    // params blob, runCreated + runStarted events.  This is EXACTLY the
    // state cmdWorkflowResume reads from disk.
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, { def, params: {}, initiator: 'r1', botResolver: () => ({}) });

    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const canonical = feishuSendExecutor.canonicalInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello R1 resume',
    });
    const seeded = await seedEffectAttempted({
      log,
      workflowId: def.workflowId,
      revisionId: 'rev-seed-r1',
      nodeId: 'send',
      provider: 'feishu-im',
      rawInput: { larkAppId: 'cli_x', chatId: 'oc_y', content: 'hello R1 resume' },
      canonicalInput: canonical,
      idempotencyTtlMs: feishuSendExecutor.idempotencyTtlMs,
    });

    // Sidecar must exist on disk — that's what writeEffectInputSidecar
    // would have written before the crash.
    await writeEffectInputSidecar(log, seeded.activityId, seeded.attemptId, {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello R1 resume',
      msgType: 'text',
    });

    // Build the SAME ctx cmdWorkflowResume builds.  We construct it
    // inline here to keep the test self-contained — the production
    // wiring in src/cli/workflow.ts must stay aligned with this shape.
    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');
    const { loadEffectInputSidecar } = await import(
      '../src/workflows/effect-input.js'
    );

    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: resumeSpawnStub,
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    };

    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = sendMessage.mock.calls[0];
    // The 5th arg is the uuid — Feishu's idempotency surface.  Must be
    // the ORIGINAL key recorded in effectAttempted, otherwise the
    // replay would land a SECOND real message instead of dedup'ing.
    expect(callArgs[4]).toBe(seeded.idempotencyKey);
  });
});

// ─── Test 2: open humanGate → awaiting-wait, zero side effects ──────────

describe('R1 — open humanGate cold resume from runDir', () => {
  it('returns awaiting-wait without re-issuing the card or writing waitResolved', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r1-gate',
      version: 1,
      nodes: {
        approve: {
          type: 'subagent',
          bot: 'b',
          prompt: 'do the thing',
          humanGate: { stage: 'before', prompt: 'ok?' },
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'r1',
      botResolver: () => ({}),
    });

    // Seed the gate state: attemptCreated for the gate activity + an
    // open waitCreated.  Mirrors what dispatchGate would have written
    // before the crash (UI doc §3.4).
    const gateActId = gateActivityId(RUN_ID, 'approve');
    const gateAttemptId = `${gateActId}::att-1`;
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'approve',
        activityId: gateActId,
        attemptId: gateAttemptId,
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'b'.repeat(64),
          outputBytes: 42,
          outputSchemaVersion: 1,
        },
      },
    });
    await createWait(log, {
      activityId: gateActId,
      attemptId: gateAttemptId,
      nodeId: 'approve',
      waitKind: 'human-gate',
      prompt: 'ok?',
    });

    const eventsBefore = await log.readAll();
    const seqBefore = eventsBefore[eventsBefore.length - 1]!.seq;

    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');
    const { loadEffectInputSidecar } = await import(
      '../src/workflows/effect-input.js'
    );

    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: resumeSpawnStub,
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    };

    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('awaiting-wait');
    expect(result.lastSnapshot.run.status).toBe('running');
    expect(result.lastSnapshot.danglingWaits).toContain(gateActId);

    // Zero NEW events written — resume must not re-issue the card or
    // synthesize a resolution.  (The orchestrator emits no actions
    // because the gate is dangling, runLoop returns awaiting-wait
    // immediately.)
    const eventsAfter = await log.readAll();
    const seqAfter = eventsAfter[eventsAfter.length - 1]!.seq;
    expect(seqAfter).toBe(seqBefore);

    // Sanity: no waitResolved was ever appended for this run.
    expect(eventsAfter.some((e) => e.type === 'waitResolved')).toBe(false);
    // No second waitCreated for the same activity, either.
    const waitCreatedCount = eventsAfter.filter(
      (e) => e.type === 'waitCreated',
    ).length;
    expect(waitCreatedCount).toBe(1);
  });
});

// ─── Test 3: subagent dispatch reachable → stub returns failure ─────────

describe('R1 — fresh subagent dispatch during cold resume is rejected, not crashing', () => {
  it('throw-free spawn stub lands as activityFailed{WorkerCrashed/manual} and run terminates failed', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r1-subagent',
      version: 1,
      nodes: {
        n1: {
          type: 'subagent',
          bot: 'b',
          prompt: 'do work',
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'r1',
      botResolver: () => ({}),
    });

    // No seeded dangling state — the run is fresh after createRun, and
    // orchestrator will emit dispatchWork(n1) on its first tick.  This
    // is the path where, if the spawn stub THREW instead of returning
    // failure, the CLI would crash with an unhandled rejection.

    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');
    const { loadEffectInputSidecar } = await import(
      '../src/workflows/effect-input.js'
    );

    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: resumeSpawnStub,
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    };

    // Must not throw — this is the core invariant codex flagged: the
    // CLI exits non-zero but doesn't blow up with an unhandled error.
    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('failed');

    // Verify the failure was RECORDED, not lost.
    const events = await log.readAll();
    const activityFailed = events.find(
      (e) =>
        e.type === 'activityFailed' &&
        !('ref' in e.payload) &&
        (e.payload as { error: { errorCode: string } }).error.errorCode ===
          'WorkerCrashed',
    );
    expect(activityFailed).toBeDefined();
    if (activityFailed && !('ref' in activityFailed.payload)) {
      const err = (
        activityFailed.payload as { error: { errorCode: string; errorClass: string } }
      ).error;
      expect(err.errorCode).toBe('WorkerCrashed');
      expect(err.errorClass).toBe('manual');
    }

    // And the orchestrator closed the run cleanly.
    const snap = replay(events);
    expect(snap.run.failedNodeId).toBe('n1');
  });
});

// ─── Test 4: cold-start in-flight subagent → WorkerCrashed recovery ─────

describe('R2 — in-flight subagent activity on cold resume is marked crashed', () => {
  it('attemptCreated without terminal and without effectAttempted is recovered as WorkerCrashed without re-spawning', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'wf-r1-inflight',
      version: 1,
      nodes: {
        n1: {
          type: 'subagent',
          bot: 'b',
          prompt: 'do work',
        },
      },
    });
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'r1',
      botResolver: () => ({}),
    });

    // Seed an in-flight subagent state: attemptCreated written, no
    // activitySucceeded / activityFailed, and crucially NO effectAttempted
    // (subagent activities don't write that — only hostExecutor does).
    // R0 recovery only consumes the side-effect family, so this entry
    // does NOT show up in danglingEffectAttempted.
    const activityId = workActivityId(RUN_ID, 'n1');
    const attemptId = `${activityId}::att-1`;
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'n1',
        activityId,
        attemptId,
        attemptNumber: 1,
        inputRef: {
          outputHash: 'sha256:' + 'c'.repeat(64),
          outputBytes: 12,
          outputSchemaVersion: 1,
        },
      },
    });

    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');
    const { loadEffectInputSidecar } = await import(
      '../src/workflows/effect-input.js'
    );

    // Spy on spawnSubagent: if anything calls it here, the test was
    // wrong about the seeded state (orchestrator should see the activity
    // in flight and emit no actions).
    let spawnCalls = 0;
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: async (input) => {
        spawnCalls++;
        return resumeSpawnStub(input);
      },
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    };

    const result = await runLoop(ctx, { maxTicks: 50 });

    // R2 cold-scan behavior: non-wait dangling activities are handed to
    // resume(), which materializes WorkerCrashed.  Crucially, the daemon
    // does not re-spawn the old subagent attempt.
    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('failed');
    expect(spawnCalls).toBe(0);

    const eventsAfter = await log.readAll();
    const failure = eventsAfter.find((e) => e.type === 'activityFailed');
    expect(failure?.payload).toMatchObject({
      activityId,
      attemptId,
      error: {
        errorCode: 'WorkerCrashed',
        errorClass: 'retryable',
      },
    });
  });
});
