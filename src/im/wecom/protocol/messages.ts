import type { WecomInboundMessage, WecomAttachment, WecomCardEvent } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
function content(body: ObjectValue): {text: string; attachments: WecomAttachment[]} {
  const attachments: WecomAttachment[] = [];
  const texts: string[] = [];
  const items = body.msgtype === 'mixed' ? object(body.mixed).msg_item : [body];
  if (Array.isArray(items)) for (const raw of items) {
    const item = object(raw);
    if (item.msgtype === 'text' || item.msgtype === 'voice') texts.push(string(object(item[string(item.msgtype)]).content));
    if (item.msgtype === 'image' || item.msgtype === 'file') {
      const type = item.msgtype;
      const media = object(item[type]);
      if (string(media.url)) attachments.push({type, url: string(media.url), ...(string(media.aeskey) ? {aesKey: string(media.aeskey)} : {})});
    }
  }
  return {text: texts.join('\n'), attachments};
}
export function normalizeWecomMessage(raw: unknown, requestId: string): WecomInboundMessage | undefined {
  const body = object(raw);
  const messageId = string(body.msgid), userId = string(object(body.from).userid);
  const chatType = body.chattype;
  const conversationId = chatType === 'single' ? userId : string(body.chatid);
  if (!messageId || !userId || !conversationId || !requestId || (chatType !== 'single' && chatType !== 'group')) return;
  const parsed = content(body);
  const quote = object(body.quote);
  return {messageId, userId, conversationId, chatType, ...parsed, replyContext: {requestId},
    ...(string(quote.msgtype) ? {quote: {type: string(quote.msgtype), text: content(quote).text}} : {})};
}

export function normalizeWecomCardEvent(raw: unknown, requestId: string, botId: string, now = Date.now()): WecomCardEvent | undefined {
  const body = object(raw), event = object(body.event);
  if (event.eventtype !== 'template_card_event' || body.aibotid !== botId) return;
  const messageId = string(body.msgid), userId = string(object(body.from).userid), taskId = string(event.task_id), eventKey = string(event.event_key);
  const chatType = body.chattype ?? 'single';
  const conversationId = chatType === 'single' ? userId : string(body.chatid);
  if (!messageId || !userId || !taskId || !eventKey || !requestId || !conversationId || (chatType !== 'single' && chatType !== 'group')) return;
  return { messageId, botId, userId, taskId, eventKey, requestId, chatType, conversationId, receivedAt: now };
}
