import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { LarkMessage } from '../types.js';

function getQueuesDir(): string {
  return join(config.session.dataDir, 'queues');
}

function getQueueFile(rootMessageId: string): string {
  return join(getQueuesDir(), `${rootMessageId}.jsonl`);
}

export function ensureQueue(rootMessageId: string): void {
  const dir = getQueuesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const queueFile = getQueueFile(rootMessageId);
  if (!existsSync(queueFile)) {
    writeFileSync(queueFile, '', 'utf-8');
  }
}

export function appendMessage(rootMessageId: string, message: LarkMessage): void {
  ensureQueue(rootMessageId);
  const line = JSON.stringify(message) + '\n';
  appendFileSync(getQueueFile(rootMessageId), line, 'utf-8');
  logger.debug(`MessageQueue: appended message to ${rootMessageId}`);
}

/** Read a recent authored message without scanning the whole queue. The caller
 * must already have authorized the turn. */
export function findQueuedMessage(rootMessageId: string, messageId: string, senderId: string): LarkMessage | undefined {
  if (!/^(?:om|oc)_[a-zA-Z0-9_-]+$/.test(rootMessageId)) return undefined;
  try {
    const fd = openSync(getQueueFile(rootMessageId), 'r');
    try {
      const size = fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 512 * 1024));
      const start = size - bytes.length;
      const count = readSync(fd, bytes, 0, bytes.length, start);
      const lines = bytes.subarray(0, count).toString('utf8').split('\n');
      if (start) lines.shift();
      for (const line of lines.reverse()) {
        if (!line.includes(messageId)) continue;
        try {
          const message = JSON.parse(line) as LarkMessage;
          if (message?.messageId === messageId && message.senderId === senderId) return message;
        } catch { /* A concurrent append can leave a partial line. */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* Missing queue records can be recovered from Feishu. */ }
  return undefined;
}
