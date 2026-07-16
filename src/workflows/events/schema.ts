import { z } from 'zod';
import {
  ActorEnum,
  Sha256Schema,
  Sha256Pattern,
  RunCreatedPayload,
  RunStartedPayload,
  RunSucceededPayload,
  RunFailedPayload,
  RunCanceledPayload,
  NodeWaitingPayload,
  NodeRetryingPayload,
  NodeSucceededPayload,
  NodeFailedPayload,
  NodeSkippedPayload,
  NodeCanceledPayload,
  ActivityRunningPayload,
  ActivityWaitingPayload,
  ActivityTimedOutPayload,
  LoopStartedPayload,
  LoopIterationStartedPayload,
  LoopIterationFinishedPayload,
  LoopFinishedPayload,
  ConditionEvaluatedPayload,
  LeaseSignedPayload,
  AttemptCreatedPayload,
  BackoffScheduledPayload,
  BackoffElapsedPayload,
  EffectAttemptedPayload,
  ActivitySucceededPayload,
  ActivityFailedPayload,
  WaitCreatedPayload,
  WaitResolvedPayload,
  WaitDeadlineExceededPayload,
  CancelRequestedPayload,
  CancelDeliveredPayload,
  ActivityCanceledPayload,
  WorkerLostPayload,
  ResumeStartedPayload,
  ReconcileResultPayload,
} from './payloads.js';

// ─── Payload ref / inline ───────────────────────────────────────────────────

export const PayloadRefSchema = z.object({
  ref: z.string().min(1),
  bytes: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
});
export type PayloadRef = z.infer<typeof PayloadRefSchema>;

export function isPayloadRef(p: unknown): p is PayloadRef {
  return (
    typeof p === 'object' &&
    p !== null &&
    'ref' in p &&
    'bytes' in p &&
    'schemaVersion' in p &&
    !('eventId' in p) // sanity: payload object, not envelope
  );
}

// ─── Envelope ───────────────────────────────────────────────────────────────

// eventId = `<runId>-<seq>`, seq is a positive integer.  We allow runIds that
// contain dashes themselves (uuidv4/uuidv7 do), so the format check only
// asserts: must end with `-<positive-integer>`.
export const EventIdSchema = z
  .string()
  .regex(/^.+-[1-9]\d*$/, 'eventId must be <runId>-<seq> with positive integer seq');

const EnvelopeBase = {
  eventId: EventIdSchema,
  runId: z.string().min(1),
  timestamp: z.number().int().positive(),
  schemaVersion: z.literal(1),
  actor: ActorEnum,
  payloadHash: z.string().regex(Sha256Pattern).optional(),
};

/**
 * Build a single event schema by wrapping the envelope around a literal
 * `type` and the type's payload schema.  The payload can be inline (the
 * payload zod object) OR a ref to a blob file when it exceeds the inline
 * size cap (see INLINE_PAYLOAD_MAX_BYTES below).
 *
 * Note the generic constraint `L extends string`: without it, callers
 * passing `'runCreated'` would have the literal widened to `string`, which
 * destroys discriminator narrowing on `z.infer<>` and breaks exhaustive
 * `switch (e.type)` checks downstream (replay, dispatchers, etc.).
 */
function event<L extends string, T extends z.ZodTypeAny>(typeLiteral: L, payloadSchema: T) {
  return z.object({
    ...EnvelopeBase,
    type: z.literal(typeLiteral),
    payload: z.union([payloadSchema, PayloadRefSchema]),
  });
}

// ─── The 31 event schemas ───────────────────────────────────────────────────

// Group 1 — Lifecycle (14)
export const RunCreatedEventSchema = event('runCreated', RunCreatedPayload);
export const RunStartedEventSchema = event('runStarted', RunStartedPayload);
export const RunSucceededEventSchema = event('runSucceeded', RunSucceededPayload);
export const RunFailedEventSchema = event('runFailed', RunFailedPayload);
export const RunCanceledEventSchema = event('runCanceled', RunCanceledPayload);
export const NodeWaitingEventSchema = event('nodeWaiting', NodeWaitingPayload);
export const NodeRetryingEventSchema = event('nodeRetrying', NodeRetryingPayload);
export const NodeSucceededEventSchema = event('nodeSucceeded', NodeSucceededPayload);
export const NodeFailedEventSchema = event('nodeFailed', NodeFailedPayload);
export const NodeSkippedEventSchema = event('nodeSkipped', NodeSkippedPayload);
export const NodeCanceledEventSchema = event('nodeCanceled', NodeCanceledPayload);
export const ActivityRunningEventSchema = event('activityRunning', ActivityRunningPayload);
export const ActivityWaitingEventSchema = event('activityWaiting', ActivityWaitingPayload);
export const ActivityTimedOutEventSchema = event('activityTimedOut', ActivityTimedOutPayload);

// Group 1b — Loop lifecycle (4)
export const LoopStartedEventSchema = event('loopStarted', LoopStartedPayload);
export const LoopIterationStartedEventSchema = event(
  'loopIterationStarted',
  LoopIterationStartedPayload,
);
export const LoopIterationFinishedEventSchema = event(
  'loopIterationFinished',
  LoopIterationFinishedPayload,
);
export const LoopFinishedEventSchema = event('loopFinished', LoopFinishedPayload);

// Group 2 — Scheduling (5)
export const ConditionEvaluatedEventSchema = event('conditionEvaluated', ConditionEvaluatedPayload);
export const LeaseSignedEventSchema = event('leaseSigned', LeaseSignedPayload);
export const AttemptCreatedEventSchema = event('attemptCreated', AttemptCreatedPayload);
export const BackoffScheduledEventSchema = event('backoffScheduled', BackoffScheduledPayload);
export const BackoffElapsedEventSchema = event('backoffElapsed', BackoffElapsedPayload);

// Group 3 — Side Effect (3)
export const EffectAttemptedEventSchema = event('effectAttempted', EffectAttemptedPayload);
export const ActivitySucceededEventSchema = event('activitySucceeded', ActivitySucceededPayload);
export const ActivityFailedEventSchema = event('activityFailed', ActivityFailedPayload);

// Group 4 — Wait / Human (3)
export const WaitCreatedEventSchema = event('waitCreated', WaitCreatedPayload);
export const WaitResolvedEventSchema = event('waitResolved', WaitResolvedPayload);
export const WaitDeadlineExceededEventSchema = event(
  'waitDeadlineExceeded',
  WaitDeadlineExceededPayload,
);

// Group 5 — Control (3)
export const CancelRequestedEventSchema = event('cancelRequested', CancelRequestedPayload);
export const CancelDeliveredEventSchema = event('cancelDelivered', CancelDeliveredPayload);
export const ActivityCanceledEventSchema = event('activityCanceled', ActivityCanceledPayload);

// Group 6 — System / Recovery (3)
export const WorkerLostEventSchema = event('workerLost', WorkerLostPayload);
export const ResumeStartedEventSchema = event('resumeStarted', ResumeStartedPayload);
export const ReconcileResultEventSchema = event('reconcileResult', ReconcileResultPayload);

// ─── Discriminated union over all 31 ────────────────────────────────────────

const EVENT_SCHEMAS = [
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunSucceededEventSchema,
  RunFailedEventSchema,
  RunCanceledEventSchema,
  NodeWaitingEventSchema,
  NodeRetryingEventSchema,
  NodeSucceededEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeCanceledEventSchema,
  ActivityRunningEventSchema,
  ActivityWaitingEventSchema,
  ActivityTimedOutEventSchema,
  LoopStartedEventSchema,
  LoopIterationStartedEventSchema,
  LoopIterationFinishedEventSchema,
  LoopFinishedEventSchema,
  ConditionEvaluatedEventSchema,
  LeaseSignedEventSchema,
  AttemptCreatedEventSchema,
  BackoffScheduledEventSchema,
  BackoffElapsedEventSchema,
  EffectAttemptedEventSchema,
  ActivitySucceededEventSchema,
  ActivityFailedEventSchema,
  WaitCreatedEventSchema,
  WaitResolvedEventSchema,
  WaitDeadlineExceededEventSchema,
  CancelRequestedEventSchema,
  CancelDeliveredEventSchema,
  ActivityCanceledEventSchema,
  WorkerLostEventSchema,
  ResumeStartedEventSchema,
  ReconcileResultEventSchema,
] as const;

/**
 * The discriminated union over all 31 event types — pure, no refinements.
 *
 * Why pure: zod's `.superRefine` wraps the union in `ZodEffects`, which
 * breaks `z.infer<>` narrowing on the discriminator at compile time
 * (`switch (e.type)` won't exhaustively narrow).  The payloadHash
 * invariant (events doc §1.1) lives in `parseEvent` / `safeParseEvent`
 * instead, applied as a post-parse check.
 */
export const EventSchema = z.discriminatedUnion('type', [...EVENT_SCHEMAS]);

export type WorkflowEvent = z.infer<typeof EventSchema>;
export type WorkflowEventType = WorkflowEvent['type'];

// ─── payloadHash invariant + canonical parse helpers ────────────────────────

/**
 * Check the payloadHash <-> payload-ref invariant from events doc §1.1:
 *   - inline payload: payloadHash MUST be absent
 *   - ref payload:    payloadHash MUST be present
 *
 * Returns `null` if the event respects the invariant; otherwise a human
 * readable reason string.  Pure function — no side effects, no throws.
 */
export function checkPayloadHashInvariant(event: WorkflowEvent): string | null {
  const isRef = isPayloadRef(event.payload);
  if (isRef && !event.payloadHash) {
    return 'payloadHash required when payload is a ref';
  }
  if (!isRef && event.payloadHash !== undefined) {
    return 'payloadHash must be absent when payload is inline';
  }
  return null;
}

/**
 * `reconcileResult.capability` × `decision` legal combinations (events
 * doc v0.1.2 §4.3.1 — table updated per spec freeze; the codex round 4
 * variant of this invariant pinned `completedByIdempotentSubmit` to
 * `idempotentSubmit` only, but the spec explicitly allows the
 * `readOnlyLookup → found → completedByIdempotentSubmit` path for
 * schedule, so we widen accordingly):
 *
 *   | decision                       | allowed capability        |
 *   |--------------------------------|---------------------------|
 *   | replayed                       | none                      |
 *   | completedByIdempotentSubmit    | readOnlyLookup OR         |
 *   |                                |   idempotentSubmit        |
 *   | freshRetry                     | readOnlyLookup            |
 *   | manual                         | any                       |
 *
 * Rationale:
 *   - `replayed` means the event log already had a terminal — resume
 *     scans the log, no provider call, capability is `none`.
 *   - `completedByIdempotentSubmit` covers BOTH "ROL found the effect"
 *     (schedule case) and "IS re-submit returned the original ref"
 *     (Feishu case).  The `capability` field disambiguates which path
 *     was taken; the decision name reflects the outcome.
 *   - `freshRetry` requires `readOnlyLookup`: the only way to confirm
 *     "provider definitely doesn't have it, safe to retry" is a
 *     side-effect-free read.  IS by itself cannot produce freshRetry —
 *     a re-submit either lands or fails, no "definitely-not-yet" state.
 *   - `manual` is the catch-all; capability records what was tried.
 *
 * Returns `null` if legal, otherwise a reason string.
 */
export function checkReconcileResultInvariant(event: WorkflowEvent): string | null {
  if (event.type !== 'reconcileResult') return null;
  if (isPayloadRef(event.payload)) return null; // can't inspect ref payload
  const { capability, decision } = event.payload as {
    capability: 'readOnlyLookup' | 'idempotentSubmit' | 'none';
    decision: 'replayed' | 'completedByIdempotentSubmit' | 'manual' | 'freshRetry';
  };
  const allowed: Record<typeof decision, ReadonlyArray<typeof capability>> = {
    replayed: ['none'],
    completedByIdempotentSubmit: ['readOnlyLookup', 'idempotentSubmit'],
    freshRetry: ['readOnlyLookup'],
    manual: ['none', 'readOnlyLookup', 'idempotentSubmit'],
  };
  if (!allowed[decision].includes(capability)) {
    return `reconcileResult: decision='${decision}' requires capability ∈ {${allowed[decision].join(', ')}}, got '${capability}'`;
  }
  return null;
}

/**
 * `waitCreated` shape invariant: `prompt` (inline) and `promptRef` (blob
 * spill) are mutually exclusive, and any spill MUST carry `promptPreview`
 * so cards / dashboard can render without reading the blob file.
 *
 * Schema keeps `prompt` as `z.string().optional()` (no `.max()`) so that
 * historical events with multi-KB inline prompts still parse / replay.
 * The producer (runtime.dispatchGate) is responsible for the 1024-byte
 * split policy.
 */
export function checkWaitCreatedPromptInvariant(event: WorkflowEvent): string | null {
  if (event.type !== 'waitCreated') return null;
  if (isPayloadRef(event.payload)) return null; // ref payloads opaque here
  const p = event.payload as { prompt?: unknown; promptRef?: unknown; promptPreview?: unknown };
  if (p.prompt !== undefined && p.promptRef !== undefined) {
    return 'waitCreated: prompt and promptRef are mutually exclusive';
  }
  if (p.promptRef !== undefined && p.promptPreview === undefined) {
    return 'waitCreated: promptRef requires promptPreview for card / dashboard display';
  }
  return null;
}

export function checkLoopFinishedInvariant(event: WorkflowEvent): string | null {
  if (event.type !== 'loopFinished') return null;
  if (isPayloadRef(event.payload)) return null;
  const p = event.payload as {
    resolution: string;
    errorCode?: string;
    errorClass?: string;
  };
  if (p.resolution === 'max-iterations-exceeded') {
    if (p.errorCode !== 'LoopMaxIterationsExceeded' || p.errorClass !== 'userFault') {
      return "loopFinished: max-iterations-exceeded requires errorCode='LoopMaxIterationsExceeded' and errorClass='userFault'";
    }
  }
  if (p.resolution === 'body-failed') {
    if (p.errorCode !== 'LoopBodyFailed') {
      return "loopFinished: body-failed requires errorCode='LoopBodyFailed'";
    }
    if (!p.errorClass) {
      return "loopFinished: body-failed requires errorClass (derived from underlying body failure)";
    }
  }
  if (p.resolution === 'timeout') {
    if (p.errorCode !== 'WaitDeadlineExceeded' || p.errorClass !== 'userFault') {
      return "loopFinished: timeout requires errorCode='WaitDeadlineExceeded' and errorClass='userFault'";
    }
  }
  return null;
}

/**
 * Run every post-parse invariant against a WorkflowEvent.  Each entry is
 * a `(event) => string | null` checker; the first failure wins and gets
 * surfaced as a ZodIssue.  Adding new invariants here means they apply
 * uniformly to parseEvent / safeParseEvent / append paths.
 */
const POST_PARSE_INVARIANTS: Array<{
  path: (string | number)[];
  check: (event: WorkflowEvent) => string | null;
}> = [
  { path: ['payloadHash'], check: checkPayloadHashInvariant },
  { path: ['payload'], check: checkReconcileResultInvariant },
  { path: ['payload'], check: checkWaitCreatedPromptInvariant },
  { path: ['payload'], check: checkLoopFinishedInvariant },
];

function applyInvariants(event: WorkflowEvent): z.ZodError | null {
  for (const { path, check } of POST_PARSE_INVARIANTS) {
    const reason = check(event);
    if (reason) {
      return new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path,
          message: reason,
        },
      ]);
    }
  }
  return null;
}

/**
 * Parse + validate an unknown value as a WorkflowEvent.  Combines the
 * discriminated-union schema check with the post-parse invariants
 * (payloadHash, reconcileResult capability×decision).  Throws ZodError
 * on failure.
 */
export function parseEvent(raw: unknown): WorkflowEvent {
  const event = EventSchema.parse(raw);
  const err = applyInvariants(event);
  if (err) throw err;
  return event;
}

/**
 * Safe variant of `parseEvent`: returns a result object instead of throwing.
 * Mirrors `ZodType.safeParse` API for ergonomic call sites.
 */
export function safeParseEvent(
  raw: unknown,
):
  | { success: true; data: WorkflowEvent }
  | { success: false; error: z.ZodError } {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error };
  const err = applyInvariants(parsed.data);
  if (err) return { success: false, error: err };
  return { success: true, data: parsed.data };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Inline payload size cap.  Payloads larger than this must be written as a
 * content-addressed blob and referenced via `PayloadRef`.  v0 value is a
 * pragmatic default; verify and tune after dogfooding (see events doc §6.2).
 */
export const INLINE_PAYLOAD_MAX_BYTES = 4096;

/**
 * Per-provider TTL (ms) within which `idempotentSubmit` is safe.  Used by
 * the reconcile path to decide whether a dangling `effectAttempted` can
 * still be safely retried with the same uuid.  Feishu's documented uuid
 * dedupe window is 1 hour (spike report §1.2).
 */
export { PROVIDER_TTL_MS } from '../shared/provider-reconciler.js';

// ─── Re-export Sha256Schema for callers ─────────────────────────────────────

export { Sha256Schema };
