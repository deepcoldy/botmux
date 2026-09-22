import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  FrozenCommandError,
  frozenCommandExecutorBinaryDigest,
  frozenCommandExecutorRevision,
  frozenCommandFilePath,
  loadFrozenCommandSnapshot,
  normalizeFrozenCommandName,
  parseFrozenCommandCandidate,
  type FrozenCommandSnapshot,
} from './frozen-command.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { logger } from '../utils/logger.js';

export type FrozenCommandLifecycleState = 'active' | 'retired' | 'revoked';
export type FrozenCommandLifecycleAction = 'approve' | 'retire' | 'restore' | 'revoke';

export interface FrozenCommandActor {
  openId?: string;
  unionId?: string;
}

export interface FrozenCommandTombstonePayload {
  status: 'retired';
  at: string;
  by: string;
  reason: string;
  replacement?: string;
  revisionId: string;
}

export interface FrozenCommandLifecycleRecord {
  targetBotId: string;
  commandPath: string;
  command: string;
  state: FrozenCommandLifecycleState;
  /** Tenant-stable identity of the human who first confirmed creation. */
  ownerUnionId?: string;
  specHash?: string;
  executorRevision?: string;
  executorBinaryDigest?: string;
  stateRevisionId: string;
  tombstonePayload?: FrozenCommandTombstonePayload;
  tombstoneHash?: string;
  sourceYaml?: string;
  updatedAt: string;
  confirmedAction?: FrozenCommandLifecycleAction;
}

export type FrozenCommandGate =
  | { kind: 'legacy' }
  | { kind: 'active'; record: FrozenCommandLifecycleRecord }
  | { kind: 'retired'; record: FrozenCommandLifecycleRecord }
  | { kind: 'revoked'; record: FrozenCommandLifecycleRecord }
  | { kind: 'fail_closed'; reason: string; record?: FrozenCommandLifecycleRecord };

export interface FrozenCommandPreparedTransition {
  token: string;
  expiresAt: string;
  command: string;
  action: FrozenCommandLifecycleAction;
  reason: string;
  replacement?: string;
  specHash?: string;
  executorRevision?: string;
  previousSpecHash?: string;
  expectedRevisionId?: string;
}

const DB_DIR = 'frozen-commands';
const DB_NAME = 'approvals.sqlite';
const CONFIRM_TTL_MS = 10 * 60_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const warnedBinaryDrifts = new Set<string>();

export interface FrozenCommandReconcileResult {
  inspected: number;
  repaired: number;
  errors: Array<{ command: string; error: string }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS command_lifecycle (
  target_bot_id TEXT NOT NULL,
  command_path TEXT NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
  owner_union_id TEXT,
  spec_hash TEXT,
  executor_revision TEXT,
  executor_binary_digest TEXT,
  state_revision_id TEXT NOT NULL,
  tombstone_payload_json TEXT,
  tombstone_hash TEXT,
  source_yaml TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(target_bot_id, command_path, command)
);
CREATE TABLE IF NOT EXISTS pending_transitions (
  token_hash TEXT PRIMARY KEY,
  target_bot_id TEXT NOT NULL,
  command_path TEXT NOT NULL,
  command TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','retire','restore','revoke')),
  actor_id TEXT NOT NULL,
  actor_open_id TEXT,
  actor_union_id TEXT,
  owner_union_id TEXT NOT NULL,
  requires_admin INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  replacement TEXT,
  expected_spec_hash TEXT,
  expected_executor_revision TEXT,
  expected_revision_id TEXT,
  candidate_yaml TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_audit (
  revision_id TEXT PRIMARY KEY,
  target_bot_id TEXT NOT NULL,
  command_path TEXT NOT NULL,
  command TEXT NOT NULL,
  action TEXT NOT NULL,
  parent_revision_id TEXT,
  prior_state TEXT,
  next_state TEXT NOT NULL,
  actor_open_id TEXT,
  actor_union_id TEXT,
  owner_union_id TEXT,
  reason TEXT NOT NULL,
  replacement TEXT,
  spec_hash TEXT,
  executor_revision TEXT,
  executor_binary_digest TEXT,
  tombstone_hash TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_expiry ON pending_transitions(expires_at);
`;

function ensureSchemaColumns(db: DatabaseSyncLike): void {
  function addColumn(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(item => item.name === column)) return;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    } catch (error) {
      // Several bot daemons share this host ledger and can cross the same
      // migration edge. Suppress only the proven "another daemon won" case.
      const after = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!after.some(item => item.name === column)) throw error;
    }
  }
  addColumn('pending_transitions', 'candidate_yaml', 'TEXT');
  addColumn('command_lifecycle', 'owner_union_id', 'TEXT');
  addColumn('command_lifecycle', 'executor_revision', 'TEXT');
  addColumn('command_lifecycle', 'executor_binary_digest', 'TEXT');
  addColumn('pending_transitions', 'owner_union_id', 'TEXT');
  addColumn('pending_transitions', 'requires_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('pending_transitions', 'expected_executor_revision', 'TEXT');
  addColumn('command_audit', 'owner_union_id', 'TEXT');
  addColumn('command_audit', 'executor_revision', 'TEXT');
  addColumn('command_audit', 'executor_binary_digest', 'TEXT');

  // The audit actor on the first successful approval is the best available
  // creator identity for ledgers written before per-command ownership existed.
  db.exec(`UPDATE command_lifecycle
    SET owner_union_id = (
      SELECT actor_union_id FROM command_audit
      WHERE command_audit.target_bot_id = command_lifecycle.target_bot_id
        AND command_audit.command_path = command_lifecycle.command_path
        AND command_audit.command = command_lifecycle.command
        AND command_audit.action = 'approve'
        AND command_audit.actor_union_id LIKE 'on_%'
      ORDER BY command_audit.at ASC LIMIT 1
    )
    WHERE owner_union_id IS NULL;`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function frozenCommandSpecHash(snapshot: FrozenCommandSnapshot): string {
  // Lifecycle status is signed separately by the ledger/tombstone. Keeping it
  // out of specHash lets the same executable definition move active ↔ retired
  // without changing its identity.
  const { status: _status, ...executableDefinition } = snapshot.definition;
  void _status;
  return sha256(canonicalJson(executableDefinition));
}

export function frozenCommandTombstoneHash(payload: FrozenCommandTombstonePayload): string {
  return sha256(canonicalJson(payload));
}

function actorId(actor: FrozenCommandActor): string | undefined {
  return actor.unionId?.trim() || actor.openId?.trim() || undefined;
}

function actorUnionId(actor: FrozenCommandActor): string {
  const unionId = actor.unionId?.trim();
  if (!unionId?.startsWith('on_')) {
    throw new FrozenCommandError(
      'transition_actor_untrusted',
      '只有可验证 union_id 的真人可以变更固化命令状态',
    );
  }
  return unionId;
}

function commandKey(workingDir: string, rawCommand: string): { command: string; commandPath: string } {
  const command = normalizeFrozenCommandName(rawCommand);
  if (!command) throw new FrozenCommandError('invalid_command_name', `非法指令名：${rawCommand}`);
  const workingRoot = realpathSync(resolve(workingDir));
  const filePath = frozenCommandFilePath(workingRoot, command);
  let commandPath = resolve(filePath);
  try { commandPath = realpathSync(filePath); }
  catch {
    try { commandPath = join(realpathSync(dirname(filePath)), command + '.yaml'); }
    catch {
      try {
        commandPath = join(realpathSync(dirname(dirname(filePath))), 'commands', command + '.yaml');
      } catch { /* A new .botmux tree remains rooted under the canonical working root. */ }
    }
  }
  const rel = relative(workingRoot, commandPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || resolve(commandPath) === workingRoot) {
    throw new FrozenCommandError('definition_file_invalid', '指令定义越出当前工作目录');
  }
  return { command, commandPath };
}

function databasePath(dataDir: string): string {
  const root = resolve(dataDir);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new FrozenCommandError('lifecycle_store_invalid', '固化命令状态目录禁止使用符号链接');
  }
  const dir = join(root, DB_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
    throw new FrozenCommandError('lifecycle_store_invalid', '固化命令状态目录必须是普通目录');
  }
  chmodSync(dir, 0o700);
  const path = join(dir, DB_NAME);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new FrozenCommandError('lifecycle_store_invalid', '固化命令状态库禁止使用符号链接');
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
    ensureSchemaColumns(db);
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
      try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    }
  }
}

interface LifecycleRow {
  target_bot_id: string;
  command_path: string;
  command: string;
  state: FrozenCommandLifecycleState;
  owner_union_id: string | null;
  spec_hash: string | null;
  executor_revision: string | null;
  executor_binary_digest: string | null;
  state_revision_id: string;
  tombstone_payload_json: string | null;
  tombstone_hash: string | null;
  source_yaml: string | null;
  updated_at: string;
}

function parseRecord(row: LifecycleRow): FrozenCommandLifecycleRecord {
  let tombstonePayload: FrozenCommandTombstonePayload | undefined;
  if (row.tombstone_payload_json) {
    try { tombstonePayload = JSON.parse(row.tombstone_payload_json) as FrozenCommandTombstonePayload; }
    catch { throw new FrozenCommandError('lifecycle_store_corrupt', '固化命令 tombstone 记录损坏'); }
  }
  return {
    targetBotId: row.target_bot_id,
    commandPath: row.command_path,
    command: row.command,
    state: row.state,
    ...(row.owner_union_id ? { ownerUnionId: row.owner_union_id } : {}),
    ...(row.spec_hash ? { specHash: row.spec_hash } : {}),
    ...(row.executor_revision ? { executorRevision: row.executor_revision } : {}),
    ...(row.executor_binary_digest ? { executorBinaryDigest: row.executor_binary_digest } : {}),
    stateRevisionId: row.state_revision_id,
    ...(tombstonePayload ? { tombstonePayload } : {}),
    ...(row.tombstone_hash ? { tombstoneHash: row.tombstone_hash } : {}),
    ...(row.source_yaml ? { sourceYaml: row.source_yaml } : {}),
    updatedAt: row.updated_at,
  };
}

function selectRecord(
  db: DatabaseSyncLike,
  targetBotId: string,
  commandPath: string,
  command: string,
): FrozenCommandLifecycleRecord | undefined {
  const row = db.prepare(`SELECT * FROM command_lifecycle
    WHERE target_bot_id = ? AND command_path = ? AND command = ?`)
    .get(targetBotId, commandPath, command) as LifecycleRow | undefined;
  return row ? parseRecord(row) : undefined;
}

function tombstoneYaml(record: FrozenCommandLifecycleRecord): string {
  const payload = record.tombstonePayload;
  if (!payload || !record.tombstoneHash || !record.specHash) {
    throw new FrozenCommandError('lifecycle_store_corrupt', '废弃记录缺少 tombstone 或 hash');
  }
  return stringifyYaml({
    schemaVersion: 1,
    name: record.command,
    status: 'retired',
    at: payload.at,
    by: payload.by,
    reason: payload.reason,
    ...(payload.replacement ? { replacement: payload.replacement } : {}),
    revisionId: payload.revisionId,
    specHash: record.specHash,
    tombstoneHash: record.tombstoneHash,
  }, { lineWidth: 0 });
}

function isExpectedTombstone(raw: string, record: FrozenCommandLifecycleRecord): boolean {
  try {
    const value = parseYaml(raw) as Record<string, unknown>;
    const allowed = new Set(['schemaVersion', 'name', 'status', 'at', 'by', 'reason', 'replacement', 'revisionId', 'specHash', 'tombstoneHash']);
    if (Object.keys(value ?? {}).some(key => !allowed.has(key))) return false;
    if (value?.status !== 'retired'
      || value?.name !== record.command
      || typeof value?.at !== 'string'
      || typeof value?.by !== 'string'
      || typeof value?.reason !== 'string'
      || typeof value?.revisionId !== 'string'
      || value?.specHash !== record.specHash
      || value?.tombstoneHash !== record.tombstoneHash
      || (value.replacement !== undefined && typeof value.replacement !== 'string')) return false;
    const payload: FrozenCommandTombstonePayload = {
      status: 'retired',
      at: value.at,
      by: value.by,
      reason: value.reason,
      ...(typeof value.replacement === 'string' ? { replacement: value.replacement } : {}),
      revisionId: value.revisionId,
    };
    return payload.revisionId === record.tombstonePayload?.revisionId
      && canonicalJson(payload) === canonicalJson(record.tombstonePayload)
      && frozenCommandTombstoneHash(payload) === record.tombstoneHash;
  } catch {
    return false;
  }
}

function isRetiredYaml(raw: string): boolean {
  try { return (parseYaml(raw) as Record<string, unknown>)?.status === 'retired'; }
  catch { return false; }
}

function reconcileRecord(record: FrozenCommandLifecycleRecord): void {
  if (record.state === 'retired') {
    const raw = existsSync(record.commandPath) ? readFileSync(record.commandPath, 'utf8') : undefined;
    if (!raw || !isExpectedTombstone(raw, record)) {
      if (raw && record.sourceYaml && raw !== record.sourceYaml) {
        throw new FrozenCommandError('lifecycle_definition_conflict', '废弃记录与命令文件冲突，已拒绝自动覆盖');
      }
      atomicWriteFileSync(record.commandPath, tombstoneYaml(record), {
        mode: 0o600,
        durable: true,
        followTargetSymlink: false,
      });
    }
    return;
  }
  if (record.state === 'revoked') {
    if (!existsSync(record.commandPath)) return;
    const stat = lstatSync(record.commandPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new FrozenCommandError('definition_file_invalid', '撤销目标不是普通文件');
    }
    const raw = readFileSync(record.commandPath, 'utf8');
    if (!isExpectedTombstone(raw, record)) {
      throw new FrozenCommandError('lifecycle_definition_conflict', '撤销记录与目标文件冲突，已拒绝删除');
    }
    unlinkSync(record.commandPath);
    return;
  }
  if (!record.sourceYaml) return;
  const raw = existsSync(record.commandPath) ? readFileSync(record.commandPath, 'utf8') : undefined;
  if (!raw || isRetiredYaml(raw)) {
    atomicWriteFileSync(record.commandPath, record.sourceYaml, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
}

export function evaluateFrozenCommandLifecycle(input: {
  dataDir: string;
  targetBotId: string;
  workingDir: string;
  command: string;
  snapshot?: FrozenCommandSnapshot;
}): FrozenCommandGate {
  let key: { command: string; commandPath: string };
  try { key = commandKey(input.workingDir, input.command); }
  catch (error) {
    return { kind: 'fail_closed', reason: error instanceof Error ? error.message : String(error) };
  }
  let record: FrozenCommandLifecycleRecord | undefined;
  try {
    record = withDb(input.dataDir, db => selectRecord(db, input.targetBotId, key.commandPath, key.command));
    if (!record) {
      const snapshot = input.snapshot ?? loadFrozenCommandSnapshot({ workingDir: input.workingDir, command: key.command });
      if (snapshot) {
        try {
          const declared = parseYaml(snapshot.raw) as Record<string, unknown>;
          if (declared?.status === 'active') {
            return { kind: 'fail_closed', reason: '命令声明为 active，但尚未完成宿主批准' };
          }
        } catch { /* the definition loader owns YAML errors */ }
      }
      return { kind: 'legacy' };
    }
    reconcileRecord(record);
    if (record.state === 'retired') return { kind: 'retired', record };
    if (record.state === 'revoked') return { kind: 'revoked', record };
    const snapshot = input.snapshot ?? loadFrozenCommandSnapshot({ workingDir: input.workingDir, command: key.command });
    if (!snapshot) return { kind: 'fail_closed', reason: '已批准的固化命令文件缺失', record };
    const actual = frozenCommandSpecHash(snapshot);
    if (!record.specHash || record.specHash !== actual) {
      return { kind: 'fail_closed', reason: '命令定义与已批准版本不一致', record };
    }
    const currentExecutorRevision = frozenCommandExecutorRevision(snapshot.definition);
    if (!record.executorRevision || record.executorRevision !== currentExecutorRevision) {
      return { kind: 'fail_closed', reason: '执行器配置或脚本与已批准版本不一致，必须重新确认', record };
    }
    const currentBinaryDigest = frozenCommandExecutorBinaryDigest(snapshot.definition);
    if (record.executorBinaryDigest && currentBinaryDigest
      && record.executorBinaryDigest !== currentBinaryDigest) {
      const warningKey = `${record.targetBotId}:${record.commandPath}:${record.command}:${currentBinaryDigest}`;
      if (!warnedBinaryDrifts.has(warningKey)) {
        warnedBinaryDrifts.add(warningKey);
        logger.warn('[frozen-command] third-party executor binary drift detected; execution remains allowed by scheme B', {
          target_bot_id: record.targetBotId,
          command: record.command,
          executor_id: snapshot.definition.executor,
          approved_binary_digest: record.executorBinaryDigest,
          current_binary_digest: currentBinaryDigest,
        });
      }
    }
    return { kind: 'active', record };
  } catch (error) {
    return {
      kind: 'fail_closed',
      reason: error instanceof Error ? error.message : String(error),
      ...(record ? { record } : {}),
    };
  }
}

function normalizeReason(reason: string): string {
  const value = reason.trim();
  if (!value || value.length > 500) throw new FrozenCommandError('transition_reason_invalid', '必须提供 1～500 字的原因');
  return value;
}

function normalizeReplacement(replacement: string | undefined): string | undefined {
  if (!replacement) return undefined;
  const command = normalizeFrozenCommandName(replacement);
  if (!command) throw new FrozenCommandError('transition_replacement_invalid', '替代命令格式不合法');
  return `/${command}`;
}

export function prepareFrozenCommandTransition(input: {
  dataDir: string;
  targetBotId: string;
  workingDir: string;
  command: string;
  action: FrozenCommandLifecycleAction;
  actor: FrozenCommandActor;
  /** Fresh per-Bot break-glass authority. Owners do not need this. */
  actorIsAdmin?: boolean;
  reason: string;
  replacement?: string;
  /** Candidate source for create/update. When present, it is validated and
   * stored in the host ledger but is not written live until confirmation. */
  candidateYaml?: string;
  now?: Date;
}): FrozenCommandPreparedTransition {
  const ownerActor = actorUnionId(input.actor);
  const id = actorId(input.actor)!;
  const key = commandKey(input.workingDir, input.command);
  const now = input.now ?? new Date();
  const reason = normalizeReason(input.reason);
  const replacement = normalizeReplacement(input.replacement);
  if (replacement && input.action !== 'retire') {
    throw new FrozenCommandError('transition_replacement_invalid', '只有废弃操作可以声明替代命令');
  }
  const token = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS).toISOString();
  let preparedSpecHash: string | undefined;
  let preparedExecutorRevision: string | undefined;
  let previousSpecHash: string | undefined;
  let expectedRevisionId: string | undefined;
  withDb(input.dataDir, db => transaction(db, () => {
    const current = selectRecord(db, input.targetBotId, key.commandPath, key.command);
    const definitionExists = existsSync(key.commandPath);
    const requiresAdmin = input.action === 'revoke' || (current?.ownerUnionId
      ? current.ownerUnionId !== ownerActor
      : current !== undefined || definitionExists);
    if (requiresAdmin && !input.actorIsAdmin) {
      throw new FrozenCommandError(
        input.action === 'revoke'
          ? 'transition_admin_required'
          : current?.ownerUnionId ? 'transition_owner_mismatch' : 'transition_owner_missing',
        input.action === 'revoke'
          ? `/${key.command} 的彻底撤销只能由固化命令管理员执行`
          : current?.ownerUnionId
            ? `只有 /${key.command} 的 owner 或固化命令管理员可以变更该命令`
            : `/${key.command} 尚无可验证 owner，只能由固化命令管理员接管`,
      );
    }
    const ownerUnionId = current?.ownerUnionId ?? ownerActor;
    previousSpecHash = current?.specHash;
    expectedRevisionId = current?.stateRevisionId;
    let expectedSpecHash: string | undefined;
    if (input.action === 'approve') {
      const snapshot = input.candidateYaml === undefined
        ? loadFrozenCommandSnapshot({ workingDir: input.workingDir, command: key.command })
        : parseFrozenCommandCandidate({
            workingDir: input.workingDir,
            command: key.command,
            raw: input.candidateYaml,
          });
      if (!snapshot) throw new FrozenCommandError('definition_missing', `未找到 /${key.command}`);
      expectedSpecHash = frozenCommandSpecHash(snapshot);
      preparedExecutorRevision = frozenCommandExecutorRevision(snapshot.definition);
      preparedSpecHash = expectedSpecHash;
      if (current?.state === 'retired' || current?.state === 'revoked') {
        throw new FrozenCommandError('transition_invalid_state', `/${key.command} 当前为 ${current.state}，必须走 restore 而不是 approve`);
      }
    } else if (input.action === 'retire') {
      const snapshot = loadFrozenCommandSnapshot({ workingDir: input.workingDir, command: key.command });
      if (!snapshot) throw new FrozenCommandError('definition_missing', `未找到 /${key.command}`);
      expectedSpecHash = frozenCommandSpecHash(snapshot);
      preparedExecutorRevision = frozenCommandExecutorRevision(snapshot.definition);
      if (current?.state === 'active') {
        if (!current.specHash || !current.sourceYaml) {
          throw new FrozenCommandError('lifecycle_store_corrupt', '已批准命令缺少原始定义或 hash');
        }
        if (expectedSpecHash !== current.specHash) {
          throw new FrozenCommandError(
            'lifecycle_definition_mismatch',
            '命令定义与已批准版本不一致；请先批准新版本，再发起废弃',
          );
        }
        expectedSpecHash = current.specHash;
      }
      preparedSpecHash = expectedSpecHash;
      if (current?.state === 'retired' || current?.state === 'revoked') {
        throw new FrozenCommandError('transition_invalid_state', `/${key.command} 当前为 ${current.state}，不能废弃`);
      }
    } else if (input.action === 'restore') {
      if (current?.state !== 'retired' || !current.sourceYaml || !current.specHash) {
        throw new FrozenCommandError('transition_invalid_state', `/${key.command} 不是 retired 状态或恢复资料不完整`);
      }
      const snapshot = parseFrozenCommandCandidate({
        workingDir: input.workingDir,
        command: key.command,
        raw: current.sourceYaml,
      });
      preparedSpecHash = current.specHash;
      preparedExecutorRevision = frozenCommandExecutorRevision(snapshot.definition);
    } else if (input.action === 'revoke' && current?.state !== 'retired') {
      throw new FrozenCommandError('transition_invalid_state', `/${key.command} 必须先 retired 才能彻底撤销`);
    }
    db.prepare('DELETE FROM pending_transitions WHERE expires_at <= ?').run(now.toISOString());
    db.prepare(`INSERT INTO pending_transitions (
      token_hash,target_bot_id,command_path,command,action,actor_id,actor_open_id,actor_union_id,
      owner_union_id,requires_admin,reason,replacement,expected_spec_hash,expected_revision_id,
      expected_executor_revision,candidate_yaml,expires_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sha256(token), input.targetBotId, key.commandPath, key.command, input.action, id,
      input.actor.openId ?? null, ownerActor, ownerUnionId, requiresAdmin ? 1 : 0,
      reason, replacement ?? null,
      expectedSpecHash ?? null, current?.stateRevisionId ?? null, preparedExecutorRevision ?? current?.executorRevision ?? null,
      input.candidateYaml ?? null,
      expiresAt, now.toISOString(),
    );
  }));
  return {
    token,
    expiresAt,
    command: key.command,
    action: input.action,
    reason,
    ...(replacement ? { replacement } : {}),
    ...(preparedSpecHash ? { specHash: preparedSpecHash } : {}),
    ...(preparedExecutorRevision ? { executorRevision: preparedExecutorRevision } : {}),
    ...(previousSpecHash ? { previousSpecHash } : {}),
    ...(expectedRevisionId ? { expectedRevisionId } : {}),
  };
}

interface PendingRow {
  token_hash: string;
  target_bot_id: string;
  command_path: string;
  command: string;
  action: FrozenCommandLifecycleAction;
  actor_id: string;
  actor_open_id: string | null;
  actor_union_id: string | null;
  owner_union_id: string | null;
  requires_admin: number;
  reason: string;
  replacement: string | null;
  expected_spec_hash: string | null;
  expected_executor_revision: string | null;
  expected_revision_id: string | null;
  candidate_yaml: string | null;
  expires_at: string;
}

export function confirmFrozenCommandTransition(input: {
  dataDir: string;
  targetBotId: string;
  token: string;
  actor: FrozenCommandActor;
  /** Re-read at click time; required only for admin overrides/legacy claims. */
  actorIsAdmin?: boolean;
  now?: Date;
}): FrozenCommandLifecycleRecord {
  const ownerActor = actorUnionId(input.actor);
  const id = actorId(input.actor)!;
  const now = input.now ?? new Date();
  const record = withDb(input.dataDir, db => transaction(db, () => {
    const pending = db.prepare('SELECT * FROM pending_transitions WHERE token_hash = ?')
      .get(sha256(input.token)) as PendingRow | undefined;
    if (!pending || pending.target_bot_id !== input.targetBotId) {
      throw new FrozenCommandError('transition_confirmation_invalid', '确认码不存在或不属于当前 Bot');
    }
    if (pending.actor_id !== id) {
      throw new FrozenCommandError('transition_confirmation_actor_mismatch', '必须由发起变更的同一真人确认');
    }
    if (!pending.owner_union_id?.startsWith('on_')) {
      throw new FrozenCommandError('transition_stale', '旧版确认卡缺少 owner 绑定，请重新发起');
    }
    if (Date.parse(pending.expires_at) <= now.getTime()) {
      db.prepare('DELETE FROM pending_transitions WHERE token_hash = ?').run(pending.token_hash);
      throw new FrozenCommandError('transition_confirmation_expired', '确认已过期，请重新发起');
    }
    const current = selectRecord(db, pending.target_bot_id, pending.command_path, pending.command);
    if ((pending.expected_revision_id ?? null) !== (current?.stateRevisionId ?? null)) {
      throw new FrozenCommandError('transition_stale', '命令状态在确认前已变化，请重新发起');
    }
    if (pending.requires_admin === 1 && !input.actorIsAdmin) {
      throw new FrozenCommandError('transition_admin_required', '管理员权限已失效，请重新发起');
    }
    // Defense in depth: actor_id + requires_admin already protect today's
    // flow, but keep this owner check local to confirmation so a future
    // proposal/refactor cannot accidentally turn the click path fail-open.
    if (current?.ownerUnionId && current.ownerUnionId !== ownerActor && !input.actorIsAdmin) {
      throw new FrozenCommandError('transition_owner_mismatch', '只有命令 owner 或固化命令管理员可以确认变更');
    }
    if (current?.ownerUnionId && current.ownerUnionId !== pending.owner_union_id) {
      throw new FrozenCommandError('transition_stale', '命令 owner 在确认前已变化，请重新发起');
    }
    if (!current && pending.requires_admin === 0 && existsSync(pending.command_path)) {
      throw new FrozenCommandError('transition_stale', '同名命令在确认前已出现，请重新发起');
    }
    const revisionId = randomUUID();
    let nextState: FrozenCommandLifecycleState;
    let specHash = current?.specHash;
    let executorRevision = current?.executorRevision;
    let executorBinaryDigest = current?.executorBinaryDigest;
    let sourceYaml = current?.sourceYaml;
    let tombstonePayload: FrozenCommandTombstonePayload | undefined;
    let tombstoneHash: string | undefined;
    if (pending.action === 'approve') {
      if (current?.state === 'retired' || current?.state === 'revoked') {
        throw new FrozenCommandError('transition_invalid_state', `/${pending.command} 当前为 ${current.state}`);
      }
      const workingDir = dirname(dirname(dirname(pending.command_path)));
      const snapshot = pending.candidate_yaml === null
        ? loadFrozenCommandSnapshot({ workingDir, command: pending.command })
        : parseFrozenCommandCandidate({
            workingDir,
            command: pending.command,
            raw: pending.candidate_yaml,
          });
      if (!snapshot) throw new FrozenCommandError('definition_missing', '待批准命令已不存在');
      sourceYaml = snapshot.raw;
      specHash = frozenCommandSpecHash(snapshot);
      if (specHash !== pending.expected_spec_hash) {
        throw new FrozenCommandError('transition_stale', '命令定义在确认前已变化，请重新发起批准');
      }
      executorRevision = frozenCommandExecutorRevision(snapshot.definition);
      if (executorRevision !== pending.expected_executor_revision) {
        throw new FrozenCommandError('transition_stale', '执行器配置或脚本在确认前已变化，请重新发起批准');
      }
      executorBinaryDigest = frozenCommandExecutorBinaryDigest(snapshot.definition);
      nextState = 'active';
      tombstonePayload = undefined;
      tombstoneHash = undefined;
    } else if (pending.action === 'retire') {
      if (current?.state === 'retired' || current?.state === 'revoked') {
        throw new FrozenCommandError('transition_invalid_state', `/${pending.command} 当前为 ${current.state}`);
      }
      const snapshot = loadFrozenCommandSnapshot({
        workingDir: dirname(dirname(dirname(pending.command_path))),
        command: pending.command,
      });
      if (!existsSync(pending.command_path)) throw new FrozenCommandError('definition_missing', '待废弃命令已不存在');
      const stat = lstatSync(pending.command_path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new FrozenCommandError('definition_file_invalid', '待废弃命令不是普通文件');
      const diskYaml = readFileSync(pending.command_path, 'utf8');
      if (!snapshot) throw new FrozenCommandError('definition_missing', '待废弃命令已不存在');
      const diskSpecHash = frozenCommandSpecHash(snapshot);
      const diskExecutorRevision = frozenCommandExecutorRevision(snapshot.definition);
      const diskExecutorBinaryDigest = frozenCommandExecutorBinaryDigest(snapshot.definition);
      if (diskSpecHash !== pending.expected_spec_hash) {
        throw new FrozenCommandError('transition_stale', '命令定义在确认前已变化，请重新发起废弃');
      }
      if (diskExecutorRevision !== pending.expected_executor_revision) {
        throw new FrozenCommandError('transition_stale', '执行器配置或脚本在确认前已变化，请重新发起废弃');
      }
      if (current?.state === 'active') {
        if (!current.specHash || !current.sourceYaml || diskSpecHash !== current.specHash) {
          throw new FrozenCommandError(
            'lifecycle_definition_mismatch',
            '命令定义与已批准版本不一致；请先批准新版本，再发起废弃',
          );
        }
        // Retirement must preserve the bytes/hash that were explicitly
        // approved. Semantically equivalent comment/format edits on disk must
        // not silently become the source restored by a later transition.
        sourceYaml = current.sourceYaml;
        specHash = current.specHash;
        executorRevision = current.executorRevision;
        executorBinaryDigest = current.executorBinaryDigest;
      } else {
        sourceYaml = diskYaml;
        specHash = diskSpecHash;
        executorRevision = diskExecutorRevision;
        executorBinaryDigest = diskExecutorBinaryDigest;
      }
      tombstonePayload = {
        status: 'retired',
        at: now.toISOString(),
        by: id,
        reason: pending.reason,
        ...(pending.replacement ? { replacement: pending.replacement } : {}),
        revisionId,
      };
      tombstoneHash = frozenCommandTombstoneHash(tombstonePayload);
      nextState = 'retired';
    } else if (pending.action === 'restore') {
      if (current?.state !== 'retired' || !current.sourceYaml || !current.specHash) {
        throw new FrozenCommandError('transition_invalid_state', '只有完整的 retired 记录可以恢复');
      }
      const snapshot = parseFrozenCommandCandidate({
        workingDir: dirname(dirname(dirname(pending.command_path))),
        command: pending.command,
        raw: current.sourceYaml,
      });
      executorRevision = frozenCommandExecutorRevision(snapshot.definition);
      if (executorRevision !== pending.expected_executor_revision) {
        throw new FrozenCommandError('transition_stale', '执行器配置或脚本在确认前已变化，请重新发起恢复');
      }
      executorBinaryDigest = frozenCommandExecutorBinaryDigest(snapshot.definition);
      nextState = 'active';
      tombstonePayload = undefined;
      tombstoneHash = undefined;
    } else {
      if (current?.state !== 'retired') throw new FrozenCommandError('transition_invalid_state', '只有 retired 命令可以彻底撤销');
      nextState = 'revoked';
      tombstonePayload = current.tombstonePayload;
      tombstoneHash = current.tombstoneHash;
      // Revocation is the irreversible purge state. Keep hashes + audit
      // metadata, but remove the executable SQL bytes from the authority DB.
      sourceYaml = undefined;
    }
    if (!specHash || !HASH_RE.test(specHash)) throw new FrozenCommandError('lifecycle_hash_invalid', '命令定义 hash 缺失');
    if (!executorRevision || !HASH_RE.test(executorRevision)) throw new FrozenCommandError('lifecycle_hash_invalid', '执行器 revision 缺失');
    db.prepare(`INSERT INTO command_lifecycle (
      target_bot_id,command_path,command,state,owner_union_id,spec_hash,executor_revision,executor_binary_digest,state_revision_id,
      tombstone_payload_json,tombstone_hash,source_yaml,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target_bot_id,command_path,command) DO UPDATE SET
      state=excluded.state,owner_union_id=excluded.owner_union_id,
      spec_hash=excluded.spec_hash,executor_revision=excluded.executor_revision,
      executor_binary_digest=excluded.executor_binary_digest,state_revision_id=excluded.state_revision_id,
      tombstone_payload_json=excluded.tombstone_payload_json,tombstone_hash=excluded.tombstone_hash,
      source_yaml=excluded.source_yaml,updated_at=excluded.updated_at`).run(
      pending.target_bot_id, pending.command_path, pending.command, nextState,
      pending.owner_union_id, specHash, executorRevision, executorBinaryDigest ?? null, revisionId,
      tombstonePayload ? JSON.stringify(tombstonePayload) : null, tombstoneHash ?? null,
      sourceYaml ?? null, now.toISOString(),
    );
    db.prepare(`INSERT INTO command_audit (
      revision_id,target_bot_id,command_path,command,action,prior_state,next_state,
      parent_revision_id,actor_open_id,actor_union_id,owner_union_id,
      reason,replacement,spec_hash,executor_revision,executor_binary_digest,tombstone_hash,at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      revisionId, pending.target_bot_id, pending.command_path, pending.command, pending.action,
      current?.state ?? 'legacy', nextState, current?.stateRevisionId ?? null,
      pending.actor_open_id, pending.actor_union_id, pending.owner_union_id,
      pending.reason, pending.replacement, specHash, executorRevision, executorBinaryDigest ?? null,
      tombstoneHash ?? null, now.toISOString(),
    );
    db.prepare('DELETE FROM pending_transitions WHERE token_hash = ?').run(pending.token_hash);
    return {
      ...selectRecord(db, pending.target_bot_id, pending.command_path, pending.command)!,
      confirmedAction: pending.action,
    };
  }));
  // State + audit commit first. A crash or write failure leaves a more
  // restrictive durable state; the next lookup/restart lazily reconciles it.
  if (record.confirmedAction === 'approve' && record.sourceYaml) {
    // Candidate approvals commit authority first, then publish the exact bytes.
    // A write failure therefore leaves the command fail-closed rather than
    // executable without a matching audit revision.
    mkdirSync(dirname(record.commandPath), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(record.commandPath, record.sourceYaml, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } else {
    reconcileRecord(record);
  }
  return record;
}

export function cancelFrozenCommandTransition(input: {
  dataDir: string;
  targetBotId: string;
  token: string;
  actor: FrozenCommandActor;
  now?: Date;
}): FrozenCommandPreparedTransition {
  const id = actorId(input.actor);
  if (!id) throw new FrozenCommandError('transition_actor_untrusted', '只有发起确认的真人可以取消状态变更');
  const now = input.now ?? new Date();
  return withDb(input.dataDir, db => transaction(db, () => {
    const pending = db.prepare('SELECT * FROM pending_transitions WHERE token_hash = ?')
      .get(sha256(input.token)) as PendingRow | undefined;
    if (!pending || pending.target_bot_id !== input.targetBotId) {
      throw new FrozenCommandError('transition_confirmation_invalid', '确认已失效，请重新发起');
    }
    if (pending.actor_id !== id) {
      throw new FrozenCommandError('transition_confirmation_actor_mismatch', '必须由发起变更的同一真人取消');
    }
    if (Date.parse(pending.expires_at) <= now.getTime()) {
      db.prepare('DELETE FROM pending_transitions WHERE token_hash = ?').run(pending.token_hash);
      throw new FrozenCommandError('transition_confirmation_expired', '确认已过期，请重新发起');
    }
    db.prepare('DELETE FROM pending_transitions WHERE token_hash = ?').run(pending.token_hash);
    return {
      token: input.token,
      expiresAt: pending.expires_at,
      command: pending.command,
      action: pending.action,
      reason: pending.reason,
      ...(pending.replacement ? { replacement: pending.replacement } : {}),
      ...(pending.expected_spec_hash ? { specHash: pending.expected_spec_hash } : {}),
      ...(pending.expected_executor_revision ? { executorRevision: pending.expected_executor_revision } : {}),
      ...(pending.expected_revision_id ? { expectedRevisionId: pending.expected_revision_id } : {}),
    };
  }));
}

export function listFrozenCommandLifecycleAudit(input: {
  dataDir: string;
  targetBotId: string;
  command?: string;
}): unknown[] {
  return withDb(input.dataDir, db => {
    if (input.command) {
      const command = normalizeFrozenCommandName(input.command);
      if (!command) return [];
      return db.prepare(`SELECT * FROM command_audit
        WHERE target_bot_id = ? AND command = ? ORDER BY at ASC`).all(input.targetBotId, command);
    }
    return db.prepare(`SELECT * FROM command_audit
      WHERE target_bot_id = ? ORDER BY at ASC`).all(input.targetBotId);
  });
}

export function listFrozenCommandLifecycleRecords(input: {
  dataDir: string;
  targetBotId: string;
  workingDir: string;
}): FrozenCommandLifecycleRecord[] {
  const workingRoot = realpathSync(resolve(input.workingDir));
  return withDb(input.dataDir, db => (db.prepare(`SELECT * FROM command_lifecycle
    WHERE target_bot_id = ? ORDER BY command ASC`).all(input.targetBotId) as LifecycleRow[])
    .map(parseRecord)
    .filter(record => dirname(dirname(dirname(record.commandPath))) === workingRoot));
}

export function reconcileFrozenCommandLifecycleAtStartup(input: {
  dataDir: string;
  targetBotId: string;
}): FrozenCommandReconcileResult {
  const path = join(resolve(input.dataDir), DB_DIR, DB_NAME);
  if (!existsSync(path)) return { inspected: 0, repaired: 0, errors: [] };
  return withDb(input.dataDir, db => {
    const records = (db.prepare(`SELECT * FROM command_lifecycle
      WHERE target_bot_id = ? ORDER BY command ASC`).all(input.targetBotId) as LifecycleRow[]).map(parseRecord);
    const result: FrozenCommandReconcileResult = { inspected: records.length, repaired: 0, errors: [] };
    for (const record of records) {
      try {
        const before = existsSync(record.commandPath) ? readFileSync(record.commandPath, 'utf8') : undefined;
        reconcileRecord(record);
        const after = existsSync(record.commandPath) ? readFileSync(record.commandPath, 'utf8') : undefined;
        if (before !== after) result.repaired += 1;
      } catch (error) {
        result.errors.push({ command: record.command, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
}
