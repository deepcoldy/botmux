import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { DAEMON_HEARTBEAT_STALE_MS } from '../utils/daemon-heartbeat.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { getSessionTokenUsage } from '../core/cost-calculator.js';
import { deleteFrozenCards } from './frozen-card-store.js';
import { removePromptContextDir } from './prompt-context-store.js';
import {
  openDatabaseSyncOrThrow,
  sqliteEngineAvailable,
  type DatabaseSyncLike,
  type StatementLike,
} from './sqlite-compat.js';
import type { Session } from '../types.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;
let currentAppId: string | undefined;
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
  db.exec(OCCUPANCY_SCHEMA_SQL);
  return db;
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
  upsert: SqliteStatementLike;
}
let ownStore: OwnSqliteStore | undefined;

/** Lock/busy contention is retryable. Swallowing it into loadFailure would let
 *  the daemon start with an empty cache while the durable store is healthy. */
function isTransientStoreContentionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|file-lock timeout/i.test(message);
}

function attachOwnStore(path: string): OwnSqliteStore {
  const db = openDbForOwnStore(path);
  ownStore = {
    db,
    selectRow: db.prepare('SELECT row FROM sessions WHERE session_id = ?'),
    selectAll: db.prepare('SELECT session_id, row FROM sessions'),
    upsert: db.prepare(
      'INSERT INTO sessions (session_id, status, row) VALUES (?, ?, ?) '
      + 'ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, row = excluded.row',
    ),
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
/** Failure injection for the SQLite row write (the JSON engine was injectable
 *  through a node:fs mock; the sqlite-compat handle bypasses node:fs). */
export function __testOnly_setBeforeRowPersist(hook: ((sessionId: string) => void) | undefined): void {
  testOnlyBeforeRowPersist = hook;
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
): Session[] {
  if (ref.kind === 'json') {
    const parsed = JSON.parse(readFileSync(ref.path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.values(parsed as Record<string, Session>).filter(s => s?.status === 'active');
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
      try { out.push(JSON.parse(r.row) as Session); } catch { /* skip unparseable row */ }
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
export function init(appId?: string, opts: { owner?: boolean; occupancy?: OccupancyHolder } = {}): void {
  currentAppId = appId;
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
  const json = JSON.stringify(session);
  const existing = ownStore.selectRow.get(session.sessionId) as { row: string } | undefined;
  if (existing?.row === json) return;
  ownStore.upsert.run(session.sessionId, sessionStatusText(session), json);
}

export function createSession(
  chatId: string,
  rootMessageId: string,
  title: string,
  chatType?: 'group' | 'p2p',
  scope?: 'thread' | 'chat',
): Session {
  loadForWrite();
  const session: Session = {
    sessionId: randomUUID(),
    chatId,
    chatType,
    rootMessageId,
    scope,
    title,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.sessionId, session);
  persistRow(session);
  logger.info(`Created session ${session.sessionId} (thread: ${rootMessageId})`);
  return session;
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
    // The materialised images are cleaned up AFTER the row commits, so the list
    // has to be read before it is dropped from the row. Not a rollback copy —
    // the durable-first commit below has nothing to undo.
    const priorDashboardAttachments = session.dashboardAttachments;
    // Durable first: build the closed row, commit it, and only then merge it
    // into the live object. A failed write leaves the session exactly as it
    // was, including any prior tokenUsage snapshot.
    const next: Session = { ...session };
    next.status = 'closed';
    next.closedAt = new Date().toISOString();
    try {
      const tokenUsage = getSessionTokenUsage({
        cliId: session.cliId ?? 'unknown',
        sessionId: session.sessionId,
        cliSessionId: session.cliSessionId,
        cwd: session.workingDir,
        larkAppId: session.larkAppId,
        fresh: true,
      });
      if (tokenUsage !== null) next.tokenUsage = tokenUsage;
      else if (next.tokenUsage === undefined) next.tokenUsage = null;
    } catch (err: any) {
      logger.warn(`Failed to snapshot token usage for session ${sessionId}: ${err?.message ?? err}`);
      if (next.tokenUsage === undefined) next.tokenUsage = null;
    }
    next.dashboardAttachments = undefined;
    next.queuedAttachments = undefined;
    // `previewTarget` is a live loopback (host, port) the session's agent
    // registered with `botmux preview <port>` for its CURRENT worker
    // generation — routing state, not a durable property of the conversation.
    // A closed session owns no port any more, and the OS is free to hand that
    // number to an unrelated local server; the preview proxy dials a target by
    // host/port alone, so a retained value would let a later reader (resume,
    // an offline row copy, a dashboard snapshot) proxy the user into someone
    // else's service. Drop it in the same atomic save as status='closed'.
    // Cleanup only: registration and proxying are untouched, and a resumed
    // session simply re-runs `botmux preview <port>`.
    next.previewTarget = undefined;
    next.mojoCloseJournal = undefined;
    // Survives close on purpose — the containment handle is still in the durable
    // store, so the row must keep reporting the residual until the handle clears.
    if (opts.parkLocalResidual) next.mojoLocalResidual = opts.parkLocalResidual;
    if (opts.parkMojoLineage) {
      // Keep both ids when a different one was already parked: each is the only
      // handle left for manual cleanup of its remote session.
      const already = next.mojoQuarantinedLineage;
      next.mojoQuarantinedLineage = already && already !== opts.parkMojoLineage
        ? `${already},${opts.parkMojoLineage}`
        : opts.parkMojoLineage;
      next.mojoQuarantineNoticePending = true;
    }
    // Riff cancellation has already completed before this durable transition.
    // Clear its retry handle in the same atomic save as status='closed'.
    if (opts.clearRiffParentTaskId) next.riffParentTaskId = undefined;
    persistRow(next);
    Object.assign(session, next);
    if (session.larkAppId && priorDashboardAttachments?.length) {
      try {
        cleanupMaterializedDashboardImages(session.larkAppId, priorDashboardAttachments);
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
  next.pendingRepoSetup = undefined;
  next.previewTarget = undefined;
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
  sessions.set(session.sessionId, session);
  persistRow(session);
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
  return [...sessions.values()];
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

/**
 * Locked offline mutation of one exact row in its owning store (per-bot when
 * the caller-observed row carries `larkAppId`, the legacy store otherwise).
 * Re-reads the row under the owning store's write exclusion — the SQLite
 * store's `BEGIN IMMEDIATE` transaction, or the shared file lock for a store
 * still on JSON — and hands the FRESH copy to `mutate`, never publishing the
 * caller's possibly-stale snapshot.
 *
 * SQLite ownership is the occupancy row read in this same `BEGIN IMMEDIATE`
 * transaction. A live lease aborts the write. Without one (row absent or
 * expired) `abortIf` — the descriptor-heartbeat probe, also a test hook —
 * still decides; that is the upgrade window for daemons that write SQLite
 * but not occupancy. `abortIf` is evaluated at entry and again immediately
 * before publication (the lease row itself cannot change under this
 * transaction). JSON stores use `abortIf` only (no occupancy table).
 * SQLite's own locking does NOT replace occupancy: it orders writers, but
 * cannot detect that a daemon holding a stale in-memory cache has come alive.
 *
 * Returns the fresh row — mutated when `mutate` returned true, otherwise
 * unmodified (so `() => false` is an exclusion-ordered fresh read) — or
 * undefined when the row is absent, `abortIf` aborted, or the store's write
 * lock could not be taken (another writer holds `BEGIN IMMEDIATE` past
 * busy_timeout). Lock contention is the same clean yield as a held lease:
 * the caller must not publish, and the CLI must not throw a stack. Other
 * errors (missing engine, corrupt file) still surface.
 */
export function mutateSessionRowOffline(
  target: { sessionId: string; larkAppId?: string },
  mutate: (current: Session) => boolean,
  options: { dataDir?: string; abortIf?: () => boolean } = {},
): Session | undefined {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const ref = resolveStoreFile(target.larkAppId, dataDir);

  if (ref.kind === 'sqlite') {
    // resolveStoreFile already probed existsSync, but a read-write open CREATES
    // a missing file. The window between that probe and this open must not
    // plant an empty store: that would make the daemon's import gate skip the
    // one-shot JSON import and silently drop every pre-SQLite row.
    if (!existsSync(ref.path)) return undefined;
    let db: SqliteDatabaseLike | undefined;
    let inTxn = false;
    try {
      // openDbForOwnStore (schema ensure) and BEGIN IMMEDIATE both take the
      // write lock. Contention here is "someone else is publishing", not a
      // broken store — same abort as a live occupancy row.
      db = openDbForOwnStore(ref.path);
      db.exec('BEGIN IMMEDIATE');
      inTxn = true;
      const lease = readOccupancyInTxn(db);
      if (sqliteOccupancyBlocksWrite(lease, Date.now(), options.abortIf)) return undefined;
      const hit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(target.sessionId) as { row: string } | undefined;
      if (!hit) return undefined;
      const current = JSON.parse(hit.row) as Session;
      if (!mutate(current)) return current;
      if (sqliteOccupancyBlocksWrite(lease, Date.now(), options.abortIf)) return undefined;
      db.prepare('UPDATE sessions SET status = ?, row = ? WHERE session_id = ?')
        .run(sessionStatusText(current), JSON.stringify(current), target.sessionId);
      db.exec('COMMIT');
      inTxn = false;
      return current;
    } catch (err) {
      if (isTransientStoreContentionError(err)) return undefined;
      throw err;
    } finally {
      if (inTxn) { try { db?.exec('ROLLBACK'); } catch { /* txn already gone */ } }
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  // Upgrade window: this store's owning daemon still runs the pre-SQLite build
  // and keeps writing the JSON, so an offline mutation has to land there too —
  // creating a .db here would fork the two representations behind that daemon's
  // back. Same file lock the old build takes.
  const fp = ref.path;
  return withFileLockSync(fp, () => {
    if (options.abortIf?.()) return undefined;
    let data: Record<string, Session> = {};
    if (existsSync(fp)) {
      try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { /* start fresh */ }
    }
    const current = data[target.sessionId];
    if (!current || !mutate(current)) return current;
    data[target.sessionId] = current;
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === 'object' && 'sessionId' in val && (val as Session).sessionId !== key) {
        delete data[key];
        continue;
      }
      if (val && typeof val === 'object') stripLegacyPendingCardFields(val as unknown as Record<string, unknown>);
    }
    if (options.abortIf?.()) return undefined;
    const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpFp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpFp, fp);
    return current;
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
