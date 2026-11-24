/**
 * 每接收方持久队列骨架（design 2026-11-20-dm-collab-group §8.3）。
 *
 * 文件 `{dataDir}/collab-chat-queues/{chatId}.json`：gate 未 open 时，目标 daemon 把
 * 规范化路由事件按 sourceMessageId 入队（同 sourceMessageId 去重）；gate open 后按
 * sourceMessageId 顺序重放进正常准入，不重发飞书用户消息。单 writer（目标 daemon）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type CollabQueueDeliveryStatus = 'pending' | 'delivered' | 'rejected';

export interface CollabChatQueueItem {
  sourceMessageId: string;
  targetAppId: string;
  routingEvent: unknown;
  deliveryStatus: CollabQueueDeliveryStatus;
  enqueuedAt: number;
}

export interface CollabChatQueueFile {
  schemaVersion: number;
  chatId: string;
  items: CollabChatQueueItem[];
}

export const COLLAB_CHAT_QUEUE_SCHEMA_VERSION = 1;

export function collabChatQueuePath(dataDir: string, chatId: string): string {
  return join(dataDir, 'collab-chat-queues', `${chatId}.json`);
}

export function readCollabChatQueue(dataDir: string, chatId: string): CollabChatQueueFile {
  const fp = collabChatQueuePath(dataDir, chatId);
  if (!existsSync(fp)) return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, items: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, items: [] };
    }
    const raw = parsed as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items as CollabChatQueueItem[] : [];
    return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, items };
  } catch {
    return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, items: [] };
  }
}

/** 入队（同 sourceMessageId 去重，返回是否新增）。 */
export function enqueueCollabChatItem(dataDir: string, chatId: string, item: CollabChatQueueItem): boolean {
  const q = readCollabChatQueue(dataDir, chatId);
  if (q.items.some(i => i.sourceMessageId === item.sourceMessageId)) return false;
  q.items.push(item);
  const fp = collabChatQueuePath(dataDir, chatId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600, durable: true });
  return true;
}

/** 标记投递状态（同 sourceMessageId 去重）。 */
export function markCollabChatItemDelivered(dataDir: string, chatId: string, sourceMessageId: string, status: CollabQueueDeliveryStatus): void {
  const q = readCollabChatQueue(dataDir, chatId);
  const item = q.items.find(i => i.sourceMessageId === sourceMessageId);
  if (!item) return;
  item.deliveryStatus = status;
  const fp = collabChatQueuePath(dataDir, chatId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600, durable: true });
}
