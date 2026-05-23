/**
 * A3-companion — feishu-reply-demo end-to-end with mocked Feishu client +
 * cold-resume dogfood proving the combined `feishu-im` reconciler hits
 * `replyMessage` (not `sendMessage`) with the original uuid.
 *
 * Two scenarios:
 *   1. Forward path — runtime dispatch through hostExecutor → invoke →
 *      replyMessage; asserts canonical input pins `rootMessageId`, effect-
 *      input sidecar contains the resolved+parsed input, and the output
 *      blob shape matches B-output's `{output, externalRefs}`.
 *   2. Recovery path — pre-seed `effectAttempted` + sidecar on disk, run
 *      `runLoop` with default reconcilers (which includes the combined
 *      `feishu-im` dispatcher).  The reconciler MUST dispatch by
 *      `rootMessageId` to the reply branch, NOT to send.
 *
 * No real Feishu API call — replyMessage / sendMessage both mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { writeEffectInputSidecar, loadEffectInputSidecar } from '../src/workflows/effect-input.js';
import { EventLog } from '../src/workflows/events/append.js';
import {
  computeInputHash,
  deriveIdempotencyKey,
} from '../src/workflows/events/idempotency.js';
import { runLoop } from '../src/workflows/loop.js';
import { workActivityId } from '../src/workflows/orchestrator.js';
import { createRun } from '../src/workflows/run-init.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const FIXTURE_PATH = join(__dirname, '..', 'workflows', 'feishu-reply-demo.workflow.json');

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-a3-runs-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

const spawnNotInvoked: WorkerSpawnFn = async () => {
  throw new Error('spawnSubagent should not be called for hostExecutor-only workflows');
};

describe('feishu-reply-demo workflow — A3 forward path (mocked client)', () => {
  it('drives feishu-reply end-to-end via mock, pins rootMessageId in canonical input', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_reply_a3');
    const sendMessage = vi.fn(async () => 'unexpected');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');

    const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const def = parseWorkflowDefinition(JSON.parse(raw));
    expect(def.workflowId).toBe('feishu-reply-demo');

    const runId = `feishu-reply-demo-${Date.now()}`;
    const log = new EventLog(runId, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'a3-companion',
      botResolver: () => ({}),
    });

    const ctx = {
      log,
      def,
      spawnSubagent: spawnNotInvoked,
      hostExecutors: createDefaultHostExecutorRegistry(),
      reconcilers: createDefaultProviderReconcilers(),
      loadEffectInput: (aid: string, atid: string) => loadEffectInputSidecar(log, aid, atid),
    };
    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    const replyArgs = replyMessage.mock.calls[0];
    expect(replyArgs[0]).toBe('cli_demo_PLACEHOLDER');
    expect(replyArgs[1]).toBe('om_demo_PLACEHOLDER');
    expect(replyArgs[2]).toBe('feishu-reply-demo: workflow A3 reply');
    expect(replyArgs[3]).toBe('text');
    expect(replyArgs[4]).toBe(false);
    expect(replyArgs[5]).toMatch(/^wf_[0-9a-f]+$/);

    const events = await log.readAll();
    const effect = events.find((e) => e.type === 'effectAttempted')! as {
      payload: { provider: string; idempotencyKey: string; inputHash: string };
    };
    expect(effect.payload.provider).toBe('feishu-im');
    expect(replyArgs[5]).toBe(effect.payload.idempotencyKey);

    const succeeded = events.find((e) => e.type === 'activitySucceeded')! as {
      payload: {
        externalRefs: { messageId: string };
        outputRef: { outputPath: string; contentType?: string };
      };
    };
    expect(succeeded.payload.externalRefs.messageId).toBe('om_reply_a3');
    const blob = JSON.parse(
      await fs.readFile(succeeded.payload.outputRef.outputPath, 'utf-8'),
    );
    expect(blob).toEqual({
      output: { messageId: 'om_reply_a3' },
      externalRefs: { messageId: 'om_reply_a3' },
    });

    // Effect-input sidecar carries the resolved+parsed input (rootMessageId
    // explicitly pinned — that's what makes Feishu treat the dedupe key as
    // bound to a thread, not a chat).
    const sendActId = workActivityId(runId, 'reply-thread');
    const succeededEvent = events.find((e) => e.type === 'activitySucceeded')!;
    const attemptId = (succeededEvent.payload as { attemptId: string }).attemptId;
    const sidecar = await loadEffectInputSidecar(log, sendActId, attemptId);
    expect(sidecar).toEqual({
      larkAppId: 'cli_demo_PLACEHOLDER',
      rootMessageId: 'om_demo_PLACEHOLDER',
      content: 'feishu-reply-demo: workflow A3 reply',
      msgType: 'text',
      replyInThread: false,
    });
  });
});

// ─── Resume dogfood: combined feishu-im reconciler routes reply by shape ─

describe('feishu-reply-demo workflow — A3 R0 recovery (combined reconciler)', () => {
  it('replays via replyMessage with original uuid; never touches sendMessage', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_reply_replayed');
    const sendMessage = vi.fn(async () => 'unexpected');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));

    const { createDefaultProviderReconcilers } = await import(
      '../src/workflows/hostExecutors/registry.js'
    );
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );

    const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const def = parseWorkflowDefinition(JSON.parse(raw));
    const RUN_ID = 'feishu-reply-demo-resume-01';
    const log = new EventLog(RUN_ID, runsDir);
    await createRun(log, {
      def,
      params: {},
      initiator: 'a3-companion-resume',
      botResolver: () => ({}),
    });

    // Hand-seed: attemptCreated + effectAttempted, no terminal.
    const nodeId = 'reply-thread';
    const activityId = workActivityId(RUN_ID, nodeId);
    const attemptId = `${activityId}::att-1`;
    const replyInput = {
      larkAppId: 'cli_demo_PLACEHOLDER',
      rootMessageId: 'om_demo_PLACEHOLDER',
      content: 'feishu-reply-demo: workflow A3 reply',
      msgType: 'text',
      replyInThread: false,
    };
    const canonical = feishuReplyExecutor.canonicalInput(replyInput);
    const inputHash = computeInputHash(canonical);
    // revisionId is computed inside createRun; read it back via replay
    // before we hand-write any further events.
    const { replay } = await import('../src/workflows/events/replay.js');
    const seedSnap = replay(await log.readAll());
    const revisionId = seedSnap.run.revisionId!;
    const idempotencyKey = deriveIdempotencyKey({
      workflowId: def.workflowId,
      revisionId,
      runId: RUN_ID,
      nodeId,
      attemptId,
    });

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
          outputBytes: 1,
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
        idempotencyTtlMs: feishuReplyExecutor.idempotencyTtlMs,
        provider: 'feishu-im',
      },
    });
    // Pre-write the sidecar — combined reconciler will read it via
    // ctx.loadEffectInput, then dispatch by rootMessageId.
    await writeEffectInputSidecar(log, activityId, attemptId, replyInput);

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

    // The combined reconciler MUST have routed to the reply branch.
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const replyArgs = replyMessage.mock.calls[0];
    // Same uuid as pre-crash effectAttempted recorded → Feishu dedupe
    // contract holds.
    expect(replyArgs[5]).toBe(idempotencyKey);
    expect(replyArgs[1]).toBe('om_demo_PLACEHOLDER');
  });
});
