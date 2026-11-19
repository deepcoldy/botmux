import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, open, readFile, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabaseSync, type DatabaseSyncLike } from './sqlite-compat.js';
import { FEEDBACK_TABLES } from './feedback-tables.js';
import { SkillFeedbackStore } from './skill-feedback-store.js';

export async function createFeedbackSnapshot(dataDir: string, migrationId: string): Promise<{ snapshotPath: string; fingerprint: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(migrationId)) throw new Error('feedback_migration_id_invalid');
  const directory = join(dataDir, 'feedback-migrations', migrationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshotPath = join(directory, 'source.sqlite');
  const existing = await stat(snapshotPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!existing) {
    const pendingPath = `${snapshotPath}.pending`;
    await rm(pendingPath, { force: true });
    const source = join(dataDir, 'botmux-feedback.sqlite');
    const require = createRequire(import.meta.url);
    if (process.versions.bun) {
      const { Database } = require('bun:sqlite');
      const database = new Database(source, { readonly: true });
      try {
        const handle = await open(pendingPath, 'wx', 0o600);
        try { await handle.writeFile(database.serialize()); await handle.sync(); } finally { await handle.close(); }
      } finally { database.close(); }
    } else {
      const { DatabaseSync, backup } = require('node:sqlite');
      if (typeof backup !== 'function') throw new Error('feedback_snapshot_backup_unavailable');
      const database = new DatabaseSync(source, { readOnly: true });
      try { await backup(database, pendingPath); } finally { database.close(); }
      const handle = await open(pendingPath, 'r+');
      try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
    }
    await rename(pendingPath, snapshotPath);
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const fingerprint = `sha256:${createHash('sha256').update(await readFile(snapshotPath)).digest('hex')}`;
  return { snapshotPath, fingerprint };
}

export function canonicalFeedbackRow(row: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
    return typeof value === 'bigint' ? Number(value) : value;
  };
  return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'feedback_order').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [
    key, key.endsWith('_json') && typeof value === 'string' ? canonical(JSON.parse(value)) : canonical(value),
  ])));
}
export function feedbackRows(database: DatabaseSyncLike, table: typeof FEEDBACK_TABLES[number]): Record<string, unknown>[] {
  return database.prepare(`SELECT ${table === 'feedback_revisions' ? 'rowid AS feedback_order,' : ''}* FROM ${table}`).all() as Record<string, unknown>[];
}
export async function workingFeedbackSnapshot(snapshotPath: string): Promise<DatabaseSyncLike> {
  const { dirname } = await import('node:path');
  const { copyFile } = await import('node:fs/promises');
  const directory = join(dirname(snapshotPath), 'working');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'botmux-feedback.sqlite');
  await copyFile(snapshotPath, path);
  const database = await openDatabaseSync(path);
  try {
    for (const table of FEEDBACK_TABLES) for (const operation of ['insert', 'update', 'delete']) database.exec(`DROP TRIGGER IF EXISTS feedback_guard_${table}_${operation}`);
    database.exec('DROP TABLE IF EXISTS feedback_source_guard');
    database.exec('DROP TABLE IF EXISTS feedback_source_restorations');
  } finally { database.close(); }
  const upgraded = await SkillFeedbackStore.open(directory);
  try {
    const checks = upgraded.integrityCheck();
    if (checks.integrity !== 'ok' || checks.foreignKeys.length) throw new Error('feedback_snapshot_integrity_failed');
  } finally { upgraded.close(); }
  return openDatabaseSync(path, { readOnly: true });
}
