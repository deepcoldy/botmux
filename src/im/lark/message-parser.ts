import type { LarkMessage, LarkMention } from './types.js';
import { logger } from '../../utils/logger.js';

// Event data structure from WSClient im.message.receive_v1
// sender is at data top-level, NOT inside data.message
interface RawEventData {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    message_type: string; // NOT msg_type
    content: string;
    chat_id: string;
    chat_type: string;
    create_time: string;
    mentions?: Array<{
      key: string;       // e.g. "@_user_1"
      name: string;      // display name
      id?: { open_id?: string; user_id?: string; union_id?: string };
      tenant_key?: string;
    }>;
  };
}

export interface MessageResource {
  type: 'image' | 'file';
  key: string;
  name: string;
}

export function extractResources(msgType: string, rawContent: string): MessageResource[] {
  try {
    const parsed = JSON.parse(rawContent);

    if (msgType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return [{ type: 'image', key: imageKey, name: `${imageKey}.jpg` }];
      }
    }

    if (msgType === 'file') {
      const fileKey = parsed.file_key;
      if (fileKey) {
        return [{ type: 'file', key: fileKey, name: parsed.file_name ?? fileKey }];
      }
    }

    if (msgType === 'post') {
      const resources: MessageResource[] = [];
      const { content: contentBlocks } = resolvePostBody(parsed);
      for (const block of contentBlocks) {
        const nodes = Array.isArray(block) ? block : [block];
        for (const node of nodes) {
          if (node.tag === 'img' && node.image_key) {
            resources.push({ type: 'image', key: node.image_key, name: `${node.image_key}.jpg` });
          }
        }
      }
      return resources;
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

export function parseEventMessage(data: RawEventData): { parsed: LarkMessage; resources: MessageResource[] } {
  const { sender, message } = data;

  // Debug: log raw message for non-text types
  if (message.message_type !== 'text') {
    logger.info(`[parser] type=${message.message_type} content=${message.content} keys=${Object.keys(message).join(',')}`);
  }

  const resources = extractResources(message.message_type, message.content);

  // Extract structured mentions
  const mentions: LarkMention[] | undefined =
    message.mentions && message.mentions.length > 0
      ? message.mentions.map(m => ({
          key: m.key,
          name: m.name,
          openId: m.id?.open_id,
        }))
      : undefined;

  const parsed: LarkMessage = {
    messageId: message.message_id,
    rootId: message.root_id ?? '',
    senderId: sender.sender_id?.open_id ?? '',
    senderType: sender.sender_type,
    msgType: message.message_type,
    content: extractTextContent(message.message_type, message.content, message.mentions),
    createTime: message.create_time,
    mentions,
  };
  return { parsed, resources };
}

export function parseApiMessage(msg: any): LarkMessage {
  return {
    messageId: msg.message_id ?? '',
    rootId: msg.root_id ?? msg.thread_id ?? '',
    senderId: msg.sender?.id ?? '',
    senderType: msg.sender?.sender_type ?? 'unknown',
    msgType: msg.msg_type ?? 'text',
    content: extractTextContent(msg.msg_type ?? 'text', msg.body?.content ?? ''),
    createTime: msg.create_time ?? '',
  };
}

/** Resolve post body from either wrapped {"zh_cn":{title,content}} or unwrapped {title,content} format */
function resolvePostBody(parsed: any): { title: string; content: any[] } {
  // Unwrapped: has content array directly
  if (Array.isArray(parsed.content)) {
    return { title: parsed.title ?? '', content: parsed.content };
  }
  // Wrapped in language key: {"zh_cn": {title, content}}
  for (const key of Object.keys(parsed)) {
    const val = parsed[key];
    if (val && typeof val === 'object' && Array.isArray(val.content)) {
      return { title: val.title ?? '', content: val.content };
    }
  }
  return { title: '', content: [] };
}

function resolveMentions(text: string, mentions?: RawEventData['message']['mentions']): string {
  if (!mentions || mentions.length === 0) {
    // No mention info available — strip placeholders
    return text.replace(/@_user_\d+/g, '').replace(/[^\S\r\n]{2,}/g, ' ').trim();
  }
  let result = text;
  for (const m of mentions) {
    result = result.replace(m.key, `@${m.name}`);
  }
  return result.trim();
}

function extractTextContent(msgType: string, rawContent: string, mentions?: RawEventData['message']['mentions']): string {
  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(rawContent);
      return resolveMentions(parsed.text ?? rawContent, mentions);
    }
    if (msgType === 'post') {
      const parsed = JSON.parse(rawContent);
      const { title, content } = resolvePostBody(parsed);
      const body = content
        .map((paragraph: any[]) => {
          const nodes = Array.isArray(paragraph) ? paragraph : [paragraph];
          return nodes
            .filter((node: any) => node.tag === 'text' || node.tag === 'a' || node.tag === 'at')
            .map((node: any) => {
              if (node.tag === 'at') return `@${node.user_name ?? 'unknown'}`;
              return node.text ?? node.href ?? '';
            })
            .join('');
        })
        .filter(Boolean)
        .join('\n');
      return title ? `${title}\n${body}` : body;
    }
    if (msgType === 'image') {
      return '[图片]';
    }
    if (msgType === 'file') {
      try {
        const p = JSON.parse(rawContent);
        return `[文件: ${p.file_name ?? 'unknown'}]`;
      } catch {
        return '[文件]';
      }
    }
    if (msgType === 'interactive') {
      return '[interactive card]';
    }
    return rawContent;
  } catch {
    return rawContent;
  }
}
