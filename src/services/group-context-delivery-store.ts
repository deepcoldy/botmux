import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { LarkAttachment } from '../types.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

const RETENTION_MS = 30 * 86_400_000;
const MAX_BUNDLES = 1_000;
const MAX_PAYLOAD_BYTES = 512_000;
const MAX_INCLUDED_SEQS = 10_000;

/** Frozen input that was prepared for one turn. Sources may be excerpts;
 * coverage means provided to a completed turn, never read or understood. */

export interface PreparedGroupContext {
  appId: string;
  chatId: string;
  turnId: string;
  createdAt: number;
  body: string;
  includedSeqs: number[];
  throughSeq: number;
  incomplete: boolean;
  epoch?: string;
  /** Already authorized/downloaded historical attachments; this store does no fetching. */
  attachments?: LarkAttachment[];
}

export interface GroupContextDeliveryBinding {
  appId: string;
  chatId: string;
  turnId: string;
  sessionId: string;
  epoch: string;
}

interface StoredContext {
  app_id: string;
  chat_id: string;
  turn_id: string;
  created_at: number;
  expires_at: number;
  payload: string;
  session_id: string | null;
  epoch: string | null;
  confirmed_at: number | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS prepared_contexts (
    app_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    session_id TEXT,
    epoch TEXT,
    confirmed_at INTEGER,
    PRIMARY KEY (app_id, chat_id, turn_id),
    CHECK ((session_id IS NULL) = (epoch IS NULL)),
    CHECK (confirmed_at IS NULL OR session_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS group_context_delivery_expiry ON prepared_contexts(expires_at);
  CREATE INDEX IF NOT EXISTS group_context_delivery_consumer
    ON prepared_contexts(app_id, chat_id, session_id, epoch) WHERE confirmed_at IS NOT NULL;
`;

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024 && !value.includes('\0');
}

function validateIdentity(...values: unknown[]): void {
  if (!values.every(validIdentity)) throw new Error('Invalid group context identity');
}

function validInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function normalizePrepared(value: unknown): PreparedGroupContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid prepared group context');
  const input = value as PreparedGroupContext;
  validateIdentity(input.appId, input.chatId, input.turnId);
  if (input.epoch !== undefined) validateIdentity(input.epoch);
  if (!validInteger(input.createdAt, 0)
    || typeof input.body !== 'string' || input.body.length > 100_000
    || typeof input.incomplete !== 'boolean'
    || !validInteger(input.throughSeq, 0)
    || !Array.isArray(input.includedSeqs) || input.includedSeqs.length > MAX_INCLUDED_SEQS
    || !input.includedSeqs.every(seq => validInteger(seq, 1) && seq <= input.throughSeq)) {
    throw new Error('Invalid prepared group context fields or sequences');
  }
  let attachments: LarkAttachment[] | undefined;
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 128) {
      throw new Error('Invalid prepared group context attachments');
    }
    attachments = input.attachments.map(attachment => {
      if (!attachment || !['image', 'file'].includes(attachment.type)
        || !validIdentity(attachment.path) || typeof attachment.name !== 'string'
        || (attachment.resourceKey !== undefined && typeof attachment.resourceKey !== 'string')
        || (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string')) {
        throw new Error('Invalid prepared group context attachment');
      }
      return {
        type: attachment.type, path: attachment.path, name: attachment.name,
        ...(attachment.resourceKey !== undefined ? { resourceKey: attachment.resourceKey } : {}),
        ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
      };
    });
  }
  const prepared: PreparedGroupContext = {
    appId: input.appId, chatId: input.chatId, turnId: input.turnId,
    createdAt: input.createdAt, body: input.body,
    includedSeqs: [...new Set(input.includedSeqs)].sort((a, b) => a - b),
    throughSeq: input.throughSeq, incomplete: input.incomplete,
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Prepared group context exceeds storage limit');
  }
  return prepared;
}

function decodeRow(row: StoredContext): PreparedGroupContext {
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Invalid stored group context payload');
  }
  const prepared = normalizePrepared(JSON.parse(row.payload));
  if (prepared.appId !== row.app_id || prepared.chatId !== row.chat_id || prepared.turnId !== row.turn_id
    || !validInteger(row.created_at, 0) || row.created_at > prepared.createdAt
    || row.expires_at !== row.created_at + RETENTION_MS
    || ((row.session_id === null) !== (row.epoch === null))
    || (row.session_id !== null && (!validIdentity(row.session_id) || !validIdentity(row.epoch)))
    || (row.epoch !== null && prepared.epoch !== undefined && row.epoch !== prepared.epoch)
    || (row.confirmed_at !== null && (!validInteger(row.confirmed_at, 0) || row.session_id === null))) {
    throw new Error('Invalid stored group context identity or delivery binding');
  }
  return prepared;
}

/** SQLite serializes first-write/bind/confirm across processes. Handles are closed
 * after every operation so persisted state is authoritative after a restart.
 * Expired input and coverage are removed on every access. A 1,000-bundle cap,
 * 512 KB payload cap and bounded identities also cap retained storage. */
function withStore<T>(dataDir: string, create: boolean, operation: (db: DatabaseSyncLike, now: number) => T): T | undefined {
  const dir = join(dataDir, 'group-context-delivery');
  const path = join(dir, 'store.db');
  if (!create && !existsSync(path)) return undefined;
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = openDatabaseSyncOrThrow(path);
  let transaction = false;
  try {
    // Set timeout before the first page access, including concurrent cold starts.
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA secure_delete = ON;');
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    if (create) {
      db.exec(SCHEMA);
      chmodSync(path, 0o600);
    }
    const now = Date.now();
    db.prepare('DELETE FROM prepared_contexts WHERE expires_at <= ?').run(now);
    const result = operation(db, now);
    db.exec('COMMIT');
    transaction = false;
    return result;
  } finally {
    try {
      if (transaction) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}

function selectPrepared(db: DatabaseSyncLike, appId: string, chatId: string, turnId: string): StoredContext | undefined {
  return db.prepare('SELECT * FROM prepared_contexts WHERE app_id = ? AND chat_id = ? AND turn_id = ?')
    .get(appId, chatId, turnId) as StoredContext | undefined;
}

/** First write wins for app/chat/turn, including retries with recomputed bodies.
 * Throws on invalid data or persistence failure; callers can omit context safely. */
export function writePreparedGroupContext(input: PreparedGroupContext, dataDir: string = config.session.dataDir): PreparedGroupContext {
  const prepared = normalizePrepared(input);
  return withStore(dataDir, true, (db, now) => {
    const existing = selectPrepared(db, prepared.appId, prepared.chatId, prepared.turnId);
    if (existing) return decodeRow(existing);
    const createdAt = Math.min(prepared.createdAt, now);
    if (createdAt + RETENTION_MS <= now) throw new Error('Prepared group context has expired');
    db.prepare(`INSERT INTO prepared_contexts (app_id, chat_id, turn_id, created_at, expires_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      prepared.appId, prepared.chatId, prepared.turnId, createdAt, createdAt + RETENTION_MS, JSON.stringify(prepared),
    );
    // Late turns do not displace newer bundles. Ties are deterministic by identity.
    db.prepare(`DELETE FROM prepared_contexts WHERE rowid IN (
      SELECT rowid FROM prepared_contexts ORDER BY created_at DESC, app_id, chat_id, turn_id LIMIT -1 OFFSET ?
    )`).run(MAX_BUNDLES);
    if (!selectPrepared(db, prepared.appId, prepared.chatId, prepared.turnId)) {
      throw new Error('Prepared group context is older than the storage retention limit');
    }
    return prepared;
  })!;
}

export function readPreparedGroupContext(appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir): PreparedGroupContext | undefined {
  try {
    validateIdentity(appId, chatId, turnId);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, appId, chatId, turnId);
      return row ? decodeRow(row) : undefined;
    });
  } catch {
    return undefined;
  }
}

/** Associate the frozen bundle with its actual consumer before CLI input.
 * Binding never covers sources. A conflicting retry cannot change the consumer. */
export function bindGroupContextDelivery(input: GroupContextDeliveryBinding, dataDir: string = config.session.dataDir): void {
  validateIdentity(input.appId, input.chatId, input.turnId, input.sessionId, input.epoch);
  const bound = withStore(dataDir, false, db => {
    const row = selectPrepared(db, input.appId, input.chatId, input.turnId);
    if (!row) throw new Error('Prepared group context is missing');
    const prepared = decodeRow(row);
    if (prepared.epoch !== undefined && prepared.epoch !== input.epoch) {
      throw new Error('Prepared group context epoch does not match consumer');
    }
    if (row.session_id !== null) {
      if (row.session_id !== input.sessionId || row.epoch !== input.epoch) {
        throw new Error('Group context is already bound to another consumer');
      }
      return true;
    }
    db.prepare('UPDATE prepared_contexts SET session_id = ?, epoch = ? WHERE app_id = ? AND chat_id = ? AND turn_id = ?')
      .run(input.sessionId, input.epoch, input.appId, input.chatId, input.turnId);
    return true;
  });
  if (!bound) throw new Error('Prepared group context is missing');
}

export function readGroupContextDeliveryBinding(appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir): GroupContextDeliveryBinding | undefined {
  try {
    validateIdentity(appId, chatId, turnId);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, appId, chatId, turnId);
      if (!row) return undefined;
      decodeRow(row);
      if (row.session_id === null || row.epoch === null) return undefined;
      return { appId, chatId, turnId, sessionId: row.session_id, epoch: row.epoch };
    });
  } catch {
    return undefined;
  }
}

/** Call only after reliable evidence that this exact consumer turn completed.
 * Returns true for a matching confirmation, including an identical retry.
 * Missing, corrupt, expired or differently bound input fails closed. */
export function confirmGroupContextDelivery(input: GroupContextDeliveryBinding, dataDir: string = config.session.dataDir): boolean {
  try {
    validateIdentity(input.appId, input.chatId, input.turnId, input.sessionId, input.epoch);
    return withStore(dataDir, false, (db, now) => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId);
      if (!row) return false;
      decodeRow(row);
      if (row.session_id !== input.sessionId || row.epoch !== input.epoch) return false;
      if (row.confirmed_at === null) {
        db.prepare(`UPDATE prepared_contexts SET confirmed_at = ?
          WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND session_id = ? AND epoch = ?`)
          .run(now, input.appId, input.chatId, input.turnId, input.sessionId, input.epoch);
      }
      return true;
    }) ?? false;
  } catch {
    return false;
  }
}

/** Exact covered source identities for one native session epoch. throughSeq is
 * metadata only: it must never become a cursor that silently skips source holes. */
export function getDeliveredGroupContextSeqs(appId: string, chatId: string, sessionId: string, epoch: string, dataDir: string = config.session.dataDir): number[] {
  try {
    validateIdentity(appId, chatId, sessionId, epoch);
    return withStore(dataDir, false, db => {
      const rows = db.prepare(`SELECT * FROM prepared_contexts
        WHERE app_id = ? AND chat_id = ? AND session_id = ? AND epoch = ? AND confirmed_at IS NOT NULL`)
        .all(appId, chatId, sessionId, epoch) as StoredContext[];
      return [...new Set(rows.flatMap(row => decodeRow(row).includedSeqs))].sort((a, b) => a - b);
    }) ?? [];
  } catch {
    return [];
  }
}
