import type { DaemonSession } from './types.js';
import { isHumanInboundTurnId, isSubstituteTurn } from './reply-target.js';
import { privateReplyEnabled } from './private-reply.js';
import { isTriggerFinalSuppressed } from './trigger-final-suppression.js';
import { managedAuxUiSuppressedFor } from './worker-pool.js';

/**
 * Preserve each exact turn's existing IM, silent, meeting, replay and
 * presentation boundaries. The predicate mirrors the per-turn auxiliary-card
 * gates used by the CLI progress notifier (`beginCliNotice` /
 * `cliNotices.allowed` in worker-pool): only a real human-inbound turn may
 * receive an auxiliary operational card. In particular, daemon-minted
 * maintenance turns (`auto-compact:…` passthrough writes) have their own
 * execution observations but must not produce "task still running" cards.
 */
export function canSendLongTaskReminder(
  session: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): boolean {
  return isHumanInboundTurnId(turnId)
    && !session.chatId.startsWith('doc:')
    && !managedAuxUiSuppressedFor(session, turnId, dispatchAttempt)
    // Chat-scope substitute (分身) turns hide their streaming card per turn;
    // an operational reminder must not become that turn's only group output.
    && !isSubstituteTurn(session, turnId)
    // A group role configured for private replies keeps all turn output in
    // the requester DM; a topic card would leak the running task's title.
    && !privateReplyEnabled(session)
    // Trigger turns whose final result is isolated must not surface aux UI.
    && !isTriggerFinalSuppressed(session, turnId)
    // Adopted terminal sessions own no Lark turn surface.
    && !session.adoptedFrom
    && !session.session.adoptedFrom;
}
