import type { Session, TrustedCaller } from '../types.js';
import { CODEX_CAPACITY_ERROR_CODE, isCodexCapacityError } from './codex-transcript.js';

export function codexCapacityRecoveryCli(cliId: string | undefined): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
}

/** Only a proven native terminal may supply recovery authority. Text in an
 * assistant answer, tool output or an unknown transport outcome is not one. */
export function codexAppTurnFailureCode(turn: { status?: unknown; error?: unknown }): string | undefined {
  if (turn.status !== 'failed') return undefined;
  // A failed terminal may omit the error object entirely (protocol variant).
  // Classify before descending into isCodexCapacityError: JSON.stringify(
  // undefined) returns undefined, not a string, and .toLowerCase() there is an
  // uncaught TypeError that kills the runner. Mirrors codex-rpc-engine's
  // `turn.error ? rpcTurnErrorCode(turn.error) : ''` guard.
  if (!turn.error) return 'codex_app_turn_failed';
  return isCodexCapacityError(turn.error) ? CODEX_CAPACITY_ERROR_CODE : 'codex_app_turn_failed';
}

/** Resolve only the acceptance-time human for this exact logical IM turn.
 * Never borrow the latest reply target, session owner or another app's user. */
export function codexAppRecoveryCaller(
  session: Pick<Session, 'larkAppId' | 'turnReplyContexts' | 'replyTargets'>,
  appId: string,
  logicalTurnId: string,
): TrustedCaller | undefined {
  if (session.larkAppId !== appId || !logicalTurnId.startsWith('om_')) return;
  const context = session.turnReplyContexts?.[logicalTurnId];
  const target = session.replyTargets?.[logicalTurnId];
  const openId = context?.replyTargetSenderOpenId ?? target?.senderOpenId;
  const isBot = context?.replyTargetSenderIsBot
    ?? target?.participants?.find(person => person.openId === openId)?.isBot;
  if (!openId?.startsWith('ou_') || isBot !== false) return;
  return { requestLarkAppId: appId, requestUserOpenId: openId, senderType: 'user' };
}
