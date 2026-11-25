import type { Session, TrustedCaller } from '../types.js';
import {
  pickTurnReplyTarget,
  registryEntryProvesHumanSender,
  registryTurnMayAuthenticateHuman,
} from './reply-target.js';

/** Return the exact human who opened a source turn, or fail closed. The
 * daemon-owned per-turn registry is the authority; session owner and any later
 * cross-chat responder are deliberately irrelevant. */
export function taskContinuationSourceOpenId(
  session: Pick<Session,
    | 'status'
    | 'replyTargets'
    | 'currentReplyTarget'
    | 'quoteTargetId'
    | 'quoteTargetSenderOpenId'
    | 'ordinaryTurnRecovery'
    | 'failedTurnRecovery'
    | 'readonlyTaskContinuation'
    | 'turnReplyContexts'>,
  sourceTurnId: string,
): string | undefined {
  if (session.status !== 'active' || !registryTurnMayAuthenticateHuman(session, sourceTurnId)) {
    return undefined;
  }
  const target = pickTurnReplyTarget(session, sourceTurnId);
  return registryEntryProvesHumanSender(target) ? target.senderOpenId : undefined;
}

/** Attach an independently scoped continuation principal while preserving the
 * immediate bot caller for routing and audit. Both identities must be
 * host-attested and agree with the exact source-turn registry entry. */
export function buildTaskContinuationCaller(input: {
  rawCaller: TrustedCaller | undefined;
  sourcePrincipal: TrustedCaller | undefined;
  larkAppId: string;
  sourceSession: Pick<Session,
    | 'sessionId'
    | 'status'
    | 'replyTargets'
    | 'currentReplyTarget'
    | 'quoteTargetId'
    | 'quoteTargetSenderOpenId'
    | 'ordinaryTurnRecovery'
    | 'failedTurnRecovery'
    | 'readonlyTaskContinuation'
    | 'turnReplyContexts'>;
  sourceTurnId: string;
}): TrustedCaller | undefined {
  const { rawCaller, sourcePrincipal, larkAppId, sourceSession, sourceTurnId } = input;
  const sourceOpenId = taskContinuationSourceOpenId(sourceSession, sourceTurnId);
  if (!sourceOpenId
    || rawCaller?.senderType !== 'bot'
    || sourcePrincipal?.senderType !== 'user'
    || sourcePrincipal.requestLarkAppId !== larkAppId
    || sourcePrincipal.requestUserOpenId !== sourceOpenId) {
    return undefined;
  }
  return {
    ...rawCaller,
    taskContinuation: {
      appId: larkAppId,
      openId: sourceOpenId,
      ...(sourcePrincipal.requestUserUnionId
        ? { unionId: sourcePrincipal.requestUserUnionId }
        : {}),
      sourceSessionId: sourceSession.sessionId,
      sourceTurnId,
    },
  };
}

/** A durable queued head owns its activation identity. The new cross-chat
 * reply is already frozen as a separate tail entry, so its continuation must
 * not be copied onto that older head. Ordinary callers retain the historical
 * refork behaviour; this only narrows the new continuation channel. */
export function reforkActivationTrustedCaller(input: {
  threadCaller: TrustedCaller | undefined;
  continuationCaller: TrustedCaller | undefined;
  queuedHasDurableTail: boolean;
}): TrustedCaller | undefined {
  return input.threadCaller
    ?? (input.queuedHasDurableTail ? undefined : input.continuationCaller);
}
