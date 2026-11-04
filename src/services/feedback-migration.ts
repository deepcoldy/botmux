import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { readFeedbackStorageConfig, readFeedbackStorageSecret, readPostgresCredential, activateFeedbackStorageCandidate } from './feedback-storage-config.js';
import type { PostgresTarget } from './feedback-storage-types.js';
// This module is imported even for `feedback storage status` (to list job
// files), so the pg-backed schema/pool helpers load lazily; FEEDBACK_TABLES
// comes from the dependency-free module.
import { FEEDBACK_TABLES } from './feedback-tables.js';
import { beginFeedbackMaintenance, freezeFeedbackSource, retireFeedbackSource, releaseFeedbackMaintenance, inspectFeedbackMaintenance } from './feedback-maintenance.js';
import { closeFeedbackStorage, getFeedbackStorage } from './feedback-storage.js';
import { canonicalFeedbackRow, createFeedbackSnapshot, feedbackRows, workingFeedbackSnapshot } from './feedback-snapshot.js';
import { validateRecoveryDecision, withFeedbackRecoveryLock, type RecoveryDecision } from './feedback-recovery.js';
import { currentFeedbackMaintenance, restoreFeedbackSource } from './feedback-maintenance.js';
import { openDatabaseSync } from './sqlite-compat.js';
import { existsSync } from 'node:fs';

export interface MigrationStatus {
  migrationId: string;
  requestId: string;
  phase: 'preflight' | 'draining' | 'frozen' | 'snapshot' | 'importing' | 'verifying' | 'retiring' | 'activating' | 'complete' | 'blocked' | 'cancelling' | 'cancelled';
  expectedGeneration: number;
  sourceInstanceId: string;
  target: PostgresTarget;
  sourceFingerprint?: string;
  snapshotPath?: string;
  targetGeneration?: number;
  blockers: string[];
  cancellation?: RecoveryDecision & { at: string };
}
const jobPath = (dataDir: string, migrationId: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(migrationId)) throw new Error('feedback_migration_id_invalid');
  return join(dataDir, 'feedback-migrations', `${migrationId}.json`);
};
async function save(dataDir: string, state: MigrationStatus): Promise<void> {
  await atomicWriteFile(jobPath(dataDir, state.migrationId), JSON.stringify(state), { mode: 0o600, durable: true, followTargetSymlink: false });
}
export async function getFeedbackMigration(dataDir: string, migrationId: string): Promise<MigrationStatus> {
  const value = JSON.parse(await readFile(jobPath(dataDir, migrationId), 'utf8')) as MigrationStatus;
  if (value.migrationId !== migrationId || typeof value.requestId !== 'string' || !value.target || !Array.isArray(value.blockers)) throw new Error('feedback_migration_state_invalid');
  return value;
}
export async function listFeedbackMigrations(dataDir: string): Promise<MigrationStatus[]> {
  const directory = join(dataDir, 'feedback-migrations');
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(names.filter(name => name.endsWith('.json')).map(name => getFeedbackMigration(dataDir, name.slice(0, -5))));
}
async function poolFor(dataDir: string, target: PostgresTarget): Promise<Pool> {
  const password = await readPostgresCredential(dataDir, target);
  const ca = target.tls.caRef ? await readFeedbackStorageSecret(dataDir, target.tls.caRef) : undefined;
  const { feedbackPostgresPool } = await import('./feedback-postgres-schema.js');
  return feedbackPostgresPool(target, password, ca);
}
function digest(rows: Record<string, unknown>[]): string {
  return createHash('sha256').update(rows.map(canonicalFeedbackRow).sort().join('\n')).digest('hex');
}
async function verify(client: PoolClient, snapshotPath: string) {
  const database = await workingFeedbackSnapshot(snapshotPath);
  try {
    const results: Array<{ table: string; rows: number; digest: string }> = [];
    for (const table of FEEDBACK_TABLES) {
      const sourceRows = feedbackRows(database, table);
      const targetRows = (await client.query(`SELECT * FROM ${table}`)).rows;
      for (const row of targetRows) {
        for (const key of ['duration_ms', 'next_attempt_at', 'claimed_at']) if (row[key] !== null && row[key] !== undefined) row[key] = Number(row[key]);
      }
      if (sourceRows.length !== targetRows.length || digest(sourceRows) !== digest(targetRows)) throw new Error(`feedback_migration_content_mismatch:${table}`);
      if (table === 'feedback_revisions') {
        const byOrder = (rows: Record<string, unknown>[]) => rows.sort((left, right) => Number(left.feedback_order) - Number(right.feedback_order)).map(row => row.feedback_id);
        if (JSON.stringify(byOrder(sourceRows)) !== JSON.stringify(byOrder(targetRows))) throw new Error('feedback_migration_feedback_order_mismatch');
      }
      results.push({ table, rows: sourceRows.length, digest: digest(sourceRows) });
    }
    return { passed: true, tableResults: results };
  } finally { database.close(); }
}
export async function verifyFeedbackMigration(snapshotPath: string, target: PostgresTarget, migrationId: string, dataDir: string) {
  const pool = await poolFor(dataDir, target);
  const client = await pool.connect();
  try {
    const meta = (await client.query('SELECT migration_id FROM feedback_storage_meta WHERE singleton=1')).rows[0];
    if (meta?.migration_id !== migrationId) throw new Error('feedback_migration_identity_conflict');
    return await verify(client, snapshotPath);
  } finally { client.release(); await pool.end(); }
}
export async function prepareFeedbackMigration(dataDir: string, request: { requestId: string; expectedGeneration: number; maintenanceConfirmed: true }): Promise<MigrationStatus> {
  if (!request.maintenanceConfirmed || !request.requestId || request.requestId.length > 128) throw new Error('feedback_maintenance_confirmation_required');
  const directory = join(dataDir, 'feedback-migrations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, 'operation'), async () => {
    const jobs = await listFeedbackMigrations(dataDir);
    const previous = jobs.find(job => job.requestId === request.requestId);
    if (previous) return previous;
    if (jobs.some(job => !['complete', 'cancelled'].includes(job.phase))) throw new Error('feedback_migration_conflict');
    const config = await readFeedbackStorageConfig(dataDir);
    if (config.generation !== request.expectedGeneration) throw new Error('feedback_storage_generation_conflict');
    if (config.active.backend !== 'sqlite' || config.candidate?.backend !== 'postgresql') throw new Error('feedback_migration_target_required');
    const job: MigrationStatus = {
      migrationId: randomUUID(), requestId: request.requestId, phase: 'preflight', expectedGeneration: config.generation,
      sourceInstanceId: config.instanceId, target: config.candidate.postgres, blockers: [],
    };
    await save(dataDir, job);
    return job;
  });
}
export async function startFeedbackMigration(dataDir: string, request: { requestId: string; expectedGeneration: number; maintenanceConfirmed: true }): Promise<MigrationStatus> {
  const job = await prepareFeedbackMigration(dataDir, request);
  return resumeFeedbackMigration(dataDir, job.migrationId);
}
export async function resumeFeedbackMigration(dataDir: string, migrationId: string): Promise<MigrationStatus> {
  return withFeedbackRecoveryLock(dataDir, async () => {
    const job = await getFeedbackMigration(dataDir, migrationId);
    if (job.phase === 'complete' || job.phase === 'cancelled') return job;
    if (job.phase === 'cancelling') return finishCancellation(dataDir, job);
    const phase = async (value: MigrationStatus['phase']) => { job.phase = value; job.blockers = []; await save(dataDir, job); };
    let pool: Pool | undefined;
    let client: PoolClient | undefined;
    try {
      const config = await readFeedbackStorageConfig(dataDir);
      const alreadyActivated = config.active.backend === 'postgresql' && JSON.stringify(config.active.postgres) === JSON.stringify(job.target) && config.generation === job.expectedGeneration + 1;
      if (!alreadyActivated && (config.generation !== job.expectedGeneration || config.candidate?.backend !== 'postgresql' || JSON.stringify(config.candidate.postgres) !== JSON.stringify(job.target))) throw new Error('feedback_storage_generation_conflict');
      if (config.instanceId !== job.sourceInstanceId) throw new Error('feedback_migration_identity_conflict');
      pool = await poolFor(dataDir, job.target);
      client = await pool.connect();
      const { ensurePostgresFeedbackSchema } = await import('./feedback-postgres-schema.js');
      await ensurePostgresFeedbackSchema(client, job.target.schema, job.sourceInstanceId, migrationId);
      if (!alreadyActivated) {
        await phase('draining');
        await beginFeedbackMaintenance(dataDir, migrationId);
        let report = await inspectFeedbackMaintenance(dataDir, migrationId);
        const deadline = Date.now() + 45000;
        while (report.blockers.length && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          report = await inspectFeedbackMaintenance(dataDir, migrationId);
        }
        if (report.blockers.length) throw new Error('feedback_maintenance_not_ready');
        await closeFeedbackStorage(dataDir);
        await freezeFeedbackSource(dataDir, migrationId);
        await phase('snapshot');
        const snapshot = await createFeedbackSnapshot(dataDir, migrationId);
        if (job.sourceFingerprint && job.sourceFingerprint !== snapshot.fingerprint) throw new Error('feedback_snapshot_changed');
        job.sourceFingerprint = snapshot.fingerprint;
        job.snapshotPath = snapshot.snapshotPath;
        await save(dataDir, job);
        const meta = (await client.query('SELECT * FROM feedback_storage_meta WHERE singleton=1')).rows[0];
        if (meta.source_fingerprint && meta.source_fingerprint !== job.sourceFingerprint) throw new Error('feedback_migration_source_conflict');
        if (!meta.source_fingerprint) {
          await phase('importing');
          const database = await workingFeedbackSnapshot(snapshot.snapshotPath);
          try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`migration:${job.target.schema}`]);
            for (const table of FEEDBACK_TABLES) {
              const count = (await client.query(`SELECT COUNT(*) count FROM ${table}`)).rows[0];
              if (Number(count.count)) throw new Error('feedback_migration_target_not_empty');
              const rows = feedbackRows(database, table);
              if (table === 'feedback_revisions') rows.sort((left, right) => Number(left.feedback_order) - Number(right.feedback_order));
              for (const row of rows) {
                const columns = Object.keys(row);
                if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('feedback_migration_column_invalid');
                await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_column, index) => `$${index + 1}`).join(',')})`, Object.values(row));
              }
            }
            await client.query("SELECT setval(pg_get_serial_sequence('feedback_revisions','feedback_order'),COALESCE((SELECT MAX(feedback_order) FROM feedback_revisions),0)+1,false)");
            await client.query('UPDATE feedback_storage_meta SET source_fingerprint=$1 WHERE singleton=1 AND migration_id=$2', [job.sourceFingerprint, migrationId]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
          finally { database.close(); }
        }
        await phase('verifying');
        await verify(client, snapshot.snapshotPath);
        await client.query('UPDATE feedback_storage_meta SET verified=1 WHERE singleton=1 AND migration_id=$1', [migrationId]);
        await phase('retiring');
        await retireFeedbackSource(dataDir, migrationId);
        await client.query("UPDATE feedback_storage_meta SET state='active' WHERE singleton=1 AND migration_id=$1 AND verified=1", [migrationId]);
        await phase('activating');
        job.targetGeneration = (await activateFeedbackStorageCandidate(dataDir, job.expectedGeneration)).generation;
        await save(dataDir, job);
      }
      await getFeedbackStorage(dataDir);
      const generation = (await readFeedbackStorageConfig(dataDir)).generation;
      const deadline = Date.now() + 15000;
      for (;;) {
        try { await releaseFeedbackMaintenance(dataDir, migrationId, generation); break; }
        catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      await phase('complete');
      return job;
    } catch (error) {
      job.phase = 'blocked';
      const message = error instanceof Error ? error.message : '';
      job.blockers = [message.startsWith('feedback_') ? message : 'feedback_migration_database_or_io_error'];
      await save(dataDir, job);
      return job;
    } finally { client?.release(); await pool?.end(); }
  });
}

async function checkCancellation(dataDir: string, job: MigrationStatus): Promise<void> {
  const config = await readFeedbackStorageConfig(dataDir);
  if (config.instanceId !== job.sourceInstanceId) throw new Error('feedback_migration_identity_conflict');
  if (config.active.backend !== 'sqlite') throw new Error('feedback_migration_already_activated_resume_required');
  const control = currentFeedbackMaintenance(dataDir);
  if (control && control.state !== 'complete' && control.migrationId !== job.migrationId) throw new Error('feedback_migration_identity_conflict');
  const path = join(dataDir, 'botmux-feedback.sqlite');
  if (!existsSync(path)) {
    if (control && control.state !== 'draining' && control.state !== 'complete') throw new Error('feedback_source_missing');
    return;
  }
  const database = await openDatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_source_guard'").get()) {
      const guard = database.prepare('SELECT * FROM feedback_source_guard WHERE singleton=1').get() as { migration_id: string; state: string } | undefined;
      if (guard?.state === 'retired') throw new Error('feedback_source_retired');
      if (guard && guard.migration_id !== job.migrationId) throw new Error('feedback_migration_identity_conflict');
      if (guard && control?.migrationId !== job.migrationId) throw new Error('feedback_maintenance_state_missing');
    }
  } finally { database.close(); }
}
async function finishCancellation(dataDir: string, job: MigrationStatus): Promise<MigrationStatus> {
  await checkCancellation(dataDir, job);
  if (!job.cancellation) throw new Error('feedback_recovery_evidence_required');
  const control = currentFeedbackMaintenance(dataDir);
  if (control?.migrationId === job.migrationId) await restoreFeedbackSource(dataDir, job.migrationId);
  job.phase = 'cancelled';
  job.blockers = [];
  await save(dataDir, job);
  return job;
}
export async function cancelFeedbackMigration(dataDir: string, migrationId: string, decision: RecoveryDecision): Promise<MigrationStatus> {
  validateRecoveryDecision(decision);
  return withFeedbackRecoveryLock(dataDir, async () => {
    const job = await getFeedbackMigration(dataDir, migrationId);
    if (job.phase === 'cancelled') return job;
    if (job.phase === 'complete') throw new Error('feedback_migration_already_activated_resume_required');
    await checkCancellation(dataDir, job);
    if (job.phase !== 'cancelling') {
      job.cancellation = { confirmed: true, actor: decision.actor, reason: decision.reason, evidence: decision.evidence, at: new Date().toISOString() };
      job.phase = 'cancelling';
      await save(dataDir, job);
    }
    return finishCancellation(dataDir, job);
  });
}
