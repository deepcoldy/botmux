import type { MessageProvenance } from '../types.js';

export interface PrincipalLaneOutboundProvenanceDeps {
  beginTrustAttempt(provenance: MessageProvenance): string;
  recordTrusted(provenance: MessageProvenance, attemptId: string): void;
  completeTrustAttempt(provenance: MessageProvenance, attemptId: string): void;
  abortTrustAttempt(provenance: MessageProvenance, attemptId: string): void;
  markUntrusted(provenance: MessageProvenance): void;
  warn(message: string): void;
}

/** A Lark send that already returned a message id is transport-successful.
 * Provenance is supplementary authority: failure to persist it makes the
 * message unusable as a trusted reference, but must never make callers resend
 * an already-visible reply. */
export function settlePrincipalLaneOutboundProvenance(
  provenance: MessageProvenance,
  deps: PrincipalLaneOutboundProvenanceDeps,
): void {
  let attemptId: string | undefined;
  let trustedRecorded = false;
  try {
    // Commit the deny fence before the ambiguous trusted write. Only a later
    // completion transaction may make the message usable as authority.
    attemptId = deps.beginTrustAttempt(provenance);
    deps.recordTrusted(provenance, attemptId);
    trustedRecorded = true;
    deps.completeTrustAttempt(provenance, attemptId);
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 'trust_commit_unknown') {
      deps.warn(
        `outbound message remains delivered but its provenance trust commit is fenced: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (attemptId
        && (error as { code?: unknown } | undefined)?.code === 'session_store_busy') {
      let fenceReleased = false;
      try {
        // SessionStoreBusyError proves the nonblocking trusted transaction did
        // not begin or publish. Its exact tokenized fence is therefore safe to
        // release before applying the durable fail-closed downgrade.
        deps.abortTrustAttempt(provenance, attemptId);
        fenceReleased = true;
      } catch (abortError) {
        deps.warn(
          `failed to abort outbound provenance trust attempt: `
          + `${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
      }
      // If the trusted write returned, a busy completion transaction only left
      // its deny fence behind. Exact-token release completes that operation;
      // downgrading or warning that authority was lost would be incorrect.
      if (fenceReleased && trustedRecorded) return;
    }
    try {
      deps.markUntrusted({ ...provenance, trustState: 'untrusted' });
    } catch (markError) {
      deps.warn(
        `failed to mark outbound provenance untrusted: `
        + `${markError instanceof Error ? markError.message : String(markError)}`,
      );
    }
    deps.warn(
      `outbound message remains delivered but cannot authorize a reference: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
