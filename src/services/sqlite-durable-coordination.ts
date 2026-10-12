import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import type {
  AcquireSessionLeaseInput,
  BeginControlOperationAttemptInput,
  BeginControlOperationAttemptResult,
  BeginOutboxAttemptInput,
  BeginOutboxAttemptResult,
  ClaimInboxInput,
  CompleteControlOperationAttemptInput,
  CompleteOutboxAttemptInput,
  ControlOperationAttempt,
  ControlOperationMutationResult,
  DurableCoordinationStore,
  DurableControlOperationRecord,
  DurableInboxEvent,
  DurableInsertResult,
  DurableJson,
  DurableOutboxRecord,
  DurableSessionRecord,
  EnqueueControlOperationInput,
  EnqueueOutboxInput,
  InboxClaim,
  InboxClaimMutationResult,
  LeaseMutationResult,
  MarkControlOperationAmbiguousInput,
  MarkOutboxAmbiguousInput,
  OutboxAttempt,
  OutboxMutationResult,
  OutboxReservation,
  ReconcileControlOperationInput,
  ReconcileControlOperationResult,
  RenewInboxClaimInput,
  RenewSessionLeaseInput,
  ReserveOutboxInput,
  RetryControlOperationAttemptInput,
  RetryInboxClaimInput,
  RetryOutboxAttemptInput,
  SessionLease,
  SessionLeaseAcquisition,
  WriteSessionInput,
  WriteSessionResult,
} from './durable-coordination.js';
import { DURABLE_INBOX_LANE_LARK_MESSAGE } from './durable-coordination.js';

export const SQLITE_DURABLE_COORDINATION_SCHEMA_VERSION = 3;

export interface SqliteDurableCoordinationOptions {
  /** 测试 seam；生产默认使用当前进程时钟。 */
  now?: () => number;
}

export const SQLITE_DURABLE_COORDINATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS durable_coordination_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_session_leases (
  session_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch >= 1),
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_sessions (
  session_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_inbox (
  event_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL DEFAULT 'lark-message',
  partition_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'claimed', 'completed')),
  visible_at INTEGER NOT NULL,
  claim_owner TEXT,
  claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK(claim_epoch >= 0),
  claim_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS durable_inbox_claim_idx
  ON durable_inbox(state, visible_at, created_at, event_id);
CREATE INDEX IF NOT EXISTS durable_inbox_partition_claim_idx
  ON durable_inbox(partition_key, state, claim_until);
CREATE TABLE IF NOT EXISTS durable_inbox_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO durable_inbox_order(event_id)
  SELECT event_id FROM durable_inbox ORDER BY created_at, event_id;

CREATE TABLE IF NOT EXISTS durable_outbox (
  message_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  origin_epoch INTEGER NOT NULL CHECK(origin_epoch >= 1),
  state TEXT NOT NULL CHECK(state IN (
    'pending', 'reserved', 'attempting', 'ambiguous', 'delivered'
  )),
  visible_at INTEGER NOT NULL,
  claim_owner TEXT,
  claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK(claim_epoch >= 0),
  claim_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  receipt_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_outbox_claim_idx
  ON durable_outbox(state, visible_at, created_at, message_id);
CREATE TABLE IF NOT EXISTS durable_outbox_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO durable_outbox_order(message_id)
  SELECT message_id FROM durable_outbox ORDER BY created_at, message_id;

CREATE TABLE IF NOT EXISTS durable_control_operations (
  operation_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  origin_epoch INTEGER NOT NULL CHECK(origin_epoch >= 1),
  state TEXT NOT NULL CHECK(state IN ('pending', 'attempting', 'ambiguous', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  attempt_owner TEXT,
  attempt_epoch INTEGER CHECK(attempt_epoch IS NULL OR attempt_epoch >= 1),
  result_json TEXT,
  reconciliation_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_control_session_state_idx
  ON durable_control_operations(session_key, state, created_at, operation_id);
`;

type LeaseRow = {
  session_key: string;
  owner_id: string;
  epoch: number;
  lease_until: number;
};

type SessionRow = {
  session_key: string;
  revision: number;
  value_json: string;
  updated_at: number;
};

type InboxRow = {
  event_id: string;
  lane: string;
  partition_key: string;
  payload_json: string;
  visible_at: number;
  claim_owner: string | null;
  claim_epoch: number;
  claim_until: number | null;
  attempts: number;
  created_at: number;
};

type OutboxRow = {
  message_id: string;
  session_key: string;
  payload_json: string;
  origin_epoch: number;
  state: DurableOutboxRecord['state'];
  visible_at: number;
  claim_owner: string | null;
  claim_epoch: number;
  claim_until: number | null;
  attempts: number;
  receipt_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type ControlOperationRow = {
  operation_id: string;
  session_key: string;
  payload_json: string;
  origin_epoch: number;
  state: DurableControlOperationRecord['state'];
  attempts: number;
  attempt_owner: string | null;
  attempt_epoch: number | null;
  result_json: string | null;
  reconciliation_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

function nonempty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
  return value;
}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('leaseDurationMs must be a positive safe integer');
  return value;
}

function leaseUntil(now: number, leaseDurationMs: number): number {
  timestamp(now, 'now');
  duration(leaseDurationMs);
  const result = now + leaseDurationMs;
  if (!Number.isSafeInteger(result)) throw new Error('lease deadline exceeds the safe integer range');
  return result;
}

function encoded(value: DurableJson): { json: string; hash: string } {
  const json = canonicalJson(value);
  return {
    json,
    hash: `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`,
  };
}

function parseJson(value: string): DurableJson {
  return JSON.parse(value) as DurableJson;
}

function sessionLease(row: LeaseRow): SessionLease {
  return {
    sessionKey: row.session_key,
    ownerId: row.owner_id,
    epoch: Number(row.epoch),
    leaseUntil: Number(row.lease_until),
  };
}

function sessionRecord(row: SessionRow): DurableSessionRecord {
  return {
    sessionKey: row.session_key,
    revision: Number(row.revision),
    value: parseJson(row.value_json),
    updatedAt: Number(row.updated_at),
  };
}

function inboxClaim(row: InboxRow): InboxClaim {
  if (!row.claim_owner || row.claim_until === null) throw new Error(`claimed inbox row ${row.event_id} has no owner/deadline`);
  return {
    event: {
      eventId: row.event_id,
      lane: row.lane,
      partitionKey: row.partition_key,
      payload: parseJson(row.payload_json),
      visibleAt: Number(row.visible_at),
      createdAt: Number(row.created_at),
    },
    workerId: row.claim_owner,
    claimEpoch: Number(row.claim_epoch),
    claimUntil: Number(row.claim_until),
    attempts: Number(row.attempts),
  };
}

function outboxRecord(row: OutboxRow): DurableOutboxRecord {
  return {
    messageId: row.message_id,
    sessionKey: row.session_key,
    payload: parseJson(row.payload_json),
    visibleAt: Number(row.visible_at),
    createdAt: Number(row.created_at),
    state: row.state,
    originEpoch: Number(row.origin_epoch),
    attempts: Number(row.attempts),
    ...(row.receipt_json !== null ? { receipt: parseJson(row.receipt_json) } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    updatedAt: Number(row.updated_at),
  };
}

function controlOperationRecord(row: ControlOperationRow): DurableControlOperationRecord {
  return {
    operationId: row.operation_id,
    sessionKey: row.session_key,
    payload: parseJson(row.payload_json),
    createdAt: Number(row.created_at),
    state: row.state,
    originEpoch: Number(row.origin_epoch),
    attempts: Number(row.attempts),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.reconciliation_json !== null
      ? { reconciliation: parseJson(row.reconciliation_json) }
      : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 本地参考实现。它使用异步合同包裹同步 SQLite 事务，从而让调用方与远程数据库实现
 * 共用同一套接口；现有 BotMux 单机路径在显式接线前不会改变。
 */
export class SqliteDurableCoordinationStore implements DurableCoordinationStore {
  private readonly db: DatabaseSyncLike;
  private readonly clock: () => number;

  constructor(path: string, options: SqliteDurableCoordinationOptions = {}) {
    nonempty(path, 'path');
    this.clock = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabaseSyncOrThrow(path);
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SQLITE_DURABLE_COORDINATION_SCHEMA_SQL);
    const existing = this.db.prepare(
      'SELECT schema_version FROM durable_coordination_meta WHERE singleton = 1',
    ).get() as { schema_version: number } | undefined;
    let schemaVersion = existing ? Number(existing.schema_version) : undefined;
    if (schemaVersion === 1) {
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE durable_inbox ADD COLUMN lane TEXT NOT NULL DEFAULT 'lark-message';",
        );
        this.db.prepare(
          'UPDATE durable_coordination_meta SET schema_version = ? WHERE singleton = 1',
        ).run(2);
      });
      schemaVersion = 2;
    }
    if (schemaVersion === 2) {
      // v3 只新增独立 control operation 表；上面的 idempotent schema DDL
      // 已创建它，这里只在同一连接内推进持久版本号。
      this.transaction(() => {
        this.db.prepare(
          'UPDATE durable_coordination_meta SET schema_version = ? WHERE singleton = 1',
        ).run(3);
      });
      schemaVersion = 3;
    }
    if (schemaVersion !== undefined && schemaVersion !== SQLITE_DURABLE_COORDINATION_SCHEMA_VERSION) {
      throw new Error(`unsupported durable coordination schema version ${schemaVersion}`);
    }
    this.db.prepare(
      'INSERT INTO durable_coordination_meta(singleton, schema_version) VALUES(1, ?) '
      + 'ON CONFLICT(singleton) DO NOTHING',
    ).run(SQLITE_DURABLE_COORDINATION_SCHEMA_VERSION);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS durable_inbox_lane_claim_idx '
      + 'ON durable_inbox(lane, state, visible_at, created_at, event_id);',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS durable_inbox_lane_partition_claim_idx '
      + 'ON durable_inbox(lane, partition_key, state, claim_until);',
    );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      }
    }
  }

  private readLease(sessionKey: string): SessionLease | undefined {
    const row = this.db.prepare(
      'SELECT session_key, owner_id, epoch, lease_until FROM durable_session_leases WHERE session_key = ?',
    ).get(sessionKey) as LeaseRow | undefined;
    return row ? sessionLease(row) : undefined;
  }

  private leaseIsCurrent(lease: SessionLease, now: number): boolean {
    const current = this.readLease(lease.sessionKey);
    return !!current
      && current.ownerId === lease.ownerId
      && current.epoch === lease.epoch
      && current.leaseUntil > now;
  }

  private now(): number {
    return timestamp(this.clock(), 'store clock');
  }

  async acquireSessionLease(input: AcquireSessionLeaseInput): Promise<SessionLeaseAcquisition> {
    const sessionKey = nonempty(input.sessionKey, 'sessionKey');
    const ownerId = nonempty(input.ownerId, 'ownerId');
    const now = this.now();
    const until = leaseUntil(now, input.leaseDurationMs);
    return this.transaction(() => {
      const current = this.readLease(sessionKey);
      if (current && current.leaseUntil > now && current.ownerId !== ownerId) {
        return {
          kind: 'occupied' as const,
          ownerId: current.ownerId,
          epoch: current.epoch,
          leaseUntil: current.leaseUntil,
        };
      }
      const epoch = current && current.ownerId === ownerId && current.leaseUntil > now
        ? current.epoch
        : (current?.epoch ?? 0) + 1;
      this.db.prepare(
        'INSERT INTO durable_session_leases(session_key, owner_id, epoch, lease_until, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET '
        + 'owner_id = excluded.owner_id, epoch = excluded.epoch, '
        + 'lease_until = excluded.lease_until, updated_at = excluded.updated_at',
      ).run(sessionKey, ownerId, epoch, until, now);
      return { kind: 'acquired' as const, lease: { sessionKey, ownerId, epoch, leaseUntil: until } };
    });
  }

  async renewSessionLease(input: RenewSessionLeaseInput): Promise<LeaseMutationResult> {
    const now = this.now();
    const until = leaseUntil(now, input.leaseDurationMs);
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale' as const };
      const result = this.db.prepare(
        'UPDATE durable_session_leases SET lease_until = ?, updated_at = ? '
        + 'WHERE session_key = ? AND owner_id = ? AND epoch = ?',
      ).run(until, now, input.lease.sessionKey, input.lease.ownerId, input.lease.epoch);
      if (Number(result.changes) !== 1) return { kind: 'stale' as const };
      return { kind: 'applied' as const, lease: { ...input.lease, leaseUntil: until } };
    });
  }

  async releaseSessionLease(lease: SessionLease): Promise<LeaseMutationResult> {
    const now = this.now();
    return this.transaction(() => {
      const current = this.readLease(lease.sessionKey);
      if (!current || current.ownerId !== lease.ownerId || current.epoch !== lease.epoch) {
        return { kind: 'stale' as const };
      }
      this.db.prepare(
        'UPDATE durable_session_leases SET lease_until = ?, updated_at = ? '
        + 'WHERE session_key = ? AND owner_id = ? AND epoch = ?',
      ).run(now, now, lease.sessionKey, lease.ownerId, lease.epoch);
      return { kind: 'applied' as const, lease: { ...lease, leaseUntil: now } };
    });
  }

  async readSession(sessionKey: string): Promise<DurableSessionRecord | undefined> {
    const row = this.db.prepare(
      'SELECT session_key, revision, value_json, updated_at FROM durable_sessions WHERE session_key = ?',
    ).get(nonempty(sessionKey, 'sessionKey')) as SessionRow | undefined;
    return row ? sessionRecord(row) : undefined;
  }

  async writeSession(input: WriteSessionInput): Promise<WriteSessionResult> {
    const now = this.now();
    if (input.expectedRevision !== null
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw new Error('expectedRevision must be null or a positive safe integer');
    }
    const valueJson = canonicalJson(input.value);
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale_lease' as const };
      const row = this.db.prepare(
        'SELECT session_key, revision, value_json, updated_at FROM durable_sessions WHERE session_key = ?',
      ).get(input.lease.sessionKey) as SessionRow | undefined;
      if (input.expectedRevision === null ? !!row : !row || Number(row.revision) !== input.expectedRevision) {
        return { kind: 'conflict' as const, ...(row ? { current: sessionRecord(row) } : {}) };
      }
      const revision = row ? Number(row.revision) + 1 : 1;
      this.db.prepare(
        'INSERT INTO durable_sessions(session_key, revision, value_json, updated_at) VALUES(?, ?, ?, ?) '
        + 'ON CONFLICT(session_key) DO UPDATE SET revision = excluded.revision, '
        + 'value_json = excluded.value_json, updated_at = excluded.updated_at',
      ).run(input.lease.sessionKey, revision, valueJson, now);
      return {
        kind: 'written' as const,
        record: { sessionKey: input.lease.sessionKey, revision, value: input.value, updatedAt: now },
      };
    });
  }

  async enqueueInbox(event: DurableInboxEvent): Promise<DurableInsertResult> {
    nonempty(event.eventId, 'eventId');
    const lane = nonempty(event.lane ?? DURABLE_INBOX_LANE_LARK_MESSAGE, 'lane');
    nonempty(event.partitionKey, 'partitionKey');
    timestamp(event.visibleAt, 'visibleAt');
    timestamp(event.createdAt, 'createdAt');
    const payload = encoded(event.payload);
    return this.transaction(() => {
      const inserted = this.db.prepare(
        'INSERT INTO durable_inbox(event_id, lane, partition_key, payload_json, payload_hash, state, '
        + 'visible_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, \'queued\', ?, ?, ?) '
        + 'ON CONFLICT(event_id) DO NOTHING',
      ).run(
        event.eventId,
        lane,
        event.partitionKey,
        payload.json,
        payload.hash,
        event.visibleAt,
        event.createdAt,
        event.createdAt,
      );
      if (Number(inserted.changes) === 1) {
        this.db.prepare(
          'INSERT INTO durable_inbox_order(event_id) VALUES(?)',
        ).run(event.eventId);
        return { kind: 'inserted' as const };
      }
      const current = this.db.prepare(
        'SELECT lane, partition_key, payload_hash FROM durable_inbox WHERE event_id = ?',
      ).get(event.eventId) as { lane: string; partition_key: string; payload_hash: string };
      return current.lane === lane
        && current.partition_key === event.partitionKey
        && current.payload_hash === payload.hash
        ? { kind: 'duplicate' as const }
        : { kind: 'conflict' as const };
    });
  }

  async claimNextInbox(input: ClaimInboxInput): Promise<InboxClaim | undefined> {
    const workerId = nonempty(input.workerId, 'workerId');
    const lane = nonempty(input.lane ?? DURABLE_INBOX_LANE_LARK_MESSAGE, 'lane');
    if (input.partitionKeys !== undefined && !Array.isArray(input.partitionKeys)) {
      throw new Error('partitionKeys must be an array');
    }
    const partitionKeys = input.partitionKeys === undefined
      ? undefined
      : [...new Set(input.partitionKeys.map(key => {
        if (typeof key !== 'string') throw new Error('partitionKey must be text');
        return nonempty(key, 'partitionKey');
      }))];
    if (partitionKeys && partitionKeys.length > 256) {
      throw new Error('partitionKeys must contain at most 256 unique values');
    }
    if (partitionKeys?.length === 0) return undefined;
    const now = this.now();
    const until = leaseUntil(now, input.leaseDurationMs);
    return this.transaction(() => {
      const partitionFilter = partitionKeys
        ? `AND i.partition_key IN (${partitionKeys.map(() => '?').join(', ')})`
        : '';
      const candidate = this.db.prepare(
        `SELECT i.event_id
           FROM durable_inbox i
           JOIN durable_inbox_order io ON io.event_id = i.event_id
          WHERE i.lane = ?
            ${partitionFilter}
            AND i.visible_at <= ?
            AND (i.state = 'queued' OR (i.state = 'claimed' AND i.claim_until <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM durable_inbox active
               WHERE active.lane = i.lane
                 AND active.partition_key = i.partition_key
                 AND active.state = 'claimed'
                 AND active.claim_until > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM durable_inbox earlier
              JOIN durable_inbox_order earlier_order ON earlier_order.event_id = earlier.event_id
               WHERE earlier.lane = i.lane
                 AND earlier.partition_key = i.partition_key
                 AND earlier.state != 'completed'
                 AND earlier_order.sequence < io.sequence
            )
          ORDER BY i.visible_at, io.sequence
          LIMIT 1`,
      ).get(lane, ...(partitionKeys ?? []), now, now, now) as { event_id: string } | undefined;
      if (!candidate) return undefined;
      this.db.prepare(
        `UPDATE durable_inbox
            SET state = 'claimed', claim_owner = ?, claim_epoch = claim_epoch + 1,
                claim_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE event_id = ?`,
      ).run(workerId, until, now, candidate.event_id);
      const row = this.db.prepare(
        `SELECT event_id, lane, partition_key, payload_json, visible_at, claim_owner,
                claim_epoch, claim_until, attempts, created_at
           FROM durable_inbox WHERE event_id = ?`,
      ).get(candidate.event_id) as InboxRow;
      return inboxClaim(row);
    });
  }

  async renewInboxClaim(input: RenewInboxClaimInput): Promise<InboxClaimMutationResult> {
    const now = this.now();
    const until = leaseUntil(now, input.leaseDurationMs);
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE durable_inbox SET claim_until = ?, updated_at = ?
          WHERE event_id = ? AND state = 'claimed' AND claim_owner = ?
            AND claim_epoch = ? AND claim_until > ?`,
      ).run(
        until,
        now,
        input.claim.event.eventId,
        input.claim.workerId,
        input.claim.claimEpoch,
        now,
      );
      if (Number(result.changes) !== 1) return { kind: 'stale' as const };
      return { kind: 'applied' as const, claim: { ...input.claim, claimUntil: until } };
    });
  }

  async completeInboxClaim(claim: InboxClaim): Promise<InboxClaimMutationResult> {
    const now = this.now();
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE durable_inbox
            SET state = 'completed', claim_owner = NULL, claim_until = NULL,
                completed_at = ?, updated_at = ?
          WHERE event_id = ? AND state = 'claimed' AND claim_owner = ?
            AND claim_epoch = ? AND claim_until > ?`,
      ).run(now, now, claim.event.eventId, claim.workerId, claim.claimEpoch, now);
      return Number(result.changes) === 1 ? { kind: 'applied' as const } : { kind: 'stale' as const };
    });
  }

  async retryInboxClaim(input: RetryInboxClaimInput): Promise<InboxClaimMutationResult> {
    const now = this.now();
    timestamp(input.visibleAt, 'visibleAt');
    return this.transaction(() => {
      const result = this.db.prepare(
        `UPDATE durable_inbox
            SET state = 'queued', visible_at = ?, claim_owner = NULL, claim_until = NULL,
                updated_at = ?
          WHERE event_id = ? AND state = 'claimed' AND claim_owner = ?
            AND claim_epoch = ? AND claim_until > ?`,
      ).run(
        input.visibleAt,
        now,
        input.claim.event.eventId,
        input.claim.workerId,
        input.claim.claimEpoch,
        now,
      );
      return Number(result.changes) === 1 ? { kind: 'applied' as const } : { kind: 'stale' as const };
    });
  }

  async enqueueOutbox(
    input: EnqueueOutboxInput,
  ): Promise<DurableInsertResult | { kind: 'stale_lease' }> {
    if (input.message.sessionKey !== input.lease.sessionKey) {
      throw new Error('outbox message sessionKey must match the fencing lease');
    }
    nonempty(input.message.messageId, 'messageId');
    timestamp(input.message.visibleAt, 'visibleAt');
    timestamp(input.message.createdAt, 'createdAt');
    const now = this.now();
    const payload = encoded(input.message.payload);
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale_lease' as const };
      const inserted = this.db.prepare(
        `INSERT INTO durable_outbox(
           message_id, session_key, payload_json, payload_hash, origin_epoch, state,
           visible_at, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      ).run(
        input.message.messageId,
        input.message.sessionKey,
        payload.json,
        payload.hash,
        input.lease.epoch,
        input.message.visibleAt,
        input.message.createdAt,
        now,
      );
      if (Number(inserted.changes) === 1) {
        this.db.prepare(
          'INSERT INTO durable_outbox_order(message_id) VALUES(?)',
        ).run(input.message.messageId);
        return { kind: 'inserted' as const };
      }
      const current = this.db.prepare(
        'SELECT session_key, payload_hash FROM durable_outbox WHERE message_id = ?',
      ).get(input.message.messageId) as { session_key: string; payload_hash: string };
      return current.session_key === input.message.sessionKey && current.payload_hash === payload.hash
        ? { kind: 'duplicate' as const }
        : { kind: 'conflict' as const };
    });
  }

  private selectOutbox(messageId: string): OutboxRow | undefined {
    return this.db.prepare(
      `SELECT message_id, session_key, payload_json, origin_epoch, state, visible_at,
              claim_owner, claim_epoch, claim_until, attempts, receipt_json, last_error,
              created_at, updated_at
         FROM durable_outbox WHERE message_id = ?`,
    ).get(messageId) as OutboxRow | undefined;
  }

  async reserveNextOutbox(input: ReserveOutboxInput): Promise<OutboxReservation | undefined> {
    const workerId = nonempty(input.workerId, 'workerId');
    const now = this.now();
    const until = leaseUntil(now, input.leaseDurationMs);
    return this.transaction(() => {
      // `attempting` 已越过副作用边界，租约丢失后结果不明，不能自动重放。
      this.db.prepare(
        `UPDATE durable_outbox
            SET state = 'ambiguous',
                last_error = COALESCE(last_error, 'delivery attempt lease expired before receipt'),
                updated_at = ?
          WHERE state = 'attempting' AND claim_until <= ?`,
      ).run(now, now);
      const candidate = this.db.prepare(
        `SELECT o.message_id FROM durable_outbox o
          JOIN durable_outbox_order current_order ON current_order.message_id = o.message_id
          WHERE o.visible_at <= ?
            AND (o.state = 'pending' OR (o.state = 'reserved' AND o.claim_until <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM durable_outbox earlier
               JOIN durable_outbox_order earlier_order ON earlier_order.message_id = earlier.message_id
               WHERE earlier.session_key = o.session_key
                 AND earlier.state != 'delivered'
                 AND earlier_order.sequence < current_order.sequence
            )
          ORDER BY o.visible_at, current_order.sequence
          LIMIT 1`,
      ).get(now, now) as { message_id: string } | undefined;
      if (!candidate) return undefined;
      this.db.prepare(
        `UPDATE durable_outbox
            SET state = 'reserved', claim_owner = ?, claim_epoch = claim_epoch + 1,
                claim_until = ?, updated_at = ?
          WHERE message_id = ?`,
      ).run(workerId, until, now, candidate.message_id);
      const row = this.selectOutbox(candidate.message_id);
      if (!row) throw new Error(`reserved outbox row ${candidate.message_id} disappeared`);
      return {
        record: outboxRecord(row),
        workerId,
        claimEpoch: Number(row.claim_epoch),
        claimUntil: until,
      };
    });
  }

  async beginOutboxAttempt(input: BeginOutboxAttemptInput): Promise<BeginOutboxAttemptResult> {
    const now = this.now();
    return this.transaction(() => {
      const reservation = input.reservation;
      const result = this.db.prepare(
        `UPDATE durable_outbox SET state = 'attempting', attempts = attempts + 1, updated_at = ?
          WHERE message_id = ? AND state = 'reserved' AND claim_owner = ?
            AND claim_epoch = ? AND claim_until > ?`,
      ).run(
        now,
        reservation.record.messageId,
        reservation.workerId,
        reservation.claimEpoch,
        now,
      );
      if (Number(result.changes) !== 1) return { kind: 'stale' as const };
      const row = this.selectOutbox(reservation.record.messageId);
      if (!row) throw new Error(`attempting outbox row ${reservation.record.messageId} disappeared`);
      const record = outboxRecord(row);
      const attempt: OutboxAttempt = { ...reservation, record, attempt: record.attempts };
      return { kind: 'applied' as const, record, attempt };
    });
  }

  private settleOutboxAttempt(
    attempt: OutboxAttempt,
    now: number,
    state: 'pending' | 'ambiguous' | 'delivered',
    options: { visibleAt?: number; receiptJson?: string; error?: string },
  ): OutboxMutationResult {
    // An ambiguous attempt may only accept the exact delayed delivered receipt.
    // Retry and repeated ambiguity must never reopen or mutate result-unknown work.
    const eligibleState = state === 'delivered'
      ? "state IN ('attempting', 'ambiguous')"
      : "state = 'attempting'";
    const result = this.db.prepare(
      `UPDATE durable_outbox
          SET state = ?, visible_at = COALESCE(?, visible_at),
              receipt_json = COALESCE(?, receipt_json), last_error = ?,
              claim_owner = CASE WHEN ? = 1 THEN claim_owner ELSE NULL END,
              claim_until = CASE WHEN ? = 1 THEN claim_until ELSE NULL END,
              updated_at = ?
        WHERE message_id = ? AND ${eligibleState}
          AND claim_owner = ? AND claim_epoch = ? AND attempts = ?`,
    ).run(
      state,
      options.visibleAt ?? null,
      options.receiptJson ?? null,
      options.error ?? null,
      state === 'ambiguous' ? 1 : 0,
      state === 'ambiguous' ? 1 : 0,
      now,
      attempt.record.messageId,
      attempt.workerId,
      attempt.claimEpoch,
      attempt.attempt,
    );
    if (Number(result.changes) !== 1) return { kind: 'stale' };
    const row = this.selectOutbox(attempt.record.messageId);
    if (!row) throw new Error(`settled outbox row ${attempt.record.messageId} disappeared`);
    return { kind: 'applied', record: outboxRecord(row) };
  }

  async completeOutboxAttempt(input: CompleteOutboxAttemptInput): Promise<OutboxMutationResult> {
    const now = this.now();
    const receiptJson = canonicalJson(input.receipt);
    return this.transaction(() => this.settleOutboxAttempt(
      input.attempt,
      now,
      'delivered',
      { receiptJson },
    ));
  }

  async retryOutboxAttempt(input: RetryOutboxAttemptInput): Promise<OutboxMutationResult> {
    const now = this.now();
    timestamp(input.visibleAt, 'visibleAt');
    nonempty(input.error, 'error');
    return this.transaction(() => this.settleOutboxAttempt(
      input.attempt,
      now,
      'pending',
      { visibleAt: input.visibleAt, error: input.error },
    ));
  }

  async markOutboxAmbiguous(input: MarkOutboxAmbiguousInput): Promise<OutboxMutationResult> {
    const now = this.now();
    nonempty(input.error, 'error');
    return this.transaction(() => this.settleOutboxAttempt(
      input.attempt,
      now,
      'ambiguous',
      { error: input.error },
    ));
  }

  async readOutbox(messageId: string): Promise<DurableOutboxRecord | undefined> {
    const row = this.selectOutbox(nonempty(messageId, 'messageId'));
    return row ? outboxRecord(row) : undefined;
  }

  private selectControlOperation(operationId: string): ControlOperationRow | undefined {
    return this.db.prepare(
      `SELECT operation_id, session_key, payload_json, origin_epoch, state, attempts,
              attempt_owner, attempt_epoch, result_json, reconciliation_json,
              last_error, created_at, updated_at
         FROM durable_control_operations WHERE operation_id = ?`,
    ).get(operationId) as ControlOperationRow | undefined;
  }

  async enqueueControlOperation(
    input: EnqueueControlOperationInput,
  ): Promise<DurableInsertResult | { kind: 'stale_lease' }> {
    if (input.operation.sessionKey !== input.lease.sessionKey) {
      throw new Error('control operation sessionKey must match the fencing lease');
    }
    const operationId = nonempty(input.operation.operationId, 'operationId');
    timestamp(input.operation.createdAt, 'createdAt');
    const now = this.now();
    const payload = encoded(input.operation.payload);
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale_lease' as const };
      const inserted = this.db.prepare(
        `INSERT INTO durable_control_operations(
           operation_id, session_key, payload_json, payload_hash, origin_epoch,
           state, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
      ).run(
        operationId,
        input.operation.sessionKey,
        payload.json,
        payload.hash,
        input.lease.epoch,
        input.operation.createdAt,
        now,
      );
      if (Number(inserted.changes) === 1) return { kind: 'inserted' as const };
      const current = this.db.prepare(
        `SELECT session_key, payload_hash
           FROM durable_control_operations WHERE operation_id = ?`,
      ).get(operationId) as { session_key: string; payload_hash: string };
      return current.session_key === input.operation.sessionKey && current.payload_hash === payload.hash
        ? { kind: 'duplicate' as const }
        : { kind: 'conflict' as const };
    });
  }

  async beginControlOperationAttempt(
    input: BeginControlOperationAttemptInput,
  ): Promise<BeginControlOperationAttemptResult> {
    const operationId = nonempty(input.operationId, 'operationId');
    const now = this.now();
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale_lease' as const };
      let row = this.selectControlOperation(operationId);
      if (!row) return { kind: 'not_found' as const };
      if (row.session_key !== input.lease.sessionKey) {
        throw new Error('control operation sessionKey must match the fencing lease');
      }

      // A different current Session lease proves the previous attempting owner
      // lost fencing. The provider may already have applied its request, so the
      // new owner freezes the operation as result-unknown instead of replaying.
      if (
        row.state === 'attempting'
        && (row.attempt_owner !== input.lease.ownerId || row.attempt_epoch !== input.lease.epoch)
      ) {
        this.db.prepare(
          `UPDATE durable_control_operations
              SET state = 'ambiguous',
                  last_error = COALESCE(last_error, 'control attempt lost its session lease before result'),
                  updated_at = ?
            WHERE operation_id = ? AND state = 'attempting'`,
        ).run(now, operationId);
        row = this.selectControlOperation(operationId);
        if (!row) throw new Error(`control operation ${operationId} disappeared`);
      }

      if (row.state !== 'pending') {
        return { kind: 'not_pending' as const, record: controlOperationRecord(row) };
      }
      const begun = this.db.prepare(
        `UPDATE durable_control_operations
            SET state = 'attempting', attempts = attempts + 1,
                attempt_owner = ?, attempt_epoch = ?, last_error = NULL, updated_at = ?
          WHERE operation_id = ? AND state = 'pending'`,
      ).run(input.lease.ownerId, input.lease.epoch, now, operationId);
      if (Number(begun.changes) !== 1) {
        row = this.selectControlOperation(operationId);
        if (!row) return { kind: 'not_found' as const };
        return { kind: 'not_pending' as const, record: controlOperationRecord(row) };
      }
      row = this.selectControlOperation(operationId);
      if (!row) throw new Error(`attempting control operation ${operationId} disappeared`);
      const record = controlOperationRecord(row);
      const attempt: ControlOperationAttempt = {
        operationId,
        sessionKey: row.session_key,
        ownerId: input.lease.ownerId,
        leaseEpoch: input.lease.epoch,
        attempt: record.attempts,
      };
      return { kind: 'applied' as const, record, attempt };
    });
  }

  private settleControlOperationAttempt(
    attempt: ControlOperationAttempt,
    now: number,
    state: 'pending' | 'ambiguous' | 'completed',
    options: { resultJson?: string; error?: string },
  ): ControlOperationMutationResult {
    nonempty(attempt.operationId, 'operationId');
    nonempty(attempt.sessionKey, 'sessionKey');
    nonempty(attempt.ownerId, 'ownerId');
    if (!Number.isSafeInteger(attempt.leaseEpoch) || attempt.leaseEpoch < 1) {
      throw new Error('leaseEpoch must be a positive safe integer');
    }
    if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
      throw new Error('attempt must be a positive safe integer');
    }
    // Exact late success may settle ambiguous. Safe retry and explicit
    // ambiguity are only legal while the same attempt is still attempting.
    const eligibleState = state === 'completed'
      ? "state IN ('attempting', 'ambiguous')"
      : "state = 'attempting'";
    const result = this.db.prepare(
      `UPDATE durable_control_operations
          SET state = ?, result_json = COALESCE(?, result_json),
              last_error = ?, updated_at = ?
        WHERE operation_id = ? AND session_key = ? AND ${eligibleState}
          AND attempt_owner = ? AND attempt_epoch = ? AND attempts = ?`,
    ).run(
      state,
      options.resultJson ?? null,
      options.error ?? null,
      now,
      attempt.operationId,
      attempt.sessionKey,
      attempt.ownerId,
      attempt.leaseEpoch,
      attempt.attempt,
    );
    if (Number(result.changes) !== 1) return { kind: 'stale' };
    const row = this.selectControlOperation(attempt.operationId);
    if (!row) throw new Error(`settled control operation ${attempt.operationId} disappeared`);
    return { kind: 'applied', record: controlOperationRecord(row) };
  }

  async completeControlOperationAttempt(
    input: CompleteControlOperationAttemptInput,
  ): Promise<ControlOperationMutationResult> {
    const now = this.now();
    const resultJson = canonicalJson(input.result);
    return this.transaction(() => this.settleControlOperationAttempt(
      input.attempt,
      now,
      'completed',
      { resultJson },
    ));
  }

  async retryControlOperationAttempt(
    input: RetryControlOperationAttemptInput,
  ): Promise<ControlOperationMutationResult> {
    const now = this.now();
    nonempty(input.error, 'error');
    return this.transaction(() => this.settleControlOperationAttempt(
      input.attempt,
      now,
      'pending',
      { error: input.error },
    ));
  }

  async markControlOperationAmbiguous(
    input: MarkControlOperationAmbiguousInput,
  ): Promise<ControlOperationMutationResult> {
    const now = this.now();
    nonempty(input.error, 'error');
    return this.transaction(() => this.settleControlOperationAttempt(
      input.attempt,
      now,
      'ambiguous',
      { error: input.error },
    ));
  }

  async reconcileControlOperation(
    input: ReconcileControlOperationInput,
  ): Promise<ReconcileControlOperationResult> {
    const operationId = nonempty(input.operationId, 'operationId');
    if (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) {
      throw new Error('expectedAttempt must be a positive safe integer');
    }
    if (input.outcome.evidence === null) {
      throw new Error('control reconciliation evidence must be non-null');
    }
    const reconciliationJson = canonicalJson({
      kind: input.outcome.kind,
      attempt: input.expectedAttempt,
      evidence: input.outcome.evidence,
    });
    const resultJson = input.outcome.kind === 'completed'
      ? canonicalJson(input.outcome.result)
      : undefined;
    const error = input.outcome.kind === 'not_applied'
      ? nonempty(input.outcome.error, 'error')
      : undefined;
    const now = this.now();
    return this.transaction(() => {
      if (!this.leaseIsCurrent(input.lease, now)) return { kind: 'stale_lease' as const };
      const row = this.selectControlOperation(operationId);
      if (!row) return { kind: 'stale' as const };
      if (row.session_key !== input.lease.sessionKey) {
        throw new Error('control operation sessionKey must match the fencing lease');
      }
      const state = input.outcome.kind === 'completed' ? 'completed' : 'pending';
      const settled = this.db.prepare(
        `UPDATE durable_control_operations
            SET state = ?, result_json = ?, reconciliation_json = ?,
                last_error = ?, updated_at = ?
          WHERE operation_id = ? AND state = 'ambiguous' AND attempts = ?`,
      ).run(
        state,
        resultJson ?? null,
        reconciliationJson,
        error ?? null,
        now,
        operationId,
        input.expectedAttempt,
      );
      if (Number(settled.changes) !== 1) return { kind: 'stale' as const };
      const updated = this.selectControlOperation(operationId);
      if (!updated) throw new Error(`reconciled control operation ${operationId} disappeared`);
      return { kind: 'applied' as const, record: controlOperationRecord(updated) };
    });
  }

  async readControlOperation(
    operationId: string,
  ): Promise<DurableControlOperationRecord | undefined> {
    const row = this.selectControlOperation(nonempty(operationId, 'operationId'));
    return row ? controlOperationRecord(row) : undefined;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
