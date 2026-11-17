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
  /** When the message arrived from a cross-chat followed thread in another group. */
  crossChatOrigin?: {
    sourceChatId: string;
    followedChatId: string;
    followedRootMessageId: string;
  };
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
    return `<message_location message_id="${escape(location.messageId)}" placement="thread" chat_id="${escape(cross.followedChatId)}" root_message_id="${escape(rootId)}" default_reply_chat_id="${escape(cross.sourceChatId)}" />\n${renderCrossChatReplyHint(cross)}`;
  }
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
