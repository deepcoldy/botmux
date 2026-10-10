import { extractAuthoredMessageText, parseEventMessage, resolvePostBody, stripLeadingMentions } from './message-parser.js';
import { isCallbackUrl } from '../../utils/user-token.js';
import { parseTopicHeader } from '../../core/topic-header.js';
import type { InputCaptureRuntime } from '../../core/plugins/input-capture/runtime.js';
import type { CaptureAttachment } from '../../core/plugins/input-capture/attachments.js';

/** Synchronous pre-ACK path. Only exact raw message anchors enter the journal;
 * command / callback routing stays with the existing dispatcher. Attachments
 * enter only explicitly subscribed bindings, as durable resource references. */
export function captureInboundText(data: any, runtime: InputCaptureRuntime,
  knownBot: (openId: string) => boolean): boolean {
  const message = data?.message;
  if (data?.sender?.sender_type !== 'user' || !message || !['text', 'post', 'image', 'file', 'audio', 'media', 'merge_forward'].includes(message.message_type)
    || (message.root_id && !/^om_[A-Za-z0-9_-]+$/.test(message.root_id))
    || (message.thread_id && !/^omt_[A-Za-z0-9_-]{1,196}$/.test(message.thread_id))
    || message.root_id && message.root_id === message.message_id) return false;
  const { parsed, resources } = parseEventMessage(data);
  if (parsed.senderType === 'app' || parsed.senderType === 'bot'
    || !parsed.senderId || knownBot(parsed.senderId)) return false;
  const attachments: CaptureAttachment[] = resources.map(resource => ({
    messageId: resource.messageId ?? parsed.messageId, type: resource.type, key: resource.key,
  }));
  try {
    if (['audio', 'media'].includes(message.message_type)) {
      attachments.push({ messageId: parsed.messageId, type: message.message_type, key: JSON.parse(message.content).file_key });
    }
    if (message.message_type === 'merge_forward') attachments.push({ messageId: parsed.messageId, type: 'merge_forward', key: parsed.messageId });
    if (message.message_type === 'post') {
      for (const paragraph of resolvePostBody(JSON.parse(message.content)).content) {
        for (const node of Array.isArray(paragraph) ? paragraph : [paragraph]) {
          if (node?.tag === 'media' && node.file_key && !attachments.some(ref => ref.type === 'media' && ref.key === node.file_key)) {
            attachments.push({ messageId: parsed.messageId, type: 'media', key: node.file_key });
          }
        }
      }
    }
  } catch { return false; }
  if (!['text', 'post'].includes(message.message_type) && !attachments.length) return false;
  const text = attachments.length ? extractAuthoredMessageText(message.message_type, message.content, message.mentions) : parsed.content;
  const command = stripLeadingMentions(text.trim(), parsed.mentions).trim();
  if (!command && !attachments.length || command.startsWith('/') || isCallbackUrl(command)
    || parseTopicHeader(command) !== null) return false;
  const anchor = message.root_id || (message.thread_id ? runtime.resolveThreadAnchor({
    messageId: parsed.messageId, chatId: message.chat_id, senderOpenId: parsed.senderId, threadId: message.thread_id,
  }) : message.chat_id);
  if (!anchor) return false;
  return runtime.capture({ messageId: parsed.messageId, chatId: message.chat_id,
    anchor, senderOpenId: parsed.senderId, ...(message.thread_id ? { threadId: message.thread_id } : {}),
    memberUnionId: parsed.senderUnionId, text, ...(attachments.length ? { attachments } : {}), botSender: false });
}
