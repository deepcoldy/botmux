import type { SubmitRecheckResult } from '../adapters/cli/types.js';

export type SubmitActivityEvidence = 'pty-output' | 'structured-transcript' | 'botmux-send';

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
  confirmPendingTurn(turnId: string, confirmedAtMs?: number, dispatchAttempt?: number): boolean;
  finishSubmitVerification(turnId: string, finishedAtMs?: number, dispatchAttempt?: number): boolean;
}

export interface DeferredSubmitConfirmationInput {
  turnId?: string;
  dispatchAttempt?: number;
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
  const targetStillCurrent = (): StaleDeferredSubmitConfirmationSettlement | undefined => {
    if (input.isCurrent && !input.isCurrent()) {
      return { stale: true, staleReason: 'generation', lifecycle: 'unchanged' };
    }
    if (input.structuredTarget
      && input.turnId
      && !controller.hasPendingTurn(input.turnId, input.dispatchAttempt)) {
      return { stale: true, staleReason: 'attempt', lifecycle: 'unchanged' };
    }
    return undefined;
  };

  // A durable attempt can expire/restart during the 20s delay before this
  // function is called. Never run its old adapter closure against a new CLI.
  const staleBeforeRecheck = targetStillCurrent();
  if (staleBeforeRecheck) return staleBeforeRecheck;

  let recheckSubmitted = false;
  let cliSessionId: string | undefined;
  let recheckError: unknown;
  if (input.recheck) {
    try {
      const result = await input.recheck();
      recheckSubmitted = typeof result === 'boolean' ? result : result.submitted === true;
      cliSessionId = typeof result === 'object' && result && typeof result.cliSessionId === 'string'
        ? result.cliSessionId
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
      if (controller.confirmPendingTurn(input.turnId, undefined, input.dispatchAttempt)) {
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
    ...(recheckError !== undefined ? { recheckError } : {}),
    lifecycle,
  };
}
