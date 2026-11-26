import type { FailedTurnRecord, Session, TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { pickTurnReplyTarget } from './reply-target.js';

/** Cross-chat origin is checked in both indexes: replyTargets is bounded much
 *  sooner than turnReplyContexts, and either may be the only surviving proof. */
export function failedTurnCrossChatOrigin(
  session: Session,
  turnId: string,
): FailedTurnRecord['crossChatOrigin'] {
  return session.replyTargets?.[turnId]?.crossChatOrigin
    ?? session.turnReplyContexts?.[turnId]?.crossChatOrigin;
}

/** Snapshot only daemon-authenticated current-turn facts, never the owner. */
export function failedTurnCaller(
  ds: DaemonSession,
  turnId: string,
  opts?: { includeRecordedCaller?: boolean },
): TrustedCaller | undefined {
  const failed = opts?.includeRecordedCaller && ds.session.lastFailedTurn?.turnId === turnId
    ? ds.session.lastFailedTurn
    : undefined;
  if (failedTurnCrossChatOrigin(ds.session, turnId) || failed?.crossChatOrigin) return;
  const caller = ds.session.failedTurnRecovery?.turnId === turnId
    ? ds.session.failedTurnRecovery.caller
    : ds.activeInteractiveTurn?.turnId === turnId
      ? ds.activeInteractiveTurn.caller
      : ds.scheduledTurnCallers?.get(turnId) ?? failed?.trustedCaller;
  if (caller) {
    if (
      (caller.senderType === 'user' || caller.source === 'schedule_creator')
      && caller.requestLarkAppId === ds.larkAppId
      && caller.requestUserOpenId?.startsWith('ou_')
    ) {
      return { ...caller, senderType: 'user' };
    }
    // An explicit foreign/bot caller cannot be replaced by reply metadata.
    return;
  }
  if (ds.session.larkAppId !== ds.larkAppId) return;
  const target = pickTurnReplyTarget(ds.session, turnId);
  const human = target?.participants?.some(person => person.openId === target.senderOpenId && person.isBot === false)
    || (ds.session.quoteTargetId === turnId && ds.session.quoteTargetSenderIsBot === false);
  if (!human || !target?.senderOpenId?.startsWith('ou_')) return;
  return { requestUserOpenId: target.senderOpenId, requestLarkAppId: ds.larkAppId, senderType: 'user' };
}
