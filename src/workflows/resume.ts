/**
 * Resume + reconcile algorithm (events doc v0.1.2 §4.3 + §4.3.1).
 *
 * Entry point for daemon restart / hand-off.  Walks the event log,
 * replays a snapshot, then drives reconcile decisions for each dangling
 * `effectAttempted` and writes terminal events for `pure skill`
 * activities that crashed mid-flight (workerLost path).
 *
 * Step 7 boundaries:
 *   - Resume DOES NOT execute activity logic; reconcile uses provider
 *     capabilities (`readOnlyLookup` / `idempotentSubmit`) to decide
 *     terminal state without re-issuing user-visible work beyond what
 *     idempotency guarantees.
 *   - Resume DOES NOT decide retry policy.  A `freshRetry` decision
 *     leaves the attempt dangling — the scheduler (Step 8+) is
 *     responsible for spawning the actual replacement attempt.
 *   - Dangling waits are left alone (waiting for external signal).
 *
 * Round 1 fixes (codex review of `1d14081`):
 *   F1 — replay surfaces the latest reconcileResult per attempt; resume
 *        consumes it before re-running the decision tree, so a crash
 *        between reconcileResult and the terminal event is recoverable.
 *   F2 — reconcilers receive the materialized effect input via the
 *        caller-supplied `loadEffectInput` callback.  Reconcilers that
 *        require input (e.g. Feishu — chatId/rootMessageId/content can't
 *        be reconstructed from idempotencyKey alone) fail explicitly
 *        when input is unrecoverable.
 *   F3 — `retryable` failures from idempotentSubmit do NOT terminate
 *        the attempt; the activity stays dangling and is surfaced in
 *        `ResumeResult.transientFailures` for the caller to retry.
 *   F4 — `resumeStarted` is written ONLY after a preflight validates
 *        the log is replayable; bad inputs throw without polluting the
 *        run event log.
 */

import type { EventLog } from './events/append.js';
import { computeInputHash } from './events/idempotency.js';
import { replay, type Snapshot, type AttemptState } from './events/replay.js';
import type {
  ActivityCanceledEvent,
  ActivityFailedEvent,
  ActivitySucceededEvent,
  ReconcileResultEvent,
  ResumeStartedEvent,
} from './events/types.js';

// ─── Public surface ─────────────────────────────────────────────────────────

export type ReconcileCapability = 'readOnlyLookup' | 'idempotentSubmit' | 'none';

export type ReconcileDecision =
  | 'replayed'
  | 'completedByIdempotentSubmit'
  | 'manual'
  | 'freshRetry';

export type ReadOnlyLookupResult =
  | { found: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | { found: false; evidence?: Record<string, unknown> };

export type IdempotentSubmitResult =
  | { ok: true; externalRefs: Record<string, unknown>; evidence?: Record<string, unknown> }
  | {
      ok: false;
      errorCode: string;
      errorClass: 'retryable' | 'fatal' | 'userFault' | 'manual';
      errorMessage: string;
      evidence?: Record<string, unknown>;
    };

/**
 * Per-provider capability bundle.  Resume looks up the reconciler by the
 * `effectAttempted.provider` field; missing entries fall through to
 * manual/UnknownProviderError.
 *
 * Reconcilers receive the materialized effect input alongside the
 * idempotencyKey: providers like Feishu can't re-construct the request
 * body from the key alone (the key is a hash, not the body).  When the
 * caller doesn't supply `loadEffectInput`, resume treats the input as
 * `undefined`; reconcilers that NEED input MUST declare so via
 * `requiresEffectInput` so resume can fail fast with a clear error
 * instead of letting the reconciler silently misbehave.
 */
export interface ProviderReconciler {
  readonly provider: string;
  /**
   * When `true`, resume refuses to call this reconciler without a
   * materialized effect input — i.e. it writes manual/InputUnrecoverable
   * if `loadEffectInput` is absent or throws.  Feishu sets this; schedule
   * does not (idempotencyKey is the full key).
   */
  readonly requiresEffectInput?: boolean;
  /**
   * Pure read against the provider keyed by `idempotencyKey`.  Has no
   * side effects; safe to call from resume even when we don't intend to
   * complete the effect.  Schedule has it (`getTask(id)`); Feishu does
   * not (no uuid-reverse-lookup API).
   */
  readOnlyLookup?(idempotencyKey: string, input: unknown): Promise<ReadOnlyLookupResult>;
  /**
   * Re-submit the effect with the same `idempotencyKey`.  MAY produce
   * the side effect for real (if the original pre-invoke crash never
   * reached the provider); provider dedupe inside TTL guarantees the
   * second submit returns the original ref instead of a duplicate.
   */
  idempotentSubmit?(idempotencyKey: string, input: unknown): Promise<IdempotentSubmitResult>;
  /**
   * Canonical form of the loaded effect input — used at resume time to
   * recompute `inputHash` and compare against `effectAttempted.inputHash`.
   * MUST mirror the executor's `canonicalInput` exactly; mismatched
   * canonicalization across resume/dispatch silently breaks idempotency.
   *
   * Reconcilers with `requiresEffectInput=true` SHOULD implement this;
   * resume writes `IdempotencyInputMismatch/manual` if a tampered or
   * drifted sidecar would otherwise reach the provider with a different
   * body than the original attempt promised.
   */
  canonicalInput?(input: unknown): unknown;
}

export type ResumeContext = {
  /** Authoritative event log for this run.  Resume writes events into it. */
  log: EventLog;
  /** Match `log.runId`; passed explicitly so the contract is visible. */
  runId: string;
  /** Daemon identifier for the resumeStarted audit event. */
  daemonId: string;
  /** Reconcilers keyed by provider name (`feishu-im`, `botmux-schedule`). */
  reconcilers: Map<string, ProviderReconciler>;
  /**
   * Load the materialized effect input that was passed to the original
   * attempt.  Required for providers that re-submit (Feishu).  Resume
   * passes the returned value to the reconciler's readOnlyLookup /
   * idempotentSubmit.
   *
   * v0: the caller (daemon) decides where to persist or recover this —
   * in-memory while alive, or some external storage on cold start.
   * Resume only consumes the callback.
   *
   * Returning `undefined` is treated as "input unrecoverable" and
   * triggers the manual/InputUnrecoverable path for reconcilers that
   * declared `requiresEffectInput`.
   */
  loadEffectInput?(activityId: string, attemptId: string): Promise<unknown>;
  /** Injectable clock for deterministic tests.  Defaults to Date.now. */
  now?: () => number;
};

export type ReconcileOutcome = {
  activityId: string;
  attemptId: string;
  idempotencyKey: string;
  provider: string;
  capability: ReconcileCapability;
  decision: ReconcileDecision;
  evidence: Record<string, unknown>;
  /**
   * Terminal event written as a consequence.  null for `replayed` (the
   * pre-existing terminal IS the consequence) and `freshRetry` (scheduler
   * issues a new attempt later, not Step 7's job).
   */
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent | null;
  /** The reconcileResult event written, or null if this outcome reused
   *  a pre-existing reconcileResult (recovery path — codex F1). */
  reconcileEvent: ReconcileResultEvent | null;
  /** True when this outcome recovered a prior crashed reconcile cycle
   *  rather than running the decision tree from scratch. */
  recovered: boolean;
};

export type WorkerCrashedOutcome = {
  activityId: string;
  attemptId: string;
  terminalEvent: ActivityFailedEvent;
};

/**
 * Recovery of a wait whose resolution event landed but whose activity
 * terminal was never written (crash between `waitResolved` /
 * `waitDeadlineExceeded` and the terminal).  Step 8: replay surfaces
 * these as `Snapshot.danglingWaitResolutions`; resume materializes the
 * terminal from the recorded resolution.
 */
export type WaitRecoveryOutcome = {
  activityId: string;
  attemptId: string;
  /** What the recovery decided to write. */
  kind: 'succeeded' | 'failed';
  source: 'resolved' | 'deadlineExceeded';
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent;
};

/**
 * Recovery of a cancel whose request landed but whose activity
 * terminal was never written (crash between `cancelRequested` /
 * `cancelDelivered` and the terminal).  Step 9: replay surfaces these
 * as `Snapshot.danglingCancels`.
 *
 * The terminal resume writes depends on whether the cancelled
 * attempt also had a dangling `effectAttempted` (Step 9 round 1
 * finding 1):
 *
 *   - **No effectAttempted** (plain cancel): resume writes
 *     `activityCanceled` directly, with `cancelOriginEventId`
 *     pointing at the originating `cancelRequested`.
 *   - **effectAttempted present** (cancel + effect): resume FIRST
 *     runs reconcile to capture provider evidence (writes
 *     `reconcileResult` with cancel-coupled keys — see
 *     payloads.ts `ReconcileResultPayload` doc), THEN decides:
 *       - `completedByIdempotentSubmit` / `freshRetry` →
 *         `activityCanceled` (cancel wins as terminal reason; the
 *         provider's outcome is preserved in reconcileResult evidence)
 *       - `manual` (TTL expired / unknown provider / submit errored
 *         fatally) → `activityFailed{manual}` — we deliberately do
 *         NOT write `activityCanceled` because provider state is
 *         unknown and pretending the cancel cleanly succeeded would
 *         lie to forensics
 *       - `transient` → NO terminal; the activity stays dangling and
 *         the next resume cycle retries (surfaces as a
 *         `TransientReconcileFailure` on `ResumeResult.transientFailures`)
 */
export type CancelRecoveryOutcome = {
  activityId: string;
  attemptId: string;
  cancelOriginEventId: string;
  /** True if cancelDelivered was already written; false means we
   *  short-circuited a never-delivered cancel.  Both still terminate
   *  the activity (cancel intent is authoritative). */
  delivered: boolean;
  /**
   * What terminal we ended up writing.  `cancelled` is the regular
   * cancel terminal; `failed` is the "manual escalation" path when
   * reconcile evidence is non-conclusive (Step 9 finding 1).
   */
  kind: 'cancelled' | 'failed';
  /** Present when reconcile ran alongside cancel — i.e. the activity
   *  had a dangling effectAttempted.  Pure cancels (no effect) leave
   *  this undefined. */
  reconcileEvent?: ReconcileResultEvent;
  /**
   * The reconcile decision that informed the cancel terminal (only
   * populated when the activity had a dangling effectAttempted).
   * - For `completedByIdempotentSubmit` and `freshRetry`, terminal is
   *   `activityCanceled`.
   * - For `manual`, terminal is `activityFailed{manual}`.
   */
  reconcileDecision?: ReconcileDecision;
  terminalEvent: ActivityCanceledEvent | ActivityFailedEvent;
};

/**
 * Reconcile failures that resume DELIBERATELY does not terminate (codex
 * F3): a retryable provider failure during idempotentSubmit might mean
 * "request landed, response lost", and writing a manual terminal there
 * would freeze the activity in a wrong terminal state.  Resume reports
 * these back to the caller and leaves the activity dangling so the next
 * resume cycle can retry.
 */
export type TransientReconcileFailure = {
  activityId: string;
  attemptId: string;
  provider: string;
  idempotencyKey: string;
  errorCode: string;
  errorClass: 'retryable';
  errorMessage: string;
};

export type ResumeResult = {
  resumeStartedEvent: ResumeStartedEvent;
  /** Snapshot captured after `resumeStarted` is appended.  Returned for
   *  observability — caller can inspect dangling sets it consumed. */
  snapshot: Snapshot;
  reconcileOutcomes: ReconcileOutcome[];
  workerCrashedOutcomes: WorkerCrashedOutcome[];
  transientFailures: TransientReconcileFailure[];
  waitRecoveryOutcomes: WaitRecoveryOutcome[];
  cancelRecoveryOutcomes: CancelRecoveryOutcome[];
};

// ─── Resume orchestrator ────────────────────────────────────────────────────

export async function resume(ctx: ResumeContext): Promise<ResumeResult> {
  if (ctx.runId !== ctx.log.runId) {
    throw new Error(
      `resume: ctx.runId (${ctx.runId}) does not match log.runId (${ctx.log.runId})`,
    );
  }
  const now = ctx.now ?? Date.now;

  // F4: Preflight BEFORE writing resumeStarted.  Bad logs (empty / no
  // runCreated / cross-runId contamination) throw without polluting the
  // run event log — audit goes to the daemon logger, not the canonical
  // per-run event stream.
  const preEvents = await ctx.log.readAll();
  if (preEvents.length === 0) {
    throw new Error(
      `resume(${ctx.runId}): cannot resume an empty event log — no runCreated to project from.`,
    );
  }
  if (preEvents[0].type !== 'runCreated') {
    throw new Error(
      `resume(${ctx.runId}): first event must be runCreated, got ${preEvents[0].type} (corrupt log; not appending resumeStarted).`,
    );
  }
  // We let `replay` enforce cross-runId, but check up front so the
  // diagnostic is colocated with the preflight.
  if (preEvents[0].runId !== ctx.runId) {
    throw new Error(
      `resume(${ctx.runId}): runCreated.runId is ${preEvents[0].runId}, log/ctx are ${ctx.runId} (corrupt log; not appending resumeStarted).`,
    );
  }

  // Preflight passed — now write the audit entry.
  const resumeStartedEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'resumeStarted',
    actor: 'system',
    payload: {
      daemonId: ctx.daemonId,
      lastSeenEventId: preEvents[preEvents.length - 1].eventId,
    },
  })) as ResumeStartedEvent;

  // Re-read so the snapshot includes the resumeStarted (replay treats
  // it as a no-op projection — keeping the read consistent).
  const allEvents = await ctx.log.readAll();
  const snapshot = replay(allEvents);

  // Step 9: cancel recovery — cancelRequested landed but no terminal.
  // Spec §2.5: cancel is the authoritative terminal REASON, but when
  // the cancelled attempt also has a dangling `effectAttempted` we
  // must FIRST run reconcile to capture provider evidence (codex Step 9
  // round 1 finding 1).  Skipping reconcile would write activityCanceled
  // without ever observing whether the provider actually performed the
  // side effect — which is the difference between "we cancelled a no-op"
  // and "we cancelled a successful submit", and recovery can't replay
  // that distinction later.  We still write `activityCanceled` for the
  // common cases (completedByIdempotentSubmit / freshRetry) so cancel
  // remains the terminal reason; only `manual` reconcile decisions
  // escalate to `activityFailed{manual}` because the provider state is
  // unknown and pretending otherwise would lie about the cancel outcome.
  //
  // Cancel runs first so the subsequent loops can skip its activities.
  const cancelRecoveryOutcomes: CancelRecoveryOutcome[] = [];
  const transientFailures: TransientReconcileFailure[] = [];
  const effectAttemptedSet = new Set(snapshot.danglingEffectAttempted);
  for (const activityId of snapshot.danglingCancels) {
    if (effectAttemptedSet.has(activityId)) {
      const result = await recoverCancelWithReconcile(ctx, snapshot, activityId, now());
      if (result.kind === 'outcome') cancelRecoveryOutcomes.push(result.outcome);
      else if (result.kind === 'transient') transientFailures.push(result.failure);
      // 'skipped' = missing activity; ignore.
    } else {
      const cancellation = await recoverCancel(ctx, snapshot, activityId);
      if (cancellation) cancelRecoveryOutcomes.push(cancellation);
    }
  }
  // Activities the cancel branch ALREADY terminated (succeeded or escalated
  // to failed) — distinct from activities the cancel branch left dangling
  // because reconcile reported transient.
  const cancelTerminated = new Set(cancelRecoveryOutcomes.map((o) => o.activityId));

  const reconcileOutcomes: ReconcileOutcome[] = [];
  for (const activityId of snapshot.danglingEffectAttempted) {
    if (cancelTerminated.has(activityId)) continue; // already handled by cancel branch
    // Skip activities that the cancel branch tried but got transient on:
    // we already recorded the transient failure there; running another
    // reconcileOne for the same idempotencyKey would double-write.
    if (snapshot.danglingCancels.includes(activityId)) {
      continue;
    }
    const result = await reconcileOne(ctx, snapshot, activityId, now());
    if (result.kind === 'outcome') reconcileOutcomes.push(result.outcome);
    else if (result.kind === 'transient') transientFailures.push(result.failure);
  }
  const cancelled = new Set(snapshot.danglingCancels);

  // Step 8: wait recovery — `waitResolved` / `waitDeadlineExceeded`
  // landed but the activity terminal didn't.  Materialize the terminal
  // from the recorded resolution so the next replay sees a clean
  // terminal state.
  const waitRecoveryOutcomes: WaitRecoveryOutcome[] = [];
  for (const activityId of snapshot.danglingWaitResolutions) {
    if (cancelled.has(activityId)) continue;
    const recovery = await recoverWaitResolution(ctx, snapshot, activityId);
    if (recovery) waitRecoveryOutcomes.push(recovery);
  }

  // Worker-crashed path: dangling activity, no effectAttempted, no
  // open wait, no recoverable wait resolution → activityFailed{WorkerCrashed, retryable}.
  const workerCrashedOutcomes: WorkerCrashedOutcome[] = [];
  const reconciled = new Set(snapshot.danglingEffectAttempted);
  const waitingActivities = new Set(snapshot.danglingWaits);
  const waitRecovered = new Set(snapshot.danglingWaitResolutions);
  for (const activityId of snapshot.danglingActivities) {
    if (cancelled.has(activityId)) continue;
    if (reconciled.has(activityId)) continue;
    if (waitingActivities.has(activityId)) continue;
    if (waitRecovered.has(activityId)) continue;
    const activity = snapshot.activities.get(activityId);
    if (!activity) continue;
    const latest = activity.attempts[activity.attempts.length - 1];
    if (!latest) continue;
    const terminalEvent = (await ctx.log.append({
      runId: ctx.runId,
      type: 'activityFailed',
      actor: 'system',
      payload: {
        activityId,
        attemptId: latest.attemptId,
        error: {
          errorCode: 'WorkerCrashed',
          errorClass: 'retryable',
          errorMessage: 'Worker process exited before the activity reached a terminal state.',
        },
      },
    })) as ActivityFailedEvent;
    workerCrashedOutcomes.push({ activityId, attemptId: latest.attemptId, terminalEvent });
  }

  return {
    resumeStartedEvent,
    snapshot,
    reconcileOutcomes,
    workerCrashedOutcomes,
    transientFailures,
    waitRecoveryOutcomes,
    cancelRecoveryOutcomes,
  };
}

// ─── Cancel recovery (Step 9) ──────────────────────────────────────────────

/**
 * Plain cancel recovery for activities WITHOUT a dangling effectAttempted.
 * Writes `activityCanceled` directly — no provider state to reconcile.
 */
async function recoverCancel(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
): Promise<CancelRecoveryOutcome | null> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return null;
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.cancelRequest) return null;
  const cr = latest.cancelRequest;
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityCanceled',
    actor: 'system',
    payload: {
      activityId,
      attemptId: latest.attemptId,
      cancelOriginEventId: cr.cancelOriginEventId,
    },
  })) as ActivityCanceledEvent;
  return {
    activityId,
    attemptId: latest.attemptId,
    cancelOriginEventId: cr.cancelOriginEventId,
    delivered: cr.delivered,
    kind: 'cancelled',
    terminalEvent,
  };
}

/**
 * Cancel recovery for activities WITH a dangling effectAttempted.
 * Step 9 codex round 1 finding 1: reconcile evidence FIRST (captures
 * provider state into a `reconcileResult`), then write the cancel
 * terminal based on the decision:
 *   - completedByIdempotentSubmit / freshRetry → activityCanceled
 *     (cancel wins; provider state preserved in evidence)
 *   - manual → activityFailed{manual} (state unknown, don't fabricate
 *     a cancel terminal we can't substantiate)
 *   - transient → no terminal; surface to caller and leave dangling
 *     so the next resume can retry the reconcile
 */
type CancelReconcileStepResult =
  | { kind: 'outcome'; outcome: CancelRecoveryOutcome }
  | { kind: 'transient'; failure: TransientReconcileFailure }
  | { kind: 'skipped' };

async function recoverCancelWithReconcile(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
  nowMs: number,
): Promise<CancelReconcileStepResult> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return { kind: 'skipped' };
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.cancelRequest || !latest.effectAttempted) return { kind: 'skipped' };
  const cr = latest.cancelRequest;

  const evidence = await captureEvidence(ctx, snapshot, activityId, nowMs, {
    cancelContext: {
      cancelOriginEventId: cr.cancelOriginEventId,
      reason: cr.reason,
      requestedBy: cr.requestedBy,
    },
  });
  if (evidence.kind === 'skipped') return { kind: 'skipped' };
  if (evidence.kind === 'transient') {
    return { kind: 'transient', failure: evidence.failure };
  }

  const ea = latest.effectAttempted;
  // Decision → terminal mapping for cancel branch.
  if (evidence.kind === 'manual') {
    // Provider state unknown — escalate to activityFailed{manual}.  We
    // intentionally do NOT write activityCanceled here: it would
    // misrepresent the cancel as a clean abort even though we can't
    // verify whether the provider performed the side effect.  The
    // cancelOriginEventId is preserved in the reconcile evidence for
    // forensics.
    const terminalEvent = (await ctx.log.append({
      runId: ctx.runId,
      type: 'activityFailed',
      actor: 'system',
      payload: {
        activityId,
        attemptId: latest.attemptId,
        error: {
          errorCode: evidence.errorCode,
          errorClass: 'manual',
          errorMessage: `Cancel + reconcile: ${evidence.errorMessage} (cancelOriginEventId=${cr.cancelOriginEventId})`,
        },
      },
    })) as ActivityFailedEvent;
    return {
      kind: 'outcome',
      outcome: {
        activityId,
        attemptId: latest.attemptId,
        cancelOriginEventId: cr.cancelOriginEventId,
        delivered: cr.delivered,
        kind: 'failed',
        reconcileEvent: evidence.reconcileEvent ?? undefined,
        reconcileDecision: 'manual',
        terminalEvent,
      },
    };
  }

  // completedByIdempotentSubmit OR freshRetry: cancel wins as terminal
  // reason.  Evidence is preserved in the reconcileResult written by
  // captureEvidence (or referenced via the prior reconcileResult eventId
  // when recovered=true).
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityCanceled',
    actor: 'system',
    payload: {
      activityId,
      attemptId: latest.attemptId,
      cancelOriginEventId: cr.cancelOriginEventId,
    },
  })) as ActivityCanceledEvent;
  void ea;
  return {
    kind: 'outcome',
    outcome: {
      activityId,
      attemptId: latest.attemptId,
      cancelOriginEventId: cr.cancelOriginEventId,
      delivered: cr.delivered,
      kind: 'cancelled',
      reconcileEvent: evidence.reconcileEvent ?? undefined,
      reconcileDecision: evidence.kind,
      terminalEvent,
    },
  };
}

// ─── Wait recovery (Step 8) ────────────────────────────────────────────────

async function recoverWaitResolution(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
): Promise<WaitRecoveryOutcome | null> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return null;
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.wait?.resolution) return null;
  const r = latest.wait.resolution;

  if (r.kind === 'resolved') {
    // approved | external → activitySucceeded.
    // rejected           → activityFailed { InputValidationFailed, userFault }.
    if (r.resolution === 'rejected') {
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activityFailed',
        actor: 'system',
        payload: {
          activityId,
          attemptId: latest.attemptId,
          error: {
            errorCode: 'InputValidationFailed',
            errorClass: 'userFault',
            errorMessage: `Recovered wait terminal: rejected by ${r.by}${
              r.comment ? `: ${r.comment}` : ''
            }`,
          },
        },
      })) as ActivityFailedEvent;
      return {
        activityId,
        attemptId: latest.attemptId,
        kind: 'failed',
        source: 'resolved',
        terminalEvent,
      };
    }
    // approved | external
    const externalRefs: Record<string, unknown> = {
      resolution: r.resolution,
      by: r.by,
      ...(r.comment ? { comment: r.comment } : {}),
    };
    const terminalEvent = await writeRecoverySucceeded(
      ctx,
      activityId,
      latest.attemptId,
      externalRefs,
    );
    return {
      activityId,
      attemptId: latest.attemptId,
      kind: 'succeeded',
      source: 'resolved',
      terminalEvent,
    };
  }

  // deadlineExceeded
  const policy = latest.wait.onTimeout ?? 'fail';
  if (policy === 'success') {
    const externalRefs = { defaultedToTimeout: true, deadlineAt: r.deadlineAt };
    const terminalEvent = await writeRecoverySucceeded(
      ctx,
      activityId,
      latest.attemptId,
      externalRefs,
    );
    return {
      activityId,
      attemptId: latest.attemptId,
      kind: 'succeeded',
      source: 'deadlineExceeded',
      terminalEvent,
    };
  }
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityFailed',
    actor: 'system',
    payload: {
      activityId,
      attemptId: latest.attemptId,
      error: {
        errorCode: 'WaitDeadlineExceeded',
        errorClass: 'userFault',
        errorMessage: `Recovered wait terminal: deadline (${r.deadlineAt}) exceeded at ${r.exceededAtMs}`,
      },
    },
  })) as ActivityFailedEvent;
  return {
    activityId,
    attemptId: latest.attemptId,
    kind: 'failed',
    source: 'deadlineExceeded',
    terminalEvent,
  };
}

async function writeRecoverySucceeded(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  externalRefs: Record<string, unknown>,
): Promise<ActivitySucceededEvent> {
  const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
  const outputHash = await sha256Hex(outputBuf);
  return (await ctx.log.append({
    runId: ctx.runId,
    type: 'activitySucceeded',
    actor: 'system',
    payload: {
      activityId,
      attemptId,
      outputRef: {
        outputHash: `sha256:${outputHash}`,
        outputBytes: outputBuf.length,
        outputSchemaVersion: 1,
        contentType: 'application/json',
      },
      externalRefs,
    },
  })) as ActivitySucceededEvent;
}

// ─── Reconcile decision tree ────────────────────────────────────────────────

type ReconcileStepResult =
  | { kind: 'outcome'; outcome: ReconcileOutcome }
  | { kind: 'transient'; failure: TransientReconcileFailure }
  | { kind: 'skipped' };

/**
 * Result of capturing reconcile evidence.  Carries enough metadata for
 * either the regular path (`reconcileOne`) or the cancel path
 * (`recoverCancelWithReconcile`) to write an appropriate terminal.
 *
 * Invariant: `reconcileResult` is either freshly written (recovered=false,
 * reconcileEvent populated) or reused from a prior crashed cycle
 * (recovered=true, reconcileEvent=null — see F1).  Either way, the
 * reconcile state has been audited; only the activity terminal remains
 * for the caller to write.
 */
type EvidenceResult =
  | {
      kind: 'completedByIdempotentSubmit';
      capability: ReconcileCapability;
      externalRefs: Record<string, unknown>;
      evidence: Record<string, unknown>;
      reconcileEvent: ReconcileResultEvent | null;
      recovered: boolean;
    }
  | {
      kind: 'freshRetry';
      capability: ReconcileCapability;
      evidence: Record<string, unknown>;
      reconcileEvent: ReconcileResultEvent | null;
      recovered: boolean;
    }
  | {
      kind: 'manual';
      capability: ReconcileCapability;
      errorCode: string;
      errorMessage: string;
      evidence: Record<string, unknown>;
      reconcileEvent: ReconcileResultEvent | null;
      recovered: boolean;
    }
  | {
      kind: 'transient';
      failure: TransientReconcileFailure;
    }
  | {
      kind: 'skipped';
    };

/** Convenience for code that only cares about reconcile decision identity. */
type EvidenceDecision = Exclude<EvidenceResult['kind'], 'transient' | 'skipped'>;

async function reconcileOne(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
  nowMs: number,
): Promise<ReconcileStepResult> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return { kind: 'skipped' };
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.effectAttempted) return { kind: 'skipped' };

  const ea = latest.effectAttempted;
  const evidence = await captureEvidence(ctx, snapshot, activityId, nowMs);
  if (evidence.kind === 'skipped') return { kind: 'skipped' };
  if (evidence.kind === 'transient') return { kind: 'transient', failure: evidence.failure };

  return { kind: 'outcome', outcome: await writeRegularTerminal(ctx, latest.attemptId, activityId, ea, evidence) };
}

/**
 * Optional extras that the caller wants merged into every freshly
 * written `reconcileResult.evidence` (does NOT apply to F1 recovery —
 * the prior reconcileResult is immutable).  Currently used by the
 * cancel branch to embed `cancelOriginEventId` / `cancelReason` /
 * `cancelRequestedBy` so dashboards / forensics can correlate
 * cancel × reconcile structurally rather than via errorMessage parsing
 * (codex Step 9 round 2 finding 1).
 */
type EvidenceCaptureOptions = {
  cancelContext?: {
    cancelOriginEventId: string;
    reason: string;
    requestedBy: string;
  };
};

/**
 * Capture reconcile evidence WITHOUT writing the activity terminal.
 * Writes `reconcileResult` (or reuses a prior one — F1 recovery) and
 * returns the decision + auxiliary data the caller needs to write the
 * appropriate terminal.
 *
 * Splitting evidence capture from terminal write lets the cancel path
 * (`recoverCancelWithReconcile`) reuse the decision tree without
 * accidentally fabricating activitySucceeded — codex Step 9 round 1
 * finding 1.
 */
async function captureEvidence(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
  nowMs: number,
  options?: EvidenceCaptureOptions,
): Promise<EvidenceResult> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return { kind: 'skipped' };
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest?.effectAttempted) return { kind: 'skipped' };

  const ea = latest.effectAttempted;
  const extra = controlExtra(options);

  // F1: recovery path — if a previous resume already wrote a
  // reconcileResult for this attempt but crashed before the terminal,
  // resume the consequences instead of re-running the decision tree.
  // Re-running risks a DIFFERENT decision (TTL crosses, provider state
  // changes), so we honor the recorded choice.
  if (latest.latestReconcileResult) {
    return evidenceFromPriorReconcileResult(latest, ea);
  }

  const reconciler = ctx.reconcilers.get(ea.provider);

  // Case A — unknown provider.  No way to confirm; manual/UnknownProvider.
  if (!reconciler) {
    return await writeReconcileResultManual(
      ctx,
      activityId,
      ea,
      'none',
      'UnknownProviderError',
      `No reconciler registered for provider "${ea.provider}".`,
      { reason: 'no_reconciler', ...extra },
    );
  }

  // Case B — TTL boundary.  Use the recorded TTL from effectAttempted,
  // not the live reconciler's value: the provider's TTL may have changed
  // between the attempt and this resume, but the contract that was in
  // force at attempt time is what matters.
  const ttlExpired = nowMs - ea.attemptedAtMs > ea.idempotencyTtlMs;
  if (ttlExpired) {
    return await writeReconcileResultManual(
      ctx,
      activityId,
      ea,
      'none',
      'TtlExpired',
      `Provider TTL (${ea.idempotencyTtlMs}ms) elapsed before resume could reconcile.`,
      {
        reason: 'ttl_expired',
        attemptedAtMs: ea.attemptedAtMs,
        nowMs,
        idempotencyTtlMs: ea.idempotencyTtlMs,
        ...extra,
      },
    );
  }

  // F2: materialize effect input via the caller's loader.  Some
  // reconcilers can work without it (schedule); others (Feishu) MUST
  // have it.
  let effectInput: unknown = undefined;
  let inputLoadError: Error | null = null;
  if (ctx.loadEffectInput) {
    try {
      effectInput = await ctx.loadEffectInput(activityId, latest.attemptId);
    } catch (err) {
      inputLoadError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (
    reconciler.requiresEffectInput &&
    (inputLoadError !== null || effectInput === undefined)
  ) {
    return await writeReconcileResultManual(
      ctx,
      activityId,
      ea,
      'none',
      'InputUnrecoverable',
      inputLoadError
        ? `Failed to load effect input for reconcile: ${inputLoadError.message}`
        : `Reconciler "${ea.provider}" requires effect input, but ctx.loadEffectInput returned undefined / was not provided.`,
      { reason: 'input_unrecoverable', hadLoader: !!ctx.loadEffectInput, ...extra },
    );
  }

  // F2.5: inputHash guard.  When a sidecar was successfully loaded, the
  // body we're about to hand the reconciler MUST canonicalize to the
  // hash that was recorded on `effectAttempted`.  Sidecar tampering,
  // schema drift, or manual edits would otherwise silently produce a
  // re-submit with a different body — Feishu would dedupe by uuid and
  // return the original messageId, but our workflow audit trail would
  // record the tampered input as "successful".
  //
  // Only enforced when the reconciler declares `canonicalInput` so the
  // contract is opt-in per provider.  For `requiresEffectInput=true`
  // reconcilers without a `canonicalInput`, fail loud: this is a
  // config error (a Feishu-flavored reconciler that can't canonicalize
  // its own input).
  if (effectInput !== undefined) {
    if (reconciler.canonicalInput) {
      const recomputed = computeInputHash(reconciler.canonicalInput(effectInput));
      if (recomputed !== ea.inputHash) {
        return await writeReconcileResultManual(
          ctx,
          activityId,
          ea,
          'none',
          'IdempotencyInputMismatch',
          `Reconciler "${ea.provider}" loaded effect input whose canonical hash (${recomputed}) does not match the recorded effectAttempted.inputHash (${ea.inputHash}). Sidecar tampered or schema drifted; not calling provider.`,
          {
            reason: 'inputhash_mismatch',
            recordedHash: ea.inputHash,
            recomputedHash: recomputed,
            source: 'hashGuard',
            ...extra,
          },
        );
      }
    } else if (reconciler.requiresEffectInput) {
      return await writeReconcileResultManual(
        ctx,
        activityId,
        ea,
        'none',
        'IdempotencyInputMismatch',
        `Reconciler "${ea.provider}" declares requiresEffectInput=true but exposes no canonicalInput — cannot verify the loaded sidecar matches effectAttempted.inputHash. Not calling provider.`,
        { reason: 'no_canonicalInput', source: 'hashGuard', ...extra },
      );
    }
  }

  // Case C — readOnlyLookup available.  Prefer it: pure read, no side
  // effect risk.  Schedule has it.
  if (reconciler.readOnlyLookup) {
    const lookup = await reconciler.readOnlyLookup(ea.idempotencyKey, effectInput);
    if (lookup.found) {
      return await writeReconcileResultCompleted(
        ctx,
        activityId,
        ea,
        'readOnlyLookup',
        lookup.externalRefs,
        { ...(lookup.evidence ?? {}), ...extra },
      );
    }
    return await writeReconcileResultFreshRetry(
      ctx,
      activityId,
      ea,
      'readOnlyLookup',
      { ...(lookup.evidence ?? { found: false }), ...extra },
    );
  }

  // Case D — idempotentSubmit only (Feishu).
  if (reconciler.idempotentSubmit) {
    const submit = await reconciler.idempotentSubmit(ea.idempotencyKey, effectInput);
    if (submit.ok) {
      return await writeReconcileResultCompleted(
        ctx,
        activityId,
        ea,
        'idempotentSubmit',
        submit.externalRefs,
        { ...(submit.evidence ?? {}), ...extra },
      );
    }
    // F3: retryable failures stay dangling — no reconcileResult is
    // written here because the provider's state is in flux.  The next
    // resume cycle re-enters the decision tree from scratch.
    if (submit.errorClass === 'retryable') {
      return {
        kind: 'transient',
        failure: {
          activityId,
          attemptId: latest.attemptId,
          provider: ea.provider,
          idempotencyKey: ea.idempotencyKey,
          errorCode: submit.errorCode,
          errorClass: 'retryable',
          errorMessage: submit.errorMessage,
        },
      };
    }
    return await writeReconcileResultManual(
      ctx,
      activityId,
      ea,
      'idempotentSubmit',
      submit.errorCode,
      submit.errorMessage,
      { ...(submit.evidence ?? { errorClass: submit.errorClass }), ...extra },
    );
  }

  // Case E — reconciler exists but exposes no capability.  Manual.
  return await writeReconcileResultManual(
    ctx,
    activityId,
    ea,
    'none',
    'UnknownProviderError',
    `Reconciler for "${ea.provider}" exposes neither readOnlyLookup nor idempotentSubmit.`,
    { reason: 'no_capability', ...extra },
  );
}

function controlExtra(options?: EvidenceCaptureOptions): Record<string, unknown> {
  if (!options?.cancelContext) return {};
  const { cancelOriginEventId, reason, requestedBy } = options.cancelContext;
  return {
    cancelOriginEventId,
    cancelReason: reason,
    cancelRequestedBy: requestedBy,
  };
}

/**
 * Write the regular (non-cancel) activity terminal that corresponds to
 * an EvidenceResult.  Returns a ReconcileOutcome for the orchestrator.
 *
 * Caller must filter out `transient` and `skipped` before invoking.
 */
async function writeRegularTerminal(
  ctx: ResumeContext,
  attemptId: string,
  activityId: string,
  ea: NonNullable<AttemptState['effectAttempted']>,
  evidence: Extract<EvidenceResult, { kind: EvidenceDecision }>,
): Promise<ReconcileOutcome> {
  switch (evidence.kind) {
    case 'completedByIdempotentSubmit': {
      const outputBuf = Buffer.from(JSON.stringify(evidence.externalRefs), 'utf-8');
      const outputHash = await sha256Hex(outputBuf);
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activitySucceeded',
        actor: 'system',
        payload: {
          activityId,
          attemptId,
          outputRef: {
            outputHash: `sha256:${outputHash}`,
            outputBytes: outputBuf.length,
            outputSchemaVersion: 1,
            contentType: 'application/json',
          },
          externalRefs: evidence.externalRefs,
        },
      })) as ActivitySucceededEvent;
      return {
        activityId,
        attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: evidence.capability,
        decision: 'completedByIdempotentSubmit',
        evidence: evidence.evidence,
        terminalEvent,
        reconcileEvent: evidence.reconcileEvent,
        recovered: evidence.recovered,
      };
    }
    case 'freshRetry': {
      return {
        activityId,
        attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: evidence.capability,
        decision: 'freshRetry',
        evidence: evidence.evidence,
        terminalEvent: null,
        reconcileEvent: evidence.reconcileEvent,
        recovered: evidence.recovered,
      };
    }
    case 'manual': {
      const terminalEvent = (await ctx.log.append({
        runId: ctx.runId,
        type: 'activityFailed',
        actor: 'system',
        payload: {
          activityId,
          attemptId,
          error: {
            errorCode: evidence.errorCode,
            errorClass: 'manual',
            errorMessage: evidence.errorMessage,
          },
        },
      })) as ActivityFailedEvent;
      return {
        activityId,
        attemptId,
        idempotencyKey: ea.idempotencyKey,
        provider: ea.provider,
        capability: evidence.capability,
        decision: 'manual',
        evidence: evidence.evidence,
        terminalEvent,
        reconcileEvent: evidence.reconcileEvent,
        recovered: evidence.recovered,
      };
    }
  }
}

// ─── F1 recovery: a prior reconcileResult exists, terminal does not ─────────

/**
 * Re-shape a prior crashed reconcile cycle's reconcileResult into an
 * EvidenceResult so the caller's terminal-write path matches what would
 * have happened originally.
 *
 * Codex Step 7 round 2: corrupt prior decisions (replayed without
 * terminal, or completedByIdempotentSubmit with missing externalRefs)
 * escalate to `manual` with diagnostic evidence rather than fabricate
 * a fake activitySucceeded.
 */
function evidenceFromPriorReconcileResult(
  latest: AttemptState,
  _ea: NonNullable<AttemptState['effectAttempted']>,
): EvidenceResult {
  void _ea;
  const rr = latest.latestReconcileResult!;
  switch (rr.decision) {
    case 'completedByIdempotentSubmit': {
      const candidate = (rr.evidence as { externalRefs?: unknown }).externalRefs;
      if (
        candidate === undefined ||
        candidate === null ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        return {
          kind: 'manual',
          capability: rr.capability,
          errorCode: 'CorruptLog',
          errorMessage:
            'Prior reconcileResult{decision=completedByIdempotentSubmit} is missing evidence.externalRefs (or it is not an object) — refusing to fabricate an activitySucceeded from empty refs.',
          evidence: {
            ...rr.evidence,
            corruptReason: 'missing_external_refs',
            originalDecision: 'completedByIdempotentSubmit',
            reconcileEventId: rr.eventId,
          },
          reconcileEvent: null,
          recovered: true,
        };
      }
      return {
        kind: 'completedByIdempotentSubmit',
        capability: rr.capability,
        externalRefs: candidate as Record<string, unknown>,
        evidence: rr.evidence,
        reconcileEvent: null,
        recovered: true,
      };
    }
    case 'manual': {
      const errorCode =
        (rr.evidence as { errorCode?: string }).errorCode ?? 'UnknownProviderError';
      return {
        kind: 'manual',
        capability: rr.capability,
        errorCode,
        errorMessage: `Recovered from prior crashed reconcile cycle (decision=manual, errorCode=${errorCode}).`,
        evidence: rr.evidence,
        reconcileEvent: null,
        recovered: true,
      };
    }
    case 'freshRetry': {
      return {
        kind: 'freshRetry',
        capability: rr.capability,
        evidence: rr.evidence,
        reconcileEvent: null,
        recovered: true,
      };
    }
    case 'replayed': {
      // Replayed means a terminal already existed when reconcileResult
      // was written.  If we landed here, that terminal got lost — log
      // corruption.  Surface as manual to flag the inconsistency.
      return {
        kind: 'manual',
        capability: rr.capability,
        errorCode: 'CorruptLog',
        errorMessage:
          'Prior reconcileResult decision=replayed but no terminal event present — log inconsistency.',
        evidence: {
          ...rr.evidence,
          originalDecision: 'replayed',
          reconcileEventId: rr.eventId,
        },
        reconcileEvent: null,
        recovered: true,
      };
    }
  }
}

// ─── reconcileResult writers (decision-shaped EvidenceResult builders) ──────

async function writeReconcileResultCompleted(
  ctx: ResumeContext,
  activityId: string,
  ea: NonNullable<AttemptState['effectAttempted']>,
  capability: ReconcileCapability,
  externalRefs: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Promise<EvidenceResult> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey: ea.idempotencyKey,
      capability,
      decision: 'completedByIdempotentSubmit',
      evidence: { ...evidence, externalRefs },
    },
  })) as ReconcileResultEvent;
  return {
    kind: 'completedByIdempotentSubmit',
    capability,
    externalRefs,
    evidence,
    reconcileEvent,
    recovered: false,
  };
}

async function writeReconcileResultFreshRetry(
  ctx: ResumeContext,
  activityId: string,
  ea: NonNullable<AttemptState['effectAttempted']>,
  capability: ReconcileCapability,
  evidence: Record<string, unknown>,
): Promise<EvidenceResult> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey: ea.idempotencyKey,
      capability,
      decision: 'freshRetry',
      evidence,
    },
  })) as ReconcileResultEvent;
  return {
    kind: 'freshRetry',
    capability,
    evidence,
    reconcileEvent,
    recovered: false,
  };
}

async function writeReconcileResultManual(
  ctx: ResumeContext,
  activityId: string,
  ea: NonNullable<AttemptState['effectAttempted']>,
  capability: ReconcileCapability,
  errorCode: string,
  errorMessage: string,
  evidence: Record<string, unknown>,
): Promise<EvidenceResult> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey: ea.idempotencyKey,
      capability,
      decision: 'manual',
      evidence: { ...evidence, errorCode },
    },
  })) as ReconcileResultEvent;
  return {
    kind: 'manual',
    capability,
    errorCode,
    errorMessage,
    evidence,
    reconcileEvent,
    recovered: false,
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}

// Re-export AttemptState so test fixtures don't need a separate import path.
export type { AttemptState };
