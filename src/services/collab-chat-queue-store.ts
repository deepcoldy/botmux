/**
 * 每接收方持久队列（design 2026-11-20-dm-collab-group §8.3）。
 *
 * 文件按 target 分区：`{dataDir}/collab-chat-queues/{chatId}/{targetAppId}.json`。每个
 * target daemon 只读写自己的队列文件（单 writer），不同 target 共享 dataDir/chat 时物理
 * 隔离，互不覆盖（N1）。gate 未 open 时，目标 daemon 把规范化路由事件按
 * (targetAppId, sourceMessageId) 复合键入队；gate open 后按序重放进正常准入，不重发
 * 飞书用户消息。
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
  targetAppId: string;
  items: CollabChatQueueItem[];
}

export const COLLAB_CHAT_QUEUE_SCHEMA_VERSION = 1;

/** 按 target 分区：`{dataDir}/collab-chat-queues/{chatId}/{targetAppId}.json`。 */
export function collabChatQueuePath(dataDir: string, chatId: string, targetAppId: string): string {
  return join(dataDir, 'collab-chat-queues', chatId, `${targetAppId}.json`);
}

/** 读取某 target 的队列（不存在/损坏返回空）。 */
export function readCollabChatQueue(dataDir: string, chatId: string, targetAppId: string): CollabChatQueueFile {
  const fp = collabChatQueuePath(dataDir, chatId, targetAppId);
  const empty = { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, targetAppId, items: [] as CollabChatQueueItem[] };
  if (!existsSync(fp)) return empty;
  try {
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const raw = parsed as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items as CollabChatQueueItem[] : [];
    return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, targetAppId, items };
  } catch {
    return empty;
  }
}

/**
 * 入队（按 (targetAppId, sourceMessageId) 复合键去重，返回是否新增）。
 * 单 writer：一个 target 队列只有一个 writer（该 target daemon），RMW 无需跨进程锁。
 */
export function enqueueCollabChatItem(dataDir: string, chatId: string, item: CollabChatQueueItem): boolean {
  const q = readCollabChatQueue(dataDir, chatId, item.targetAppId);
  if (q.items.some(i => i.sourceMessageId === item.sourceMessageId)) return false;
  q.items.push(item);
  const fp = collabChatQueuePath(dataDir, chatId, item.targetAppId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600, durable: true });
  return true;
}

/** 标记投递状态（按 (targetAppId, sourceMessageId) 去重）。 */
export function markCollabChatItemDelivered(dataDir: string, chatId: string, targetAppId: string, sourceMessageId: string, status: CollabQueueDeliveryStatus): void {
  const q = readCollabChatQueue(dataDir, chatId, targetAppId);
  const item = q.items.find(i => i.sourceMessageId === sourceMessageId);
  if (!item) return;
  item.deliveryStatus = status;
  const fp = collabChatQueuePath(dataDir, chatId, targetAppId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600, durable: true });
}
