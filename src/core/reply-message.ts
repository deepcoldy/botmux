import { compatibleAuthorityPrincipal } from './active-turn-authority.js';
import { replyTargetKey, type SessionReplyTarget } from './reply-target.js';
import type { AncestorSessionContext, QueuedTypeAheadTurn } from './session-marker.js';

/** Reply addressing only. Never use this selection as execution/actor authority. */
export function selectReplyMessageId(
  session: { sessionId: string; turnReplyContexts?: Record<string, { target?: unknown }> },
  executionTurnId: string | undefined,
  marker: AncestorSessionContext | null | undefined,
  explicitMessageId?: string,
): string | undefined {
  if (explicitMessageId !== undefined) {
    if (!explicitMessageId.startsWith('om_') || !parseReplyMessageTarget(session.turnReplyContexts?.[explicitMessageId]?.target)) {
      throw new Error('--reply-to requires a retained incoming message from this session');
    }
    return explicitMessageId;
  }
  if (marker?.sessionId === session.sessionId && marker.turnId === executionTurnId) {
    const consumed = marker.queuedTurns?.filter(turn =>
      turn.inputConsumed === true
      && (turn.absorbedIntoTurnId === undefined
        || (turn.absorbedIntoTurnId === executionTurnId
          && turn.absorbedIntoDispatchAttempt === marker.dispatchAttempt)))
      .at(-1);
    if (consumed && parseReplyMessageTarget(session.turnReplyContexts?.[consumed.turnId]?.target)) return consumed.turnId;
    const settled = marker.settledAbsorbedTurns
      ?.filter(turn => turn.hostTurnId === executionTurnId && turn.hostDispatchAttempt === marker.dispatchAttempt)
      .at(-1);
    if (settled && parseReplyMessageTarget(session.turnReplyContexts?.[settled.turnId]?.target)) return settled.turnId;
  }
  return executionTurnId;
}

export interface AbsorbedTurnSettlementContext {
  session: {
    sessionId: string;
    scope?: 'chat' | 'thread';
    turnReplyContexts?: Record<string, {
      target?: unknown;
      replyTargetSenderOpenId?: string;
      crossChatOrigin?: InboundMessageLocation['crossChatOrigin'];
    }>;
    replyTargets?: Record<string, {
      senderOpenId?: string;
      crossChatOrigin?: InboundMessageLocation['crossChatOrigin'];
    }>;
  };
  originSessionId: string | undefined;
  originDispatchAttempt: number | undefined;
  /** Absorbed turn IDs already observed on the PID marker BEFORE this send
   *  invoked Lark HTTP. Prevents a TOCTOU swallow of messages absorbed while
   *  the final send was in flight. */
  preSendAbsorbedTurnIds: ReadonlySet<string>;
  actualDeliveredTarget: SessionReplyTarget | undefined;
  privateReply: boolean;
  replyTargetSenderOpenId: string | undefined;
  explicitReplyTo: string | undefined;
  routingOverride: boolean;
  excludedSendKind: boolean;
  crossPrincipalInterruption: boolean;
}

/** Fail-closed send/session gate for settling a Claude mid-turn absorbed
 *  queued turn alongside its host turn's final send. Relies purely on
 *  structural transcript/destination/principal evidence (never message content). */
export function buildAbsorbedTurnSettlementGate(
  ctx: AbsorbedTurnSettlementContext,
): (turn: QueuedTypeAheadTurn, marker: AncestorSessionContext) => boolean {
  const sendEligible = ctx.originSessionId === ctx.session.sessionId
    && ctx.originDispatchAttempt === undefined
    && !ctx.routingOverride
    && !ctx.excludedSendKind
    && ctx.preSendAbsorbedTurnIds.size > 0;
  return (turn, marker) => {
    if (!sendEligible) return false;
    if (!ctx.preSendAbsorbedTurnIds.has(turn.turnId)) return false;
    if (ctx.explicitReplyTo !== undefined && turn.turnId !== ctx.explicitReplyTo) return false;
    const turnCtx = ctx.session.turnReplyContexts?.[turn.turnId];
    const turnTarget = ctx.session.replyTargets?.[turn.turnId];
    if (turnCtx?.crossChatOrigin || turnTarget?.crossChatOrigin) return false;
    if (ctx.privateReply) {
      const bSender = turnTarget?.senderOpenId
        ?? turnCtx?.replyTargetSenderOpenId
        ?? turn.trustedCaller?.requestUserOpenId;
      if (!bSender || !ctx.replyTargetSenderOpenId || bSender !== ctx.replyTargetSenderOpenId) {
        return false;
      }
    }
    if (ctx.session.scope !== 'thread') {
      const bTarget = parseReplyMessageTarget(turnCtx?.target);
      if (!ctx.actualDeliveredTarget || !bTarget) return false;
      if (replyTargetKey(bTarget) !== replyTargetKey(ctx.actualDeliveredTarget)) return false;
    }
    if (ctx.crossPrincipalInterruption
      && !compatibleAuthorityPrincipal(marker.trustedCaller, turn.trustedCaller)) {
      return false;
    }
    return true;
  };
}

export interface InboundMessageLocation {
  messageId?: string;
  rootMessageId?: string;
  /** When the message arrived from a cross-chat followed thread in another group. */
  crossChatOrigin?: {
    sourceChatId: string;
    followedChatId: string;
    followedRootMessageId: string;
  };
}

export function crossChatOriginForSend(input: {
  replyContext?: { crossChatOrigin?: InboundMessageLocation['crossChatOrigin'] };
  replyTarget?: { crossChatOrigin?: InboundMessageLocation['crossChatOrigin'] };
  frozenTurnDispatch?: { crossChatOrigin?: InboundMessageLocation['crossChatOrigin'] };
}): InboundMessageLocation['crossChatOrigin'] | undefined {
  return input.replyContext?.crossChatOrigin
    ?? input.replyTarget?.crossChatOrigin
    ?? input.frozenTurnDispatch?.crossChatOrigin;
}

/** A followed-chat sender is never the origin session's implicit addressee.
 * Only an explicit send back into the followed chat may retain that sender. */
export function crossChatSenderForSend(input: {
  crossChatOrigin?: InboundMessageLocation['crossChatOrigin'];
  sendingToOriginSessionChat: boolean;
  frozenTurnSender?: string;
  perTurnSender?: string;
  legacySender?: string;
  originQuoteSender?: string;
  originLastCaller?: string;
  originOwner?: string;
}): string | undefined {
  if (!input.crossChatOrigin || !input.sendingToOriginSessionChat) {
    return input.frozenTurnSender ?? input.perTurnSender ?? input.legacySender;
  }
  return input.originQuoteSender ?? input.originLastCaller ?? input.originOwner;
}

export function renderCrossChatReplyHint(cross: NonNullable<InboundMessageLocation['crossChatOrigin']>): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]!);
  const followedChatId = escape(cross.followedChatId);
  const rootId = escape(cross.followedRootMessageId);
  const sourceChatId = escape(cross.sourceChatId);
  return `<cross_chat_reply_hint chat_id="${followedChatId}" root_message_id="${rootId}" default_reply_chat_id="${sourceChatId}">`
    + `本条消息来自跨群（${followedChatId}）的话题（${rootId}），是对本会话此前跨群发送消息的回复。`
    + `直接执行 \`botmux send\` 默认仍发送到主会话群（${sourceChatId}）；`
    + `若需在该跨群话题内回复对方，请显式加传参：\`botmux send --chat-id ${followedChatId} --into ${rootId}\`。`
    + `</cross_chat_reply_hint>`;
}

/** Host-authored metadata; kept outside the user's message in both input modes. */
export function renderInboundMessageLocation(location: InboundMessageLocation | undefined): string {
  if (!location) return '';
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]!);
  const cross = location.crossChatOrigin;
  if (cross) {
    const rootId = location.rootMessageId ?? cross.followedRootMessageId;
    return `<message_location${location.messageId ? ` message_id="${escape(location.messageId)}"` : ''} placement="thread" chat_id="${escape(cross.followedChatId)}" root_message_id="${escape(rootId)}" default_reply_chat_id="${escape(cross.sourceChatId)}" />\n${renderCrossChatReplyHint(cross)}`;
  }
  return `<message_location${location.messageId ? ` message_id="${escape(location.messageId)}"` : ''} placement="${location.rootMessageId ? 'thread' : 'chat'}"${location.rootMessageId ? ` root_message_id="${escape(location.rootMessageId)}"` : ''} />`;
}

export function parseReplyMessageTarget(value: unknown): SessionReplyTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as { mode?: unknown; chatId?: unknown; rootMessageId?: unknown };
  if (target.mode === 'plain' && typeof target.chatId === 'string' && target.chatId) {
    return { mode: 'plain', chatId: target.chatId };
  }
  if ((target.mode === 'thread' || target.mode === 'quote')
    && typeof target.rootMessageId === 'string' && target.rootMessageId.startsWith('om_')) {
    return { mode: target.mode, rootMessageId: target.rootMessageId };
  }
  return undefined;
}
