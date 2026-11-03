import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
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
