import { stampBotmuxCallbackMarkers } from './callback-button-marker.js';

/** Feishu documents a 30 KB limit for card message create/reply/PATCH.
 * Use decimal KB and include the serialized request, not just Markdown.
 * https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md */
export const TURN_REPLY_CARD_MAX_BYTES = 30_000;

export function turnReplyCardRequestBytes(cardJson: string, chatId: string): number {
  const common = {
    msg_type: 'interactive', content: stampBotmuxCallbackMarkers(cardJson),
    // TurnReplyCardStore uses brc_ followed by a 32-character digest.
    uuid: 'brc_'.padEnd(36, '0'),
  };
  // Either initial delivery envelope is larger than a subsequent PATCH.
  return Math.max(
    Buffer.byteLength(JSON.stringify({ ...common, receive_id: chatId }), 'utf8'),
    Buffer.byteLength(JSON.stringify({ ...common, reply_in_thread: true }), 'utf8'),
  );
}
