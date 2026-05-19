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
 */

import type { EventLog } from './events/append.js';
import { replay, type Snapshot, type AttemptState } from './events/replay.js';
import type {
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
 */
export interface ProviderReconciler {
  readonly provider: string;
  /**
   * Pure read against the provider keyed by `idempotencyKey`.  Has no
   * side effects; safe to call from resume even when we don't intend to
   * complete the effect.  Schedule has it (`getTask(id)`); Feishu does
   * not (no uuid-reverse-lookup API).
   */
  readOnlyLookup?(idempotencyKey: string): Promise<ReadOnlyLookupResult>;
  /**
   * Re-submit the effect with the same `idempotencyKey`.  MAY produce
   * the side effect for real (if the original pre-invoke crash never
   * reached the provider); provider dedupe inside TTL guarantees the
   * second submit returns the original ref instead of a duplicate.
   */
  idempotentSubmit?(idempotencyKey: string): Promise<IdempotentSubmitResult>;
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
  /** The reconcileResult event written. */
  reconcileEvent: ReconcileResultEvent;
};

export type WorkerCrashedOutcome = {
  activityId: string;
  attemptId: string;
  terminalEvent: ActivityFailedEvent;
};

export type ResumeResult = {
  resumeStartedEvent: ResumeStartedEvent;
  /** Snapshot captured after `resumeStarted` is appended.  Returned for
   *  observability — caller can inspect dangling sets it consumed. */
  snapshot: Snapshot;
  reconcileOutcomes: ReconcileOutcome[];
  workerCrashedOutcomes: WorkerCrashedOutcome[];
};

// ─── Resume orchestrator ────────────────────────────────────────────────────

export async function resume(ctx: ResumeContext): Promise<ResumeResult> {
  if (ctx.runId !== ctx.log.runId) {
    throw new Error(
      `resume: ctx.runId (${ctx.runId}) does not match log.runId (${ctx.log.runId})`,
    );
  }
  const now = ctx.now ?? Date.now;

  // 1. Write resumeStarted audit entry BEFORE replay — the audit entry
  //    itself is a recoverable signal that a resume cycle began on this
  //    daemon, even if the cycle itself crashes mid-way.
  const preEvents = await ctx.log.readAll();
  // The payload schema requires a string; use the empty string as the
  // sentinel for "we resumed against an empty log" rather than allowing
  // null at the envelope.  In practice resume should only run after
  // `runCreated`, but the sentinel keeps the function total.
  const lastSeenEventId = preEvents.length > 0 ? preEvents[preEvents.length - 1].eventId : '';
  const resumeStartedEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'resumeStarted',
    actor: 'system',
    payload: {
      daemonId: ctx.daemonId,
      lastSeenEventId,
    },
  })) as ResumeStartedEvent;

  // 2. Replay (including resumeStarted itself — it doesn't affect snapshot
  //    projection but keeps the read consistent).
  const allEvents = await ctx.log.readAll();
  const snapshot = replay(allEvents);

  // 3. Reconcile dangling effectAttempted activities.
  const reconcileOutcomes: ReconcileOutcome[] = [];
  for (const activityId of snapshot.danglingEffectAttempted) {
    const outcome = await reconcileOne(ctx, snapshot, activityId, now());
    if (outcome) reconcileOutcomes.push(outcome);
  }

  // 4. Worker-crashed path: dangling activity, no effectAttempted, no
  //    open wait.  Treat as worker died mid-execution → activityFailed
  //    with retryable/WorkerCrashed.  Human-gate (waitCreated dangling)
  //    is intentionally left alone — it's waiting on external signal.
  const workerCrashedOutcomes: WorkerCrashedOutcome[] = [];
  const reconciled = new Set(snapshot.danglingEffectAttempted);
  const waitingActivities = new Set(snapshot.danglingWaits);
  for (const activityId of snapshot.danglingActivities) {
    if (reconciled.has(activityId)) continue;
    if (waitingActivities.has(activityId)) continue;
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
  };
}

// ─── Reconcile decision tree ────────────────────────────────────────────────

async function reconcileOne(
  ctx: ResumeContext,
  snapshot: Snapshot,
  activityId: string,
  nowMs: number,
): Promise<ReconcileOutcome | null> {
  const activity = snapshot.activities.get(activityId);
  if (!activity) return null;
  const latest = activity.attempts[activity.attempts.length - 1];
  if (!latest || !latest.effectAttempted) return null;

  const ea = latest.effectAttempted;
  const reconciler = ctx.reconcilers.get(ea.provider);

  // Case A — unknown provider.  No way to confirm; manual/UnknownProvider.
  if (!reconciler) {
    return writeManual(
      ctx,
      activityId,
      latest.attemptId,
      ea.idempotencyKey,
      ea.provider,
      'none',
      'UnknownProviderError',
      `No reconciler registered for provider "${ea.provider}".`,
      { reason: 'no_reconciler' },
    );
  }

  // Case B — TTL boundary.  Use the recorded TTL from effectAttempted,
  // not the live reconciler's value: the provider's TTL may have changed
  // between the attempt and this resume, but the contract that was in
  // force at attempt time is what matters.
  const ttlExpired = nowMs - ea.attemptedAtMs > ea.idempotencyTtlMs;
  if (ttlExpired) {
    return writeManual(
      ctx,
      activityId,
      latest.attemptId,
      ea.idempotencyKey,
      ea.provider,
      'none',
      'TtlExpired',
      `Provider TTL (${ea.idempotencyTtlMs}ms) elapsed before resume could reconcile.`,
      {
        reason: 'ttl_expired',
        attemptedAtMs: ea.attemptedAtMs,
        nowMs,
        idempotencyTtlMs: ea.idempotencyTtlMs,
      },
    );
  }

  // Case C — readOnlyLookup available.  Prefer it: pure read, no side
  // effect risk.  Schedule has it.
  if (reconciler.readOnlyLookup) {
    const lookup = await reconciler.readOnlyLookup(ea.idempotencyKey);
    if (lookup.found) {
      return writeCompletedByIdempotentSubmit(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'readOnlyLookup',
        lookup.externalRefs,
        lookup.evidence ?? {},
      );
    }
    // Not found → freshRetry.  We DO NOT write a terminal event; the
    // scheduler will issue a new attempt with the same attemptId /
    // idempotencyKey.  Resume's job ends with the reconcileResult.
    return writeFreshRetry(
      ctx,
      activityId,
      latest.attemptId,
      ea.idempotencyKey,
      ea.provider,
      'readOnlyLookup',
      lookup.evidence ?? { found: false },
    );
  }

  // Case D — idempotentSubmit only (Feishu).  Re-submitting inside TTL
  // is safe: provider dedupe returns the original ref if a previous
  // submit landed, or completes the effect for the first time if the
  // pre-invoke crash predated the provider receiving anything.
  if (reconciler.idempotentSubmit) {
    const submit = await reconciler.idempotentSubmit(ea.idempotencyKey);
    if (submit.ok) {
      return writeCompletedByIdempotentSubmit(
        ctx,
        activityId,
        latest.attemptId,
        ea.idempotencyKey,
        ea.provider,
        'idempotentSubmit',
        submit.externalRefs,
        submit.evidence ?? {},
      );
    }
    // Re-submit failed.  If retryable we still go manual here — Step 7
    // doesn't make retry decisions, and a manual reconcileResult lets a
    // human inspect before retry policy reactivates.
    return writeManual(
      ctx,
      activityId,
      latest.attemptId,
      ea.idempotencyKey,
      ea.provider,
      'idempotentSubmit',
      submit.errorCode,
      submit.errorMessage,
      submit.evidence ?? { errorClass: submit.errorClass },
    );
  }

  // Case E — reconciler exists but exposes no capability.  Manual.
  return writeManual(
    ctx,
    activityId,
    latest.attemptId,
    ea.idempotencyKey,
    ea.provider,
    'none',
    'UnknownProviderError',
    `Reconciler for "${ea.provider}" exposes neither readOnlyLookup nor idempotentSubmit.`,
    { reason: 'no_capability' },
  );
}

// ─── Event writers (one per terminal decision) ──────────────────────────────

async function writeCompletedByIdempotentSubmit(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  externalRefs: Record<string, unknown>,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'completedByIdempotentSubmit',
      evidence: { ...evidence, externalRefs },
    },
  })) as ReconcileResultEvent;

  // Outcome is success — write activitySucceeded.  outputRef is a
  // content-addressed reference to the externalRefs blob (same shape as
  // executeSideEffect's success path).
  const outputBuf = Buffer.from(JSON.stringify(externalRefs), 'utf-8');
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
      externalRefs,
    },
  })) as ActivitySucceededEvent;

  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'completedByIdempotentSubmit',
    evidence,
    terminalEvent,
    reconcileEvent,
  };
}

async function writeFreshRetry(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'freshRetry',
      evidence,
    },
  })) as ReconcileResultEvent;
  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'freshRetry',
    evidence,
    terminalEvent: null,
    reconcileEvent,
  };
}

async function writeManual(
  ctx: ResumeContext,
  activityId: string,
  attemptId: string,
  idempotencyKey: string,
  provider: string,
  capability: ReconcileCapability,
  errorCode: string,
  errorMessage: string,
  evidence: Record<string, unknown>,
): Promise<ReconcileOutcome> {
  const reconcileEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'reconcileResult',
    actor: 'system',
    payload: {
      activityId,
      idempotencyKey,
      capability,
      decision: 'manual',
      evidence: { ...evidence, errorCode },
    },
  })) as ReconcileResultEvent;
  const terminalEvent = (await ctx.log.append({
    runId: ctx.runId,
    type: 'activityFailed',
    actor: 'system',
    payload: {
      activityId,
      attemptId,
      error: {
        errorCode,
        errorClass: 'manual',
        errorMessage,
      },
    },
  })) as ActivityFailedEvent;
  return {
    activityId,
    attemptId,
    idempotencyKey,
    provider,
    capability,
    decision: 'manual',
    evidence,
    terminalEvent,
    reconcileEvent,
  };
}

async function sha256Hex(buf: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest('hex');
}

// Re-export AttemptState so test fixtures don't need a separate import path.
export type { AttemptState };
