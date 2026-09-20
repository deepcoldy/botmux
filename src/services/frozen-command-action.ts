import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

export type FrozenCommandActionStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired';

export interface FrozenCommandActionRecord {
  id: string;
  status: FrozenCommandActionStatus;
  targetBotId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  rootMessageId: string;
  scope: 'thread' | 'chat';
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
  workingDir: string;
  sourceMessageId: string;
  sourceContentHash: string;
  intentSchemaVersion: string;
  parserVersion: string;
  actorOpenId: string;
  actorUnionId: string;
  command: string;
  rawArgs: string;
  normalizedArgs: Array<{ name: string; label: string; value: string }>;
  datasource?: string;
  specHash: string;
  revisionId: string;
  cardMessageId?: string;
  callbackEventId?: string;
  queryId?: string;
  errorCode?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface CreateFrozenCommandActionInput
  extends Omit<FrozenCommandActionRecord,
    'id' | 'status' | 'cardMessageId' | 'queryId' | 'errorCode' | 'createdAt' | 'expiresAt' | 'updatedAt'> {
  ttlMs?: number;
  now?: Date;
}

export interface CreatedFrozenCommandAction {
  record: FrozenCommandActionRecord;
  nonce: string;
}

const ACTION_TTL_MS = 10 * 60_000;
const DB_DIR = 'frozen-commands';
const DB_NAME = 'actions.sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS command_actions (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed','expired')),
  target_bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK(chat_type IN ('group','p2p')),
  root_message_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('thread','chat')),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  dispatch_attempt INTEGER NOT NULL,
  working_dir TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  intent_schema_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  actor_open_id TEXT NOT NULL,
  actor_union_id TEXT NOT NULL,
  command TEXT NOT NULL,
  raw_args TEXT NOT NULL,
  normalized_args_json TEXT NOT NULL,
  datasource TEXT,
  spec_hash TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  card_message_id TEXT,
  callback_event_id TEXT,
  query_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_actions_expiry
  ON command_actions(status, expires_at);
`;

interface ActionRow {
  id: string;
  status: FrozenCommandActionStatus;
  target_bot_id: string;
  chat_id: string;
  chat_type: 'group' | 'p2p';
  root_message_id: string;
  scope: 'thread' | 'chat';
  session_id: string;
  turn_id: string;
  dispatch_attempt: number;
  working_dir: string;
  source_message_id: string;
  source_content_hash: string;
  intent_schema_version: string;
  parser_version: string;
  actor_open_id: string;
  actor_union_id: string;
  command: string;
  raw_args: string;
  normalized_args_json: string;
  datasource: string | null;
  spec_hash: string;
  revision_id: string;
  card_message_id: string | null;
  callback_event_id: string | null;
  query_id: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function databasePath(dataDir: string): string {
  const root = resolve(dataDir);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error('固化命令动作目录禁止使用符号链接');
  }
  const dir = join(root, DB_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
    throw new Error('固化命令动作目录必须是普通目录');
  }
  chmodSync(dir, 0o700);
  const path = join(dir, DB_NAME);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('固化命令动作库禁止使用符号链接');
  }
  return path;
}

function withDb<T>(dataDir: string, operation: (db: DatabaseSyncLike) => T): T {
  const path = databasePath(dataDir);
  const db = openDatabaseSyncOrThrow(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec(SCHEMA);
    return operation(db);
  } finally {
    db.close();
  }
}

function transaction<T>(db: DatabaseSyncLike, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = operation();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
    }
  }
}

function parseRow(row: ActionRow): FrozenCommandActionRecord {
  let normalizedArgs: FrozenCommandActionRecord['normalizedArgs'];
  try {
    normalizedArgs = JSON.parse(row.normalized_args_json) as FrozenCommandActionRecord['normalizedArgs'];
  } catch {
    throw new Error('固化命令动作参数记录损坏');
  }
  return {
    id: row.id,
    status: row.status,
    targetBotId: row.target_bot_id,
    chatId: row.chat_id,
    chatType: row.chat_type,
    rootMessageId: row.root_message_id,
    scope: row.scope,
    sessionId: row.session_id,
    turnId: row.turn_id,
    dispatchAttempt: Number(row.dispatch_attempt),
    workingDir: row.working_dir,
    sourceMessageId: row.source_message_id,
    sourceContentHash: row.source_content_hash,
    intentSchemaVersion: row.intent_schema_version,
    parserVersion: row.parser_version,
    actorOpenId: row.actor_open_id,
    actorUnionId: row.actor_union_id,
    command: row.command,
    rawArgs: row.raw_args,
    normalizedArgs,
    ...(row.datasource ? { datasource: row.datasource } : {}),
    specHash: row.spec_hash,
    revisionId: row.revision_id,
    ...(row.card_message_id ? { cardMessageId: row.card_message_id } : {}),
    ...(row.callback_event_id ? { callbackEventId: row.callback_event_id } : {}),
    ...(row.query_id ? { queryId: row.query_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function selectAction(db: DatabaseSyncLike, id: string): FrozenCommandActionRecord | undefined {
  const row = db.prepare('SELECT * FROM command_actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function createFrozenCommandAction(
  dataDir: string,
  input: CreateFrozenCommandActionInput,
): CreatedFrozenCommandAction {
  const now = input.now ?? new Date();
  const id = randomUUID();
  const nonce = randomBytes(24).toString('base64url');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? ACTION_TTL_MS)).toISOString();
  withDb(dataDir, db => transaction(db, () => {
    db.prepare(`INSERT INTO command_actions (
      id,nonce_hash,status,target_bot_id,chat_id,chat_type,root_message_id,scope,
      session_id,turn_id,dispatch_attempt,working_dir,source_message_id,source_content_hash,
      intent_schema_version,parser_version,
      actor_open_id,actor_union_id,command,raw_args,normalized_args_json,datasource,
      spec_hash,revision_id,created_at,expires_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, sha256(nonce), 'pending', input.targetBotId, input.chatId, input.chatType,
      input.rootMessageId, input.scope, input.sessionId, input.turnId,
      input.dispatchAttempt, input.workingDir, input.sourceMessageId,
      input.sourceContentHash, input.intentSchemaVersion, input.parserVersion,
      input.actorOpenId, input.actorUnionId, input.command,
      input.rawArgs, JSON.stringify(input.normalizedArgs), input.datasource ?? null,
      input.specHash, input.revisionId, createdAt, expiresAt, createdAt,
    );
  }));
  return {
    nonce,
    record: {
      id,
      status: 'pending',
      targetBotId: input.targetBotId,
      chatId: input.chatId,
      chatType: input.chatType,
      rootMessageId: input.rootMessageId,
      scope: input.scope,
      sessionId: input.sessionId,
      turnId: input.turnId,
      dispatchAttempt: input.dispatchAttempt,
      workingDir: input.workingDir,
      sourceMessageId: input.sourceMessageId,
      sourceContentHash: input.sourceContentHash,
      intentSchemaVersion: input.intentSchemaVersion,
      parserVersion: input.parserVersion,
      actorOpenId: input.actorOpenId,
      actorUnionId: input.actorUnionId,
      command: input.command,
      rawArgs: input.rawArgs,
      normalizedArgs: input.normalizedArgs,
      ...(input.datasource ? { datasource: input.datasource } : {}),
      specHash: input.specHash,
      revisionId: input.revisionId,
      createdAt,
      expiresAt,
      updatedAt: createdAt,
    },
  };
}

export function getFrozenCommandAction(
  dataDir: string,
  id: string,
): FrozenCommandActionRecord | undefined {
  return withDb(dataDir, db => selectAction(db, id));
}

export function bindFrozenCommandActionCard(
  dataDir: string,
  id: string,
  cardMessageId: string,
  now = new Date(),
): boolean {
  return withDb(dataDir, db => Number(db.prepare(`UPDATE command_actions
    SET card_message_id = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND card_message_id IS NULL`)
    .run(cardMessageId, now.toISOString(), id).changes) === 1);
}

/** Terminalize an action that could not be presented as a usable confirmation
 * card. This transition is intentionally limited to pending so it can never
 * overwrite an executing/completed query outcome. */
export function expirePendingFrozenCommandAction(input: {
  dataDir: string;
  id: string;
  errorCode: string;
  now?: Date;
}): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return withDb(input.dataDir, db => Number(db.prepare(`UPDATE command_actions
    SET status='expired',error_code=?,updated_at=?
    WHERE id=? AND status='pending'`)
    .run(input.errorCode, now, input.id).changes) === 1);
}

export type FrozenCommandActionClaimResult =
  | { kind: 'claimed'; record: FrozenCommandActionRecord }
  | { kind: 'already'; record: FrozenCommandActionRecord }
  | { kind: 'expired'; record: FrozenCommandActionRecord }
  | { kind: 'rejected'; reason: string; record?: FrozenCommandActionRecord };

export function claimFrozenCommandAction(input: {
  dataDir: string;
  id: string;
  nonce: string;
  targetBotId: string;
  cardMessageId: string;
  chatId: string;
  actorOpenId: string;
  actorUnionId: string;
  callbackEventId?: string;
  now?: Date;
}): FrozenCommandActionClaimResult {
  const now = input.now ?? new Date();
  return withDb(input.dataDir, db => transaction(db, () => {
    const row = db.prepare('SELECT nonce_hash FROM command_actions WHERE id = ?').get(input.id) as { nonce_hash: string } | undefined;
    const current = selectAction(db, input.id);
    if (!row || !current) return { kind: 'rejected', reason: 'action_not_found' };
    if (row.nonce_hash !== sha256(input.nonce)) return { kind: 'rejected', reason: 'nonce_mismatch' };
    if (current.targetBotId !== input.targetBotId
      || current.cardMessageId !== input.cardMessageId
      || current.chatId !== input.chatId
      || current.actorOpenId !== input.actorOpenId
      || current.actorUnionId !== input.actorUnionId) {
      return { kind: 'rejected', reason: 'binding_mismatch', record: current };
    }
    if (current.status !== 'pending') return { kind: 'already', record: current };
    if (current.expiresAt <= now.toISOString()) {
      db.prepare(`UPDATE command_actions SET status='expired',updated_at=?
        WHERE id=? AND status='pending'`).run(now.toISOString(), input.id);
      return { kind: 'expired', record: { ...current, status: 'expired', updatedAt: now.toISOString() } };
    }
    const changed = db.prepare(`UPDATE command_actions SET status='executing',callback_event_id=?,updated_at=?
      WHERE id=? AND status='pending'`).run(input.callbackEventId ?? null, now.toISOString(), input.id);
    if (Number(changed.changes) !== 1) {
      const raced = selectAction(db, input.id);
      return raced
        ? { kind: 'already', record: raced }
        : { kind: 'rejected', reason: 'action_not_found' };
    }
    return {
      kind: 'claimed',
      record: {
        ...current,
        status: 'executing',
        ...(input.callbackEventId ? { callbackEventId: input.callbackEventId } : {}),
        updatedAt: now.toISOString(),
      },
    };
  }));
}

export function settleFrozenCommandAction(input: {
  dataDir: string;
  id: string;
  status: 'completed' | 'failed';
  queryId?: string;
  errorCode?: string;
  now?: Date;
}): boolean {
  const now = (input.now ?? new Date()).toISOString();
  return withDb(input.dataDir, db => Number(db.prepare(`UPDATE command_actions
    SET status=?,query_id=?,error_code=?,updated_at=?
    WHERE id=? AND status='executing'`)
    .run(input.status, input.queryId ?? null, input.errorCode ?? null, now, input.id).changes) === 1);
}

/** Crash recovery is deliberately fail-closed: an executing read may already
 * have reached Data MCP, so it is never replayed after daemon restart. */
export function expireInterruptedFrozenCommandActions(
  dataDir: string,
  targetBotId: string,
  now = new Date(),
): number {
  return withDb(dataDir, db => Number(db.prepare(`UPDATE command_actions
    SET status='failed',error_code='execution_interrupted',updated_at=?
    WHERE status='executing' AND target_bot_id=?`).run(now.toISOString(), targetBotId).changes));
}
