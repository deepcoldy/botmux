import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync, copyFileSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { DAEMON_HEARTBEAT_STALE_MS } from '../utils/daemon-heartbeat.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { getSessionTokenUsage } from '../core/cost-calculator.js';
import { deleteFrozenCards } from './frozen-card-store.js';
import { removePromptContextDir } from './prompt-context-store.js';
import { removeStatuslineDir } from './statusline-snapshot.js';
import {
  applySessionRowCommand,
  type HostSessionCommand,
  type SessionRowRefusal,
  type SessionRowReleased,
} from './session-commands.js';
import {
  openDatabaseSyncOrThrow,
  sqliteEngineAvailable,
  type DatabaseSyncLike,
  type StatementLike,
} from './sqlite-compat.js';
import type {
  HumanLaneIdentityEvidence,
  HumanLanePrincipal,
  InboundPrincipal,
  MessageProvenance,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  PrincipalLaneWorktreeProof,
  Session,
} from '../types.js';
import {
  decideLegacySourceMigration,
  lanePrincipalKey,
  parsePrincipalLaneBinding,
  parsePrincipalLaneSourceState,
  sourceSessionDisplayTarget,
} from '../core/principal-lane-routing.js';
import {
  materializePrincipalLaneWorktree,
  parsePrincipalLaneWorktreeProof,
  principalLaneWorktreeMaterializationId,
  readPrincipalLaneGitIdentity,
  type PrincipalLaneWorktreeMaterialization,
} from '../core/principal-lane-worktree.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  parsePrincipalWorkspaceTicket,
  parsePrincipalWorkspaceTicketLocator,
  parsePrincipalWorkspaceTicketSequence,
  parsePrincipalWorkspaceGroup,
  parsePrincipalWorkspaceMember,
  principalWorkspaceGroupIdV2,
  principalWorkspaceTicketIdV1,
  type PrincipalWorkspaceGroup,
  type PrincipalWorkspaceMember,
  type PrincipalWorkspaceTicket,
  type PrincipalWorkspaceTicketAuditEvent,
  type PrincipalWorkspaceTicketLocator,
  type PrincipalWorkspaceTicketSequence,
} from '../core/principal-workspace-admission.js';
import type { PrincipalLaneDispatchAuthority } from '../core/principal-lane-dispatch.js';
import {
  inventoryPrincipalLaneQueueRecords,
  principalLaneAppendReceiptLocator,
  type PrincipalLaneAppendReceipt,
  type PrincipalLaneQueueHandle,
} from './message-queue.js';
import { configuredCodexInstanceBot, newSessionCodexInstanceState, legacyCodexInstanceBinding, type SessionCreationSource } from './codex-instance-pool.js';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { resolveCliRuntime, snapshotCliRuntime } from '../adapters/cli/runtime.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;
let currentAppId: string | undefined;
let migratedCodexInstanceConfig: string | undefined;
let resolveGroupDefaultModels: ((chatId: string) => Session['groupDefaultModels']) | undefined;
// Only the store-owning daemon process may create/import the SQLite store.
// Workers spawned from a NEWER dist by a still-running OLDER daemon must not
// bootstrap a .db while that daemon keeps writing JSON — the mixed upgrade
// window would fork the two representations.
let sqliteBootstrapAllowed = true;
let loadFailure: Error | undefined;

/**
 * The compatibility reader deliberately exposes an empty projection after a
 * read/parse failure. Destructive callers must use the strict API below so an
 * unreadable store cannot be mistaken for "there are no durable sessions".
 */
export class SessionStoreUnavailableError extends Error {
  override readonly name = 'SessionStoreUnavailableError';

  constructor(readonly loadError: Error) {
    super(`session store is unavailable: ${loadError.message}`);
  }
}

/** A nonblocking owned-store mutation could not acquire SQLite's write lock.
 * Callers may retry after yielding the event loop; no transaction or cache
 * mutation was published. */
export class SessionStoreBusyError extends Error {
  override readonly name = 'SessionStoreBusyError';
  readonly code = 'session_store_busy';

  constructor(readonly storeError: unknown) {
    super(`session store is busy: ${storeError instanceof Error ? storeError.message : String(storeError)}`);
  }
}


// Legacy fields from the removed「处理中」placeholder-card PATCH delivery. They
// no longer exist on `Session`, so no code path can produce them any more —
// only rows persisted before the removal carry them. Stripping happens ONCE,
// while importing those rows; every row the SQLite engine has ever written is
// clean by construction, so the write paths do not re-check.
const LEGACY_PENDING_CARD_FIELDS = ['pendingResponseCardId', 'pendingResponseCardState', 'lastPatchedResponseCardId'] as const;
function stripLegacyPendingCardFields(session: Record<string, unknown>): void {
  for (const f of LEGACY_PENDING_CARD_FIELDS) delete session[f];
}

// ─── SQLite engine ───────────────────────────────────────────────────────────
// Per-bot session rows live in `session-stores/<appId>/sessions.db` (legacy
// no-appId store: `sessions.db`), one table, whole-row JSON column. The TS
// `Session` type stays the schema authority; the generated columns below only
// serve hot lookups.
//
// SQLite is the only engine the OWNING DAEMON ever writes. It imports its
// pre-SQLite `sessions*.json` once at first load and never writes JSON again.
//
// The cross-process surface (worker reads, CLI reads, CLI offline writes) still
// resolves each store as "use the .db when it exists, else the .json". That is
// not leftover indecision — it is the upgrade window. `npm i -g` replaces dist
// and repoints ~/.botmux/bin/botmux immediately, while the daemon that owns the
// rows keeps running the OLD code (auto-update is off by default and `botmux
// upgrade` tells the operator to restart by hand), so a store can legitimately
// have no `.db` for hours or weeks. Dropping the JSON read seam would leave
// every live session's `botmux send` unable to find itself until that restart.
//
// The frozen JSON is deliberately never deleted: it is also the only artifact a
// downgrade to a pre-SQLite botmux can read, and it costs a few hundred KB.

type SqliteStatementLike = StatementLike;
type SqliteDatabaseLike = DatabaseSyncLike;

const SQLITE_BUSY_TIMEOUT_MS = 3000;
const SQLITE_NODE_VERSION_HINT = 'Node ≥ 22.13.0（23.x 需 ≥ 23.4.0）';

// Recovery receipts: written in the SAME transaction as the merge, so
// "this orphan's rows are already in the main file" becomes a durable fact
// instead of something re-derived from a replay whose observations are
// timing-dependent. Keyed by the orphan WAL's content digest.
const RECOVERY_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS import_recovery_receipts (
  orphan_digest TEXT PRIMARY KEY,
  merged_at TEXT NOT NULL,
  merged_rows INTEGER NOT NULL
);
`;

const SESSIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  row TEXT NOT NULL,
  chat_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.chatId')) VIRTUAL,
  root_message_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.rootMessageId')) VIRTUAL,
  scope TEXT GENERATED ALWAYS AS (json_extract(row, '$.scope')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_root_message_id ON sessions(root_message_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_scope ON sessions(chat_id, scope, status);
`;

/** Principal-lane sidecars are intentionally separate from the whole Session
 * JSON row. They provide one durable owner for lane indexes, workspace epochs,
 * quote provenance, and migration audits before the runtime routing feature is
 * enabled. CREATE IF NOT EXISTS is the migration: legacy stores remain fully
 * readable and keep their original single-principal behavior until an owner
 * identity passes the explicit migration gate. */
export const PRINCIPAL_LANE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS principal_lane_sources (
  source_session_id TEXT PRIMARY KEY,
  source_principal_key TEXT NOT NULL,
  canonical_cwd TEXT NOT NULL,
  workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
  workspace_group_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  row TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principal_lanes (
  lane_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  principal_key TEXT NOT NULL,
  routing_anchor TEXT NOT NULL,
  workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  row TEXT NOT NULL,
  PRIMARY KEY(source_session_id, lane_id),
  UNIQUE(source_session_id, principal_key),
  UNIQUE(source_session_id, routing_anchor)
);
CREATE INDEX IF NOT EXISTS idx_principal_lanes_source
  ON principal_lanes(source_session_id, phase);
CREATE INDEX IF NOT EXISTS idx_principal_lanes_routing_anchor
  ON principal_lanes(routing_anchor, phase);
CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_lanes_source_routing_anchor
  ON principal_lanes(source_session_id, routing_anchor);
CREATE TABLE IF NOT EXISTS principal_lane_worktrees (
  materialization_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  principal_key TEXT NOT NULL,
  workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
  source_repo_root TEXT NOT NULL,
  source_git_common_dir TEXT NOT NULL,
  worktree_root TEXT NOT NULL UNIQUE,
  worktree_git_common_dir TEXT NOT NULL,
  working_dir TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('ready', 'quarantined')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  row TEXT NOT NULL,
  UNIQUE(source_session_id, lane_id),
  UNIQUE(source_session_id, principal_key)
);
CREATE INDEX IF NOT EXISTS idx_principal_lane_worktrees_source
  ON principal_lane_worktrees(source_session_id, phase);
CREATE TABLE IF NOT EXISTS principal_lane_aliases (
  source_session_id TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  canonical_principal_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_session_id, alias_key)
);
CREATE INDEX IF NOT EXISTS idx_principal_lane_aliases_lane
  ON principal_lane_aliases(source_session_id, lane_id);
CREATE TABLE IF NOT EXISTS principal_lane_identity_audit (
  audit_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  lane_id TEXT,
  event TEXT NOT NULL CHECK(event IN ('created', 'upgraded', 'conflict')),
  from_principal_key TEXT,
  to_principal_key TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principal_lane_identity_audit_source
  ON principal_lane_identity_audit(source_session_id, created_at);
CREATE TABLE IF NOT EXISTS principal_lane_identity_conflicts (
  conflict_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  left_alias_key TEXT NOT NULL,
  right_alias_key TEXT NOT NULL,
  left_lane_id TEXT NOT NULL,
  right_lane_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_session_id, left_alias_key, right_alias_key)
);
CREATE INDEX IF NOT EXISTS idx_principal_lane_identity_conflicts_aliases
  ON principal_lane_identity_conflicts(source_session_id, left_alias_key, right_alias_key);
CREATE TABLE IF NOT EXISTS message_provenance (
  message_id TEXT PRIMARY KEY,
  lark_app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  display_root_id TEXT,
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  worker_generation INTEGER NOT NULL CHECK(worker_generation >= 1),
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  trust_state TEXT NOT NULL CHECK(trust_state IN ('trusted', 'untrusted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_provenance_turn
  ON message_provenance(source_session_id, turn_id, worker_generation);
CREATE INDEX IF NOT EXISTS idx_message_provenance_gc
  ON message_provenance(updated_at, trust_state);
CREATE TABLE IF NOT EXISTS message_provenance_trust_fences (
  message_id TEXT PRIMARY KEY,
  lark_app_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  worker_generation INTEGER,
  attempt_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_provenance_conflicts (
  audit_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('identity_conflict')),
  existing_identity TEXT NOT NULL,
  incoming_identity TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_provenance_conflicts_message
  ON message_provenance_conflicts(message_id, created_at);
CREATE TABLE IF NOT EXISTS principal_lane_migration_audit (
  audit_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  lark_app_id TEXT NOT NULL,
  principal_key TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('bound', 'disabled')),
  evidence TEXT CHECK(evidence IN ('owner_union_id', 'same_app_owner_open_id')),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principal_lane_migration_source
  ON principal_lane_migration_audit(source_session_id, created_at);
CREATE TABLE IF NOT EXISTS principal_workspace_groups (
  group_id TEXT PRIMARY KEY,
  group_key_version INTEGER NOT NULL CHECK(group_key_version = 2),
  lark_app_id TEXT NOT NULL,
  canonical_cwd TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('active', 'closing', 'closed', 'quarantined')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  last_lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(last_lease_generation >= 0),
  row TEXT NOT NULL,
  UNIQUE(group_key_version, lark_app_id, canonical_cwd)
);
CREATE TABLE IF NOT EXISTS principal_workspace_members (
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
  membership_phase TEXT NOT NULL CHECK(membership_phase IN ('active', 'closing', 'closed', 'quarantined')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  row TEXT NOT NULL,
  PRIMARY KEY(source_session_id, lane_id)
);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_members_group
  ON principal_workspace_members(group_id, membership_phase);
CREATE TABLE IF NOT EXISTS principal_workspace_migration_audit (
  audit_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('created', 'migrated', 'conflict')),
  from_group_id TEXT,
  target_group_id TEXT,
  from_revision INTEGER,
  from_epoch INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_migration_source
  ON principal_workspace_migration_audit(source_session_id, created_at);
CREATE TABLE IF NOT EXISTS principal_workspace_member_conflicts (
  conflict_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  existing_identity TEXT,
  incoming_identity TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_member_conflicts_source
  ON principal_workspace_member_conflicts(source_session_id, created_at);
CREATE TABLE IF NOT EXISTS principal_workspace_ticket_sequences (
  group_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0 AND last_sequence <= 9007199254740991),
  revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principal_workspace_tickets (
  ticket_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1 AND sequence <= 9007199254740991),
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'attempting', 'completed', 'cancelled', 'unknown')),
  revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= 9007199254740991),
  namespace_version INTEGER NOT NULL CHECK(namespace_version = 1),
  namespace TEXT NOT NULL,
  record_version INTEGER NOT NULL CHECK(record_version = 1),
  record_id TEXT NOT NULL,
  payload_encoding TEXT NOT NULL CHECK(payload_encoding = 'canonical-json-utf8-base64'),
  payload_hash TEXT NOT NULL,
  exact_file_length INTEGER NOT NULL CHECK(exact_file_length >= 1 AND exact_file_length <= 2097152),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  row TEXT NOT NULL,
  UNIQUE(group_id, sequence),
  UNIQUE(source_session_id, lane_id, session_id, turn_id),
  UNIQUE(namespace_version, namespace, record_version, record_id)
);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_tickets_group_fifo
  ON principal_workspace_tickets(group_id, status, sequence);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_tickets_namespace
  ON principal_workspace_tickets(namespace_version, namespace, sequence);
CREATE TABLE IF NOT EXISTS principal_workspace_ticket_audit (
  audit_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  ticket_id TEXT,
  source_session_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN (
    'enqueued', 'turn_record_conflict', 'record_ticket_conflict',
    'ticket_id_collision', 'ticket_row_corruption', 'sequence_corruption',
    'counter_corruption'
  )),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principal_workspace_ticket_audit_ticket
  ON principal_workspace_ticket_audit(ticket_id, event, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_workspace_ticket_audit_enqueued
  ON principal_workspace_ticket_audit(ticket_id) WHERE event = 'enqueued';
CREATE INDEX IF NOT EXISTS idx_principal_workspace_ticket_audit_group
  ON principal_workspace_ticket_audit(group_id, event, created_at);
`;

/** Per-bot occupancy (grain directory). v1 uses a single `bot` row; the
 *  primary key is `scope` so a later per-session grain can add
 *  `session:<id>` without a migration that excludes that shape. */
export const OCCUPANCY_SCOPE_BOT = 'bot';
/** Lease TTL. Shares the descriptor-heartbeat staleness window so the two
 *  ownership signals (lease, heartbeat fallback) lapse on one schedule. */
export const OCCUPANCY_LEASE_MS = DAEMON_HEARTBEAT_STALE_MS;

const OCCUPANCY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS occupancy (
  scope TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
`;

export type OccupancyHolder = {
  bootId: string;
  pid: number;
};

export type OccupancyLease = {
  scope: string;
  ownerPid: number;
  bootId: string;
  leaseUntil: number;
};

/** Identity used by the owning daemon to claim/renew/release occupancy.
 *  Set by `init()`; `owner: false` never claims. */
let occupancyHolder: OccupancyHolder | undefined;

let sqliteForcedUnavailable = false;
/** Simulate a runtime without a SQLite engine. The real probe lives in
 *  sqlite-compat (Node: node:sqlite / Bun: bun:sqlite); tests flip this
 *  because createRequire bypasses the vitest module graph. */
export function __testOnly_setSqliteUnavailable(unavailable: boolean): void {
  sqliteForcedUnavailable = unavailable;
}

/** SQLite engine cannot be loaded but a SQLite store exists (or must be
 *  created). Distinct class so best-effort scan loops can rethrow it instead
 *  of degrading a capability failure into "file skipped". A corrupt .db is
 *  NOT this error — that is a regular open failure the scan may skip. */
export class SessionStoreSqliteUnavailableError extends Error {
  override readonly name = 'SessionStoreSqliteUnavailableError';
}


function sqliteUnavailableMessage(context: string): string {
  return `${context}需要 SQLite 引擎（Node 的 node:sqlite 或 Bun 的 bun:sqlite），但当前运行时不可用。Node 请升级到 ${SQLITE_NODE_VERSION_HINT}；编译版请使用支持 bun:sqlite 的 Bun。当前 runtime: ${process.version}。`;
}

function requireSqliteEngine(context: string): void {
  if (sqliteForcedUnavailable || !sqliteEngineAvailable()) {
    throw new SessionStoreSqliteUnavailableError(sqliteUnavailableMessage(context));
  }
}

/** Startup capability gate for the daemon. package.json engines is only
 *  `node: >=22` (npm WARNS on mismatch; bun binaries use bun:sqlite). This
 *  probe is the real gate: fail fast with an actionable message instead of
 *  failing later on the first store touch. */
export function assertSqliteSupported(): void {
  requireSqliteEngine('botmux 会话存储（SQLite 引擎）');
}

/** Open the store the daemon/worker owns for read-write use (WAL + NORMAL +
 *  busy_timeout, schema ensured). Durability matches the previous JSON
 *  tmp+rename (no fsync) — deliberately not upgraded in this step. */
function openDbForOwnStore(path: string): SqliteDatabaseLike {
  requireSqliteEngine(`会话存储 ${basename(path)} `);
  const db = openDatabaseSyncOrThrow(path);
  // Neither engine validates the file in the constructor. `busy_timeout` is
  // connection-level and touches no page either; the first statement that can
  // reject a corrupt file is `journal_mode` below — still inside this helper.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SESSIONS_SCHEMA_SQL);
  db.exec(PRINCIPAL_LANE_SCHEMA_SQL);
  ensurePrincipalLaneWorktreeCommonDirColumns(db);
  ensureMessageProvenanceTrustFenceIdentityColumns(db);
  db.exec(OCCUPANCY_SCHEMA_SQL);
  return db;
}

/** `0d6ab50d1` could create this sidecar before the common-dir proof columns
 * existed. SQLite cannot add NOT NULL columns to a populated table without a
 * fabricated default, so upgrades add nullable columns and deliberately leave
 * old rows NULL. The parser rejects those rows; only a fresh materialization
 * can publish usable proof. */
function ensurePrincipalLaneWorktreeCommonDirColumns(db: SqliteDatabaseLike): void {
  const columns = db.prepare('PRAGMA table_info(principal_lane_worktrees)').all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map(column => column.name));
  const addIfMissing = (name: string) => {
    if (names.has(name)) return;
    try { db.exec(`ALTER TABLE principal_lane_worktrees ADD COLUMN ${name} TEXT;`); }
    catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  };
  addIfMissing('source_git_common_dir');
  addIfMissing('worktree_git_common_dir');
}

/** Older staged stores created provenance fences before an exact dispatch
 * identity/token was part of the schema. Leave legacy rows NULL so they remain
 * permanently fail-closed; only a fresh begin attempt may create a releasable
 * fence. */
function ensureMessageProvenanceTrustFenceIdentityColumns(db: SqliteDatabaseLike): void {
  const columns = db.prepare('PRAGMA table_info(message_provenance_trust_fences)').all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map(column => column.name));
  const addIfMissing = (name: string, type: string) => {
    if (names.has(name)) return;
    try { db.exec(`ALTER TABLE message_provenance_trust_fences ADD COLUMN ${name} ${type};`); }
    catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  };
  addIfMissing('session_id', 'TEXT');
  addIfMissing('turn_id', 'TEXT');
  addIfMissing('worker_generation', 'INTEGER');
  addIfMissing('attempt_id', 'TEXT');
}

/** Open somebody's store for reading. Read-write first so a stale WAL left by
 *  a crashed daemon can be recovered; fall back to read-only for sandboxed
 *  readers whose grant on the .db is read-only (a live daemon maintains the
 *  -shm they piggyback on). Callers must only SELECT. */
function openDbForRead(path: string): SqliteDatabaseLike {
  requireSqliteEngine(`会话存储 ${basename(path)} `);
  // A read-write open CREATES a missing file. An empty store planted here
  // would make the owning daemon's `existsSync(db)` import gate skip the
  // one-shot JSON import and silently discard every pre-SQLite row, so a
  // reader must refuse an absent store outright (scan loops skip it).
  if (!existsSync(path)) throw new Error(`session store ${path} does not exist`);
  let db: SqliteDatabaseLike;
  try {
    db = openDatabaseSyncOrThrow(path);
  } catch {
    db = openDatabaseSyncOrThrow(path, { readOnly: true });
  }
  // NOT a validation point: `busy_timeout` is connection-level and touches no
  // page, so a corrupt file survives it — this helper RETURNS A HANDLE for one.
  // The read path's validation happens at the caller's first page-touching
  // statement (the SELECT), which the scan loops treat as a skippable store.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  return db;
}

interface OwnSqliteStore {
  db: SqliteDatabaseLike;
  selectRow: SqliteStatementLike;
  selectAll: SqliteStatementLike;
  updateExact: SqliteStatementLike;
  insertNew: SqliteStatementLike;
}
type SqliteReadStore = Pick<OwnSqliteStore, 'db'>;
let ownStore: OwnSqliteStore | undefined;

/** Lock/busy contention is retryable. Swallowing it into loadFailure would let
 *  the daemon start with an empty cache while the durable store is healthy. */
function isTransientStoreContentionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|file-lock timeout/i.test(message);
}

/** Run one owned-row write transaction, optionally borrowing busy_timeout=0.
 *
 * BEGIN intentionally sits outside the transaction-body try/finally: when
 * BEGIN itself fails there is no transaction to roll back, so the original
 * SQLITE_BUSY error cannot be hidden by a spurious ROLLBACK failure.
 */
function runOwnedWriteTransaction<T>(
  store: OwnSqliteStore,
  nonblocking: boolean,
  operation: () => T,
): T {
  if (nonblocking) store.db.exec('PRAGMA busy_timeout = 0;');
  try {
    let committed = false;
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      store.db.exec('COMMIT');
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try { store.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      }
    }
  } catch (error) {
    if (nonblocking && isTransientStoreContentionError(error)) {
      throw new SessionStoreBusyError(error);
    }
    throw error;
  } finally {
    if (nonblocking) store.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  }
}

function attachOwnStore(path: string): OwnSqliteStore {
  const db = openDbForOwnStore(path);
  ownStore = {
    db,
    selectRow: db.prepare('SELECT row FROM sessions WHERE session_id = ?'),
    selectAll: db.prepare('SELECT session_id, row FROM sessions'),
    updateExact: db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ? AND row = ?'),
    insertNew: db.prepare('INSERT INTO sessions (session_id, status, row) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING'),
  };
  return ownStore;
}

function readOccupancyInTxn(db: SqliteDatabaseLike): OccupancyLease | undefined {
  try {
    const hit = db.prepare(
      'SELECT scope, owner_pid, boot_id, lease_until FROM occupancy WHERE scope = ?',
    ).get(OCCUPANCY_SCOPE_BOT) as { scope: string; owner_pid: number; boot_id: string; lease_until: number } | undefined;
    if (!hit) return undefined;
    return {
      scope: hit.scope,
      ownerPid: Number(hit.owner_pid),
      bootId: String(hit.boot_id),
      leaseUntil: Number(hit.lease_until),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return undefined;
    throw err;
  }
}

/** True when a lease row is present and still inside its TTL. */
export function occupancyLeaseIsActive(
  lease: OccupancyLease | undefined,
  now: number = Date.now(),
): boolean {
  return !!lease && lease.leaseUntil > now;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but is not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type OccupancyClaimResult =
  /** This process holds the lease (claimed, taken over, or renewed). */
  | 'held'
  /** Another live boot holds it; the row was left untouched. */
  | 'displaced'
  /** No attached own store (not the owner, or the load failed). */
  | 'unavailable';

/**
 * Take or extend the bot-scope lease for `holder` inside the caller's write
 * transaction. A foreign row is taken over only once it has expired or its
 * owner process is gone; a live foreign lease is never overwritten, so an
 * overlapping predecessor (restart before its teardown finished) keeps
 * ownership until it releases or lapses. Claim and renew are the same
 * statement: a process that lost its lease re-acquires it on the next tick
 * instead of running unowned for the rest of its life.
 */
function claimOccupancyInTxn(
  db: SqliteDatabaseLike,
  holder: OccupancyHolder,
  now: number,
): 'held' | 'displaced' {
  const current = readOccupancyInTxn(db);
  if (current
      && current.bootId !== holder.bootId
      && current.ownerPid !== holder.pid
      && occupancyLeaseIsActive(current, now)
      && processAlive(current.ownerPid)) {
    return 'displaced';
  }
  db.prepare(
    'INSERT INTO occupancy (scope, owner_pid, boot_id, lease_until) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(scope) DO UPDATE SET owner_pid = excluded.owner_pid, '
    + 'boot_id = excluded.boot_id, lease_until = excluded.lease_until',
  ).run(OCCUPANCY_SCOPE_BOT, holder.pid, holder.bootId, now + OCCUPANCY_LEASE_MS);
  return 'held';
}

/** Runs inside load()'s snapshot transaction. A failed claim must not turn a
 *  loadable store into a boot failure (a read-only store served reads before
 *  occupancy existed): log it, let the snapshot commit, and leave the retry
 *  to the heartbeat tick's claimOccupancyLease. */
function claimOccupancyOnLoad(db: SqliteDatabaseLike, now: number): void {
  if (!sqliteBootstrapAllowed || !occupancyHolder) return;
  try {
    if (claimOccupancyInTxn(db, occupancyHolder, now) === 'displaced') {
      logger.warn(
        `Session store ${getDbPath()} occupancy is held by another live daemon boot; `
        + 'this process starts without the lease and retries on its heartbeat',
      );
    }
  } catch (err) {
    logger.error(`Failed to claim session store occupancy on load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * SQLite ownership: a live lease blocks the write outright. Without a live
 * lease (row absent or expired) `abortIf` — the descriptor-heartbeat probe —
 * still decides. That fallback is the upgrade window: a daemon that writes
 * SQLite but not occupancy (a pre-Stage-1 build, or a rollback after a newer
 * build crashed and left a stale row) is visible only by heartbeat. Either
 * signal fails closed; only "no live lease AND no fresh heartbeat" lets an
 * offline writer publish.
 */
function sqliteOccupancyBlocksWrite(
  lease: OccupancyLease | undefined,
  now: number,
  abortIf?: () => boolean,
): boolean {
  return occupancyLeaseIsActive(lease, now) || !!abortIf?.();
}

/** Point-read the bot-scope lease. JSON stores and pre-occupancy DBs → undefined. */
export function readOccupancyLease(
  larkAppId: string,
  dataDir: string = config.session.dataDir,
): OccupancyLease | undefined {
  const ref = resolveStoreFile(larkAppId, dataDir);
  if (ref.kind !== 'sqlite' || !existsSync(ref.path)) return undefined;
  const db = openDbForRead(ref.path);
  try {
    return readOccupancyInTxn(db);
  } finally {
    db.close();
  }
}

/** Claim or extend this process's lease (daemon heartbeat tick, and once right
 *  after the first load). Takeover rules: see claimOccupancyInTxn. */
export function claimOccupancyLease(opts: { bootId: string; pid: number; now?: number }): OccupancyClaimResult {
  if (!ownStore || loadFailure || !sqliteBootstrapAllowed) return 'unavailable';
  const db = ownStore.db;
  const now = opts.now ?? Date.now();
  let committed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = claimOccupancyInTxn(db, { bootId: opts.bootId, pid: opts.pid }, now);
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) { try { db.exec('ROLLBACK'); } catch { /* txn already gone */ } }
  }
}

/** Drop this process's lease. Other holders are left untouched. */
export function releaseOccupancyLease(opts: { bootId: string }): boolean {
  if (!ownStore) return false;
  const result = ownStore.db.prepare(
    'DELETE FROM occupancy WHERE scope = ? AND boot_id = ?',
  ).run(OCCUPANCY_SCOPE_BOT, opts.bootId);
  return Number(result.changes) > 0;
}

function sessionStatusText(value: unknown): string {
  const status = (value as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' ? status : '';
}

let testOnlyBeforeRowPersist: ((sessionId: string) => void) | undefined;
let testOnlyBeforePrincipalLaneCreateTransaction: (() => void) | undefined;
let testOnlyAfterPrincipalWorkspaceReadFence: (() => void) | undefined;
let testOnlyBeforePrincipalWorkspaceReadQuarantine: (() => void) | undefined;
let testOnlyBeforePrincipalWorkspaceEnqueueCommit: (() => void) | undefined;
let testOnlyAfterPrincipalWorkspaceEnqueueCommit: (() => void) | undefined;
let testOnlyBeforePrincipalLaneWorktreeCommit: (() => void) | undefined;
let testOnlyAfterPrincipalLaneWorktreeCommit: (() => void) | undefined;
/** Failure injection for the SQLite row write (the JSON engine was injectable
 *  through a node:fs mock; the sqlite-compat handle bypasses node:fs). */
export function __testOnly_setBeforeRowPersist(hook: ((sessionId: string) => void) | undefined): void {
  testOnlyBeforeRowPersist = hook;
}

/** Failure/race injection between the authority snapshot and the write
 * transaction. Production code never assigns this hook. */
export function __testOnly_setBeforePrincipalLaneCreateTransaction(
  hook: (() => void) | undefined,
): void {
  testOnlyBeforePrincipalLaneCreateTransaction = hook;
}

export function __testOnly_setBeforePrincipalLaneWorktreeCommit(
  hook: (() => void) | undefined,
): void {
  testOnlyBeforePrincipalLaneWorktreeCommit = hook;
}

export function __testOnly_setAfterPrincipalLaneWorktreeCommit(
  hook: (() => void) | undefined,
): void {
  testOnlyAfterPrincipalLaneWorktreeCommit = hook;
}

/** Race injection after the read snapshot has ended and before a narrow
 * quarantine begins. Production code never assigns this hook. */
export function __testOnly_setBeforePrincipalWorkspaceReadQuarantine(
  hook: (() => void) | undefined,
): void {
  testOnlyBeforePrincipalWorkspaceReadQuarantine = hook;
}

/** Race injection after source/fence validation while the read snapshot is
 * still open. Production code never assigns this hook. */
export function __testOnly_setAfterPrincipalWorkspaceReadFence(
  hook: (() => void) | undefined,
): void {
  testOnlyAfterPrincipalWorkspaceReadFence = hook;
}

/** Simulate a failed acknowledgement before SQLite COMMIT is attempted.
 * Production code never assigns this hook. */
export function __testOnly_setBeforePrincipalWorkspaceEnqueueCommit(
  hook: (() => void) | undefined,
): void {
  testOnlyBeforePrincipalWorkspaceEnqueueCommit = hook;
}

/** Simulate the SQLite commit-unknown boundary after COMMIT has returned.
 * Production code never assigns this hook. */
export function __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(
  hook: (() => void) | undefined,
): void {
  testOnlyAfterPrincipalWorkspaceEnqueueCommit = hook;
}

// ─── Store resolution (db-else-json, cross-process only) ─────────────────────

type StoreFileRef = {
  /** undefined = the legacy no-appId store. */
  appId?: string;
  kind: 'sqlite' | 'json';
  path: string;
};

/** Per-bot SQLite stores live in their OWN directory
 *  (`session-stores/<appId>/sessions.db`), not as flat sibling files: the CLI
 *  file sandbox must bind the store as a DIRECTORY. A single-file bwrap bind
 *  pins the inode mounted at spawn, and SQLite deletes/recreates -wal/-shm
 *  when the last connection closes — a persistent pane surviving a daemon
 *  restart would keep reading the dead WAL forever (or a corrupt hybrid once
 *  checkpoints recycle it). Directory binds resolve names live, so the pane
 *  always sees the current sidecars. The legacy no-appId store (tests /
 *  single-bot dev) stays flat `sessions.db` — it is never sandbox-granted. */
const PER_BOT_STORE_DIRNAME = 'session-stores';

export function sessionStoreSqliteDir(appId: string, dataDir: string = config.session.dataDir): string {
  return join(dataDir, PER_BOT_STORE_DIRNAME, appId);
}

function storeDbPath(appId: string | undefined, dataDir: string): string {
  return appId ? join(sessionStoreSqliteDir(appId, dataDir), 'sessions.db') : join(dataDir, 'sessions.db');
}

/** The pre-SQLite file for a store: the daemon's one-shot import source, and
 *  the cross-process read seam until that daemon restarts. */
function storeJsonFileName(appId: string | undefined): string {
  return appId ? `sessions-${appId}.json` : 'sessions.json';
}

/** Per-store rule for every cross-process reader and CLI offline writer:
 *  use the .db when it exists, else the .json (see the upgrade-window note at
 *  the top of the engine section). */
function resolveStoreFile(appId: string | undefined, dataDir: string): StoreFileRef {
  const dbPath = storeDbPath(appId, dataDir);
  if (existsSync(dbPath)) return { appId, kind: 'sqlite', path: dbPath };
  return { appId, kind: 'json', path: join(dataDir, storeJsonFileName(appId)) };
}

/** One ref per store identity across the whole data dir, .db winning: flat
 *  legacy files + per-bot JSON files + per-bot SQLite store directories.
 *  `strict` propagates an unlistable `session-stores/` dir (fail-closed
 *  callers must not mistake an unreadable store set for an empty one);
 *  otherwise it degrades to the JSON view. */
function listStoreRefs(dataDir: string, opts: { strict?: boolean } = {}): StoreFileRef[] {
  const names = readdirSync(dataDir);
  const dbPaths = new Map<string, string>();
  const jsonPaths = new Map<string, string>();
  for (const name of names) {
    if (name === 'sessions.db') dbPaths.set('', join(dataDir, name));
    else if (name === 'sessions.json') jsonPaths.set('', join(dataDir, name));
    else if (name.startsWith('sessions-') && name.endsWith('.json')) {
      jsonPaths.set(name.slice('sessions-'.length, -'.json'.length), join(dataDir, name));
    }
  }
  if (names.includes(PER_BOT_STORE_DIRNAME)) {
    let appIds: string[] = [];
    try {
      appIds = readdirSync(join(dataDir, PER_BOT_STORE_DIRNAME));
    } catch (err) {
      if (opts.strict) throw err;
    }
    for (const appId of appIds) {
      const dbPath = storeDbPath(appId, dataDir);
      if (existsSync(dbPath)) dbPaths.set(appId, dbPath);
    }
  }
  const refs: StoreFileRef[] = [];
  for (const key of new Set([...dbPaths.keys(), ...jsonPaths.keys()])) {
    const dbPath = dbPaths.get(key);
    refs.push({
      appId: key === '' ? undefined : key,
      kind: dbPath ? 'sqlite' : 'json',
      path: dbPath ?? jsonPaths.get(key)!,
    });
  }
  return refs;
}

/** All [key, value] entries of one store. Throws on an unreadable store;
 *  callers decide skip-vs-propagate (capability errors always propagate). */
function readStoreEntries(ref: StoreFileRef): [string, Session][] {
  if (ref.kind === 'json') {
    const parsed = JSON.parse(readFileSync(ref.path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.entries(parsed as Record<string, Session>);
  }
  const db = openDbForRead(ref.path);
  try {
    const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
    const entries: [string, Session][] = [];
    for (const r of rows) {
      try { entries.push([r.session_id, JSON.parse(r.row) as Session]); } catch { /* skip unparseable row */ }
    }
    return entries;
  } finally {
    db.close();
  }
}

/** Point-read one key from one store. Throws on an unreadable store. */
function readStoreRowByKey(ref: StoreFileRef, sessionId: string): Session | undefined {
  if (ref.kind === 'json') {
    const parsed = JSON.parse(readFileSync(ref.path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, Session>)[sessionId];
  }
  // The daemon's hot freshness reads hit its own store — reuse the attached
  // connection instead of opening one per call.
  if (ownStore && loaded && ref.appId === currentAppId && ref.path === getDbPath()) {
    const hit = ownStore.selectRow.get(sessionId) as { row: string } | undefined;
    return hit ? JSON.parse(hit.row) as Session : undefined;
  }
  const db = openDbForRead(ref.path);
  try {
    const hit = db.prepare('SELECT row FROM sessions WHERE session_id = ?').get(sessionId) as { row: string } | undefined;
    return hit ? JSON.parse(hit.row) as Session : undefined;
  } finally {
    db.close();
  }
}

/** The active rows of one store, optionally narrowed by an indexed hint. */
function readStoreActiveRows(
  ref: StoreFileRef,
  hint?: { rootMessageId?: string; chatScopeChatId?: string; threadScopeChatId?: string },
  opts: { strict?: boolean } = {},
): Session[] {
  if (ref.kind === 'json') {
    const parsed = JSON.parse(readFileSync(ref.path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (opts.strict) throw new Error(`malformed active session store in ${ref.path}`);
      return [];
    }
    const out: Session[] = [];
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || (value as { status?: unknown }).status !== 'active') continue;
      const session = value as Partial<Session>;
      if (typeof session.sessionId !== 'string') {
        if (opts.strict) throw new Error(`malformed active session row in ${ref.path}: invalid session object`);
        continue;
      }
      out.push(session as Session);
    }
    return out;
  }
  const db = openDbForRead(ref.path);
  try {
    let sql = "SELECT row FROM sessions WHERE status = 'active'";
    const params: unknown[] = [];
    if (hint?.rootMessageId !== undefined) {
      sql += ' AND root_message_id = ?';
      params.push(hint.rootMessageId);
    }
    if (hint?.chatScopeChatId !== undefined) {
      sql += " AND chat_id = ? AND scope = 'chat'";
      params.push(hint.chatScopeChatId);
    }
    if (hint?.threadScopeChatId !== undefined) {
      sql += " AND chat_id = ? AND (scope IS NULL OR scope <> 'chat')";
      params.push(hint.threadScopeChatId);
    }
    const rows = db.prepare(sql).all(...params) as { row: string }[];
    const out: Session[] = [];
    for (const r of rows) {
      try {
        const session = JSON.parse(r.row) as Session;
        if (!session || typeof session !== 'object' || typeof session.sessionId !== 'string') {
          throw new Error('invalid session object');
        }
        out.push(session);
      } catch (err) {
        if (opts.strict) {
          throw new Error(`malformed active session row in ${ref.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** The active row no longer has the lineage/ownership sampled by the caller. */
export class RemoteLineageOwnershipError extends Error {
  override readonly name = 'RemoteLineageOwnershipError';
}

export type RemoteDurableOwner = {
  pid: number | null;
  larkAppId: string | null;
  backendType: string | null;
};

export type ActiveRemoteShutdownSnapshot = {
  sessionId: string;
  taskId: string | null;
  owner: RemoteDurableOwner;
};

export type ActiveRemoteLineageBatchUpdate = ActiveRemoteShutdownSnapshot & {
  targetTaskId: string | null;
  expectedCurrentTaskIds: readonly (string | null)[];
};

export type RemoteLineageBatchFailureStage =
  | 'prewrite_ownership'
  | 'prewrite_io'
  | 'postrename_ambiguity';

export class RemoteLineageBatchError extends Error {
  override readonly name = 'RemoteLineageBatchError';

  constructor(
    readonly stage: RemoteLineageBatchFailureStage,
    readonly sessionIds: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

function remoteDurableOwner(session: Session): RemoteDurableOwner {
  return {
    pid: session.pid ?? null,
    larkAppId: session.larkAppId ?? null,
    backendType: session.backendType ?? null,
  };
}

function remoteOwnersEqual(left: RemoteDurableOwner, right: RemoteDurableOwner): boolean {
  return left.pid === right.pid
    && left.larkAppId === right.larkAppId
    && left.backendType === right.backendType;
}

let testOnlyAfterRemoteBatchRename: (() => void) | undefined;
export function __testOnly_setAfterRemoteBatchRename(hook: (() => void) | undefined): void {
  testOnlyAfterRemoteBatchRename = hook;
}

/**
 * Initialise session store for a specific bot (multi-daemon mode).
 * When appId is set, sessions are stored in `session-stores/{appId}/sessions.db`.
 * When unset, uses the legacy no-appId store (`sessions.db`).
 *
 * `owner: false` marks a non-owning process (worker): it reads whichever
 * engine exists (db-else-json) but never bootstraps/imports the SQLite store —
 * an old daemon can spawn workers from a newer dist during the upgrade window,
 * and only the daemon itself may flip the on-disk engine.
 */
export function init(appId?: string, opts: {
  owner?: boolean;
  occupancy?: OccupancyHolder;
  groupDefaultModels?: (chatId: string) => Session['groupDefaultModels'];
} = {}): void {
  migratedCodexInstanceConfig = undefined;
  currentAppId = appId;
  resolveGroupDefaultModels = opts.groupDefaultModels;
  sqliteBootstrapAllowed = opts.owner !== false;
  loaded = false;
  sessions = new Map();
  loadFailure = undefined;
  occupancyHolder = sqliteBootstrapAllowed ? opts.occupancy : undefined;
  if (ownStore) {
    try { ownStore.db.close(); } catch { /* already closed */ }
    ownStore = undefined;
  }
}

/** Pre-SQLite JSON file for this store — the one-shot import source. */
function getImportJsonPath(): string {
  return join(config.session.dataDir, storeJsonFileName(currentAppId));
}

function getDbPath(): string {
  return storeDbPath(currentAppId, config.session.dataDir);
}

function ensureDir(): void {
  const dir = config.session.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// A short-lived /repo bug recreated chat-scope sessions with the chat routing
// anchor (`oc_...`) copied into rootMessageId and omitted scope. That shape is
// impossible for a real thread: Lark message ids are `om_...`. Repair only this
// narrow signature so ordinary legacy records without scope keep their
// documented thread fallback. The original trace message cannot be recovered,
// but chat routing does not use rootMessageId.
export function repairMissingChatScope(session: unknown): boolean {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
  const record = session as Record<string, unknown>;
  if (
    record.scope === undefined
    && typeof record.chatId === 'string'
    && record.chatId.startsWith('oc_')
    && typeof record.rootMessageId === 'string'
    && record.rootMessageId === record.chatId
  ) {
    record.scope = 'chat';
    return true;
  }
  return false;
}

function parseSessionsProjectionStrict(raw: string, fp: string): Record<string, Session> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid sessions projection at ${fp}`);
  }
  return value as Record<string, Session>;
}

/** Which snapshot file a recovery/import read actually resolved. `none` means no
 *  readable snapshot existed at all — distinct from "a readable snapshot that
 *  legitimately holds zero rows for this bot", which IS evidence. */
type FrozenSnapshotSource = 'per-bot' | 'legacy' | 'none';

/** The JSON rows today's load()/migration would have produced for this store,
 *  plus WHICH file they came from. The source matters to recovery: a legacy
 *  `sessions.json` that parses fine but filters down to zero rows for this bot
 *  proves the store held nothing, whereas a missing file proves nothing. */
function readFrozenSnapshotForImport(jsonFp: string): {
  entries: [string, Session][];
  source: FrozenSnapshotSource;
} {
  let entries: [string, Session][] = [];
  let source: FrozenSnapshotSource = 'none';
  if (existsSync(jsonFp)) {
    const data = parseSessionsProjectionStrict(readFileSync(jsonFp, 'utf-8'), jsonFp);
    entries = Object.entries(data);
    source = 'per-bot';
  } else if (currentAppId) {
    const legacyFp = join(config.session.dataDir, 'sessions.json');
    if (!existsSync(legacyFp)) return { entries: [], source: 'none' };
    const data = parseSessionsProjectionStrict(readFileSync(legacyFp, 'utf-8'), legacyFp);
    entries = Object.entries(data).filter(([, v]) => v?.larkAppId === currentAppId);
    source = 'legacy';
  } else {
    return { entries: [], source: 'none' };
  }
  for (const [, value] of entries) {
    if (value && typeof value === 'object') {
      repairMissingChatScope(value);
      stripLegacyPendingCardFields(value as unknown as Record<string, unknown>);
    }
  }
  return { entries, source };
}

/** The JSON rows today's load()/migration would have produced for this store:
 *  the per-bot file's entries when it exists, else the legacy `sessions.json`
 *  rows belonging to this bot; scope repair applied, legacy card fields
 *  stripped, closed rows included. Parse failures degrade to an empty store —
 *  exactly like the previous loader. */
function readJsonEntriesForImport(jsonFp: string): [string, Session][] {
  return readFrozenSnapshotForImport(jsonFp).entries;
}

/** One-shot deterministic import: build the store at `<db>.tmp`, commit, then
 *  rename into place so readers only ever see a complete database. The caller
 *  holds the same JSON file lock daemon saves and offline CLI mutations use,
 *  so the imported snapshot cannot race a concurrent JSON writer. The source
 *  JSON is left frozen in place (the rollback path for the upgrade window). */
function importJsonStoreToSqlite(dbFp: string, jsonFp: string): number {
  requireSqliteEngine(`会话存储 ${basename(dbFp)} 首次导入`);
  const tmpFp = `${dbFp}.tmp`;
  // `-journal` is DELETE mode's sidecar (the mode this import uses below);
  // `-wal`/`-shm` cover a crash under an older WAL-based import.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { unlinkSync(`${tmpFp}${suffix}`); } catch { /* no leftover from a crashed import */ }
  }
  const entries = readJsonEntriesForImport(jsonFp);
  const tmp = openDatabaseSyncOrThrow(tmpFp);
  try {
    tmp.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    // The staging database is deliberately NOT in WAL mode. `renameSync` below
    // publishes ONE file, so every imported row has to live inside it by the
    // time we rename — and closing a WAL connection does not reliably fold the
    // -wal sidecar back into the main file on both engines. Under bun:sqlite it
    // does not: the rows stay in `<db>.tmp-wal`, the rename publishes a 4 KB
    // header-only database, and every later open fails with "disk I/O error".
    // Because the import gate is `existsSync(db)`, that shell is never
    // rebuilt — the store is bricked and every pre-SQLite session is
    // unreachable. The rollback journal keeps the staging file self-contained;
    // the real store still runs WAL (see openDbForOwnStore).
    tmp.exec('PRAGMA journal_mode = DELETE;');
    tmp.exec('PRAGMA synchronous = NORMAL;');
    tmp.exec(SESSIONS_SCHEMA_SQL);
    tmp.exec('BEGIN');
    const insert = tmp.prepare('INSERT OR REPLACE INTO sessions (session_id, status, row) VALUES (?, ?, ?)');
    for (const [key, value] of entries) {
      // Import under the file's OWN key, never the row's sessionId. Re-keying
      // looks like a cleanup for the historical "key disagrees with
      // row.sessionId" corruption, but two entries can carry the SAME
      // sessionId — and then the later one silently replaces the earlier,
      // letting a stale closed ghost overwrite the live row, irreversibly
      // (the import runs once and the JSON is frozen afterwards). A
      // mis-keyed row stays inert instead: identity scans already skip rows
      // whose sessionId disagrees with the key they were found under.
      insert.run(key, sessionStatusText(value), JSON.stringify(value));
    }
    tmp.exec('COMMIT');
    tmp.close();
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (existsSync(`${tmpFp}${suffix}`)) {
        throw new Error(`temporary SQLite import left ${tmpFp}${suffix}`);
      }
    }
    renameSync(tmpFp, dbFp);
    return entries.length;
  } catch (err) {
    try { tmp.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { unlinkSync(`${tmpFp}${suffix}`); } catch { /* best-effort orphan cleanup */ }
    }
    throw err;
  }
}

// ─── Orphaned import sidecar recovery ────────────────────────────────────────
// A pre-fix import built `<db>.tmp` in WAL mode and published only the main
// file with `renameSync`. Under Bun, `close()` skips the WAL checkpoint while a
// prepared statement is still alive, so the schema and every row stayed in
// `<db>.tmp-wal` while the published `.db` was a bare 4096-byte header. That
// import path now uses DELETE mode (it cannot produce this shape any more), but
// stores already poisoned by it stay broken forever: the import/cleanup branch
// below is gated on `!existsSync(dbFp)` and the poisoned `.db` DOES exist, so
// nothing ever looks at the orphans again.
//
// DETECTION uses the orphaned `<db>.tmp*` sidecars and nothing else. Verified
// alternatives and why they are unusable:
//   • `PRAGMA quick_check` / `integrity_check` return `ok` on a poisoned store
//     (the file is structurally fine, its content simply never merged) — zero
//     discriminating power against a legitimately empty store.
//   • "the `sessions` table is missing" self-erases: `openDbForOwnStore` runs
//     `CREATE TABLE IF NOT EXISTS`, so the very first open destroys the
//     evidence. Measured going false→true across two opens while the `.tmp*`
//     orphans persisted.
// The orphan predicate cannot fire on a healthy store: the import builds on
// `<db>.tmp` and only `renameSync`s it into place as the last step, under the
// same lock, and its branch requires `.db` to be ABSENT. So ".db exists AND
// .tmp* exists" is unreachable in a normal timeline — it is always crash
// residue. A scan of 56 live production stores found zero `.tmp*` leftovers
// (healthy stores carry only `-wal`/`-shm`), i.e. no false-positive surface.
const IMPORT_TMP_SIDECAR_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const;

/** No source could attest what a poisoned store held, so recovery refused to
 *  touch it. Distinct class so the fail-closed path reads as a deliberate
 *  refusal rather than an I/O accident. */
class SessionStoreRecoveryUnattestedError extends Error {
  override readonly name = 'SessionStoreRecoveryUnattestedError';
}

/** Content digest of an orphaned WAL, used as its recovery-receipt key. The
 *  bytes are what identify it: a different crash produces different frames, and
 *  a WAL we already merged keeps the same digest until it is finally removed. */
function orphanWalDigest(walFp: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(walFp)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Whether a previous recovery pass already committed THIS orphan's rows.
 *
 *  STRICTLY read-only: SELECT and nothing else. It must not create the receipts
 *  table — a bare `CREATE TABLE IF NOT EXISTS` grows the main file (measured
 *  12288 → 20480 bytes), and this runs BEFORE the archive is taken, so writing
 *  here would leave the archived shell no longer paired with the WAL frames it
 *  is meant to preserve. A missing table simply means "no proof". */
function hasPriorReceipt(dbFp: string, walDigest: string | undefined): boolean {
  if (!walDigest) return false;
  try {
    const db = openDatabaseSyncOrThrow(dbFp, { readOnly: true });
    try {
      return db.prepare('SELECT 1 FROM import_recovery_receipts WHERE orphan_digest = ?')
        .get(walDigest) !== undefined;
    } finally {
      db.close();
    }
  } catch {
    // No table yet, or an unreadable store: either way, nothing is proven.
    return false;
  }
}

/** Every orphaned `<db>.tmp*` path a crashed pre-fix import may have left: the
 *  temporary shell itself plus any of its journals. */
function orphanedImportSidecars(dbFp: string): string[] {
  return IMPORT_TMP_SIDECAR_SUFFIXES
    .map(suffix => `${dbFp}.tmp${suffix}`)
    .filter(path => existsSync(path));
}

/**
 * Rows stranded in an orphaned import WAL, read WITHOUT touching the originals.
 *
 * ⚠️ DO NOT "recover" by renaming `<db>.tmp-wal` onto `<db>-wal` in place. A
 * `-wal` is REPLACE semantics, not merge: once anything has opened the poisoned
 * store, `CREATE TABLE IF NOT EXISTS` gives it a usable empty table and new
 * sessions accumulate in the store's OWN `-wal`. Measured on Bun 1.4.0 — the
 * in-place rename overwrites that live WAL and ALSO fails to replay (the
 * orphan's frames describe the original bare shell, which the live writes have
 * since moved past): a store holding 3 fresh sessions went to 0 rows and the 40
 * stranded ones did not come back either. Net data destruction.
 *
 * So replay happens on a private COPY, and the caller merges the result without
 * overwriting anything live. A damaged orphan never yields half-parsed rows, but
 * it does NOT reliably announce itself either: measured shapes include throwing
 * `no such table` (no usable shell at all), replaying zero rows (frames accepted
 * but the transaction never committed), and — the dangerous one — quietly echoing
 * whatever the MAIN file already holds. Damage is therefore not detectable from
 * the returned rows; see the composite warning below.
 *
 * ⚠️ THE SCRATCH VIEW IS A COMPOSITE, not a picture of the WAL. It is "current
 * main file + orphan WAL", and SQLite silently IGNORES an orphan whose header is
 * invalid. So rows coming back prove nothing about the orphan: a store whose old
 * code wrote new sessions and checkpointed them into the main file replays those
 * live rows even when the orphan is entirely unreadable. Counting rows (or
 * checking they all parse) therefore cannot answer "did the WAL replay" — it
 * measures the wrong file.
 *
 * `walReplayed` answers that question with `PRAGMA wal_checkpoint(PASSIVE)`,
 * which reports how many WAL frames the engine actually ACCEPTED. Measured on
 * Bun 1.4.0 and Node 22.21.1 alike, against a 40-row orphan beside 3 live rows
 * already checkpointed into the main file:
 *
 *   intact orphan       → `{busy:0, log:17, checkpointed:17}`, SELECT sees 40
 *   header zeroed       → `{busy:0, log:0,  checkpointed:0}`,  SELECT sees 3 (live only)
 *   truncated to 20 KiB → `{busy:0, log:3,  checkpointed:3}`,  SELECT sees 0
 *
 * `log > 0` is what rules out the dangerous blind spot — the middle row, where
 * the WAL contributed NOTHING and the rows on screen are pure live main. It is
 * still not a completeness proof (the third row accepted 3 frames yet lost every
 * row), so it is paired with "the replay produced parseable rows". Anything not
 * proven replayed is archived rather than deleted.
 *
 * A differential replay of the shell WITHOUT the orphan is layered on top, so a
 * future engine that reports frames it then discards still cannot pass. That
 * comparison uses whole rows rather than ids: a valid orphan may UPDATE a row the
 * shell already carries, which an id-only diff would miss.
 */
function readStrandedImportRows(dbFp: string): {
  entries: [string, Session][];
  walReplayed: boolean;
} {
  const walFp = `${dbFp}.tmp-wal`;
  if (!existsSync(walFp)) return { entries: [], walReplayed: false };
  const scratchFp = `${dbFp}.recover-${process.pid}-${randomUUID()}`;
  const baseFp = `${dbFp}.recoverbase-${process.pid}-${randomUUID()}`;
  const scratchPaths = ['', '-journal', '-wal', '-shm'].flatMap(suffix => [
    `${scratchFp}${suffix}`,
    `${baseFp}${suffix}`,
  ]);
  const dropScratch = (): void => {
    for (const path of scratchPaths) {
      try { unlinkSync(path); } catch { /* nothing to drop */ }
    }
  };
  /** session_id → row the shell exposes on its own (no orphan attached). Full
   *  rows, not just ids: a valid orphan may UPDATE an id the shell already has,
   *  and comparing ids alone would score that as "the WAL contributed nothing". */
  const readBaselineRows = (): Map<string, string> => {
    copyFileSync(dbFp, baseFp);
    try {
      const db = openDatabaseSyncOrThrow(baseFp);
      try {
        db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
        const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
        return new Map(rows.map(r => [r.session_id, r.row]));
      } finally {
        db.close();
      }
    } catch {
      // A bare shell with no table is the normal baseline for a poisoned store.
      return new Map();
    }
  };
  try {
    const baselineRows = readBaselineRows();
    // The published `.db` is the exact shell those WAL frames were written
    // against, so it is the shell the replay must run on.
    copyFileSync(dbFp, scratchFp);
    copyFileSync(walFp, `${scratchFp}-wal`);
    const db = openDatabaseSyncOrThrow(scratchFp);
    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
      // Must run BEFORE the SELECT: it reports the frames the engine accepted
      // from this orphan, which is the only direct evidence the WAL was used.
      let acceptedFrames = 0;
      try {
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log?: number | bigint } | undefined;
        acceptedFrames = Number(checkpoint?.log ?? 0);
      } catch {
        // Treat an unavailable pragma as "cannot prove the WAL replayed".
        acceptedFrames = 0;
      }
      const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
      const entries: [string, Session][] = [];
      let unparseable = 0;
      let beyondBaseline = 0;
      for (const r of rows) {
        if (baselineRows.get(r.session_id) !== r.row) beyondBaseline++;
        try { entries.push([r.session_id, JSON.parse(r.row) as Session]); } catch { unparseable++; }
      }
      // "The orphan demonstrably replayed": SQLite accepted frames from it AND
      // it contributed rows the shell did not already have, with nothing corrupt.
      //
      // Deliberately NOT extended to "the row sets happen to match, so a previous
      // pass must have merged it". That inference is timing-dependent — a
      // truncated orphan beside live rows can produce an identical-looking
      // observation while its real rows are unaccounted for — so the retry path
      // is answered by a durable RECEIPT instead (see recoverPoisonedSqliteStore).
      const walReplayed = acceptedFrames > 0 && unparseable === 0 && beyondBaseline > 0;
      return { entries, walReplayed };
    } finally {
      db.close();
    }
  } finally {
    dropScratch();
  }
}

/**
 * Repair a store poisoned by a crashed pre-fix import, in place, and report how
 * many rows were rescued. MUST be called with the store's JSON file lock held —
 * the same lock the import, daemon saves and offline CLI mutations use.
 *
 * TWO sources are merged, because neither alone is sufficient:
 *   • the orphaned WAL — the only copy of anything written after the JSON was
 *     frozen, and the only source at all if the JSON has since been removed;
 *   • the frozen JSON — the import read exclusively from it, so it is normally a
 *     superset of the stranded rows, and the only source that survives a DAMAGED
 *     orphan. "Normally": the file can later be trimmed or partially restored,
 *     so it is not treated as authoritative on its own.
 * A partially-written orphan is precisely why both are needed: truncating one
 * replays as "schema, zero rows" without any error, so trusting the orphan alone
 * would delete it and report a healthy EMPTY store — the very silent-loss bug
 * this function exists to end.
 *
 * Two independent decisions come out of that, and conflating them is what makes
 * this subtle:
 *
 * 1. MAY WE PROCEED AT ALL? Only with POSITIVE ATTESTATION of what the store
 *    held. Three things can supply it:
 *      • the orphan demonstrably replayed rows;
 *      • a snapshot file was actually READ — about the source, not the row
 *        count: a legacy `sessions.json` that parses and filters down to zero
 *        rows for this bot proves the store held nothing, while a MISSING file
 *        proves nothing at all;
 *      • a RECEIPT for this exact orphan digest, written by an earlier pass in
 *        the same transaction as its merge — the only proof that survives a
 *        crash, and the one that lets an interrupted cleanup finish.
 *    With none of them, "zero rows" is indistinguishable from "damaged, contents
 *    unknown", so recovery refuses and keeps the orphans for manual rescue.
 *
 * 2. MAY WE DESTROY THE ORPHAN? Only when its contents are accounted for. Frame
 *    counts cannot establish that: a WAL truncated mid-transaction still gets
 *    frames ACCEPTED (its schema prefix) while contributing no data rows at all,
 *    because the missing commit frame means SQLite exposes none of that
 *    transaction. Equally, "we merged something" is not proof nothing was lost —
 *    with a trimmed snapshot beside a damaged orphan, both sources can be missing
 *    the same session and the merge silently converges on an incomplete store.
 *    When completeness cannot be proven, the
 *    pair is ARCHIVED rather than deleted — `<db>.unrecovered-<ts>.db` plus its
 *    `-wal`: the ORIGINAL bytes, kept beside the shell they belong to, for
 *    forensics or a manual salvage attempt.
 *
 *    It is deliberately NOT a promise that the couple replays. Measured: a WAL
 *    truncated mid-transaction hands back zero rows, because the missing commit
 *    frame means SQLite exposes no partial transaction at all — the damage lost
 *    those rows, not the archiving. What archiving guarantees is that nothing is
 *    thrown away: whatever a human can still extract remains extractable.
 *
 *    Archiving, rather than leaving the file in place, is also what makes the
 *    store usable again. The orphan path IS the poison predicate, so keeping
 *    `<db>.tmp-wal` there would re-enter recovery on every single start and leave
 *    every `owner:false` worker permanently fail-closed. And the shell is copied
 *    BEFORE the merge, since the merge advances the live database — a shell
 *    copied afterwards would no longer be the one those frames were written
 *    against.
 *
 * Merge policy is `INSERT OR IGNORE`: rows that exist live always win. Both
 * sources predate every live write by construction, so preferring live rows
 * cannot lose newer state. Verified: 40 stranded + 3 live → 43, both kept.
 *
 * Orphans are removed only after the merge commits, so a crash mid-recovery
 * leaves the store exactly as recoverable as it was before. The `.tmp-wal` is
 * deleted LAST, so a crash mid-cleanup always leaves the still-authoritative
 * file behind rather than a stray sidecar with the evidence already gone.
 */
function recoverPoisonedSqliteStore(dbFp: string, jsonFp: string): {
  merged: number;
  archivedEvidence?: string;
} {
  const walFp = `${dbFp}.tmp-wal`;
  const walPresent = existsSync(walFp);
  const walDigest = walPresent ? orphanWalDigest(walFp) : undefined;
  let stranded: [string, Session][] = [];
  let walReplayed = false;
  try {
    const replay = readStrandedImportRows(dbFp);
    stranded = replay.entries;
    walReplayed = replay.walReplayed;
  } catch (err) {
    logger.error(`Could not replay the orphaned import WAL for ${dbFp}: ${err}`);
  }

  let frozen: [string, Session][] = [];
  let frozenAttests = false;
  try {
    const snapshot = readFrozenSnapshotForImport(jsonFp);
    frozen = snapshot.entries;
    // A snapshot that was actually READ attests, even when it resolves to zero
    // rows for this bot — that is a positive statement about the store. Only
    // `none` (no readable file anywhere) fails to attest.
    frozenAttests = snapshot.source !== 'none';
  } catch (err) {
    logger.error(`Could not read the frozen JSON snapshot for ${dbFp}: ${err}`);
  }

  // The composite view can echo rows that live only in the MAIN file, so
  // `stranded.length` is not evidence about the orphan. Proceeding requires the
  // orphan to have demonstrably replayed, or a snapshot to have been read.
  const priorReceipt = hasPriorReceipt(dbFp, walDigest);
  if (!walReplayed && !frozenAttests && !priorReceipt) {
    throw new SessionStoreRecoveryUnattestedError(
      `cannot recover ${dbFp}: the orphaned import WAL could not be proven to have replayed and no frozen `
      + 'JSON snapshot could attest the store contents',
    );
  }

  // Archive BEFORE the merge: the shell must be the one those WAL frames were
  // written against, and the merge is about to change it. A receipt (checked in
  // the transaction below) can still spare an archive on the retry path, so this
  // decision is revisited there rather than being final here.
  let archivedEvidence: string | undefined;
  if (walPresent && !walReplayed && !priorReceipt) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveFp = `${dbFp}.unrecovered-${stamp}.db`;
    try {
      copyFileSync(dbFp, archiveFp);
      copyFileSync(walFp, `${archiveFp}-wal`);
      archivedEvidence = archiveFp;
    } catch (err) {
      // Could not preserve the couple — do NOT delete the original below.
      logger.error(`Could not archive the unrecovered import WAL for ${dbFp}: ${err}`);
      throw err;
    }
  }

  const db = openDbForOwnStore(dbFp);
  let merged = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Inside the transaction, so the schema write cannot advance the shell
      // before the archive above was taken.
      db.exec(RECOVERY_RECEIPTS_SCHEMA_SQL);
      const insert = db.prepare('INSERT OR IGNORE INTO sessions (session_id, status, row) VALUES (?, ?, ?)');
      for (const [key, value] of [...stranded, ...frozen]) {
        const result = insert.run(key, sessionStatusText(value), JSON.stringify(value));
        if (Number(result.changes) > 0) merged++;
      }
      // Record the receipt in the SAME transaction as the rows: either both land
      // or neither does, so a receipt can never claim a merge that did not commit.
      if (walDigest && walReplayed) {
        db.prepare('INSERT OR IGNORE INTO import_recovery_receipts (orphan_digest, merged_at, merged_rows) VALUES (?, ?, ?)')
          .run(walDigest, new Date().toISOString(), merged);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* txn already gone */ }
      throw err;
    }
  } finally {
    db.close();
  }
  // Committed, and anything unproven is archived under a name the poison
  // predicate ignores, so the originals can go.
  //
  // ORDER IS A CORRECTNESS PROPERTY, not tidiness. `<db>.tmp-wal` is the only
  // sidecar that carries rows, so it is deleted LAST and only once every other
  // sidecar is provably gone. That makes "just a lone `.tmp-shm`" unreachable —
  // neither a successful recovery nor a crash midway through cleanup can produce
  // it — which is what lets a lone `-shm` keep counting as a poisoned store
  // instead of being waved through as a healthy empty one. If any earlier unlink
  // fails, the WAL stays: the store still tests as poisoned and the next start
  // re-runs an idempotent merge.
  let sidecarsCleared = true;
  for (const path of orphanedImportSidecars(dbFp)) {
    if (path === walFp) continue;
    try {
      unlinkSync(path);
    } catch (err) {
      sidecarsCleared = false;
      logger.error(`Could not remove orphaned import sidecar ${path}: ${err}`);
    }
  }
  // The WAL may go once its contents are accounted for, which happens three ways:
  //   • this pass replayed it (its rows are now merged);
  //   • a receipt proves an earlier pass committed them (interrupted-cleanup retry);
  //   • it was ARCHIVED — the original bytes are preserved elsewhere, which is
  //     the whole point of archiving. (A failed copy throws above, so reaching
  //     here with `archivedEvidence` set means the copy succeeded.)
  const walAccountedFor = walReplayed || priorReceipt || archivedEvidence !== undefined;
  if (walPresent && sidecarsCleared && walAccountedFor) {
    try { unlinkSync(walFp); } catch (err) {
      logger.error(`Could not remove the orphaned import WAL ${walFp}: ${err}`);
    }
  } else if (walPresent && !archivedEvidence) {
    // Neither replayed nor receipted, and not archived either: leave it exactly
    // where it is. The store keeps testing as poisoned, which is the honest
    // state — its contents are unaccounted for.
    logger.warn(`Leaving ${walFp} in place: its rows are not accounted for.`);
  }
  return { merged, archivedEvidence };
}

/** Read this store's pre-SQLite JSON into the in-memory projection WITHOUT
 *  writing anything back. Only for a non-owning process during the upgrade
 *  window (see `load()`); the owning daemon imports instead. */
function loadFromFrozenJson(): void {
  const jsonFp = getImportJsonPath();
  const legacyFp = join(config.session.dataDir, 'sessions.json');
  const sourceFp = existsSync(jsonFp) ? jsonFp
    : currentAppId && existsSync(legacyFp) ? legacyFp
      : undefined;
  sessions = new Map();
  if (!sourceFp) return;
  try {
    const data = parseSessionsProjectionStrict(readFileSync(sourceFp, 'utf-8'), sourceFp);
    for (const [key, value] of Object.entries(data)) {
      if (sourceFp === legacyFp && value?.larkAppId !== currentAppId) continue;
      repairMissingChatScope(value);
      sessions.set(key, value);
    }
    logger.info(`Loaded ${sessions.size} sessions from ${sourceFp} (store not imported yet)`);
  } catch (err) {
    logger.error(`Failed to load sessions: ${err}`);
    loadFailure = err instanceof Error ? err : new Error(String(err));
    sessions = new Map();
  }
}

// Sessions persisted before 2026-04-29 lack `cliId`; consumers must fall back to 'unknown' at the render boundary.
function load(): void {
  if (loaded) return;
  ensureDir();
  const dbFp = getDbPath();
  const jsonFp = getImportJsonPath();

  // A poisoned store must never be mistaken for an empty one. Recover it before
  // anything reads it, or fail closed so listSessionsStrict() throws instead of
  // answering "there are no durable sessions".
  if (existsSync(dbFp) && orphanedImportSidecars(dbFp).length > 0) {
    if (!sqliteBootstrapAllowed) {
      // A worker must not repair a store its still-running daemon owns. Report
      // unavailable rather than serve the truncated view.
      loadFailure = new Error(
        `session store ${dbFp} has orphaned import sidecars (${orphanedImportSidecars(dbFp).join(', ')}); `
        + 'a non-owning process may not recover it',
      );
      logger.error(`Refusing to load poisoned session store as a non-owner: ${loadFailure.message}`);
      sessions = new Map();
      loaded = true;
      return;
    }
    try {
      withFileLockSync(jsonFp, () => {
        // Re-check under the lock: another owning process may have just fixed it.
        if (orphanedImportSidecars(dbFp).length === 0) return;
        const { merged, archivedEvidence } = recoverPoisonedSqliteStore(dbFp, jsonFp);
        if (archivedEvidence) {
          // The merge committed, but the orphan could not be proven to have
          // replayed, so a matched shell+WAL couple was archived under a name
          // the poison predicate ignores. Say so loudly: the store is usable,
          // yet a human may still want to replay that couple by hand.
          logger.warn(
            `Recovered ${merged} session row(s) stranded by a crashed SQLite import into ${dbFp}, but the `
            + `orphaned WAL could not be proven to have replayed — archived the matching shell+WAL couple to `
            + `${archivedEvidence}(-wal) for manual inspection. Delete it once you are satisfied nothing is missing.`,
          );
        } else {
          logger.warn(
            `Recovered ${merged} session row(s) stranded by a crashed SQLite import into ${dbFp}; `
            + 'removed the orphaned .tmp sidecars',
          );
        }
      });
    } catch (err) {
      if (isTransientStoreContentionError(err)) throw err;
      // Fail closed: the rows are still on disk, but this process cannot prove
      // what the store holds, so it must not report an empty projection.
      logger.error(`Failed to recover poisoned session store ${dbFp}: ${err}`);
      loadFailure = err instanceof Error ? err : new Error(String(err));
      sessions = new Map();
      loaded = true;
      return;
    }
  }

  if (!existsSync(dbFp)) {
    if (!sqliteBootstrapAllowed) {
      // `owner: false` (a worker) and no store yet: the daemon that spawned it
      // still runs the pre-SQLite build and keeps writing its JSON, so this
      // process reads THAT — creating a .db behind that daemon's back would
      // fork the two representations. Read-only: the repairs and the
      // legacy→per-bot migration are the owning daemon's job, and it does them
      // once, as the import.
      loadFromFrozenJson();
      loaded = true;
      return;
    }
    // First start on the SQLite engine: import this store's pre-SQLite JSON
    // rows (or create an empty store).
    //
    // This is the ONLY file lock left in the store — the save/load/offline-write
    // orchestration it used to serialise is gone with the JSON engine. It stays
    // because the import stages through a FIXED `<db>.tmp` path, and two owning
    // processes for the same bot can briefly overlap (a restart racing a not-yet
    // reaped predecessor): both would pass `existsSync(db)`, write the same tmp
    // file, and publish a corrupt database. A per-process tmp name would trade
    // that for orphan files no one cleans up, and building straight into the
    // final `.db` would break the invariant this design rests on — "the .db
    // exists" must mean "the import completed", or a partial import silently
    // disables the import gate and drops every pre-SQLite row.
    mkdirSync(dirname(dbFp), { recursive: true });
    try {
      withFileLockSync(jsonFp, () => {
        if (existsSync(dbFp)) return; // another owning process won the import
        const imported = importJsonStoreToSqlite(dbFp, jsonFp);
        if (imported > 0) {
          logger.info(`Imported ${imported} session row(s) from JSON into ${dbFp}; JSON files stay frozen for rollback`);
        }
      });
    } catch (err) {
      if (isTransientStoreContentionError(err)) throw err;
      logger.error(`Failed to import sessions into SQLite: ${err}`);
      loadFailure = err instanceof Error ? err : new Error(String(err));
      sessions = new Map();
      loaded = true;
      return;
    }
  }

  let store: OwnSqliteStore;
  try {
    store = attachOwnStore(dbFp);
  } catch (err) {
    // Schema DDL is a real write on a store that predates a table (the
    // occupancy CREATE on first boot after upgrade) and can wait out an
    // offline writer's BEGIN IMMEDIATE — retryable, not a corrupt store.
    if (isTransientStoreContentionError(err)) throw err;
    // Unreadable/corrupt .db: fail-closed for every write gate.
    logger.error(`Failed to load sessions: ${err}`);
    loadFailure = err instanceof Error ? err : new Error(String(err));
    sessions = new Map();
    loaded = true;
    return;
  }
  sessions = new Map();
  // 排他读 + 占位：BEGIN IMMEDIATE 与离线 CLI 写者互斥后再取快照，并在同一
  // 事务写入 occupancy。纯 SELECT 不被写事务排斥——若一个已通过探测、正持有
  // IMMEDIATE 的离线 CLI 尚未 commit，普通读会把它提交前的旧行读进终身缓存，
  // 随后的行写回就会覆盖掉 CLI 的提交。descriptor 文件仍用于 IPC 发现，所有权
  // 以本事务里的租约为准。
  try {
    store.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      for (const [key, value] of readOwnStoreAllRows(store)) sessions.set(key, value);
      claimOccupancyOnLoad(store.db, Date.now());
      // COMMIT publishes the claim. Its failure must surface (a cache marked
      // loaded over a silently rolled-back lease would run unowned), so it is
      // not swallowed the way a SELECT-only transaction's used to be.
      store.db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { store.db.exec('ROLLBACK'); } catch { /* txn already gone */ } }
    }
  } catch (err) {
    // Lock contention (SQLITE_BUSY after busy_timeout) must NOT become
    // loadFailure + empty cache: daemon startup uses listSessions(), which
    // would then restore nothing while the durable store is healthy.
    if (ownStore) {
      try { ownStore.db.close(); } catch { /* already closed */ }
      ownStore = undefined;
    }
    sessions = new Map();
    throw err;
  }
  logger.info(`Loaded ${sessions.size} sessions from ${dbFp}`);
  loaded = true;
}

/**
 * Mutations must never proceed from the compatibility reader's empty
 * projection after a load failure. In particular, serialising that empty
 * cache would replace the unreadable durable file and destroy the only copy
 * of its rows. Keep the failure sticky until init() explicitly reloads the
 * selected store, matching listSessionsStrict().
 */
function loadForWrite(): void {
  load();
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
  migrateCodexInstanceBindings();
}

/** Migrate all recoverable rows before first admission/restore, not just active ones. */
function migrateCodexInstanceBindings(): void {
  const bot = configuredCodexInstanceBot(currentAppId);
  if (!sqliteBootstrapAllowed || !ownStore || !bot?.codexInstancePool) return;
  const configKey = JSON.stringify([bot.codexInstancePool, bot.cliId, bot.cliRuntime, bot.cliPathOverride, bot.codexAuthSync]);
  if (migratedCodexInstanceConfig === configKey) return;
  const changes: Session[] = [];
  ownStore.db.exec('BEGIN IMMEDIATE');
  try {
   for (const durable of readOwnStoreAllRows(ownStore).map(([, row]) => row)) {
    const binding = legacyCodexInstanceBinding(durable, bot, botHomePath(dirname(config.session.dataDir), bot.larkAppId));
    if (!binding) continue;
    const cliId = durable.cliId ?? bot.cliId;
    const next: Session = { ...durable, cliInstanceBinding: binding, cliId, agentFrozen: true,
      reasoningEffort: durable.agentFrozen ? durable.reasoningEffort : durable.reasoningEffort ?? bot.reasoningEffort,
      cliRuntime: durable.cliRuntime ?? snapshotCliRuntime(resolveCliRuntime({ cliId,
        cliRuntime: durable.agentFrozen || durable.cliPathOverride ? undefined : bot.cliRuntime,
        cliPathOverride: durable.cliPathOverride ?? (durable.agentFrozen || bot.cliRuntime ? undefined : bot.cliPathOverride),
        context: 'legacy Codex instance migration' })) };
    changes.push(next);
   }
    for (const next of changes) persistRow(next);
    ownStore.db.exec('COMMIT');
  } catch (error) { ownStore.db.exec('ROLLBACK'); throw error; }
  migratedCodexInstanceConfig = configKey;
  for (const next of changes) {
    const cached = sessions.get(next.sessionId);
    if (cached) Object.assign(cached, next);
    else sessions.set(next.sessionId, next);
  }
}

function readOwnStoreAllRows(store: OwnSqliteStore): [string, Session][] {
  const rows = store.selectAll.all() as { session_id: string; row: string }[];
  const entries: [string, Session][] = [];
  for (const r of rows) {
    try { entries.push([r.session_id, JSON.parse(r.row) as Session]); } catch { /* skip unparseable row */ }
  }
  return entries;
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/** The connection `load()` attached for this process's own store. Going
 *  through load() is what keeps the import gate and the `owner: false`
 *  contract in one place instead of opening a second connection here (a
 *  read-write open would CREATE the store and poison the import gate). */
function withOwnStoreDb<T>(fn: (db: SqliteDatabaseLike) => T): T {
  loadForWrite();
  return fn(ownStore!.db);
}

/**
 * Sample every active Riff participant from one fresh sessions projection.
 * Fleet shutdown takes this snapshot before fencing any worker.
 */
export function getActiveRemoteShutdownSnapshotsBatch(
  sessionIds: readonly string[],
): ActiveRemoteShutdownSnapshot[] {
  if (sessionIds.length === 0) return [];
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RemoteLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate remote shutdown session ids: ${duplicates.join(', ')}`,
    );
  }

  loadForWrite();
  try {
    return withOwnStoreDb((db): ActiveRemoteShutdownSnapshot[] => {
      db.exec('BEGIN');
      try {
        const select = db.prepare('SELECT row FROM sessions WHERE session_id = ?');
        const fresh = new Map<string, Session | undefined>();
        for (const sessionId of sessionIds) {
          const hit = select.get(sessionId) as { row: string } | undefined;
          fresh.set(sessionId, hit ? JSON.parse(hit.row) as Session : undefined);
        }
        const invalid = sessionIds.filter((sessionId) => {
          const session = fresh.get(sessionId);
          return !session || session.status !== 'active';
        });
        if (invalid.length > 0) {
          throw new RemoteLineageBatchError(
            'prewrite_ownership',
            invalid,
            `cannot snapshot non-active remote sessions: ${invalid.join(', ')}`,
          );
        }
        return sessionIds.map((sessionId) => {
          const session = fresh.get(sessionId)!;
          return {
            sessionId,
            taskId: session.riffParentTaskId ?? null,
            owner: remoteDurableOwner(session),
          };
        });
      } finally {
        // 读事务收尾：COMMIT 失败（事务已 abort）时必须 ROLLBACK，
        // 长驻连接绝不能滞留在事务里。
        try { db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch { /* txn already gone */ } }
      }
    });
  } catch (error) {
    if (error instanceof RemoteLineageBatchError) throw error;
    throw new RemoteLineageBatchError(
      'prewrite_io',
      [...sessionIds],
      `failed to snapshot active remote sessions: ${String(error)}`,
    );
  }
}

/**
 * Commit every prepared remote lineage as one compare-and-set transaction.
 * The published rows are read back before workers are allowed to exit.
 */
export function persistActiveRemoteLineagesExactBatch(
  updates: readonly ActiveRemoteLineageBatchUpdate[],
): ActiveRemoteShutdownSnapshot[] {
  if (updates.length === 0) return [];
  const sessionIds = updates.map(update => update.sessionId);
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RemoteLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate remote lineage batch session ids: ${duplicates.join(', ')}`,
    );
  }

  loadForWrite();
  let published = false;
  try {
    return withOwnStoreDb((db): ActiveRemoteShutdownSnapshot[] => {
      const select = db.prepare('SELECT row FROM sessions WHERE session_id = ?');
      const update = db.prepare("UPDATE sessions SET status = ?, row = ? WHERE session_id = ?");
      let inTxn = false;
      let changed = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        inTxn = true;
        const freshRows = new Map<string, { session: Session; raw: string } | undefined>();
        for (const sessionId of sessionIds) {
          const hit = select.get(sessionId) as { row: string } | undefined;
          freshRows.set(sessionId, hit ? { session: JSON.parse(hit.row) as Session, raw: hit.row } : undefined);
        }
        const conflicts: string[] = [];
        for (const u of updates) {
          const durable = freshRows.get(u.sessionId)?.session;
          const durableTaskId = durable?.riffParentTaskId ?? null;
          if (!durable
              || durable.status !== 'active'
              || !u.expectedCurrentTaskIds.some(candidate => candidate === durableTaskId)
              || !remoteOwnersEqual(remoteDurableOwner(durable), u.owner)) {
            conflicts.push(u.sessionId);
          }
        }
        if (conflicts.length > 0) {
          throw new RemoteLineageBatchError(
            'prewrite_ownership',
            conflicts,
            `Remote lineage batch compare-and-set failed for: ${conflicts.join(', ')}`,
          );
        }
        for (const u of updates) {
          const fresh = freshRows.get(u.sessionId)!;
          const next: Session = {
            ...fresh.session,
            riffParentTaskId: u.targetTaskId ?? undefined,
          };
          const json = JSON.stringify(next);
          if (json !== fresh.raw) {
            update.run(sessionStatusText(next), json, u.sessionId);
            changed = true;
          }
        }
        db.exec('COMMIT');
        inTxn = false;
      } catch (err) {
        if (inTxn) { try { db.exec('ROLLBACK'); } catch { /* txn already gone */ } }
        throw err;
      }
      if (changed) {
        published = true;
        testOnlyAfterRemoteBatchRename?.();
      }

      // Read back the committed rows before any worker may exit.
      const verifiedRows = new Map<string, Session | undefined>();
      for (const sessionId of sessionIds) {
        const hit = select.get(sessionId) as { row: string } | undefined;
        verifiedRows.set(sessionId, hit ? JSON.parse(hit.row) as Session : undefined);
      }
      const ambiguous = updates.filter((u) => {
        const durable = verifiedRows.get(u.sessionId);
        return !durable
          || durable.status !== 'active'
          || (durable.riffParentTaskId ?? null) !== u.targetTaskId
          || !remoteOwnersEqual(remoteDurableOwner(durable), u.owner);
      }).map(u => u.sessionId);
      if (ambiguous.length > 0) {
        throw new RemoteLineageBatchError(
          published ? 'postrename_ambiguity' : 'prewrite_ownership',
          ambiguous,
          `Remote lineage batch readback mismatch for: ${ambiguous.join(', ')}`,
        );
      }

      const verified = updates.map((u) => ({
        sessionId: u.sessionId,
        taskId: u.targetTaskId,
        owner: remoteDurableOwner(verifiedRows.get(u.sessionId)!),
      }));
      if (loaded) {
        for (const u of updates) {
          const cached = sessions.get(u.sessionId);
          if (cached) cached.riffParentTaskId = u.targetTaskId ?? undefined;
        }
      }
      return verified;
    });
  } catch (error) {
    if (error instanceof RemoteLineageBatchError) throw error;
    throw new RemoteLineageBatchError(
      published ? 'postrename_ambiguity' : 'prewrite_io',
      [...sessionIds],
      `failed to persist Remote lineage batch: ${String(error)}`,
    );
  }
}

/** Persist ONE changed row: a dirty-row upsert. A redundant update that leaves
 *  the serialized row identical skips the write — the daemon fires several
 *  updateSession() calls per inbound message (activity bump, pid, stream-card
 *  state, …) and many of them change nothing. */
function persistRow(session: Session): void {
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
  if (!ownStore) {
    throw new SessionStoreUnavailableError(
      new Error(`session store ${getDbPath()} is not attached`),
    );
  }
  testOnlyBeforeRowPersist?.(session.sessionId);
  const existing = ownStore.selectRow.get(session.sessionId) as { row: string } | undefined;
  if (existing) {
    const durable = JSON.parse(existing.row) as Session;
    if (durable.cliInstanceBinding) {
      if (session.cliInstanceBinding && JSON.stringify(session.cliInstanceBinding) !== JSON.stringify(durable.cliInstanceBinding)) {
        throw new Error('Codex instance binding is immutable');
      }
      // Whole-row writers may hold pre-migration objects. Carry forward the
      // complete routing identity rather than letting them erase one field.
      session = { ...session, cliInstanceBinding: durable.cliInstanceBinding, creationSource: durable.creationSource,
        cliId: durable.cliId, cliRuntime: durable.cliRuntime, cliPathOverride: durable.cliPathOverride,
        wrapperCli: durable.wrapperCli, cliLaunchMode: durable.cliLaunchMode, agentFrozen: durable.agentFrozen };
    }
  }
  const json = JSON.stringify(session);
  if (existing?.row === json) return;
  // Compare-and-set across the read/merge/write boundary. An offline writer
  // must not install a binding between our SELECT and an unconditional UPSERT.
  const result = existing
    ? ownStore.updateExact.run(sessionStatusText(session), json, session.sessionId, existing.row)
    : ownStore.insertNew.run(session.sessionId, sessionStatusText(session), json);
  if (Number(result.changes) !== 1) throw new Error('Session changed concurrently; routing write refused');
}

function buildNewSession(
  chatId: string,
  rootMessageId: string,
  title: string,
  chatType?: 'group' | 'p2p',
  scope?: 'thread' | 'chat',
  intent: { source?: SessionCreationSource; inherit?: Session } = {},
): Session {
  const bot = configuredCodexInstanceBot(currentAppId);
  const source = intent.source ?? 'other';
  const initial = intent.inherit ? {
    cliInstanceBinding: intent.inherit.cliInstanceBinding,
    cliId: intent.inherit.cliId, cliRuntime: intent.inherit.cliRuntime, cliPathOverride: intent.inherit.cliPathOverride,
    wrapperCli: intent.inherit.wrapperCli, cliLaunchMode: intent.inherit.cliLaunchMode, agentFrozen: intent.inherit.agentFrozen, creationSource: 'fork' as const,
  } : bot ? newSessionCodexInstanceState(bot, source) : {};
  const session: Session = {
    sessionId: randomUUID(),
    chatId,
    chatType,
    rootMessageId,
    scope,
    title,
    status: 'active',
    createdAt: new Date().toISOString(),
    creationSource: source,
    ...initial,
  };
  if (chatType !== 'p2p' && scope !== 'chat') {
    const models = resolveGroupDefaultModels?.(chatId);
    if (models && Object.keys(models).length) session.groupDefaultModels = structuredClone(models);
  }
  return session;
}

export function createSession(
  chatId: string,
  rootMessageId: string,
  title: string,
  chatType?: 'group' | 'p2p',
  scope?: 'thread' | 'chat',
  intent: { source?: SessionCreationSource; inherit?: Session } = {},
): Session {
  loadForWrite();
  const session = buildNewSession(chatId, rootMessageId, title, chatType, scope, intent);
  persistRow(session);
  sessions.set(session.sessionId, session);
  logger.info(`Created session ${session.sessionId} (thread: ${rootMessageId})`);
  return session;
}

/**
 * Create one session and mutate a fixed set of existing owned sessions in the
 * same transaction. The new row is invisible to the cache until COMMIT.
 *
 * This is deliberately separate from createSession(): callers that publish a
 * child whose safety metadata lives on its parent must not leave a crash
 * window in which the child is durable but the parent-side authority is not.
 */
export function createSessionWithOwnedMutation<T>(
  args: {
    chatId: string;
    rootMessageId: string;
    title: string;
    chatType?: 'group' | 'p2p';
    scope?: 'thread' | 'chat';
    intent?: { source?: SessionCreationSource; inherit?: Session };
    ownedSessionIds: readonly string[];
    /** Fail fast with SessionStoreBusyError instead of blocking the daemon's
     * event loop behind the connection's normal busy_timeout. */
    nonblocking?: boolean;
  },
  mutate: (fresh: Map<string, Session>, created: Session) => T,
): { session: Session; result: T; rows: Map<string, Session> } {
  loadForWrite();
  const unique = [...new Set(args.ownedSessionIds)];
  if (unique.length !== args.ownedSessionIds.length) {
    throw new Error('duplicate session id in atomic session creation');
  }
  const store = ownStore;
  if (!store) {
    throw new SessionStoreUnavailableError(new Error('owned session store is not attached'));
  }
  const created = buildNewSession(
    args.chatId,
    args.rootMessageId,
    args.title,
    args.chatType,
    args.scope,
    args.intent,
  );
  const fresh = new Map<string, Session>();
  let result!: T;
  runOwnedWriteTransaction(store, args.nonblocking === true, () => {
    for (const sessionId of unique) {
      const hit = store.selectRow.get(sessionId) as { row: string } | undefined;
      if (!hit) throw new Error(`atomic session creation cannot find ${sessionId}`);
      fresh.set(sessionId, structuredClone(JSON.parse(hit.row) as Session));
    }
    result = mutate(fresh, created);
    for (const row of fresh.values()) persistRow(row);
    persistRow(created);
  });
  for (const [sessionId, row] of fresh) {
    const cached = sessions.get(sessionId);
    if (cached) {
      for (const key of Object.keys(cached)) delete (cached as unknown as Record<string, unknown>)[key];
      Object.assign(cached, structuredClone(row));
      fresh.set(sessionId, cached);
    } else {
      sessions.set(sessionId, row);
    }
  }
  sessions.set(created.sessionId, created);
  logger.info(`Created session ${created.sessionId} (thread: ${args.rootMessageId})`);
  return { session: created, result, rows: fresh };
}

export function getSession(sessionId: string): Session | undefined {
  load();
  return sessions.get(sessionId) ?? findInOtherFiles(sessionId);
}

const bridgeMarkerCleanupFences = new Map<string, Promise<void>>();

export function registerSessionBridgeSendMarkerCleanupFence(
  sessionId: string,
  fence: Promise<void>,
): void {
  bridgeMarkerCleanupFences.set(sessionId, fence);
  void fence.then(
    () => {
      if (bridgeMarkerCleanupFences.get(sessionId) === fence) {
        bridgeMarkerCleanupFences.delete(sessionId);
      }
    },
    () => {
      if (bridgeMarkerCleanupFences.get(sessionId) === fence) {
        bridgeMarkerCleanupFences.delete(sessionId);
      }
    },
  );
}

/**
 * Return a row only when it belongs to this process's currently-initialised
 * bot store. Mutating daemon endpoints must use this instead of getSession(),
 * whose cross-file fallback is intentionally read-only discovery.
 */
export function getOwnedSession(sessionId: string): Session | undefined {
  load();
  return sessions.get(sessionId);
}

/** Cross-process fresh read. SQLite: a point SELECT observes the last committed
 *  write (WAL orders the daemon against offline CLI writers). JSON (a store the
 *  owning daemon has not imported yet): ordered after writers by the shared file
 *  lock, as before. */
export function getSessionFresh(sessionId: string): Session | undefined {
  ensureDir();
  const dbFp = getDbPath();
  if (existsSync(dbFp)) {
    try {
      return readStoreRowByKey({ appId: currentAppId, kind: 'sqlite', path: dbFp }, sessionId);
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      return undefined;
    }
  }
  const fp = getImportJsonPath();
  return withFileLockSync(fp, () => {
    if (!existsSync(fp)) return undefined;
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, Session>;
      return data[sessionId];
    } catch {
      return undefined;
    }
  });
}

/**
 * Search all session stores for a session not found in the current store.
 *
 * Sessions are partitioned per-bot, but agent-facing CLI subcommands
 * (`botmux send`, etc.) may be invoked in contexts where LARK_APP_ID isn't
 * set, so they can't pick the right store directly. Scanning all stores is
 * safe — these callers only read sessions.
 */
function findInOtherFiles(sessionId: string): Session | undefined {
  const dataDir = config.session.dataDir;
  let refs: StoreFileRef[];
  try {
    refs = listStoreRefs(dataDir);
  } catch { return undefined; }
  for (const ref of refs) {
    if (ref.appId === currentAppId) continue;
    try {
      const hit = readStoreRowByKey(ref, sessionId);
      if (hit) return hit;
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      continue;
    }
  }
  return undefined;
}

export function cleanupSessionBridgeSendMarkersNow(sessionId: string): void {
  try { unlinkSync(join(config.session.dataDir, 'turn-sends', `${sessionId}.jsonl`)); } catch { /* absent/best effort */ }
}

export function cleanupSessionBridgeSendMarkers(sessionId: string): void {
  const fence = bridgeMarkerCleanupFences.get(sessionId);
  if (fence) {
    void fence.then(
      () => cleanupSessionBridgeSendMarkersNow(sessionId),
      () => cleanupSessionBridgeSendMarkersNow(sessionId),
    );
    return;
  }
  cleanupSessionBridgeSendMarkersNow(sessionId);
}

export function isValidMojoCloseJournal(
  value: unknown,
): value is NonNullable<Session['mojoCloseJournal']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  if (journal.phase !== 'preparing'
      && journal.phase !== 'prepared'
      && journal.phase !== 'uncertain') return false;
  if (typeof journal.requestId !== 'string' || !journal.requestId.trim()) return false;
  if (typeof journal.updatedAt !== 'string' || !journal.updatedAt.trim()) return false;
  if (journal.recovery !== undefined
      && journal.recovery !== 'retryable'
      && journal.recovery !== 'uncertain'
      && journal.recovery !== 'irreversible') return false;
  if (journal.admission !== undefined
      && journal.admission !== 'restorable'
      && journal.admission !== 'fenced') return false;
  if (journal.commitOnly !== undefined && typeof journal.commitOnly !== 'boolean') return false;
  if (journal.localResidual !== undefined
      && journal.localResidual !== 'local_subtree_unprovable_on_platform'
      && journal.localResidual !== 'local_subtree_boundary_unproven') return false;
  // A retryable verdict never proves an irreversible teardown, so it must not
  // arrive wearing the marker that suppresses further cancellation.
  if (journal.recovery === 'retryable' && journal.commitOnly === true) return false;
  // An irreversible verdict is only ever legal as a commit-only `prepared` row:
  // the remote side is gone, so nothing may cancel or abort it again.
  if (journal.recovery === 'irreversible'
      && (journal.phase !== 'prepared' || journal.commitOnly !== true)) return false;
  if (journal.commitOnly === true && journal.phase !== 'prepared') return false;
  return journal.taskId === undefined
    || (typeof journal.taskId === 'string' && !!journal.taskId.trim());
}

function mutateMojoCloseJournal(
  sessionId: string,
  mutate: (session: Session) => void,
): Session {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'active') {
    throw new Error(`cannot mutate Mojo close journal for non-active session ${sessionId}`);
  }
  if (session.backendType !== 'mojo') {
    throw new Error(`cannot mutate Mojo close journal for non-Mojo session ${sessionId}`);
  }
  if (session.mojoCloseJournal && !isValidMojoCloseJournal(session.mojoCloseJournal)) {
    throw new Error(`cannot mutate malformed Mojo close journal for ${sessionId}`);
  }
  // Durable first: `mutate` works on a copy, and a failed persist leaves the
  // live row untouched — including when `mutate` itself rejects the transition.
  const next: Session = { ...session };
  mutate(next);
  persistRow(next);
  Object.assign(session, next);
  return session;
}

/** Persist the admission fence before any authoritative Mojo cancel begins. */
export function beginMojoCloseJournal(
  sessionId: string,
  requestId: string,
  expectedTaskId?: string,
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    if (session.riffParentTaskId !== expectedTaskId) {
      throw new Error(`Mojo close lineage changed before prepare for ${sessionId}`);
    }
    const existing = session.mojoCloseJournal;
    if (existing) {
      if (existing.commitOnly) {
        // The remote teardown already completed irreversibly; only the local
        // commit may be retried. Starting a second cancel here is exactly the
        // double teardown this journal exists to prevent.
        throw new Error(`cannot re-cancel commit-only Mojo close journal for ${sessionId}`);
      }
      if (existing.phase !== 'preparing' && existing.phase !== 'uncertain') {
        throw new Error(`cannot restart ${existing.phase} Mojo close journal for ${sessionId}`);
      }
      if (existing.taskId !== expectedTaskId) {
        throw new Error(`Mojo close journal lineage changed before retry for ${sessionId}`);
      }
      if (existing.requestId !== requestId) {
        if (existing.phase !== 'uncertain' && existing.recovery !== 'retryable') {
          throw new Error(`another Mojo close journal already owns ${sessionId}`);
        }
        // Two journal shapes accept a fresh attempt under a NEW requestId:
        //   * `retryable` — the failed prepare durably recorded that retrying
        //     the cancel is legitimate. Refusing every fresh requestId here is
        //     what made `retryable` dead-code and the row a permanent brick
        //     (P1-1/P1-2).
        //   * `uncertain` — an explicit close IS the manual reconciliation the
        //     fence demanded. Only a live worker's prepare/commit reaches this
        //     takeover (ownerless uncertain rows DRAIN instead — see
        //     prepareMojoExplicitClose), and re-running the cancel is the
        //     fail-safe direction: the frozen identity pins the tenant, and an
        //     already-terminal remote session is classified as gone, not as a
        //     second teardown. Without the takeover the live-worker case had no
        //     exit at all (P0-new).
        // commitOnly / `prepared` journals were rejected above and stay
        // non-restartable: those record an IRREVERSIBLE teardown. The row is
        // rebuilt from scratch so the stale recovery/admission verdict cannot
        // survive into the new attempt; lineage equality was asserted above, so
        // the retry still addresses the same remote session.
        session.mojoCloseJournal = {
          phase: 'preparing',
          requestId,
          ...(expectedTaskId ? { taskId: expectedTaskId } : {}),
          updatedAt: new Date().toISOString(),
        };
      }
      return;
    }
    session.mojoCloseJournal = {
      phase: 'preparing',
      requestId,
      ...(expectedTaskId ? { taskId: expectedTaskId } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Publish irreversible remote-cancel proof before the local close commit. */
export function markMojoClosePrepared(
  sessionId: string,
  requestId: string,
  taskId?: string,
  localResidual?: NonNullable<Session['mojoCloseJournal']>['localResidual'],
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    const existing = session.mojoCloseJournal;
    if (existing && existing.requestId !== requestId) {
      throw new Error(`stale Mojo close prepare for ${sessionId}`);
    }
    if (existing?.phase === 'uncertain') {
      throw new Error(`cannot promote uncertain Mojo close journal for ${sessionId}`);
    }
    if (existing?.taskId && taskId && existing.taskId !== taskId) {
      throw new Error(`Mojo close proof changed journal lineage for ${sessionId}`);
    }
    const provenTaskId = taskId ?? existing?.taskId;
    if (provenTaskId && session.riffParentTaskId
        && session.riffParentTaskId !== provenTaskId) {
      throw new Error(`Mojo close result lineage changed for ${sessionId}`);
    }
    if (provenTaskId) session.riffParentTaskId = provenTaskId;
    // The residual is part of the PROOF being published: a replay of this
    // prepared journal (runtime commit retry, or a daemon restart) must publish
    // the same residual close it describes. A repeat prepare without one keeps
    // the recorded residual — the evidence grade of the original close does not
    // improve by being replayed.
    const provenResidual = localResidual ?? existing?.localResidual;
    session.mojoCloseJournal = {
      phase: 'prepared',
      requestId,
      ...(provenTaskId ? { taskId: provenTaskId } : {}),
      ...(provenResidual ? { localResidual: provenResidual } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Finish a failed prepare after worker admission restore. If restore was not
 * proven, keep a durable uncertain fence; either way retain a newly discovered
 * pre-init lineage for later reconciliation.
 */
export function finishMojoCloseAbort(
  sessionId: string,
  requestId: string,
  options: { admissionRestored: boolean; taskId?: string },
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    const existing = session.mojoCloseJournal;
    if (!existing || existing.requestId !== requestId) {
      throw new Error(`stale Mojo close abort for ${sessionId}`);
    }
    if (existing.commitOnly || existing.recovery === 'irreversible') {
      // Checked BEFORE the generic prepared guard so the refusal names the reason:
      // rolling this back would re-open write admission on a lineage whose remote
      // side is already gone, leaving a session that looks writable and can never
      // continue.
      throw new Error(`cannot abort irreversible Mojo close journal for ${sessionId}`);
    }
    if (existing.phase === 'prepared') {
      throw new Error(`cannot abort prepared Mojo close proof for ${sessionId}`);
    }
    if (existing.taskId && options.taskId && existing.taskId !== options.taskId) {
      throw new Error(`Mojo close abort changed journal lineage for ${sessionId}`);
    }
    const retainedTaskId = options.taskId ?? existing.taskId;
    if (retainedTaskId && session.riffParentTaskId
        && session.riffParentTaskId !== retainedTaskId) {
      throw new Error(`Mojo close abort lineage changed for ${sessionId}`);
    }
    if (retainedTaskId) session.riffParentTaskId = retainedTaskId;
    if (options.admissionRestored) {
      session.mojoCloseJournal = undefined;
      return;
    }
    session.mojoCloseJournal = {
      phase: 'uncertain',
      requestId,
      ...(retainedTaskId ? { taskId: retainedTaskId } : {}),
      recovery: 'uncertain',
      admission: 'fenced',
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Persist a FAILED prepare that must NOT be rolled back, with its exact verdict.
 *
 * Such a prepare previously left the journal at `preparing` carrying the
 * PRE-prepare task id: a restart could not tell "reconcile me" apart from "only
 * the local commit is left", the lineage the worker actually reported was
 * dropped, and nothing recorded that write admission was never re-opened.
 *
 * `irreversible` is stored as a commit-only `prepared` row on purpose - every
 * existing recovery path (restore, retry, abort) then treats it as
 * un-cancellable and finishes only the local close.
 */
export function markMojoCloseUnresolved(
  sessionId: string,
  requestId: string,
  options: {
    /**
     * Whether the CLOSE may be retried. `retryable` is a legitimate value here:
     * a close that keeps writes fenced is not automatically un-retryable, and
     * forcing it into `uncertain` would forbid the retry that can still succeed.
     */
    recovery: 'retryable' | 'uncertain' | 'irreversible';
    taskId?: string;
    /** Whether a new WRITE may be admitted. Recorded verbatim, never derived. */
    admission: 'restorable' | 'fenced';
  },
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    const existing = session.mojoCloseJournal;
    if (existing && existing.requestId !== requestId) {
      throw new Error(`stale Mojo close verdict for ${sessionId}`);
    }
    if (existing?.commitOnly && options.recovery !== 'irreversible') {
      // Never downgrade a recorded irreversible teardown into something a later
      // caller may cancel or abort again.
      throw new Error(`cannot downgrade commit-only Mojo close journal for ${sessionId}`);
    }
    if (existing?.taskId && options.taskId && existing.taskId !== options.taskId) {
      throw new Error(`Mojo close verdict changed journal lineage for ${sessionId}`);
    }
    const exactTaskId = options.taskId ?? existing?.taskId;
    if (exactTaskId && session.riffParentTaskId
        && session.riffParentTaskId !== exactTaskId) {
      throw new Error(`Mojo close verdict lineage changed for ${sessionId}`);
    }
    // The worker may have learned the lineage only DURING the prepare (the
    // pre-init window), so persist that exact id: a retry or a manual
    // reconciliation must address the real remote session, not the stale guess.
    if (exactTaskId) session.riffParentTaskId = exactTaskId;
    const irreversible = options.recovery === 'irreversible';
    // A still-retryable close keeps its `preparing` intent: a retry SHOULD re-run
    // the cancel. Promoting it to `uncertain` would demand manual reconciliation
    // for a failure the retry can clear on its own -- while `admission: 'fenced'`
    // independently keeps writes out.
    const phase = irreversible
      ? 'prepared'
      : options.recovery === 'retryable' ? 'preparing' : 'uncertain';
    session.mojoCloseJournal = {
      phase,
      requestId,
      ...(exactTaskId ? { taskId: exactTaskId } : {}),
      recovery: options.recovery,
      admission: options.admission,
      ...(irreversible ? { commitOnly: true } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

export function closeSession(
  sessionId: string,
  opts: {
    cleanupBridgeMarkers?: boolean;
    clearRiffParentTaskId?: boolean;
    /**
     * Park an uncancellable mojo lineage as PART of this transaction.
     *
     * The caller must not pre-write this onto its own Session object: the runtime
     * object is not always the authoritative row (and when it is, a failed save
     * would leave a parked id the rollback below does not know about). Merging it
     * here — against the store's own row, snapshotted and rolled back with
     * everything else — is what makes "closed + parked" actually atomic.
     */
    parkMojoLineage?: string;
    /**
     * Park a LOCAL-subtree residual as PART of this transaction, so an idempotent
     * re-close of the already-closed row still reports `closed_with_residual`.
     * The journal (the residual's other home) is wiped on commit below, and a
     * client that lost the first response and retries would otherwise get a false
     * all-clear while the containment handle and blocker are still held.
     */
    parkLocalResidual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
  } = {},
): void {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (session) {
    // The close-time token snapshot is sampled here, outside any store lock
    // (the transcript scan can be large), and handed to the shared apply as an
    // input. `null` = sampled, nothing found; the apply then writes `null`
    // only when the row carries no snapshot yet. An already-closed row does
    // not take a new snapshot — re-close must not pin a later `null` over a
    // live dashboard read, and must not spend the scan when apply will ignore it.
    let tokenUsage: NonNullable<Session['tokenUsage']> | null | undefined;
    if (session.status !== 'closed') {
      tokenUsage = null;
      try {
        tokenUsage = getSessionTokenUsage({
          cliId: session.cliId ?? 'unknown',
          sessionId: session.sessionId,
          cliSessionId: session.cliSessionId,
          cwd: session.workingDir,
          larkAppId: session.larkAppId,
          fresh: true,
        });
      } catch (err: any) {
        logger.warn(`Failed to snapshot token usage for session ${sessionId}: ${err?.message ?? err}`);
      }
    }
    // Durable first: build the closed row, commit it, and only then merge it
    // into the live object. A failed write leaves the session exactly as it
    // was, including any prior tokenUsage snapshot. The transition itself is
    // the ONE shared apply (session-commands.ts); this is the daemon's own
    // store close, reached after its explicit prepare, so it alone names the
    // journal wipe. Persist only on `applied` — a no-op re-close must not
    // rewrite the row.
    const next: Session = { ...session };
    const applied = applySessionRowCommand(next, {
      type: 'close',
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      clearMojoCloseJournal: true,
      ...(opts.parkMojoLineage ? { parkMojoLineage: opts.parkMojoLineage } : {}),
      ...(opts.parkLocalResidual ? { parkLocalResidual: opts.parkLocalResidual } : {}),
      ...(opts.clearRiffParentTaskId ? { clearRiffParentTaskId: true } : {}),
    }, { now: new Date() });
    if (applied.outcome === 'applied') {
      persistRow(next);
      Object.assign(session, next);
    }
    const released = applied.outcome === 'applied' ? applied.released.dashboardAttachments : undefined;
    if (session.larkAppId && released?.length) {
      try {
        cleanupMaterializedDashboardImages(session.larkAppId, released);
      } catch (error: any) {
        logger.warn(`Failed to clean Dashboard images for session ${sessionId}: ${error?.message ?? error}`);
      }
    }
    // turn-sends was originally a transient bridge-dedup file cleaned by a
    // live worker's close handler. Message previews now make its bounded tail
    // user-visible, so workerless/forced closes must apply the same cleanup;
    // otherwise closed sessions retain private reply text indefinitely.
    if (opts.cleanupBridgeMarkers !== false) cleanupSessionBridgeSendMarkers(sessionId);
    // #794: per-turn hook sidecar 与 turn-sends 同生命周期，关会话一并清掉，
    // 否则 prompt-ctx/<sid>/ 成为孤儿目录（24h TTL 兜底但 daemon 长命会累积）。
    removePromptContextDir(sessionId);
    // Claude statusline 快照目录同生命周期（best-effort，内部吞错）。
    removeStatuslineDir(config.session.dataDir, sessionId);
    deleteFrozenCards(sessionId);
    logger.info(`Closed session ${sessionId}`);
  }
}

/**
 * Reactivate one explicitly closed row and discard every queued/setup owner in
 * the same durable write.  The close path has cleared these fields
 * since 2026-07, but older closed rows can still contain prepared input.  A
 * generic resume is an explicit new lifecycle and must never revive that
 * abandoned FIFO.
 *
 * `previewTarget` is cleared here for the same reason: closeSession() now drops
 * it, but rows closed by an older build still carry one on disk, and resume
 * starts a new worker generation that has not registered any port.
 */
export function reactivateClosedSession(
  sessionId: string,
): { ok: true; session: Session }
| { ok: false; error: 'not_found' | 'not_closed' } {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'not_found' };
  if (session.status !== 'closed') return { ok: false, error: 'not_closed' };

  // Durable first (see closeSession): the reactivated row is committed before
  // it is merged into the live object, so a failed write is a no-op. Reactivate
  // starts a new lifecycle, so the previous close-time token snapshot must not
  // survive into the active row or the next close.
  const next: Session = { ...session };
  next.status = 'active';
  next.closedAt = undefined;
  next.lastMessageAt = new Date().toISOString();
  next.codexAppDispatchLedger = undefined;
  next.codexAppGenerationCommits = undefined;
  next.queued = undefined;
  next.queuedPrompt = undefined;
  next.queuedCodexAppText = undefined;
  next.queuedCodexAppMessageContext = undefined;
  next.queuedActivationPending = undefined;
  next.queuedActivationToken = undefined;
  next.queuedActivationInput = undefined;
  next.queuedActivationTurnId = undefined;
  next.queuedActivationDispatchAttempt = undefined;
  next.queuedActivationResume = undefined;
  next.queuedActivationTail = undefined;
  next.queuedActivationTailNextOrder = undefined;
  next.principalLaneQueuedTurns = undefined;
  next.pendingRepoSetup = undefined;
  next.previewTarget = undefined;
  next.crossPrincipalInterruptions = undefined;
  next.mojoCloseJournal = undefined;
  next.tokenUsage = undefined;

  persistRow(next);
  Object.assign(session, next);
  return { ok: true, session };
}


export function updateSessionPid(sessionId: string, pid: number | null): void {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (session) {
    session.pid = pid ?? undefined;
    persistRow(session);
  }
}

export function updateSession(session: Session): void {
  loadForWrite();
  try { persistRow(session); }
  catch (error) {
    const row = ownStore?.selectRow.get(session.sessionId) as { row: string } | undefined;
    if (row) {
      const durable = JSON.parse(row.row) as Session;
      const cached = sessions.get(session.sessionId);
      for (const target of new Set([session, cached].filter((s): s is Session => !!s))) {
        for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
        Object.assign(target, durable);
      }
    }
    throw error;
  }
  const durable = ownStore?.selectRow.get(session.sessionId) as { row: string } | undefined;
  if (durable) Object.assign(session, JSON.parse(durable.row));
  sessions.set(session.sessionId, session);
}

/**
 * Mutate a fixed set of owned session rows inside one SQLite transaction.
 *
 * The callback receives fresh cloned rows, never the process cache. Cache and
 * caller-visible objects are updated only after COMMIT, so a failed coordinator
 * election cannot publish half of a multi-row authority transition in memory.
 */
export function mutateOwnedSessionsAtomically<T>(
  sessionIds: readonly string[],
  mutate: (fresh: Map<string, Session>) => T,
  options: {
    /** Fail fast with SessionStoreBusyError instead of blocking the daemon's
     * event loop behind the connection's normal busy_timeout. */
    nonblocking?: boolean;
  } = {},
): { result: T; rows: Map<string, Session> } {
  loadForWrite();
  const unique = [...new Set(sessionIds)];
  if (unique.length !== sessionIds.length) {
    throw new Error('duplicate session id in atomic session mutation');
  }
  const store = ownStore;
  if (!store) {
    throw new SessionStoreUnavailableError(new Error('owned session store is not attached'));
  }
  const fresh = new Map<string, Session>();
  let result!: T;
  runOwnedWriteTransaction(store, options.nonblocking === true, () => {
    for (const sessionId of unique) {
      const hit = store.selectRow.get(sessionId) as { row: string } | undefined;
      if (!hit) throw new Error(`atomic session mutation cannot find ${sessionId}`);
      fresh.set(sessionId, structuredClone(JSON.parse(hit.row) as Session));
    }
    result = mutate(fresh);
    for (const row of fresh.values()) persistRow(row);
  });
  for (const [sessionId, row] of fresh) {
    const cached = sessions.get(sessionId);
    if (cached) {
      for (const key of Object.keys(cached)) delete (cached as unknown as Record<string, unknown>)[key];
      Object.assign(cached, structuredClone(row));
      fresh.set(sessionId, cached);
    } else {
      sessions.set(sessionId, row);
    }
  }
  return { result, rows: fresh };
}

export type EnsurePrincipalLaneSourceResult =
  | { status: 'ready'; source: PrincipalLaneSourceState; lane: PrincipalLaneBinding }
  | { status: 'retry'; reason: 'canonical_cwd_unavailable' | 'workspace_migration_busy' }
  | { status: 'disabled'; reason: 'caller_identity_unproven' }
  | { status: 'quarantined'; reason: string };

interface PrincipalLaneSourceSidecarRow {
  source_principal_key: string;
  canonical_cwd: string;
  workspace_epoch: number;
  workspace_group_id: string;
  phase: string;
  revision: number;
  row: string;
}

interface PrincipalLaneSidecarRow {
  lane_id: string;
  session_id: string;
  principal_key: string;
  routing_anchor: string;
  workspace_epoch: number;
  phase: string;
  revision: number;
  row: string;
}

interface PrincipalLaneWorktreeSidecarRow {
  materialization_id: string;
  source_session_id: string;
  lane_id: string;
  session_id: string;
  principal_key: string;
  workspace_epoch: number;
  source_repo_root: string;
  source_git_common_dir: string;
  worktree_root: string;
  worktree_git_common_dir: string;
  working_dir: string;
  branch: string;
  phase: string;
  revision: number;
  row: string;
}

type ParsedPrincipalLaneSidecar = {
  binding: PrincipalLaneBinding;
  sessionId: string;
};

function parseSourceSidecar(
  hit: PrincipalLaneSourceSidecarRow | undefined,
  displayTarget: PrincipalLaneDisplayTarget,
  sourceSessionId: string,
): { ok: true; value: PrincipalLaneSourceState } | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_sidecar' };
  if (hit.phase === 'quarantined') return { ok: false, error: 'stored_quarantine' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalLaneSourceState(raw, displayTarget, sourceSessionId);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.source_principal_key !== value.sourcePrincipalKey
      || hit.canonical_cwd !== value.canonicalCwd
      || Number(hit.workspace_epoch) !== value.workspaceEpoch
      || hit.workspace_group_id !== value.workspaceGroupId
      || hit.phase !== value.phase
      || Number(hit.revision) !== value.revision) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function parseLaneSidecar(
  hit: PrincipalLaneSidecarRow | undefined,
  expected: { displayTarget: PrincipalLaneDisplayTarget; sourceSessionId: string },
): { ok: true; value: ParsedPrincipalLaneSidecar } | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_sidecar' };
  if (hit.phase === 'quarantined') return { ok: false, error: 'stored_quarantine' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalLaneBinding(raw, expected);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.lane_id !== value.laneId
      || hit.principal_key !== value.principalKey
      || hit.routing_anchor !== value.routingAnchor
      || Number(hit.workspace_epoch) !== value.workspaceEpoch
      || hit.phase !== value.phase
      || Number(hit.revision) !== value.revision
      || typeof hit.session_id !== 'string'
      || hit.session_id.length === 0) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value: { binding: value, sessionId: hit.session_id } };
}

function parseWorktreeSidecar(
  hit: PrincipalLaneWorktreeSidecarRow | undefined,
  expected: {
    sourceSessionId: string;
    laneId: string;
    sessionId: string;
    principalKey: string;
    workspaceEpoch: number;
  },
): { ok: true; value: PrincipalLaneWorktreeProof } | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_sidecar' };
  if (hit.phase === 'quarantined') return { ok: false, error: 'stored_quarantine' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalLaneWorktreeProof(raw, expected);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.materialization_id !== value.materializationId
      || hit.source_session_id !== value.sourceSessionId
      || hit.lane_id !== value.laneId
      || hit.session_id !== value.sessionId
      || hit.principal_key !== value.principalKey
      || Number(hit.workspace_epoch) !== value.workspaceEpoch
      || hit.source_repo_root !== value.sourceRepoRoot
      || hit.source_git_common_dir !== value.sourceGitCommonDir
      || hit.worktree_root !== value.worktreeRoot
      || hit.worktree_git_common_dir !== value.worktreeGitCommonDir
      || hit.working_dir !== value.workingDir
      || hit.branch !== value.branch
      || hit.phase !== value.phase
      || Number(hit.revision) !== value.revision) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function readPrincipalLaneWorktreeRow(
  store: SqliteReadStore,
  sourceSessionId: string,
  laneId: string,
): PrincipalLaneWorktreeSidecarRow | undefined {
  return store.db.prepare(
    'SELECT materialization_id, source_session_id, lane_id, session_id, principal_key, '
    + 'workspace_epoch, source_repo_root, source_git_common_dir, worktree_root, '
    + 'worktree_git_common_dir, working_dir, branch, phase, revision, row '
    + 'FROM principal_lane_worktrees WHERE source_session_id = ? AND lane_id = ?',
  ).get(sourceSessionId, laneId) as PrincipalLaneWorktreeSidecarRow | undefined;
}

function quarantinePrincipalLaneWorktree(
  store: OwnSqliteStore,
  sourceSessionId: string,
  laneId: string,
): void {
  store.db.prepare(
    "UPDATE principal_lane_worktrees SET phase = 'quarantined' "
    + 'WHERE source_session_id = ? AND lane_id = ?',
  ).run(sourceSessionId, laneId);
}

function quarantinePrincipalLaneSource(store: OwnSqliteStore, sourceSessionId: string): void {
  store.db.prepare(
    "UPDATE principal_lane_sources SET phase = 'quarantined' WHERE source_session_id = ?",
  ).run(sourceSessionId);
}

function quarantinePrincipalLane(
  store: OwnSqliteStore,
  sourceSessionId: string,
  laneId = 'source',
): void {
  store.db.prepare(
    "UPDATE principal_lanes SET phase = 'quarantined' WHERE source_session_id = ? AND lane_id = ?",
  ).run(sourceSessionId, laneId);
}

function canonicalSessionCwd(session: Session): string {
  const cwd = resolve(session.workingDir || process.cwd());
  try { return realpathSync(cwd); } catch { return cwd; }
}

function strictCanonicalSessionCwd(session: Session): string | undefined {
  try { return realpathSync(resolve(session.workingDir || process.cwd())); }
  catch { return undefined; }
}

function sourceRoutingAnchor(target: PrincipalLaneDisplayTarget): string {
  return target.scope === 'chat' ? target.chatId : target.rootMessageId;
}

function initialPrincipalWorkspaceGroup(
  larkAppId: string,
  canonicalCwd: string,
  now: string,
): PrincipalWorkspaceGroup {
  return {
    version: 1,
    groupId: principalWorkspaceGroupIdV2(larkAppId, canonicalCwd),
    groupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
    larkAppId,
    canonicalCwd,
    phase: 'active',
    revision: 1,
    lastLeaseGeneration: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function initialPrincipalWorkspaceMember(args: {
  sourceSessionId: string;
  laneId: string;
  sessionId: string;
  groupId: string;
  workspaceEpoch: number;
  now: string;
}): PrincipalWorkspaceMember {
  return {
    version: 1,
    sourceSessionId: args.sourceSessionId,
    laneId: args.laneId,
    sessionId: args.sessionId,
    groupId: args.groupId,
    workspaceEpoch: args.workspaceEpoch,
    membershipPhase: 'active',
    revision: 1,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

function insertPrincipalWorkspaceGroup(
  store: OwnSqliteStore,
  group: PrincipalWorkspaceGroup,
): void {
  store.db.prepare(
    'INSERT INTO principal_workspace_groups '
    + '(group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
    + 'last_lease_generation, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    group.groupId, group.groupKeyVersion, group.larkAppId, group.canonicalCwd,
    group.phase, group.revision, group.lastLeaseGeneration, JSON.stringify(group),
  );
}

function insertPrincipalWorkspaceMember(
  store: OwnSqliteStore,
  member: PrincipalWorkspaceMember,
): void {
  store.db.prepare(
    'INSERT INTO principal_workspace_members '
    + '(source_session_id, lane_id, session_id, group_id, workspace_epoch, '
    + 'membership_phase, revision, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    member.sourceSessionId, member.laneId, member.sessionId, member.groupId,
    member.workspaceEpoch, member.membershipPhase, member.revision, JSON.stringify(member),
  );
}

interface PrincipalWorkspaceGroupRow {
  group_id: string;
  group_key_version: number;
  lark_app_id: string;
  canonical_cwd: string;
  phase: string;
  revision: number;
  last_lease_generation: number;
  row: string;
}

interface PrincipalWorkspaceMemberRow {
  source_session_id: string;
  lane_id: string;
  session_id: string;
  group_id: string;
  workspace_epoch: number;
  membership_phase: string;
  revision: number;
  row: string;
}

interface PrincipalWorkspaceTicketSequenceRow {
  group_id: string;
  last_sequence: number;
  revision: number;
  created_at: string;
  updated_at: string;
  row: string;
}

interface PrincipalWorkspaceTicketRow {
  ticket_id: string;
  group_id: string;
  sequence: number;
  source_session_id: string;
  lane_id: string;
  session_id: string;
  workspace_epoch: number;
  turn_id: string;
  status: string;
  revision: number;
  namespace_version: number;
  namespace: string;
  record_version: number;
  record_id: string;
  payload_encoding: string;
  payload_hash: string;
  exact_file_length: number;
  created_at: string;
  updated_at: string;
  row: string;
}

interface PrincipalWorkspaceTicketAuditRow {
  audit_id: string;
  group_id: string;
  ticket_id: string | null;
  source_session_id: string;
  lane_id: string;
  session_id: string;
  turn_id: string;
  event: string;
  detail: string | null;
  created_at: string;
}

function parseWorkspaceGroupSidecar(hit: PrincipalWorkspaceGroupRow | undefined):
  | { ok: true; value: PrincipalWorkspaceGroup }
  | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_group' };
  if (hit.phase === 'quarantined') return { ok: false, error: 'stored_quarantine' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalWorkspaceGroup(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.group_id !== value.groupId
      || Number(hit.group_key_version) !== value.groupKeyVersion
      || hit.lark_app_id !== value.larkAppId
      || hit.canonical_cwd !== value.canonicalCwd
      || hit.phase !== value.phase
      || Number(hit.revision) !== value.revision
      || Number(hit.last_lease_generation) !== value.lastLeaseGeneration) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function parseWorkspaceMemberSidecar(hit: PrincipalWorkspaceMemberRow | undefined):
  | { ok: true; value: PrincipalWorkspaceMember }
  | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_member' };
  if (hit.membership_phase === 'quarantined') {
    return { ok: false, error: 'stored_quarantine' };
  }
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalWorkspaceMember(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.source_session_id !== value.sourceSessionId
      || hit.lane_id !== value.laneId
      || hit.session_id !== value.sessionId
      || hit.group_id !== value.groupId
      || Number(hit.workspace_epoch) !== value.workspaceEpoch
      || hit.membership_phase !== value.membershipPhase
      || Number(hit.revision) !== value.revision) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function parseWorkspaceTicketSequenceSidecar(hit: PrincipalWorkspaceTicketSequenceRow | undefined):
  | { ok: true; value: PrincipalWorkspaceTicketSequence }
  | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_ticket_sequence' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalWorkspaceTicketSequence(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.group_id !== value.groupId
      || Number(hit.last_sequence) !== value.lastSequence
      || Number(hit.revision) !== value.revision
      || hit.created_at !== value.createdAt
      || hit.updated_at !== value.updatedAt) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function ticketLocatorFromRow(hit: PrincipalWorkspaceTicketRow): PrincipalWorkspaceTicketLocator {
  return {
    namespaceVersion: Number(hit.namespace_version) as 1,
    namespace: hit.namespace,
    recordVersion: Number(hit.record_version) as 1,
    recordId: hit.record_id,
    turnId: hit.turn_id,
    payloadEncoding: hit.payload_encoding as PrincipalWorkspaceTicketLocator['payloadEncoding'],
    payloadHash: hit.payload_hash,
    exactFileLength: Number(hit.exact_file_length),
  };
}

function parseWorkspaceTicketSidecar(hit: PrincipalWorkspaceTicketRow | undefined):
  | { ok: true; value: PrincipalWorkspaceTicket }
  | { ok: false; error: string } {
  if (!hit) return { ok: false, error: 'missing_ticket' };
  let raw: unknown;
  try { raw = JSON.parse(hit.row); } catch { return { ok: false, error: 'invalid_json' }; }
  const parsed = parsePrincipalWorkspaceTicket(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (hit.ticket_id !== value.ticketId
      || hit.group_id !== value.groupId
      || Number(hit.sequence) !== value.sequence
      || hit.source_session_id !== value.sourceSessionId
      || hit.lane_id !== value.laneId
      || hit.session_id !== value.sessionId
      || Number(hit.workspace_epoch) !== value.workspaceEpoch
      || hit.turn_id !== value.turnId
      || hit.status !== value.status
      || Number(hit.revision) !== value.revision
      || hit.created_at !== value.createdAt
      || hit.updated_at !== value.updatedAt
      || !sameTicketLocator(ticketLocatorFromRow(hit), value.locator)) {
    return { ok: false, error: 'indexed_value_mismatch' };
  }
  return { ok: true, value };
}

function sameTicketLocator(
  left: Readonly<PrincipalWorkspaceTicketLocator>,
  right: Readonly<PrincipalWorkspaceTicketLocator>,
): boolean {
  return left.namespaceVersion === right.namespaceVersion
    && left.namespace === right.namespace
    && left.recordVersion === right.recordVersion
    && left.recordId === right.recordId
    && left.turnId === right.turnId
    && left.payloadEncoding === right.payloadEncoding
    && left.payloadHash === right.payloadHash
    && left.exactFileLength === right.exactFileLength;
}

function ticketCounterEvidence(row: PrincipalWorkspaceTicketSequenceRow | undefined): string | null {
  if (!row) return null;
  return JSON.stringify({
    groupId: row.group_id,
    lastSequence: row.last_sequence,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    row: row.row,
  });
}

const PRINCIPAL_WORKSPACE_TICKET_COLUMNS = 'ticket_id, group_id, sequence, source_session_id, '
  + 'lane_id, session_id, workspace_epoch, turn_id, status, revision, namespace_version, '
  + 'namespace, record_version, record_id, payload_encoding, payload_hash, exact_file_length, '
  + 'created_at, updated_at, row';

function readWorkspaceTicketById(
  store: OwnSqliteStore,
  ticketId: string,
): PrincipalWorkspaceTicketRow | undefined {
  return store.db.prepare(
    `SELECT ${PRINCIPAL_WORKSPACE_TICKET_COLUMNS} FROM principal_workspace_tickets WHERE ticket_id = ?`,
  ).get(ticketId) as PrincipalWorkspaceTicketRow | undefined;
}

function readWorkspaceTicketByTurn(
  store: OwnSqliteStore,
  sourceSessionId: string,
  laneId: string,
  sessionId: string,
  turnId: string,
): PrincipalWorkspaceTicketRow | undefined {
  return store.db.prepare(
    `SELECT ${PRINCIPAL_WORKSPACE_TICKET_COLUMNS} FROM principal_workspace_tickets `
    + 'WHERE source_session_id = ? AND lane_id = ? AND session_id = ? AND turn_id = ?',
  ).get(sourceSessionId, laneId, sessionId, turnId) as PrincipalWorkspaceTicketRow | undefined;
}

function readWorkspaceTicketByRecord(
  store: OwnSqliteStore,
  locator: Readonly<PrincipalWorkspaceTicketLocator>,
): PrincipalWorkspaceTicketRow | undefined {
  return store.db.prepare(
    `SELECT ${PRINCIPAL_WORKSPACE_TICKET_COLUMNS} FROM principal_workspace_tickets `
    + 'WHERE namespace_version = ? AND namespace = ? AND record_version = ? AND record_id = ?',
  ).get(
    locator.namespaceVersion, locator.namespace, locator.recordVersion, locator.recordId,
  ) as PrincipalWorkspaceTicketRow | undefined;
}

function ticketAuditId(
  event: PrincipalWorkspaceTicketAuditEvent,
  ticketId: string | undefined,
  turnId: string,
  detail: string,
): string {
  const hash = createHash('sha256');
  for (const value of [
    'botmux.principal-workspace.ticket-audit', '1', event, ticketId ?? '', turnId, detail,
  ]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    hash.update(length);
    hash.update(bytes);
  }
  return `principal-workspace-ticket-audit:v1:${hash.digest('hex')}`;
}

function persistPrincipalWorkspaceTicketAudit(
  store: OwnSqliteStore,
  args: {
    event: PrincipalWorkspaceTicketAuditEvent;
    groupId: string;
    ticketId?: string;
    sourceSessionId: string;
    laneId: string;
    sessionId: string;
    turnId: string;
    detail: unknown;
    now: string;
  },
): void {
  const detail = JSON.stringify(args.detail);
  store.db.prepare(
    `INSERT ${args.event === 'enqueued' ? '' : 'OR IGNORE '}INTO principal_workspace_ticket_audit `
    + '(audit_id, group_id, ticket_id, source_session_id, lane_id, session_id, turn_id, '
    + 'event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    ticketAuditId(args.event, args.ticketId, args.turnId, detail), args.groupId,
    args.ticketId ?? null, args.sourceSessionId, args.laneId, args.sessionId,
    args.turnId, args.event, detail, args.now,
  );
}

function ticketAuditMatchesTicket(
  hit: PrincipalWorkspaceTicketAuditRow | undefined,
  ticket: PrincipalWorkspaceTicket,
): boolean {
  if (!hit || hit.event !== 'enqueued'
      || hit.group_id !== ticket.groupId
      || hit.ticket_id !== ticket.ticketId
      || hit.source_session_id !== ticket.sourceSessionId
      || hit.lane_id !== ticket.laneId
      || hit.session_id !== ticket.sessionId
      || hit.turn_id !== ticket.turnId
      || !hit.detail) return false;
  try {
    const detail = JSON.parse(hit.detail) as { version?: unknown; ticket?: unknown };
    if (detail.version !== 1) return false;
    const parsed = parsePrincipalWorkspaceTicket(detail.ticket);
    return parsed.ok
      && JSON.stringify(parsed.value) === JSON.stringify(ticket)
      && canonicalIso(hit.created_at)
      && hit.audit_id === ticketAuditId('enqueued', ticket.ticketId, ticket.turnId, hit.detail);
  } catch {
    return false;
  }
}

function readEnqueuedTicketAudit(
  store: OwnSqliteStore,
  ticketId: string,
): PrincipalWorkspaceTicketAuditRow | undefined {
  return store.db.prepare(
    'SELECT audit_id, group_id, ticket_id, source_session_id, lane_id, session_id, turn_id, '
    + 'event, detail, created_at FROM principal_workspace_ticket_audit '
    + "WHERE ticket_id = ? AND event = 'enqueued' ORDER BY created_at, audit_id LIMIT 1",
  ).get(ticketId) as PrincipalWorkspaceTicketAuditRow | undefined;
}

function readWorkspaceGroupRow(
  store: SqliteReadStore,
  groupId: string,
): PrincipalWorkspaceGroupRow | undefined {
  return store.db.prepare(
    'SELECT group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
    + 'last_lease_generation, row FROM principal_workspace_groups WHERE group_id = ?',
  ).get(groupId) as PrincipalWorkspaceGroupRow | undefined;
}

function readWorkspaceMemberRow(
  store: SqliteReadStore,
  sourceSessionId: string,
  laneId: string,
): PrincipalWorkspaceMemberRow | undefined {
  return store.db.prepare(
    'SELECT source_session_id, lane_id, session_id, group_id, workspace_epoch, '
    + 'membership_phase, revision, row FROM principal_workspace_members '
    + 'WHERE source_session_id = ? AND lane_id = ?',
  ).get(sourceSessionId, laneId) as PrincipalWorkspaceMemberRow | undefined;
}

function quarantinePrincipalWorkspaceGroup(store: OwnSqliteStore, groupId: string): void {
  store.db.prepare(
    "UPDATE principal_workspace_groups SET phase = 'quarantined' WHERE group_id = ?",
  ).run(groupId);
}

function quarantinePrincipalWorkspaceMember(
  store: OwnSqliteStore,
  sourceSessionId: string,
  laneId: string,
): void {
  store.db.prepare(
    "UPDATE principal_workspace_members SET membership_phase = 'quarantined' "
    + 'WHERE source_session_id = ? AND lane_id = ?',
  ).run(sourceSessionId, laneId);
}

function principalWorkspaceMemberIdentityMatchesLane(
  member: PrincipalWorkspaceMember,
  lane: ParsedPrincipalLaneSidecar,
  source: PrincipalLaneSourceState,
): boolean {
  return member.sourceSessionId === lane.binding.sourceSessionId
    && member.laneId === lane.binding.laneId
    && member.sessionId === lane.sessionId
    && member.groupId === source.workspaceGroupId
    && member.workspaceEpoch === source.workspaceEpoch;
}

/**
 * Atomically bind a legacy source to human lane 0 and create its workspace
 * epoch/index sidecars. The authoritative display target is derived from the
 * persisted source row, never from the inbound event. An unproven caller only
 * disables principal-lane routing for this source; the legacy session remains
 * active and otherwise unchanged.
 */
export function ensurePrincipalLaneSource(args: {
  sourceSessionId: string;
  caller: InboundPrincipal;
  now?: string;
}): EnsurePrincipalLaneSourceResult {
  loadForWrite();
  if (args.caller.senderType !== 'user') {
    throw new Error('bot principal cannot initialize a human principal lane');
  }
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const now = args.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== now) {
    throw new Error('invalid principal-lane migration timestamp');
  }
  let nextSession: Session | undefined;
  const result = runOwnedWriteTransaction(store, false, (): EnsurePrincipalLaneSourceResult => {
    const hit = store.selectRow.get(args.sourceSessionId) as { row: string } | undefined;
    if (!hit) throw new Error(`principal-lane source session not found: ${args.sourceSessionId}`);
    const sourceSession = JSON.parse(hit.row) as Session;
    if (sourceSession.status !== 'active') throw new Error('principal-lane source session is not active');
    if (sourceSession.principalLaneDisabledReason) {
      return { status: 'disabled', reason: sourceSession.principalLaneDisabledReason };
    }
    if (sourceSession.principalLaneQuarantineReason) {
      return { status: 'quarantined', reason: sourceSession.principalLaneQuarantineReason };
    }
    const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId!);
    if (!displayTarget) {
      nextSession = { ...sourceSession, principalLaneQuarantineReason: 'invalid_source_display_target' };
      const update = store.updateExact.run(
        sessionStatusText(nextSession), JSON.stringify(nextSession), nextSession.sessionId, hit.row,
      );
      if (Number(update.changes) !== 1) {
        throw new Error('source session changed during lane quarantine');
      }
      return { status: 'quarantined', reason: 'invalid_source_display_target' };
    }

    const sourceHit = store.db.prepare(
      'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
      + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
    ).get(args.sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
    const laneHit = store.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
    ).get(args.sourceSessionId) as PrincipalLaneSidecarRow | undefined;
    if (sourceHit || laneHit) {
      const parsedSource = parseSourceSidecar(sourceHit, displayTarget, args.sourceSessionId);
      const parsedLane = parseLaneSidecar(laneHit, { displayTarget, sourceSessionId: args.sourceSessionId });
      if (!parsedSource.ok || !parsedLane.ok
          || parsedLane.value.binding.laneId !== 'source'
          || parsedLane.value.sessionId !== args.sourceSessionId
          || parsedSource.value.sourcePrincipalKey !== parsedLane.value.binding.principalKey
          || parsedSource.value.workspaceEpoch !== parsedLane.value.binding.workspaceEpoch) {
        const sourceLaneMismatch = parsedSource.ok && parsedLane.ok;
        const reason = !parsedSource.ok
          ? `source:${parsedSource.error}`
          : !parsedLane.ok ? `lane:${parsedLane.error}` : 'source_lane_mismatch';
        if (!parsedSource.ok) quarantinePrincipalLaneSource(store, args.sourceSessionId);
        if (!parsedLane.ok || sourceLaneMismatch) quarantinePrincipalLane(store, args.sourceSessionId);
        return { status: 'quarantined', reason };
      }
      return { status: 'ready', source: parsedSource.value, lane: parsedLane.value.binding };
    }

    const migration = decideLegacySourceMigration({
      session: sourceSession,
      inboundLarkAppId: currentAppId!,
      caller: args.caller,
    });
    if (migration.kind === 'disable_principal_lanes') {
      nextSession = { ...sourceSession, principalLaneDisabledReason: migration.reason };
      const update = store.updateExact.run(
        sessionStatusText(nextSession), JSON.stringify(nextSession),
        nextSession.sessionId, hit.row,
      );
      if (Number(update.changes) !== 1) throw new Error('source session changed during lane migration');
      store.db.prepare(
        'INSERT INTO principal_lane_migration_audit '
        + '(audit_id, source_session_id, lark_app_id, outcome, reason, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), sourceSession.sessionId, currentAppId!, 'disabled', migration.reason, now);
      return { status: 'disabled', reason: migration.reason };
    }

    const canonicalCwd = strictCanonicalSessionCwd(sourceSession);
    if (!canonicalCwd) return { status: 'retry', reason: 'canonical_cwd_unavailable' };
    const workspaceEpoch = 1;
    const workspaceGroup = initialPrincipalWorkspaceGroup(currentAppId!, canonicalCwd, now);
    const source: PrincipalLaneSourceState = {
      version: 1,
      sourcePrincipalKey: migration.principalKey,
      displayTarget,
      canonicalCwd,
      workspaceEpoch,
      workspaceGroupId: workspaceGroup.groupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
      phase: 'active',
      revision: 1,
      updatedAt: now,
      migrationAudit: {
        evidence: migration.evidence,
        migratedAt: now,
        larkAppId: currentAppId!,
      },
    };
    const lane: PrincipalLaneBinding = {
      version: 1,
      laneId: 'source',
      sourceSessionId: sourceSession.sessionId,
      principalKey: migration.principalKey,
      principal: migration.principal,
      routingAnchor: sourceRoutingAnchor(displayTarget),
      displayTarget,
      workspaceEpoch,
      phase: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const groupById = readWorkspaceGroupRow(store, workspaceGroup.groupId);
    const groupByIdentity = store.db.prepare(
      'SELECT group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
      + 'last_lease_generation, row FROM principal_workspace_groups '
      + 'WHERE group_key_version = ? AND lark_app_id = ? AND canonical_cwd = ?',
    ).get(
      PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION, currentAppId!, canonicalCwd,
    ) as PrincipalWorkspaceGroupRow | undefined;
    if (groupById && groupByIdentity && groupById.group_id !== groupByIdentity.group_id) {
      quarantinePrincipalWorkspaceGroup(store, groupById.group_id);
      quarantinePrincipalWorkspaceGroup(store, groupByIdentity.group_id);
      return { status: 'quarantined', reason: 'group:identity_collision' };
    }
    const existingGroup = groupById ?? groupByIdentity;
    if (existingGroup) {
      const parsedGroup = parseWorkspaceGroupSidecar(existingGroup);
      if (!parsedGroup.ok) {
        quarantinePrincipalWorkspaceGroup(store, existingGroup.group_id);
        return { status: 'quarantined', reason: `group:${parsedGroup.error}` };
      }
      if (parsedGroup.value.groupId !== workspaceGroup.groupId
          || parsedGroup.value.larkAppId !== workspaceGroup.larkAppId
          || parsedGroup.value.canonicalCwd !== workspaceGroup.canonicalCwd) {
        quarantinePrincipalWorkspaceGroup(store, existingGroup.group_id);
        return { status: 'quarantined', reason: 'group:identity_conflict' };
      }
      if (parsedGroup.value.phase !== 'active') {
        return { status: 'retry', reason: 'workspace_migration_busy' };
      }
    }
    store.db.prepare(
      'INSERT INTO principal_lane_sources '
      + '(source_session_id, source_principal_key, canonical_cwd, workspace_epoch, '
      + 'workspace_group_id, phase, revision, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sourceSession.sessionId, source.sourcePrincipalKey, source.canonicalCwd,
      source.workspaceEpoch, source.workspaceGroupId, source.phase, source.revision,
      JSON.stringify(source),
    );
    store.db.prepare(
      'INSERT INTO principal_lanes '
      + '(lane_id, source_session_id, session_id, principal_key, routing_anchor, '
      + 'workspace_epoch, phase, revision, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      lane.laneId, lane.sourceSessionId, sourceSession.sessionId, lane.principalKey,
      lane.routingAnchor, lane.workspaceEpoch, lane.phase, lane.revision, JSON.stringify(lane),
    );
    if (!existingGroup) {
      insertPrincipalWorkspaceGroup(store, workspaceGroup);
    }
    insertPrincipalWorkspaceMember(store, initialPrincipalWorkspaceMember({
      sourceSessionId: sourceSession.sessionId,
      laneId: lane.laneId,
      sessionId: sourceSession.sessionId,
      groupId: workspaceGroup.groupId,
      workspaceEpoch,
      now,
    }));
    store.db.prepare(
      'INSERT INTO principal_lane_aliases '
      + '(source_session_id, alias_key, lane_id, canonical_principal_key, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      sourceSession.sessionId, lane.principalKey, lane.laneId, lane.principalKey, now, now,
    );
    nextSession = {
      ...sourceSession,
      principalLane: lane,
      principalLaneSource: source,
      principalLaneDisabledReason: undefined,
    };
    const update = store.updateExact.run(
      sessionStatusText(nextSession), JSON.stringify(nextSession), nextSession.sessionId, hit.row,
    );
    if (Number(update.changes) !== 1) throw new Error('source session changed during lane migration');
    store.db.prepare(
      'INSERT INTO principal_lane_migration_audit '
      + '(audit_id, source_session_id, lark_app_id, principal_key, outcome, evidence, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(), sourceSession.sessionId, currentAppId!, migration.principalKey,
      'bound', migration.evidence, now,
    );
    store.db.prepare(
      'INSERT INTO principal_workspace_migration_audit '
      + '(audit_id, source_session_id, event, target_group_id, from_revision, from_epoch, '
      + 'detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(), sourceSession.sessionId, 'created', workspaceGroup.groupId,
      0, workspaceEpoch, JSON.stringify({ laneCount: 1 }), now,
    );
    return { status: 'ready', source, lane };
  });
  if (nextSession) {
    const cached = sessions.get(args.sourceSessionId);
    if (cached) Object.assign(cached, structuredClone(nextSession));
    else sessions.set(args.sourceSessionId, nextSession);
  }
  return result;
}

/** Explicit ingress name for the only supported source bootstrap gate. The
 * persisted legacy owner remains authoritative; a B/C first message cannot
 * nominate itself as source owner. */
export type BootstrapPrincipalLaneSourceForIngressResult =
  | EnsurePrincipalLaneSourceResult
  | { status: 'retry'; reason: 'source_owner_mismatch' };

export function bootstrapPrincipalLaneSourceForIngress(args: {
  sourceSessionId: string;
  caller: InboundPrincipal;
  now?: string;
}): BootstrapPrincipalLaneSourceForIngressResult {
  loadForWrite();
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const existing = store.db.prepare(
    'SELECT 1 AS hit FROM principal_lane_sources WHERE source_session_id = ?',
  ).get(args.sourceSessionId) as { hit: number } | undefined;
  if (!existing) {
    const hit = store.selectRow.get(args.sourceSessionId) as { row: string } | undefined;
    if (!hit) throw new Error(`principal-lane source session not found: ${args.sourceSessionId}`);
    let session: Session;
    try { session = JSON.parse(hit.row) as Session; }
    catch { return { status: 'retry', reason: 'source_owner_mismatch' }; }
    if (decideLegacySourceMigration({
      session,
      inboundLarkAppId: currentAppId,
      caller: args.caller,
    }).kind !== 'bind') {
      return { status: 'retry', reason: 'source_owner_mismatch' };
    }
  }
  return ensurePrincipalLaneSource(args);
}

export function readPrincipalLaneSource(
  sourceSessionId: string,
): EnsurePrincipalLaneSourceResult | undefined {
  loadForWrite();
  const sourceSession = sessions.get(sourceSessionId);
  if (!sourceSession || !currentAppId || !ownStore) return undefined;
  if (sourceSession.principalLaneDisabledReason) {
    return { status: 'disabled', reason: sourceSession.principalLaneDisabledReason };
  }
  if (sourceSession.principalLaneQuarantineReason) {
    return { status: 'quarantined', reason: sourceSession.principalLaneQuarantineReason };
  }
  const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId);
  if (!displayTarget) {
    mutateOwnedSessionsAtomically([sourceSessionId], rows => {
      const fresh = rows.get(sourceSessionId);
      if (!fresh) throw new Error(`principal-lane source session not found: ${sourceSessionId}`);
      fresh.principalLaneQuarantineReason = 'invalid_source_display_target';
    });
    return { status: 'quarantined', reason: 'invalid_source_display_target' };
  }
  const sourceHit = ownStore.db.prepare(
    'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
    + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
  ).get(sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
  const laneHit = ownStore.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
  ).get(sourceSessionId) as PrincipalLaneSidecarRow | undefined;
  if (!sourceHit && !laneHit) return undefined;
  const source = parseSourceSidecar(sourceHit, displayTarget, sourceSessionId);
  const lane = parseLaneSidecar(laneHit, { displayTarget, sourceSessionId });
  if (!source.ok || !lane.ok
      || lane.value.binding.laneId !== 'source'
      || lane.value.sessionId !== sourceSessionId
      || source.value.sourcePrincipalKey !== lane.value.binding.principalKey
      || source.value.workspaceEpoch !== lane.value.binding.workspaceEpoch) {
    const sourceLaneMismatch = source.ok && lane.ok;
    runOwnedWriteTransaction(ownStore, false, () => {
      if (!source.ok) quarantinePrincipalLaneSource(ownStore!, sourceSessionId);
      if (!lane.ok || sourceLaneMismatch) quarantinePrincipalLane(ownStore!, sourceSessionId);
    });
    if (!source.ok) return { status: 'quarantined', reason: `source:${source.error}` };
    if (!lane.ok) return { status: 'quarantined', reason: `lane:${lane.error}` };
    return { status: 'quarantined', reason: 'source_lane_mismatch' };
  }
  return { status: 'ready', source: source.value, lane: lane.value.binding };
}

export type ResolvePrincipalLaneForIngressResult =
  | { status: 'ready'; laneId: string; routingAnchor: string }
  | { status: 'missing' }
  | { status: 'identity_conflict'; reason: 'identity_evidence_conflict' }
  | { status: 'retry'; reason: 'source_not_active' | 'lane_not_active' };

/** Resolve only the durable identity index. The returned lane id is not an
 * activation capability; callers must still run hydratePrincipalLaneForIngress
 * under lane admission before publishing a runtime session. */
export function resolvePrincipalLaneForIngress(args: {
  sourceSessionId: string;
  identity: HumanLaneIdentityEvidence;
}): ResolvePrincipalLaneForIngressResult {
  loadForWrite();
  if (!ownStore || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const source = readPrincipalLaneSource(args.sourceSessionId);
  if (!source || source.status !== 'ready' || source.source.phase !== 'active') {
    return { status: 'retry', reason: 'source_not_active' };
  }
  const evidence = resolveHumanLaneEvidence(args.identity, currentAppId);
  if (!evidence) return { status: 'missing' };
  if (evidence.canonicalKey === source.source.sourcePrincipalKey) {
    return { status: 'ready', laneId: 'source', routingAnchor: source.lane.routingAnchor };
  }
  const rows = evidence.aliasKeys.map(aliasKey => ownStore!.db.prepare(
    'SELECT lane_id, canonical_principal_key FROM principal_lane_aliases '
    + 'WHERE source_session_id = ? AND alias_key = ?',
  ).get(args.sourceSessionId, aliasKey) as {
    lane_id: string; canonical_principal_key: string;
  } | undefined).filter((row): row is { lane_id: string; canonical_principal_key: string } => !!row);
  const laneIds = new Set(rows.map(row => row.lane_id));
  const canonicalKeys = new Set(rows.map(row => row.canonical_principal_key));
  if (laneIds.size > 1 || canonicalKeys.size > 1) {
    return { status: 'identity_conflict', reason: 'identity_evidence_conflict' };
  }
  const row = rows[0];
  if (!row) return { status: 'missing' };
  const lane = ownStore.db.prepare(
    'SELECT routing_anchor FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
  ).get(args.sourceSessionId, row.lane_id) as { routing_anchor: string } | undefined;
  return lane?.routing_anchor
    ? { status: 'ready', laneId: row.lane_id, routingAnchor: lane.routing_anchor }
    : { status: 'retry', reason: 'lane_not_active' };
}

export type EnsureShadowPrincipalLaneResult =
  | {
      status: 'ready';
      created: boolean;
      lane: PrincipalLaneBinding;
      session: Session;
      worktree?: PrincipalLaneWorktreeProof;
    }
  | { status: 'retry'; reason: 'source_authority_changed' | 'source_not_active'
      | 'lane_not_active' | 'workspace_migration_required' | 'workspace_migration_busy'
      | 'worktree_not_committed' | 'store_busy' }
  | { status: 'identity_conflict'; reason: 'identity_evidence_conflict' }
  | { status: 'quarantined'; reason: string }
  | { status: 'unknown'; reason: 'worktree_publication_unknown' };

export interface ExpectedPrincipalLaneSourceAuthority {
  sourcePrincipalKey: string;
  sourceRevision: number;
  sourceLaneRevision: number;
  workspaceEpoch: number;
  canonicalCwd: string;
  workspaceGroupId: string;
  workspaceGroupKeyVersion: 2 | undefined;
  displayTarget: PrincipalLaneDisplayTarget;
}

export interface ExpectedPrincipalWorkspaceTicketAuthority {
  groupRevision: number;
  memberRevision: number;
}

export type EnqueuePrincipalWorkspaceTicketResult =
  | { status: 'ready'; created: boolean; ticket: PrincipalWorkspaceTicket }
  | { status: 'retry'; reason: 'stale_authority' | 'enqueue_not_committed' | 'store_busy' }
  | { status: 'busy'; reason: 'source_not_active' | 'lane_not_active'
      | 'workspace_group_not_active' | 'workspace_member_not_active'
      | 'sequence_exhausted' | 'counter_revision_exhausted' }
  | { status: 'conflict'; reason: 'turn_record_conflict' }
  | { status: 'quarantined'; target: 'source' | 'lane' | 'group' | 'member' | 'ticket'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'unknown'; reason: 'enqueue_unknown' };

export type PrincipalWorkspaceTicketInventoryResult =
  | {
      status: 'ready';
      namespaceVersion: 1;
      namespace: string;
      ticketed: Array<{ recordId: string; ticketId: string; sequence: number }>;
      orphanRecords: Array<{ recordId: string; exactFileLength: number }>;
      conflicts: Array<{
        recordId: string;
        ticketId: string;
        sequence: number;
        reason: 'ticket_authority_mismatch' | 'ticket_namespace_mismatch'
          | 'record_length_mismatch';
        expectedExactFileLength?: number;
        observedExactFileLength?: number;
      }>;
      unknown: Array<{
        recordId?: string;
        ticketId: string;
        sequence?: number;
        reason: 'ticket_row_unverified' | 'ticket_audit_unverified'
          | 'ticket_counter_unverified' | 'record_missing';
      }>;
      staging: Array<{ name: string; exactFileLength: number }>;
    }
  | { status: 'retry' | 'busy' | 'invalid' | 'quarantined'; reason: string };

export type EnsurePrincipalWorkspaceMembershipV2Result =
  | {
      status: 'ready';
      migrated: boolean;
      source: PrincipalLaneSourceState;
      group: PrincipalWorkspaceGroup;
      members: PrincipalWorkspaceMember[];
    }
  | {
      status: 'retry';
      reason: 'stale_authority' | 'source_not_active' | 'canonical_cwd_unavailable'
        | 'lane_not_active' | 'migration_busy';
    }
  | { status: 'conflict'; reason: 'group_identity_conflict' | 'membership_conflict' }
  | { status: 'quarantined'; reason: string };

export interface PrincipalWorkspaceMembershipLaneSnapshot {
  lane: PrincipalLaneBinding;
  session: Session;
  member: PrincipalWorkspaceMember;
}

export type ReadPrincipalWorkspaceMembershipV2Result =
  | {
      status: 'ready';
      source: PrincipalLaneSourceState;
      sourceLane: PrincipalLaneBinding;
      sourceSession: Session;
      group: PrincipalWorkspaceGroup;
      lanes: PrincipalWorkspaceMembershipLaneSnapshot[];
    }
  | { status: 'missing'; reason: string }
  | { status: 'stale'; reason: string }
  | { status: 'busy'; reason: string }
  | { status: 'quarantined'; target: 'source' | 'lane' | 'group' | 'member'; reason: string };

function expectedPrincipalLaneSourceMatches(
  source: PrincipalLaneSourceState,
  lane: PrincipalLaneBinding,
  expected: ExpectedPrincipalLaneSourceAuthority,
): boolean {
  return source.sourcePrincipalKey === expected.sourcePrincipalKey
    && source.revision === expected.sourceRevision
    && lane.revision === expected.sourceLaneRevision
    && source.workspaceEpoch === expected.workspaceEpoch
    && source.canonicalCwd === expected.canonicalCwd
    && source.workspaceGroupId === expected.workspaceGroupId
    && source.workspaceGroupKeyVersion === expected.workspaceGroupKeyVersion
    && samePrincipalDisplayTarget(source.displayTarget, expected.displayTarget);
}

type ValidatedPrincipalWorkspaceLane = {
  lane: ParsedPrincipalLaneSidecar;
  session: Session;
  sessionRow: string;
};

type ValidatedPrincipalLaneWorkspace =
  | { ok: true; worktree?: PrincipalLaneWorktreeProof }
  | { ok: false; reason: string };

/** Validate the durable workspace carrier for one lane. Source and legacy
 * shadow lanes retain the canonical source cwd; D-live shadow lanes must have
 * one exact embedded+indexed worktree proof. */
function validatePrincipalLaneWorkspace(
  store: SqliteReadStore,
  source: PrincipalLaneSourceState,
  lane: ParsedPrincipalLaneSidecar,
  session: Session,
): ValidatedPrincipalLaneWorkspace {
  if (lane.binding.laneId === 'source') {
    return canonicalSessionCwd(session) === source.canonicalCwd
      ? { ok: true }
      : { ok: false, reason: 'source_session_cwd_mismatch' };
  }
  const proofHit = readPrincipalLaneWorktreeRow(
    store, lane.binding.sourceSessionId, lane.binding.laneId,
  );
  if (!proofHit && !session.principalLaneWorktree) {
    return canonicalSessionCwd(session) === source.canonicalCwd
      ? { ok: true }
      : { ok: false, reason: 'legacy_lane_session_cwd_mismatch' };
  }
  const indexed = parseWorktreeSidecar(proofHit, {
    sourceSessionId: lane.binding.sourceSessionId,
    laneId: lane.binding.laneId,
    sessionId: lane.sessionId,
    principalKey: lane.binding.principalKey,
    workspaceEpoch: lane.binding.workspaceEpoch,
  });
  const embedded = session.principalLaneWorktree
    ? parsePrincipalLaneWorktreeProof(session.principalLaneWorktree, {
      sourceSessionId: lane.binding.sourceSessionId,
      laneId: lane.binding.laneId,
      sessionId: lane.sessionId,
      principalKey: lane.binding.principalKey,
      workspaceEpoch: lane.binding.workspaceEpoch,
    })
    : { ok: false as const, error: 'missing_embedded_proof' };
  if (!indexed.ok) return { ok: false, reason: `worktree:${indexed.error}` };
  if (!embedded.ok) return { ok: false, reason: `worktree:${embedded.error}` };
  if (JSON.stringify(indexed.value) !== JSON.stringify(embedded.value)
      || indexed.value.sourceCanonicalCwd !== source.canonicalCwd
      || canonicalSessionCwd(session) !== indexed.value.workingDir) {
    return { ok: false, reason: 'worktree_session_sidecar_mismatch' };
  }
  return { ok: true, worktree: indexed.value };
}

async function principalLaneWorktreeGitCarrierIsIntact(proof: Pick<
  PrincipalLaneWorktreeProof,
  'sourceRepoRoot' | 'sourceGitCommonDir' | 'worktreeRoot' | 'worktreeGitCommonDir'
    | 'workingDir' | 'branch'
>): Promise<boolean> {
  try {
    const [sourceGit, worktreeGit] = await Promise.all([
      readPrincipalLaneGitIdentity(proof.sourceRepoRoot),
      readPrincipalLaneGitIdentity(proof.worktreeRoot),
    ]);
    return proof.sourceRepoRoot !== proof.worktreeRoot
      && proof.sourceGitCommonDir === proof.worktreeGitCommonDir
      && sourceGit.repoRoot === proof.sourceRepoRoot
      && sourceGit.gitCommonDir === proof.sourceGitCommonDir
      && worktreeGit.repoRoot === proof.worktreeRoot
      && worktreeGit.gitCommonDir === proof.worktreeGitCommonDir
      && worktreeGit.gitCommonDir === sourceGit.gitCommonDir
      && worktreeGit.branch === proof.branch
      && realpathSync(proof.sourceRepoRoot) === proof.sourceRepoRoot
      && realpathSync(proof.worktreeRoot) === proof.worktreeRoot
      && realpathSync(proof.workingDir) === proof.workingDir;
  } catch {
    return false;
  }
}

function validatePrincipalWorkspaceLanes(
  store: OwnSqliteStore,
  sourceSessionId: string,
  source: PrincipalLaneSourceState,
  displayTarget: PrincipalLaneDisplayTarget,
  sourceSession: Session,
  sourceSessionRow: string,
):
  | { ok: true; lanes: ValidatedPrincipalWorkspaceLane[] }
  | { ok: false; kind: 'missing' | 'stale' | 'quarantined'; laneId: string; reason: string } {
  const hits = store.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + 'phase, revision, row FROM principal_lanes WHERE source_session_id = ? ORDER BY lane_id',
  ).all(sourceSessionId) as PrincipalLaneSidecarRow[];
  const lanes: ValidatedPrincipalWorkspaceLane[] = [];
  for (const hit of hits) {
    const parsed = parseLaneSidecar(hit, { displayTarget, sourceSessionId });
    if (!parsed.ok) {
      return { ok: false, kind: 'quarantined', laneId: hit.lane_id, reason: `lane:${parsed.error}` };
    }
    const binding = parsed.value.binding;
    if (binding.workspaceEpoch !== source.workspaceEpoch) {
      return {
        ok: false, kind: 'quarantined', laneId: binding.laneId,
        reason: 'lane_workspace_epoch_mismatch',
      };
    }
    if (binding.phase !== 'active' && binding.phase !== 'dormant') {
      return { ok: false, kind: 'stale', laneId: binding.laneId, reason: 'lane_not_active' };
    }
    const childHit = binding.laneId === 'source'
      ? { row: sourceSessionRow }
      : store.selectRow.get(parsed.value.sessionId) as { row: string } | undefined;
    if (!childHit) {
      return { ok: false, kind: 'missing', laneId: binding.laneId, reason: 'missing_lane_session' };
    }
    let child: Session;
    try { child = binding.laneId === 'source' ? sourceSession : JSON.parse(childHit.row) as Session; }
    catch {
      return {
        ok: false, kind: 'quarantined', laneId: binding.laneId,
        reason: 'invalid_lane_session_json',
      };
    }
    if (child.sessionId !== parsed.value.sessionId) {
      return {
        ok: false, kind: 'quarantined', laneId: binding.laneId,
        reason: 'lane_session_identity_mismatch',
      };
    }
    if (child.status !== 'active') {
      return { ok: false, kind: 'stale', laneId: binding.laneId, reason: 'lane_not_active' };
    }
    const embedded = child.principalLane
      ? parsePrincipalLaneBinding(child.principalLane, { displayTarget, sourceSessionId })
      : { ok: false as const, error: 'not_object' };
    if (!embedded.ok || !principalLaneBindingsEqual(embedded.value, binding)) {
      return {
        ok: false, kind: 'quarantined', laneId: binding.laneId,
        reason: 'lane_session_sidecar_mismatch',
      };
    }
    if (binding.laneId === 'source') {
      const normalized = sourceSessionDisplayTarget(child, currentAppId!);
      if (!normalized || !samePrincipalDisplayTarget(normalized, displayTarget)) {
        return {
          ok: false, kind: 'quarantined', laneId: binding.laneId,
          reason: 'lane_session_display_mismatch',
        };
      }
    } else {
      const explicitDisplayMatches = child.larkAppId === displayTarget.larkAppId
        && child.scope === displayTarget.scope
        && child.chatId === displayTarget.chatId
        && (displayTarget.scope === 'chat'
          || child.rootMessageId === displayTarget.rootMessageId);
      if (!explicitDisplayMatches) {
        return {
          ok: false, kind: 'quarantined', laneId: binding.laneId,
          reason: 'lane_session_display_mismatch',
        };
      }
    }
    const workspace = validatePrincipalLaneWorkspace(
      store, source, parsed.value, child,
    );
    if (!workspace.ok) {
      return {
        ok: false, kind: 'quarantined', laneId: binding.laneId,
        reason: workspace.reason,
      };
    }
    lanes.push({ lane: parsed.value, session: child, sessionRow: childHit.row });
  }
  if (!lanes.some(value => value.lane.binding.laneId === 'source')) {
    return { ok: false, kind: 'missing', laneId: 'source', reason: 'missing_source_lane' };
  }
  return { ok: true, lanes };
}

function tableExists(store: OwnSqliteStore, tableName: string): boolean {
  return !!store.db.prepare(
    "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName);
}

function principalWorkspaceStoreView(db: SqliteDatabaseLike): OwnSqliteStore {
  return {
    db,
    selectRow: db.prepare('SELECT row FROM sessions WHERE session_id = ?'),
    selectAll: db.prepare('SELECT session_id, row FROM sessions'),
    updateExact: db.prepare(
      'UPDATE sessions SET status = ?, row = ? WHERE session_id = ? AND row = ?',
    ),
    insertNew: db.prepare('INSERT INTO sessions (session_id, status, row) VALUES (?, ?, ?)'),
  };
}

interface PrincipalWorkspaceReadEvidence {
  sessions: unknown[];
  sources: unknown[];
  lanes: unknown[];
  members: unknown[];
  groups: unknown[];
}

function capturePrincipalWorkspaceReadEvidence(
  db: SqliteDatabaseLike,
  sourceSessionId: string,
): PrincipalWorkspaceReadEvidence {
  return {
    sessions: db.prepare(
      'SELECT session_id, status, row FROM sessions WHERE session_id = ? '
      + 'OR session_id IN (SELECT session_id FROM principal_lanes WHERE source_session_id = ?) '
      + 'ORDER BY session_id',
    ).all(sourceSessionId, sourceSessionId),
    sources: db.prepare(
      'SELECT source_session_id, source_principal_key, canonical_cwd, workspace_epoch, '
      + 'workspace_group_id, phase, revision, row FROM principal_lane_sources '
      + 'WHERE source_session_id = ? ORDER BY source_session_id',
    ).all(sourceSessionId),
    lanes: db.prepare(
      'SELECT lane_id, source_session_id, session_id, principal_key, routing_anchor, '
      + 'workspace_epoch, phase, revision, row FROM principal_lanes '
      + 'WHERE source_session_id = ? ORDER BY lane_id',
    ).all(sourceSessionId),
    members: db.prepare(
      'SELECT source_session_id, lane_id, session_id, group_id, workspace_epoch, '
      + 'membership_phase, revision, row FROM principal_workspace_members '
      + 'WHERE source_session_id = ? ORDER BY lane_id',
    ).all(sourceSessionId),
    // Group quarantine is collision-sensitive. Capture the complete app-store
    // index so a concurrently inserted identity alias cannot escape the CAS.
    groups: db.prepare(
      'SELECT group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
      + 'last_lease_generation, row FROM principal_workspace_groups ORDER BY group_id',
    ).all(),
  };
}

function principalWorkspaceReadEvidenceEqual(
  left: PrincipalWorkspaceReadEvidence,
  right: PrincipalWorkspaceReadEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type PrincipalWorkspaceQuarantinePlan = {
  result: Extract<ReadPrincipalWorkspaceMembershipV2Result, { status: 'quarantined' }>;
  laneId?: string;
  groupIds?: string[];
  audit?: {
    existingIdentity: unknown;
    incomingIdentity: unknown;
  };
};

function changedPrincipalWorkspaceReadResult(
  evidence: PrincipalWorkspaceReadEvidence,
): ReadPrincipalWorkspaceMembershipV2Result {
  const hasBusyGroup = evidence.groups.some(row => {
    const phase = (row as { phase?: unknown }).phase;
    return phase === 'closing' || phase === 'closed';
  });
  const hasBusyMember = evidence.members.some(row => {
    const phase = (row as { membership_phase?: unknown }).membership_phase;
    return phase === 'closing' || phase === 'closed';
  });
  return hasBusyGroup || hasBusyMember
    ? { status: 'busy', reason: 'authority_changed_before_quarantine' }
    : { status: 'stale', reason: 'authority_changed_before_quarantine' };
}

function applyPrincipalWorkspaceReadQuarantine(
  store: OwnSqliteStore,
  sourceSessionId: string,
  evidence: PrincipalWorkspaceReadEvidence,
  plan: PrincipalWorkspaceQuarantinePlan,
): ReadPrincipalWorkspaceMembershipV2Result {
  let committed = false;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const current = capturePrincipalWorkspaceReadEvidence(store.db, sourceSessionId);
    if (!principalWorkspaceReadEvidenceEqual(current, evidence)) {
      store.db.exec('COMMIT');
      committed = true;
      return changedPrincipalWorkspaceReadResult(current);
    }
    if (plan.audit) {
      persistPrincipalWorkspaceConflict(store, {
        sourceSessionId,
        incomingIdentity: plan.audit.incomingIdentity,
        existingIdentity: plan.audit.existingIdentity,
        reason: 'group_identity_conflict',
        now: new Date().toISOString(),
      });
    }
    if (plan.result.target === 'source') quarantinePrincipalLaneSource(store, sourceSessionId);
    if (plan.result.target === 'lane') {
      quarantinePrincipalLane(store, sourceSessionId, plan.laneId ?? 'source');
    }
    if (plan.result.target === 'group') {
      for (const groupId of plan.groupIds ?? []) quarantinePrincipalWorkspaceGroup(store, groupId);
    }
    if (plan.result.target === 'member' && plan.laneId) {
      quarantinePrincipalWorkspaceMember(store, sourceSessionId, plan.laneId);
    }
    store.db.exec('COMMIT');
    committed = true;
    return plan.result;
  } finally {
    if (!committed) {
      try { store.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
  }
}

/** Read a complete v2 workspace authority without migrating or repairing it.
 * Ready/missing/stale/busy paths are read-only. Persisted malformed state is
 * the sole case that performs the established narrow quarantine write. */
export function readPrincipalWorkspaceMembershipV2(
  sourceSessionId: string,
  expectedSource?: ExpectedPrincipalLaneSourceAuthority,
): ReadPrincipalWorkspaceMembershipV2Result {
  const appId = currentAppId;
  if (!appId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const path = getDbPath();
  if (!existsSync(path)) return { status: 'missing', reason: 'store_missing' };
  const db = openDbForRead(path);
  const store = principalWorkspaceStoreView(db);
  let snapshotOpen = false;
  let plan: PrincipalWorkspaceQuarantinePlan | undefined;
  let evidence: PrincipalWorkspaceReadEvidence | undefined;
  const quarantine = (next: PrincipalWorkspaceQuarantinePlan): ReadPrincipalWorkspaceMembershipV2Result => {
    plan = next;
    return next.result;
  };
  try {
    if (!tableExists(store, 'principal_lane_sources')
        || !tableExists(store, 'principal_lanes')
        || !tableExists(store, 'principal_workspace_groups')
        || !tableExists(store, 'principal_workspace_members')
        || !tableExists(store, 'principal_workspace_migration_audit')) {
      return { status: 'missing', reason: 'workspace_schema_missing' };
    }
    db.exec('BEGIN');
    snapshotOpen = true;
    const result = (() => {
      const sourceSessionHit = store.selectRow.get(sourceSessionId) as { row: string } | undefined;
      if (!sourceSessionHit) return { status: 'missing', reason: 'source_session_missing' } as const;
      let sourceSession: Session;
      try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
      catch {
        return quarantine({
          result: { status: 'quarantined', target: 'source', reason: 'invalid_source_session_json' },
        });
      }
      if (sourceSession.status !== 'active') {
        return { status: 'stale', reason: 'source_not_active' } as const;
      }
      const displayTarget = sourceSessionDisplayTarget(sourceSession, appId);
      if (!displayTarget) {
        return quarantine({
          result: { status: 'quarantined', target: 'source', reason: 'invalid_source_display_target' },
        });
      }
      const sourceHit = store.db.prepare(
        'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
        + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
      const sourceLaneHit = store.db.prepare(
        'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
        + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(sourceSessionId) as PrincipalLaneSidecarRow | undefined;
      if (!sourceHit || !sourceLaneHit) {
        return {
          status: 'missing',
          reason: !sourceHit ? 'source_sidecar_missing' : 'source_lane_missing',
        } as const;
      }
      const source = parseSourceSidecar(sourceHit, displayTarget, sourceSessionId);
      if (!source.ok) {
        if (source.error === 'stored_quarantine') {
          return { status: 'quarantined', target: 'source', reason: `source:${source.error}` } as const;
        }
        return quarantine({
          result: { status: 'quarantined', target: 'source', reason: `source:${source.error}` },
        });
      }
      const sourceLane = parseLaneSidecar(sourceLaneHit, { displayTarget, sourceSessionId });
      if (!sourceLane.ok) {
        if (sourceLane.error === 'stored_quarantine') {
          return { status: 'quarantined', target: 'lane', reason: `lane:${sourceLane.error}` } as const;
        }
        return quarantine({
          result: { status: 'quarantined', target: 'lane', reason: `lane:${sourceLane.error}` },
          laneId: 'source',
        });
      }
      if (sourceLane.value.binding.laneId !== 'source'
          || sourceLane.value.sessionId !== sourceSessionId
          || sourceLane.value.binding.principalKey !== source.value.sourcePrincipalKey
          || sourceLane.value.binding.workspaceEpoch !== source.value.workspaceEpoch) {
        return quarantine({
          result: { status: 'quarantined', target: 'lane', reason: 'source_lane_mismatch' },
          laneId: 'source',
        });
      }
      const embeddedSource = sourceSession.principalLaneSource
        ? parsePrincipalLaneSourceState(sourceSession.principalLaneSource, displayTarget, sourceSessionId)
        : { ok: false as const, error: 'not_object' };
      if (!embeddedSource.ok || !principalLaneSourcesEqual(embeddedSource.value, source.value)) {
        return quarantine({
          result: { status: 'quarantined', target: 'source', reason: 'source_session_mismatch' },
        });
      }
      const embeddedSourceLane = sourceSession.principalLane
        ? parsePrincipalLaneBinding(sourceSession.principalLane, { displayTarget, sourceSessionId })
        : { ok: false as const, error: 'not_object' };
      if (!embeddedSourceLane.ok
          || !principalLaneBindingsEqual(embeddedSourceLane.value, sourceLane.value.binding)) {
        return quarantine({
          result: { status: 'quarantined', target: 'lane', reason: 'source_lane_session_mismatch' },
          laneId: 'source',
        });
      }
      if (expectedSource
          && !expectedPrincipalLaneSourceMatches(source.value, sourceLane.value.binding, expectedSource)) {
        return { status: 'stale', reason: 'source_authority_changed' } as const;
      }
      if (source.value.phase !== 'active') {
        return { status: 'stale', reason: 'source_not_active' } as const;
      }
      if (sourceLane.value.binding.phase !== 'active') {
        return { status: 'stale', reason: 'lane_not_active' } as const;
      }
      if (source.value.workspaceGroupKeyVersion !== PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION) {
        return { status: 'stale', reason: 'workspace_migration_required' } as const;
      }
      testOnlyAfterPrincipalWorkspaceReadFence?.();
      let canonicalCwd: string;
      try { canonicalCwd = realpathSync(source.value.canonicalCwd); }
      catch { return { status: 'stale', reason: 'canonical_cwd_unavailable' } as const; }
      if (canonicalCwd !== source.value.canonicalCwd) {
        return { status: 'stale', reason: 'source_authority_changed' } as const;
      }
      const validatedLanes = validatePrincipalWorkspaceLanes(
        store, sourceSessionId, source.value, displayTarget, sourceSession, sourceSessionHit.row,
      );
      if (!validatedLanes.ok) {
        if (validatedLanes.kind === 'missing') {
          return { status: 'missing', reason: validatedLanes.reason } as const;
        }
        if (validatedLanes.kind === 'stale') {
          return { status: 'stale', reason: validatedLanes.reason } as const;
        }
        return quarantine({
          result: { status: 'quarantined', target: 'lane', reason: validatedLanes.reason },
          laneId: validatedLanes.laneId,
        });
      }

      const groupById = readWorkspaceGroupRow(store, source.value.workspaceGroupId);
      const groupByIdentity = store.db.prepare(
        'SELECT group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
        + 'last_lease_generation, row FROM principal_workspace_groups '
        + 'WHERE group_key_version = ? AND lark_app_id = ? AND canonical_cwd = ?',
      ).get(
        PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION, appId, source.value.canonicalCwd,
      ) as PrincipalWorkspaceGroupRow | undefined;
      if (groupById && groupByIdentity && groupById.group_id !== groupByIdentity.group_id) {
        return quarantine({
          result: { status: 'quarantined', target: 'group', reason: 'group:identity_collision' },
          groupIds: [groupById.group_id, groupByIdentity.group_id],
          audit: {
            incomingIdentity: {
              targetGroupId: source.value.workspaceGroupId,
              larkAppId: appId,
              canonicalCwd: source.value.canonicalCwd,
            },
            existingIdentity: {
              byId: groupById.group_id,
              byIdentity: groupByIdentity.group_id,
            },
          },
        });
      }
      const groupHit = groupById ?? groupByIdentity;
      if (!groupHit) return { status: 'missing', reason: 'workspace_group_missing' } as const;
      const group = parseWorkspaceGroupSidecar(groupHit);
      if (!group.ok) {
        if (group.error === 'stored_quarantine') {
          return { status: 'quarantined', target: 'group', reason: `group:${group.error}` } as const;
        }
        return quarantine({
          result: { status: 'quarantined', target: 'group', reason: `group:${group.error}` },
          groupIds: [groupHit.group_id],
        });
      }
      if (group.value.groupId !== source.value.workspaceGroupId
          || group.value.larkAppId !== appId
          || group.value.canonicalCwd !== source.value.canonicalCwd) {
        return quarantine({
          result: { status: 'quarantined', target: 'group', reason: 'group:identity_conflict' },
          groupIds: [group.value.groupId],
        });
      }
      if (group.value.phase !== 'active') {
        return { status: 'busy', reason: 'workspace_group_not_active' } as const;
      }

      const memberRows = store.db.prepare(
        'SELECT source_session_id, lane_id, session_id, group_id, workspace_epoch, '
        + 'membership_phase, revision, row FROM principal_workspace_members '
        + 'WHERE source_session_id = ? ORDER BY lane_id',
      ).all(sourceSessionId) as PrincipalWorkspaceMemberRow[];
      const laneIds = new Set(validatedLanes.lanes.map(value => value.lane.binding.laneId));
      const extraMember = memberRows.find(row => !laneIds.has(row.lane_id));
      if (extraMember) {
        return quarantine({
          result: { status: 'quarantined', target: 'member', reason: 'member:unexpected_lane' },
          laneId: extraMember.lane_id,
        });
      }
      const memberByLane = new Map(memberRows.map(row => [row.lane_id, row]));
      const lanes: PrincipalWorkspaceMembershipLaneSnapshot[] = [];
      for (const validated of validatedLanes.lanes) {
        const laneId = validated.lane.binding.laneId;
        const memberHit = memberByLane.get(laneId);
        if (!memberHit) return { status: 'missing', reason: 'workspace_member_missing' } as const;
        const member = parseWorkspaceMemberSidecar(memberHit);
        if (!member.ok) {
          if (member.error === 'stored_quarantine') {
            return { status: 'quarantined', target: 'member', reason: `member:${member.error}` } as const;
          }
          return quarantine({
            result: { status: 'quarantined', target: 'member', reason: `member:${member.error}` },
            laneId,
          });
        }
        if (!principalWorkspaceMemberIdentityMatchesLane(member.value, validated.lane, source.value)) {
          return quarantine({
            result: { status: 'quarantined', target: 'member', reason: 'member:identity_mismatch' },
            laneId: member.value.laneId,
          });
        }
        if (member.value.membershipPhase !== 'active') {
          return { status: 'busy', reason: 'workspace_member_not_active' } as const;
        }
        lanes.push({ lane: validated.lane.binding, session: validated.session, member: member.value });
      }
      return {
        status: 'ready', source: source.value, sourceLane: sourceLane.value.binding,
        sourceSession, group: group.value, lanes,
      } as const;
    })();
    if (plan) evidence = capturePrincipalWorkspaceReadEvidence(db, sourceSessionId);
    db.exec('COMMIT');
    snapshotOpen = false;
    if (!plan || !evidence) return result;
    testOnlyBeforePrincipalWorkspaceReadQuarantine?.();
    return applyPrincipalWorkspaceReadQuarantine(store, sourceSessionId, evidence, plan);
  } finally {
    if (snapshotOpen) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    try { db.close(); } catch { /* already closed */ }
  }
}

function persistPrincipalWorkspaceConflict(
  store: OwnSqliteStore,
  args: {
    sourceSessionId: string;
    laneId?: string;
    sessionId?: string;
    existingIdentity?: unknown;
    incomingIdentity: unknown;
    reason: 'group_identity_conflict' | 'membership_conflict';
    now: string;
  },
): void {
  store.db.prepare(
    'INSERT INTO principal_workspace_migration_audit '
    + '(audit_id, source_session_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), args.sourceSessionId, 'conflict', JSON.stringify({
    reason: args.reason,
    laneId: args.laneId,
    sessionId: args.sessionId,
    existingIdentity: args.existingIdentity,
    incomingIdentity: args.incomingIdentity,
  }), args.now);
  if (args.laneId && args.sessionId) {
    store.db.prepare(
      'INSERT INTO principal_workspace_member_conflicts '
      + '(conflict_id, source_session_id, lane_id, session_id, existing_identity, '
      + 'incoming_identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(), args.sourceSessionId, args.laneId, args.sessionId,
      args.existingIdentity === undefined ? null : JSON.stringify(args.existingIdentity),
      JSON.stringify(args.incomingIdentity), args.now,
    );
  }
}

/** Upgrade one complete source and all of its lanes from the source-local v1
 * workspace id to the shared canonical-cwd v2 group. The supplied fence is
 * mandatory: an old-fence concurrent loser always returns stale rather than
 * inferring that another migration is "close enough". */
export function ensurePrincipalWorkspaceMembershipV2(args: {
  sourceSessionId: string;
  expectedSource: ExpectedPrincipalLaneSourceAuthority;
  now?: string;
}): EnsurePrincipalWorkspaceMembershipV2Result {
  loadForWrite();
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const now = args.now ?? new Date().toISOString();
  if (!canonicalIso(now)) throw new Error('invalid principal workspace migration timestamp');
  let committedSourceSession: Session | undefined;
  let result: EnsurePrincipalWorkspaceMembershipV2Result;
  try {
    result = runOwnedWriteTransaction(store, false, (): EnsurePrincipalWorkspaceMembershipV2Result => {
    const sourceSessionHit = store.selectRow.get(args.sourceSessionId) as { row: string } | undefined;
    if (!sourceSessionHit) return { status: 'retry', reason: 'stale_authority' };
    let sourceSession: Session;
    try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
    catch {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'invalid_source_session_json' };
    }
    if (sourceSession.status !== 'active') return { status: 'retry', reason: 'source_not_active' };
    const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId!);
    if (!displayTarget) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'invalid_source_display_target' };
    }
    const sourceHit = store.db.prepare(
      'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
      + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
    ).get(args.sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
    const sourceLaneHit = store.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
    ).get(args.sourceSessionId) as PrincipalLaneSidecarRow | undefined;
    const sourceState = parseSourceSidecar(sourceHit, displayTarget, args.sourceSessionId);
    const sourceLane = parseLaneSidecar(sourceLaneHit, {
      displayTarget, sourceSessionId: args.sourceSessionId,
    });
    if (!sourceState.ok) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: `source:${sourceState.error}` };
    }
    if (!sourceLane.ok
        || sourceLane.value.binding.laneId !== 'source'
        || sourceLane.value.sessionId !== args.sourceSessionId
        || sourceLane.value.binding.principalKey !== sourceState.value.sourcePrincipalKey
        || sourceLane.value.binding.workspaceEpoch !== sourceState.value.workspaceEpoch) {
      quarantinePrincipalLane(store, args.sourceSessionId);
      return { status: 'quarantined', reason: !sourceLane.ok
        ? `lane:${sourceLane.error}` : 'source_lane_mismatch' };
    }
    const embeddedSource = sourceSession.principalLaneSource
      ? parsePrincipalLaneSourceState(
        sourceSession.principalLaneSource, displayTarget, args.sourceSessionId,
      )
      : { ok: false as const, error: 'not_object' };
    if (!embeddedSource.ok || !principalLaneSourcesEqual(embeddedSource.value, sourceState.value)) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'source_session_mismatch' };
    }
    if (sourceState.value.phase !== 'active' || sourceLane.value.binding.phase !== 'active') {
      return { status: 'retry', reason: 'source_not_active' };
    }
    if (!expectedPrincipalLaneSourceMatches(
      sourceState.value, sourceLane.value.binding, args.expectedSource,
    )) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    let canonicalCwd: string;
    try { canonicalCwd = realpathSync(sourceState.value.canonicalCwd); }
    catch { return { status: 'retry', reason: 'canonical_cwd_unavailable' }; }
    if (canonicalCwd !== sourceState.value.canonicalCwd) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    const validatedLanes = validatePrincipalWorkspaceLanes(
      store, args.sourceSessionId, sourceState.value, displayTarget,
      sourceSession, sourceSessionHit.row,
    );
    if (!validatedLanes.ok) {
      if (validatedLanes.kind === 'stale') {
        return { status: 'retry', reason: 'lane_not_active' };
      }
      quarantinePrincipalLane(store, args.sourceSessionId, validatedLanes.laneId);
      return { status: 'quarantined', reason: validatedLanes.reason };
    }

    const targetGroupId = principalWorkspaceGroupIdV2(currentAppId!, canonicalCwd);
    const groupById = readWorkspaceGroupRow(store, targetGroupId);
    const groupByIdentity = store.db.prepare(
      'SELECT group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
      + 'last_lease_generation, row FROM principal_workspace_groups '
      + 'WHERE group_key_version = ? AND lark_app_id = ? AND canonical_cwd = ?',
    ).get(
      PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION, currentAppId!, canonicalCwd,
    ) as PrincipalWorkspaceGroupRow | undefined;
    if (groupById && groupByIdentity && groupById.group_id !== groupByIdentity.group_id) {
      persistPrincipalWorkspaceConflict(store, {
        sourceSessionId: args.sourceSessionId,
        incomingIdentity: { targetGroupId, larkAppId: currentAppId, canonicalCwd },
        existingIdentity: { byId: groupById.group_id, byIdentity: groupByIdentity.group_id },
        reason: 'group_identity_conflict', now,
      });
      quarantinePrincipalWorkspaceGroup(store, groupById.group_id);
      quarantinePrincipalWorkspaceGroup(store, groupByIdentity.group_id);
      return { status: 'quarantined', reason: 'group:identity_collision' };
    }
    const groupHit = groupById ?? groupByIdentity;
    let existingGroup: PrincipalWorkspaceGroup | undefined;
    if (groupHit) {
      const parsedGroup = parseWorkspaceGroupSidecar(groupHit);
      if (!parsedGroup.ok) {
        quarantinePrincipalWorkspaceGroup(store, groupHit.group_id);
        return { status: 'quarantined', reason: `group:${parsedGroup.error}` };
      }
      existingGroup = parsedGroup.value;
      if (existingGroup.groupId !== targetGroupId
          || existingGroup.larkAppId !== currentAppId
          || existingGroup.canonicalCwd !== canonicalCwd) {
        persistPrincipalWorkspaceConflict(store, {
          sourceSessionId: args.sourceSessionId,
          incomingIdentity: { targetGroupId, larkAppId: currentAppId, canonicalCwd },
          existingIdentity: existingGroup,
          reason: 'group_identity_conflict', now,
        });
        quarantinePrincipalWorkspaceGroup(store, existingGroup.groupId);
        return { status: 'quarantined', reason: 'group:identity_conflict' };
      }
      if (existingGroup.phase !== 'active') {
        return { status: 'retry', reason: 'migration_busy' };
      }
    }

    const memberRows = store.db.prepare(
      'SELECT source_session_id, lane_id, session_id, group_id, workspace_epoch, '
      + 'membership_phase, revision, row FROM principal_workspace_members '
      + 'WHERE source_session_id = ? ORDER BY lane_id',
    ).all(args.sourceSessionId) as PrincipalWorkspaceMemberRow[];
    const byLaneId = new Map(memberRows.map(row => [row.lane_id, row]));

    if (sourceState.value.workspaceGroupKeyVersion === PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION) {
      if (sourceState.value.workspaceGroupId !== targetGroupId) {
        return { status: 'retry', reason: 'stale_authority' };
      }
      const laneIds = new Set(validatedLanes.lanes.map(value => value.lane.binding.laneId));
      if (memberRows.length !== validatedLanes.lanes.length
          || memberRows.some(row => !laneIds.has(row.lane_id))) {
        persistPrincipalWorkspaceConflict(store, {
          sourceSessionId: args.sourceSessionId,
          incomingIdentity: { lanes: [...laneIds].sort(), groupId: targetGroupId },
          existingIdentity: memberRows.map(row => ({ laneId: row.lane_id, sessionId: row.session_id })),
          reason: 'membership_conflict', now,
        });
        return { status: 'conflict', reason: 'membership_conflict' };
      }
      const members: PrincipalWorkspaceMember[] = [];
      for (const validated of validatedLanes.lanes) {
        const row = byLaneId.get(validated.lane.binding.laneId);
        const parsedMember = parseWorkspaceMemberSidecar(row);
        if (!parsedMember.ok) {
          if (row) quarantinePrincipalWorkspaceMember(
            store, args.sourceSessionId, validated.lane.binding.laneId,
          );
          return { status: 'quarantined', reason: `member:${parsedMember.error}` };
        }
        if (!principalWorkspaceMemberIdentityMatchesLane(
          parsedMember.value, validated.lane, sourceState.value,
        )) {
          persistPrincipalWorkspaceConflict(store, {
            sourceSessionId: args.sourceSessionId,
            laneId: validated.lane.binding.laneId,
            sessionId: validated.lane.sessionId,
            existingIdentity: parsedMember.value,
            incomingIdentity: {
              sourceSessionId: args.sourceSessionId,
              laneId: validated.lane.binding.laneId,
              sessionId: validated.lane.sessionId,
              groupId: targetGroupId,
              workspaceEpoch: sourceState.value.workspaceEpoch,
            },
            reason: 'membership_conflict', now,
          });
          return { status: 'conflict', reason: 'membership_conflict' };
        }
        if (parsedMember.value.membershipPhase !== 'active') {
          return { status: 'retry', reason: 'migration_busy' };
        }
        members.push(parsedMember.value);
      }
      if (!existingGroup) {
        persistPrincipalWorkspaceConflict(store, {
          sourceSessionId: args.sourceSessionId,
          incomingIdentity: { targetGroupId, larkAppId: currentAppId, canonicalCwd },
          reason: 'group_identity_conflict', now,
        });
        return { status: 'conflict', reason: 'group_identity_conflict' };
      }
      return {
        status: 'ready', migrated: false, source: sourceState.value,
        group: existingGroup, members,
      };
    }

    const existingTicketWork = tableExists(store, 'principal_workspace_tickets')
      && !!store.db.prepare(
        'SELECT 1 AS hit FROM principal_workspace_tickets WHERE source_session_id = ? LIMIT 1',
      ).get(args.sourceSessionId);
    if (existingTicketWork || tableExists(store, 'principal_workspace_active_leases')) {
      return { status: 'retry', reason: 'migration_busy' };
    }
    if (memberRows.length > 0) {
      const row = memberRows[0]!;
      persistPrincipalWorkspaceConflict(store, {
        sourceSessionId: args.sourceSessionId,
        laneId: row.lane_id,
        sessionId: row.session_id,
        existingIdentity: row,
        incomingIdentity: { targetGroupId, workspaceEpoch: sourceState.value.workspaceEpoch },
        reason: 'membership_conflict', now,
      });
      return { status: 'conflict', reason: 'membership_conflict' };
    }
    for (const validated of validatedLanes.lanes) {
      const sessionOwner = store.db.prepare(
        'SELECT source_session_id, lane_id, session_id, group_id, workspace_epoch, '
        + 'membership_phase, revision, row FROM principal_workspace_members '
        + 'WHERE session_id = ?',
      ).get(validated.lane.sessionId) as PrincipalWorkspaceMemberRow | undefined;
      if (sessionOwner) {
        persistPrincipalWorkspaceConflict(store, {
          sourceSessionId: args.sourceSessionId,
          laneId: validated.lane.binding.laneId,
          sessionId: validated.lane.sessionId,
          existingIdentity: sessionOwner,
          incomingIdentity: { targetGroupId, workspaceEpoch: sourceState.value.workspaceEpoch },
          reason: 'membership_conflict', now,
        });
        return { status: 'conflict', reason: 'membership_conflict' };
      }
    }

    const group = existingGroup ?? initialPrincipalWorkspaceGroup(currentAppId!, canonicalCwd, now);
    const members = validatedLanes.lanes.map(value => initialPrincipalWorkspaceMember({
      sourceSessionId: args.sourceSessionId,
      laneId: value.lane.binding.laneId,
      sessionId: value.lane.sessionId,
      groupId: targetGroupId,
      workspaceEpoch: sourceState.value.workspaceEpoch,
      now,
    }));
    const nextSource: PrincipalLaneSourceState = {
      ...sourceState.value,
      workspaceGroupId: targetGroupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
      revision: sourceState.value.revision + 1,
      updatedAt: now,
    };
    const nextSourceSession: Session = {
      ...sourceSession,
      principalLaneSource: nextSource,
    };

    if (!existingGroup) insertPrincipalWorkspaceGroup(store, group);
    for (const member of members) insertPrincipalWorkspaceMember(store, member);
    const sourceUpdated = store.db.prepare(
      'UPDATE principal_lane_sources SET workspace_group_id = ?, revision = ?, row = ? '
      + 'WHERE source_session_id = ? AND revision = ? AND workspace_group_id = ?',
    ).run(
      nextSource.workspaceGroupId, nextSource.revision, JSON.stringify(nextSource),
      args.sourceSessionId, sourceState.value.revision, sourceState.value.workspaceGroupId,
    );
    if (Number(sourceUpdated.changes) !== 1) throw new PrincipalLaneAuthorityChangedError();
    const sessionUpdated = store.updateExact.run(
      sessionStatusText(nextSourceSession), JSON.stringify(nextSourceSession),
      args.sourceSessionId, sourceSessionHit.row,
    );
    if (Number(sessionUpdated.changes) !== 1) throw new PrincipalLaneAuthorityChangedError();
    store.db.prepare(
      'INSERT INTO principal_workspace_migration_audit '
      + '(audit_id, source_session_id, event, from_group_id, target_group_id, '
      + 'from_revision, from_epoch, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(), args.sourceSessionId, 'migrated', sourceState.value.workspaceGroupId,
      targetGroupId, sourceState.value.revision, sourceState.value.workspaceEpoch,
      JSON.stringify({ laneCount: members.length }), now,
    );
    committedSourceSession = nextSourceSession;
    return { status: 'ready', migrated: true, source: nextSource, group, members };
    });
  } catch (error) {
    if (error instanceof PrincipalLaneAuthorityChangedError) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    throw error;
  }
  if (committedSourceSession) {
    const cached = sessions.get(args.sourceSessionId);
    if (cached) {
      for (const key of Object.keys(cached)) delete (cached as unknown as Record<string, unknown>)[key];
      Object.assign(cached, structuredClone(committedSourceSession));
    } else {
      sessions.set(args.sourceSessionId, committedSourceSession);
    }
  }
  return result;
}

type ValidatedTicketEnqueueAuthority = {
  source: PrincipalLaneSourceState;
  lane: ParsedPrincipalLaneSidecar;
  group: PrincipalWorkspaceGroup;
  member: PrincipalWorkspaceMember;
};

function validateTicketEnqueueAuthority(
  store: OwnSqliteStore,
  authority: PrincipalLaneDispatchAuthority,
  expected: ExpectedPrincipalWorkspaceTicketAuthority,
): { ok: true; value: ValidatedTicketEnqueueAuthority }
  | { ok: false; result: EnqueuePrincipalWorkspaceTicketResult } {
  const sourceSessionId = authority.source.sourceSessionId;
  if (!currentAppId || authority.source.source.displayTarget.larkAppId !== currentAppId) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  const sourceSessionHit = store.selectRow.get(sourceSessionId) as { row: string } | undefined;
  if (!sourceSessionHit) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  let sourceSession: Session;
  try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
  catch {
    quarantinePrincipalLaneSource(store, sourceSessionId);
    return {
      ok: false,
      result: { status: 'quarantined', target: 'source', reason: 'invalid_source_session_json' },
    };
  }
  if (sourceSession.status !== 'active' || authority.source.source.phase !== 'active') {
    return { ok: false, result: { status: 'busy', reason: 'source_not_active' } };
  }
  const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId);
  if (!displayTarget) {
    quarantinePrincipalLaneSource(store, sourceSessionId);
    return {
      ok: false,
      result: { status: 'quarantined', target: 'source', reason: 'invalid_source_display_target' },
    };
  }
  const sourceHit = store.db.prepare(
    'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
    + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
  ).get(sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
  const sourceLaneHit = store.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
  ).get(sourceSessionId) as PrincipalLaneSidecarRow | undefined;
  const source = parseSourceSidecar(sourceHit, displayTarget, sourceSessionId);
  const sourceLane = parseLaneSidecar(sourceLaneHit, { displayTarget, sourceSessionId });
  if (!source.ok) {
    if (source.error === 'missing_sidecar') {
      return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
    }
    quarantinePrincipalLaneSource(store, sourceSessionId);
    return {
      ok: false,
      result: { status: 'quarantined', target: 'source', reason: `source:${source.error}` },
    };
  }
  if (!sourceLane.ok || sourceLane.value.binding.laneId !== 'source'
      || sourceLane.value.sessionId !== sourceSessionId) {
    if (!sourceLane.ok && sourceLane.error === 'missing_sidecar') {
      return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
    }
    quarantinePrincipalLane(store, sourceSessionId);
    return {
      ok: false,
      result: {
        status: 'quarantined', target: 'lane',
        reason: !sourceLane.ok ? `lane:${sourceLane.error}` : 'source_lane_mismatch',
      },
    };
  }
  if (!principalLaneSourcesEqual(source.value, authority.source.source)
      || !principalLaneBindingsEqual(sourceLane.value.binding, authority.source.lane)) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  const embeddedSource = sourceSession.principalLaneSource
    ? parsePrincipalLaneSourceState(sourceSession.principalLaneSource, displayTarget, sourceSessionId)
    : { ok: false as const, error: 'not_object' };
  if (!embeddedSource.ok || !principalLaneSourcesEqual(embeddedSource.value, source.value)) {
    quarantinePrincipalLaneSource(store, sourceSessionId);
    return {
      ok: false,
      result: { status: 'quarantined', target: 'source', reason: 'source_session_mismatch' },
    };
  }
  if (source.value.workspaceGroupKeyVersion !== PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  const lanes = validatePrincipalWorkspaceLanes(
    store, sourceSessionId, source.value, displayTarget, sourceSession, sourceSessionHit.row,
  );
  if (!lanes.ok) {
    if (lanes.kind === 'missing') {
      return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
    }
    if (lanes.kind === 'stale') {
      return { ok: false, result: { status: 'busy', reason: 'lane_not_active' } };
    }
    quarantinePrincipalLane(store, sourceSessionId, lanes.laneId);
    return {
      ok: false,
      result: { status: 'quarantined', target: 'lane', reason: lanes.reason },
    };
  }
  const target = lanes.lanes.find(value => value.lane.binding.laneId === authority.lane.lane.laneId);
  if (!target
      || target.lane.sessionId !== authority.lane.sessionId
      || !principalLaneBindingsEqual(target.lane.binding, authority.lane.lane)
      || authority.session.sessionId !== target.lane.sessionId) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  const groupHit = readWorkspaceGroupRow(store, source.value.workspaceGroupId);
  const group = parseWorkspaceGroupSidecar(groupHit);
  if (!group.ok) {
    if (group.error === 'missing_group') {
      return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
    }
    if (group.error !== 'stored_quarantine' && groupHit) {
      quarantinePrincipalWorkspaceGroup(store, source.value.workspaceGroupId);
    }
    return {
      ok: false,
      result: { status: 'quarantined', target: 'group', reason: `group:${group.error}` },
    };
  }
  if (group.value.groupId !== source.value.workspaceGroupId
      || group.value.larkAppId !== currentAppId
      || group.value.canonicalCwd !== source.value.canonicalCwd
      || group.value.revision !== expected.groupRevision) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  if (group.value.phase !== 'active') {
    return { ok: false, result: { status: 'busy', reason: 'workspace_group_not_active' } };
  }
  const memberHit = readWorkspaceMemberRow(store, sourceSessionId, target.lane.binding.laneId);
  const member = parseWorkspaceMemberSidecar(memberHit);
  if (!member.ok) {
    if (member.error === 'missing_member') {
      return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
    }
    if (member.error !== 'stored_quarantine' && memberHit) {
      quarantinePrincipalWorkspaceMember(store, sourceSessionId, target.lane.binding.laneId);
    }
    return {
      ok: false,
      result: { status: 'quarantined', target: 'member', reason: `member:${member.error}` },
    };
  }
  if (!principalWorkspaceMemberIdentityMatchesLane(member.value, target.lane, source.value)
      || member.value.revision !== expected.memberRevision) {
    return { ok: false, result: { status: 'retry', reason: 'stale_authority' } };
  }
  if (member.value.membershipPhase !== 'active') {
    return { ok: false, result: { status: 'busy', reason: 'workspace_member_not_active' } };
  }
  return { ok: true, value: { source: source.value, lane: target.lane, group: group.value, member: member.value } };
}

function ticketConflictOrCorruption(
  store: OwnSqliteStore,
  existingRow: PrincipalWorkspaceTicketRow,
  incoming: {
    ticketId: string;
    groupId: string;
    sourceSessionId: string;
    laneId: string;
    sessionId: string;
    turnId: string;
    locator: PrincipalWorkspaceTicketLocator;
    now: string;
  },
): EnqueuePrincipalWorkspaceTicketResult {
  if (existingRow.ticket_id === incoming.ticketId
      && (existingRow.group_id !== incoming.groupId
        || existingRow.source_session_id !== incoming.sourceSessionId
        || existingRow.lane_id !== incoming.laneId
        || existingRow.session_id !== incoming.sessionId
        || existingRow.turn_id !== incoming.turnId)) {
    persistPrincipalWorkspaceTicketAudit(store, {
      ...incoming,
      event: 'ticket_id_collision',
      detail: {
        existingIdentity: {
          groupId: existingRow.group_id,
          sourceSessionId: existingRow.source_session_id,
          laneId: existingRow.lane_id,
          sessionId: existingRow.session_id,
          turnId: existingRow.turn_id,
        },
        incomingIdentity: {
          groupId: incoming.groupId,
          sourceSessionId: incoming.sourceSessionId,
          laneId: incoming.laneId,
          sessionId: incoming.sessionId,
          turnId: incoming.turnId,
        },
      },
    });
    quarantinePrincipalWorkspaceGroup(store, incoming.groupId);
    if (existingRow.group_id !== incoming.groupId) {
      quarantinePrincipalWorkspaceGroup(store, existingRow.group_id);
    }
    return { status: 'quarantined', target: 'ticket', reason: 'ticket_id_collision' };
  }
  const parsed = parseWorkspaceTicketSidecar(existingRow);
  if (!parsed.ok) {
    persistPrincipalWorkspaceTicketAudit(store, {
      ...incoming, event: 'ticket_row_corruption', detail: { error: parsed.error },
    });
    quarantinePrincipalWorkspaceGroup(store, incoming.groupId);
    return { status: 'quarantined', target: 'ticket', reason: `ticket:${parsed.error}` };
  }
  const ticket = parsed.value;
  const enqueuedAudit = readEnqueuedTicketAudit(store, ticket.ticketId);
  if (!ticketAuditMatchesTicket(enqueuedAudit, ticket)) {
    persistPrincipalWorkspaceTicketAudit(store, {
      ...incoming, event: 'ticket_row_corruption', detail: { error: 'enqueued_audit_mismatch' },
    });
    quarantinePrincipalWorkspaceGroup(store, incoming.groupId);
    if (ticket.groupId !== incoming.groupId) {
      quarantinePrincipalWorkspaceGroup(store, ticket.groupId);
    }
    return { status: 'quarantined', target: 'ticket', reason: 'ticket:enqueued_audit_mismatch' };
  }
  const sameTurnIdentity = ticket.ticketId === incoming.ticketId
    && ticket.groupId === incoming.groupId
    && ticket.sourceSessionId === incoming.sourceSessionId
    && ticket.laneId === incoming.laneId
    && ticket.sessionId === incoming.sessionId
    && ticket.turnId === incoming.turnId;
  if (sameTurnIdentity && sameTicketLocator(ticket.locator, incoming.locator)) {
    return { status: 'ready', created: false, ticket };
  }
  if (ticket.sourceSessionId === incoming.sourceSessionId
      && ticket.laneId === incoming.laneId
      && ticket.sessionId === incoming.sessionId
      && ticket.turnId === incoming.turnId) {
    persistPrincipalWorkspaceTicketAudit(store, {
      ...incoming, event: 'turn_record_conflict',
      detail: { existingTicket: ticket, incomingLocator: incoming.locator },
    });
    return { status: 'conflict', reason: 'turn_record_conflict' };
  }
  const event: PrincipalWorkspaceTicketAuditEvent = existingRow.ticket_id === incoming.ticketId
    ? 'ticket_id_collision' : 'record_ticket_conflict';
  persistPrincipalWorkspaceTicketAudit(store, {
    ...incoming, event, detail: { existingTicket: ticket, incomingLocator: incoming.locator },
  });
  quarantinePrincipalWorkspaceGroup(store, incoming.groupId);
  if (ticket.groupId !== incoming.groupId) quarantinePrincipalWorkspaceGroup(store, ticket.groupId);
  return { status: 'quarantined', target: 'ticket', reason: event };
}

function recoverPrincipalWorkspaceEnqueueOutcome(args: {
  path: string;
  ticketId: string;
  groupId: string;
  sourceSessionId: string;
  laneId: string;
  sessionId: string;
  turnId: string;
  locator: PrincipalWorkspaceTicketLocator;
  counterBeforeCommit: string | null | undefined;
}): EnqueuePrincipalWorkspaceTicketResult {
  const db = openDbForRead(args.path);
  const store = principalWorkspaceStoreView(db);
  let open = false;
  try {
    db.exec('BEGIN');
    open = true;
    const byId = readWorkspaceTicketById(store, args.ticketId);
    const byTurn = readWorkspaceTicketByTurn(
      store, args.sourceSessionId, args.laneId, args.sessionId, args.turnId,
    );
    const byRecord = readWorkspaceTicketByRecord(store, args.locator);
    const hits = [byId, byTurn, byRecord]
      .filter((row): row is PrincipalWorkspaceTicketRow => !!row);
    if (new Set(hits.map(row => row.ticket_id)).size > 1) {
      db.exec('COMMIT');
      open = false;
      return { status: 'unknown', reason: 'enqueue_unknown' };
    }
    const row = byId ?? byTurn ?? byRecord;
    if (!row) {
      const auditTrace = store.db.prepare(
        'SELECT COUNT(*) AS value FROM principal_workspace_ticket_audit '
        + 'WHERE ticket_id = ? OR (source_session_id = ? AND lane_id = ? '
        + 'AND session_id = ? AND turn_id = ?)',
      ).get(
        args.ticketId, args.sourceSessionId, args.laneId, args.sessionId, args.turnId,
      ) as { value: number };
      const counterRow = store.db.prepare(
        'SELECT group_id, last_sequence, revision, created_at, updated_at, row '
        + 'FROM principal_workspace_ticket_sequences WHERE group_id = ?',
      ).get(args.groupId) as PrincipalWorkspaceTicketSequenceRow | undefined;
      const currentCounterEvidence = ticketCounterEvidence(counterRow);
      const provablyUncommitted = args.counterBeforeCommit !== undefined
        && currentCounterEvidence === args.counterBeforeCommit
        && Number(auditTrace.value) === 0;
      db.exec('COMMIT');
      open = false;
      return provablyUncommitted
        ? { status: 'retry', reason: 'enqueue_not_committed' }
        : { status: 'unknown', reason: 'enqueue_unknown' };
    }
    const parsed = parseWorkspaceTicketSidecar(row);
    const audit = readEnqueuedTicketAudit(store, row.ticket_id);
    if (!parsed.ok || !ticketAuditMatchesTicket(audit, parsed.value)) {
      db.exec('COMMIT');
      open = false;
      return { status: 'unknown', reason: 'enqueue_unknown' };
    }
    const counterRow = store.db.prepare(
      'SELECT group_id, last_sequence, revision, created_at, updated_at, row '
      + 'FROM principal_workspace_ticket_sequences WHERE group_id = ?',
    ).get(parsed.value.groupId) as PrincipalWorkspaceTicketSequenceRow | undefined;
    const counter = parseWorkspaceTicketSequenceSidecar(counterRow);
    if (!counter.ok || counter.value.lastSequence < parsed.value.sequence) {
      db.exec('COMMIT');
      open = false;
      return { status: 'unknown', reason: 'enqueue_unknown' };
    }
    const stableIdentity = parsed.value.ticketId === args.ticketId
      && parsed.value.groupId === args.groupId
      && parsed.value.sourceSessionId === args.sourceSessionId
      && parsed.value.laneId === args.laneId
      && parsed.value.sessionId === args.sessionId
      && parsed.value.turnId === args.turnId;
    const result: EnqueuePrincipalWorkspaceTicketResult = !stableIdentity
      ? { status: 'unknown', reason: 'enqueue_unknown' }
      : sameTicketLocator(parsed.value.locator, args.locator)
        ? { status: 'ready', created: false, ticket: parsed.value }
        : { status: 'conflict', reason: 'turn_record_conflict' };
    db.exec('COMMIT');
    open = false;
    return result;
  } catch {
    return { status: 'unknown', reason: 'enqueue_unknown' };
  } finally {
    if (open) try { db.exec('ROLLBACK'); } catch { /* already ended */ }
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Persist exactly one immutable record admission ticket. The turn id and
 * durable locator are extracted only from the opaque append receipt. */
export function enqueuePrincipalWorkspaceTicket(args: {
  receipt: PrincipalLaneAppendReceipt;
  authority: PrincipalLaneDispatchAuthority;
  expected: ExpectedPrincipalWorkspaceTicketAuthority;
  now?: string;
}): EnqueuePrincipalWorkspaceTicketResult {
  const located = principalLaneAppendReceiptLocator(args.receipt, args.authority);
  if (located.status !== 'ready') {
    if (located.status === 'retry') return { status: 'retry', reason: 'store_busy' };
    if (located.status === 'quarantined') {
      return { status: 'quarantined', target: 'ticket', reason: located.reason };
    }
    return { status: 'invalid', reason: located.reason };
  }
  const locatorParsed = parsePrincipalWorkspaceTicketLocator(located.value);
  if (!locatorParsed.ok) return { status: 'invalid', reason: locatorParsed.error };
  const locator = locatorParsed.value;
  const now = args.now ?? new Date().toISOString();
  if (!canonicalIso(now)) return { status: 'invalid', reason: 'invalid_enqueue_timestamp' };
  loadForWrite();
  if (!currentAppId || !ownStore) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const path = getDbPath();
  const db = openDatabaseSyncOrThrow(path);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  const store = principalWorkspaceStoreView(db);
  const identity = {
    ticketId: principalWorkspaceTicketIdV1({
      groupId: args.authority.source.source.workspaceGroupId,
      sourceSessionId: args.authority.source.sourceSessionId,
      laneId: args.authority.lane.lane.laneId,
      sessionId: args.authority.lane.sessionId,
      turnId: locator.turnId,
    }),
    groupId: args.authority.source.source.workspaceGroupId,
    sourceSessionId: args.authority.source.sourceSessionId,
    laneId: args.authority.lane.lane.laneId,
    sessionId: args.authority.lane.sessionId,
    turnId: locator.turnId,
    locator,
    now,
  };
  let transactionOpen = false;
  let counterBeforeCommit: string | null | undefined;
  let result: EnqueuePrincipalWorkspaceTicketResult;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const validated = validateTicketEnqueueAuthority(store, args.authority, args.expected);
    if (!validated.ok) {
      result = validated.result;
    } else {
      const observedCounterRow = store.db.prepare(
        'SELECT group_id, last_sequence, revision, created_at, updated_at, row '
        + 'FROM principal_workspace_ticket_sequences WHERE group_id = ?',
      ).get(identity.groupId) as PrincipalWorkspaceTicketSequenceRow | undefined;
      counterBeforeCommit = ticketCounterEvidence(observedCounterRow);
      const hits = [
        readWorkspaceTicketById(store, identity.ticketId),
        readWorkspaceTicketByTurn(
          store, identity.sourceSessionId, identity.laneId, identity.sessionId, identity.turnId,
        ),
        readWorkspaceTicketByRecord(store, locator),
      ].filter((row): row is PrincipalWorkspaceTicketRow => !!row);
      const distinct = [...new Map(hits.map(row => [row.ticket_id, row])).values()];
      let existingCounterError: string | undefined;
      let existingMaxSequence = 0;
      if (distinct.length > 0) {
        const existingMaxHit = store.db.prepare(
          'SELECT MAX(sequence) AS value FROM principal_workspace_tickets WHERE group_id = ?',
        ).get(identity.groupId) as { value: number | null };
        existingMaxSequence = existingMaxHit.value === null ? 0 : Number(existingMaxHit.value);
        const existingCounter = parseWorkspaceTicketSequenceSidecar(observedCounterRow);
        if (!existingCounter.ok
            || existingCounter.value.groupId !== identity.groupId
            || existingCounter.value.lastSequence < existingMaxSequence) {
          existingCounterError = existingCounter.ok
            ? 'counter_range_mismatch' : existingCounter.error;
        }
      }
      if (existingCounterError) {
        persistPrincipalWorkspaceTicketAudit(store, {
          ...identity, event: 'counter_corruption',
          detail: { error: existingCounterError, maxSequence: existingMaxSequence },
        });
        quarantinePrincipalWorkspaceGroup(store, identity.groupId);
        result = { status: 'quarantined', target: 'group', reason: 'counter_corruption' };
      } else if (distinct.length > 1) {
        persistPrincipalWorkspaceTicketAudit(store, {
          ...identity, event: 'record_ticket_conflict',
          detail: { existingTicketIds: distinct.map(row => row.ticket_id).sort() },
        });
        quarantinePrincipalWorkspaceGroup(store, identity.groupId);
        result = { status: 'quarantined', target: 'ticket', reason: 'ticket_index_collision' };
      } else if (distinct.length > 0) {
        result = ticketConflictOrCorruption(store, distinct[0]!, identity);
      } else {
        const counterRow = observedCounterRow;
        const maxHit = store.db.prepare(
          'SELECT MAX(sequence) AS value FROM principal_workspace_tickets WHERE group_id = ?',
        ).get(identity.groupId) as { value: number | null };
        const maxSequence = maxHit.value === null ? 0 : Number(maxHit.value);
        let sequence: number;
        let nextCounter: PrincipalWorkspaceTicketSequence;
        if (counterRow) {
          const counter = parseWorkspaceTicketSequenceSidecar(counterRow);
          if (!counter.ok || counter.value.groupId !== identity.groupId
              || counter.value.lastSequence < maxSequence) {
            persistPrincipalWorkspaceTicketAudit(store, {
              ...identity, event: 'counter_corruption',
              detail: { error: counter.ok ? 'counter_range_mismatch' : counter.error, maxSequence },
            });
            quarantinePrincipalWorkspaceGroup(store, identity.groupId);
            result = { status: 'quarantined', target: 'group', reason: 'counter_corruption' };
          } else if (counter.value.lastSequence === Number.MAX_SAFE_INTEGER) {
            result = { status: 'busy', reason: 'sequence_exhausted' };
          } else if (counter.value.revision === Number.MAX_SAFE_INTEGER) {
            result = { status: 'busy', reason: 'counter_revision_exhausted' };
          } else {
            sequence = counter.value.lastSequence + 1;
            nextCounter = {
              ...counter.value, lastSequence: sequence,
              revision: counter.value.revision + 1, updatedAt: now,
            };
            db.exec('SAVEPOINT enqueue_ticket');
            try {
              const updated = store.db.prepare(
                'UPDATE principal_workspace_ticket_sequences SET last_sequence = ?, revision = ?, '
                + 'updated_at = ?, row = ? WHERE group_id = ? AND last_sequence = ? '
                + 'AND revision = ? AND row = ?',
              ).run(
                nextCounter.lastSequence, nextCounter.revision, nextCounter.updatedAt,
                JSON.stringify(nextCounter), identity.groupId, counter.value.lastSequence,
                counter.value.revision, counterRow.row,
              );
              if (Number(updated.changes) !== 1) throw new PrincipalLaneAuthorityChangedError();
              result = insertPrincipalWorkspaceTicket(store, identity, validated.value.source, sequence, now);
              db.exec('RELEASE enqueue_ticket');
            } catch (error) {
              db.exec('ROLLBACK TO enqueue_ticket');
              db.exec('RELEASE enqueue_ticket');
              if (error instanceof PrincipalLaneAuthorityChangedError) {
                result = { status: 'retry', reason: 'stale_authority' };
              } else {
                const loser = readWorkspaceTicketByTurn(
                  store, identity.sourceSessionId, identity.laneId, identity.sessionId,
                  identity.turnId,
                ) ?? readWorkspaceTicketByRecord(store, locator)
                  ?? readWorkspaceTicketById(store, identity.ticketId);
                if (!loser) throw error;
                result = ticketConflictOrCorruption(store, loser, identity);
              }
            }
          }
        } else if (maxSequence !== 0) {
          persistPrincipalWorkspaceTicketAudit(store, {
            ...identity, event: 'counter_corruption', detail: { error: 'missing_counter', maxSequence },
          });
          quarantinePrincipalWorkspaceGroup(store, identity.groupId);
          result = { status: 'quarantined', target: 'group', reason: 'counter_corruption' };
        } else {
          sequence = 1;
          nextCounter = {
            version: 1, groupId: identity.groupId, lastSequence: sequence,
            revision: 1, createdAt: now, updatedAt: now,
          };
          db.exec('SAVEPOINT enqueue_ticket');
          try {
            store.db.prepare(
              'INSERT INTO principal_workspace_ticket_sequences '
              + '(group_id, last_sequence, revision, created_at, updated_at, row) '
              + 'VALUES (?, ?, ?, ?, ?, ?)',
            ).run(
              identity.groupId, sequence, 1, now, now, JSON.stringify(nextCounter),
            );
            result = insertPrincipalWorkspaceTicket(store, identity, validated.value.source, sequence, now);
            db.exec('RELEASE enqueue_ticket');
          } catch (error) {
            db.exec('ROLLBACK TO enqueue_ticket');
            db.exec('RELEASE enqueue_ticket');
            const loser = readWorkspaceTicketByTurn(
              store, identity.sourceSessionId, identity.laneId, identity.sessionId,
              identity.turnId,
            ) ?? readWorkspaceTicketByRecord(store, locator)
              ?? readWorkspaceTicketById(store, identity.ticketId);
            if (!loser) throw error;
            result = ticketConflictOrCorruption(store, loser, identity);
          }
        }
      }
    }
    let commitAttempted = false;
    try {
      testOnlyBeforePrincipalWorkspaceEnqueueCommit?.();
      commitAttempted = true;
      db.exec('COMMIT');
      transactionOpen = false;
      testOnlyAfterPrincipalWorkspaceEnqueueCommit?.();
      return result!;
    } catch {
      if (!commitAttempted) {
        let rollbackConfirmed = false;
        if (transactionOpen) {
          try {
            db.exec('ROLLBACK');
            rollbackConfirmed = true;
          } catch { /* outcome remains unknown */ }
        }
        transactionOpen = false;
        try { db.close(); } catch { /* already closed */ }
        return rollbackConfirmed
          ? { status: 'retry', reason: 'enqueue_not_committed' }
          : { status: 'unknown', reason: 'enqueue_unknown' };
      }
      transactionOpen = false;
      try { db.close(); } catch { /* already closed */ }
      try {
        return recoverPrincipalWorkspaceEnqueueOutcome({
          path, ...identity, counterBeforeCommit,
        });
      }
      catch { return { status: 'unknown', reason: 'enqueue_unknown' }; }
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
        transactionOpen = false;
        return { status: 'retry', reason: 'enqueue_not_committed' };
      } catch {
        transactionOpen = false;
        return { status: 'unknown', reason: 'enqueue_unknown' };
      }
    }
    if (isTransientStoreContentionError(error)) return { status: 'retry', reason: 'store_busy' };
    throw error;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Correlate immutable record files with durable tickets for one verified lane.
 * This is a read-only report: it never signs a capability, repairs a ticket,
 * deletes staging, or backfills an orphan record. */
export function inventoryPrincipalWorkspaceTickets(args: {
  handle: PrincipalLaneQueueHandle;
  authority: PrincipalLaneDispatchAuthority;
  expected: ExpectedPrincipalWorkspaceTicketAuthority;
}): PrincipalWorkspaceTicketInventoryResult {
  const files = inventoryPrincipalLaneQueueRecords(args.handle, args.authority);
  if (files.status !== 'ready') {
    if (files.status === 'retry') return { status: 'retry', reason: files.reason };
    if (files.status === 'quarantined') return { status: 'quarantined', reason: files.reason };
    return { status: 'invalid', reason: files.reason };
  }
  if (!currentAppId) return { status: 'retry', reason: 'store_not_attached' };
  const path = getDbPath();
  if (!existsSync(path)) return { status: 'retry', reason: 'store_missing' };
  const db = openDbForRead(path);
  const store = principalWorkspaceStoreView(db);
  let open = false;
  try {
    db.exec('BEGIN');
    open = true;
    const sourceSessionId = args.authority.source.sourceSessionId;
    const sourceSessionHit = store.selectRow.get(sourceSessionId) as { row: string } | undefined;
    if (!sourceSessionHit) return { status: 'retry', reason: 'stale_authority' };
    let sourceSession: Session;
    try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
    catch { return { status: 'quarantined', reason: 'invalid_source_session_json' }; }
    if (sourceSession.status !== 'active') {
      return { status: 'busy', reason: 'source_not_active' };
    }
    const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId);
    if (!displayTarget) return { status: 'quarantined', reason: 'invalid_source_display_target' };
    const sourceHit = store.db.prepare(
      'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
      + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
    ).get(sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
    const source = parseSourceSidecar(sourceHit, displayTarget, sourceSessionId);
    if (!source.ok) return source.error === 'missing_sidecar'
      ? { status: 'retry', reason: 'stale_authority' }
      : { status: 'quarantined', reason: `source:${source.error}` };
    const sourceLaneHit = store.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
    ).get(sourceSessionId) as PrincipalLaneSidecarRow | undefined;
    const sourceLane = parseLaneSidecar(sourceLaneHit, { displayTarget, sourceSessionId });
    if (!sourceLane.ok) return sourceLane.error === 'missing_sidecar'
      ? { status: 'retry', reason: 'stale_authority' }
      : { status: 'quarantined', reason: `lane:${sourceLane.error}` };
    if (!principalLaneSourcesEqual(source.value, args.authority.source.source)
        || !principalLaneBindingsEqual(sourceLane.value.binding, args.authority.source.lane)) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    if (source.value.phase !== 'active') return { status: 'busy', reason: 'source_not_active' };
    const embeddedSource = sourceSession.principalLaneSource
      ? parsePrincipalLaneSourceState(sourceSession.principalLaneSource, displayTarget, sourceSessionId)
      : { ok: false as const, error: 'not_object' };
    if (!embeddedSource.ok || !principalLaneSourcesEqual(embeddedSource.value, source.value)) {
      return { status: 'quarantined', reason: 'source_session_mismatch' };
    }
    const lanes = validatePrincipalWorkspaceLanes(
      store, sourceSessionId, source.value, displayTarget, sourceSession, sourceSessionHit.row,
    );
    if (!lanes.ok) return lanes.kind === 'quarantined'
      ? { status: 'quarantined', reason: lanes.reason }
      : lanes.kind === 'missing'
        ? { status: 'retry', reason: 'stale_authority' }
        : { status: 'busy', reason: 'lane_not_active' };
    const target = lanes.lanes.find(value => value.lane.binding.laneId === args.authority.lane.lane.laneId);
    if (!target
        || !principalLaneBindingsEqual(target.lane.binding, args.authority.lane.lane)
        || target.lane.sessionId !== args.authority.lane.sessionId
        || args.authority.session.sessionId !== target.lane.sessionId) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    if (target.lane.binding.phase !== 'active' && target.lane.binding.phase !== 'dormant') {
      return { status: 'busy', reason: 'lane_not_active' };
    }
    const group = parseWorkspaceGroupSidecar(
      readWorkspaceGroupRow(store, source.value.workspaceGroupId),
    );
    if (!group.ok) return group.error === 'missing_group'
      ? { status: 'retry', reason: 'stale_authority' }
      : { status: 'quarantined', reason: `group:${group.error}` };
    if (group.value.revision !== args.expected.groupRevision
        || group.value.groupId !== source.value.workspaceGroupId
        || group.value.larkAppId !== currentAppId
        || group.value.canonicalCwd !== source.value.canonicalCwd
        || group.value.phase !== 'active') {
      return group.value.phase === 'active'
        ? { status: 'retry', reason: 'stale_authority' }
        : { status: 'busy', reason: 'workspace_group_not_active' };
    }
    const member = parseWorkspaceMemberSidecar(
      readWorkspaceMemberRow(store, sourceSessionId, target.lane.binding.laneId),
    );
    if (!member.ok) return member.error === 'missing_member'
      ? { status: 'retry', reason: 'stale_authority' }
      : { status: 'quarantined', reason: `member:${member.error}` };
    if (member.value.revision !== args.expected.memberRevision
        || !principalWorkspaceMemberIdentityMatchesLane(member.value, target.lane, source.value)) {
      return { status: 'retry', reason: 'stale_authority' };
    }
    if (member.value.membershipPhase !== 'active') {
      return { status: 'busy', reason: 'workspace_member_not_active' };
    }
    const rows = store.db.prepare(
      `SELECT ${PRINCIPAL_WORKSPACE_TICKET_COLUMNS} FROM principal_workspace_tickets `
      + 'WHERE source_session_id = ? AND lane_id = ? AND session_id = ? ORDER BY sequence',
    ).all(
      sourceSessionId, target.lane.binding.laneId, target.lane.sessionId,
    ) as PrincipalWorkspaceTicketRow[];
    const tickets: PrincipalWorkspaceTicket[] = [];
    const conflicts: Extract<PrincipalWorkspaceTicketInventoryResult, { status: 'ready' }>['conflicts'] = [];
    const unknown: Extract<PrincipalWorkspaceTicketInventoryResult, { status: 'ready' }>['unknown'] = [];
    const referencedRecordIds = new Set<string>();
    for (const row of rows) {
      const parsed = parseWorkspaceTicketSidecar(row);
      if (!parsed.ok) {
        if (row.namespace_version === files.value.namespaceVersion
            && row.namespace === files.value.namespace) {
          referencedRecordIds.add(row.record_id);
        }
        unknown.push({
          ticketId: row.ticket_id,
          recordId: row.record_id,
          sequence: Number.isSafeInteger(row.sequence) && row.sequence >= 1
            ? row.sequence : undefined,
          reason: 'ticket_row_unverified',
        });
        continue;
      }
      tickets.push(parsed.value);
    }
    const counterRow = store.db.prepare(
      'SELECT group_id, last_sequence, revision, created_at, updated_at, row '
      + 'FROM principal_workspace_ticket_sequences WHERE group_id = ?',
    ).get(source.value.workspaceGroupId) as PrincipalWorkspaceTicketSequenceRow | undefined;
    const counter = parseWorkspaceTicketSequenceSidecar(counterRow);
    const groupMaxHit = store.db.prepare(
      'SELECT MAX(sequence) AS value FROM principal_workspace_tickets WHERE group_id = ?',
    ).get(source.value.workspaceGroupId) as { value: number | null };
    const maxTicketSequence = groupMaxHit.value === null ? 0 : Number(groupMaxHit.value);
    const counterVerified = counter.ok
      && counter.value.groupId === source.value.workspaceGroupId
      && counter.value.lastSequence >= maxTicketSequence;
    const filesByRecord = new Map(files.value.records.map(record => [record.recordId, record]));
    const ticketed: Array<{ recordId: string; ticketId: string; sequence: number }> = [];
    for (const ticket of tickets) {
      const belongsToInventoryNamespace = ticket.locator.namespaceVersion === files.value.namespaceVersion
        && ticket.locator.namespace === files.value.namespace;
      if (belongsToInventoryNamespace) referencedRecordIds.add(ticket.locator.recordId);
      if (ticket.groupId !== source.value.workspaceGroupId
          || ticket.sourceSessionId !== sourceSessionId
          || ticket.laneId !== target.lane.binding.laneId
          || ticket.sessionId !== target.lane.sessionId
          || ticket.workspaceEpoch !== source.value.workspaceEpoch) {
        conflicts.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'ticket_authority_mismatch',
        });
        continue;
      }
      if (!belongsToInventoryNamespace) {
        conflicts.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'ticket_namespace_mismatch',
        });
        continue;
      }
      if (!ticketAuditMatchesTicket(readEnqueuedTicketAudit(store, ticket.ticketId), ticket)) {
        unknown.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'ticket_audit_unverified',
        });
        continue;
      }
      if (!counterVerified) {
        unknown.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'ticket_counter_unverified',
        });
        continue;
      }
      const record = filesByRecord.get(ticket.locator.recordId);
      if (!record) {
        unknown.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'record_missing',
        });
      } else if (record.exactFileLength !== ticket.locator.exactFileLength) {
        conflicts.push({
          recordId: ticket.locator.recordId,
          ticketId: ticket.ticketId,
          sequence: ticket.sequence,
          reason: 'record_length_mismatch',
          expectedExactFileLength: ticket.locator.exactFileLength,
          observedExactFileLength: record.exactFileLength,
        });
      } else {
        ticketed.push({
          recordId: ticket.locator.recordId, ticketId: ticket.ticketId, sequence: ticket.sequence,
        });
      }
    }
    const orphanRecords = files.value.records.filter(record => !referencedRecordIds.has(record.recordId));
    db.exec('COMMIT');
    open = false;
    return {
      status: 'ready', namespaceVersion: files.value.namespaceVersion,
      namespace: files.value.namespace, ticketed, orphanRecords,
      conflicts, unknown, staging: files.value.staging,
    };
  } finally {
    if (open) try { db.exec('ROLLBACK'); } catch { /* already ended */ }
    try { db.close(); } catch { /* already closed */ }
  }
}

function insertPrincipalWorkspaceTicket(
  store: OwnSqliteStore,
  identity: {
    ticketId: string;
    groupId: string;
    sourceSessionId: string;
    laneId: string;
    sessionId: string;
    turnId: string;
    locator: PrincipalWorkspaceTicketLocator;
  },
  source: PrincipalLaneSourceState,
  sequence: number,
  now: string,
): EnqueuePrincipalWorkspaceTicketResult {
  const ticket: PrincipalWorkspaceTicket = {
    version: 1, ticketId: identity.ticketId, groupId: identity.groupId, sequence,
    sourceSessionId: identity.sourceSessionId, laneId: identity.laneId,
    sessionId: identity.sessionId, workspaceEpoch: source.workspaceEpoch,
    turnId: identity.turnId, status: 'queued', revision: 1,
    locator: identity.locator, createdAt: now, updatedAt: now,
  };
  store.db.prepare(
    'INSERT INTO principal_workspace_tickets '
    + '(ticket_id, group_id, sequence, source_session_id, lane_id, session_id, '
    + 'workspace_epoch, turn_id, status, revision, namespace_version, namespace, '
    + 'record_version, record_id, payload_encoding, payload_hash, exact_file_length, '
    + 'created_at, updated_at, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    ticket.ticketId, ticket.groupId, ticket.sequence, ticket.sourceSessionId, ticket.laneId,
    ticket.sessionId, ticket.workspaceEpoch, ticket.turnId, ticket.status, ticket.revision,
    ticket.locator.namespaceVersion, ticket.locator.namespace, ticket.locator.recordVersion,
    ticket.locator.recordId, ticket.locator.payloadEncoding, ticket.locator.payloadHash,
    ticket.locator.exactFileLength, ticket.createdAt, ticket.updatedAt, JSON.stringify(ticket),
  );
  persistPrincipalWorkspaceTicketAudit(store, {
    event: 'enqueued', groupId: ticket.groupId, ticketId: ticket.ticketId,
    sourceSessionId: ticket.sourceSessionId, laneId: ticket.laneId,
    sessionId: ticket.sessionId, turnId: ticket.turnId,
    detail: { version: 1, ticket }, now,
  });
  if (!ticketAuditMatchesTicket(readEnqueuedTicketAudit(store, ticket.ticketId), ticket)) {
    throw new Error('principal workspace enqueued audit did not round-trip');
  }
  return { status: 'ready', created: true, ticket };
}

class PrincipalLaneAuthorityChangedError extends Error {}

type ResolvedHumanLaneEvidence = {
  canonicalPrincipal: HumanLanePrincipal;
  canonicalKey: string;
  aliasKeys: string[];
  unionId?: string;
  openId?: string;
};

function resolveHumanLaneEvidence(
  evidence: HumanLaneIdentityEvidence,
  expectedLarkAppId: string,
): ResolvedHumanLaneEvidence | undefined {
  if (evidence.larkAppId !== expectedLarkAppId) return undefined;
  const unionId = evidence.unionId?.trim() || undefined;
  const openId = evidence.openId?.trim() || undefined;
  if (!unionId && !openId) return undefined;
  const canonicalPrincipal: HumanLanePrincipal = unionId
    ? { senderType: 'user', kind: 'union', unionId }
    : { senderType: 'user', kind: 'app_open', larkAppId: expectedLarkAppId, openId: openId! };
  const canonicalKey = lanePrincipalKey(canonicalPrincipal);
  const aliasKeys = [canonicalKey];
  if (openId) {
    const openKey = lanePrincipalKey({
      senderType: 'user', kind: 'app_open', larkAppId: expectedLarkAppId, openId,
    });
    if (openKey !== canonicalKey) aliasKeys.push(openKey);
  }
  return { canonicalPrincipal, canonicalKey, aliasKeys, unionId, openId };
}

function samePrincipalDisplayTarget(
  left: PrincipalLaneDisplayTarget,
  right: PrincipalLaneDisplayTarget,
): boolean {
  return left.scope === right.scope
    && left.larkAppId === right.larkAppId
    && left.chatId === right.chatId
    && (left.scope !== 'thread'
      || (right.scope === 'thread' && left.rootMessageId === right.rootMessageId));
}

function shadowRoutingAnchor(sourceSessionId: string, laneId: string): string {
  return `principal-lane:${createHash('sha256')
    .update(`${sourceSessionId}\0${laneId}`)
    .digest('hex').slice(0, 32)}`;
}

const PRINCIPAL_LANE_RUNTIME_KEYS = [
  'cliId', 'cliLaunchSnapshot', 'cliInstanceBinding', 'cliRuntime', 'cliPathOverride',
  'wrapperCli', 'agentFrozen', 'model', 'reasoningEffort', 'modelBackendVariant',
  'backendType', 'mojoIdentity', 'mojoIdentityHostDefault',
  'sandbox', 'sandboxPaths', 'sandboxHidePaths',
  'sandboxReadonlyPaths', 'sandboxNetwork',
] as const satisfies readonly (keyof Session)[];

function copyPrincipalLaneRuntimeConfig(source: Session, target: Session): void {
  const sourceRecord = source as unknown as Record<string, unknown>;
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of PRINCIPAL_LANE_RUNTIME_KEYS) {
    if (sourceRecord[key] !== undefined) targetRecord[key] = structuredClone(sourceRecord[key]);
  }
}

function buildShadowPrincipalSession(args: {
  source: Session;
  sourceState: PrincipalLaneSourceState;
  displayTarget: PrincipalLaneDisplayTarget;
  evidence: ResolvedHumanLaneEvidence;
  lane: PrincipalLaneBinding;
  title: string;
  now: string;
}): Session {
  const session: Session = {
    sessionId: randomUUID(),
    chatId: args.displayTarget.chatId,
    chatType: args.source.chatType,
    rootMessageId: args.displayTarget.scope === 'thread'
      ? args.displayTarget.rootMessageId
      : args.source.rootMessageId,
    scope: args.displayTarget.scope,
    title: args.title,
    nativeSessionTitle: args.title,
    nativeSessionTitleUserDefined: false,
    status: 'active',
    createdAt: args.now,
    creationSource: 'fork',
    larkAppId: args.displayTarget.larkAppId,
    workingDir: args.sourceState.canonicalCwd,
    ownerUnionId: args.evidence.unionId,
    ownerOpenId: args.evidence.openId,
    creatorOpenId: args.evidence.openId,
    lastCallerOpenId: args.evidence.openId,
    principalLane: args.lane,
  };
  copyPrincipalLaneRuntimeConfig(args.source, session);
  return session;
}

function buildPrincipalLaneWorktreeProof(args: {
  materialization: PrincipalLaneWorktreeMaterialization;
  lane: PrincipalLaneBinding;
  sessionId: string;
  now: string;
}): PrincipalLaneWorktreeProof {
  return {
    version: 1,
    materializationId: args.materialization.materializationId,
    sourceSessionId: args.lane.sourceSessionId,
    laneId: args.lane.laneId,
    sessionId: args.sessionId,
    principalKey: args.lane.principalKey,
    workspaceEpoch: args.lane.workspaceEpoch,
    sourceCanonicalCwd: args.materialization.sourceCanonicalCwd,
    sourceRepoRoot: args.materialization.sourceRepoRoot,
    sourceGitCommonDir: args.materialization.sourceGitCommonDir,
    sourceRelativeCwd: args.materialization.sourceRelativeCwd,
    worktreeRoot: args.materialization.worktreeRoot,
    worktreeGitCommonDir: args.materialization.worktreeGitCommonDir,
    workingDir: args.materialization.workingDir,
    branch: args.materialization.branch,
    baseRef: args.materialization.baseRef,
    phase: 'ready',
    revision: 1,
    createdAt: args.materialization.createdAt,
    updatedAt: args.now,
  };
}

function materializationMatchesSource(
  materialization: PrincipalLaneWorktreeMaterialization,
  sourceSessionId: string,
  source: PrincipalLaneSourceState,
  principalKey: string,
): boolean {
  return materialization.version === 1
    && materialization.materializationId === principalLaneWorktreeMaterializationId({
      sourceSessionId,
      principalKey,
      workspaceEpoch: source.workspaceEpoch,
      sourceCanonicalCwd: source.canonicalCwd,
    })
    && materialization.sourceSessionId === sourceSessionId
    && materialization.principalKey === principalKey
    && materialization.workspaceEpoch === source.workspaceEpoch
    && materialization.sourceCanonicalCwd === source.canonicalCwd
    && canonicalIso(materialization.createdAt)
    && typeof materialization.branch === 'string'
    && materialization.branch.length > 0
    && typeof materialization.baseRef === 'string'
    && materialization.baseRef.length > 0
    && typeof materialization.sourceRelativeCwd === 'string'
    && !isAbsolute(materialization.sourceRelativeCwd)
    && materialization.sourceRelativeCwd !== '..'
    && !materialization.sourceRelativeCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && isAbsolute(materialization.sourceRepoRoot)
    && isAbsolute(materialization.sourceGitCommonDir)
    && isAbsolute(materialization.worktreeRoot)
    && isAbsolute(materialization.worktreeGitCommonDir)
    && isAbsolute(materialization.workingDir)
    && materialization.sourceRepoRoot !== materialization.worktreeRoot
    && materialization.sourceGitCommonDir === materialization.worktreeGitCommonDir
    && materialization.sourceCanonicalCwd !== materialization.workingDir
    && resolve(materialization.sourceRepoRoot, materialization.sourceRelativeCwd)
      === materialization.sourceCanonicalCwd
    && resolve(materialization.worktreeRoot, materialization.sourceRelativeCwd)
      === materialization.workingDir;
}

function insertPrincipalLaneWorktreeProof(
  store: OwnSqliteStore,
  proof: PrincipalLaneWorktreeProof,
): void {
  store.db.prepare(
    'INSERT INTO principal_lane_worktrees '
    + '(materialization_id, source_session_id, lane_id, session_id, principal_key, '
    + 'workspace_epoch, source_repo_root, source_git_common_dir, worktree_root, '
    + 'worktree_git_common_dir, working_dir, branch, phase, revision, row) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    proof.materializationId, proof.sourceSessionId, proof.laneId, proof.sessionId,
    proof.principalKey, proof.workspaceEpoch, proof.sourceRepoRoot, proof.sourceGitCommonDir,
    proof.worktreeRoot, proof.worktreeGitCommonDir, proof.workingDir, proof.branch,
    proof.phase, proof.revision, JSON.stringify(proof),
  );
}

function proofMatchesMaterialization(
  proof: PrincipalLaneWorktreeProof,
  materialization: PrincipalLaneWorktreeMaterialization,
): boolean {
  return proof.materializationId === materialization.materializationId
    && proof.sourceSessionId === materialization.sourceSessionId
    && proof.principalKey === materialization.principalKey
    && proof.workspaceEpoch === materialization.workspaceEpoch
    && proof.sourceCanonicalCwd === materialization.sourceCanonicalCwd
    && proof.sourceRepoRoot === materialization.sourceRepoRoot
    && proof.sourceGitCommonDir === materialization.sourceGitCommonDir
    && proof.sourceRelativeCwd === materialization.sourceRelativeCwd
    && proof.worktreeRoot === materialization.worktreeRoot
    && proof.worktreeGitCommonDir === materialization.worktreeGitCommonDir
    && proof.workingDir === materialization.workingDir
    && proof.branch === materialization.branch;
}

async function recoverPrincipalLaneWorktreePublication(
  materialization: PrincipalLaneWorktreeMaterialization,
): Promise<EnsureShadowPrincipalLaneResult> {
  let db: SqliteDatabaseLike;
  try { db = openDbForRead(getDbPath()); }
  catch { return { status: 'unknown', reason: 'worktree_publication_unknown' }; }
  try {
    db.exec('BEGIN');
    const proofHit = db.prepare(
      'SELECT materialization_id, source_session_id, lane_id, session_id, principal_key, '
      + 'workspace_epoch, source_repo_root, source_git_common_dir, worktree_root, '
      + 'worktree_git_common_dir, working_dir, branch, phase, revision, row '
      + 'FROM principal_lane_worktrees WHERE materialization_id = ?',
    ).get(materialization.materializationId) as PrincipalLaneWorktreeSidecarRow | undefined;
    if (!proofHit) {
      const laneHit = db.prepare(
        'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, phase, revision, row '
        + 'FROM principal_lanes WHERE source_session_id = ? AND principal_key = ?',
      ).get(
        materialization.sourceSessionId, materialization.principalKey,
      ) as PrincipalLaneSidecarRow | undefined;
      if (!laneHit) {
        const identityTrace = db.prepare(
          'SELECT 1 AS hit FROM principal_lane_aliases '
          + 'WHERE source_session_id = ? AND (alias_key = ? OR canonical_principal_key = ?) LIMIT 1',
        ).get(
          materialization.sourceSessionId, materialization.principalKey,
          materialization.principalKey,
        ) as { hit: number } | undefined;
        db.exec('COMMIT');
        return identityTrace
          ? { status: 'unknown', reason: 'worktree_publication_unknown' }
          : { status: 'retry', reason: 'worktree_not_committed' };
      }
      const legacy = currentAppId
        ? readPrincipalLaneHydrationSnapshot(
          { db }, currentAppId, materialization.sourceSessionId, laneHit.lane_id,
        )
        : { status: 'quarantined' as const, reason: 'missing_app_identity' };
      db.exec('COMMIT');
      return legacy.status === 'retry' && legacy.reason === 'worktree_not_materialized'
        ? { status: 'retry', reason: 'worktree_not_committed' }
        : { status: 'unknown', reason: 'worktree_publication_unknown' };
    }
    const parsedProof = parseWorktreeSidecar(proofHit, {
      sourceSessionId: proofHit.source_session_id,
      laneId: proofHit.lane_id,
      sessionId: proofHit.session_id,
      principalKey: proofHit.principal_key,
      workspaceEpoch: Number(proofHit.workspace_epoch),
    });
    if (!parsedProof.ok || !proofMatchesMaterialization(parsedProof.value, materialization)) {
      db.exec('COMMIT');
      return { status: 'unknown', reason: 'worktree_publication_unknown' };
    }
    db.exec('COMMIT');
    const hydrated = currentAppId
      ? await readPrincipalLaneHydrationWithGitFence(
        { db }, currentAppId, materialization.sourceSessionId, parsedProof.value.laneId,
      )
      : { status: 'quarantined' as const, reason: 'missing_app_identity' };
    if (hydrated.status !== 'ready' || !hydrated.worktree
        || !proofMatchesMaterialization(hydrated.worktree, materialization)
        || hydrated.lane.laneId !== parsedProof.value.laneId
        || hydrated.lane.principalKey !== parsedProof.value.principalKey
        || hydrated.lane.workspaceEpoch !== parsedProof.value.workspaceEpoch
        || hydrated.session.sessionId !== parsedProof.value.sessionId
        || JSON.stringify(hydrated.worktree) !== JSON.stringify(parsedProof.value)) {
      return { status: 'unknown', reason: 'worktree_publication_unknown' };
    }
    return {
      status: 'ready',
      created: false,
      lane: hydrated.lane,
      session: hydrated.session,
      worktree: hydrated.worktree,
    };
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* read transaction already gone */ }
    return { status: 'unknown', reason: 'worktree_publication_unknown' };
  } finally {
    db.close();
  }
}

function runPrincipalLaneWorktreePublicationTransaction(
  store: OwnSqliteStore,
  materialization: PrincipalLaneWorktreeMaterialization,
  operation: () => EnsureShadowPrincipalLaneResult,
): EnsureShadowPrincipalLaneResult {
  let began = false;
  let commitAttempted = false;
  try {
    store.db.exec('BEGIN IMMEDIATE');
    began = true;
    const result = operation();
    testOnlyBeforePrincipalLaneWorktreeCommit?.();
    commitAttempted = true;
    store.db.exec('COMMIT');
    began = false;
    testOnlyAfterPrincipalLaneWorktreeCommit?.();
    return result;
  } catch (error) {
    if (!commitAttempted) {
      if (!began) {
        return isTransientStoreContentionError(error)
          ? { status: 'retry', reason: 'store_busy' }
          : { status: 'retry', reason: 'worktree_not_committed' };
      }
      try {
        store.db.exec('ROLLBACK');
        began = false;
        return { status: 'retry', reason: 'worktree_not_committed' };
      } catch {
        return { status: 'unknown', reason: 'worktree_publication_unknown' };
      }
    }
    return { status: 'unknown', reason: 'worktree_publication_unknown' };
  }
}

function principalLaneBindingsEqual(left: PrincipalLaneBinding, right: PrincipalLaneBinding): boolean {
  return left.laneId === right.laneId
    && left.sourceSessionId === right.sourceSessionId
    && left.principalKey === right.principalKey
    && left.routingAnchor === right.routingAnchor
    && left.workspaceEpoch === right.workspaceEpoch
    && left.phase === right.phase
    && left.revision === right.revision
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.quarantineReason === right.quarantineReason
    && samePrincipalDisplayTarget(left.displayTarget, right.displayTarget);
}

function principalLaneSourcesEqual(
  left: PrincipalLaneSourceState,
  right: PrincipalLaneSourceState,
): boolean {
  return left.version === right.version
    && left.sourcePrincipalKey === right.sourcePrincipalKey
    && samePrincipalDisplayTarget(left.displayTarget, right.displayTarget)
    && left.canonicalCwd === right.canonicalCwd
    && left.workspaceEpoch === right.workspaceEpoch
    && left.workspaceGroupId === right.workspaceGroupId
    && left.workspaceGroupKeyVersion === right.workspaceGroupKeyVersion
    && left.phase === right.phase
    && left.revision === right.revision
    && left.updatedAt === right.updatedAt
    && left.leaseOwner === right.leaseOwner
    && left.leaseGeneration === right.leaseGeneration
    && left.principalLaneDisabledReason === right.principalLaneDisabledReason
    && JSON.stringify(left.migrationAudit) === JSON.stringify(right.migrationAudit);
}

function upsertPrincipalLaneAlias(
  store: OwnSqliteStore,
  sourceSessionId: string,
  aliasKey: string,
  laneId: string,
  canonicalPrincipalKey: string,
  now: string,
): void {
  store.db.prepare(
    'INSERT INTO principal_lane_aliases '
    + '(source_session_id, alias_key, lane_id, canonical_principal_key, created_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(source_session_id, alias_key) DO UPDATE SET '
    + 'lane_id = excluded.lane_id, canonical_principal_key = excluded.canonical_principal_key, '
    + 'updated_at = excluded.updated_at',
  ).run(sourceSessionId, aliasKey, laneId, canonicalPrincipalKey, now, now);
}

function persistPrincipalLaneIdentityConflict(
  store: OwnSqliteStore,
  args: {
    sourceSessionId: string;
    leftAliasKey: string;
    rightAliasKey: string;
    leftLaneId: string;
    rightLaneId: string;
    now: string;
  },
): void {
  const ordered = [
    { aliasKey: args.leftAliasKey, laneId: args.leftLaneId },
    { aliasKey: args.rightAliasKey, laneId: args.rightLaneId },
  ].sort((left, right) => left.aliasKey.localeCompare(right.aliasKey)
    || left.laneId.localeCompare(right.laneId));
  const inserted = store.db.prepare(
    'INSERT OR IGNORE INTO principal_lane_identity_conflicts '
    + '(conflict_id, source_session_id, left_alias_key, right_alias_key, '
    + 'left_lane_id, right_lane_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(), args.sourceSessionId, ordered[0]!.aliasKey, ordered[1]!.aliasKey,
    ordered[0]!.laneId, ordered[1]!.laneId, args.now,
  );
  if (Number(inserted.changes) === 0) return;
  store.db.prepare(
    'INSERT INTO principal_lane_identity_audit '
    + '(audit_id, source_session_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), args.sourceSessionId, 'conflict', JSON.stringify({
    leftAlias: ordered[0]!.aliasKey,
    rightAlias: ordered[1]!.aliasKey,
    leftLaneId: ordered[0]!.laneId,
    rightLaneId: ordered[1]!.laneId,
  }), args.now);
}

/** Atomically reuses, upgrades, or creates one human principal lane. It does
 * not publish a runtime DaemonSession and never feeds routingAnchor to Lark. */
export function ensureShadowPrincipalLane(args: {
  sourceSessionId: string;
  identity: HumanLaneIdentityEvidence;
  title?: string;
  now?: string;
  expectedSource?: ExpectedPrincipalLaneSourceAuthority;
  /** D-live publication path. When present, lane/session/proof commit atomically;
   * callers must not register the returned session unless status is ready. */
  worktree?: PrincipalLaneWorktreeMaterialization;
}): EnsureShadowPrincipalLaneResult {
  loadForWrite();
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const evidence = resolveHumanLaneEvidence(args.identity, currentAppId);
  if (!evidence) throw new Error('invalid human lane identity evidence');
  const now = args.now ?? new Date().toISOString();
  if (!canonicalIso(now)) throw new Error('invalid principal-lane creation timestamp');

  const snapshot = readPrincipalLaneSource(args.sourceSessionId);
  if (!snapshot || snapshot.status === 'disabled') {
    return { status: 'retry', reason: 'source_not_active' };
  }
  if (snapshot.status === 'retry') return { status: 'retry', reason: 'source_authority_changed' };
  if (snapshot.status === 'quarantined') return snapshot;
  if (snapshot.source.phase !== 'active') return { status: 'retry', reason: 'source_not_active' };

  testOnlyBeforePrincipalLaneCreateTransaction?.();

  let result: EnsureShadowPrincipalLaneResult;
  try {
    const operation = (): EnsureShadowPrincipalLaneResult => {
    const sourceSessionHit = store.selectRow.get(args.sourceSessionId) as { row: string } | undefined;
    if (!sourceSessionHit) return { status: 'retry', reason: 'source_authority_changed' };
    let sourceSession: Session;
    try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
    catch {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'invalid_source_session_json' };
    }
    if (sourceSession.status !== 'active') return { status: 'retry', reason: 'source_not_active' };
    const displayTarget = sourceSessionDisplayTarget(sourceSession, currentAppId!);
    if (!displayTarget) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'invalid_source_display_target' };
    }

    const sourceHit = store.db.prepare(
      'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
      + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
    ).get(args.sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
    const sourceLaneHit = store.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
    ).get(args.sourceSessionId) as PrincipalLaneSidecarRow | undefined;
    const sourceState = parseSourceSidecar(sourceHit, displayTarget, args.sourceSessionId);
    const sourceLane = parseLaneSidecar(sourceLaneHit, {
      displayTarget, sourceSessionId: args.sourceSessionId,
    });
    if (!sourceState.ok) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      return { status: 'quarantined', reason: `source:${sourceState.error}` };
    }
    if (!sourceLane.ok || sourceLane.value.binding.laneId !== 'source'
        || sourceLane.value.sessionId !== args.sourceSessionId
        || sourceLane.value.binding.principalKey !== sourceState.value.sourcePrincipalKey
        || sourceLane.value.binding.workspaceEpoch !== sourceState.value.workspaceEpoch) {
      quarantinePrincipalLane(store, args.sourceSessionId);
      return { status: 'quarantined', reason: !sourceLane.ok
        ? `lane:${sourceLane.error}` : 'source_lane_mismatch' };
    }
    const embeddedSourceState = sourceSession.principalLaneSource
      ? parsePrincipalLaneSourceState(
        sourceSession.principalLaneSource, displayTarget, args.sourceSessionId,
      )
      : { ok: false as const, error: 'not_object' as const };
    const embeddedSourceLane = sourceSession.principalLane
      ? parsePrincipalLaneBinding(sourceSession.principalLane, {
        displayTarget,
        sourceSessionId: args.sourceSessionId,
      })
      : { ok: false as const, error: 'not_object' as const };
    if (!embeddedSourceState.ok || !embeddedSourceLane.ok
        || !principalLaneSourcesEqual(embeddedSourceState.value, sourceState.value)
        || !principalLaneBindingsEqual(embeddedSourceLane.value, sourceLane.value.binding)) {
      quarantinePrincipalLaneSource(store, args.sourceSessionId);
      quarantinePrincipalLane(store, args.sourceSessionId);
      return { status: 'quarantined', reason: 'source_session_mismatch' };
    }
    if (sourceState.value.phase !== 'active' || sourceLane.value.binding.phase !== 'active') {
      return { status: 'retry', reason: 'source_not_active' };
    }
    if (args.worktree && !materializationMatchesSource(
      args.worktree,
      args.sourceSessionId,
      sourceState.value,
      evidence.canonicalKey,
    )) {
      return { status: 'quarantined', reason: 'worktree_materialization_mismatch' };
    }
    if (!principalLaneSourcesEqual(sourceState.value, snapshot.source)
        || !principalLaneBindingsEqual(sourceLane.value.binding, snapshot.lane)
        || canonicalSessionCwd(sourceSession) !== sourceState.value.canonicalCwd) {
      return { status: 'retry', reason: 'source_authority_changed' };
    }
    const expectedSource = args.expectedSource;
    if (expectedSource
        && (sourceState.value.sourcePrincipalKey !== expectedSource.sourcePrincipalKey
          || sourceState.value.revision !== expectedSource.sourceRevision
          || sourceLane.value.binding.revision !== expectedSource.sourceLaneRevision
          || sourceState.value.workspaceEpoch !== expectedSource.workspaceEpoch
          || sourceState.value.canonicalCwd !== expectedSource.canonicalCwd
          || sourceState.value.workspaceGroupId !== expectedSource.workspaceGroupId
          || sourceState.value.workspaceGroupKeyVersion
            !== expectedSource.workspaceGroupKeyVersion
          || !samePrincipalDisplayTarget(
            sourceState.value.displayTarget,
            expectedSource.displayTarget,
          ))) {
      return { status: 'retry', reason: 'source_authority_changed' };
    }
    if (sourceState.value.workspaceGroupKeyVersion
        !== PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION) {
      return { status: 'retry', reason: 'workspace_migration_required' };
    }
    const groupHit = readWorkspaceGroupRow(store, sourceState.value.workspaceGroupId);
    const parsedGroup = parseWorkspaceGroupSidecar(groupHit);
    if (!parsedGroup.ok) {
      if (groupHit) quarantinePrincipalWorkspaceGroup(store, sourceState.value.workspaceGroupId);
      return { status: 'quarantined', reason: `group:${parsedGroup.error}` };
    }
    if (parsedGroup.value.larkAppId !== currentAppId
        || parsedGroup.value.canonicalCwd !== sourceState.value.canonicalCwd
        || parsedGroup.value.groupId !== sourceState.value.workspaceGroupId) {
      return { status: 'retry', reason: 'source_authority_changed' };
    }
    if (parsedGroup.value.phase !== 'active') {
      return { status: 'retry', reason: 'workspace_migration_busy' };
    }
    const sourceMemberHit = readWorkspaceMemberRow(store, args.sourceSessionId, 'source');
    const sourceMember = parseWorkspaceMemberSidecar(sourceMemberHit);
    if (!sourceMember.ok) {
      if (sourceMemberHit) quarantinePrincipalWorkspaceMember(store, args.sourceSessionId, 'source');
      return { status: 'quarantined', reason: `member:${sourceMember.error}` };
    }
    if (!principalWorkspaceMemberIdentityMatchesLane(
      sourceMember.value, sourceLane.value, sourceState.value,
    )) {
      quarantinePrincipalWorkspaceMember(store, args.sourceSessionId, 'source');
      return { status: 'quarantined', reason: 'member:source_membership_mismatch' };
    }
    if (sourceMember.value.membershipPhase !== 'active') {
      return { status: 'retry', reason: 'lane_not_active' };
    }

    for (const aliasKey of evidence.aliasKeys) {
      const conflict = store.db.prepare(
        'SELECT 1 AS hit FROM principal_lane_identity_conflicts '
        + 'WHERE source_session_id = ? AND (left_alias_key = ? OR right_alias_key = ?) LIMIT 1',
      ).get(args.sourceSessionId, aliasKey, aliasKey) as { hit: number } | undefined;
      if (conflict) return { status: 'identity_conflict', reason: 'identity_evidence_conflict' };
    }

    const identityMatches: Array<{
      aliasKey: string;
      laneId: string;
      via: 'alias' | 'direct';
      canonicalPrincipalKey?: string;
    }> = [];
    for (const aliasKey of evidence.aliasKeys) {
      const alias = store.db.prepare(
        'SELECT lane_id, canonical_principal_key FROM principal_lane_aliases '
        + 'WHERE source_session_id = ? AND alias_key = ?',
      ).get(args.sourceSessionId, aliasKey) as {
        lane_id: string;
        canonical_principal_key: string;
      } | undefined;
      const direct = store.db.prepare(
        'SELECT lane_id FROM principal_lanes WHERE source_session_id = ? AND principal_key = ?',
      ).get(args.sourceSessionId, aliasKey) as { lane_id: string } | undefined;
      if (alias) identityMatches.push({
        aliasKey,
        laneId: alias.lane_id,
        via: 'alias',
        canonicalPrincipalKey: alias.canonical_principal_key,
      });
      if (direct) identityMatches.push({ aliasKey, laneId: direct.lane_id, via: 'direct' });
    }
    const candidateLaneIds = [...new Set(identityMatches.map(match => match.laneId))];
    if (candidateLaneIds.length > 1) {
      const left = identityMatches.find(match => match.laneId === candidateLaneIds[0])!;
      const right = identityMatches.find(match => match.laneId !== left.laneId)!;
      persistPrincipalLaneIdentityConflict(store, {
        sourceSessionId: args.sourceSessionId,
        leftAliasKey: left.aliasKey,
        rightAliasKey: right.aliasKey,
        leftLaneId: left.laneId,
        rightLaneId: right.laneId,
        now,
      });
      return { status: 'identity_conflict', reason: 'identity_evidence_conflict' };
    }

    if (candidateLaneIds.length === 1) {
      const laneId = candidateLaneIds[0]!;
      const hit = store.db.prepare(
        'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
        + 'phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
      ).get(args.sourceSessionId, laneId) as PrincipalLaneSidecarRow | undefined;
      const parsed = parseLaneSidecar(hit, { displayTarget, sourceSessionId: args.sourceSessionId });
      if (!parsed.ok) {
        quarantinePrincipalLane(store, args.sourceSessionId, laneId);
        return { status: 'quarantined', reason: `lane:${parsed.error}` };
      }
      let binding = parsed.value.binding;
      const memberHit = readWorkspaceMemberRow(store, args.sourceSessionId, laneId);
      const member = parseWorkspaceMemberSidecar(memberHit);
      if (!member.ok) {
        if (memberHit) quarantinePrincipalWorkspaceMember(store, args.sourceSessionId, laneId);
        return { status: 'quarantined', reason: `member:${member.error}` };
      }
      if (!principalWorkspaceMemberIdentityMatchesLane(member.value, parsed.value, sourceState.value)) {
        quarantinePrincipalWorkspaceMember(store, args.sourceSessionId, laneId);
        return { status: 'quarantined', reason: 'member:lane_membership_mismatch' };
      }
      if (member.value.membershipPhase !== 'active') {
        return { status: 'retry', reason: 'lane_not_active' };
      }
      const mismatchedAlias = identityMatches.find(match => match.via === 'alias'
        && match.laneId === laneId
        && match.canonicalPrincipalKey !== binding.principalKey);
      if (mismatchedAlias) {
        persistPrincipalLaneIdentityConflict(store, {
          sourceSessionId: args.sourceSessionId,
          leftAliasKey: mismatchedAlias.aliasKey,
          rightAliasKey: mismatchedAlias.canonicalPrincipalKey!,
          leftLaneId: laneId,
          rightLaneId: laneId,
          now,
        });
        return { status: 'identity_conflict', reason: 'identity_evidence_conflict' };
      }
      if (binding.workspaceEpoch !== sourceState.value.workspaceEpoch) {
        return { status: 'retry', reason: 'source_authority_changed' };
      }
      if (binding.phase !== 'active' && binding.phase !== 'dormant') {
        return { status: 'retry', reason: 'lane_not_active' };
      }
      const childHit = store.selectRow.get(parsed.value.sessionId) as { row: string } | undefined;
      let child: Session | undefined;
      try { child = childHit ? JSON.parse(childHit.row) as Session : undefined; } catch { child = undefined; }
      const embedded = child?.principalLane
        ? parsePrincipalLaneBinding(child.principalLane, { displayTarget, sourceSessionId: args.sourceSessionId })
        : { ok: false as const, error: 'not_object' as const };
      const childDisplayTarget = child
        ? sourceSessionDisplayTarget(child, currentAppId!)
        : undefined;
      if (!child || child.status !== 'active' || !embedded.ok
          || !principalLaneBindingsEqual(embedded.value, binding)
          || child.larkAppId !== currentAppId
          || !childDisplayTarget
          || !samePrincipalDisplayTarget(childDisplayTarget, displayTarget)) {
        quarantinePrincipalLane(store, args.sourceSessionId, laneId);
        return { status: 'quarantined', reason: 'lane_session_mismatch' };
      }
      const workspace = validatePrincipalLaneWorkspace(
        store, sourceState.value, parsed.value, child,
      );
      if (!workspace.ok) {
        quarantinePrincipalLane(store, args.sourceSessionId, laneId);
        if (readPrincipalLaneWorktreeRow(store, args.sourceSessionId, laneId)) {
          quarantinePrincipalLaneWorktree(store, args.sourceSessionId, laneId);
        }
        return { status: 'quarantined', reason: workspace.reason };
      }
      if (args.worktree && workspace.worktree
          && !proofMatchesMaterialization(workspace.worktree, args.worktree)) {
        return { status: 'quarantined', reason: 'worktree_materialization_conflict' };
      }
      if (workspace.worktree && binding.principalKey !== evidence.canonicalKey) {
        return { status: 'quarantined', reason: 'worktree_identity_upgrade_requires_migration' };
      }

      if (binding.principalKey !== evidence.canonicalKey) {
        const openKey = evidence.openId ? lanePrincipalKey({
          senderType: 'user', kind: 'app_open', larkAppId: currentAppId!, openId: evidence.openId,
        }) : undefined;
        if (!evidence.unionId || !openKey || binding.principalKey !== openKey
            || binding.principal.kind !== 'app_open') {
          persistPrincipalLaneIdentityConflict(store, {
            sourceSessionId: args.sourceSessionId,
            leftAliasKey: binding.principalKey,
            rightAliasKey: evidence.canonicalKey,
            leftLaneId: laneId,
            rightLaneId: laneId,
            now,
          });
          return { status: 'identity_conflict', reason: 'identity_evidence_conflict' };
        }
        const previousKey = binding.principalKey;
        binding = {
          ...binding,
          principal: evidence.canonicalPrincipal,
          principalKey: evidence.canonicalKey,
          revision: binding.revision + 1,
          updatedAt: now,
        };
        child.principalLane = binding;
        child.ownerUnionId = evidence.unionId;
        child.ownerOpenId = evidence.openId;
        child.creatorOpenId = evidence.openId;
        child.lastCallerOpenId = evidence.openId;
        if (laneId === 'source') {
          const nextSource = {
            ...sourceState.value,
            sourcePrincipalKey: evidence.canonicalKey,
            revision: sourceState.value.revision + 1,
            updatedAt: now,
          };
          child.principalLaneSource = nextSource;
          const sourceUpdated = store.db.prepare(
            'UPDATE principal_lane_sources SET source_principal_key = ?, revision = ?, row = ? '
            + 'WHERE source_session_id = ? AND revision = ?',
          ).run(
            nextSource.sourcePrincipalKey, nextSource.revision, JSON.stringify(nextSource),
            args.sourceSessionId, sourceState.value.revision,
          );
          if (Number(sourceUpdated.changes) !== 1) throw new PrincipalLaneAuthorityChangedError();
        }
        const updated = store.db.prepare(
          'UPDATE principal_lanes SET principal_key = ?, revision = ?, row = ? '
          + 'WHERE source_session_id = ? AND lane_id = ? AND revision = ?',
        ).run(
          binding.principalKey, binding.revision, JSON.stringify(binding),
          args.sourceSessionId, laneId, parsed.value.binding.revision,
        );
        if (Number(updated.changes) !== 1) throw new PrincipalLaneAuthorityChangedError();
        persistRow(child);
        store.db.prepare(
          'INSERT INTO principal_lane_identity_audit '
          + '(audit_id, source_session_id, lane_id, event, from_principal_key, '
          + 'to_principal_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          randomUUID(), args.sourceSessionId, laneId, 'upgraded',
          previousKey, evidence.canonicalKey, now,
        );
      }
      let worktree = workspace.worktree;
      if (args.worktree && !worktree) {
        worktree = buildPrincipalLaneWorktreeProof({
          materialization: args.worktree,
          lane: binding,
          sessionId: child.sessionId,
          now,
        });
        child.workingDir = worktree.workingDir;
        child.principalLaneWorktree = worktree;
        persistRow(child);
        insertPrincipalLaneWorktreeProof(store, worktree);
      }
      for (const aliasKey of evidence.aliasKeys) {
        upsertPrincipalLaneAlias(store, args.sourceSessionId, aliasKey, laneId, binding.principalKey, now);
      }
      store.db.prepare(
        'UPDATE principal_lane_aliases SET canonical_principal_key = ?, updated_at = ? '
        + 'WHERE source_session_id = ? AND lane_id = ?',
      ).run(binding.principalKey, now, args.sourceSessionId, laneId);
      return { status: 'ready', created: false, lane: binding, session: child, worktree };
    }

    const laneId = `lane_${randomUUID()}`;
    const binding: PrincipalLaneBinding = {
      version: 1,
      laneId,
      sourceSessionId: args.sourceSessionId,
      principalKey: evidence.canonicalKey,
      principal: evidence.canonicalPrincipal,
      routingAnchor: shadowRoutingAnchor(args.sourceSessionId, laneId),
      displayTarget,
      workspaceEpoch: sourceState.value.workspaceEpoch,
      phase: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const title = args.title?.trim().slice(0, 100) || '独立任务';
    const child = buildShadowPrincipalSession({
      source: sourceSession,
      sourceState: sourceState.value,
      displayTarget,
      evidence,
      lane: binding,
      title,
      now,
    });
    let worktree: PrincipalLaneWorktreeProof | undefined;
    if (args.worktree) {
      worktree = buildPrincipalLaneWorktreeProof({
        materialization: args.worktree,
        lane: binding,
        sessionId: child.sessionId,
        now,
      });
      child.workingDir = worktree.workingDir;
      child.principalLaneWorktree = worktree;
    }
    persistRow(child);
    store.db.prepare(
      'INSERT INTO principal_lanes '
      + '(lane_id, source_session_id, session_id, principal_key, routing_anchor, '
      + 'workspace_epoch, phase, revision, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      binding.laneId, binding.sourceSessionId, child.sessionId, binding.principalKey,
      binding.routingAnchor, binding.workspaceEpoch, binding.phase, binding.revision,
      JSON.stringify(binding),
    );
    if (worktree) insertPrincipalLaneWorktreeProof(store, worktree);
    insertPrincipalWorkspaceMember(store, initialPrincipalWorkspaceMember({
      sourceSessionId: args.sourceSessionId,
      laneId,
      sessionId: child.sessionId,
      groupId: sourceState.value.workspaceGroupId,
      workspaceEpoch: sourceState.value.workspaceEpoch,
      now,
    }));
    for (const aliasKey of evidence.aliasKeys) {
      upsertPrincipalLaneAlias(
        store, args.sourceSessionId, aliasKey, laneId, binding.principalKey, now,
      );
    }
    store.db.prepare(
      'INSERT INTO principal_lane_identity_audit '
      + '(audit_id, source_session_id, lane_id, event, to_principal_key, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), args.sourceSessionId, laneId, 'created', binding.principalKey, now);
      return { status: 'ready', created: true, lane: binding, session: child, worktree };
    };
    result = args.worktree
      ? runPrincipalLaneWorktreePublicationTransaction(store, args.worktree, operation)
      : runOwnedWriteTransaction(store, false, operation);
  } catch (error) {
    if (error instanceof PrincipalLaneAuthorityChangedError) {
      return { status: 'retry', reason: 'source_authority_changed' };
    }
    throw error;
  }

  if (result.status === 'ready') {
    const cached = sessions.get(result.session.sessionId);
    if (cached) {
      for (const key of Object.keys(cached)) delete (cached as unknown as Record<string, unknown>)[key];
      Object.assign(cached, structuredClone(result.session));
      result.session = cached;
    } else {
      sessions.set(result.session.sessionId, result.session);
    }
  }
  return result;
}

export type HydratePrincipalLaneForIngressResult =
  | {
      status: 'ready';
      source: PrincipalLaneSourceState;
      lane: PrincipalLaneBinding;
      session: Session;
      runtimeRoutingAnchor: string;
      worktree?: PrincipalLaneWorktreeProof;
    }
  | {
      status: 'retry';
      reason: 'source_not_active' | 'lane_not_active' | 'worktree_not_materialized'
        | 'store_busy' | 'authority_changed';
    }
  | { status: 'missing'; reason: 'source_missing' | 'lane_missing' | 'session_missing' }
  | { status: 'quarantined'; reason: string };

export type PrepareShadowPrincipalLaneForIngressResult =
  | Extract<EnsureShadowPrincipalLaneResult, { status: 'ready' }>
  | {
      status: 'retry';
      reason: string;
      detail?: string;
      orphan?: PrincipalLaneWorktreeOrphan;
    }
  | {
      status: 'unknown';
      reason: 'worktree_materialization_unknown' | 'worktree_publication_unknown';
      detail?: string;
      orphan: PrincipalLaneWorktreeOrphan;
    }
  | {
      status: 'identity_conflict';
      reason: string;
      orphan: PrincipalLaneWorktreeOrphan;
    }
  | {
      status: 'quarantined';
      reason: string;
      orphan?: PrincipalLaneWorktreeOrphan;
    };

export interface PrincipalLaneWorktreeOrphan {
  worktreePath: string;
  branch: string;
  materializationId: string;
}

/** Full fail-closed D-live admission preparation, still deliberately detached
 * from event-dispatch and activeSessions. Any directory that exists without a
 * proven ready publication is reported as an orphan and never deleted or
 * reused as a capability by this API. */
export async function prepareShadowPrincipalLaneForIngress(args: {
  sourceSessionId: string;
  identity: HumanLaneIdentityEvidence;
  title?: string;
  now?: string;
}): Promise<PrepareShadowPrincipalLaneForIngressResult> {
  const source = readPrincipalLaneSource(args.sourceSessionId);
  if (!source || source.status !== 'ready') {
    return source?.status === 'quarantined'
      ? { status: 'quarantined', reason: `source:${source.reason}` }
      : { status: 'retry', reason: source?.status === 'retry'
        ? source.reason : 'source_not_active' };
  }
  const expectedSource: ExpectedPrincipalLaneSourceAuthority = {
    sourcePrincipalKey: source.source.sourcePrincipalKey,
    sourceRevision: source.source.revision,
    sourceLaneRevision: source.lane.revision,
    workspaceEpoch: source.source.workspaceEpoch,
    canonicalCwd: source.source.canonicalCwd,
    workspaceGroupId: source.source.workspaceGroupId,
    workspaceGroupKeyVersion: source.source.workspaceGroupKeyVersion,
    displayTarget: source.source.displayTarget,
  };
  const materialized = await materializePrincipalLaneWorktree({
    sourceSessionId: args.sourceSessionId,
    source: source.source,
    identity: args.identity,
    now: args.now,
    commit: worktree => ensureShadowPrincipalLane({
      sourceSessionId: args.sourceSessionId,
      identity: args.identity,
      title: args.title,
      now: args.now,
      expectedSource,
      worktree,
    }),
  });
  if (materialized.status === 'retry') {
    return { status: 'retry', reason: materialized.reason, detail: materialized.detail };
  }
  if (materialized.status === 'unknown') {
    return {
      status: 'unknown', reason: 'worktree_materialization_unknown',
      detail: materialized.detail, orphan: materialized.orphan,
    };
  }
  const orphan: PrincipalLaneWorktreeOrphan = {
    worktreePath: materialized.materialization.worktreeRoot,
    branch: materialized.materialization.branch,
    materializationId: materialized.materialization.materializationId,
  };
  if (materialized.value.status === 'unknown') {
    const recovered = await recoverPrincipalLaneWorktreePublication(materialized.materialization);
    return recovered.status === 'ready' ? recovered : { ...recovered, orphan };
  }
  if (materialized.value.status === 'ready') {
    const hydrated = await hydratePrincipalLaneForIngress(
      args.sourceSessionId, materialized.value.lane.laneId,
    );
    if (hydrated.status === 'ready' && hydrated.worktree
        && hydrated.session.sessionId === materialized.value.session.sessionId
        && JSON.stringify(hydrated.lane) === JSON.stringify(materialized.value.lane)
        && proofMatchesMaterialization(hydrated.worktree, materialized.materialization)) {
      return materialized.value;
    }
    return { status: 'unknown', reason: 'worktree_publication_unknown', orphan };
  }
  return { ...materialized.value, orphan };
}

/** Read exactly one lane from one SQLite snapshot for on-demand ingress
 * activation. This does not scan at startup, mutate rows, publish an
 * activeSessions entry, or fork a worker. Shadow lanes without durable
 * worktree proof are intentionally non-hydratable. */
function readPrincipalLaneHydrationSnapshot(
  store: SqliteReadStore,
  appId: string,
  sourceSessionId: string,
  laneId: string,
): HydratePrincipalLaneForIngressResult {
  const readSession = (sessionId: string) => store.db.prepare(
    'SELECT row FROM sessions WHERE session_id = ?',
  ).get(sessionId) as { row: string } | undefined;
  const sourceSessionHit = readSession(sourceSessionId);
  if (!sourceSessionHit) return { status: 'missing', reason: 'source_missing' };
  let sourceSession: Session;
  try { sourceSession = JSON.parse(sourceSessionHit.row) as Session; }
  catch { return { status: 'quarantined', reason: 'invalid_source_session_json' }; }
  if (sourceSession.status !== 'active') return { status: 'retry', reason: 'source_not_active' };
  const displayTarget = sourceSessionDisplayTarget(sourceSession, appId);
  if (!displayTarget) return { status: 'quarantined', reason: 'invalid_source_display_target' };
  const sourceHit = store.db.prepare(
    'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
    + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
  ).get(sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
  const parsedSource = parseSourceSidecar(sourceHit, displayTarget, sourceSessionId);
  if (!parsedSource.ok) return { status: 'quarantined', reason: `source:${parsedSource.error}` };
  if (parsedSource.value.phase !== 'active') return { status: 'retry', reason: 'source_not_active' };
  const sourceLaneHit = store.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + "phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
  ).get(sourceSessionId) as PrincipalLaneSidecarRow | undefined;
  const parsedSourceLane = parseLaneSidecar(sourceLaneHit, { displayTarget, sourceSessionId });
  const embeddedSource = sourceSession.principalLaneSource
    ? parsePrincipalLaneSourceState(sourceSession.principalLaneSource, displayTarget, sourceSessionId)
    : { ok: false as const, error: 'missing_embedded_source' };
  const embeddedSourceLane = sourceSession.principalLane
    ? parsePrincipalLaneBinding(sourceSession.principalLane, { displayTarget, sourceSessionId })
    : { ok: false as const, error: 'missing_embedded_source_lane' };
  if (!parsedSourceLane.ok || parsedSourceLane.value.binding.laneId !== 'source'
      || parsedSourceLane.value.sessionId !== sourceSessionId
      || !embeddedSource.ok || !embeddedSourceLane.ok
      || !principalLaneSourcesEqual(embeddedSource.value, parsedSource.value)
      || !principalLaneBindingsEqual(embeddedSourceLane.value, parsedSourceLane.value.binding)
      || canonicalSessionCwd(sourceSession) !== parsedSource.value.canonicalCwd) {
    return { status: 'quarantined', reason: 'source_session_sidecar_mismatch' };
  }
  const laneHit = store.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + 'phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
  ).get(sourceSessionId, laneId) as PrincipalLaneSidecarRow | undefined;
  if (!laneHit) return { status: 'missing', reason: 'lane_missing' };
  const parsedLane = parseLaneSidecar(laneHit, { displayTarget, sourceSessionId });
  if (!parsedLane.ok
      || parsedLane.value.binding.workspaceEpoch !== parsedSource.value.workspaceEpoch) {
    return { status: 'quarantined', reason: !parsedLane.ok
      ? `lane:${parsedLane.error}` : 'lane_workspace_epoch_mismatch' };
  }
  if (parsedLane.value.binding.phase !== 'active'
      && parsedLane.value.binding.phase !== 'dormant') {
    return { status: 'retry', reason: 'lane_not_active' };
  }
  const childHit = parsedLane.value.sessionId === sourceSessionId
    ? sourceSessionHit
    : readSession(parsedLane.value.sessionId);
  if (!childHit) return { status: 'missing', reason: 'session_missing' };
  let child: Session;
  try { child = JSON.parse(childHit.row) as Session; }
  catch { return { status: 'quarantined', reason: 'invalid_lane_session_json' }; }
  const embeddedLane = child.principalLane
    ? parsePrincipalLaneBinding(child.principalLane, { displayTarget, sourceSessionId })
    : { ok: false as const, error: 'missing_embedded_lane' };
  if (child.sessionId !== parsedLane.value.sessionId || !embeddedLane.ok
      || !principalLaneBindingsEqual(embeddedLane.value, parsedLane.value.binding)) {
    return { status: 'quarantined', reason: 'lane_session_sidecar_mismatch' };
  }
  const childDisplay = parsedLane.value.binding.laneId === 'source'
    ? sourceSessionDisplayTarget(child, appId)
    : child.larkAppId === displayTarget.larkAppId
      && child.scope === displayTarget.scope
      && child.chatId === displayTarget.chatId
      && (displayTarget.scope === 'chat' || child.rootMessageId === displayTarget.rootMessageId)
      ? displayTarget
      : undefined;
  if (!childDisplay || !samePrincipalDisplayTarget(childDisplay, displayTarget)) {
    return { status: 'quarantined', reason: 'lane_session_display_mismatch' };
  }
  if (child.status !== 'active') return { status: 'retry', reason: 'lane_not_active' };
  const workspace = validatePrincipalLaneWorkspace(store, parsedSource.value, parsedLane.value, child);
  if (!workspace.ok) return { status: 'quarantined', reason: workspace.reason };
  if (laneId !== 'source' && !workspace.worktree) {
    return { status: 'retry', reason: 'worktree_not_materialized' };
  }
  const memberHit = readWorkspaceMemberRow(store, sourceSessionId, laneId);
  const member = parseWorkspaceMemberSidecar(memberHit);
  if (!member.ok || !principalWorkspaceMemberIdentityMatchesLane(
    member.value, parsedLane.value, parsedSource.value,
  )) {
    return { status: 'quarantined', reason: !member.ok
      ? `member:${member.error}` : 'member:lane_membership_mismatch' };
  }
  if (member.value.membershipPhase !== 'active') {
    return { status: 'retry', reason: 'lane_not_active' };
  }
  const groupHit = readWorkspaceGroupRow(store, parsedSource.value.workspaceGroupId);
  const group = parseWorkspaceGroupSidecar(groupHit);
  if (!group.ok || group.value.phase !== 'active'
      || group.value.larkAppId !== appId
      || group.value.groupId !== member.value.groupId
      || group.value.canonicalCwd !== parsedSource.value.canonicalCwd) {
    return { status: 'quarantined', reason: !group.ok
      ? `group:${group.error}` : 'group_source_mismatch' };
  }
  return {
    status: 'ready',
    source: parsedSource.value,
    lane: parsedLane.value.binding,
    session: child,
    runtimeRoutingAnchor: parsedLane.value.binding.routingAnchor,
    worktree: workspace.worktree,
  };
}

function readPrincipalLaneHydrationTransaction(
  store: SqliteReadStore,
  appId: string,
  sourceSessionId: string,
  laneId: string,
): HydratePrincipalLaneForIngressResult {
  let began = false;
  try {
    store.db.exec('BEGIN');
    began = true;
    const result = readPrincipalLaneHydrationSnapshot(store, appId, sourceSessionId, laneId);
    store.db.exec('COMMIT');
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try { store.db.exec('ROLLBACK'); } catch { /* read snapshot already gone */ }
    }
    throw error;
  }
}

async function readPrincipalLaneHydrationWithGitFence(
  store: SqliteReadStore,
  appId: string,
  sourceSessionId: string,
  laneId: string,
): Promise<HydratePrincipalLaneForIngressResult> {
  const before = readPrincipalLaneHydrationTransaction(store, appId, sourceSessionId, laneId);
  if (before.status !== 'ready' || !before.worktree) return before;
  const gitIdentityIsIntact = await principalLaneWorktreeGitCarrierIsIntact(before.worktree);
  const after = readPrincipalLaneHydrationTransaction(store, appId, sourceSessionId, laneId);
  if (after.status !== 'ready' || !after.worktree) {
    return { status: 'retry', reason: 'authority_changed' };
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    return { status: 'retry', reason: 'authority_changed' };
  }
  return gitIdentityIsIntact
    ? after
    : { status: 'quarantined', reason: 'worktree_session_sidecar_mismatch' };
}

export async function hydratePrincipalLaneForIngress(
  sourceSessionId: string,
  laneId: string,
): Promise<HydratePrincipalLaneForIngressResult> {
  loadForWrite();
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  try {
    return await readPrincipalLaneHydrationWithGitFence(
      store, currentAppId, sourceSessionId, laneId,
    );
  } catch (error) {
    if (isTransientStoreContentionError(error)) {
      return { status: 'retry', reason: 'store_busy' };
    }
    return { status: 'quarantined', reason: 'hydrate_read_failed' };
  }
}

export type RetirePrincipalLaneResult =
  | { status: 'ready' }
  | { status: 'retired' }
  | { status: 'retry'; reason: 'store_busy' | 'session_not_closed' | 'active_workspace_ticket' }
  | { status: 'missing'; reason: 'lane_missing' }
  | { status: 'quarantined'; reason: string };

/** Remove the durable routing/materialization records for one closed shadow
 * lane. The closed Session row and ticket/audit history are intentionally kept
 * for observability; only records that could route future traffic back into the
 * retired worktree are deleted. Physical worktree removal happens afterwards,
 * under the git target lock, so a failed store transaction can never orphan a
 * live directory from its authority record. */
export function retirePrincipalLane(args: {
  sourceSessionId: string;
  laneId: string;
  sessionId: string;
  materializationId: string;
  dryRun?: boolean;
}): RetirePrincipalLaneResult {
  loadForWrite();
  const store = ownStore;
  if (!store || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  if (args.laneId === 'source') {
    return { status: 'quarantined', reason: 'source_lane_cannot_be_retired' };
  }

  let began = false;
  try {
    store.db.exec('BEGIN IMMEDIATE');
    began = true;
    const sessionHit = store.db.prepare(
      'SELECT status, row FROM sessions WHERE session_id = ?',
    ).get(args.sessionId) as { status: string; row: string } | undefined;
    const sourceSessionHit = store.db.prepare(
      'SELECT status, row FROM sessions WHERE session_id = ?',
    ).get(args.sourceSessionId) as { status: string; row: string } | undefined;
    const laneHit = store.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + 'phase, revision, row FROM principal_lanes '
      + 'WHERE source_session_id = ? AND lane_id = ?',
    ).get(args.sourceSessionId, args.laneId) as PrincipalLaneSidecarRow | undefined;
    if (!laneHit) {
      store.db.exec('COMMIT');
      began = false;
      return { status: 'missing', reason: 'lane_missing' };
    }
    const sourceHit = store.db.prepare(
      'SELECT source_principal_key, canonical_cwd, workspace_epoch, workspace_group_id, '
      + 'phase, revision, row FROM principal_lane_sources WHERE source_session_id = ?',
    ).get(args.sourceSessionId) as PrincipalLaneSourceSidecarRow | undefined;
    const memberHit = readWorkspaceMemberRow(store, args.sourceSessionId, args.laneId);

    let sessionRow: Session | undefined;
    let sourceSessionRow: Session | undefined;
    try {
      sessionRow = sessionHit ? JSON.parse(sessionHit.row) as Session : undefined;
      sourceSessionRow = sourceSessionHit
        ? JSON.parse(sourceSessionHit.row) as Session
        : undefined;
    } catch {
      store.db.exec('ROLLBACK');
      began = false;
      return { status: 'quarantined', reason: 'invalid_lane_sidecar_json' };
    }
    const expectedSessionStatus = args.dryRun ? 'active' : 'closed';
    if (!sessionHit || !sessionRow
        || sessionHit.status !== expectedSessionStatus
        || sessionRow.status !== expectedSessionStatus) {
      store.db.exec('ROLLBACK');
      began = false;
      return { status: 'retry', reason: 'session_not_closed' };
    }
    const displayTarget = sourceSessionRow
      ? sourceSessionDisplayTarget(sourceSessionRow, currentAppId)
      : undefined;
    const source = displayTarget
      ? parseSourceSidecar(sourceHit, displayTarget, args.sourceSessionId)
      : { ok: false as const, error: 'invalid_source_display_target' };
    const lane = displayTarget
      ? parseLaneSidecar(laneHit, { displayTarget, sourceSessionId: args.sourceSessionId })
      : { ok: false as const, error: 'invalid_source_display_target' };
    const embeddedLane = sessionRow.principalLane && displayTarget
      ? parsePrincipalLaneBinding(sessionRow.principalLane, {
        displayTarget, sourceSessionId: args.sourceSessionId,
      })
      : { ok: false as const, error: 'missing_embedded_lane' };
    const workspace = source.ok && lane.ok
      ? validatePrincipalLaneWorkspace(store, source.value, lane.value, sessionRow)
      : { ok: false as const, reason: 'invalid_lane_authority' };
    const member = parseWorkspaceMemberSidecar(memberHit);
    const exactAuthority = !!sourceSessionHit
      && sourceSessionHit.status === 'active'
      && sourceSessionRow?.status === 'active'
      && source.ok
      && source.value.phase === 'active'
      && lane.ok
      && lane.value.sessionId === args.sessionId
      && lane.value.binding.phase === 'active'
      && lane.value.binding.workspaceEpoch === source.value.workspaceEpoch
      && embeddedLane.ok
      && principalLaneBindingsEqual(embeddedLane.value, lane.value.binding)
      && workspace.ok
      && !!workspace.worktree
      && workspace.worktree.materializationId === args.materializationId
      && workspace.worktree.sourceCanonicalCwd === source.value.canonicalCwd
      && member.ok
      && member.value.membershipPhase === 'active'
      && principalWorkspaceMemberIdentityMatchesLane(member.value, lane.value, source.value);
    if (!exactAuthority) {
      store.db.exec('ROLLBACK');
      began = false;
      return { status: 'quarantined', reason: 'lane_retirement_authority_mismatch' };
    }
    const activeTicket = store.db.prepare(
      "SELECT 1 AS hit FROM principal_workspace_tickets WHERE source_session_id = ? "
      + "AND lane_id = ? AND session_id = ? AND status IN ('queued', 'attempting', 'unknown') LIMIT 1",
    ).get(args.sourceSessionId, args.laneId, args.sessionId) as { hit: number } | undefined;
    if (activeTicket) {
      store.db.exec('ROLLBACK');
      began = false;
      return { status: 'retry', reason: 'active_workspace_ticket' };
    }
    if (args.dryRun) {
      store.db.exec('COMMIT');
      began = false;
      return { status: 'ready' };
    }

    store.db.prepare(
      'DELETE FROM principal_lane_aliases WHERE source_session_id = ? AND lane_id = ?',
    ).run(args.sourceSessionId, args.laneId);
    store.db.prepare(
      'DELETE FROM principal_lane_worktrees WHERE materialization_id = ? '
      + 'AND source_session_id = ? AND lane_id = ? AND session_id = ?',
    ).run(args.materializationId, args.sourceSessionId, args.laneId, args.sessionId);
    store.db.prepare(
      'DELETE FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = ? AND session_id = ?',
    ).run(args.sourceSessionId, args.laneId, args.sessionId);
    store.db.prepare(
      'DELETE FROM principal_lanes WHERE source_session_id = ? AND lane_id = ? AND session_id = ?',
    ).run(args.sourceSessionId, args.laneId, args.sessionId);
    store.db.exec('COMMIT');
    began = false;
    return { status: 'retired' };
  } catch (error) {
    if (began) {
      try { store.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    }
    if (isTransientStoreContentionError(error)) {
      return { status: 'retry', reason: 'store_busy' };
    }
    return {
      status: 'quarantined',
      reason: error instanceof Error ? `lane_retirement_failed:${error.message}` : 'lane_retirement_failed',
    };
  }
}

function provenanceMatchesDisplay(
  provenance: Pick<MessageProvenance, 'larkAppId' | 'chatId' | 'displayRootId'>,
  target: PrincipalLaneDisplayTarget,
): boolean {
  return provenance.larkAppId === target.larkAppId
    && provenance.chatId === target.chatId
    && (target.scope === 'thread'
      ? provenance.displayRootId === target.rootMessageId
      : provenance.displayRootId === undefined);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function provenanceFromRow(row: Record<string, unknown>): MessageProvenance | undefined {
  const direction = row.direction;
  const trustState = row.trust_state;
  if (typeof row.message_id !== 'string' || row.message_id.length === 0
      || typeof row.lark_app_id !== 'string' || row.lark_app_id.length === 0
      || typeof row.chat_id !== 'string' || row.chat_id.length === 0
      || (row.display_root_id !== null && row.display_root_id !== undefined && typeof row.display_root_id !== 'string')
      || typeof row.source_session_id !== 'string' || row.source_session_id.length === 0
      || typeof row.lane_id !== 'string' || row.lane_id.length === 0
      || typeof row.session_id !== 'string' || row.session_id.length === 0
      || typeof row.turn_id !== 'string' || row.turn_id.length === 0
      || typeof row.principal_key !== 'string' || row.principal_key.length === 0
      || !Number.isSafeInteger(row.worker_generation) || Number(row.worker_generation) < 1
      || (direction !== 'inbound' && direction !== 'outbound')
      || (trustState !== 'trusted' && trustState !== 'untrusted')
      || !canonicalIso(row.created_at)
      || !canonicalIso(row.updated_at)
      || Date.parse(row.updated_at) < Date.parse(row.created_at)) return undefined;
  return {
    messageId: row.message_id,
    larkAppId: row.lark_app_id,
    chatId: row.chat_id,
    ...(typeof row.display_root_id === 'string' ? { displayRootId: row.display_root_id } : {}),
    sourceSessionId: row.source_session_id,
    laneId: row.lane_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    principalKey: row.principal_key,
    workerGeneration: Number(row.worker_generation),
    direction,
    trustState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameProvenanceIdentity(a: MessageProvenance, b: MessageProvenance): boolean {
  // createdAt records when a caller observed the message, not who owns it.
  // Retries may reconstruct the same authority a few milliseconds later; the
  // persisted row keeps the first createdAt while updatedAt advances below.
  return a.messageId === b.messageId
    && a.larkAppId === b.larkAppId
    && a.chatId === b.chatId
    && a.displayRootId === b.displayRootId
    && a.sourceSessionId === b.sourceSessionId
    && a.laneId === b.laneId
    && a.sessionId === b.sessionId
    && a.turnId === b.turnId
    && a.principalKey === b.principalKey
    && a.workerGeneration === b.workerGeneration
    && a.direction === b.direction;
}

function laterIsoTimestamp(first: string, second: string): string {
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

type ProvenanceCommitResult =
  | { ok: true; value: MessageProvenance }
  | { ok: false; error: 'identity_conflict' | 'trust_elevation_refused' };

type MessageProvenanceTrustFenceRow = {
  message_id: string;
  lark_app_id: string;
  source_session_id: string;
  session_id: string | null;
  turn_id: string | null;
  worker_generation: number | null;
  attempt_id: string | null;
};

export class MessageProvenanceFencedError extends Error {
  readonly code = 'trust_commit_unknown';
  constructor(readonly messageId: string) {
    super(`message provenance ${messageId} is fenced by an unresolved trust attempt`);
    this.name = 'MessageProvenanceFencedError';
  }
}

function trustFenceMatchesAttempt(
  fence: MessageProvenanceTrustFenceRow,
  provenance: MessageProvenance,
  attemptId: string | undefined,
): boolean {
  return !!attemptId
    && fence.attempt_id === attemptId
    && fence.lark_app_id === provenance.larkAppId
    && fence.source_session_id === provenance.sourceSessionId
    && fence.session_id === provenance.sessionId
    && fence.turn_id === provenance.turnId
    && fence.worker_generation === provenance.workerGeneration;
}

/** Idempotent provenance commit. Conflicting reuse of a Lark message id, or an
 * attempted untrusted→trusted elevation, fails closed. The caller may mark an
 * API-success/persist-failure message untrusted in a later explicit audit, but
 * no read path will ever treat that row as authority. */
export function recordMessageProvenance(
  provenance: MessageProvenance,
  trustAttemptId?: string,
): MessageProvenance {
  loadForWrite();
  if (!ownStore || !currentAppId) {
    throw new SessionStoreUnavailableError(new Error('owned app-scoped session store is not attached'));
  }
  const createdAtMs = Date.parse(provenance.createdAt);
  const updatedAtMs = Date.parse(provenance.updatedAt);
  if (provenance.larkAppId !== currentAppId
      || !provenance.messageId
      || !provenance.turnId
      || !Number.isSafeInteger(provenance.workerGeneration)
      || provenance.workerGeneration < 1
      || !Number.isFinite(createdAtMs)
      || !Number.isFinite(updatedAtMs)
      || new Date(createdAtMs).toISOString() !== provenance.createdAt
      || new Date(updatedAtMs).toISOString() !== provenance.updatedAt
      || updatedAtMs < createdAtMs) {
    throw new Error('invalid message provenance');
  }
  const bundle = readPrincipalLaneSource(provenance.sourceSessionId);
  if (!bundle || bundle.status !== 'ready') throw new Error('principal-lane source is not ready');
  if (!provenanceMatchesDisplay(provenance, bundle.source.displayTarget)) {
    throw new Error('message provenance display target mismatch');
  }

  // A tokenized outbound trust attempt already has a durable deny fence. Keep
  // its trusted write nonblocking so SQLITE_BUSY is classified as proven
  // pre-commit and the exact fence can be safely aborted by the caller.
  const nonblockingTrustAttempt = trustAttemptId !== undefined;
  const committed = runOwnedWriteTransaction(ownStore, nonblockingTrustAttempt, (): ProvenanceCommitResult => {
    const fence = ownStore!.db.prepare(
      'SELECT message_id, lark_app_id, source_session_id, session_id, turn_id, '
      + 'worker_generation, attempt_id FROM message_provenance_trust_fences WHERE message_id = ?',
    ).get(provenance.messageId) as MessageProvenanceTrustFenceRow | undefined;
    if (fence && !trustFenceMatchesAttempt(fence, provenance, trustAttemptId)) {
      throw new MessageProvenanceFencedError(provenance.messageId);
    }
    const laneHit = ownStore!.db.prepare(
      'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
      + 'phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
    ).get(provenance.sourceSessionId, provenance.laneId) as PrincipalLaneSidecarRow | undefined;
    const parsedLane = parseLaneSidecar(laneHit, {
      displayTarget: bundle.source.displayTarget,
      sourceSessionId: provenance.sourceSessionId,
    });
    if (!parsedLane.ok || parsedLane.value.binding.principalKey !== provenance.principalKey) {
      throw new Error('message provenance lane authority mismatch');
    }
    if (parsedLane.value.sessionId !== provenance.sessionId) {
      throw new Error('message provenance session authority mismatch');
    }
    if (bundle.source.phase !== 'active'
        || parsedLane.value.binding.phase !== 'active'
        || parsedLane.value.binding.workspaceEpoch !== bundle.source.workspaceEpoch) {
      throw new Error('message provenance lane is not admissible');
    }

    const existingRow = ownStore!.db.prepare(
      'SELECT * FROM message_provenance WHERE message_id = ?',
    ).get(provenance.messageId) as Record<string, unknown> | undefined;
    if (existingRow) {
      const existing = provenanceFromRow(existingRow);
      if (!existing || !sameProvenanceIdentity(existing, provenance)) {
        const durableUpdatedAt = canonicalIso(existingRow.updated_at)
          ? laterIsoTimestamp(existingRow.updated_at, provenance.updatedAt)
          : provenance.updatedAt;
        ownStore!.db.prepare(
          "UPDATE message_provenance SET trust_state = 'untrusted', updated_at = ? WHERE message_id = ?",
        ).run(durableUpdatedAt, provenance.messageId);
        ownStore!.db.prepare(
          'INSERT INTO message_provenance_conflicts '
          + '(audit_id, message_id, reason, existing_identity, incoming_identity, created_at) '
          + 'VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          randomUUID(), provenance.messageId, 'identity_conflict',
          JSON.stringify(existingRow), JSON.stringify(provenance), new Date().toISOString(),
        );
        return { ok: false, error: 'identity_conflict' };
      }
      if (existing.trustState === 'untrusted' && provenance.trustState === 'trusted') {
        return { ok: false, error: 'trust_elevation_refused' };
      }
      const durableUpdatedAt = laterIsoTimestamp(existing.updatedAt, provenance.updatedAt);
      ownStore!.db.prepare(
        'UPDATE message_provenance SET updated_at = ? WHERE message_id = ?',
      ).run(durableUpdatedAt, provenance.messageId);
      return { ok: true, value: { ...existing, updatedAt: durableUpdatedAt } };
    }
    ownStore!.db.prepare(
      'INSERT INTO message_provenance '
      + '(message_id, lark_app_id, chat_id, display_root_id, source_session_id, lane_id, '
      + 'session_id, turn_id, principal_key, worker_generation, direction, trust_state, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      provenance.messageId, provenance.larkAppId, provenance.chatId,
      provenance.displayRootId ?? null, provenance.sourceSessionId, provenance.laneId,
      provenance.sessionId, provenance.turnId, provenance.principalKey,
      provenance.workerGeneration, provenance.direction, provenance.trustState,
      provenance.createdAt, provenance.updatedAt,
    );
    return { ok: true, value: provenance };
  });
  if (!committed.ok) {
    if (committed.error === 'identity_conflict') {
      throw new Error('message provenance identity conflict');
    }
    throw new Error('message provenance trust elevation refused');
  }
  return committed.value;
}

function messageProvenanceIsDurablyDenied(messageId: string): boolean {
  if (!ownStore) return true;
  const fence = ownStore.db.prepare(
    'SELECT source_session_id FROM message_provenance_trust_fences WHERE message_id = ?',
  ).get(messageId) as { source_session_id: unknown } | undefined;
  // A message id is globally unique. A fence for another source is therefore
  // an identity conflict, not permission to ignore the fence.
  return fence !== undefined;
}

export function beginMessageProvenanceTrustAttempt(provenance: MessageProvenance): string {
  loadForWrite();
  if (!ownStore) throw new SessionStoreUnavailableError(
    new Error('owned app-scoped session store is not attached'),
  );
  const attemptId = randomUUID();
  runOwnedWriteTransaction(ownStore, true, () => {
    const existing = ownStore!.db.prepare(
      'SELECT message_id FROM message_provenance_trust_fences WHERE message_id = ?',
    ).get(provenance.messageId) as { message_id: string } | undefined;
    if (existing) throw new MessageProvenanceFencedError(provenance.messageId);
    ownStore!.db.prepare(
      'INSERT INTO message_provenance_trust_fences '
      + '(message_id, lark_app_id, source_session_id, session_id, turn_id, worker_generation, '
      + 'attempt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      provenance.messageId,
      provenance.larkAppId,
      provenance.sourceSessionId,
      provenance.sessionId,
      provenance.turnId,
      provenance.workerGeneration,
      attemptId,
      new Date().toISOString(),
    );
  });
  return attemptId;
}

export function completeMessageProvenanceTrustAttempt(
  provenance: MessageProvenance,
  attemptId: string,
): void {
  loadForWrite();
  if (!ownStore) throw new SessionStoreUnavailableError(
    new Error('owned app-scoped session store is not attached'),
  );
  runOwnedWriteTransaction(ownStore, true, () => {
    const result = ownStore!.db.prepare(
      'DELETE FROM message_provenance_trust_fences '
      + 'WHERE message_id = ? AND lark_app_id = ? AND source_session_id = ? '
      + 'AND session_id = ? AND turn_id = ? AND worker_generation = ? AND attempt_id = ?',
    ).run(
      provenance.messageId,
      provenance.larkAppId,
      provenance.sourceSessionId,
      provenance.sessionId,
      provenance.turnId,
      provenance.workerGeneration,
      attemptId,
    );
    if (Number(result.changes) !== 1) {
      throw new MessageProvenanceFencedError(provenance.messageId);
    }
  });
}

/** Releases only the exact trust-attempt fence after a proven pre-commit
 * failure (for example, a nonblocking SQLITE_BUSY before the trusted write
 * began). This must never be used for commit-unknown failures. */
export function abortMessageProvenanceTrustAttempt(
  provenance: MessageProvenance,
  attemptId: string,
): void {
  loadForWrite();
  if (!ownStore) throw new SessionStoreUnavailableError(
    new Error('owned app-scoped session store is not attached'),
  );
  runOwnedWriteTransaction(ownStore, false, () => {
    const result = ownStore!.db.prepare(
      'DELETE FROM message_provenance_trust_fences '
      + 'WHERE message_id = ? AND lark_app_id = ? AND source_session_id = ? '
      + 'AND session_id = ? AND turn_id = ? AND worker_generation = ? AND attempt_id = ?',
    ).run(
      provenance.messageId,
      provenance.larkAppId,
      provenance.sourceSessionId,
      provenance.sessionId,
      provenance.turnId,
      provenance.workerGeneration,
      attemptId,
    );
    if (Number(result.changes) !== 1) {
      throw new MessageProvenanceFencedError(provenance.messageId);
    }
  });
}

let testOnlyAfterProvenanceDenyFence: (() => void) | undefined;
export function __testOnly_setAfterProvenanceDenyFence(
  hook: (() => void) | undefined,
): void {
  testOnlyAfterProvenanceDenyFence = hook;
}

/** Permanently removes one message id from the trusted-reference surface.
 * This is used after the Lark API has already accepted an outbound message but
 * its trusted provenance commit could not be proved.  A second write may still
 * fail (for example while the store is unavailable); in that case the caller
 * must keep the transport success and fail closed when the message is later
 * referenced.  The explicit UPDATE covers the commit-unknown shape where the
 * first write actually committed a trusted row before throwing. */
export function markMessageProvenanceUntrusted(provenance: MessageProvenance): void {
  loadForWrite();
  if (!ownStore) throw new SessionStoreUnavailableError(
    new Error('owned app-scoped session store is not attached'),
  );
  // A surviving fence already makes the message unreadable and means the
  // earlier trusted commit outcome is unknown. Never convert that ambiguity
  // into a permanent downgrade of a possibly healthy trusted row.
  if (messageProvenanceIsDurablyDenied(provenance.messageId)) return;
  testOnlyAfterProvenanceDenyFence?.();
  const untrusted: MessageProvenance = { ...provenance, trustState: 'untrusted' };
  recordMessageProvenance(untrusted);
}

export function readTrustedMessageProvenance(
  messageId: string,
  sourceSessionId: string,
): MessageProvenance | undefined {
  loadForWrite();
  if (!ownStore) return undefined;
  if (messageProvenanceIsDurablyDenied(messageId)) return undefined;
  const bundle = readPrincipalLaneSource(sourceSessionId);
  if (!bundle || bundle.status !== 'ready') return undefined;
  const row = ownStore.db.prepare(
    "SELECT * FROM message_provenance WHERE message_id = ? AND trust_state = 'trusted'",
  ).get(messageId) as Record<string, unknown> | undefined;
  const provenance = row ? provenanceFromRow(row) : undefined;
  if (!provenance
      || provenance.sourceSessionId !== sourceSessionId
      || !provenanceMatchesDisplay(provenance, bundle.source.displayTarget)) return undefined;
  const laneHit = ownStore.db.prepare(
    'SELECT lane_id, session_id, principal_key, routing_anchor, workspace_epoch, '
    + 'phase, revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
  ).get(sourceSessionId, provenance.laneId) as PrincipalLaneSidecarRow | undefined;
  const lane = parseLaneSidecar(laneHit, {
    displayTarget: bundle.source.displayTarget,
    sourceSessionId,
  });
  if (!lane.ok
      || lane.value.sessionId !== provenance.sessionId
      || lane.value.binding.principalKey !== provenance.principalKey
      || bundle.source.phase !== 'active'
      || lane.value.binding.phase !== 'active'
      || lane.value.binding.workspaceEpoch !== bundle.source.workspaceEpoch) return undefined;
  return provenance;
}

/**
 * Persist one exact remote follow-up lineage for an active durable owner.
 * The process cache changes only after the durable write succeeds.
 */
export function persistActiveRemoteLineageExact(
  sessionId: string,
  taskId: string | null,
  options: {
    expectedCurrentTaskIds?: readonly (string | null)[];
    expectedOwner?: RemoteDurableOwner;
  } = {},
): Session {
  const applyChecksAndBuildNext = (durable: Session | undefined): Session => {
    if (!durable || durable.status !== 'active') {
      throw new RemoteLineageOwnershipError(
        `cannot persist remote lineage for non-active session ${sessionId}`,
      );
    }
    const durableTaskId = durable.riffParentTaskId ?? null;
    const expected = options.expectedCurrentTaskIds;
    if (expected && !expected.some(candidate => candidate === durableTaskId)) {
      throw new RemoteLineageOwnershipError(
        `Remote lineage compare-and-set failed for ${sessionId} `
        + `(current=${durableTaskId ?? 'none'}, expected=${expected.map(id => id ?? 'none').join('|')})`,
      );
    }
    if (options.expectedOwner && !remoteOwnersEqual(remoteDurableOwner(durable), options.expectedOwner)) {
      throw new RemoteLineageOwnershipError(
        `Remote owner compare-and-set failed for ${sessionId} `
        + `(current=${JSON.stringify(remoteDurableOwner(durable))}, `
        + `expected=${JSON.stringify(options.expectedOwner)})`,
      );
    }
    const next: Session = {
      ...durable,
      riffParentTaskId: taskId ?? undefined,
    };
    return next;
  };

  const publishToCache = (next: Session): Session => {
    const cached = sessions.get(sessionId);
    if (cached) {
      cached.riffParentTaskId = taskId ?? undefined;
      return cached;
    }
    sessions.set(sessionId, next);
    return next;
  };

  return withOwnStoreDb((db): Session => {
    const select = db.prepare('SELECT row FROM sessions WHERE session_id = ?');
    let inTxn = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      inTxn = true;
      const hit = select.get(sessionId) as { row: string } | undefined;
      const next = applyChecksAndBuildNext(hit ? JSON.parse(hit.row) as Session : undefined);
      const json = JSON.stringify(next);
      if (json !== hit!.row) {
        testOnlyBeforeRowPersist?.(sessionId);
        db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?')
          .run(sessionStatusText(next), json, sessionId);
      }
      db.exec('COMMIT');
      inTxn = false;
      return publishToCache(next);
    } catch (err) {
      if (inTxn) { try { db.exec('ROLLBACK'); } catch { /* txn already gone */ } }
      throw err;
    }
  });
}

export function listSessions(): Session[] {
  load();
  migrateCodexInstanceBindings();
  return [...sessions.values()];
}

/**
 * Return the current projection only when its backing store was loaded safely.
 * Use this for decisions that delete, retire, or reconfigure resources: the
 * legacy empty-on-error behaviour of listSessions() is unsafe at those gates.
 * A failed load remains unhealthy until init() explicitly selects/reloads a
 * store, avoiding a silent mid-transaction recovery against a different view.
 */
export function listSessionsStrict(): Session[] {
  load();
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
  migrateCodexInstanceBindings();
  return [...sessions.values()];
}

/** Read-only configuration-change guard; unlike display snapshots, malformed rows fail closed. */
export function readBotSessionsStrict(appId: string, dataDir = config.session.dataDir): Session[] {
  const result: Session[] = [];
  for (const id of [undefined, appId]) {
    const ref = resolveStoreFile(id, dataDir);
    if (!existsSync(ref.path)) continue;
    if (ref.kind === 'json') {
      const parsed = JSON.parse(readFileSync(ref.path, 'utf8')) as Record<string, Session>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid session store');
      result.push(...Object.values(parsed).filter(s => id === appId || s.larkAppId === appId));
    } else {
      const db = openDbForRead(ref.path);
      try {
        const rows = db.prepare('SELECT row FROM sessions').all() as { row: string }[];
        result.push(...rows.map(row => JSON.parse(row.row) as Session).filter(s => id === appId || s.larkAppId === appId));
      } finally { db.close(); }
    }
  }
  return result;
}

/**
 * Cross-file lookup: find every active session attached to a thread, across
 * all bots. Used when a not-yet-initialized bot is mentioned in a thread that
 * another bot has already pinned to a working directory — the new bot inherits
 * the pinned dir instead of re-prompting the user for repo selection.
 *
 * Reads other bots' session stores directly (best-effort) instead of relying
 * on any in-memory state, since each daemon process only owns its own bot.
 */
export function findActiveSessionsByRoot(rootMessageId: string): Session[] {
  return findActiveSessionsMatching(
    s => s.rootMessageId === rootMessageId,
    { rootMessageId },
  );
}

/**
 * Cross-file lookup: find every active chat-scope session for a chat, across
 * all bots. Mirror of findActiveSessionsByRoot for chat-scope (普通群整群一会话):
 * lets a not-yet-initialised bot inherit the workingDir from a peer bot that
 * already has a chat-scope session in the same chat, so a `botmux send
 * --mention <other-bot>` in 普通群 can spawn the second bot without bouncing
 * through the repo-select card.
 *
 * Only returns scope='chat' sessions — thread-scope sessions in the same chat
 * are routed by rootMessageId and not eligible for chat-scope inheritance.
 */
export function findActiveChatScopeSessionsByChat(chatId: string): Session[] {
  return findActiveSessionsMatching(
    s => s.chatId === chatId && s.scope === 'chat',
    { chatScopeChatId: chatId },
  );
}

export function findActiveSessionsByWorkingDir(workingDir: string): Session[] {
  return findActiveSessionsMatching(s => s.workingDir === workingDir);
}

/** Destructive-worktree inventory: unlike ordinary discovery this is fail-closed. */
export function findActiveSessionsByWorkingDirStrict(workingDir: string): Session[] {
  load();
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
  const target = resolve(workingDir);
  const matches: Session[] = [];
  const targetReal = realpathSync(target);
  const matchesDir = (session: Session) => {
    if (session.status !== 'active' || !session.workingDir) return false;
    let candidate: string;
    try { candidate = realpathSync(resolve(session.workingDir)); }
    catch { candidate = resolve(session.workingDir); }
    const rel = relative(targetReal, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  for (const session of sessions.values()) if (matchesDir(session)) matches.push(session);
  for (const ref of listStoreRefs(config.session.dataDir, { strict: true })) {
    if (ref.appId === currentAppId) continue;
    for (const session of readStoreActiveRows(ref, undefined, { strict: true })) {
      if (matchesDir(session)) matches.push(session);
    }
  }
  return matches;
}

/**
 * Cross-store lookup: every active thread-scope session in `chatId`, across
 * all bots. Backs `schedule add --follow-active`: at fire time the scheduler
 * needs "the topic in this chat where a human most recently spoke", and that
 * person may have been talking to a different bot — the bot boundary is a
 * property of the daemon layout, not of the human, so the lookup must not
 * stop at the current store.
 *
 * Chat-scope sessions are excluded (they have no topic to land in), as are
 * rows whose rootMessageId is missing or equals the chat id.
 */
export function findActiveThreadSessionsByChat(chatId: string): Session[] {
  return findActiveSessionsMatching(
    s => s.chatId === chatId
      && s.scope !== 'chat'
      && typeof s.rootMessageId === 'string'
      && s.rootMessageId.length > 0
      && s.rootMessageId !== chatId,
    { threadScopeChatId: chatId },
  );
}

/**
 * Count active sessions across every bot's on-disk session store. A pure disk
 * read (no in-memory state) so it's correct at daemon startup regardless of
 * which bot owns this process — used by the restart-report DM after a restart.
 */
export function countActiveSessionsOnDisk(dataDir: string = config.session.dataDir): number {
  let refs: StoreFileRef[];
  try {
    refs = listStoreRefs(dataDir);
  } catch { return 0; /* missing dir → 0 */ }
  let n = 0;
  for (const ref of refs) {
    try {
      if (ref.kind === 'sqlite') {
        const db = openDbForRead(ref.path);
        try {
          const hit = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'").get() as { n: number };
          n += hit.n;
        } finally {
          db.close();
        }
      } else {
        const data: Record<string, Session> = JSON.parse(readFileSync(ref.path, 'utf-8'));
        for (const s of Object.values(data)) if (s?.status === 'active') n++;
      }
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      continue;
    }
  }
  return n;
}

/**
 * Collect every CLI session identity botmux has ever recorded — across ALL bot
 * stores, ANY status (active or closed). Returns both each session's botmux
 * `sessionId` (which, for claude-family, IS the on-disk jsonl filename since
 * botmux spawns with `--session-id <id>`) and its `cliSessionId` (the
 * CLI-native id after any resume/rotation, e.g. a codex/traex rollout id).
 *
 * Used by `/adopt`'s resume-import discovery to hide sessions botmux already
 * manages — live OR closed — so the picker surfaces only genuinely external
 * sessions (a CLI the user ran standalone). Closed botmux sessions remain
 * resumable via their own session-closed cards.
 */
export function collectBotmuxSessionIdentities(dataDir: string = config.session.dataDir): Set<string> {
  const ids = new Set<string>();
  const add = (s: Session | undefined) => {
    if (!s) return;
    if (s.sessionId) ids.add(s.sessionId);
    if (s.cliSessionId) ids.add(s.cliSessionId);
  };
  // In-memory first (freshest — covers ids not yet flushed to disk).
  load();
  for (const s of sessions.values()) add(s);
  // Then every bot's persisted store (other daemons own their own stores).
  let refs: StoreFileRef[];
  try {
    refs = listStoreRefs(dataDir);
  } catch { return ids; /* missing dir → in-memory only */ }
  for (const ref of refs) {
    try {
      for (const [, s] of readStoreEntries(ref)) add(s);
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      continue;
    }
  }
  return ids;
}

// ─── Cross-process offline access ───────────────────────────────────────────
// The only sanctioned ways to touch session rows from OUTSIDE the owning
// daemon process (agent-facing CLI subcommands, caller-identity proofs). Until
// 2026-08 the CLI kept its own parallel copies of these (loadSessions /
// saveSession / mutateSessionOffline in cli.ts) — one of which wrote the whole
// file WITHOUT the lock; they were absorbed here so persistence mechanics
// (store layout, lock/transaction, legacy-field strip) stay private to this
// module. Every entry point resolves each store as db-else-json (mixed
// upgrade window: npm already replaced dist, daemon still running old code).

/**
 * Read-only snapshot of every session row across the legacy store and all
 * per-bot stores. Per-bot rows win duplicate sessionIds and get `larkAppId`
 * stamped from their filename so a later offline mutation resolves the owning
 * store. Deliberately lock-free: atomic publication (tmp+rename for JSON,
 * WAL transactions for SQLite) keeps each store self-consistent, and snapshot
 * composition must stay a pure reader (an older CLI opportunistically migrated
 * legacy rows here, which made even `botmux list` a whole-file writer able to
 * race a daemon save).
 */
export function loadAllSessionsSnapshot(options: {
  dataDir?: string;
  /** Per-bot fallback when the data dir cannot be enumerated (the CLI file
   *  sandbox exposes this bot's own store but NOT a listing of data/). */
  fallbackAppId?: string;
} = {}): Map<string, Session> {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const out = new Map<string, Session>();
  const readInto = (ref: StoreFileRef): void => {
    let entries: [string, Session][];
    try {
      entries = readStoreEntries(ref);
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      return; /* absent or corrupt store → skip */
    }
    // Arrays are deliberately tolerated on the JSON side (Object.entries
    // yields their rows): the historical CLI loader accepted array-shaped
    // files and existing fixtures/tools rely on that.
    for (const [, value] of entries) {
      const session = value as Session;
      if (!session || typeof session !== 'object' || !session.sessionId) continue;
      repairMissingChatScope(session);
      if (ref.appId && !session.larkAppId) session.larkAppId = ref.appId;
      out.set(session.sessionId, session);
    }
  };
  readInto(resolveStoreFile(undefined, dataDir));
  let refs: StoreFileRef[];
  try {
    refs = listStoreRefs(dataDir);
  } catch {
    if (options.fallbackAppId) {
      readInto(resolveStoreFile(options.fallbackAppId, dataDir));
    }
    return out;
  }
  for (const ref of refs) {
    if (ref.appId) readInto(ref);
  }
  return out;
}

/**
 * Unlocked point-read of one row straight from disk, bypassing this process's
 * in-memory cache: the owning per-bot store first, then the legacy store.
 * Atomic publication keeps each store self-consistent, so this never blocks
 * on (or throws from) the store lock — safe on hot paths that only need a
 * freshness hint.
 */
export function readSessionRowFromDisk(
  sessionId: string,
  larkAppId?: string,
  dataDir: string = config.session.dataDir,
): Session | undefined {
  const stores = larkAppId
    ? [resolveStoreFile(larkAppId, dataDir), resolveStoreFile(undefined, dataDir)]
    : [resolveStoreFile(undefined, dataDir)];
  for (const ref of stores) {
    if (!existsSync(ref.path)) continue;
    try {
      const hit = readStoreRowByKey(ref, sessionId);
      if (hit) return hit;
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      /* ignore corrupt/racing session store */
    }
  }
  return undefined;
}

/**
 * Fail-closed identity scan: every store's copy of one session row across the
 * legacy and all per-bot stores — one entry per store that holds the id (a
 * per-bot store is its .db when that exists, else its .json; a frozen
 * pre-import JSON file is superseded, not a second copy). An unlistable data
 * dir THROWS: a caller proving "this row resolves exactly once" must not
 * mistake an unreadable store for an empty one. A corrupt individual store is
 * skipped: an unrelated bot's bad file must neither block nor impersonate a
 * valid record; the target row still has to resolve from a readable store.
 */
export function readSessionRowCopiesAcrossStores(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): Session[] {
  const refs = listStoreRefs(dataDir, { strict: true });
  const matches: Session[] = [];
  for (const ref of refs) {
    let session: Session | undefined;
    try {
      session = readStoreRowByKey(ref, sessionId);
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      continue;
    }
    if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
    if (session.sessionId !== sessionId) continue;
    matches.push(session);
  }
  return matches;
}

// ─── Temporary host activation (daemon absent) ──────────────────────────────
//
// A process that owns no store may still act on one exact row while no daemon
// holds it: `botmux delete` / `list` auto-prune / `whiteboard` from a host
// shell, and the dashboard's board deletion. The activation is ONE exclusive
// store transaction — the SQLite `BEGIN IMMEDIATE`, or the shared file lock of
// a store still on JSON (upgrade window) — inside which ownership is judged,
// the FRESH row is read, the shared command apply (session-commands.ts) runs,
// and the row is published. Nothing else is expressible here: there is no
// closure that could write an arbitrary field list.
//
// SQLite ownership is the occupancy row read in this same transaction. A live
// lease yields. Without one (row absent or expired) `abortIf` — the
// descriptor-heartbeat probe, also a test hook — still decides; that is the
// upgrade window for daemons that write SQLite but not occupancy. `abortIf`
// is evaluated at entry and again immediately before publication (the lease
// row itself cannot change under this transaction). JSON stores use `abortIf`
// only (no occupancy table). SQLite's own locking does NOT replace occupancy:
// it orders writers, but cannot detect that a daemon holding a stale
// in-memory cache has come alive.
//
// No lease row is written by the temporary host: a claim + release inside a
// single exclusive transaction is unobservable to every other connection, and
// holding one ACROSS the steps of a multi-step command (the offline abandon)
// would only leave a daemon that boots meanwhile `displaced` until its next
// heartbeat tick. Each step re-judges ownership in its own transaction.

/** Why the activation yielded without touching the row. */
export type UnownedRowBlocked =
  /** A live lease, or a fresh heartbeat while no live lease exists, holds the store. */
  | { outcome: 'owned' }
  /** No such row — or no store file at all (never created here: an empty
   *  store would disable the daemon's one-shot JSON import gate). */
  | { outcome: 'missing' }
  /** The store's write lock could not be taken (another writer holds it past
   *  busy_timeout / the file-lock wait). Same "do not publish" as `owned`;
   *  reported apart so a caller never claims a live row is gone. */
  | { outcome: 'contended' };

export type UnownedRowRead =
  | { outcome: 'ok'; row: Session }
  | UnownedRowBlocked;

export type UnownedRowApply =
  | { outcome: 'applied'; row: Session; released: SessionRowReleased }
  | { outcome: 'noop'; row: Session }
  | { outcome: 'refused'; reason: SessionRowRefusal | 'row_changed'; row: Session }
  | UnownedRowBlocked;

type UnownedRowOptions = { dataDir?: string; abortIf?: () => boolean };

/** One step over the fresh row: whether to publish it, and what to report. */
type UnownedRowStep<T> = (current: Session) => { publish: boolean; result: T };

function runUnownedRowTxn<T>(
  target: { sessionId: string; larkAppId?: string },
  options: UnownedRowOptions,
  step: UnownedRowStep<T>,
): T | UnownedRowBlocked {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const ref = resolveStoreFile(target.larkAppId, dataDir);

  if (ref.kind === 'sqlite') {
    // resolveStoreFile already probed existsSync, but a read-write open CREATES
    // a missing file. The window between that probe and this open must not
    // plant an empty store: that would make the daemon's import gate skip the
    // one-shot JSON import and silently drop every pre-SQLite row.
    if (!existsSync(ref.path)) return { outcome: 'missing' };
    let db: SqliteDatabaseLike | undefined;
    let inTxn = false;
    try {
      // openDbForOwnStore (schema ensure) and BEGIN IMMEDIATE both take the
      // write lock. Contention here is "someone else is publishing", not a
      // broken store — same yield as a live occupancy row.
      db = openDbForOwnStore(ref.path);
      db.exec('BEGIN IMMEDIATE');
      inTxn = true;
      const lease = readOccupancyInTxn(db);
      if (sqliteOccupancyBlocksWrite(lease, Date.now(), options.abortIf)) return { outcome: 'owned' };
      const hit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(target.sessionId) as { row: string } | undefined;
      if (!hit) return { outcome: 'missing' };
      const current = JSON.parse(hit.row) as Session;
      const { publish, result } = step(current);
      if (!publish) return result;
      if (sqliteOccupancyBlocksWrite(lease, Date.now(), options.abortIf)) return { outcome: 'owned' };
      db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?')
        .run(sessionStatusText(current), JSON.stringify(current), target.sessionId);
      db.exec('COMMIT');
      inTxn = false;
      return result;
    } catch (err) {
      if (isTransientStoreContentionError(err)) return { outcome: 'contended' };
      throw err;
    } finally {
      if (inTxn) { try { db?.exec('ROLLBACK'); } catch { /* txn already gone */ } }
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  // Upgrade window: this store's owning daemon still runs the pre-SQLite build
  // and keeps writing the JSON, so an offline command has to land there too —
  // creating a .db here would fork the two representations behind that daemon's
  // back. Same file lock the old build takes.
  const fp = ref.path;
  try {
    return withFileLockSync(fp, (): T | UnownedRowBlocked => {
      if (options.abortIf?.()) return { outcome: 'owned' };
      let data: Record<string, Session> = {};
      if (existsSync(fp)) {
        try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { /* start fresh */ }
      }
      const current = data[target.sessionId];
      if (!current) return { outcome: 'missing' };
      const { publish, result } = step(current);
      if (!publish) return result;
      data[target.sessionId] = current;
      for (const [key, val] of Object.entries(data)) {
        if (val && typeof val === 'object' && 'sessionId' in val && (val as Session).sessionId !== key) {
          delete data[key];
          continue;
        }
        if (val && typeof val === 'object') stripLegacyPendingCardFields(val as unknown as Record<string, unknown>);
      }
      if (options.abortIf?.()) return { outcome: 'owned' };
      const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmpFp, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpFp, fp);
      return result;
    });
  } catch (err) {
    if (isTransientStoreContentionError(err)) return { outcome: 'contended' };
    throw err;
  }
}

function sessionRowIsAdopted(row: Session): boolean {
  return !!row.adoptedFrom && typeof row.adoptedFrom === 'object';
}

/**
 * Exclusion-ordered fresh read of one exact row while no daemon holds its
 * store. This is an ownership check that happens not to write, not a plain
 * point-read: it yields `owned` under exactly the rules of the apply below,
 * so a multi-step host command (abandon: stop the worker, destroy the
 * backing, close) can re-judge ownership before each irreversible step.
 */
export function readSessionRowUnowned(
  target: { sessionId: string; larkAppId?: string },
  options: UnownedRowOptions = {},
): UnownedRowRead {
  return runUnownedRowTxn(target, options, current => ({
    publish: false,
    result: { outcome: 'ok' as const, row: current },
  }));
}

/**
 * Apply one host command to the FRESH row of its owning store (per-bot when the
 * caller-observed row carries `larkAppId`, the legacy store otherwise) while
 * no daemon holds it, and publish the result. The caller's snapshot is never
 * written back.
 *
 * `expectAdopted` is a fail-closed precondition for multi-step host commands:
 * the row must still be (non-)adopted exactly as the caller last read it,
 * otherwise the step is `refused` with `row_changed`.
 */
export function applySessionCommandUnowned(
  target: { sessionId: string; larkAppId?: string },
  command: HostSessionCommand,
  options: UnownedRowOptions & { expectAdopted?: boolean } = {},
): UnownedRowApply {
  return runUnownedRowTxn<UnownedRowApply>(target, options, current => {
    if (options.expectAdopted !== undefined && sessionRowIsAdopted(current) !== options.expectAdopted) {
      return { publish: false, result: { outcome: 'refused', reason: 'row_changed', row: current } };
    }
    const applied = applySessionRowCommand(current, command, { now: new Date() });
    if (applied.outcome === 'applied') {
      return { publish: true, result: { outcome: 'applied', row: current, released: applied.released } };
    }
    return { publish: false, result: { ...applied, row: current } };
  });
}

function findActiveSessionsMatching(
  predicate: (s: Session) => boolean,
  hint?: { rootMessageId?: string; chatScopeChatId?: string; threadScopeChatId?: string },
): Session[] {
  load();
  const matches: Session[] = [];
  for (const s of sessions.values()) {
    if (predicate(s) && s.status === 'active') matches.push(s);
  }
  const dataDir = config.session.dataDir;
  let refs: StoreFileRef[];
  try {
    refs = listStoreRefs(dataDir);
  } catch { return matches; }
  for (const ref of refs) {
    if (ref.appId === currentAppId) continue;
    try {
      for (const s of readStoreActiveRows(ref, hint)) {
        if (predicate(s) && s.status === 'active') matches.push(s);
      }
    } catch (err) {
      if (err instanceof SessionStoreSqliteUnavailableError) throw err;
      continue;
    }
  }
  return matches;
}
