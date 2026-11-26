/** Narrow rolling-recovery protocol, never a general user_notify exemption. */
export function isStructuredNoticeProtocolMessage(message: {
  type: string;
  kind?: string;
  turnId?: string;
  noticeId?: string;
}): boolean {
  if (typeof message.turnId !== 'string' || !message.turnId
    || typeof message.noticeId !== 'string' || !message.noticeId) return false;
  return message.type === 'turn_display_retired'
    || (message.type === 'user_notify' && message.kind === 'structured_turn_not_collected');
}
