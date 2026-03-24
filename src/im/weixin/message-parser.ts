import type { ImMessage, ImAttachment } from '../types.js';

const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface ILinkRawMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;  // 1=text, 2=image, 3=voice, 4=file, 5=video
  message_state: number;
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
    image_item?: {
      media?: CDNMedia;
      thumb_media?: CDNMedia;
      aeskey?: string;       // hex string (16 raw bytes)
      url?: string;          // sometimes a direct URL, sometimes empty
      mid_size?: number;
      hd_size?: number;
    };
  }>;
}

/** Resolve AES key from image_item: try media.aes_key (base64), then aeskey (hex→base64) */
function resolveImageAesKey(img: NonNullable<ILinkRawMessage['item_list'][0]['image_item']>): string | undefined {
  // Prefer media.aes_key (already base64)
  if (img.media?.aes_key) return img.media.aes_key;
  // Fallback: aeskey is hex-encoded 16 bytes → convert to base64
  if (img.aeskey && img.aeskey.length === 32) {
    return Buffer.from(img.aeskey, 'hex').toString('base64');
  }
  return undefined;
}

/** Build CDN download URL from encrypt_query_param */
function buildCdnDownloadUrl(encryptQueryParam: string): string {
  return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export function parseMessage(raw: ILinkRawMessage): ImMessage {
  const textParts = raw.item_list
    .filter(item => item.type === 1 && item.text_item)
    .map(item => item.text_item!.text);

  const attachments: ImAttachment[] = [];
  for (let i = 0; i < raw.item_list.length; i++) {
    const item = raw.item_list[i];
    if (item.type !== 2 || !item.image_item) continue;
    const img = item.image_item;
    const encryptParam = img.media?.encrypt_query_param;
    const aesKey = resolveImageAesKey(img);
    if (encryptParam && aesKey) {
      // Store CDN URL + base64 key separated by \n — downloaded by poller
      const cdnUrl = buildCdnDownloadUrl(encryptParam);
      attachments.push({
        type: 'image',
        path: `${cdnUrl}\n${aesKey}`,
        name: `image_${i}.jpg`,
      });
    }
  }

  return {
    id: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId: raw.from_user_id,
    senderId: raw.from_user_id,
    senderType: 'user',
    content: textParts.join('\n'),
    msgType: raw.message_type === 1 ? 'text' : `media_${raw.message_type}`,
    createTime: new Date().toISOString(),
    ...(attachments.length > 0 && { attachments }),
  };
}

export function isTextMessage(raw: ILinkRawMessage): boolean {
  return raw.message_type === 1;
}
