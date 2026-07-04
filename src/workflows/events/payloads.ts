import { z } from 'zod';

// ─── Shared primitives ──────────────────────────────────────────────────────

export const Sha256Pattern = /^sha256:[0-9a-f]{64}$/;
export const Sha256Schema = z.string().regex(Sha256Pattern, 'must be sha256:<64-hex>');

export const ActorEnum = z.enum([
  'scheduler',
  'worker',
  'hostExecutor',
  'human',
  'supervisor',
  'system',
]);
export type Actor = z.infer<typeof ActorEnum>;

export const ErrorClassEnum = z.enum(['retryable', 'fatal', 'userFault', 'manual']);
export type ErrorClass = z.infer<typeof ErrorClassEnum>;

export const ErrorCodeEnum = z.enum([
  'LeaseExpired',
  'WorkerCrashed',
  'NetworkError',
  'ProviderRateLimited',
  'IdempotencyInputMismatch',
  'IdempotencyConflict',
  'InputValidationFailed',
  // Author wrote a `{ "$ref": ... }` that couldn't be resolved against
  // upstream output at dispatch time — missing node, not-yet-succeeded,
  // path-not-found, missing output blob.  Always userFault: it's a
  // workflow definition / authoring mistake, not a provider issue.
  'InputBindingFailed',
  'OutputSchemaViolation',
  'WaitDeadlineExceeded',
  'TtlExpired',
  'UnknownProviderError',
  // Step 7 round 1 recovery codes:
  //  InputUnrecoverable — reconciler requires the original effect input
  //    to re-submit, but the daemon cannot load it (no callback, callback
  //    threw, or returned undefined).  Always manual class.
  //  CorruptLog — replay/recovery detected an inconsistent event log
  //    (e.g. reconcileResult{decision=replayed} but no terminal event
  //    found).  Always manual class.
  'InputUnrecoverable',
  'CorruptLog',
  'LoopMaxIterationsExceeded',
  // Non-terminator failure inside a loop body (subagent crash /
  // hostExecutor error / non-terminator humanGate reject = fail-run).
  // Carried on `loopFinished` when resolution='body-failed'.  Loop v0.2
  // Step 3 review Medium — see /tmp/wf-loop-v02.md §10.8.
  'LoopBodyFailed',
]);
export type ErrorCode = z.infer<typeof ErrorCodeEnum>;

export const ErrorPayloadSchema = z.object({
  errorCode: ErrorCodeEnum,
  errorClass: ErrorClassEnum,
  errorMessage: z.string().max(4096),
  stackRef: z.string().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const OutputRefSchema = z.object({
  outputHash: Sha256Schema,
  outputPath: z.string().optional(),
  outputBytes: z.number().int().nonnegative(),
  outputSchemaVersion: z.number().int().positive(),
  contentType: z.string().optional(),
});
export type OutputRef = z.infer<typeof OutputRefSchema>;

export const ReconcileCapabilityEnum = z.enum(['readOnlyLookup', 'idempotentSubmit', 'none']);
export const ReconcileDecisionEnum = z.enum([
  'replayed',
  'completedByIdempotentSubmit',
  'manual',
  'freshRetry',
]);

export const WaitKindEnum = z.enum(['human-gate', 'time', 'condition']);
export const WaitResolutionEnum = z.enum(['approved', 'rejected', 'external']);

export const CancelTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: z.string() }),
  z.object({ kind: z.literal('node'), nodeId: z.string() }),
  z.object({ kind: z.literal('activity'), activityId: z.string() }),
]);

export const BackoffPolicySchema = z.object({
  kind: z.enum(['fixed', 'exponential']),
  baseMs: z.number().int().positive(),
  factor: z.number().positive().optional(),
  jitter: z.boolean().optional(),
});

// ─── Group 1 — Lifecycle (14) ───────────────────────────────────────────────

/**
 * Immutable identity snapshot of a workflow bot at run-creation time.
 * Frozen here so subsequent rename / re-wire in bots.json doesn't drift
 * the historical run view (UI doc §3.4).  All fields optional so a bot
 * with partial registry data still serializes cleanly.
 */
export const BotSnapshotSchema = z.object({
  larkAppId: z.string().optional(),
  cliId: z.string().optional(),
  displayName: z.string().optional(),
  workingDir: z.string().optional(),
  cliPathOverride: z.string().optional(),
});
export type BotSnapshot = z.infer<typeof BotSnapshotSchema>;

export const RunCreatedPayload = z.object({
  workflowId: z.string(),
  revisionId: z.string(),
  inputRef: OutputRefSchema,
  initiator: z.string(),
  // Non-breaking extension (UI doc §11): bot name → identity snapshot
  // for every subagent bot referenced in the workflow definition.
  botSnapshots: z.record(BotSnapshotSchema).optional(),
});

export const RunStartedPayload = z.object({}).strict();

export const RunSucceededPayload = z.object({
  outputRef: OutputRefSchema,
});

export const RunFailedPayload = z.object({
  failedNodeId: z.string(),
  rootCauseEventId: z.string(),
});

export const RunCanceledPayload = z.object({
  cancelOriginEventId: z.string(),
});

export const NodeWaitingPayload = z.object({
  nodeId: z.string(),
  waitReason: z.string(),
  deadlineAt: z.number().int().positive().optional(),
});

export const NodeRetryingPayload = z.object({
  nodeId: z.string(),
  lastAttemptId: z.string(),
  nextBackoffMs: z.number().int().nonnegative(),
});

export const NodeSucceededPayload = z.object({
  nodeId: z.string(),
  lastActivityId: z.string(),
});

export const NodeFailedPayload = z.object({
  nodeId: z.string(),
  lastActivityId: z.string(),
  errorClass: ErrorClassEnum,
});

export const NodeSkippedPayload = z.object({
  nodeId: z.string(),
  conditionEventId: z.string(),
});

export const NodeCanceledPayload = z.object({
  nodeId: z.string(),
  cancelOriginEventId: z.string(),
});

export const ActivityRunningPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  leaseId: z.string(),
});

export const ActivityWaitingPayload = z.object({
  activityId: z.string(),
  reason: z.string(),
});

export const ActivityTimedOutPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  runningMs: z.number().int().nonnegative(),
  reason: z.literal('LeaseExpired'),
  errorClass: z.literal('retryable'),
});

// ─── Group 1b — Loop lifecycle (4) ─────────────────────────────────────────

export const LoopStartedPayload = z.object({
  loopId: z.string(),
  maxIterations: z.number().int().positive(),
});

export const LoopIterationStartedPayload = z.object({
  loopId: z.string(),
  iteration: z.number().int().positive(),
  prevResolution: z.enum(['initial', 'rejected']),
});

export const LoopIterationFinishedPayload = z.object({
  loopId: z.string(),
  iteration: z.number().int().positive(),
  resolution: z.enum(['approved', 'rejected']),
  decisionActivityId: z.string(),
  waitResolvedEventId: z.string(),
  by: z.string(),
  comment: z.string().optional(),
  timedOut: z.boolean().optional(),
});

export const LoopFinishedPayload = z.object({
  loopId: z.string(),
  finalIteration: z.number().int().positive(),
  // - approved: terminator decision approved (success)
  // - max-iterations-exceeded: ran out of iterations on rejection
  // - body-failed: non-terminator body node failed (subagent crash /
  //   hostExecutor error / non-terminator humanGate reject = fail-run)
  // - cancelled: user-initiated cancel reached the loop
  // - timeout: terminator humanGate deadline expired
  resolution: z.enum([
    'approved',
    'max-iterations-exceeded',
    'body-failed',
    'cancelled',
    'timeout',
  ]),
  outputRef: OutputRefSchema.optional(),
  errorCode: ErrorCodeEnum.optional(),
  errorClass: ErrorClassEnum.optional(),
});

// ─── Group 2 — Scheduling (5) ───────────────────────────────────────────────

export const ConditionEvaluatedPayload = z.object({
  nodeId: z.string(),
  conditionExpr: z.string(),
  resultTrue: z.boolean(),
  evaluatedInputs: z.record(z.unknown()).optional(),
});

export const LeaseSignedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  leaseId: z.string(),
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});

export const AttemptCreatedPayload = z.object({
  // Codex round 4 finding 3: nodeId is REQUIRED.  Without it, replay
  // can't project node.status idle→triggered when the first attempt is
  // created, so node state stays idle until an explicit terminal
  // node event arrives — and no event in the schema covers
  // "triggered/running" entry.  attemptCreated.nodeId fills that gap.
  nodeId: z.string(),
  activityId: z.string(),
  attemptId: z.string(),
  attemptNumber: z.number().int().positive(),
  inputRef: OutputRefSchema,
});

export const BackoffScheduledPayload = z.object({
  nodeId: z.string(),
  lastAttemptId: z.string(),
  nextAttemptAt: z.number().int().positive(),
  backoffPolicy: BackoffPolicySchema,
});

export const BackoffElapsedPayload = z.object({
  nodeId: z.string(),
  scheduledAttemptId: z.string(),
});

// ─── Group 3 — Side Effect (3) ──────────────────────────────────────────────

export const EffectAttemptedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  // idempotencyKey is the 50-char-bounded provider uuid derived from
  // hash(workflowId:revisionId:runId:nodeId:attemptId). Feishu uuid field
  // accepts ≤ 50 chars; spike report Section 1.6.
  idempotencyKey: z.string().min(1).max(50),
  inputHash: Sha256Schema,
  idempotencyTtlMs: z.number().int().positive(),
  provider: z.string(),
});

export const ActivitySucceededPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  outputRef: OutputRefSchema,
  // type-specific external refs returned by provider on side-effecting
  // succeeded events: send/reply → { messageId }, schedule → { taskId },
  // pure skills omit. v0 keeps the shape open; v0.x+ standardizes per provider.
  externalRefs: z.record(z.unknown()).optional(),
});

export const ActivityFailedPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  error: ErrorPayloadSchema,
});

// ─── Group 4 — Wait / Human (3) ─────────────────────────────────────────────

/**
 * Spec §6 open question #7 resolved at Step 8: `onTimeout` is part of
 * the wait creation payload, not external node IR.  Recording it on the
 * event lets resume materialize the right terminal for a dangling
 * `waitDeadlineExceeded` without consulting external workflow state.
 * Default is `fail` at the consumer (matches spec default behavior).
 */
export const WaitOnTimeoutEnum = z.enum(['fail', 'success']);

export const WaitCreatedPayload = z.object({
  activityId: z.string(),
  nodeId: z.string(),
  waitKind: WaitKindEnum,
  deadlineAt: z.number().int().positive().optional(),
  // `prompt` is the inline form: small prompts (producer policy ≤1024B) live
  // here directly. NO `.max()` on the schema — historical waitCreated events
  // wrote 2-3KB inline prompts and must still replay/parse. The producer
  // strategy split is enforced in `runtime.dispatchGate`, not the wire format.
  prompt: z.string().optional(),
  // Blob-spill form: large prompts go to a content-addressed file via
  // `writeBlob`, and the event carries the resulting `OutputRef` plus a short
  // preview for cards / dashboard. Mutual exclusion with `prompt` is enforced
  // by `checkWaitCreatedPromptInvariant`.
  promptRef: OutputRefSchema.optional(),
  promptPreview: z.string().max(500).optional(),
  approvers: z.array(z.string()).optional(),
  onTimeout: WaitOnTimeoutEnum.optional(),
});

export const WaitResolvedPayload = z.object({
  activityId: z.string(),
  resolution: WaitResolutionEnum,
  by: z.string(),
  comment: z.string().optional(),
});

export const WaitDeadlineExceededPayload = z.object({
  activityId: z.string(),
  deadlineAt: z.number().int().positive(),
  exceededAtMs: z.number().int().positive(),
});

// ─── Group 5 — Control (3) ──────────────────────────────────────────────────

export const CancelRequestedPayload = z.object({
  target: CancelTargetSchema,
  reason: z.string(),
  by: z.string(),
});

export const CancelDeliveredPayload = z.object({
  target: CancelTargetSchema,
  activityId: z.string(),
});

export const ActivityCanceledPayload = z.object({
  activityId: z.string(),
  attemptId: z.string(),
  cancelOriginEventId: z.string(),
});

// ─── Group 6 — System / Recovery (3) ────────────────────────────────────────

export const WorkerLostPayload = z.object({
  workerId: z.string(),
  lostActivityIds: z.array(z.string()).min(1),
});

export const ResumeStartedPayload = z.object({
  daemonId: z.string(),
  lastSeenEventId: z.string(),
});

/**
 * `reconcileResult.evidence` v0 convention (spec §6 Q4 — standardization
 * deferred to v0.x+, but the per-provider shape used by the v0 runtime
 * is fixed here so dashboards and resume recovery can parse it without
 * provider-specific knowledge).
 *
 * Common keys (any provider, any decision):
 *   - `externalRefs`?: Record<string, unknown>
 *       Provider-returned ref (messageId / taskId / ...) — required
 *       for `completedByIdempotentSubmit` decisions, recovery uses it
 *       to materialize `activitySucceeded.payload.externalRefs`.
 *   - `errorCode`?: string
 *       Recorded errorCode for `manual` decisions — recovery uses it
 *       to materialize `activityFailed.payload.error.errorCode`.
 *
 * Manual-only keys (decision='manual'):
 *   - `reason`?: 'ttl_expired' | 'no_reconciler' | 'no_capability'
 *                | 'input_unrecoverable' | 'missing_external_refs'
 *   - `attemptedAtMs`, `nowMs`, `idempotencyTtlMs`?: number
 *       Populated when reason='ttl_expired' for forensics.
 *   - `originalDecision`?: ReconcileDecision
 *       When recovery escalates from a corrupt prior decision (e.g.
 *       replayed/manual without terminal), the original decision the
 *       prior reconcile wrote is preserved here.
 *   - `corruptReason`?: 'missing_external_refs'
 *   - `reconcileEventId`?: string
 *       eventId of the originating reconcileResult (recovery cross-ref).
 *
 * Cancel-coupled keys (Step 9 round 2 — when reconcile fires under
 * cancel, any decision):
 *   - `cancelOriginEventId`?: string  — eventId of the originating
 *     `cancelRequested` so dashboard / forensics can correlate the
 *     cancel × reconcile pair structurally instead of parsing
 *     `activityFailed.errorMessage`.
 *   - `cancelReason`?: string         — `cancelRequested.payload.reason`
 *   - `cancelRequestedBy`?: string    — `cancelRequested.payload.by`
 *
 * These keys are written ONLY by `recoverCancelWithReconcile`'s fresh
 * reconcile cycle; they are absent on regular reconciles and on F1
 * recovery (the prior reconcileResult was written before cancel
 * landed and is immutable).
 *
 * `freshRetry` evidence is provider-specific; v0 puts whatever the
 * reconciler returned from `readOnlyLookup({ found: false })` here.
 *
 * Per-provider conventions (v0):
 *   - `botmux-schedule` readOnlyLookup: `{ source: 'getTask',
 *     returned: 'task' | 'undefined' }`
 *   - `feishu-im` idempotentSubmit: `{ source: 'create-or-reply' }` or
 *     similar; provider just returns externalRefs on success.
 *
 * Future work: lock these per-provider shapes via discriminated
 * schemas keyed on `(decision, capability, provider)`.  Tracked in
 * spec §6 Q4.
 */
export const ReconcileResultPayload = z.object({
  activityId: z.string(),
  idempotencyKey: z.string().min(1).max(50),
  capability: ReconcileCapabilityEnum,
  decision: ReconcileDecisionEnum,
  evidence: z.record(z.unknown()),
});
