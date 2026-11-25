import type { SubmitRecheckResult } from '../adapters/cli/types.js';

export type SubmitActivityEvidence = 'pty-output' | 'structured-transcript' | 'botmux-send';

export interface SubmitEvidenceIdentity {
  turnId?: string;
  dispatchAttempt?: number;
}

export interface SubmitStructuredTurnEvidence extends SubmitEvidenceIdentity {
  /** Optional explicit full-content flag; when explicitly false, partial/prefix
   *  or uncorroborated starts are rejected as authoritative submit proof. */
  fullInputMatch?: boolean;
}

export interface SubmitSendMarkerEvidence extends SubmitEvidenceIdentity {
  sessionId?: string;
  sentAtMs?: number;
  terminalIndependent?: boolean;
}

export interface SubmitActivityEvidenceInput {
  target?: SubmitEvidenceIdentity;
  sessionId?: string;
  sinceMs?: number;
  retainedReceipt?: { evidence: 'structured-transcript' | 'botmux-send' };
  ptyActive: boolean;
  structuredTurns: readonly SubmitStructuredTurnEvidence[];
  sendMarkers: readonly SubmitSendMarkerEvidence[];
}

export function isAuthoritativeClaudeTranscriptTurn(turn: {
  started?: boolean;
  fullContentMatch?: boolean;
  exactContentMatch?: boolean;
  isLocal?: boolean;
  isScheduled?: boolean;
  restoredFromJournal?: boolean;
}): boolean {
  const matched = turn.exactContentMatch !== undefined
    ? turn.exactContentMatch === true
    : turn.fullContentMatch === true;
  return turn.started === true
    && matched
    && !turn.isLocal
    && !turn.isScheduled
    && !turn.restoredFromJournal;
}

export function isAuthoritativeStructuredTranscriptTurn(turn: {
  started?: boolean;
  provisionalTaskStartedAtMs?: number;
  exactUserInputMatch?: boolean;
  isLocal?: boolean;
  restoredFromJournal?: boolean;
}): boolean {
  return turn.started === true
    && turn.provisionalTaskStartedAtMs === undefined
    && turn.exactUserInputMatch === true
    && !turn.isLocal
    && !turn.restoredFromJournal;
}

export function isAuthoritativeSubmitSendMarker(
  marker: SubmitSendMarkerEvidence,
  target: SubmitEvidenceIdentity,
  opts?: { sessionId?: string; sinceMs?: number },
): boolean {
  if (!matchesExactEvidence(target, marker)) return false;
  if (marker.terminalIndependent === true) return false;
  if (opts?.sessionId !== undefined && marker.sessionId !== undefined
    && marker.sessionId !== opts.sessionId) {
    return false;
  }
  if (opts?.sinceMs !== undefined) {
    if (typeof marker.sentAtMs !== 'number' || !Number.isFinite(marker.sentAtMs)) return false;
    if (marker.sentAtMs < opts.sinceMs) return false;
  }
  return true;
}

function matchesExactEvidence(
  target: SubmitEvidenceIdentity,
  evidence: SubmitEvidenceIdentity,
): boolean {
  return target.turnId !== undefined
    && evidence.turnId === target.turnId
    && evidence.dispatchAttempt === target.dispatchAttempt;
}

export function selectSubmitActivityEvidence(
  input: SubmitActivityEvidenceInput,
): SubmitActivityEvidence | undefined {
  const target = input.target;
  if (target) {
    if (target.turnId !== undefined && input.retainedReceipt) {
      return input.retainedReceipt.evidence;
    }
    if (input.structuredTurns.some(turn => turn.fullInputMatch !== false && matchesExactEvidence(target, turn))) {
      return 'structured-transcript';
    }
    if (input.sendMarkers.some(marker => isAuthoritativeSubmitSendMarker(marker, target, {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.sinceMs !== undefined ? { sinceMs: input.sinceMs } : {}),
    }))) {
      return 'botmux-send';
    }
  }
  return input.ptyActive ? 'pty-output' : undefined;
}

export function combineSubmitCurrentFences(
  ...fences: readonly (() => boolean)[]
): () => boolean {
  return () => fences.every(fence => fence());
}

export type SubmitConfirmationAction =
  | { kind: 'notify-hard-failure'; reason: string }
  | { kind: 'suppress-confirmed' }
  | { kind: 'suppress-usage-limit' }
  | { kind: 'suppress-active'; evidence: SubmitActivityEvidence }
  | { kind: 'notify-stuck' };

export interface SubmitConfirmationDecisionInput {
  failureReason?: string;
  recheckSubmitted: boolean;
  usageLimitDetected: boolean;
  activityEvidence?: SubmitActivityEvidence;
}

export function decideSubmitConfirmationAction(input: SubmitConfirmationDecisionInput): SubmitConfirmationAction {
  if (input.failureReason) return { kind: 'notify-hard-failure', reason: input.failureReason };
  if (input.recheckSubmitted) return { kind: 'suppress-confirmed' };
  if (input.usageLimitDetected) return { kind: 'suppress-usage-limit' };
  if (input.activityEvidence) return { kind: 'suppress-active', evidence: input.activityEvidence };
  return { kind: 'notify-stuck' };
}

export interface StructuredSubmitLifecycleController {
  hasPendingTurn(turnId: string, dispatchAttempt?: number): boolean;
  /** The exact attempt is still queued but already closed by its native
   *  terminal (e.g. FIFO-held behind an unfinished predecessor). */
  hasTerminalTurn(turnId: string, dispatchAttempt?: number): boolean;
  /** Stronger variant: the closed turn also proved whole-input receipt (never
   *  provisional task_started or prefix-only partial match). Optional for
   *  backwards compatibility with test doubles. */
  hasExactTerminalTurn?(
    turnId: string,
    dispatchAttempt?: number,
    expectedSourceSessionId?: string,
  ): boolean;
  confirmPendingTurn(
    turnId: string,
    confirmedAtMs?: number,
    dispatchAttempt?: number,
    options?: { weak?: boolean },
  ): boolean;
  finishSubmitVerification(turnId: string, finishedAtMs?: number, dispatchAttempt?: number): boolean;
}

export interface DeferredSubmitConfirmationInput {
  turnId?: string;
  dispatchAttempt?: number;
  /** Observed native session id for this worker generation, used to reject
   *  foreign-session closed terminals. */
  expectedSourceSessionId?: string;
  /** True only when turnId names a CodexBridgeQueue mark. Claude fallback
   *  turns use BridgeTurnQueue IDs, so treating every bridge ID as a
   *  structured target would incorrectly discard every Claude recheck. */
  structuredTarget?: boolean;
  recheck?: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
  usageLimitDetected: () => boolean;
  activityEvidence: () => SubmitActivityEvidence | undefined;
  /** Generation/backend fence owned by the worker. It is checked both before
   *  invoking the old recheck closure and after its await resolves. */
  isCurrent?: () => boolean;
}

export interface CurrentDeferredSubmitConfirmationSettlement {
  stale: false;
  action: SubmitConfirmationAction;
  cliSessionId?: string;
  /** Positive native ownership reported by the recheck, when the adapter can prove it. */
  ownershipProven?: boolean;
  /** Not-yet-owned session id candidate reported by the recheck (see SubmitRecheckResult). */
  unprovenCliSessionId?: string;
  recheckError?: unknown;
  lifecycle: 'confirmed' | 'verification-finished' | 'unchanged';
}

export interface StaleDeferredSubmitConfirmationSettlement {
  stale: true;
  staleReason: 'generation' | 'attempt';
  lifecycle: 'unchanged';
}

export type DeferredSubmitConfirmationSettlement =
  | CurrentDeferredSubmitConfirmationSettlement
  | StaleDeferredSubmitConfirmationSettlement;

export type StaleWriteContinuationDisposition = 'ambiguous-terminal' | 'ordinary-carryover';

/** Settle an await continuation whose CLI generation is no longer current.
 * Ordinary inputs are already owned by InflightInputTracker's crash carryover:
 * touching the process-global bridge queues or warning the user here could
 * delete the replacement generation's same-ID mark or invite a duplicate
 * manual retry. Durable inputs are not auto-replayed and therefore need their
 * exact attempt terminal reconciled by the receiver. */
export function settleStaleWriteContinuation(
  identity: { turnId?: string; dispatchAttempt?: number },
  errorCode: string,
  emitAmbiguous: (turnId: string, errorCode: string, dispatchAttempt: number) => void,
): StaleWriteContinuationDisposition {
  if (identity.turnId && identity.dispatchAttempt !== undefined) {
    emitAmbiguous(identity.turnId, errorCode, identity.dispatchAttempt);
    return 'ambiguous-terminal';
  }
  return 'ordinary-carryover';
}

/** Execute the deferred submit-recheck callback and settle the structured
 *  pre-start lifecycle atomically with its decision. Both an actual history
 *  recheck hit and weaker "CLI is active" evidence become a bounded confirmed
 *  lease. The latter must not merely clear verification: that would leave a
 *  bare, unstarted fingerprint which no expiry pruning can ever remove. */
export async function settleDeferredSubmitConfirmation(
  controller: StructuredSubmitLifecycleController,
  input: DeferredSubmitConfirmationInput,
): Promise<DeferredSubmitConfirmationSettlement> {
  const closedButUndrained = (): boolean => !!input.structuredTarget && !!input.turnId
    && controller.hasTerminalTurn(input.turnId, input.dispatchAttempt);
  const exactClosedButUndrained = (): boolean => !!input.structuredTarget && !!input.turnId
    && (controller.hasExactTerminalTurn
      ? controller.hasExactTerminalTurn(input.turnId, input.dispatchAttempt, input.expectedSourceSessionId)
      : controller.hasTerminalTurn(input.turnId, input.dispatchAttempt));
  const targetStillCurrent = (): StaleDeferredSubmitConfirmationSettlement | undefined => {
    if (input.isCurrent && !input.isCurrent()) {
      return { stale: true, staleReason: 'generation', lifecycle: 'unchanged' };
    }
    // Only a missing exact attempt (pruned, or replaced by attempt N+1) is
    // stale. A closed-but-undrained attempt is the same delivery with a native
    // terminal: discarding its recheck would drop the input-delivery
    // quarantine's only release while that terminal waits behind its FIFO
    // predecessor, holding every later input in BotMux (#2642).
    if (input.structuredTarget
      && input.turnId
      && !controller.hasPendingTurn(input.turnId, input.dispatchAttempt)
      && !closedButUndrained()) {
      return { stale: true, staleReason: 'attempt', lifecycle: 'unchanged' };
    }
    return undefined;
  };

  // A durable attempt can expire/restart during the 20s delay before this
  // function is called. Never run its old adapter closure against a new CLI.
  const staleBeforeRecheck = targetStillCurrent();
  if (staleBeforeRecheck) return staleBeforeRecheck;
  // Its native terminal with whole-input match already proves the submit, and
  // the FIFO drain owns its final/terminal. Settle as structured success
  // without the adapter recheck: a missed receipt plus usage-limit/no-activity
  // must not fail or drop a turn that has already answered.
  if (exactClosedButUndrained()) {
    return {
      stale: false,
      action: { kind: 'suppress-active', evidence: 'structured-transcript' },
      lifecycle: 'unchanged',
    };
  }

  let recheckSubmitted = false;
  let cliSessionId: string | undefined;
  let unprovenCliSessionId: string | undefined;
  let ownershipProven = false;
  let recheckError: unknown;
  if (input.recheck) {
    try {
      const result = await input.recheck();
      recheckSubmitted = typeof result === 'boolean' ? result : result.submitted === true;
      ownershipProven = typeof result === 'object' && !!result && result.ownershipProven === true;
      cliSessionId = typeof result === 'object' && result && typeof result.cliSessionId === 'string'
        ? result.cliSessionId
        : undefined;
      unprovenCliSessionId = typeof result === 'object' && result && typeof result.unprovenCliSessionId === 'string'
        ? result.unprovenCliSessionId
        : undefined;
    } catch (err) {
      recheckError = err;
    }
  }

  // The old closure can itself await filesystem/CLI state. Re-check both the
  // CLI generation and exact attempt before any lifecycle or caller effect.
  const staleAfterRecheck = targetStillCurrent();
  if (staleAfterRecheck) return staleAfterRecheck;

  const action = decideSubmitConfirmationAction({
    recheckSubmitted,
    usageLimitDetected: input.usageLimitDetected(),
    activityEvidence: input.activityEvidence(),
  });

  let lifecycle: DeferredSubmitConfirmationSettlement['lifecycle'] = 'unchanged';
  if (input.structuredTarget && input.turnId) {
    if (action.kind === 'suppress-confirmed' || action.kind === 'suppress-active') {
      const confirmOptions = action.kind === 'suppress-active' && action.evidence === 'pty-output'
        ? { weak: true }
        : undefined;
      if (controller.confirmPendingTurn(input.turnId, undefined, input.dispatchAttempt, confirmOptions)) {
        lifecycle = 'confirmed';
      } else if (controller.finishSubmitVerification(input.turnId, undefined, input.dispatchAttempt)) {
        lifecycle = 'verification-finished';
      }
    } else if (controller.finishSubmitVerification(input.turnId, undefined, input.dispatchAttempt)) {
      lifecycle = 'verification-finished';
    }
  }

  return {
    stale: false,
    action,
    ...(cliSessionId ? { cliSessionId } : {}),
    ...(ownershipProven ? { ownershipProven: true } : {}),
    ...(unprovenCliSessionId ? { unprovenCliSessionId } : {}),
    ...(recheckError !== undefined ? { recheckError } : {}),
    lifecycle,
  };
}
