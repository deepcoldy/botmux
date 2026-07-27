import type { BotState, MessageListenerConfig } from '../bot-registry.js';
import { extractCardContent, unwrapUserDslContent } from '../im/lark/message-parser.js';

export const MAX_MESSAGE_LISTENER_PROMPT_BYTES = 32 * 1024;

export type MessageListenerSenderType = 'user' | 'bot';

export interface MessageListenerMatch {
  name?: string;
  replyCardTitle?: string;
  prompt: string;
  workingDir?: string;
  messageText: string;
  messageTitle?: string;
  msgType: string;
  senderOpenId?: string;
  senderName?: string;
  senderType: MessageListenerSenderType;
}

export interface MessageListenerPreviewMatch extends MessageListenerMatch {
  messageId: string;
  createTime?: string;
}

export const DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT = 5;
export const MAX_MESSAGE_LISTENER_PREVIEW_LIMIT = 20;

export function listenerSenderType(raw: unknown): MessageListenerSenderType {
  return raw === 'app' || raw === 'bot' ? 'bot' : 'user';
}

export function messageTypeOf(message: any): string {
  return String(message?.message_type ?? message?.msg_type ?? '').trim() || 'text';
}

function listenerMessageRawContent(message: any): string {
  const content = message?.content ?? message?.body?.content;
  return typeof content === 'string' ? content : '';
}

function listenerMessageContent(message: any): string {
  const content = listenerMessageRawContent(message);
  if (!content) return '';
  return messageTypeOf(message) === 'interactive'
    ? unwrapUserDslContent(content) ?? content
    : content;
}

function firstTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function extractListenerMessageTitle(message: any): string | undefined {
  const content = listenerMessageContent(message);
  if (!content) return undefined;
  const msgType = messageTypeOf(message);
  if (msgType === 'interactive') {
    const renderedTitle = content.match(/<card\s+title=(["'])(.*?)\1/i)?.[2];
    if (renderedTitle?.trim()) return renderedTitle.trim();
    try {
      const card = JSON.parse(content);
      return firstTrimmedString(
        card?.title,
        card?.header?.title?.content,
        card?.header?.title?.i18n?.zh_cn,
        card?.header?.title?.i18n?.en_us,
      );
    } catch {
      return undefined;
    }
  }
  if (msgType === 'post') {
    try {
      const obj = JSON.parse(content);
      const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
      return firstTrimmedString(inner?.title, obj?.title);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function extractListenerMessageText(message: any): string {
  const content = listenerMessageContent(message);
  if (!content) return '';
  const msgType = messageTypeOf(message);
  if (msgType === 'interactive') return extractCardContent(content);
  if (msgType === 'image') {
    try {
      const obj = JSON.parse(content);
      const key = firstTrimmedString(obj?.image_key, obj?.img_key);
      return key ? `[图片消息: ${key}]` : '[图片消息]';
    } catch {
      return '[图片消息]';
    }
  }
  try {
    const obj = JSON.parse(content);
    if (typeof obj?.text === 'string') return obj.text.trim();
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
        }
      }
      return parts.join('').trim();
    }
  } catch {
    return '';
  }
  return '';
}

function contains(list: readonly string[] | undefined, value: string | undefined): boolean {
  return !!value && !!list && list.includes(value);
}

function senderTypeAllowed(listener: MessageListenerConfig, type: MessageListenerSenderType): boolean {
  const policy = listener.senderPolicy;
  if (policy?.includeSenderTypes && policy.includeSenderTypes.length > 0 && !policy.includeSenderTypes.includes(type)) {
    return false;
  }
  if (policy?.excludeSenderTypes?.includes(type)) return false;
  return true;
}

function senderOpenIdAllowed(listener: MessageListenerConfig, openId: string | undefined): boolean {
  const policy = listener.senderPolicy;
  const mode = policy?.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  if (mode === 'include_only') {
    return contains(policy?.includeSenderOpenIds, openId);
  }
  return !contains(policy?.excludeSenderOpenIds, openId);
}

function msgTypeAllowed(listener: MessageListenerConfig, msgType: string): boolean {
  const include = listener.messagePolicy?.includeMsgTypes;
  if (!include || include.length === 0) return msgType === 'text' || msgType === 'post';
  return include.includes(msgType);
}

export function findMessageListenerForChat(bot: BotState, chatId: string): MessageListenerConfig | undefined {
  const listener = bot.config.messageListeners?.[chatId];
  if (!listener?.enabled) return undefined;
  if (!listener.prompt?.trim()) return undefined;
  return listener;
}

export function evaluateMessageListener(input: {
  bot: BotState;
  chatId: string;
  message: any;
  senderOpenId?: string;
  senderName?: string;
  senderTypeRaw?: string;
  explicitlyMentionedThisBot: boolean;
}): MessageListenerMatch | undefined {
  if (input.explicitlyMentionedThisBot) return undefined;
  const messageId = String(input.message?.message_id ?? '');
  const rootId = input.message?.root_id ? String(input.message.root_id) : '';
  const threadId = input.message?.thread_id ? String(input.message.thread_id) : '';
  const parentId = input.message?.parent_id ? String(input.message.parent_id) : '';
  // REST history returns a top-level topic root as message_id=om_* plus
  // thread_id=omt_*. Replies carry root_id/parent_id. Do not reject the root
  // solely because thread_id uses a different id namespace.
  if ((rootId && rootId !== messageId) || (parentId && parentId !== messageId)) return undefined;
  if (threadId && threadId.startsWith('om_') && threadId !== messageId) return undefined;

  const listener = findMessageListenerForChat(input.bot, input.chatId);
  if (!listener) return undefined;

  const senderType = listenerSenderType(input.senderTypeRaw);
  if ((listener.senderPolicy?.excludeSelf ?? true) && input.senderOpenId && input.senderOpenId === input.bot.botOpenId) {
    return undefined;
  }
  if (!senderTypeAllowed(listener, senderType)) return undefined;
  if (!senderOpenIdAllowed(listener, input.senderOpenId)) return undefined;

  const msgType = messageTypeOf(input.message);
  if (!msgTypeAllowed(listener, msgType)) return undefined;

  const messageText = extractListenerMessageText(input.message);
  if (!messageText && (msgType === 'text' || msgType === 'post')) return undefined;
  const messageTitle = extractListenerMessageTitle(input.message);

  return {
    name: listener.name,
    replyCardTitle: listener.replyCardTitle,
    prompt: listener.prompt,
    workingDir: listener.workingDir,
    messageText,
    messageTitle,
    msgType,
    senderOpenId: input.senderOpenId,
    senderName: input.senderName,
    senderType,
  };
}

export function normalizeMessageListenerPreviewLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MESSAGE_LISTENER_PREVIEW_LIMIT;
  return Math.min(MAX_MESSAGE_LISTENER_PREVIEW_LIMIT, Math.max(1, Math.floor(value)));
}

export function previewMessageListenerMatches(input: {
  bot: BotState;
  chatId: string;
  messages: any[];
  limit: number;
  senderForMessage(message: any): { senderOpenId?: string; senderName?: string; senderTypeRaw?: string };
  explicitlyMentionedThisBot?: (message: any, senderOpenId?: string) => boolean;
}): MessageListenerPreviewMatch[] {
  const limit = normalizeMessageListenerPreviewLimit(input.limit);
  const matches: MessageListenerPreviewMatch[] = [];
  for (const message of input.messages) {
    const messageId = String(message?.message_id ?? '');
    if (!messageId) continue;
    const sender = input.senderForMessage(message);
    const match = evaluateMessageListener({
      bot: input.bot,
      chatId: input.chatId,
      message,
      senderOpenId: sender.senderOpenId,
      senderName: sender.senderName,
      senderTypeRaw: sender.senderTypeRaw,
      explicitlyMentionedThisBot: input.explicitlyMentionedThisBot?.(message, sender.senderOpenId) ?? false,
    });
    if (!match) continue;
    matches.push({
      ...match,
      messageId,
      createTime: message?.create_time ? String(message.create_time) : undefined,
    });
  }
  return matches.slice(Math.max(0, matches.length - limit));
}

export function renderMessageListenerPrompt(match: MessageListenerMatch): string {
  const observedText = truncateUtf8(match.messageText, MAX_MESSAGE_LISTENER_PROMPT_BYTES);
  return [
    '<message_listener>',
    match.name ? `  <name>${escapeXml(match.name)}</name>` : '',
    '  <instruction>',
    match.prompt,
    '  </instruction>',
    '  <observed_message',
    `    sender_type="${escapeXml(match.senderType)}"`,
    match.senderOpenId ? `    sender_open_id="${escapeXml(match.senderOpenId)}"` : '',
    match.senderName ? `    sender_name="${escapeXml(match.senderName)}"` : '',
    `    msg_type="${escapeXml(match.msgType)}"`,
    match.messageTitle ? `    message_title="${escapeXml(match.messageTitle)}"` : '',
    '  >',
    observedText,
    '  </observed_message>',
    '</message_listener>',
  ].filter(Boolean).join('\n');
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf-8') <= maxBytes) return s;
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
