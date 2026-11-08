import type { DaemonSession } from './types.js';
import { pickTurnReplyTarget } from './reply-target.js';

/** Resolve the requesting user from daemon-owned records for one exact turn.
 * The worker supplies only the turn id, never a user or a session-owner fallback. */
export function currentGatewayCallerOpenId(
  ds: Pick<DaemonSession, 'session' | 'larkAppId' | 'scheduledTurnCallers' | 'managedTurnOrigin'>,
  turnId: string,
): string | undefined {
  const origin = ds.managedTurnOrigin;
  if (origin?.turnId === turnId) {
    // Preserve the upstream execution principal, including explicit callerless
    // turns. Only older workers without this field may recover from registries.
    if (origin.trustedCaller === null) return undefined;
    if (origin.trustedCaller !== undefined) return origin.callerOpenId;
  }
  const replyTargetCaller = pickTurnReplyTarget(ds.session, turnId)?.senderOpenId;
  if (replyTargetCaller) return replyTargetCaller;
  // Document turns have their own reply-target registry, populated before
  // worker delivery. Never borrow the subscription/session owner or a later turn.
  // The daemon writes it in this app's session; credential routes still verify
  // the resolved identity is a real user before reading that user's token.
  const commentTarget = ds.session.docCommentTargets?.[turnId];
  if (commentTarget?.turnId === turnId && commentTarget.replyToOpenId) {
    return commentTarget.replyToOpenId;
  }
  const recovered = ds.session.failedTurnRecovery;
  if (recovered?.turnId === turnId && recovered.caller.requestLarkAppId === ds.larkAppId
      && recovered.caller.senderType === 'user') return recovered.caller.requestUserOpenId;
  const scheduledCaller = ds.scheduledTurnCallers?.get(turnId);
  if (scheduledCaller) {
    // Keep the exact-turn caller across the worker's repeated origin publications.
    return scheduledCaller.requestUserOpenId;
  }
  const continuation = ds.session.readonlyTaskContinuation;
  return continuation?.authorizationMode === 'inherited'
    && continuation.currentTurnId === turnId
    && continuation.trustedCaller?.requestLarkAppId === ds.larkAppId
    && continuation.trustedCaller.senderType === 'user'
    ? continuation.trustedCaller.requestUserOpenId
    : undefined;
}
