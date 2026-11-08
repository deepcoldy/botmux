import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';

/** The execution whose deployment checkpoint may be recorded or cancelled.
 * Admission takes precedence over a previous execution's late receipt. The
 * initial idle prompt may revoke that admission hint before the worker writes
 * the input; its subsequently published live origin then owns the execution.
 * Reply routing alone is not execution evidence. */
export function deploymentContinuationAuthority(ds: DaemonSession): {
  turnId: string; caller?: TrustedCaller | null;
} | undefined {
  const admitted = ds.activeInteractiveTurn;
  const origin = ds.managedTurnOrigin;
  if (admitted && admitted.turnId !== origin?.turnId) return admitted;
  if (origin?.turnId) return { turnId: origin.turnId, caller: origin.trustedCaller };
  const restored = ds.session.deploymentContinuation;
  if (restored?.state === 'claimed' && ds.currentReplyTarget?.turnId === restored.turnId) {
    return { turnId: restored.turnId, caller: restored.caller };
  }
}
