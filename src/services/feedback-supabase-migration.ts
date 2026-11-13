import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { chmod, mkdir, open, readdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock, FileLockTimeoutError } from '../utils/file-lock.js';
import type { FeedbackStorageConfig, FeedbackStorageTarget, SupabaseTarget } from './feedback-storage-types.js';
import { readFeedbackStorageConfig, readFeedbackStorageSecret, readPostgresCredential } from './feedback-storage-config.js';
import { FEEDBACK_TABLES } from './feedback-tables.js';
import { beginFeedbackMaintenance, currentFeedbackMaintenance, inspectFeedbackMaintenance, freezeFeedbackSource,
  retireFeedbackSource, restoreFeedbackSource, releaseFeedbackMaintenance, cancelFeedbackMaintenance } from './feedback-maintenance.js';
import { canonicalFeedbackRow, createFeedbackSnapshot, feedbackRows, workingFeedbackSnapshot } from './feedback-snapshot.js';
import { validateRecoveryDecision, recoveryAcknowledged, webhookRecoveryFingerprint, type RecoveryDecision } from './feedback-recovery.js';
import { openDatabaseSync, type DatabaseSyncLike } from './sqlite-compat.js';
import type { SupabaseFeedbackClient } from './feedback-supabase-store.js';

type Row = Record<string, unknown>;
const optionalTables = ['feedback_event_stream', 'feedback_event_stream_counter'] as const;
type Table = typeof FEEDBACK_TABLES[number] | typeof optionalTables[number];
type Phase = 'preflight' | 'draining' | 'frozen' | 'snapshot' | 'importing' | 'verifying' | 'retiring'
  | 'activating' | 'complete' | 'blocked' | 'cancelling' | 'cancelled';
interface PendingOperation {
  operation: 'prepare' | 'import' | 'retire' | 'activate';
  table?: Table;
  offset?: number;
  count?: number;
}
export interface SupabaseFeedbackMigration {
  migrationId: string;
  requestId: string;
  phase: Phase;
  expectedGeneration: number;
  sourceInstanceId: string;
  source: FeedbackStorageTarget;
  sourceConfig: FeedbackStorageConfig;
  configFingerprint: string;
  sourceFreezeId: string;
  target: { backend: 'supabase'; supabase: SupabaseTarget };
  sourceFingerprint?: string;
  snapshotPath?: string;
  sqliteSnapshotPath?: string;
  sourceMeta?: Row;
  sourceIdentity?: { dev: number; ino: number };
  pending?: PendingOperation;
  imported: Partial<Record<Table, number>>;
  verified?: boolean;
  sourceRetired?: boolean;
  targetGeneration?: number;
  snapshotInvalidated?: boolean;
  blockers: string[];
  cancellation?: RecoveryDecision & { at: string };
}
interface Snapshot {
  version: 1;
  instanceId: string;
  configFingerprint: string;
  sourceMeta: Row;
  tables: Partial<Record<Table, Row[]>>;
}
const terminal = (job: SupabaseFeedbackMigration) => job.phase === 'complete' || job.phase === 'cancelled';
const identityPattern = /^[A-Za-z0-9_-]{1,100}$/;
const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right))) : child);

async function directory(dataDir: string, create = true): Promise<string> {
  if (create) await mkdir(dataDir, { recursive: true });
  const root = await realpath(dataDir);
  const path = join(root, 'feedback-supabase-migrations');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path) throw new Error('feedback_migration_directory_invalid');
  if (create) await chmod(path, 0o700);
  return path;
}
function jobPath(root: string, identity: string): string {
  if (!identityPattern.test(identity)) throw new Error('feedback_migration_id_invalid');
  return join(root, `${identity}.json`);
}
async function privateRead(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error('feedback_migration_file_invalid');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function save(dataDir: string, job: SupabaseFeedbackMigration): Promise<void> {
  await atomicWriteFile(jobPath(await directory(dataDir), job.migrationId), JSON.stringify(job), {
    mode: 0o600, durable: true, followTargetSymlink: false,
  });
}
export async function getSupabaseFeedbackMigration(dataDir: string, identity: string): Promise<SupabaseFeedbackMigration> {
  const job = JSON.parse((await privateRead(jobPath(await directory(dataDir, false), identity))).toString()) as SupabaseFeedbackMigration;
  if (job.migrationId !== identity || !identityPattern.test(job.sourceFreezeId) || !job.sourceConfig
    || job.target?.backend !== 'supabase' || !Array.isArray(job.blockers) || !job.imported
    || !['preflight', 'draining', 'frozen', 'snapshot', 'importing', 'verifying', 'retiring', 'activating', 'complete', 'blocked', 'cancelling', 'cancelled'].includes(job.phase)
    || typeof job.requestId !== 'string' || typeof job.sourceInstanceId !== 'string'
    || !['sqlite', 'postgresql'].includes(job.source?.backend)
    || hash(stable(job.sourceConfig)) !== job.configFingerprint
    || stable(job.sourceConfig.active) !== stable(job.source) || stable(job.sourceConfig.candidate) !== stable(job.target)
    || job.sourceConfig.instanceId !== job.sourceInstanceId || job.sourceConfig.generation !== job.expectedGeneration) {
    throw new Error('feedback_migration_state_invalid');
  }
  return job;
}
export async function listSupabaseFeedbackMigrations(dataDir: string): Promise<SupabaseFeedbackMigration[]> {
  let root: string;
  try { root = await directory(dataDir, false); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all((await readdir(root)).filter(name => name.endsWith('.json')).sort()
    .map(name => getSupabaseFeedbackMigration(dataDir, name.slice(0, -5))));
}
async function locked<Result>(dataDir: string, operation: () => Promise<Result>): Promise<Result> {
  const root = await directory(dataDir);
  const legacy = join(await realpath(dataDir), 'feedback-migrations');
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  if (await realpath(legacy) !== legacy) throw new Error('feedback_migration_directory_invalid');
  try {
    return await withFileLock(join(legacy, 'operation'), () => withFileLock(join(legacy, 'runner'),
      () => withFileLock(join(root, 'operation'), operation, { maxWaitMs: 1000 }), { maxWaitMs: 1000 }), { maxWaitMs: 1000 });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) throw new Error('feedback_migration_busy_retry');
    throw error;
  }
}
async function overlap(dataDir: string, identity?: string): Promise<void> {
  const { listFeedbackMigrations } = await import('./feedback-migration.js');
  if ((await listFeedbackMigrations(dataDir)).some(job => !['complete', 'cancelled'].includes(job.phase))
    || (await listSupabaseFeedbackMigrations(dataDir)).some(job => job.migrationId !== identity && !terminal(job))) {
    throw new Error('feedback_migration_conflict');
  }
  const control = currentFeedbackMaintenance(dataDir);
  if (control && control.state !== 'complete' && control.migrationId !== identity) throw new Error('feedback_migration_conflict');
}
async function boundConfig(dataDir: string, job: SupabaseFeedbackMigration, allowActivated = false): Promise<FeedbackStorageConfig> {
  const config = await readFeedbackStorageConfig(dataDir);
  const activated: FeedbackStorageConfig = {
    version: 1, instanceId: job.sourceInstanceId, generation: job.expectedGeneration + 1, active: job.target,
  };
  if (hash(stable(config)) !== job.configFingerprint && !(allowActivated && stable(config) === stable(activated))) {
    throw new Error('feedback_storage_generation_conflict');
  }
  return config;
}
export async function prepareSupabaseFeedbackMigration(dataDir: string, request: {
  requestId: string; expectedGeneration: number; maintenanceConfirmed: true;
}): Promise<SupabaseFeedbackMigration> {
  if (request?.maintenanceConfirmed !== true || typeof request.requestId !== 'string' || !request.requestId.trim()
    || request.requestId.length > 128) throw new Error('feedback_maintenance_confirmation_required');
  return locked(dataDir, async () => {
    const jobs = await listSupabaseFeedbackMigrations(dataDir);
    const previous = jobs.find(job => job.requestId === request.requestId);
    if (previous) {
      if (request.expectedGeneration !== previous.expectedGeneration) throw new Error('feedback_storage_generation_conflict');
      await boundConfig(dataDir, previous, previous.phase === 'complete');
      return previous;
    }
    await overlap(dataDir);
    const config = await readFeedbackStorageConfig(dataDir);
    if (config.generation !== request.expectedGeneration) throw new Error('feedback_storage_generation_conflict');
    if (config.candidate?.backend !== 'supabase' || !['sqlite', 'postgresql'].includes(config.active.backend)) {
      throw new Error('feedback_migration_target_required');
    }
    const identity = randomUUID();
    const job: SupabaseFeedbackMigration = {
      migrationId: identity, requestId: request.requestId, phase: 'preflight', sourceFreezeId: identity,
      expectedGeneration: config.generation, sourceInstanceId: config.instanceId, source: config.active,
      sourceConfig: config, configFingerprint: hash(stable(config)), target: config.candidate,
      imported: {}, blockers: [],
    };
    await save(dataDir, job);
    return job;
  });
}
async function sourcePool(dataDir: string, job: SupabaseFeedbackMigration): Promise<Pool> {
  if (job.source.backend !== 'postgresql') throw new Error('feedback_migration_source_invalid');
  const target = job.source.postgres;
  const credential = await readPostgresCredential(dataDir, target);
  const ca = target.tls.caRef ? await readFeedbackStorageSecret(dataDir, target.tls.caRef) : undefined;
  const { feedbackPostgresPool } = await import('./feedback-postgres-schema.js');
  return feedbackPostgresPool(target, credential, ca);
}
function normalize(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value !== null && ['duration_ms', 'next_attempt_at', 'claimed_at', 'feedback_order', 'sequence', 'value'].includes(key)) {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric)) throw new Error('feedback_migration_integer_invalid');
      return [key, numeric];
    }
    return [key, value];
  }));
}
function canonical(row: Row): string {
  const normalized = normalize(row);
  return stable([canonicalFeedbackRow(normalized), normalized.feedback_order ?? null]);
}
function rowsDigest(rows: Row[]): string { return hash(rows.map(canonical).sort().join('\n')); }
function assertOutbox(dataDir: string, job: SupabaseFeedbackMigration, rows: Row[]): void {
  for (const row of rows) {
    if (row.status === 'inflight') throw new Error('feedback_outbox_unsettled');
    if (!String(row.last_error ?? '').startsWith('webhook_outcome_unknown:')) continue;
    if (!recoveryAcknowledged(dataDir, webhookRecoveryFingerprint(job.sourceInstanceId, job.source, row as {
      outbox_id: string; event_id: string; destination_id: string; last_error: string; status: string; attempts: number;
    }))) throw new Error('feedback_outbox_unsettled');
  }
}
function sqliteOptional(database: DatabaseSyncLike): typeof optionalTables[number][] {
  return optionalTables.filter(table => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
async function sqliteGuard(dataDir: string, job: SupabaseFeedbackMigration, allowRestored = false): Promise<Row | undefined> {
  if (!existsSync(join(dataDir, 'botmux-feedback.sqlite'))) return undefined;
  const database = await openDatabaseSync(join(dataDir, 'botmux-feedback.sqlite'), { readOnly: true });
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_source_restorations'").get()
      && database.prepare('SELECT 1 FROM feedback_source_restorations WHERE migration_id=?').get(job.sourceFreezeId) && !allowRestored) {
      throw new Error('feedback_migration_source_restored');
    }
    return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_source_guard'").get()
      ? database.prepare('SELECT * FROM feedback_source_guard WHERE singleton=1').get() as Row | undefined : undefined;
  } finally { database.close(); }
}
async function freezeSqlite(dataDir: string, job: SupabaseFeedbackMigration): Promise<void> {
  const sourcePath = join(await realpath(dataDir), 'botmux-feedback.sqlite');
  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (job.sourceIdentity && (job.sourceIdentity.dev !== info.dev || job.sourceIdentity.ino !== info.ino))) {
      throw new Error('feedback_migration_source_identity_conflict');
    }
    if (!job.sourceIdentity) { job.sourceIdentity = { dev: info.dev, ino: info.ino }; await save(dataDir, job); }
  } finally { await handle.close(); }
  const guard = await sqliteGuard(dataDir, job);
  if (!guard && job.sourceFingerprint) throw new Error('feedback_migration_source_identity_conflict');
  if (guard && guard.migration_id !== job.sourceFreezeId) throw new Error('feedback_migration_identity_conflict');
  if (guard?.state === 'retired') return;
  await freezeFeedbackSource(dataDir, job.sourceFreezeId);
  const database = await openDatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const table of sqliteOptional(database)) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      database.exec(`CREATE TRIGGER IF NOT EXISTS feedback_supabase_guard_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'feedback_source_frozen'); END`);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}
async function postgresGuard(client: PoolClient, job: SupabaseFeedbackMigration, allowRestored = false): Promise<Row | undefined> {
  const exists = (await client.query("SELECT to_regclass('feedback_supabase_source_guard') name")).rows[0]?.name;
  if (!exists) return undefined;
  const rows = (await client.query('SELECT * FROM feedback_supabase_source_guard')).rows;
  if (rows.some(row => row.state !== 'restored' && row.migration_id !== job.sourceFreezeId)) throw new Error('feedback_migration_identity_conflict');
  const guard = rows.find(row => row.migration_id === job.sourceFreezeId);
  if (guard?.state === 'restored' && !allowRestored) throw new Error('feedback_migration_source_restored');
  return guard;
}
async function postgresTables(client: PoolClient): Promise<Table[]> {
  const rows = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()")).rows as { tablename: string }[];
  const known = new Set<string>([...FEEDBACK_TABLES, ...optionalTables, 'feedback_storage_meta', 'feedback_supabase_source_guard']);
  if (rows.some(row => !known.has(row.tablename)) || FEEDBACK_TABLES.some(table => !rows.some(row => row.tablename === table))) {
    throw new Error('feedback_source_schema_unsupported');
  }
  return [...FEEDBACK_TABLES, ...optionalTables.filter(table => rows.some(row => row.tablename === table))];
}
async function freezePostgres(dataDir: string, job: SupabaseFeedbackMigration, client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feedback-supabase-source:${job.sourceInstanceId}`]);
    const tables = await postgresTables(client);
    await client.query(`LOCK TABLE ${[...tables, 'feedback_storage_meta'].join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const meta = (await client.query('SELECT * FROM feedback_storage_meta WHERE singleton=1 FOR UPDATE')).rows[0];
    const guard = await postgresGuard(client, job);
    if (!guard && job.sourceFingerprint) throw new Error('feedback_migration_source_identity_conflict');
    if (!meta || meta.instance_id !== job.sourceInstanceId || meta.version !== 1
      || (!guard && meta.state !== 'active') || (guard && !['frozen', 'retired'].includes(meta.state))) {
      throw new Error('feedback_storage_target_not_active');
    }
    if (job.sourceMeta && stable(job.sourceMeta) !== stable({ ...meta, state: job.sourceMeta.state })) throw new Error('feedback_migration_source_conflict');
    if (guard?.state === 'retired') { await client.query('COMMIT'); return; }
    assertOutbox(dataDir, job, (await client.query('SELECT * FROM feedback_outbox')).rows);
    if (!job.sourceMeta) { job.sourceMeta = meta; await save(dataDir, job); }
    await client.query('CREATE TABLE IF NOT EXISTS feedback_supabase_source_guard(migration_id TEXT PRIMARY KEY,state TEXT NOT NULL)');
    await client.query("INSERT INTO feedback_supabase_source_guard VALUES($1,'frozen') ON CONFLICT DO NOTHING", [job.sourceFreezeId]);
    await client.query("UPDATE feedback_storage_meta SET state='frozen' WHERE singleton=1 AND state='active'");
    if (job.source.backend !== 'postgresql') throw new Error('feedback_migration_source_invalid');
    await client.query(`CREATE OR REPLACE FUNCTION feedback_supabase_reject_source_write() RETURNS trigger
      LANGUAGE plpgsql SET search_path TO "${job.source.postgres.schema}",pg_catalog AS $guard$ BEGIN
        PERFORM 1 FROM feedback_storage_meta WHERE singleton=1 FOR SHARE;
        IF EXISTS(SELECT 1 FROM feedback_supabase_source_guard WHERE state IN ('frozen','retired')) THEN
          RAISE EXCEPTION 'feedback_source_frozen';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM feedback_storage_meta WHERE singleton=1 AND state='active') THEN
          RAISE EXCEPTION 'feedback_source_retired';
        END IF;
        RETURN NULL;
      END $guard$`);
    for (const table of tables) {
      await client.query(`DROP TRIGGER IF EXISTS feedback_supabase_source_write ON ${table}`);
      await client.query(`CREATE TRIGGER feedback_supabase_source_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION feedback_supabase_reject_source_write()`);
      await client.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER feedback_supabase_source_write`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
async function makeSnapshot(dataDir: string, job: SupabaseFeedbackMigration, client?: PoolClient): Promise<Snapshot> {
  const root = await directory(dataDir);
  const jobDirectory = join(root, job.migrationId);
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  if (await realpath(jobDirectory) !== jobDirectory) throw new Error('feedback_migration_directory_invalid');
  const path = join(jobDirectory, 'source.json');
  if (existsSync(path)) {
    const raw = await privateRead(path);
    if (job.sourceFingerprint && hash(raw) !== job.sourceFingerprint) throw new Error('feedback_snapshot_changed');
    const snapshot = JSON.parse(raw.toString()) as Snapshot;
    if (snapshot.version !== 1 || snapshot.instanceId !== job.sourceInstanceId || snapshot.configFingerprint !== job.configFingerprint
      || !snapshot.sourceMeta || !snapshot.tables || FEEDBACK_TABLES.some(table => !Array.isArray(snapshot.tables[table]))
      || Object.keys(snapshot.tables).some(table => ![...FEEDBACK_TABLES, ...optionalTables].includes(table as Table))) {
      throw new Error('feedback_migration_identity_conflict');
    }
    job.sourceFingerprint = hash(raw);
    job.snapshotPath = path;
    await save(dataDir, job);
    return snapshot;
  }
  if (job.sourceFingerprint || job.snapshotPath) throw new Error('feedback_snapshot_missing');
  const tables: Snapshot['tables'] = {};
  let sourceMeta: Row;
  if (job.source.backend === 'sqlite') {
    const sourcePath = join(await realpath(dataDir), 'botmux-feedback.sqlite');
    const stage = join(jobDirectory, 'sqlite');
    await mkdir(stage, { recursive: true, mode: 0o700 });
    if (await realpath(stage) !== stage) throw new Error('feedback_migration_directory_invalid');
    const link = join(stage, 'botmux-feedback.sqlite');
    if (!existsSync(link)) await symlink(sourcePath, link);
    if (await realpath(link) !== sourcePath) throw new Error('feedback_migration_identity_conflict');
    const backup = await createFeedbackSnapshot(stage, job.migrationId);
    job.sqliteSnapshotPath = backup.snapshotPath;
    const database = await workingFeedbackSnapshot(backup.snapshotPath);
    try {
      for (const table of FEEDBACK_TABLES) tables[table] = feedbackRows(database, table).map(normalize);
      for (const table of sqliteOptional(database)) tables[table] = (database.prepare(`SELECT * FROM ${table}`).all() as Row[]).map(normalize);
      if (tables.feedback_event_stream && !tables.feedback_event_stream_counter) {
        const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='feedback_event_stream'").get() as { seq: number } | undefined;
        const maximum = tables.feedback_event_stream.reduce((value, row) => Math.max(value, Number(row.sequence)), Number(sequence?.seq ?? 0));
        tables.feedback_event_stream_counter = [{ singleton: 1, value: maximum }];
      }
      sourceMeta = { version: 1, instance_id: job.sourceInstanceId, backend: 'sqlite', user_version: 8, source_freeze_id: job.sourceFreezeId };
    } finally { database.close(); }
  } else {
    if (!client) throw new Error('feedback_migration_source_invalid');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const guard = await postgresGuard(client, job);
      if (!guard || guard.state !== 'frozen') throw new Error('feedback_source_not_frozen');
      const meta = (await client.query('SELECT * FROM feedback_storage_meta WHERE singleton=1')).rows[0];
      if (meta?.instance_id !== job.sourceInstanceId || meta.state !== 'frozen' || !job.sourceMeta
        || stable({ ...meta, state: job.sourceMeta.state }) !== stable(job.sourceMeta)) {
        throw new Error('feedback_migration_source_conflict');
      }
      for (const table of await postgresTables(client)) tables[table] = (await client.query(`SELECT * FROM ${table}`)).rows.map(normalize);
      sourceMeta = job.sourceMeta;
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  }
  if (tables.feedback_revisions) tables.feedback_revisions.sort((left, right) => Number(left.feedback_order) - Number(right.feedback_order));
  assertOutbox(dataDir, job, tables.feedback_outbox ?? []);
  const snapshot: Snapshot = { version: 1, instanceId: job.sourceInstanceId, configFingerprint: job.configFingerprint, sourceMeta, tables };
  const raw = stable(snapshot);
  await atomicWriteFile(path, raw, { mode: 0o600, durable: true, followTargetSymlink: false });
  job.sourceFingerprint = hash(raw);
  job.sourceMeta = sourceMeta;
  job.snapshotPath = path;
  await save(dataDir, job);
  return snapshot;
}
function assertTarget(job: SupabaseFeedbackMigration, meta: Row, allowEmpty = false): void {
  if (meta?.instance_id !== job.sourceInstanceId || meta.version !== 1) throw new Error('feedback_migration_identity_conflict');
  if (allowEmpty && meta.state === 'empty' && meta.migration_id == null && meta.source_fingerprint == null) return;
  if (meta.migration_id !== job.migrationId || meta.source_fingerprint !== job.sourceFingerprint || !['migrating', 'active'].includes(String(meta.state))) {
    throw new Error('feedback_migration_identity_conflict');
  }
}
async function targetRows(job: SupabaseFeedbackMigration, target: SupabaseFeedbackClient, table: Table): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const page = await target.call<{ rows: Row[]; meta: Row }>('migration_snapshot', [job.migrationId, table, rows.length, 500], job.sourceInstanceId);
    assertTarget(job, page?.meta);
    if (!Array.isArray(page.rows) || page.rows.length > 500) throw new Error('feedback_supabase_response_invalid');
    rows.push(...page.rows.map(normalize));
    if (page.rows.length < 500) return rows;
  }
}
async function reconcile(dataDir: string, job: SupabaseFeedbackMigration, snapshot: Snapshot,
  target: SupabaseFeedbackClient, source?: PoolClient): Promise<void> {
  if (!job.pending) return;
  const pending = job.pending;
  const meta = await target.call<Row>('migration_status', [], job.sourceInstanceId);
  assertTarget(job, meta, pending.operation === 'prepare');
  if (pending.operation === 'prepare' && meta.state === 'empty') throw new Error('feedback_supabase_prepare_outcome_unknown');
  if (pending.operation === 'activate' && (meta.state !== 'active' || Number(meta.verified) !== 1)
    && !(meta.state === 'migrating' && job.verified && job.sourceRetired)) throw new Error('feedback_supabase_activation_outcome_unknown');
  if (pending.operation === 'import') {
    const table = pending.table!;
    const expected = snapshot.tables[table]!.slice(pending.offset, pending.offset! + pending.count!);
    const actual = new Set((await targetRows(job, target, table)).map(canonical));
    if (expected.some(row => !actual.has(canonical(row)))) throw new Error('feedback_supabase_import_outcome_unknown');
    job.imported[table] = pending.offset! + pending.count!;
  }
  if (pending.operation === 'retire') {
    const guard = source ? await postgresGuard(source, job) : await sqliteGuard(dataDir, job);
    if (guard?.state !== 'retired' || guard.migration_id !== job.sourceFreezeId) throw new Error('feedback_source_retirement_outcome_unknown');
    job.sourceRetired = true;
  }
  delete job.pending;
  await save(dataDir, job);
}
async function retire(dataDir: string, job: SupabaseFeedbackMigration, source?: PoolClient): Promise<void> {
  if (!source) { await retireFeedbackSource(dataDir, job.sourceFreezeId); return; }
  await source.query('BEGIN');
  try {
    const guard = await postgresGuard(source, job);
    if (!guard || !['frozen', 'retired'].includes(String(guard.state))) throw new Error('feedback_migration_identity_conflict');
    const result = await source.query("UPDATE feedback_storage_meta SET state='retired' WHERE singleton=1 AND instance_id=$1 AND state IN ('frozen','retired')", [job.sourceInstanceId]);
    if (result.rowCount !== 1) throw new Error('feedback_migration_identity_conflict');
    await source.query("UPDATE feedback_supabase_source_guard SET state='retired' WHERE migration_id=$1", [job.sourceFreezeId]);
    await source.query('COMMIT');
  } catch (error) { await source.query('ROLLBACK').catch(() => {}); throw error; }
}
async function activateConfig(dataDir: string, job: SupabaseFeedbackMigration): Promise<number> {
  return withFileLock(join(await realpath(dataDir), 'feedback-storage.json'), async () => {
    const current = await boundConfig(dataDir, job, true);
    if (current.generation === job.expectedGeneration + 1) return current.generation;
    const next: FeedbackStorageConfig = { version: 1, instanceId: job.sourceInstanceId, generation: current.generation + 1, active: job.target };
    await atomicWriteFile(join(await realpath(dataDir), 'feedback-storage.json'), JSON.stringify(next), {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
    return next.generation;
  });
}
export async function resumeSupabaseFeedbackMigration(dataDir: string, identity: string): Promise<SupabaseFeedbackMigration> {
  return locked(dataDir, async () => {
    const job = await getSupabaseFeedbackMigration(dataDir, identity);
    if (terminal(job)) return job;
    if (job.phase === 'cancelling') return finishCancellation(dataDir, job);
    let pool: Pool | undefined;
    let source: PoolClient | undefined;
    let target: SupabaseFeedbackClient | undefined;
    const phase = async (value: Phase) => { job.phase = value; job.blockers = []; await save(dataDir, job); };
    try {
      await overlap(dataDir, identity);
      const config = await boundConfig(dataDir, job, true);
      if (job.snapshotInvalidated) throw new Error('feedback_snapshot_invalidated');
      if (job.source.backend === 'postgresql') { pool = await sourcePool(dataDir, job); source = await pool.connect(); }
      if (config.generation === job.expectedGeneration) {
        await phase('draining');
        await beginFeedbackMaintenance(dataDir, job.sourceFreezeId);
        let report = await inspectFeedbackMaintenance(dataDir, job.sourceFreezeId);
        const deadline = Date.now() + 45000;
        while (report.blockers.length && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          await boundConfig(dataDir, job);
          report = await inspectFeedbackMaintenance(dataDir, job.sourceFreezeId);
        }
        if (report.blockers.length) throw new Error(`feedback_maintenance_blocked:${report.blockers.join(',')}`);
        const { closeFeedbackStorage } = await import('./feedback-storage.js');
        await closeFeedbackStorage(dataDir);
        if (source) await freezePostgres(dataDir, job, source);
        else await freezeSqlite(dataDir, job);
      } else {
        const guard = source ? await postgresGuard(source, job) : await sqliteGuard(dataDir, job);
        if (guard?.state !== 'retired' || !job.verified || !job.sourceRetired) throw new Error('feedback_migration_activation_state_invalid');
      }
      await phase('snapshot');
      const snapshot = await makeSnapshot(dataDir, job, source);
      const { openSupabaseFeedbackClient } = await import('./feedback-supabase-store.js');
      target = await openSupabaseFeedbackClient(dataDir, job.target.supabase);
      await reconcile(dataDir, job, snapshot, target, source);
      let meta = await target.call<Row>('migration_status', [], job.sourceInstanceId);
      assertTarget(job, meta, true);
      if (meta.state === 'active' && (!job.verified || !job.sourceRetired)) throw new Error('feedback_migration_target_activated_early');
      if (meta.state === 'empty') {
        job.pending = { operation: 'prepare' }; await save(dataDir, job);
        meta = await target.call<Row>('migration_prepare', [identity, job.sourceFingerprint], job.sourceInstanceId);
        assertTarget(job, meta);
        delete job.pending; await save(dataDir, job);
      }
      if (meta.state === 'migrating') {
        if (job.sourceRetired && !job.verified) throw new Error('feedback_source_retired');
        await phase('importing');
        for (const table of [...FEEDBACK_TABLES, ...optionalTables]) {
          const rows = snapshot.tables[table];
          if (!rows) continue;
          let offset = job.imported[table] ?? 0;
          if (offset > rows.length) throw new Error('feedback_migration_state_invalid');
          while (offset < rows.length) {
            await boundConfig(dataDir, job);
            const chunk = rows.slice(offset, offset + 250);
            job.pending = { operation: 'import', table, offset, count: chunk.length }; await save(dataDir, job);
            assertTarget(job, await target.call<Row>('migration_import', [identity, table, chunk], job.sourceInstanceId));
            offset += chunk.length;
            job.imported[table] = offset;
            delete job.pending; await save(dataDir, job);
          }
        }
      }
      if (meta.state !== 'active' || !job.verified) {
        await phase('verifying');
        for (const table of [...FEEDBACK_TABLES, ...optionalTables]) {
          const expected = snapshot.tables[table];
          if (!expected) continue;
          const actual = await targetRows(job, target, table);
          if (expected.length !== actual.length || rowsDigest(expected) !== rowsDigest(actual)) throw new Error(`feedback_migration_content_mismatch:${table}`);
          if (table === 'feedback_revisions') {
            const order = (rows: Row[]) => rows.slice().sort((left, right) => Number(left.feedback_order) - Number(right.feedback_order)).map(row => [row.feedback_id, row.feedback_order]);
            if (stable(order(expected)) !== stable(order(actual))) throw new Error('feedback_migration_feedback_order_mismatch');
          }
        }
        job.verified = true; await save(dataDir, job);
      }
      await boundConfig(dataDir, job, true);
      if (!job.sourceRetired) {
        await phase('retiring');
        job.pending = { operation: 'retire' }; await save(dataDir, job);
        await retire(dataDir, job, source);
        job.sourceRetired = true;
        delete job.pending; await save(dataDir, job);
      }
      if (meta.state !== 'active') {
        await phase('activating');
        job.pending = { operation: 'activate' }; await save(dataDir, job);
        meta = await target.call<Row>('migration_activate', [identity, job.sourceFingerprint], job.sourceInstanceId);
        assertTarget(job, meta);
        if (meta.state !== 'active' || Number(meta.verified) !== 1) throw new Error('feedback_supabase_activation_outcome_unknown');
        delete job.pending; await save(dataDir, job);
      }
      job.targetGeneration = await activateConfig(dataDir, job);
      await save(dataDir, job);
      const deadline = Date.now() + 15000;
      for (;;) {
        try { await releaseFeedbackMaintenance(dataDir, job.sourceFreezeId, job.targetGeneration); break; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'feedback_maintenance_generation_pending' || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
          await boundConfig(dataDir, job, true);
        }
      }
      await phase('complete');
    } catch (error) {
      job.phase = 'blocked';
      const message = error instanceof Error ? error.message : '';
      job.blockers = [message.startsWith('feedback_') ? message : 'feedback_migration_database_or_io_error'];
      await save(dataDir, job);
    } finally { await target?.close(); source?.release(); await pool?.end(); }
    return job;
  });
}
async function finishCancellation(dataDir: string, job: SupabaseFeedbackMigration): Promise<SupabaseFeedbackMigration> {
  if (!job.cancellation) throw new Error('feedback_recovery_evidence_required');
  await boundConfig(dataDir, job);
  if (job.sourceRetired || job.pending?.operation === 'activate') throw new Error('feedback_source_retired');
  let pool: Pool | undefined;
  let source: PoolClient | undefined;
  let target: SupabaseFeedbackClient | undefined;
  try {
    if (job.sourceFingerprint) {
      const { openSupabaseFeedbackClient } = await import('./feedback-supabase-store.js');
      target = await openSupabaseFeedbackClient(dataDir, job.target.supabase);
      const meta = await target.call<Row>('migration_status', [], job.sourceInstanceId);
      assertTarget(job, meta, true);
      if (meta.state === 'active') throw new Error('feedback_migration_already_activated_resume_required');
    }
    if (job.source.backend === 'postgresql') {
      pool = await sourcePool(dataDir, job);
      source = await pool.connect();
      await source.query('BEGIN');
      try {
        const tables = await postgresTables(source);
        await source.query(`LOCK TABLE ${[...tables, 'feedback_storage_meta'].join(',')} IN SHARE ROW EXCLUSIVE MODE`);
        const guard = await postgresGuard(source, job, true);
        const meta = (await source.query('SELECT * FROM feedback_storage_meta WHERE singleton=1 FOR UPDATE')).rows[0];
        if (meta?.instance_id !== job.sourceInstanceId || !['active', 'frozen'].includes(meta.state) || guard?.state === 'retired') throw new Error('feedback_source_retired');
        if (guard) {
          for (const table of tables) await source.query(`DROP TRIGGER IF EXISTS feedback_supabase_source_write ON ${table}`);
          await source.query("UPDATE feedback_supabase_source_guard SET state='restored' WHERE migration_id=$1", [job.sourceFreezeId]);
          await source.query("UPDATE feedback_storage_meta SET state='active' WHERE singleton=1 AND state='frozen'");
        }
        await source.query('COMMIT');
      } catch (error) { await source.query('ROLLBACK').catch(() => {}); throw error; }
      const control = currentFeedbackMaintenance(dataDir);
      if (control?.migrationId === job.sourceFreezeId) cancelFeedbackMaintenance(dataDir, job.sourceFreezeId, job.expectedGeneration);
    } else {
      const guard = await sqliteGuard(dataDir, job, true);
      if (guard?.state === 'retired') throw new Error('feedback_source_retired');
      if (guard && guard.migration_id !== job.sourceFreezeId) throw new Error('feedback_migration_identity_conflict');
      if (guard) {
        const database = await openDatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
        try {
          for (const table of optionalTables) for (const action of ['insert', 'update', 'delete']) {
            database.exec(`DROP TRIGGER IF EXISTS feedback_supabase_guard_${table}_${action}`);
          }
        } finally { database.close(); }
      }
      if (currentFeedbackMaintenance(dataDir)?.migrationId === job.sourceFreezeId) await restoreFeedbackSource(dataDir, job.sourceFreezeId);
    }
    job.snapshotInvalidated = true;
    job.phase = 'cancelled';
    job.blockers = [];
    delete job.pending;
    await save(dataDir, job);
    return job;
  } finally { await target?.close(); source?.release(); await pool?.end(); }
}
async function checkCancellation(dataDir: string, job: SupabaseFeedbackMigration): Promise<void> {
  await boundConfig(dataDir, job);
  if (job.sourceRetired || job.pending?.operation === 'activate') throw new Error('feedback_source_retired');
  let pool: Pool | undefined;
  let source: PoolClient | undefined;
  let target: SupabaseFeedbackClient | undefined;
  try {
    if (job.sourceFingerprint) {
      const { openSupabaseFeedbackClient } = await import('./feedback-supabase-store.js');
      target = await openSupabaseFeedbackClient(dataDir, job.target.supabase);
      const meta = await target.call<Row>('migration_status', [], job.sourceInstanceId);
      assertTarget(job, meta, true);
      if (meta.state === 'active') throw new Error('feedback_migration_already_activated_resume_required');
    }
    if (job.source.backend === 'postgresql') { pool = await sourcePool(dataDir, job); source = await pool.connect(); }
    const guard = source ? await postgresGuard(source, job, true) : await sqliteGuard(dataDir, job, true);
    if (guard?.state === 'retired') throw new Error('feedback_source_retired');
    if (guard && guard.migration_id !== job.sourceFreezeId) throw new Error('feedback_migration_identity_conflict');
  } finally { await target?.close(); source?.release(); await pool?.end(); }
}
export async function cancelSupabaseFeedbackMigration(dataDir: string, identity: string, decision: RecoveryDecision): Promise<SupabaseFeedbackMigration> {
  validateRecoveryDecision(decision);
  return locked(dataDir, async () => {
    const job = await getSupabaseFeedbackMigration(dataDir, identity);
    if (job.phase === 'cancelled') return job;
    if (job.phase === 'complete' || job.sourceRetired) throw new Error('feedback_source_retired');
    await overlap(dataDir, identity);
    await checkCancellation(dataDir, job);
    job.cancellation = { ...decision, at: new Date().toISOString() };
    job.phase = 'cancelling';
    await save(dataDir, job);
    return finishCancellation(dataDir, job);
  });
}
