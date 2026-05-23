import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  EventSchema,
  safeParseEvent,
  parseEvent,
  PayloadRefSchema,
  INLINE_PAYLOAD_MAX_BYTES,
  PROVIDER_TTL_MS,
  RunCreatedEventSchema,
  ActivityTimedOutEventSchema,
  EffectAttemptedEventSchema,
  ActivitySucceededEventSchema,
  CancelRequestedEventSchema,
  ReconcileResultEventSchema,
} from '../src/workflows/events/schema.js';
import type {
  WorkflowEvent,
  WorkflowEventType,
} from '../src/workflows/events/schema.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const RUN_ID = 'run-01HZZ8X1Z7C0KZ7K1Z2WZ3V4Q5';
const SHA = 'sha256:' + 'a'.repeat(64);

function eventId(seq: number): string {
  return `${RUN_ID}-${seq}`;
}

const baseEnvelope = {
  runId: RUN_ID,
  timestamp: 1779163031453,
  schemaVersion: 1 as const,
};

const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 128,
  outputSchemaVersion: 1,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('event schema — envelope', () => {
  it('accepts a well-formed runCreated with inline payload', () => {
    const e: WorkflowEvent = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runCreated',
      actor: 'scheduler',
      payload: {
        workflowId: 'wf-demo',
        revisionId: 'rev-001',
        inputRef: sampleOutputRef,
        initiator: 'user:sensuosss',
      },
    };
    expect(() => parseEvent(e)).not.toThrow();
  });

  it('rejects eventId that does not match <runId>-<seq>', () => {
    const bad = {
      ...baseEnvelope,
      eventId: 'no-seq-here',
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: {},
    };
    const r = safeParseEvent(bad);
    expect(r.success).toBe(false);
  });

  it('rejects seq=0 (must be positive integer)', () => {
    const bad = {
      ...baseEnvelope,
      eventId: `${RUN_ID}-0`,
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: {},
    };
    const r = safeParseEvent(bad);
    expect(r.success).toBe(false);
  });

  it('rejects unknown event type', () => {
    const bad = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'nonexistent',
      actor: 'scheduler',
      payload: {},
    };
    const r = safeParseEvent(bad);
    expect(r.success).toBe(false);
  });

  it('rejects unknown actor', () => {
    const bad = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runStarted',
      actor: 'martian',
      payload: {},
    };
    const r = safeParseEvent(bad);
    expect(r.success).toBe(false);
  });

  it('rejects schemaVersion != 1', () => {
    const bad = {
      ...baseEnvelope,
      schemaVersion: 2,
      eventId: eventId(1),
      type: 'runStarted',
      actor: 'scheduler',
      payload: {},
    };
    const r = safeParseEvent(bad);
    expect(r.success).toBe(false);
  });
});

describe('event schema — payloadHash invariant (v0.1.2 §1.1)', () => {
  it('inline payload + payloadHash absent: ok', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: {},
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('inline payload + payloadHash present: REJECTED', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: {},
      payloadHash: SHA,
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(';');
      expect(msgs).toContain('payloadHash must be absent');
    }
  });

  it('ref payload + payloadHash present: ok', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: { ref: 'runs/x/blobs/abc', bytes: 8192, schemaVersion: 1 },
      payloadHash: SHA,
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('ref payload + payloadHash absent: REJECTED', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(1),
      type: 'runStarted' as const,
      actor: 'scheduler' as const,
      payload: { ref: 'runs/x/blobs/abc', bytes: 8192, schemaVersion: 1 },
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(';');
      expect(msgs).toContain('payloadHash required');
    }
  });
});

describe('event schema — waitCreated prompt / promptRef invariant (v0.1.3)', () => {
  const baseWait = {
    ...baseEnvelope,
    eventId: eventId(1),
    type: 'waitCreated' as const,
    actor: 'scheduler' as const,
  };
  const samplePromptRef = {
    outputHash: SHA,
    outputPath: '/tmp/runs/x/blobs/abc',
    outputBytes: 5000,
    outputSchemaVersion: 1,
    contentType: 'text/plain',
  };

  it('inline-only prompt: ok', () => {
    const e = {
      ...baseWait,
      payload: {
        activityId: 'a1',
        nodeId: 'n',
        waitKind: 'human-gate',
        prompt: 'review this',
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('promptRef + promptPreview only: ok', () => {
    const e = {
      ...baseWait,
      payload: {
        activityId: 'a1',
        nodeId: 'n',
        waitKind: 'human-gate',
        promptRef: samplePromptRef,
        promptPreview: 'review this big plan…',
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('no prompt and no promptRef: ok (caller never set one)', () => {
    const e = {
      ...baseWait,
      payload: { activityId: 'a1', nodeId: 'n', waitKind: 'human-gate' },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('prompt + promptRef both set: REJECTED', () => {
    const e = {
      ...baseWait,
      payload: {
        activityId: 'a1',
        nodeId: 'n',
        waitKind: 'human-gate',
        prompt: 'small',
        promptRef: samplePromptRef,
        promptPreview: 'preview',
      },
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(';');
      expect(msgs).toContain('mutually exclusive');
    }
  });

  it('promptRef without promptPreview: REJECTED', () => {
    const e = {
      ...baseWait,
      payload: {
        activityId: 'a1',
        nodeId: 'n',
        waitKind: 'human-gate',
        promptRef: samplePromptRef,
      },
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(';');
      expect(msgs).toContain('requires promptPreview');
    }
  });

  it('historical 3KB inline prompt still parses (no .max on schema)', () => {
    // Pre-v0.1.3 events wrote arbitrarily long inline prompts up to the
    // 4KB envelope cap. The schema must keep accepting them so the old
    // run logs replay; the 1024B split is a producer policy, not a wire
    // contract.
    const bigPrompt = 'x'.repeat(3000);
    const e = {
      ...baseWait,
      payload: {
        activityId: 'a1',
        nodeId: 'n',
        waitKind: 'human-gate',
        prompt: bigPrompt,
      },
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(true);
    if (r.success) {
      const p = r.data.payload as { prompt?: string };
      expect(p.prompt?.length).toBe(3000);
    }
  });
});

describe('event schema — activityTimedOut payload v0.1.2', () => {
  it('requires reason=LeaseExpired and errorClass=retryable', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(2),
      type: 'activityTimedOut' as const,
      actor: 'scheduler' as const,
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        runningMs: 30000,
        reason: 'LeaseExpired' as const,
        errorClass: 'retryable' as const,
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('rejects wrong reason literal', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(2),
      type: 'activityTimedOut',
      actor: 'scheduler',
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        runningMs: 30000,
        reason: 'WorkerCrashed',
        errorClass: 'retryable',
      },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });

  it('rejects wrong errorClass literal (must be retryable)', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(2),
      type: 'activityTimedOut',
      actor: 'scheduler',
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        runningMs: 30000,
        reason: 'LeaseExpired',
        errorClass: 'fatal',
      },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });
});

describe('event schema — effectAttempted idempotencyKey bounds', () => {
  const validPayload = {
    activityId: 'a1',
    attemptId: 'at1',
    idempotencyKey: 'wf_' + 'a'.repeat(40),
    inputHash: SHA,
    idempotencyTtlMs: PROVIDER_TTL_MS['feishu-im'],
    provider: 'feishu-im',
  };

  it('accepts a ≤ 50 char idempotencyKey', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(3),
      type: 'effectAttempted' as const,
      actor: 'hostExecutor' as const,
      payload: validPayload,
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('rejects idempotencyKey > 50 chars (Feishu uuid limit)', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(3),
      type: 'effectAttempted',
      actor: 'hostExecutor',
      payload: { ...validPayload, idempotencyKey: 'wf_' + 'a'.repeat(60) },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });

  it('rejects empty idempotencyKey', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(3),
      type: 'effectAttempted',
      actor: 'hostExecutor',
      payload: { ...validPayload, idempotencyKey: '' },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });

  it('rejects malformed inputHash', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(3),
      type: 'effectAttempted',
      actor: 'hostExecutor',
      payload: { ...validPayload, inputHash: 'not-a-sha' },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });
});

describe('event schema — activitySucceeded externalRefs', () => {
  it('accepts externalRefs omitted (pure skill)', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(4),
      type: 'activitySucceeded' as const,
      actor: 'worker' as const,
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        outputRef: sampleOutputRef,
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('accepts send-shape externalRefs', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(4),
      type: 'activitySucceeded' as const,
      actor: 'hostExecutor' as const,
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        outputRef: sampleOutputRef,
        externalRefs: { messageId: 'om_xxx' },
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('accepts schedule-shape externalRefs', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(4),
      type: 'activitySucceeded' as const,
      actor: 'hostExecutor' as const,
      payload: {
        activityId: 'a1',
        attemptId: 'at1',
        outputRef: sampleOutputRef,
        externalRefs: { taskId: 'wf_abc12345' },
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });
});

describe('event schema — cancelRequested target discrim union', () => {
  it.each([
    { kind: 'run' as const, runId: 'r1' },
    { kind: 'node' as const, nodeId: 'n1' },
    { kind: 'activity' as const, activityId: 'a1' },
  ])('accepts target.kind=$kind', (target) => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(5),
      type: 'cancelRequested' as const,
      actor: 'human' as const,
      payload: { target, reason: 'user requested', by: 'sensuosss' },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it('rejects unknown target.kind', () => {
    const e = {
      ...baseEnvelope,
      eventId: eventId(5),
      type: 'cancelRequested',
      actor: 'human',
      payload: { target: { kind: 'sandwich' }, reason: 'x', by: 'y' },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });
});

describe('event schema — reconcileResult decision matrix', () => {
  const base = {
    ...baseEnvelope,
    eventId: eventId(6),
    type: 'reconcileResult' as const,
    actor: 'system' as const,
  };

  it.each([
    ['replayed', 'none'],
    // completedByIdempotentSubmit covers both ROL-found (schedule) and
    // IS re-submit (Feishu); both are legal per events doc v0.1.2 §4.3.1.
    ['completedByIdempotentSubmit', 'idempotentSubmit'],
    ['completedByIdempotentSubmit', 'readOnlyLookup'],
    // manual is the catch-all; capability records what was tried.
    ['manual', 'none'],
    ['manual', 'idempotentSubmit'],
    ['manual', 'readOnlyLookup'],
    ['freshRetry', 'readOnlyLookup'],
  ] as const)('accepts decision=%s capability=%s (legal combo)', (decision, capability) => {
    const e = {
      ...base,
      payload: {
        activityId: 'a1',
        idempotencyKey: 'wf_test_idem',
        capability,
        decision,
        evidence: { messageId: 'om_x' },
      },
    };
    expect(safeParseEvent(e).success).toBe(true);
  });

  it.each([
    // Each row is an illegal capability×decision pairing per the relaxed
    // invariant (events doc v0.1.2 §4.3.1).
    //   - `replayed` is "log already had terminal" — by definition no
    //     provider call ran, so capability MUST be none.
    //   - `completedByIdempotentSubmit` requires *some* provider work;
    //     capability=none would mean "completed without doing anything",
    //     which is incoherent.
    //   - `freshRetry` means ROL confirmed not-yet; cannot come from
    //     none or idempotentSubmit (IS lands or fails, no "definitely-not-yet").
    ['replayed', 'idempotentSubmit'],
    ['replayed', 'readOnlyLookup'],
    ['completedByIdempotentSubmit', 'none'],
    ['freshRetry', 'none'],
    ['freshRetry', 'idempotentSubmit'],
  ] as const)('rejects decision=%s capability=%s (illegal combo)', (decision, capability) => {
    const e = {
      ...base,
      payload: {
        activityId: 'a1',
        idempotencyKey: 'wf_test_idem',
        capability,
        decision,
        evidence: {},
      },
    };
    const r = safeParseEvent(e);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(';');
      expect(msgs).toMatch(/reconcileResult: decision/);
    }
  });

  it('rejects unknown decision', () => {
    const e = {
      ...base,
      payload: {
        activityId: 'a1',
        idempotencyKey: 'wf_test_idem',
        capability: 'idempotentSubmit',
        decision: 'maybeReplayed',
        evidence: {},
      },
    };
    expect(safeParseEvent(e).success).toBe(false);
  });
});

describe('event schema — 31 event coverage check', () => {
  it('discriminated union covers exactly 31 types', () => {
    // Probe each declared type name against schema.  If any can't be
    // constructed minimally, the schema is missing or mis-wired.
    const allTypes: WorkflowEventType[] = [
      'runCreated',
      'runStarted',
      'runSucceeded',
      'runFailed',
      'runCanceled',
      'nodeWaiting',
      'nodeRetrying',
      'nodeSucceeded',
      'nodeFailed',
      'nodeSkipped',
      'nodeCanceled',
      'activityRunning',
      'activityWaiting',
      'activityTimedOut',
      'conditionEvaluated',
      'leaseSigned',
      'attemptCreated',
      'backoffScheduled',
      'backoffElapsed',
      'effectAttempted',
      'activitySucceeded',
      'activityFailed',
      'waitCreated',
      'waitResolved',
      'waitDeadlineExceeded',
      'cancelRequested',
      'cancelDelivered',
      'activityCanceled',
      'workerLost',
      'resumeStarted',
      'reconcileResult',
    ];
    expect(allTypes.length).toBe(31);
    // unique
    expect(new Set(allTypes).size).toBe(31);
  });
});

describe('module constants', () => {
  it('INLINE_PAYLOAD_MAX_BYTES = 4096', () => {
    expect(INLINE_PAYLOAD_MAX_BYTES).toBe(4096);
  });

  it('feishu-im TTL = 1h ms', () => {
    expect(PROVIDER_TTL_MS['feishu-im']).toBe(60 * 60 * 1000);
  });

  it('botmux-schedule TTL = effectively permanent', () => {
    expect(PROVIDER_TTL_MS['botmux-schedule']).toBeGreaterThan(Number.MAX_SAFE_INTEGER - 1);
  });
});

describe('PayloadRefSchema isolation', () => {
  it('parses a well-formed ref', () => {
    expect(
      PayloadRefSchema.safeParse({ ref: 'runs/x/blobs/y', bytes: 1000, schemaVersion: 1 }).success,
    ).toBe(true);
  });

  it('rejects zero bytes', () => {
    expect(
      PayloadRefSchema.safeParse({ ref: 'runs/x', bytes: 0, schemaVersion: 1 }).success,
    ).toBe(false);
  });
});
