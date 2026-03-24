import type { ImMessage, ImAttachment } from '../types.js';

export interface ILinkRawMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;  // 1=text, 2=image, 3=voice, 4=file, 5=video
  message_state: number;
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
    image_item?: { url: string; aes_key: string; file_size: number };
  }>;
}

export function parseMessage(raw: ILinkRawMessage): ImMessage {
  const textParts = raw.item_list
    .filter(item => item.type === 1 && item.text_item)
    .map(item => item.text_item!.text);

  const attachments: ImAttachment[] = raw.item_list
    .filter(item => item.type === 2 && item.image_item)
    .map((item, i) => ({
      type: 'image' as const,
      // Store CDN URL + key in path field, separated by \n — will be downloaded by daemon
      path: `${item.image_item!.url}\n${item.image_item!.aes_key}`,
      name: `image_${i}.jpg`,
    }));

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
