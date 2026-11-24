/**
 * 任务分配记录持久层：`<dataDir>/task-routing.sqlite`。
 *
 * 约定：
 * - 懒创建：仅在真正写入分配记录时建库；读路径看到文件不存在直接返回空列表 / null，
 *   确保未开启或未使用的部署磁盘上零新增文件（合码标准 3.1）。
 * - 复用 `openDatabaseSyncOrThrow`（WAL + busy_timeout + 0600），兼容 Bun 与 Node SQLite。
 * - 两阶段更新：派发前先落 `pending`，每次候选尝试和建群结果即时落盘，最终收敛为
 *   `dispatched` / `fallback_dispatched` / `failed`。
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import type {
  CandidateEvaluation,
  TaskRoutingAttempt,
  TaskRoutingCallerKind,
  TaskRoutingConfidence,
  TaskRoutingConstraints,
  TaskRoutingDispatchMode,
  TaskRoutingMatcherKind,
  TaskRoutingOutcome,
  TaskRoutingRecord,
} from '../core/task-routing/model.js';

const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_ROUTING_RECORDS = 1_000;

export function taskRoutingDbPath(dataDir: string): string {
  return join(dataDir, 'task-routing.sqlite');
}

interface RawRoutingRow {
  id: string;
  created_at: number;
  updated_at: number;
  mode: string;
  task_summary: string;
  caller_kind: string;
  caller_app_id: string | null;
  caller_session_id: string | null;
  caller_turn_id: string | null;
  constraints_json: string;
  selected_app_id: string | null;
  selected_name: string | null;
  matcher_kind: string;
  confidence: string;
  reason: string;
  fallback_from_matcher: string | null;
  candidates_json: string;
  excluded_json: string;
  attempts_json: string;
  outcome: string;
  target_chat_id: string | null;
  target_session_id: string | null;
  target_root_msg_id: string | null;
  error: string | null;
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: RawRoutingRow): TaskRoutingRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: (row.mode === 'topic' ? 'topic' : 'group') as TaskRoutingDispatchMode,
    taskSummary: row.task_summary,
    callerKind: (row.caller_kind as TaskRoutingCallerKind) || 'host_cli',
    ...(row.caller_app_id ? { callerAppId: row.caller_app_id } : {}),
    ...(row.caller_session_id ? { callerSessionId: row.caller_session_id } : {}),
    ...(row.caller_turn_id ? { callerTurnId: row.caller_turn_id } : {}),
    constraints: safeParseJson<TaskRoutingConstraints>(row.constraints_json, {}),
    selectedAppId: row.selected_app_id,
    selectedName: row.selected_name,
    matcherKind: (row.matcher_kind as TaskRoutingMatcherKind) || 'rule',
    confidence: (row.confidence as TaskRoutingConfidence) || 'medium',
    reason: row.reason,
    ...(row.fallback_from_matcher ? { fallbackFromMatcher: row.fallback_from_matcher } : {}),
    candidates: safeParseJson<CandidateEvaluation[]>(row.candidates_json, []),
    excluded: safeParseJson<CandidateEvaluation[]>(row.excluded_json, []),
    attempts: safeParseJson<TaskRoutingAttempt[]>(row.attempts_json, []),
    outcome: (row.outcome as TaskRoutingOutcome) || 'pending',
    ...(row.target_chat_id ? { targetChatId: row.target_chat_id } : {}),
    ...(row.target_session_id ? { targetSessionId: row.target_session_id } : {}),
    ...(row.target_root_msg_id ? { targetRootMessageId: row.target_root_msg_id } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export interface TaskRoutingRecordPatch {
  updatedAt?: number;
  selectedAppId?: string | null;
  selectedName?: string | null;
  attempts?: TaskRoutingAttempt[];
  outcome?: TaskRoutingOutcome;
  targetChatId?: string | null;
  targetSessionId?: string | null;
  targetRootMessageId?: string | null;
  error?: string | null;
}

export interface ListTaskRoutingRecordsOptions {
  limit?: number;
  botAppId?: string;
  outcome?: TaskRoutingOutcome;
}

function openExistingOrCreate(dbPath: string, create: boolean): DatabaseSyncLike | null {
  if (!create && !existsSync(dbPath)) return null;
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = openDatabaseSyncOrThrow(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    if (create) {
      db.exec('PRAGMA journal_mode = WAL;');
      const row = db.prepare('PRAGMA user_version;').get() as { user_version?: number } | undefined;
      const version = Number(row?.user_version ?? 0);
      if (version > SCHEMA_VERSION) {
        throw new Error(`task-routing.sqlite schema version ${version} is newer than supported ${SCHEMA_VERSION}`);
      }
      if (version < SCHEMA_VERSION) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS routing_records (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            mode TEXT NOT NULL,
            task_summary TEXT NOT NULL,
            caller_kind TEXT NOT NULL,
            caller_app_id TEXT,
            caller_session_id TEXT,
            caller_turn_id TEXT,
            constraints_json TEXT NOT NULL,
            selected_app_id TEXT,
            selected_name TEXT,
            matcher_kind TEXT NOT NULL,
            confidence TEXT NOT NULL,
            reason TEXT NOT NULL,
            fallback_from_matcher TEXT,
            candidates_json TEXT NOT NULL,
            excluded_json TEXT NOT NULL,
            attempts_json TEXT NOT NULL,
            outcome TEXT NOT NULL,
            target_chat_id TEXT,
            target_session_id TEXT,
            target_root_msg_id TEXT,
            error TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_routing_records_created_at
            ON routing_records(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_routing_records_selected
            ON routing_records(selected_app_id, created_at DESC);
          PRAGMA user_version = ${SCHEMA_VERSION};
          COMMIT;
        `);
      }
      if (process.platform !== 'win32') {
        try { chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
      }
    }
    return db;
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
}

export class TaskRoutingStore {
  private readonly dbPath: string;
  private readonly maxRecords: number;

  constructor(dataDir: string, options: { maxRecords?: number } = {}) {
    this.dbPath = taskRoutingDbPath(dataDir);
    this.maxRecords = Math.max(10, options.maxRecords ?? DEFAULT_MAX_ROUTING_RECORDS);
  }

  insertRecord(record: TaskRoutingRecord): void {
    const db = openExistingOrCreate(this.dbPath, true)!;
    try {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO routing_records (
            id, created_at, updated_at, mode, task_summary,
            caller_kind, caller_app_id, caller_session_id, caller_turn_id,
            constraints_json, selected_app_id, selected_name,
            matcher_kind, confidence, reason, fallback_from_matcher,
            candidates_json, excluded_json, attempts_json, outcome,
            target_chat_id, target_session_id, target_root_msg_id, error
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?
          )
        `).run(
          record.id,
          record.createdAt,
          record.updatedAt,
          record.mode,
          record.taskSummary,
          record.callerKind,
          record.callerAppId ?? null,
          record.callerSessionId ?? null,
          record.callerTurnId ?? null,
          JSON.stringify(record.constraints ?? {}),
          record.selectedAppId ?? null,
          record.selectedName ?? null,
          record.matcherKind,
          record.confidence,
          record.reason,
          record.fallbackFromMatcher ?? null,
          JSON.stringify(record.candidates ?? []),
          JSON.stringify(record.excluded ?? []),
          JSON.stringify(record.attempts ?? []),
          record.outcome,
          record.targetChatId ?? null,
          record.targetSessionId ?? null,
          record.targetRootMessageId ?? null,
          record.error ?? null,
        );

        // Bound table size atomically; never prune in-flight `pending` records.
        db.prepare(`
          DELETE FROM routing_records
          WHERE id IN (
            SELECT id FROM routing_records
            WHERE outcome != 'pending'
            ORDER BY created_at DESC, rowid DESC
            LIMIT -1 OFFSET ?
          )
        `).run(this.maxRecords);
        db.exec('COMMIT;');
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
        throw err;
      }
    } finally {
      db.close();
    }
  }

  private buildPatchUpdate(patch: TaskRoutingRecordPatch): { sets: string[]; params: Array<string | number | null> } {
    const sets: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [patch.updatedAt ?? Date.now()];

    if (patch.selectedAppId !== undefined) {
      sets.push('selected_app_id = ?');
      params.push(patch.selectedAppId);
    }
    if (patch.selectedName !== undefined) {
      sets.push('selected_name = ?');
      params.push(patch.selectedName);
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts_json = ?');
      params.push(JSON.stringify(patch.attempts));
    }
    if (patch.outcome !== undefined) {
      sets.push('outcome = ?');
      params.push(patch.outcome);
    }
    if (patch.targetChatId !== undefined) {
      sets.push('target_chat_id = ?');
      params.push(patch.targetChatId);
    }
    if (patch.targetSessionId !== undefined) {
      sets.push('target_session_id = ?');
      params.push(patch.targetSessionId);
    }
    if (patch.targetRootMessageId !== undefined) {
      sets.push('target_root_msg_id = ?');
      params.push(patch.targetRootMessageId);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    return { sets, params };
  }

  updateRecord(id: string, patch: TaskRoutingRecordPatch): boolean {
    const db = openExistingOrCreate(this.dbPath, false);
    if (!db) return false;
    try {
      const { sets, params } = this.buildPatchUpdate(patch);
      params.push(id);
      const res = db.prepare(`UPDATE routing_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      return Number(res.changes ?? 0) > 0;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  /**
   * Atomically transition a `pending` record to a terminal outcome (`WHERE id = ? AND outcome = 'pending'`).
   * Returns `false` if the record does not exist, is already settled, or the DB is uninitialized.
   */
  settlePendingRecord(
    id: string,
    patch: TaskRoutingRecordPatch & { outcome: Exclude<TaskRoutingOutcome, 'pending'> },
  ): boolean {
    const db = openExistingOrCreate(this.dbPath, false);
    if (!db) return false;
    try {
      const { sets, params } = this.buildPatchUpdate(patch);
      params.push(id);
      const res = db.prepare(
        `UPDATE routing_records SET ${sets.join(', ')} WHERE id = ? AND outcome = 'pending'`,
      ).run(...params);
      return Number(res.changes ?? 0) > 0;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  getRecord(id: string): TaskRoutingRecord | null {
    const db = openExistingOrCreate(this.dbPath, false);
    if (!db) return null;
    try {
      const row = db.prepare('SELECT * FROM routing_records WHERE id = ?').get(id) as RawRoutingRow | undefined;
      return row ? rowToRecord(row) : null;
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  listRecords(options: ListTaskRoutingRecordsOptions = {}): TaskRoutingRecord[] {
    const db = openExistingOrCreate(this.dbPath, false);
    if (!db) return [];
    try {
      const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (options.botAppId) {
        // Match both the final selection and every fallback attempt. Filtering in
        // SQL keeps ORDER BY + LIMIT correct; post-filtering the limited page
        // could silently drop older matching records.
        where.push(`(
          selected_app_id = ? OR EXISTS (
            SELECT 1 FROM json_each(
              CASE WHEN json_valid(routing_records.attempts_json)
                THEN routing_records.attempts_json
                ELSE '[]'
              END
            )
            WHERE json_extract(value, '$.appId') = ?
          )
        )`);
        params.push(options.botAppId, options.botAppId);
      }
      if (options.outcome) {
        where.push('outcome = ?');
        params.push(options.outcome);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);
      const rows = db.prepare(
        `SELECT * FROM routing_records ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(...params) as RawRoutingRow[];
      return rows.map(rowToRecord);
    } catch {
      return [];
    } finally {
      db.close();
    }
  }
}
