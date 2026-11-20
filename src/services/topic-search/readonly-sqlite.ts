import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../sqlite-compat.js';
import type { SourceStatus } from './sources.js';

const READ_BUSY_TIMEOUT_MS = 5_000;

export type ReadonlySource = { status: 'ready'; db: DatabaseSyncLike; version: number }
  | { status: Exclude<SourceStatus, 'ready' | 'empty'> };

/** Pins one read snapshot until close(). close() ends it with ROLLBACK first: under
 *  Bun, close() with unfinalized statements leaves the connection alive until GC,
 *  and a connection still inside BEGIN keeps its snapshot, so the source's own
 *  writer cannot checkpoint (its WAL keeps growing) until then. */
export function beginPinnedRead(db: DatabaseSyncLike, busyTimeoutMs = READ_BUSY_TIMEOUT_MS): DatabaseSyncLike {
  try { db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`); db.exec('BEGIN'); }
  catch (error) { db.close(); throw error; }
  return {
    exec: sql => db.exec(sql),
    prepare: sql => db.prepare(sql),
    close: () => {
      try { db.exec('ROLLBACK'); } catch { /* An I/O error may already have rolled the read back. */ }
      db.close();
    },
  };
}

/** No migrations, chmod, journal-mode changes, or writer-side open helpers. */
export function openReadonlySource(path: string, versions: readonly number[], tables: readonly string[]): ReadonlySource {
  let db: DatabaseSyncLike | undefined;
  try {
    if (!lstatSync(path).isFile()) return { status: 'unreadable' };
    for (const suffix of ['-wal', '-shm']) {
      try { if (!lstatSync(`${path}${suffix}`).isFile()) return { status: 'unreadable' }; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    db = beginPinnedRead(openDatabaseSyncOrThrow(path, { readOnly: true }));
    const { user_version: version } = z.object({ user_version: z.number().int() })
      .parse(db.prepare('PRAGMA user_version').get());
    if (!versions.includes(version)) { db.close(); return { status: 'schema_unknown' }; }
    for (const table of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        db.close(); return { status: 'absent' };
      }
    }
    return { status: 'ready', db, version };
  } catch (error) {
    db?.close();
    return { status: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
}
