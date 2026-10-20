/**
 * Host-only authority store for scheduled tasks.
 *
 * `schedules.json` remains a user-facing projection.  Once an app has been
 * enrolled here, this SQLite database is the only source of runnable task
 * definitions and mutable run state.  This prevents a sandbox that can update
 * its own projection from manufacturing, re-enabling or replaying authority.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScheduledTask } from '../types.js';
import type { TriggerUserAuthTool } from './trigger-user-auth.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { canonicalScheduleInput } from './schedule-store.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

export type ScheduleAuthorityKind = 'legacy' | 'direct' | 'delegated';
export type ScheduleAuthorityState = 'active' | 'paused' | 'completed' | 'revoked';

export interface DelegatedScheduleControl {
  openId: string;
  unionId: string;
  credentialOpenId?: string;
  runScopes?: readonly TriggerUserAuthTool[];
  selfManage?: boolean;
}

export interface ScheduleAuthorityRecord {
  kind: ScheduleAuthorityKind;
  state: ScheduleAuthorityState;
  task: ScheduledTask;
  controlOpenId?: string;
  controlUnionId?: string;
  credentialOpenId?: string;
  runScopes: readonly TriggerUserAuthTool[];
  selfManage: boolean;
  grantId?: string;
  requestHash?: string;
  sourceMessageId?: string;
  sourceSessionId?: string;
  targetTurnId?: string;
  targetGeneration?: number;
}

export type CommitDelegatedScheduleResult =
  | { ok: true; task: ScheduledTask; replay: boolean }
  | { ok: false; error: 'grant_conflict' | 'grant_task_limit' | 'task_id_conflict' };

export const scheduleAuthorityDbPath = (dataDir: string): string =>
  join(dataDir, 'schedule-authority.sqlite');

let beforeCommitTestHook: (() => void) | undefined;
export function __setScheduleAuthorityBeforeCommitTestHook(hook?: () => void): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('schedule authority hook is test-only');
  beforeCommitTestHook = hook;
}

function taskHash(task: ScheduledTask): string {
  return computeInputHash(canonicalScheduleInput(task));
}

function stateFor(task: ScheduledTask): ScheduleAuthorityState {
  if (!task.enabled) return task.disabledReason === 'once_completed' ? 'completed' : 'paused';
  return 'active';
}

function parseTask(raw: unknown, expectedAppId?: string): ScheduledTask {
  if (typeof raw !== 'string') throw new Error('schedule_authority_corrupt_task');
  let task: ScheduledTask;
  try { task = JSON.parse(raw) as ScheduledTask; }
  catch { throw new Error('schedule_authority_corrupt_task'); }
  if (!task || typeof task !== 'object' || typeof task.id !== 'string'
    || typeof task.chatId !== 'string'
    || (task.larkAppId !== undefined && typeof task.larkAppId !== 'string')) {
    throw new Error('schedule_authority_corrupt_task');
  }
  if (expectedAppId && task.larkAppId !== undefined && task.larkAppId !== expectedAppId) {
    throw new Error('schedule_authority_app_mismatch');
  }
  return task;
}

const AUTHORITY_TASK_COLUMNS = [
  'schema_version', 'app_id', 'task_id', 'kind', 'state', 'task_json', 'canonical_hash',
  'control_open_id', 'control_union_id', 'credential_open_id', 'run_scopes_json',
  'self_manage', 'grant_id', 'request_hash', 'source_message_id', 'source_session_id',
  'target_turn_id', 'target_generation', 'created_at', 'updated_at',
] as const;

function createAuthorityTasksTableSql(tableName: string, ifNotExists = false): string {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      app_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('legacy','direct','delegated')),
      state TEXT NOT NULL CHECK(state IN ('active','paused','completed','revoked')),
      task_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      control_open_id TEXT,
      control_union_id TEXT,
      credential_open_id TEXT,
      run_scopes_json TEXT NOT NULL DEFAULT '[]',
      self_manage INTEGER NOT NULL DEFAULT 0 CHECK(self_manage IN (0,1)),
      grant_id TEXT,
      request_hash TEXT,
      source_message_id TEXT,
      source_session_id TEXT,
      target_turn_id TEXT,
      target_generation INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, task_id),
      UNIQUE (grant_id, request_hash)
    );
  `;
}

function authorityTasksTableSql(db: DatabaseSyncLike): string {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_authority_tasks'
  `).get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== 'string') throw new Error('schedule_authority_schema_missing');
  return row.sql;
}

function hasLegacySingleGrantUnique(db: DatabaseSyncLike): boolean {
  const normalized = authorityTasksTableSql(db).replace(/\s+/g, ' ').toLowerCase();
  return /unique\s*\(\s*grant_id\s*\)/.test(normalized);
}

/** SQLite cannot ALTER a table-level UNIQUE constraint. Early builds used
 * UNIQUE(grant_id), which makes a live turn's second distinct request fail.
 * Called inside the schema transaction, after additive columns are backfilled. */
function migrateLegacyGrantUnique(db: DatabaseSyncLike): void {
  if (!hasLegacySingleGrantUnique(db)) return;
  const replacement = 'schedule_authority_tasks_grant_v2';
  const columns = AUTHORITY_TASK_COLUMNS.join(', ');
  const occupied = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(replacement);
  if (occupied) throw new Error('schedule_authority_migration_table_conflict');
  db.exec(createAuthorityTasksTableSql(replacement));
  db.exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM schedule_authority_tasks;`);
  db.exec('DROP TABLE schedule_authority_tasks;');
  db.exec(`ALTER TABLE ${replacement} RENAME TO schedule_authority_tasks;`);
}

export class ScheduleAuthorityStore {
  private constructor(private readonly db: DatabaseSyncLike) {}

  static open(dataDir: string): ScheduleAuthorityStore {
    const path = scheduleAuthorityDbPath(dataDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = openDatabaseSyncOrThrow(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      // Inspect and migrate under the same write lock. Otherwise parallel
      // openers can both observe a missing column and attempt the same ALTER.
      db.exec('BEGIN IMMEDIATE;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_authority_apps (
          app_id TEXT PRIMARY KEY,
          initialized_at TEXT NOT NULL
        );
      ` + createAuthorityTasksTableSql('schedule_authority_tasks', true));
      const columns = new Set((db.prepare('PRAGMA table_info(schedule_authority_tasks)').all() as Array<{
        name?: unknown;
      }>).flatMap(row => typeof row.name === 'string' ? [row.name] : []));
      if (!columns.has('credential_open_id')) {
        db.exec('ALTER TABLE schedule_authority_tasks ADD COLUMN credential_open_id TEXT;');
      }
      if (!columns.has('self_manage')) {
        db.exec('ALTER TABLE schedule_authority_tasks ADD COLUMN self_manage INTEGER NOT NULL DEFAULT 0;');
      }
      migrateLegacyGrantUnique(db);
      db.exec('COMMIT;');
      return new ScheduleAuthorityStore(db);
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no transaction or already rolled back */ }
      try { db.close(); } catch { /* preserve the initialization error */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** One-time trusted migration. Unknown JSON rows after this marker exists are
   * never auto-classified as legacy. */
  initializeApp(appId: string, existing: readonly ScheduledTask[]): void {
    if (this.isInitialized(appId)) return;
    // Validate the complete migration inventory before opening the transaction.
    // In particular, a marker must never be committed for rows that the
    // authoritative read path cannot subsequently parse. Legacy ownerless rows
    // are valid for the primary daemon, but an explicit different app id is not.
    const validated = existing.map(task => parseTask(JSON.stringify(task), appId));
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const initialized = this.db.prepare(
        'SELECT 1 AS present FROM schedule_authority_apps WHERE app_id = ?',
      ).get(appId) as { present?: number } | undefined;
      if (!initialized) {
        const now = new Date().toISOString();
        const insert = this.db.prepare(`
          INSERT INTO schedule_authority_tasks
            (schema_version, app_id, task_id, kind, state, task_json, canonical_hash,
             control_open_id, control_union_id, run_scopes_json, created_at, updated_at)
          VALUES (1, ?, ?, 'legacy', ?, ?, ?, ?, ?, '[]', ?, ?)
        `);
        for (const task of validated) {
          insert.run(
            appId, task.id, stateFor(task), JSON.stringify(task), taskHash(task),
            task.ownerOpenId ?? null, task.ownerUnionId ?? null, now, now,
          );
        }
        this.db.prepare(
          'INSERT INTO schedule_authority_apps (app_id, initialized_at) VALUES (?, ?)',
        ).run(appId, now);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no-op */ }
      throw error;
    }
  }

  isInitialized(appId: string): boolean {
    return !!this.db.prepare(
      'SELECT 1 AS present FROM schedule_authority_apps WHERE app_id = ?',
    ).get(appId);
  }

  listTasks(appId: string): ScheduledTask[] {
    return this.listRecords(appId).map(record => record.task);
  }

  listRecords(appId: string): ScheduleAuthorityRecord[] {
    return this.db.prepare(`
      SELECT task_id FROM schedule_authority_tasks
      WHERE app_id = ? AND state != 'revoked' ORDER BY created_at ASC, task_id ASC
    `).all(appId).map(row => this.getRecord(appId, String((row as { task_id: unknown }).task_id))!)
      .filter(Boolean);
  }

  getRecord(appId: string, taskId: string): ScheduleAuthorityRecord | undefined {
    const row = this.db.prepare(`
      SELECT schema_version, kind, state, task_json, canonical_hash, control_open_id, control_union_id,
             credential_open_id, run_scopes_json, self_manage, grant_id, request_hash, source_message_id,
             source_session_id, target_turn_id, target_generation
      FROM schedule_authority_tasks WHERE app_id = ? AND task_id = ?
    `).get(appId, taskId) as Record<string, unknown> | undefined;
    if (!row) return;
    if (row.schema_version !== 1) throw new Error('schedule_authority_schema_mismatch');
    let runScopes: unknown;
    try { runScopes = JSON.parse(String(row.run_scopes_json)); }
    catch { throw new Error('schedule_authority_run_scopes_corrupt'); }
    if (!Array.isArray(runScopes)
      || runScopes.some(scope => scope !== 'bytedcli')
      || new Set(runScopes).size !== runScopes.length) {
      throw new Error('schedule_authority_run_scopes_unsupported');
    }
    if (row.self_manage !== 0 && row.self_manage !== 1) {
      throw new Error('schedule_authority_self_manage_corrupt');
    }
    const task = parseTask(row.task_json, appId);
    if (String(row.canonical_hash) !== taskHash(task)) {
      throw new Error('schedule_authority_canonical_mismatch');
    }
    return {
      kind: row.kind as ScheduleAuthorityKind,
      state: row.state as ScheduleAuthorityState,
      task,
      ...(typeof row.control_open_id === 'string' ? { controlOpenId: row.control_open_id } : {}),
      ...(typeof row.control_union_id === 'string' ? { controlUnionId: row.control_union_id } : {}),
      ...(typeof row.credential_open_id === 'string' ? { credentialOpenId: row.credential_open_id } : {}),
      runScopes: runScopes as TriggerUserAuthTool[],
      selfManage: row.self_manage === 1,
      ...(typeof row.grant_id === 'string' ? { grantId: row.grant_id } : {}),
      ...(typeof row.request_hash === 'string' ? { requestHash: row.request_hash } : {}),
      ...(typeof row.source_message_id === 'string' ? { sourceMessageId: row.source_message_id } : {}),
      ...(typeof row.source_session_id === 'string' ? { sourceSessionId: row.source_session_id } : {}),
      ...(typeof row.target_turn_id === 'string' ? { targetTurnId: row.target_turn_id } : {}),
      ...(typeof row.target_generation === 'number' ? { targetGeneration: row.target_generation } : {}),
    };
  }

  createDirect(task: ScheduledTask): ScheduledTask {
    const appId = task.larkAppId;
    if (typeof appId !== 'string' || !appId) {
      throw new Error('schedule_authority_app_required');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.getRecord(appId, task.id);
      if (existing) {
        if (taskHash(existing.task) !== taskHash(task)) throw new Error('schedule_task_id_conflict');
        this.db.exec('COMMIT;');
        return existing.task;
      }
      this.db.prepare(`
        INSERT INTO schedule_authority_tasks
          (schema_version, app_id, task_id, kind, state, task_json, canonical_hash,
           control_open_id, control_union_id, run_scopes_json, created_at, updated_at)
        VALUES (1, ?, ?, 'direct', ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        appId, task.id, stateFor(task), JSON.stringify(task), taskHash(task),
        task.ownerOpenId ?? null, task.ownerUnionId ?? null, now, now,
      );
      this.db.exec('COMMIT;');
      return task;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no-op */ }
      throw error;
    }
  }

  commitDelegated(input: {
    appId: string;
    grantId: string;
    requestHash: string;
    task: ScheduledTask;
    control: DelegatedScheduleControl;
    sourceMessageId: string;
    sourceSessionId: string;
    targetTurnId: string;
    targetGeneration: number;
    maxTasksPerTurn: number;
  }): CommitDelegatedScheduleResult {
    if (!Number.isSafeInteger(input.maxTasksPerTurn) || input.maxTasksPerTurn < 1) {
      throw new Error('schedule_authority_invalid_task_limit');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const prior = this.db.prepare(`
        SELECT app_id, task_id, request_hash, task_json FROM schedule_authority_tasks
        WHERE grant_id = ? AND request_hash = ?
      `).get(input.grantId, input.requestHash) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.app_id !== input.appId || prior.request_hash !== input.requestHash) {
          this.db.exec('ROLLBACK;');
          return { ok: false, error: 'grant_conflict' };
        }
        const task = parseTask(prior.task_json);
        this.db.exec('COMMIT;');
        return { ok: true, task, replay: true };
      }
      const committedForGrant = this.db.prepare(`
        SELECT COUNT(*) AS count FROM schedule_authority_tasks WHERE grant_id = ?
      `).get(input.grantId) as { count?: number | bigint } | undefined;
      if (Number(committedForGrant?.count ?? 0) >= input.maxTasksPerTurn) {
        this.db.exec('ROLLBACK;');
        return { ok: false, error: 'grant_task_limit' };
      }
      const occupied = this.db.prepare(
        'SELECT 1 AS present FROM schedule_authority_tasks WHERE app_id = ? AND task_id = ?',
      ).get(input.appId, input.task.id);
      if (occupied) {
        this.db.exec('ROLLBACK;');
        return { ok: false, error: 'task_id_conflict' };
      }
      this.db.prepare(`
        INSERT INTO schedule_authority_tasks
          (schema_version, app_id, task_id, kind, state, task_json, canonical_hash,
           control_open_id, control_union_id, credential_open_id, run_scopes_json, self_manage, grant_id,
           request_hash, source_message_id, source_session_id, target_turn_id,
           target_generation, created_at, updated_at)
        VALUES (1, ?, ?, 'delegated', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.appId, input.task.id, JSON.stringify(input.task), taskHash(input.task),
        input.control.openId, input.control.unionId,
        input.control.credentialOpenId ?? input.control.openId,
        JSON.stringify(input.control.runScopes ?? []), input.control.selfManage === true ? 1 : 0,
        input.grantId, input.requestHash,
        input.sourceMessageId, input.sourceSessionId, input.targetTurnId,
        input.targetGeneration, now, now,
      );
      beforeCommitTestHook?.();
      this.db.exec('COMMIT;');
      return { ok: true, task: input.task, replay: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no-op */ }
      throw error;
    }
  }

  updateTask(appId: string, taskId: string, mutate: (task: ScheduledTask) => ScheduledTask | undefined): ScheduledTask | undefined {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const record = this.getRecord(appId, taskId);
      if (!record || record.state === 'revoked') {
        this.db.exec('COMMIT;');
        return;
      }
      const next = mutate(structuredClone(record.task));
      if (!next) {
        this.db.exec('COMMIT;');
        return record.task;
      }
      const state = stateFor(next);
      this.db.prepare(`
        UPDATE schedule_authority_tasks
        SET state = ?, task_json = ?, canonical_hash = ?, updated_at = ?
        WHERE app_id = ? AND task_id = ?
      `).run(state, JSON.stringify(next), taskHash(next), new Date().toISOString(), appId, taskId);
      this.db.exec('COMMIT;');
      return next;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no-op */ }
      throw error;
    }
  }

  revoke(appId: string, taskId: string): boolean {
    const result = this.db.prepare(`
      UPDATE schedule_authority_tasks SET state = 'revoked', updated_at = ?
      WHERE app_id = ? AND task_id = ? AND state != 'revoked'
    `).run(new Date().toISOString(), appId, taskId);
    return Number(result.changes) > 0;
  }

  /** Compensation for a direct create whose protected companion setup failed
   * before the operation became externally successful. Delegated grants never
   * use this escape hatch: their consumed receipt/tombstone must survive. */
  rollbackUnpublishedDirectCreate(appId: string, taskId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM schedule_authority_tasks
      WHERE app_id = ? AND task_id = ? AND kind = 'direct' AND grant_id IS NULL
    `).run(appId, taskId);
    return Number(result.changes) > 0;
  }
}
