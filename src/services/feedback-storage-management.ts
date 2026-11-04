import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate, putFeedbackStorageSecret, readFeedbackStorageSecret, readPostgresCredential, activateFeedbackStorageCandidate } from './feedback-storage-config.js';
import type { FeedbackStorageConfig, FeedbackStorageTarget } from './feedback-storage-types.js';
import { FEEDBACK_TABLES } from './feedback-tables.js';
import { SkillFeedbackStore } from './skill-feedback-store.js';
import { openDatabaseSync } from './sqlite-compat.js';
import { closeFeedbackStorage } from './feedback-storage.js';
// PG pool and migration runner pull in the optional `pg` dependency; load them
// lazily so `feedback storage status` and the Dashboard storage panel work on
// SQLite-only installs (pg is required only when actually using PostgreSQL).
import { randomUUID } from 'node:crypto';
import { currentFeedbackMaintenance } from './feedback-maintenance.js';

export function feedbackStorageView(config: FeedbackStorageConfig) {
  const redact = (target: FeedbackStorageTarget) => target.backend === 'sqlite' ? target : {
    backend: target.backend,
    postgres: { host: target.postgres.host, port: target.postgres.port, database: target.postgres.database,
      user: target.postgres.user, schema: target.postgres.schema, tls: { mode: target.postgres.tls.mode, hasCa: !!target.postgres.tls.caRef },
      connectTimeoutMs: target.postgres.connectTimeoutMs, hasPassword: !!target.postgres.passwordRef,
      ...(target.postgres.bytepg ? { bytepg: { computeId: target.postgres.bytepg.computeId, hasToken: !!target.postgres.bytepg.tokenRef,
        ...(target.postgres.bytepg.doas ? { doas: target.postgres.bytepg.doas } : {}) } } : {}) },
  };
  return { generation: config.generation, active: redact(config.active), candidate: config.candidate ? redact(config.candidate) : undefined };
}
export async function feedbackStorageStatus(dataDir: string) {
  const config = await readFeedbackStorageConfig(dataDir);
  const { listFeedbackMigrations } = await import('./feedback-migration.js');
  const jobs = await listFeedbackMigrations(dataDir);
  return { ...feedbackStorageView(config), maintenance: currentFeedbackMaintenance(dataDir),
    migrations: jobs.map(job => ({ migrationId: job.migrationId, phase: job.phase, blockers: job.blockers })) };
}
export async function configureFeedbackStorageCandidate(dataDir: string, request: {
  expectedGeneration: number; candidate: FeedbackStorageTarget; password?: string; token?: string; ca?: string;
}): Promise<FeedbackStorageConfig> {
  const current = await readFeedbackStorageConfig(dataDir);
  if (current.generation !== request.expectedGeneration) throw new Error('feedback_storage_generation_conflict');
  if (!request.candidate || !['sqlite', 'postgresql'].includes(request.candidate.backend)) throw new Error('feedback_storage_target_invalid');
  const candidate = structuredClone(request.candidate);
  if (candidate.backend === 'postgresql') {
    if (!candidate.postgres) throw new Error('feedback_storage_target_invalid');
    const previous = current.candidate?.backend === 'postgresql' ? current.candidate.postgres : current.active.backend === 'postgresql' ? current.active.postgres : undefined;
    if (candidate.postgres.bytepg) {
      if (request.password || candidate.postgres.passwordRef) throw new Error('feedback_storage_auth_invalid');
      if (candidate.postgres.bytepg.doas) {
        if (request.token || candidate.postgres.bytepg.tokenRef) throw new Error('feedback_storage_auth_invalid');
        delete candidate.postgres.bytepg.tokenRef;
      } else {
        candidate.postgres.bytepg.tokenRef = request.token
          ? await putFeedbackStorageSecret(dataDir, request.token)
          : candidate.postgres.bytepg.tokenRef || previous?.bytepg?.tokenRef || '';
      }
    } else {
      if (request.token) throw new Error('feedback_storage_auth_invalid');
      candidate.postgres.passwordRef = request.password
        ? await putFeedbackStorageSecret(dataDir, request.password)
        : candidate.postgres.passwordRef || previous?.passwordRef || '';
    }
    if (!request.ca && !candidate.postgres.tls.caRef && previous?.tls.caRef) {
      candidate.postgres.tls = { ...candidate.postgres.tls, caRef: previous.tls.caRef };
    }
    if (request.ca) candidate.postgres.tls = { ...candidate.postgres.tls, caRef: await putFeedbackStorageSecret(dataDir, request.ca) };
  }
  return saveFeedbackStorageCandidate(dataDir, current.generation, candidate);
}
export async function testFeedbackStorageConnection(dataDir: string): Promise<{ ok: true; backend: string }> {
  const config = await readFeedbackStorageConfig(dataDir);
  const selected = config.candidate ?? config.active;
  if (selected.backend === 'sqlite') return { ok: true, backend: 'sqlite' };
  const target = selected.postgres;
  const { feedbackPostgresPool } = await import('./feedback-postgres-schema.js');
  const pool = feedbackPostgresPool(target, await readPostgresCredential(dataDir, target), target.tls.caRef ? await readFeedbackStorageSecret(dataDir, target.tls.caRef) : undefined);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const permission = (await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') permitted")).rows[0];
      if (!permission.permitted) throw new Error('feedback_storage_create_permission_required');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    return { ok: true, backend: 'postgresql' };
  } catch (error) {
    if ((error as Error).message.startsWith('feedback_')) throw error;
    throw new Error('feedback_storage_connection_failed');
  } finally { await pool.end(); }
}
export async function initializeFeedbackStorage(dataDir: string, expectedGeneration: number): Promise<FeedbackStorageConfig> {
  const config = await readFeedbackStorageConfig(dataDir);
  if (config.generation !== expectedGeneration || !config.candidate) throw new Error('feedback_storage_generation_conflict');
  if (config.active.backend !== 'sqlite') throw new Error('feedback_storage_reverse_migration_unsupported');
  const path = join(dataDir, 'botmux-feedback.sqlite');
  if (existsSync(path)) {
    const database = await openDatabaseSync(path, { readOnly: true });
    try {
      for (const table of FEEDBACK_TABLES) {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
          Number((database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count)) throw new Error('feedback_storage_migration_required');
      }
    } finally { database.close(); }
  }
  if (config.candidate.backend === 'postgresql') {
    const source = await SkillFeedbackStore.open(dataDir);
    source.close();
    const { startFeedbackMigration } = await import('./feedback-migration.js');
    const job = await startFeedbackMigration(dataDir, {
      requestId: `initialize-${randomUUID()}`, expectedGeneration, maintenanceConfirmed: true,
    });
    if (job.phase !== 'complete') throw new Error(job.blockers[0] ?? 'feedback_storage_initialization_blocked');
    return readFeedbackStorageConfig(dataDir);
  }
  await closeFeedbackStorage(dataDir);
  return activateFeedbackStorageCandidate(dataDir, expectedGeneration);
}
export async function configureFeedbackStorageFile(dataDir: string, path: string): Promise<FeedbackStorageConfig> {
  let candidate: FeedbackStorageTarget;
  try { candidate = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('feedback_storage_config_file_invalid'); }
  const current = await readFeedbackStorageConfig(dataDir);
  if (JSON.stringify(current.active) === JSON.stringify(candidate)) return current;
  return configureFeedbackStorageCandidate(dataDir, { candidate, expectedGeneration: current.generation });
}
