/**
 * Opt-in non-executing bot notification contract. It carries no business role
 * or workflow state; publishers retain those facts in their own ledger.
 *
 * Only a top-level card separator with this reserved ID is a notice. Quoted
 * text, nested cards and human forwards cannot opt another message out.
 */
export const BOTMUX_NOTICE_ELEMENT_ID = 'botmux_notice_v1';

export function classifyNoticeCard(content: unknown): 'notice' | 'ordinary' | 'unresolved' {
  let card: any;
  try { card = typeof content === 'string' ? JSON.parse(content) : content; }
  catch { return 'unresolved'; }
  if (!card || card.schema !== '2.0' || !Array.isArray(card.body?.elements)) return 'unresolved';
  return card.body.elements.some((element: any) =>
    element?.tag === 'hr' && element.element_id === BOTMUX_NOTICE_ELEMENT_ID)
    ? 'notice' : 'ordinary';
}

export async function isNonExecutingBotNotice(
  data: { sender?: { sender_type?: string }; message?: any },
  readCard: (messageId: string) => Promise<any>,
): Promise<boolean> {
  if (!['app', 'bot'].includes(data.sender?.sender_type ?? '')) return false;
  const message = data.message;
  const type = message?.message_type ?? message?.msg_type;
  if (type !== 'interactive' && type !== 'nonsupport') return false;
  const direct = classifyNoticeCard(message.content ?? message.body?.content);
  if (direct !== 'unresolved') return direct === 'notice';
  // WS/list responses may contain a flattened placeholder with no element IDs.
  // Never admit that placeholder through a listener or the auto-start path.
  if (!message?.message_id) throw new Error('bot_notice_message_identity_missing');
  const detail = await readCard(message.message_id);
  const current = detail?.items?.[0] ?? detail?.message;
  if (!current || current.message_id !== message.message_id || current.chat_id !== message.chat_id
      || current.deleted === true || !['app', 'bot'].includes(current.sender?.sender_type)) {
    throw new Error('bot_notice_readback_unproven');
  }
  const readback = classifyNoticeCard(current.body?.content ?? current.content);
  // A full legacy card cannot contain the v1 schema-2 marker. Keep its ordinary
  // routing, but do not infer that from a list/WS placeholder.
  if (readback === 'unresolved') {
    let card: any;
    try { card = JSON.parse(current.body?.content ?? current.content); } catch {}
    if (Array.isArray(card?.elements) && !card.schema) return false;
    throw new Error('bot_notice_card_content_unavailable');
  }
  return readback === 'notice';
}
