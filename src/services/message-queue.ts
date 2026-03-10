import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
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

function getOffsetFile(rootMessageId: string): string {
  return join(getQueuesDir(), `${rootMessageId}.offset`);
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

function readOffset(rootMessageId: string): number {
  const offsetFile = getOffsetFile(rootMessageId);
  if (!existsSync(offsetFile)) return 0;
  try {
    return parseInt(readFileSync(offsetFile, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(rootMessageId: string, offset: number): void {
  writeFileSync(getOffsetFile(rootMessageId), String(offset), 'utf-8');
}

/** Reset offset to re-read all messages from a given byte position (0 = beginning). */
export function rewindOffset(rootMessageId: string, to = 0): void {
  writeOffset(rootMessageId, to);
}

/** Return the current read offset (byte position) without advancing it. */
export function getOffset(rootMessageId: string): number {
  return readOffset(rootMessageId);
}

export function readUnread(rootMessageId: string): LarkMessage[] {
  const queueFile = getQueueFile(rootMessageId);
  if (!existsSync(queueFile)) return [];

  const content = readFileSync(queueFile, 'utf-8');
  const offset = readOffset(rootMessageId);

  if (offset >= content.length) return [];

  const unread = content.slice(offset);
  const messages: LarkMessage[] = [];
  for (const line of unread.split('\n')) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        logger.warn(`MessageQueue: failed to parse line: ${line}`);
      }
    }
  }

  if (messages.length > 0) {
    writeOffset(rootMessageId, content.length);
  }

  return messages;
}
