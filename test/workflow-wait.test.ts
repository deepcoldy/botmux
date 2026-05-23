import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  createWait,
  resolveWait,
  expireWait,
} from '../src/workflows/wait.js';

const RUN_ID = 'run-wait-test-01';
const SHA = 'sha256:' + 'e'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 24,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-wait-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const runCreated: EventDraft = {
  runId: RUN_ID,
  type: 'runCreated',
  actor: 'scheduler',
  payload: {
    workflowId: 'wf-demo',
    revisionId: 'rev-001',
    inputRef: sampleOutputRef,
    initiator: 'tester',
  },
};

function attemptCreated(activityId: string, attemptId: string, nodeId = 'n-1'): EventDraft {
  return {
    runId: RUN_ID,
    type: 'attemptCreated',
    actor: 'scheduler',
    payload: {
      activityId,
      attemptId,
      attemptNumber: 1,
      nodeId,
      inputRef: sampleOutputRef,
    },
  };
}

async function bootstrapAttempt(activityId: string, attemptId: string, nodeId = 'n-1'): Promise<void> {
  await log.append(runCreated);
  await log.append(attemptCreated(activityId, attemptId, nodeId));
}

// ─── createWait ────────────────────────────────────────────────────────────

describe('wait — createWait', () => {
  it('writes a waitCreated event with all optional fields', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    const e = await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
      deadlineAt: 99_999,
      prompt: 'approve please',
      onTimeout: 'success',
    });
    expect(e.type).toBe('waitCreated');
    const p = e.payload as {
      activityId: string;
      waitKind: string;
      deadlineAt?: number;
      prompt?: string;
      onTimeout?: string;
    };
    expect(p.activityId).toBe('a-1');
    expect(p.waitKind).toBe('human-gate');
    expect(p.deadlineAt).toBe(99_999);
    expect(p.prompt).toBe('approve please');
    expect(p.onTimeout).toBe('success');
  });

  it('rejects waitKind=time without deadlineAt', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await expect(
      createWait(log, {
        activityId: 'a-1',
        attemptId: 'at-1',
        nodeId: 'n-1',
        waitKind: 'time',
      }),
    ).rejects.toThrow(/waitKind='time' requires deadlineAt/);
  });

  it('replay projects waitCreated into AttemptState.wait', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
      prompt: 'ok?',
      onTimeout: 'fail',
    });
    const snap = replay(await log.readAll());
    const a = snap.activities.get('a-1');
    expect(a?.attempts[0].wait).toMatchObject({
      waitKind: 'human-gate',
      prompt: 'ok?',
      onTimeout: 'fail',
    });
    expect(snap.danglingWaits).toContain('a-1');
    expect(snap.danglingWaitResolutions).not.toContain('a-1');
  });
});

// ─── resolveWait ───────────────────────────────────────────────────────────

describe('wait — resolveWait', () => {
  it('approved → waitResolved + activitySucceeded with external_refs.resolution=approved', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
    });
    const r = await resolveWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      resolution: 'approved',
      by: 'ou_alice',
      comment: 'lgtm',
    });
    expect(r.resolutionEvent.type).toBe('waitResolved');
    expect(r.terminalEvent.type).toBe('activitySucceeded');
    const p = r.terminalEvent.payload as { externalRefs: Record<string, unknown> };
    expect(p.externalRefs).toMatchObject({
      resolution: 'approved',
      by: 'ou_alice',
      comment: 'lgtm',
    });
  });

  it('rejected → waitResolved + activityFailed{InputValidationFailed, userFault}', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
    });
    const r = await resolveWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      resolution: 'rejected',
      by: 'ou_alice',
      comment: 'nope',
    });
    expect(r.terminalEvent.type).toBe('activityFailed');
    const p = r.terminalEvent.payload as { error: { errorCode: string; errorClass: string; errorMessage: string } };
    expect(p.error.errorCode).toBe('InputValidationFailed');
    expect(p.error.errorClass).toBe('userFault');
    expect(p.error.errorMessage).toMatch(/rejected by ou_alice/);
    expect(p.error.errorMessage).toMatch(/nope/);
  });

  it('external → waitResolved (actor=system) + activitySucceeded with extra output', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'condition',
    });
    const r = await resolveWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      resolution: 'external',
      by: 'system',
      output: { sourceEventId: 'evt-99' },
    });
    expect(r.resolutionEvent.actor).toBe('system');
    expect(r.terminalEvent.type).toBe('activitySucceeded');
    const p = r.terminalEvent.payload as { externalRefs: Record<string, unknown> };
    expect(p.externalRefs).toMatchObject({
      resolution: 'external',
      by: 'system',
      sourceEventId: 'evt-99',
    });
  });

  it('replay clears danglingWaits after waitResolved', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
    });
    await resolveWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      resolution: 'approved',
      by: 'ou_alice',
    });
    const snap = replay(await log.readAll());
    expect(snap.danglingWaits).not.toContain('a-1');
    expect(snap.danglingWaitResolutions).not.toContain('a-1');
    // wait.resolution should be projected too
    expect(snap.activities.get('a-1')?.attempts[0].wait?.resolution).toMatchObject({
      kind: 'resolved',
      resolution: 'approved',
      by: 'ou_alice',
    });
  });
});

// ─── expireWait ────────────────────────────────────────────────────────────

describe('wait — expireWait', () => {
  it('default (onTimeout=fail) → waitDeadlineExceeded + activityFailed{WaitDeadlineExceeded}', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'time',
      deadlineAt: 1_000_000,
    });
    const r = await expireWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      deadlineAt: 1_000_000,
      exceededAtMs: 1_000_010,
    });
    expect(r.deadlineEvent.type).toBe('waitDeadlineExceeded');
    expect(r.terminalEvent.type).toBe('activityFailed');
    const p = r.terminalEvent.payload as { error: { errorCode: string; errorClass: string } };
    expect(p.error.errorCode).toBe('WaitDeadlineExceeded');
    expect(p.error.errorClass).toBe('userFault');
  });

  it('onTimeout=success → waitDeadlineExceeded + activitySucceeded{defaultedToTimeout: true}', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'time',
      deadlineAt: 1_000_000,
      onTimeout: 'success',
    });
    const r = await expireWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      deadlineAt: 1_000_000,
      exceededAtMs: 1_000_010,
      onTimeout: 'success',
    });
    expect(r.terminalEvent.type).toBe('activitySucceeded');
    const p = r.terminalEvent.payload as { externalRefs: { defaultedToTimeout: boolean } };
    expect(p.externalRefs.defaultedToTimeout).toBe(true);
  });

  it('replay projects deadlineExceeded into AttemptState.wait.resolution', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'time',
      deadlineAt: 1_000_000,
    });
    await expireWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      deadlineAt: 1_000_000,
      exceededAtMs: 1_000_010,
    });
    const snap = replay(await log.readAll());
    expect(snap.activities.get('a-1')?.attempts[0].wait?.resolution).toMatchObject({
      kind: 'deadlineExceeded',
      deadlineAt: 1_000_000,
      exceededAtMs: 1_000_010,
    });
    expect(snap.danglingWaits).not.toContain('a-1');
  });
});

// ─── Crash boundary: wait resolved but terminal missing → dangling ─────────

describe('wait — dangling resolution surface (Step 8 → resume)', () => {
  it('surfaces "resolved but no terminal" via danglingWaitResolutions', async () => {
    await bootstrapAttempt('a-1', 'at-1');
    await createWait(log, {
      activityId: 'a-1',
      attemptId: 'at-1',
      nodeId: 'n-1',
      waitKind: 'human-gate',
    });
    // Append waitResolved directly (skipping resolveWait's terminal
    // write) to simulate a crash between waitResolved and the terminal.
    await log.append({
      runId: RUN_ID,
      type: 'waitResolved',
      actor: 'human',
      payload: {
        activityId: 'a-1',
        resolution: 'approved',
        by: 'ou_alice',
      },
    });
    const snap = replay(await log.readAll());
    expect(snap.danglingWaitResolutions).toContain('a-1');
    expect(snap.danglingActivities).toContain('a-1');
  });
});
