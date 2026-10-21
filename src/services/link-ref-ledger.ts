import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import {
  LINK_REF_MAX_TOTAL_URL_BYTES,
  LINK_REF_MAX_URL_BYTES,
  LINK_REF_MAX_URLS_PER_TURN,
  LINK_REF_RETENTION_MS,
  LinkRefError,
  type LinkRefCandidate,
  type LinkRefRegistrationResult,
  type LinkRefTurnKey,
  type LinkRefTurnRecord,
  type RegisteredLinkRef,
} from './link-ref-types.js';

interface TurnRow {
  app_id: string;
  session_id: string;
  turn_id: string;
  dispatch_attempt: number;
  mode: 'enabled';
  state: 'open' | 'settled' | 'expired';
  created_at_ms: number;
  last_activity_at_ms: number;
  settled_at_ms: number | null;
  expires_at_ms: number;
  total_url_bytes: number;
}

interface LinkRow {
  ref_id: string;
  original_url: string;
  source_type: RegisteredLinkRef['sourceType'];
  source_id: string | null;
  app_id?: string;
  session_id?: string;
  turn_id?: string;
  dispatch_attempt?: number;
}

function attemptOf(key: LinkRefTurnKey): number {
  return key.dispatchAttempt ?? 0;
}

function keyParams(key: LinkRefTurnKey): [string, string, string, number] {
  return [key.appId, key.sessionId, key.turnId, attemptOf(key)];
}

function toRecord(row: TurnRow): LinkRefTurnRecord {
  return {
    appId: row.app_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    dispatchAttempt: row.dispatch_attempt,
    mode: row.mode,
    state: row.state,
    createdAtMs: row.created_at_ms,
    lastActivityAtMs: row.last_activity_at_ms,
    ...(row.settled_at_ms === null ? {} : { settledAtMs: row.settled_at_ms }),
    expiresAtMs: row.expires_at_ms,
  };
}

function toRegistered(row: LinkRow): RegisteredLinkRef {
  return {
    refId: row.ref_id as RegisteredLinkRef['refId'],
    originalUrl: row.original_url,
    sourceType: row.source_type,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
  };
}

function urlHash(originalUrl: string): string {
  return createHash('sha256').update(originalUrl, 'utf8').digest('hex');
}

function isBusy(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === 'SQLITE_BUSY' || /database is (?:locked|busy)/iu.test(value?.message ?? '');
}

function boundedBusyJitter(retry: number): void {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, 5 * retry);
}

export class LinkRefLedger {
  private readonly db: DatabaseSyncLike;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private closed = false;

  constructor(
    dataDir: string,
    options: { now?: () => number; randomBytes?: (size: number) => Buffer } = {},
  ) {
    const root = join(dataDir, 'link-refs');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const path = join(root, 'link-refs.sqlite');
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.db = openDatabaseSyncOrThrow(path);
    this.db.exec('PRAGMA busy_timeout = 50;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS link_ref_turns (
        app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        dispatch_attempt INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode = 'enabled'),
        state TEXT NOT NULL CHECK(state IN ('open','settled','expired')),
        created_at_ms INTEGER NOT NULL, last_activity_at_ms INTEGER NOT NULL,
        settled_at_ms INTEGER, expires_at_ms INTEGER NOT NULL,
        total_url_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(app_id, session_id, turn_id, dispatch_attempt)
      );
      CREATE TABLE IF NOT EXISTS link_refs (
        ref_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        dispatch_attempt INTEGER NOT NULL,
        original_url TEXT NOT NULL, url_hash TEXT NOT NULL,
        source_type TEXT NOT NULL, source_id TEXT, created_at_ms INTEGER NOT NULL,
        UNIQUE(app_id, session_id, turn_id, dispatch_attempt, url_hash, original_url),
        FOREIGN KEY(app_id, session_id, turn_id, dispatch_attempt)
          REFERENCES link_ref_turns(app_id, session_id, turn_id, dispatch_attempt) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS link_ref_pending_drafts (
        app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        dispatch_attempt INTEGER NOT NULL, content TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(app_id, session_id, turn_id, dispatch_attempt),
        FOREIGN KEY(app_id, session_id, turn_id, dispatch_attempt)
          REFERENCES link_ref_turns(app_id, session_id, turn_id, dispatch_attempt) ON DELETE CASCADE
      );
    `);
    chmodSync(path, 0o600);
  }

  private transaction<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      let begun = false;
      try {
        this.db.exec('BEGIN IMMEDIATE');
        begun = true;
        const result = operation();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        if (begun) {
          try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
        }
        if (!isBusy(error) || attempt >= 2) throw error;
        boundedBusyJitter(attempt + 1);
      }
    }
  }

  private retryBusy<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!isBusy(error) || attempt >= 2) throw error;
        boundedBusyJitter(attempt + 1);
      }
    }
  }

  private turnRow(key: LinkRefTurnKey): TurnRow | undefined {
    return this.db.prepare(`
      SELECT * FROM link_ref_turns
      WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
    `).get(...keyParams(key)) as TurnRow | undefined;
  }

  private requireTurn(key: LinkRefTurnKey): TurnRow {
    const row = this.turnRow(key);
    if (!row) throw new LinkRefError('link_ref_turn_missing');
    if (row.state === 'expired' || row.expires_at_ms <= this.now()) {
      throw new LinkRefError('link_ref_expired');
    }
    return row;
  }

  openTurn(key: LinkRefTurnKey): void {
    const now = this.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO link_ref_turns (
          app_id, session_id, turn_id, dispatch_attempt, mode, state,
          created_at_ms, last_activity_at_ms, settled_at_ms, expires_at_ms, total_url_bytes
        ) VALUES (?, ?, ?, ?, 'enabled', 'open', ?, ?, NULL, ?, 0)
      `).run(...keyParams(key), now, now, now + LINK_REF_RETENTION_MS);
      const existing = this.turnRow(key);
      if (!existing) throw new LinkRefError('link_ref_ledger_unavailable');
      if (existing.state !== 'open') throw new LinkRefError('link_ref_turn_not_open');
    });
  }

  readTurn(key: LinkRefTurnKey): LinkRefTurnRecord | undefined {
    const row = this.turnRow(key);
    if (!row) return undefined;
    return toRecord(row);
  }

  registerBatch(
    key: LinkRefTurnKey,
    candidates: readonly LinkRefCandidate[],
  ): LinkRefRegistrationResult {
    return this.transaction(() => {
      const turn = this.requireTurn(key);
      if (turn.state !== 'open') throw new LinkRefError('link_ref_turn_not_open');
      const countRow = this.db.prepare(`
        SELECT COUNT(*) AS count FROM link_refs
        WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
      `).get(...keyParams(key)) as { count: number };
      let count = Number(countRow.count);
      let totalBytes = turn.total_url_bytes;
      let deduplicated = 0;
      let filteredByLimit = 0;
      const registered: RegisteredLinkRef[] = [];

      for (const candidate of candidates) {
        const hash = urlHash(candidate.originalUrl);
        const existing = this.db.prepare(`
          SELECT ref_id, original_url, source_type, source_id FROM link_refs
          WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
            AND url_hash = ? AND original_url = ?
        `).get(...keyParams(key), hash, candidate.originalUrl) as LinkRow | undefined;
        if (existing) {
          deduplicated += 1;
          registered.push(toRegistered(existing));
          continue;
        }
        const bytes = Buffer.byteLength(candidate.originalUrl);
        if (
          bytes > LINK_REF_MAX_URL_BYTES
          || count >= LINK_REF_MAX_URLS_PER_TURN
          || totalBytes + bytes > LINK_REF_MAX_TOTAL_URL_BYTES
        ) {
          filteredByLimit += 1;
          continue;
        }

        let refId: RegisteredLinkRef['refId'];
        for (;;) {
          refId = `lr_${this.randomBytes(16).toString('hex')}`;
          const collision = this.db.prepare('SELECT 1 AS present FROM link_refs WHERE ref_id = ?').get(refId);
          if (!collision) break;
        }
        this.db.prepare(`
          INSERT INTO link_refs (
            ref_id, app_id, session_id, turn_id, dispatch_attempt,
            original_url, url_hash, source_type, source_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          refId,
          ...keyParams(key),
          candidate.originalUrl,
          hash,
          candidate.sourceType,
          candidate.sourceId ?? null,
          this.now(),
        );
        registered.push({ refId, ...candidate });
        count += 1;
        totalBytes += bytes;
      }
      this.db.prepare(`
        UPDATE link_ref_turns SET total_url_bytes = ?, last_activity_at_ms = ?, expires_at_ms = ?
        WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
      `).run(totalBytes, this.now(), this.now() + LINK_REF_RETENTION_MS, ...keyParams(key));
      return {
        registered,
        deduplicated,
        filteredByLimit,
        ...(filteredByLimit === 0 ? {} : { failure: 'link_ref_limit_exceeded' as const }),
      };
    });
  }

  resolveBatch(key: LinkRefTurnKey, refIds: readonly string[]): Map<string, string> {
    return this.retryBusy(() => {
      const unique = [...new Set(refIds)];
      if (unique.length === 0) return new Map();
      const rows = unique.map((refId) => this.db.prepare(`
        SELECT ref_id, app_id, session_id, turn_id, dispatch_attempt, original_url
        FROM link_refs WHERE ref_id = ?
      `).get(refId) as LinkRow | undefined);
      const missingIndex = rows.findIndex((row) => !row);
      if (missingIndex >= 0) throw new LinkRefError('link_ref_unknown');
      for (const row of rows as LinkRow[]) {
        if (
          row.app_id !== key.appId
          || row.session_id !== key.sessionId
          || row.turn_id !== key.turnId
          || row.dispatch_attempt !== attemptOf(key)
        ) {
          throw new LinkRefError('link_ref_identity_mismatch');
        }
      }
      this.requireTurn(key);
      return new Map((rows as LinkRow[]).map((row) => [row.ref_id, row.original_url]));
    });
  }

  savePendingDraft(key: LinkRefTurnKey, content: string): void {
    this.retryBusy(() => {
      this.requireTurn(key);
      this.db.prepare(`
        INSERT INTO link_ref_pending_drafts (
          app_id, session_id, turn_id, dispatch_attempt, content, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, session_id, turn_id, dispatch_attempt)
        DO UPDATE SET content = excluded.content, updated_at_ms = excluded.updated_at_ms
      `).run(...keyParams(key), content, this.now());
    });
  }

  readPendingDraft(key: LinkRefTurnKey): string | undefined {
    return this.retryBusy(() => {
      const row = this.db.prepare(`
        SELECT content FROM link_ref_pending_drafts
        WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
      `).get(...keyParams(key)) as { content: string } | undefined;
      return row?.content;
    });
  }

  clearPendingDraft(key: LinkRefTurnKey): void {
    this.retryBusy(() => {
      this.db.prepare(`
        DELETE FROM link_ref_pending_drafts
        WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ?
      `).run(...keyParams(key));
    });
  }

  settleTurn(key: LinkRefTurnKey): void {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE link_ref_turns
      SET state = 'settled', settled_at_ms = ?, last_activity_at_ms = ?, expires_at_ms = ?
      WHERE app_id = ? AND session_id = ? AND turn_id = ? AND dispatch_attempt = ? AND state = 'open'
    `).run(now, now, now + LINK_REF_RETENTION_MS, ...keyParams(key));
    if (Number(result.changes) === 0) {
      const row = this.turnRow(key);
      if (!row) throw new LinkRefError('link_ref_turn_missing');
      if (row.state !== 'settled') throw new LinkRefError('link_ref_turn_not_open');
    }
  }

  deleteSession(appId: string, sessionId: string): number {
    return this.transaction(() => {
      // Bun SQLite includes rows removed by ON DELETE CASCADE in `changes`,
      // while node:sqlite reports only the rows deleted from this table. Count
      // the public unit (turns) explicitly so the API is runtime-independent.
      const row = this.db.prepare(`
        SELECT COUNT(*) AS count FROM link_ref_turns
        WHERE app_id = ? AND session_id = ?
      `).get(appId, sessionId) as { count: number };
      this.db.prepare(`
        DELETE FROM link_ref_turns WHERE app_id = ? AND session_id = ?
      `).run(appId, sessionId);
      return Number(row.count);
    });
  }

  pruneExpired(nowMs: number = this.now()): { expired: number; removed: number } {
    return this.transaction(() => {
      const expired = Number(this.db.prepare(`
        UPDATE link_ref_turns SET state = 'expired', expires_at_ms = ?
        WHERE state = 'open' AND last_activity_at_ms + ? <= ?
      `).run(nowMs, LINK_REF_RETENTION_MS, nowMs).changes);
      // See deleteSession: count turns before the cascading delete instead of
      // exposing the engine-specific meaning of `changes` to callers.
      const removable = this.db.prepare(`
        SELECT COUNT(*) AS count FROM link_ref_turns WHERE expires_at_ms <= ?
      `).get(nowMs) as { count: number };
      this.db.prepare(`
        DELETE FROM link_ref_turns WHERE expires_at_ms <= ?
      `).run(nowMs);
      const removed = Number(removable.count);
      return { expired, removed };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
