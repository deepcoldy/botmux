import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventLog,
  type EventDraft,
} from '../src/workflows/events/append.js';
import {
  replay,
  type Snapshot,
} from '../src/workflows/events/replay.js';
import { PROVIDER_TTL_MS } from '../src/workflows/events/schema.js';

const RUN_ID = 'run-replay-test-01';
const SHA = 'sha256:' + 'b'.repeat(64);
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 64,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-replay-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// Helper: append + flatten to events array via readAll
async function snapshotAfter(...drafts: EventDraft[]): Promise<Snapshot> {
  for (const d of drafts) await log.append(d);
  const events = await log.readAll();
  return replay(events);
}

const runCreated: EventDraft = {
  runId: RUN_ID,
  type: 'runCreated',
  actor: 'scheduler',
  payload: {
    workflowId: 'wf-demo',
    revisionId: 'rev-001',
    inputRef: sampleOutputRef,
    initiator: 'sensuosss',
  },
};

describe('replay — preconditions', () => {
  it('throws on empty event list', () => {
    expect(() => replay([])).toThrow(/empty event log/);
  });

  it('throws if first event is not runCreated', async () => {
    // We can't append a non-runCreated as the first event via EventLog
    // without bypassing the schema, so build the array directly.
    await log.append(runCreated);
    const events = await log.readAll();
    // Pop the first event to violate precondition
    const tail = events.slice(1);
    if (tail.length === 0) {
      // Forge a non-runCreated event as the head
      const forged = { ...events[0], type: 'runStarted', payload: {} } as any;
      expect(() => replay([forged])).toThrow(/first event must be runCreated/);
    }
  });

  it('throws on runId mismatch within the log', async () => {
    await log.append(runCreated);
    const events = await log.readAll();
    const e2 = { ...events[0], eventId: 'other-run-2', runId: 'other-run' };
    expect(() => replay([events[0], e2 as any])).toThrow(/runId mismatch/);
  });
});

describe('replay — Run lifecycle', () => {
  it('runCreated alone → run.status=pending + input set', async () => {
    const s = await snapshotAfter(runCreated);
    expect(s.run.status).toBe('pending');
    expect(s.run.workflowId).toBe('wf-demo');
    expect(s.run.initiator).toBe('sensuosss');
    expect(s.run.input?.outputHash).toBe(SHA);
    expect(s.lastSeq).toBe(1);
  });

  it('runStarted → status=running', async () => {
    const s = await snapshotAfter(runCreated, {
      runId: RUN_ID,
      type: 'runStarted',
      actor: 'scheduler',
      payload: {},
    });
    expect(s.run.status).toBe('running');
  });

  it('runSucceeded → status=succeeded + output', async () => {
    const s = await snapshotAfter(
      runCreated,
      { runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} },
      {
        runId: RUN_ID,
        type: 'runSucceeded',
        actor: 'scheduler',
        payload: { outputRef: sampleOutputRef },
      },
    );
    expect(s.run.status).toBe('succeeded');
    expect(s.run.output?.outputHash).toBe(SHA);
  });

  it('runFailed → status=failed + failedNodeId', async () => {
    const s = await snapshotAfter(
      runCreated,
      { runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} },
      {
        runId: RUN_ID,
        type: 'runFailed',
        actor: 'scheduler',
        payload: { failedNodeId: 'n1', rootCauseEventId: `${RUN_ID}-2` },
      },
    );
    expect(s.run.status).toBe('failed');
    expect(s.run.failedNodeId).toBe('n1');
  });

  it('runCanceled → status=cancelled + origin event', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'runCanceled',
        actor: 'scheduler',
        payload: { cancelOriginEventId: `${RUN_ID}-1` },
      },
    );
    expect(s.run.status).toBe('cancelled');
    expect(s.run.cancelOriginEventId).toBe(`${RUN_ID}-1`);
  });
});

describe('replay — Node lifecycle', () => {
  it('nodeWaiting/Succeeded/Failed/Skipped/Canceled project correctly', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'nodeWaiting',
        actor: 'scheduler',
        payload: { nodeId: 'n1', waitReason: 'human gate' },
      },
      {
        runId: RUN_ID,
        type: 'nodeSucceeded',
        actor: 'scheduler',
        payload: { nodeId: 'n2', lastActivityId: 'a2' },
      },
      {
        runId: RUN_ID,
        type: 'nodeFailed',
        actor: 'scheduler',
        payload: { nodeId: 'n3', lastActivityId: 'a3', errorClass: 'fatal' },
      },
      {
        runId: RUN_ID,
        type: 'nodeSkipped',
        actor: 'scheduler',
        payload: { nodeId: 'n4', conditionEventId: `${RUN_ID}-1` },
      },
      {
        runId: RUN_ID,
        type: 'nodeCanceled',
        actor: 'scheduler',
        payload: { nodeId: 'n5', cancelOriginEventId: `${RUN_ID}-1` },
      },
    );
    expect(s.nodes.get('n1')?.status).toBe('waiting');
    expect(s.nodes.get('n2')?.status).toBe('succeeded');
    expect(s.nodes.get('n2')?.activityId).toBe('a2');
    expect(s.nodes.get('n3')?.status).toBe('failed');
    expect(s.nodes.get('n3')?.errorClass).toBe('fatal');
    expect(s.nodes.get('n4')?.status).toBe('skipped');
    expect(s.nodes.get('n5')?.status).toBe('cancelled');
  });

  it('nodeRetrying increments retryCount', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'nodeRetrying',
        actor: 'scheduler',
        payload: { nodeId: 'n1', lastAttemptId: 'at1', nextBackoffMs: 1000 },
      },
      {
        runId: RUN_ID,
        type: 'nodeRetrying',
        actor: 'scheduler',
        payload: { nodeId: 'n1', lastAttemptId: 'at2', nextBackoffMs: 2000 },
      },
    );
    expect(s.nodes.get('n1')?.status).toBe('retrying');
    expect(s.nodes.get('n1')?.retryCount).toBe(2);
  });
});

describe('replay — Activity attempts + status', () => {
  it('attemptCreated → activity.status=pending, attempt registered, node→activity mapping built', async () => {
    const s = await snapshotAfter(runCreated, {
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: 'n1',
        activityId: 'a1',
        attemptId: 'at1',
        attemptNumber: 1,
        inputRef: sampleOutputRef,
      },
    });
    const a = s.activities.get('a1');
    expect(a?.status).toBe('pending');
    expect(a?.attempts).toHaveLength(1);
    expect(a?.attempts[0].attemptId).toBe('at1');
    expect(a?.currentAttemptId).toBe('at1');
    expect(a?.ownerNodeId).toBe('n1');
    // Codex round 4: first attempt projects node.status idle→triggered
    expect(s.nodes.get('n1')?.status).toBe('triggered');
    expect(s.nodes.get('n1')?.activityId).toBe('a1');
  });

  it('activityRunning projects node.status triggered → running via owner mapping', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: {
          nodeId: 'n1',
          activityId: 'a1',
          attemptId: 'at1',
          attemptNumber: 1,
          inputRef: sampleOutputRef,
        },
      },
      {
        runId: RUN_ID,
        type: 'activityRunning',
        actor: 'worker',
        payload: { activityId: 'a1', attemptId: 'at1', leaseId: 'L1' },
      },
    );
    expect(s.activities.get('a1')?.status).toBe('running');
    expect(s.nodes.get('n1')?.status).toBe('running');
  });

  it('retry (attemptNumber > 1) does NOT overwrite node.status — nodeRetrying owns that', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activityFailed',
        actor: 'worker',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          error: { errorCode: 'NetworkError', errorClass: 'retryable', errorMessage: 'x' },
        },
      },
      {
        runId: RUN_ID,
        type: 'nodeRetrying',
        actor: 'scheduler',
        payload: { nodeId: 'n1', lastAttemptId: 'at1', nextBackoffMs: 1000 },
      },
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at2', attemptNumber: 2, inputRef: sampleOutputRef },
      },
    );
    // node.status stays 'retrying' (set by nodeRetrying), not overwritten
    // back to 'triggered' by the new attempt.
    expect(s.nodes.get('n1')?.status).toBe('retrying');
  });

  it('leaseSigned attaches lease info to current attempt', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'leaseSigned',
        actor: 'scheduler',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          leaseId: 'L1',
          timeoutMs: 30000,
          maxOutputBytes: 1024,
        },
      },
    );
    const at = s.activities.get('a1')?.attempts[0];
    expect(at?.leaseId).toBe('L1');
    expect(at?.timeoutMs).toBe(30000);
    expect(at?.maxOutputBytes).toBe(1024);
  });

  it('activityRunning → status=running', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activityRunning',
        actor: 'worker',
        payload: { activityId: 'a1', attemptId: 'at1', leaseId: 'L1' },
      },
    );
    expect(s.activities.get('a1')?.status).toBe('running');
    expect(s.activities.get('a1')?.attempts[0].status).toBe('running');
  });

  it('activitySucceeded → terminal, output recorded, externalRefs preserved', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activitySucceeded',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          outputRef: sampleOutputRef,
          externalRefs: { messageId: 'om_test' },
        },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('succeeded');
    expect(a?.attempts[0].externalRefs).toEqual({ messageId: 'om_test' });
    expect(s.outputs.get('a1')?.outputHash).toBe(SHA);
  });

  it('activityTimedOut → status=timedOut + runningMs', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activityTimedOut',
        actor: 'scheduler',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          runningMs: 30000,
          reason: 'LeaseExpired',
          errorClass: 'retryable',
        },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('timedOut');
    expect(a?.attempts[0].runningMs).toBe(30000);
  });

  it('activityCanceled → status=cancelled + origin event', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activityCanceled',
        actor: 'scheduler',
        payload: { activityId: 'a1', attemptId: 'at1', cancelOriginEventId: `${RUN_ID}-1` },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('cancelled');
    expect(a?.attempts[0].cancelOriginEventId).toBe(`${RUN_ID}-1`);
  });
});

describe('replay — side effect: effectAttempted + terminal projection', () => {
  it('effectAttempted → status=effectAttempting + payload recorded', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'effectAttempted',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          idempotencyKey: 'wf_idem_x',
          inputHash: SHA,
          idempotencyTtlMs: PROVIDER_TTL_MS['feishu-im'],
          provider: 'feishu-im',
        },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('effectAttempting');
    expect(a?.attempts[0].effectAttempted?.idempotencyKey).toBe('wf_idem_x');
    expect(a?.attempts[0].effectAttempted?.provider).toBe('feishu-im');
  });

  it('effectAttempted then activitySucceeded → succeeded terminal, attempt has both records', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'effectAttempted',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          idempotencyKey: 'wf_k',
          inputHash: SHA,
          idempotencyTtlMs: 3600000,
          provider: 'feishu-im',
        },
      },
      {
        runId: RUN_ID,
        type: 'activitySucceeded',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          outputRef: sampleOutputRef,
          externalRefs: { messageId: 'om_xyz' },
        },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('succeeded');
    expect(a?.attempts[0].effectAttempted).toBeDefined();
    expect(a?.attempts[0].externalRefs?.messageId).toBe('om_xyz');
  });
});

describe('replay — dangling sets', () => {
  it('empty when log has no in-flight activity', async () => {
    const s = await snapshotAfter(runCreated);
    expect(s.danglingActivities).toEqual([]);
    expect(s.danglingEffectAttempted).toEqual([]);
    expect(s.danglingWaits).toEqual([]);
  });

  it('attemptCreated with no terminal → activity dangling', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
    );
    expect(s.danglingActivities).toEqual(['a1']);
    expect(s.danglingEffectAttempted).toEqual([]);
  });

  it('effectAttempted with no terminal → both dangling sets contain activity', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'effectAttempted',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          idempotencyKey: 'wf_k',
          inputHash: SHA,
          idempotencyTtlMs: 3600000,
          provider: 'feishu-im',
        },
      },
    );
    expect(s.danglingActivities).toEqual(['a1']);
    expect(s.danglingEffectAttempted).toEqual(['a1']);
  });

  it('effectAttempted + activitySucceeded → not dangling', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'effectAttempted',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          idempotencyKey: 'wf_k',
          inputHash: SHA,
          idempotencyTtlMs: 3600000,
          provider: 'feishu-im',
        },
      },
      {
        runId: RUN_ID,
        type: 'activitySucceeded',
        actor: 'hostExecutor',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          outputRef: sampleOutputRef,
        },
      },
    );
    expect(s.danglingActivities).toEqual([]);
    expect(s.danglingEffectAttempted).toEqual([]);
  });

  it('waitCreated with no resolution → wait dangling', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a1',
          nodeId: 'n1',
          waitKind: 'human-gate',
          prompt: 'ok?',
        },
      },
    );
    expect(s.danglingWaits).toEqual(['a1']);
  });

  it('waitCreated with promptRef → wait.promptRef + promptPreview surface, no blob I/O', async () => {
    // Replay must NOT read the blob file; the OutputRef and preview both
    // flow through to AttemptState.wait so the dashboard / Node I/O can
    // decide when (and whether) to read the full text.
    const fakePromptRef = {
      outputHash: 'sha256:' + 'c'.repeat(64),
      outputPath: '/path/that/does/not/exist',  // proves replay doesn't read
      outputBytes: 5000,
      outputSchemaVersion: 1,
      contentType: 'text/plain',
    };
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: {
          activityId: 'a1',
          nodeId: 'n1',
          waitKind: 'human-gate',
          promptRef: fakePromptRef,
          promptPreview: '出行规划预览：…(完整内容见 dashboard)',
        },
      },
    );
    const at = s.activities.get('a1')?.attempts[0];
    expect(at?.wait?.prompt).toBeUndefined();
    expect(at?.wait?.promptRef).toEqual(fakePromptRef);
    expect(at?.wait?.promptPreview).toMatch(/dashboard/);
  });

  it('waitCreated + waitResolved → not dangling', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a1', nodeId: 'n1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type: 'waitResolved',
        actor: 'human',
        payload: { activityId: 'a1', resolution: 'approved', by: 'user' },
      },
    );
    expect(s.danglingWaits).toEqual([]);
  });

  it('waitCreated + waitDeadlineExceeded → not dangling', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a1', nodeId: 'n1', waitKind: 'time', deadlineAt: Date.now() + 1000 },
      },
      {
        runId: RUN_ID,
        type: 'waitDeadlineExceeded',
        actor: 'scheduler',
        payload: { activityId: 'a1', deadlineAt: 1, exceededAtMs: 2 },
      },
    );
    expect(s.danglingWaits).toEqual([]);
  });

  it.each([
    [
      'activitySucceeded',
      {
        activityId: 'a1',
        attemptId: 'at1',
        outputRef: sampleOutputRef,
      },
    ],
    [
      'activityFailed',
      {
        activityId: 'a1',
        attemptId: 'at1',
        error: {
          errorCode: 'WorkerCrashed',
          errorClass: 'retryable',
          errorMessage: 'worker lost',
        },
      },
    ],
    [
      'activityTimedOut',
      {
        activityId: 'a1',
        attemptId: 'at1',
        runningMs: 1000,
        reason: 'LeaseExpired',
        errorClass: 'retryable',
      },
    ],
    [
      'activityCanceled',
      {
        activityId: 'a1',
        attemptId: 'at1',
        cancelOriginEventId: 'run-replay-test-01-3',
      },
    ],
  ] as const)('waitCreated + %s terminal → not dangling', async (type, payload) => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: {
          nodeId: 'n1',
          activityId: 'a1',
          attemptId: 'at1',
          attemptNumber: 1,
          inputRef: sampleOutputRef,
        },
      },
      {
        runId: RUN_ID,
        type: 'waitCreated',
        actor: 'scheduler',
        payload: { activityId: 'a1', nodeId: 'n1', waitKind: 'human-gate' },
      },
      {
        runId: RUN_ID,
        type,
        actor: 'scheduler',
        payload,
      },
    );
    expect(s.danglingWaits).toEqual([]);
    expect(s.danglingActivities).toEqual([]);
  });
});

describe('replay — retry: multiple attempts in same Activity', () => {
  it('failed attempt + new attemptCreated → activity back to pending, both attempts preserved', async () => {
    const s = await snapshotAfter(
      runCreated,
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at1', attemptNumber: 1, inputRef: sampleOutputRef },
      },
      {
        runId: RUN_ID,
        type: 'activityFailed',
        actor: 'worker',
        payload: {
          activityId: 'a1',
          attemptId: 'at1',
          error: {
            errorCode: 'NetworkError',
            errorClass: 'retryable',
            errorMessage: 'timeout',
          },
        },
      },
      {
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: { nodeId: 'n1', activityId: 'a1', attemptId: 'at2', attemptNumber: 2, inputRef: sampleOutputRef },
      },
    );
    const a = s.activities.get('a1');
    expect(a?.status).toBe('pending'); // latest attempt status
    expect(a?.attempts).toHaveLength(2);
    expect(a?.attempts[0].status).toBe('failed');
    expect(a?.attempts[1].status).toBe('pending');
    expect(a?.currentAttemptId).toBe('at2');
  });
});

describe('replay — lastSeq', () => {
  it('tracks max seq seen', async () => {
    const s = await snapshotAfter(
      runCreated,
      { runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} },
      { runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} },
    );
    expect(s.lastSeq).toBe(3);
  });
});
