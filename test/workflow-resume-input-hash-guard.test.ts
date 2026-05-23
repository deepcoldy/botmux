/**
 * Resume inputHash guard.
 *
 * When `effectAttempted.inputHash` records the canonical hash of the
 * input the original attempt promised, the resume path MUST verify the
 * loaded sidecar still canonicalizes to the same hash before re-submitting
 * to the provider.  Sidecar tampering / schema drift / manual file edits
 * would otherwise silently let Feishu's uuid dedupe return the original
 * message while our audit trail records a different body.
 *
 * Covered:
 *   1. happy path (no tamper) — sidecar matches, provider called
 *   2. tampered feishu-send sidecar → IdempotencyInputMismatch, NOT sent
 *   3. tampered feishu-reply sidecar → IdempotencyInputMismatch, NOT replied
 *   4. reconciler with `requiresEffectInput=true` but no `canonicalInput`
 *      → IdempotencyInputMismatch (config error fail-loud)
 *   5. composite `feishu-im` reconciler routes canonicalInput by shape
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeEffectInputSidecar,
  loadEffectInputSidecar,
} from '../src/workflows/effect-input.js';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { computeInputHash } from '../src/workflows/events/idempotency.js';
import { resume } from '../src/workflows/resume.js';

const RUN_ID = 'r-hash-guard-01';
const RUN_ID_2 = 'r-hash-guard-02';
const SHA64 = 'a'.repeat(64);
const FAKE_INPUT_REF = {
  outputHash: `sha256:${SHA64}`,
  outputBytes: 1,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'r-hash-guard-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  vi.doUnmock('../src/im/lark/client.js');
  vi.resetModules();
});

async function bootstrapEffectAttempted(opts: {
  log: EventLog;
  activityId: string;
  attemptId: string;
  provider: string;
  idempotencyKey: string;
  inputHash: string;
  ttlMs: number;
}): Promise<void> {
  await opts.log.append({
    runId: opts.log.runId,
    type: 'runCreated',
    actor: 'scheduler',
    payload: {
      workflowId: 'wf-hash-guard',
      revisionId: 'rev-1',
      inputRef: FAKE_INPUT_REF,
      initiator: 'hash-guard-test',
    },
  } as EventDraft);
  await opts.log.append({
    runId: opts.log.runId,
    type: 'runStarted',
    actor: 'scheduler',
    payload: {},
  } as EventDraft);
  await opts.log.append({
    runId: opts.log.runId,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      nodeId: 'n1',
      activityId: opts.activityId,
      attemptId: opts.attemptId,
      attemptNumber: 1,
      inputRef: FAKE_INPUT_REF,
    },
  } as EventDraft);
  await opts.log.append({
    runId: opts.log.runId,
    type: 'effectAttempted',
    actor: 'hostExecutor',
    payload: {
      activityId: opts.activityId,
      attemptId: opts.attemptId,
      idempotencyKey: opts.idempotencyKey,
      inputHash: opts.inputHash,
      idempotencyTtlMs: opts.ttlMs,
      provider: opts.provider,
    },
  } as EventDraft);
}

// ─── Tamper detection: feishu-send sidecar ───────────────────────────────

describe('inputHash guard — feishu-send', () => {
  it('passes through when sidecar canonicalizes to recorded inputHash', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_match');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage: vi.fn(),
      MessageWithdrawnError: class extends Error {},
    }));
    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    const original = {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
      msgType: 'text',
    };
    const inputHash = computeInputHash(feishuSendExecutor.canonicalInput(original));
    const activityId = 'a-send';
    const attemptId = 'a-send::att-1';
    await bootstrapEffectAttempted({
      log,
      activityId,
      attemptId,
      provider: 'feishu-im',
      idempotencyKey: 'wf_idem_send',
      inputHash,
      ttlMs: feishuSendExecutor.idempotencyTtlMs,
    });
    await writeEffectInputSidecar(log, activityId, attemptId, original);

    const r = await resume({
      log,
      runId: log.runId,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', feishuImReconciler]]),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    });

    expect(r.reconcileOutcomes).toHaveLength(1);
    expect(r.reconcileOutcomes[0].decision).toBe('completedByIdempotentSubmit');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][4]).toBe('wf_idem_send');
  });

  it('IdempotencyInputMismatch when sidecar content was tampered', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_should_not_happen');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage: vi.fn(),
      MessageWithdrawnError: class extends Error {},
    }));
    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    // effectAttempted records hash of the ORIGINAL body
    const originalHash = computeInputHash(
      feishuSendExecutor.canonicalInput({
        larkAppId: 'cli_x',
        chatId: 'oc_y',
        content: 'ORIGINAL',
      }),
    );
    const activityId = 'a-send-tamper';
    const attemptId = `${activityId}::att-1`;
    await bootstrapEffectAttempted({
      log,
      activityId,
      attemptId,
      provider: 'feishu-im',
      idempotencyKey: 'wf_idem_tamp_send',
      inputHash: originalHash,
      ttlMs: feishuSendExecutor.idempotencyTtlMs,
    });
    // Sidecar carries DIFFERENT content — simulates manual edit / drift
    await writeEffectInputSidecar(log, activityId, attemptId, {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'TAMPERED',
      msgType: 'text',
    });

    const r = await resume({
      log,
      runId: log.runId,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', feishuImReconciler]]),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(r.reconcileOutcomes).toHaveLength(1);
    const o = r.reconcileOutcomes[0];
    expect(o.decision).toBe('manual');
    const terminal = o.terminalEvent as {
      payload: { error: { errorCode: string; errorClass: string; errorMessage: string } };
    };
    expect(terminal.payload.error.errorCode).toBe('IdempotencyInputMismatch');
    expect(terminal.payload.error.errorClass).toBe('manual');
    expect(terminal.payload.error.errorMessage).toMatch(/hash.*does not match/);
  });
});

// ─── Tamper detection: feishu-reply sidecar ──────────────────────────────

describe('inputHash guard — feishu-reply', () => {
  it('IdempotencyInputMismatch when reply sidecar was tampered', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_should_not_happen');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage: vi.fn(),
      replyMessage,
      MessageWithdrawnError: class extends Error {},
    }));
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    const originalHash = computeInputHash(
      feishuReplyExecutor.canonicalInput({
        larkAppId: 'cli_x',
        rootMessageId: 'om_parent',
        content: 'ORIGINAL',
      }),
    );
    const activityId = 'a-reply-tamper';
    const attemptId = `${activityId}::att-1`;
    await bootstrapEffectAttempted({
      log,
      activityId,
      attemptId,
      provider: 'feishu-im',
      idempotencyKey: 'wf_idem_tamp_reply',
      inputHash: originalHash,
      ttlMs: feishuReplyExecutor.idempotencyTtlMs,
    });
    await writeEffectInputSidecar(log, activityId, attemptId, {
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'TAMPERED',
      msgType: 'text',
      replyInThread: false,
    });

    const r = await resume({
      log,
      runId: log.runId,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', feishuImReconciler]]),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    });

    expect(replyMessage).not.toHaveBeenCalled();
    const terminal = r.reconcileOutcomes[0].terminalEvent as {
      payload: { error: { errorCode: string } };
    };
    expect(terminal.payload.error.errorCode).toBe('IdempotencyInputMismatch');
  });
});

// ─── Config error: requiresEffectInput=true but no canonicalInput ────────

describe('inputHash guard — config error', () => {
  it('IdempotencyInputMismatch when reconciler lacks canonicalInput', async () => {
    const reconciler = {
      provider: 'custom-x',
      requiresEffectInput: true,
      // No canonicalInput — config bug
      async idempotentSubmit() {
        // Should never be called
        return { ok: true as const, externalRefs: {} };
      },
    };
    const activityId = 'a-config-err';
    const attemptId = `${activityId}::att-1`;
    await bootstrapEffectAttempted({
      log,
      activityId,
      attemptId,
      provider: 'custom-x',
      idempotencyKey: 'wf_idem_cfg',
      inputHash: 'sha256:' + 'd'.repeat(64),
      ttlMs: 60_000,
    });
    await writeEffectInputSidecar(log, activityId, attemptId, { whatever: 'x' });

    const r = await resume({
      log,
      runId: log.runId,
      daemonId: 'd-1',
      reconcilers: new Map([['custom-x', reconciler]]),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    });

    expect(r.reconcileOutcomes).toHaveLength(1);
    const terminal = r.reconcileOutcomes[0].terminalEvent as {
      payload: { error: { errorCode: string; errorMessage: string } };
    };
    expect(terminal.payload.error.errorCode).toBe('IdempotencyInputMismatch');
    expect(terminal.payload.error.errorMessage).toMatch(/no canonicalInput/);
  });
});

// ─── Combined reconciler dispatches canonicalInput by shape ──────────────

describe('inputHash guard — combined feishu-im reconciler routing', () => {
  it('dispatches canonicalInput to reply path when rootMessageId present', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_x');
    const sendMessage = vi.fn(async () => 'unexpected');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage,
      MessageWithdrawnError: class extends Error {},
    }));
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    const input = {
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'r',
      msgType: 'text',
      replyInThread: false,
    };
    const inputHash = computeInputHash(feishuReplyExecutor.canonicalInput(input));
    const activityId = 'a-im-route';
    const attemptId = `${activityId}::att-1`;
    await bootstrapEffectAttempted({
      log,
      activityId,
      attemptId,
      provider: 'feishu-im',
      idempotencyKey: 'wf_im_route',
      inputHash,
      ttlMs: feishuReplyExecutor.idempotencyTtlMs,
    });
    await writeEffectInputSidecar(log, activityId, attemptId, input);

    const r = await resume({
      log,
      runId: log.runId,
      daemonId: 'd-1',
      reconcilers: new Map([['feishu-im', feishuImReconciler]]),
      loadEffectInput: (aid, atid) => loadEffectInputSidecar(log, aid, atid),
    });

    // Reply succeeded; send NOT called.
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(r.reconcileOutcomes[0].decision).toBe('completedByIdempotentSubmit');
  });
});
