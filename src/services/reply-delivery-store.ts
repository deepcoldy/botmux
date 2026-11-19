import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface ReplyDeliveryAttachment {
  deliveryId: string;
  index: number;
  name: string;
  type: 'file' | 'media';
  status: 'pending' | 'sent' | 'failed';
  messageId?: string;
  errorCode?: 'attachment_delivery_failed';
}
export interface ReplyDelivery {
  version: 1;
  appId: string;
  chatId: string;
  messageId: string;
  updatedAt: number;
  attachments: ReplyDeliveryAttachment[];
}
export type ReplyAttachmentOutcome = { messageId: string } | { failed: true };
const appPattern = /^cli_[A-Za-z0-9_-]+$/;
const messagePattern = /^om_[A-Za-z0-9_-]+$/;
const chatPattern = /^oc_[A-Za-z0-9_-]+$/;

/** Bucket subdirectory holding delivery index records. It is an evidence
 *  index, not a per-message attachment download, so it must not share the
 *  attachment-prune TTL (see core/attachment-prune.ts): the quoted main
 *  message stays discoverable long after the 14-day download sweep. */
export const REPLY_DELIVERY_DIRNAME = 'deliveries';

/** Hard cap on indexed attachments per main message; mirrored by the reader's
 *  record validation so a tampered oversized file fails closed. */
export const REPLY_DELIVERY_ATTACHMENT_LIMIT = 256;

/** Per-app metadata inside the existing attachment carve-out. Records contain
 * provider IDs and display names only, never bodies, credentials or local paths. */
export class ReplyDeliveryStore {
  constructor(private readonly dataDir: string) {}

  private path(appId: string, messageId: string): string {
    if (!appPattern.test(appId) || !messagePattern.test(messageId)) throw new Error('Invalid reply delivery identity');
    const id = createHash('sha256').update(messageId).digest('hex');
    return join(this.dataDir, 'attachments', appId, REPLY_DELIVERY_DIRNAME, `${id}.json`);
  }

  read(appId: string, messageId: string, chatId: string): ReplyDelivery | undefined {
    if (!chatPattern.test(chatId)) throw new Error('Invalid reply delivery chat');
    let raw: string;
    try { raw = readFileSync(this.path(appId, messageId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const value: ReplyDelivery = JSON.parse(raw);
    if (value.version !== 1 || value.appId !== appId || value.messageId !== messageId || value.chatId !== chatId
      || !Number.isFinite(value.updatedAt) || !Array.isArray(value.attachments) || value.attachments.length > REPLY_DELIVERY_ATTACHMENT_LIMIT
      || value.attachments.some(item => !item || typeof item.deliveryId !== 'string' || !/^[a-f0-9-]{36}$/.test(item.deliveryId)
        || !Number.isInteger(item.index) || item.index < 0 || typeof item.name !== 'string'
        || item.name !== basename(item.name) || /[\\\u0000-\u001f]/.test(item.name)
        || !['file', 'media'].includes(item.type) || !['pending', 'sent', 'failed'].includes(item.status)
        || (item.status === 'sent' ? !messagePattern.test(item.messageId ?? '') || item.messageId === messageId : item.messageId !== undefined)
        || (item.errorCode !== undefined && item.errorCode !== 'attachment_delivery_failed'))) {
      throw new Error('Invalid reply delivery record');
    }
    const slots = new Set<string>();
    for (const item of value.attachments) {
      const slot = JSON.stringify([item.deliveryId, item.index]);
      if (slots.has(slot)) throw new Error('Duplicate reply delivery attachment slot');
      slots.add(slot);
    }
    return { version: 1, appId, messageId, chatId, updatedAt: value.updatedAt,
      attachments: value.attachments.map(item => ({ deliveryId: item.deliveryId, index: item.index, name: item.name,
        type: item.type, status: item.status, ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.errorCode ? { errorCode: item.errorCode } : {}) })) };
  }

  private mutate(appId: string, messageId: string, chatId: string, change: (record: ReplyDelivery) => void): ReplyDelivery {
    const path = this.path(appId, messageId);
    if (!chatPattern.test(chatId)) throw new Error('Invalid reply delivery chat');
    mkdirSync(join(this.dataDir, 'attachments', appId, REPLY_DELIVERY_DIRNAME), { recursive: true, mode: 0o700 });
    return withFileLockSync(path, () => {
      const record = this.read(appId, messageId, chatId) ?? { version: 1, appId, messageId, chatId, updatedAt: Date.now(), attachments: [] };
      change(record);
      record.updatedAt = Date.now();
      atomicWriteFileSync(path, JSON.stringify(record), { mode: 0o600, durable: true, followTargetSymlink: false });
      return record;
    }, { maxWaitMs: 2000 });
  }

  begin(appId: string, messageId: string, chatId: string, files: readonly { path: string; type: 'file' | 'media' }[]): string {
    const deliveryId = randomUUID();
    this.mutate(appId, messageId, chatId, record => {
      if (record.attachments.length + files.length > REPLY_DELIVERY_ATTACHMENT_LIMIT) throw new Error('Reply delivery attachment limit exceeded');
      record.attachments.push(...files.map((file, index) => ({ deliveryId, index,
        name: basename(file.path.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'attachment',
        type: file.type, status: 'pending' as const })));
    });
    return deliveryId;
  }

  record(appId: string, messageId: string, chatId: string, deliveryId: string, index: number, outcome: ReplyAttachmentOutcome): void {
    this.mutate(appId, messageId, chatId, record => {
      const item = record.attachments.find(entry => entry.deliveryId === deliveryId && entry.index === index);
      if (!item) throw new Error('Reply delivery attachment not found');
      // A late failure cannot erase an accepted provider result.
      if (item.status === 'sent') {
        if ('messageId' in outcome && item.messageId !== outcome.messageId) throw new Error('Conflicting attachment receipt');
        return;
      }
      if ('messageId' in outcome) {
        if (!messagePattern.test(outcome.messageId) || outcome.messageId === messageId) throw new Error('Invalid attachment receipt');
        item.status = 'sent'; item.messageId = outcome.messageId; delete item.errorCode;
      } else { item.status = 'failed'; item.errorCode = 'attachment_delivery_failed'; }
    });
  }
}
