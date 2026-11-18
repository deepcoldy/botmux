import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFeedbackStorageConfig } from './feedback-storage-config.js';
import type { RecoveryDecision } from './feedback-recovery.js';

function supabaseMigration(dataDir: string, migrationId: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(migrationId)) throw new Error('feedback_migration_id_invalid');
  const supabase = existsSync(join(dataDir, 'feedback-supabase-migrations', `${migrationId}.json`));
  if (supabase && existsSync(join(dataDir, 'feedback-migrations', `${migrationId}.json`))) {
    throw new Error('feedback_migration_identity_conflict');
  }
  return supabase;
}

export async function prepareStorageMigration(dataDir: string, request: {
  requestId: string; expectedGeneration: number; maintenanceConfirmed: true;
}) {
  const config = await readFeedbackStorageConfig(dataDir);
  if (config.candidate?.backend === 'supabase') {
    return (await import('./feedback-supabase-migration.js')).prepareSupabaseFeedbackMigration(dataDir, request);
  }
  return (await import('./feedback-migration.js')).prepareFeedbackMigration(dataDir, request);
}

export async function resumeStorageMigration(dataDir: string, migrationId: string) {
  if (supabaseMigration(dataDir, migrationId)) {
    return (await import('./feedback-supabase-migration.js')).resumeSupabaseFeedbackMigration(dataDir, migrationId);
  }
  return (await import('./feedback-migration.js')).resumeFeedbackMigration(dataDir, migrationId);
}

export async function getStorageMigration(dataDir: string, migrationId: string) {
  if (supabaseMigration(dataDir, migrationId)) {
    return (await import('./feedback-supabase-migration.js')).getSupabaseFeedbackMigration(dataDir, migrationId);
  }
  return (await import('./feedback-migration.js')).getFeedbackMigration(dataDir, migrationId);
}

export async function cancelStorageMigration(dataDir: string, migrationId: string, decision: RecoveryDecision) {
  if (supabaseMigration(dataDir, migrationId)) {
    return (await import('./feedback-supabase-migration.js')).cancelSupabaseFeedbackMigration(dataDir, migrationId, decision);
  }
  return (await import('./feedback-migration.js')).cancelFeedbackMigration(dataDir, migrationId, decision);
}
