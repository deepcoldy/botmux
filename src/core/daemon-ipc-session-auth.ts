import {
  verifyVcMeetingManagedOriginClaim,
  type VcMeetingLiveManagedOrigin,
} from '../services/vc-meeting-send-policy.js';

export type SessionScopedIpcAuthDecision =
  | { ok: true }
  | { ok: false; error: 'origin_unproven' | 'managed_action_required' };

export interface SessionScopedIpcIdentity {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
}

/** Replace every caller-selectable route field with the authenticated
 * daemon-session identity while preserving endpoint-specific payload fields. */
export function bindSessionScopedIpcIdentity<T extends object>(
  payload: T,
  identity: SessionScopedIpcIdentity,
): T & SessionScopedIpcIdentity {
  return { ...payload, ...identity };
}

/**
 * Narrow fallback for commands that legitimately originate inside a
 * read-isolated CLI and therefore cannot read the host IPC HMAC secret.
 *
 * The daemon resolves `liveOrigin` from the exact body session id; callers must
 * present that session's current rotating capability. The visible turn/attempt
 * tuple is never accepted as proof. Receiver sessions are denied unless the
 * endpoint is explicitly non-observable (currently SessionStart readiness).
 */
export function authorizeSessionScopedIpc(input: {
  trustedHost: boolean;
  sessionExists: boolean;
  receiverSession: boolean;
  allowReceiver: boolean;
  sessionId: string;
  liveOrigin?: VcMeetingLiveManagedOrigin;
  claimedCapability?: string;
  claimedTurnId?: string;
  claimedDispatchAttempt?: number;
}): SessionScopedIpcAuthDecision {
  if (input.trustedHost) return { ok: true };
  if (!input.sessionExists || !input.sessionId) return { ok: false, error: 'origin_unproven' };
  if (input.receiverSession && !input.allowReceiver) {
    return { ok: false, error: 'managed_action_required' };
  }
  const verified = verifyVcMeetingManagedOriginClaim({
    receiverSessionId: input.sessionId,
    liveOrigin: input.liveOrigin,
    claimedCapability: input.claimedCapability,
    claimedTurnId: input.claimedTurnId,
    claimedDispatchAttempt: input.claimedDispatchAttempt,
  });
  return verified.ok
    ? { ok: true }
    : { ok: false, error: 'origin_unproven' };
}
