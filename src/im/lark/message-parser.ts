import type { LarkMessage, LarkMention } from '../../types.js';
import { getMessageDetail } from './client.js';
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

/**
 * When the WebSocket event delivers message_type "nonsupport", call the REST API
 * to fetch the real message content and patch the event data in-place.
 *
 * Also handles `interactive`: the WebSocket event only carries a simplified
 * fallback view of cards (often literally "请升级至最新版本客户端，以查看内容"),
 * so we fetch the real card JSON (including v2 `body.elements`) via REST.
 */
export async function resolveNonsupportMessage(data: RawEventData, larkAppId: string): Promise<void> {
  const type = data.message.message_type;
  if (type !== 'nonsupport' && type !== 'interactive') return;

  // For interactive fallbacks, the WS payload often embeds the full v2 card JSON
  // inside a `user_dsl` string. Unwrap it locally — no REST call needed, and it
  // works even cross-tenant where im.message.get is denied.
  if (type === 'interactive') {
    if (unwrapUserDsl(data)) return;
    // No user_dsl — only fetch when the content looks like a fallback.
    if (!isCardFallback(data.message.content)) return;
  }

  try {
    const detail = await getMessageDetail(larkAppId, data.message.message_id);
    const msg = detail?.items?.[0];
    if (!msg) return;

    const realType = msg.msg_type;
    const realContent = msg.body?.content;
    if (realType && realContent) {
      logger.info(`[parser] Resolved ${type} → ${realType} for ${data.message.message_id}`);
      data.message.message_type = realType;
      data.message.content = realContent;
    }
  } catch (err) {
    logger.debug(`[parser] Failed to resolve ${type} message ${data.message.message_id}: ${err}`);
  }
}

/**
 * Lark bundles the real v2 card JSON inside a `user_dsl` string on the
 * simplified WS payload. When present, replace content with the unwrapped
 * v2 body so downstream extractors see schema/body.elements directly.
 * Returns true when unwrap succeeded.
 */
function unwrapUserDsl(data: RawEventData): boolean {
  try {
    const outer = JSON.parse(data.message.content);
    if (typeof outer?.user_dsl !== 'string') return false;
    const inner = JSON.parse(outer.user_dsl);
    if (!inner || typeof inner !== 'object') return false;
    if (!inner.body && !inner.elements && !inner.header) return false;
    data.message.content = JSON.stringify(inner);
    logger.info(`[parser] Unwrapped user_dsl for ${data.message.message_id}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether an interactive message's WS content is the simplified
 * "upgrade your client" fallback rather than the real card body.
 */
function isCardFallback(rawContent: string): boolean {
  if (rawContent.includes('请升级至最新版本客户端')) return true;
  try {
    const c = JSON.parse(rawContent);
    // Real v2 cards have schema/body; v1 card JSON usually has header/config.
    // The fallback has only {title, elements:[[...]]} with no schema/header/config.
    const hasRealStructure = c.schema || c.body || c.header || c.config;
    return !hasRealStructure;
  } catch {
    return false;
  }
}

export interface MessageResource {
  type: 'image' | 'file';
  key: string;
  name: string;
  /** When set, download uses this message_id instead of the parent (e.g. merge_forward sub-messages). */
  messageId?: string;
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

    if (msgType === 'interactive') {
      const resources: MessageResource[] = [];
      // v2 cards nest elements under `body`; fall back to legacy top-level.
      const rootElements = Array.isArray(parsed.body?.elements)
        ? parsed.body.elements
        : Array.isArray(parsed.elements) ? parsed.elements : null;
      if (rootElements) {
        const isApiFormat = rootElements.length > 0 && Array.isArray(rootElements[0]);
        if (isApiFormat) {
          // Format A: [[{tag:"img",image_key:"..."}, ...], ...]
          for (const block of rootElements) {
            if (!Array.isArray(block)) continue;
            for (const node of block) {
              const key = node.image_key ?? node.img_key;
              if ((node.tag === 'img' || node.tag === 'image') && key) {
                resources.push({ type: 'image', key, name: `${key}.jpg` });
              }
            }
          }
        } else {
          for (const el of rootElements) {
            extractElementImages(el, resources);
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
      return extractCardContent(rawContent);
    }
    if (msgType === 'merge_forward') {
      return '[合并转发消息]';
    }
    return rawContent;
  } catch {
    return rawContent;
  }
}

/**
 * Extract human-readable text from an interactive card.
 *
 * Lark API returns card content in a **simplified format** (not the original card JSON):
 *   { title: "...", elements: [[{tag:"text",text:"..."}, ...], ...] }
 * This is similar to post message body.  We also handle the original card JSON
 * (header/config/elements with tag objects) for locally-cached cards.
 */
function extractCardContent(rawContent: string): string {
  try {
    const card = JSON.parse(rawContent);

    // Template-based card — no inline content to extract
    if (card.type === 'template') {
      return '[卡片 (模板)]';
    }

    const parts: string[] = [];

    // --- Format A: Lark API simplified format ---
    // { title: "...", elements: [[{tag,text}, ...], ...] }
    const title = card.title ?? card.header?.title?.content;
    if (title) parts.push(`[卡片: ${title}]`);
    else parts.push('[卡片]');

    // v2 cards nest elements under `body`; fall back to legacy top-level.
    const rootElements = Array.isArray(card.body?.elements)
      ? card.body.elements
      : Array.isArray(card.elements) ? card.elements : null;

    // Shared counter so inline image placeholders align with the ordered
    // attachment list produced by extractResources (same traversal order).
    const imgCounter = { n: 0 };

    if (rootElements) {
      const isApiFormat = rootElements.length > 0 && Array.isArray(rootElements[0]);

      if (isApiFormat) {
        // Format A: [[{tag:"text",text:"..."}, {tag:"img",...}, {tag:"button",...}], ...]
        for (const paragraph of rootElements) {
          if (!Array.isArray(paragraph)) continue;
          const textNodes: string[] = [];
          const buttons: string[] = [];
          for (const node of paragraph) {
            if (node.tag === 'text') { if (node.text) textNodes.push(node.text); }
            else if (node.tag === 'a') textNodes.push(node.text ?? node.href ?? '');
            else if (node.tag === 'at') textNodes.push(`@${node.user_name ?? 'unknown'}`);
            else if (node.tag === 'img' || node.tag === 'image') {
              if (node.image_key ?? node.img_key) textNodes.push(`[图片 ${++imgCounter.n}]`);
            }
            else if (node.tag === 'button') {
              const btnText = typeof node.text === 'string' ? node.text : node.text?.content;
              if (btnText) buttons.push(`[${btnText}]`);
            }
          }
          const line = textNodes.join('').trim();
          if (line) parts.push(line);
          if (buttons.length) parts.push(buttons.join(' '));
        }
      } else {
        for (const el of rootElements) {
          extractElementText(el, parts, imgCounter);
        }
      }
    }

    return parts.join('\n') || '[卡片]';
  } catch {
    return '[卡片]';
  }
}

/** Recursively extract image resources from an original-format card element. */
function extractElementImages(el: any, resources: MessageResource[]): void {
  if (!el || typeof el !== 'object') return;

  const tag = el.tag;
  const key = el.image_key ?? el.img_key;
  if ((tag === 'img' || tag === 'image') && key) {
    resources.push({ type: 'image', key, name: `${key}.jpg` });
  }

  // div.extra can contain an image
  if (el.extra) extractElementImages(el.extra, resources);

  // column_set / column — recurse into nested elements
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (Array.isArray(col.elements)) {
        for (const child of col.elements) extractElementImages(child, resources);
      }
    }
  }
  if (Array.isArray(el.elements)) {
    for (const child of el.elements) extractElementImages(child, resources);
  }
}

/** Recursively extract readable text from an original-format card element. */
function extractElementText(el: any, parts: string[], imgCounter: { n: number }): void {
  if (!el || typeof el !== 'object') return;

  const tag = el.tag;

  // div / markdown / plain_text blocks
  if (tag === 'div' || tag === 'markdown' || tag === 'plain_text') {
    const text = el.text?.content ?? el.content;
    if (text) parts.push(text);
  }

  // button — text may be a plain_text object (v2) or a string (v1 simplified).
  if (tag === 'button') {
    const btnText = typeof el.text === 'string' ? el.text : el.text?.content;
    if (btnText) parts.push(`[${btnText}]`);
  }

  // image — emit a numbered placeholder matching the attachment list order.
  if (tag === 'img' || tag === 'image') {
    if (el.image_key ?? el.img_key) parts.push(`[图片 ${++imgCounter.n}]`);
  }

  // note blocks (v1 only — v2 removed the tag but we still parse v1 cards)
  if (tag === 'note' && Array.isArray(el.elements)) {
    const noteTexts = el.elements
      .map((n: any) => n.content ?? n.text?.content ?? '')
      .filter(Boolean);
    if (noteTexts.length) parts.push(noteTexts.join(' '));
  }

  // div.extra can host an image
  if (el.extra) extractElementText(el.extra, parts, imgCounter);

  // column_set / column — recurse into nested elements
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (Array.isArray(col.elements)) {
        for (const child of col.elements) extractElementText(child, parts, imgCounter);
      }
    }
  }
  if (Array.isArray(el.elements) && tag !== 'note') {
    for (const child of el.elements) extractElementText(child, parts, imgCounter);
  }
}
