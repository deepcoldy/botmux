/**
 * 每接收方持久队列（design §8.3）。
 *
 * 文件按 target 分区：`{dataDir}/collab-chat-queues/{chatId}/{targetAppId}.json`。每个
 * target daemon 只读写自己的队列文件（单 writer），不同 target 共享 dataDir/chat 时物理
 * 隔离，互不覆盖。只有 ENOENT 是空队列；损坏必须 fail-closed，禁止把 pending 消息当空队列覆盖。
 */
import { mkdirSync, readFileSync } from 'node:fs';
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

export type CollabChatQueueReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupted'; message: string }
  | { kind: 'ok'; queue: CollabChatQueueFile };

export class CollabChatQueueCorruptedError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`collab chat queue corrupted at ${filePath}: ${message}`);
    this.name = 'CollabChatQueueCorruptedError';
  }
}

/** 按 target 分区：`{dataDir}/collab-chat-queues/{chatId}/{targetAppId}.json`。 */
export function collabChatQueuePath(dataDir: string, chatId: string, targetAppId: string): string {
  return join(dataDir, 'collab-chat-queues', chatId, `${targetAppId}.json`);
}

function emptyQueue(chatId: string, targetAppId: string): CollabChatQueueFile {
  return { schemaVersion: COLLAB_CHAT_QUEUE_SCHEMA_VERSION, chatId, targetAppId, items: [] };
}

function parseQueue(raw: string, chatId: string, targetAppId: string): CollabChatQueueFile {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('queue 非对象');
  const q = parsed as Partial<CollabChatQueueFile>;
  if (q.schemaVersion !== COLLAB_CHAT_QUEUE_SCHEMA_VERSION || q.chatId !== chatId
    || q.targetAppId !== targetAppId || !Array.isArray(q.items)) {
    throw new Error('queue schemaVersion/身份/items 不符');
  }
  for (const item of q.items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || typeof item.sourceMessageId !== 'string' || !item.sourceMessageId
      || item.targetAppId !== targetAppId
      || !['pending', 'delivered', 'rejected'].includes(item.deliveryStatus)
      || typeof item.enqueuedAt !== 'number' || !Number.isFinite(item.enqueuedAt)) {
      throw new Error('queue item 结构非法');
    }
  }
  return q as CollabChatQueueFile;
}

/** 严格读：只有 ENOENT 是 missing；读取、JSON、schema 或身份错误都是 corrupted。 */
export function readCollabChatQueueStrict(dataDir: string, chatId: string, targetAppId: string): CollabChatQueueReadResult {
  const fp = collabChatQueuePath(dataDir, chatId, targetAppId);
  let raw: string;
  try { raw = readFileSync(fp, 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) };
  }
  try { return { kind: 'ok', queue: parseQueue(raw, chatId, targetAppId) }; }
  catch (err) { return { kind: 'corrupted', message: err instanceof Error ? err.message : String(err) }; }
}

/** 常规读：不存在返回空队列；损坏抛错，禁止后续 mutation 覆盖旧 pending 项。 */
export function readCollabChatQueue(dataDir: string, chatId: string, targetAppId: string): CollabChatQueueFile {
  const read = readCollabChatQueueStrict(dataDir, chatId, targetAppId);
  if (read.kind === 'missing') return emptyQueue(chatId, targetAppId);
  if (read.kind === 'corrupted') throw new CollabChatQueueCorruptedError(collabChatQueuePath(dataDir, chatId, targetAppId), read.message);
  return read.queue;
}

function writeQueue(dataDir: string, queue: CollabChatQueueFile): void {
  parseQueue(JSON.stringify(queue), queue.chatId, queue.targetAppId);
  const fp = collabChatQueuePath(dataDir, queue.chatId, queue.targetAppId);
  mkdirSync(dirname(fp), { recursive: true });
  atomicWriteFileSync(fp, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600, durable: true });
}

/** 入队（按 (targetAppId, sourceMessageId) 复合键去重，返回是否新增）。 */
export function enqueueCollabChatItem(dataDir: string, chatId: string, item: CollabChatQueueItem): boolean {
  const q = readCollabChatQueue(dataDir, chatId, item.targetAppId);
  if (q.items.some(i => i.sourceMessageId === item.sourceMessageId)) return false;
  q.items.push(item);
  writeQueue(dataDir, q);
  return true;
}

/** 标记投递状态（按 (targetAppId, sourceMessageId) 去重）。 */
export function markCollabChatItemDelivered(dataDir: string, chatId: string, targetAppId: string, sourceMessageId: string, status: CollabQueueDeliveryStatus): void {
  const q = readCollabChatQueue(dataDir, chatId, targetAppId);
  const item = q.items.find(i => i.sourceMessageId === sourceMessageId);
  if (!item) return;
  item.deliveryStatus = status;
  writeQueue(dataDir, q);
}

/** gate open 后按入队时间返回仍 pending 的事件；重放不复读飞书用户消息。 */
export function listPendingCollabChatItems(dataDir: string, chatId: string, targetAppId: string): CollabChatQueueItem[] {
  const q = readCollabChatQueue(dataDir, chatId, targetAppId);
  return q.items.filter(i => i.deliveryStatus === 'pending').sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** 目标重启对账：gate 未 open 保留原队列；open 返回仍需重放的 pending 项。 */
export function reconcileCollabChatQueue(opts: {
  dataDir: string;
  chatId: string;
  targetAppId: string;
  gateOpen: boolean;
}): CollabChatQueueItem[] {
  if (!opts.gateOpen) return [];
  return listPendingCollabChatItems(opts.dataDir, opts.chatId, opts.targetAppId);
}
