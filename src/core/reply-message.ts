import type { SessionReplyTarget } from './reply-target.js';
import type { AncestorSessionContext } from './session-marker.js';

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
    const consumed = marker.queuedTurns?.filter(turn => turn.inputConsumed === true).at(-1);
    if (consumed && parseReplyMessageTarget(session.turnReplyContexts?.[consumed.turnId]?.target)) return consumed.turnId;
  }
  return executionTurnId;
}

export interface InboundMessageLocation {
  messageId: string;
  rootMessageId?: string;
}

/** Host-authored metadata; kept outside the user's message in both input modes. */
export function renderInboundMessageLocation(location: InboundMessageLocation | undefined): string {
  if (!location) return '';
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]!);
  return `<message_location message_id="${escape(location.messageId)}" placement="${location.rootMessageId ? 'thread' : 'chat'}"${location.rootMessageId ? ` root_message_id="${escape(location.rootMessageId)}"` : ''} />`;
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
