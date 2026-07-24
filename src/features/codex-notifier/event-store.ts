import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { parseCodexNotifierEvent } from './event.js';
import type {
  CodexNotifierDelivery,
  CodexNotifierDeliveryStatus,
  CodexNotifierEventRecord,
  CodexTaskCompletedEvent,
} from './types.js';

const STORE_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_CODEX_NOTIFIER_EVENTS = 1000;
export const DEFAULT_MAX_CODEX_NOTIFIER_RECEIPTS = 10_000;

interface StoreFileV1 {
  schemaVersion: 1;
  records: CodexNotifierEventRecord[];
}

interface StoreFileV2 {
  schemaVersion: 2;
  records: CodexNotifierEventRecord[];
  receipts: CodexNotifierEventRecord[];
}

export interface CodexNotifierDeliveryUpdate {
  status: CodexNotifierDeliveryStatus;
  messageId?: string;
  lastError?: string;
  incrementAttempts?: boolean;
}

export interface RecordCodexNotifierEventResult {
  inserted: boolean;
  record: CodexNotifierEventRecord;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && !Number.isNaN(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function validateDelivery(value: unknown): CodexNotifierDelivery {
  if (!plainObject(value)
    || Object.keys(value).some(key => !['status', 'attempts', 'updatedAt', 'messageId', 'lastError'].includes(key))
    || !['pending', 'delivered', 'failed'].includes(String(value.status))
    || !Number.isSafeInteger(value.attempts)
    || (value.attempts as number) < 0
    || !validIsoTimestamp(value.updatedAt)
    || (value.messageId !== undefined && (typeof value.messageId !== 'string' || value.messageId.length > 256))
    || (value.lastError !== undefined && (typeof value.lastError !== 'string' || value.lastError.length > 1000))) {
    throw new Error('invalid Codex notifier delivery record');
  }
  return value as unknown as CodexNotifierDelivery;
}

function validateRecord(value: unknown): CodexNotifierEventRecord {
  if (!plainObject(value)
    || Object.keys(value).some(key => !['event', 'receivedAt', 'delivery'].includes(key))
    || !validIsoTimestamp(value.receivedAt)) {
    throw new Error('invalid Codex notifier event record');
  }
  return {
    event: parseCodexNotifierEvent(value.event),
    receivedAt: value.receivedAt,
    delivery: validateDelivery(value.delivery),
  };
}

function cloneRecord(record: CodexNotifierEventRecord): CodexNotifierEventRecord {
  return structuredClone(record);
}

function validateReceipt(value: unknown): CodexNotifierEventRecord {
  const record = validateRecord(value);
  if (record.delivery.status !== 'delivered'
    || !record.delivery.messageId?.trim()
    || record.event.finalPreview !== undefined) {
    throw new Error('invalid Codex notifier delivery receipt');
  }
  // 兼容开发期写出的 v2 receipt，并在下一次持久化时移除旧标题。
  delete record.event.title;
  return record;
}

function toDeliveryReceipt(record: CodexNotifierEventRecord): CodexNotifierEventRecord | undefined {
  if (record.delivery.status !== 'delivered' || !record.delivery.messageId?.trim()) return undefined;
  const receipt = cloneRecord(record);
  delete receipt.event.finalPreview;
  delete receipt.event.title;
  return receipt;
}

/** 单 daemon 写入的有界、原子事件账本。 */
export class CodexNotifierEventStore {
  private readonly records = new Map<string, CodexNotifierEventRecord>();
  private readonly receipts = new Map<string, CodexNotifierEventRecord>();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = DEFAULT_MAX_CODEX_NOTIFIER_EVENTS,
    private readonly maxReceipts = DEFAULT_MAX_CODEX_NOTIFIER_RECEIPTS,
  ) {
    if (!filePath.trim()) throw new Error('Codex notifier store path is required');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('Codex notifier maxEntries must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
      throw new Error('Codex notifier maxReceipts must be a positive safe integer');
    }
    this.load();
  }

  get(eventId: string): CodexNotifierEventRecord | undefined {
    const record = this.records.get(eventId) ?? this.receipts.get(eventId);
    return record ? cloneRecord(record) : undefined;
  }

  isDuplicate(eventId: string): boolean {
    return this.records.has(eventId) || this.receipts.has(eventId);
  }

  record(event: CodexTaskCompletedEvent, now = Date.now()): RecordCodexNotifierEventResult {
    const existing = this.records.get(event.eventId) ?? this.receipts.get(event.eventId);
    if (existing) return { inserted: false, record: cloneRecord(existing) };
    const timestamp = toIso(now);
    const record: CodexNotifierEventRecord = {
      event: structuredClone(event),
      receivedAt: timestamp,
      delivery: { status: 'pending', attempts: 0, updatedAt: timestamp },
    };
    this.records.set(event.eventId, record);
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.records.get(oldest);
      this.records.delete(oldest);
      if (!evicted) continue;
      const receipt = toDeliveryReceipt(evicted);
      if (!receipt) continue;
      this.receipts.set(oldest, receipt);
      while (this.receipts.size > this.maxReceipts) {
        const oldestReceipt = this.receipts.keys().next().value as string | undefined;
        if (oldestReceipt === undefined) break;
        this.receipts.delete(oldestReceipt);
      }
    }
    this.persist();
    return { inserted: true, record: cloneRecord(record) };
  }

  updateDelivery(
    eventId: string,
    update: CodexNotifierDeliveryUpdate,
    now = Date.now(),
  ): CodexNotifierEventRecord | undefined {
    const record = this.records.get(eventId);
    if (!record) return undefined;
    const next: CodexNotifierDelivery = {
      status: update.status,
      attempts: record.delivery.attempts + (update.incrementAttempts === false ? 0 : 1),
      updatedAt: toIso(now),
      ...(update.messageId ? { messageId: update.messageId.slice(0, 256) } : {}),
      ...(update.lastError ? { lastError: update.lastError.slice(0, 1000) } : {}),
    };
    record.delivery = next;
    // 更新后的记录移到末尾，使有界淘汰优先移除最久未活动的事件。
    this.records.delete(eventId);
    this.records.set(eventId, record);
    // pending 只是当前进程内的投递中状态。事件在发送前已由 record 持久化，
    // 成功或失败结果也会立即落盘；跳过这次整账本写不影响重启后的幂等重试。
    if (update.status !== 'pending') this.persist();
    return cloneRecord(record);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (cause) {
      throw new Error(`Codex notifier store is unreadable at ${this.filePath}`, { cause });
    }
    if (!plainObject(parsed)) {
      throw new Error(`Codex notifier store schema mismatch at ${this.filePath}`);
    }
    let rawRecords: unknown[];
    let rawReceipts: unknown[];
    if (parsed.schemaVersion === 1
      && Array.isArray(parsed.records)
      && parsed.records.length <= this.maxEntries
      && !Object.keys(parsed).some(key => !['schemaVersion', 'records'].includes(key))) {
      rawRecords = parsed.records;
      rawReceipts = [];
    } else if (parsed.schemaVersion === STORE_SCHEMA_VERSION
      && Array.isArray(parsed.records)
      && parsed.records.length <= this.maxEntries
      && Array.isArray(parsed.receipts)
      && parsed.receipts.length <= this.maxReceipts
      && !Object.keys(parsed).some(key => !['schemaVersion', 'records', 'receipts'].includes(key))) {
      rawRecords = parsed.records;
      rawReceipts = parsed.receipts;
    } else {
      throw new Error(`Codex notifier store schema mismatch at ${this.filePath}`);
    }
    for (const raw of rawRecords) {
      const record = validateRecord(raw);
      if (this.records.has(record.event.eventId)) {
        throw new Error(`Codex notifier store contains duplicate event ${record.event.eventId}`);
      }
      this.records.set(record.event.eventId, record);
    }
    for (const raw of rawReceipts) {
      const receipt = validateReceipt(raw);
      if (this.records.has(receipt.event.eventId) || this.receipts.has(receipt.event.eventId)) {
        throw new Error(`Codex notifier store contains duplicate event ${receipt.event.eventId}`);
      }
      this.receipts.set(receipt.event.eventId, receipt);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: StoreFileV2 = {
      schemaVersion: STORE_SCHEMA_VERSION,
      records: [...this.records.values()],
      receipts: [...this.receipts.values()],
    };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
}

function toIso(now: number): string {
  if (!Number.isFinite(now)) throw new Error('Codex notifier timestamp must be finite');
  return new Date(now).toISOString();
}
