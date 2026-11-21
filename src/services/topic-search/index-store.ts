import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../sqlite-compat.js';
import type { Session } from '../../types.js';
import { enumerateSources, readJsonlPage, readTopicSession, readTopicSessions, sessionQueueAnchor,
  sourceRevision, type SourceFile, type SourceKind, type SourceRevision, type SourceStatus } from './sources.js';
import { readOutputJournalPage, type OutputPagePosition } from './output-journal.js';
import { beginPinnedRead } from './readonly-sqlite.js';
import { readGroupContextPage, readGroupContextExistingIds, type GroupChange } from './group-context.js';
import { entrySchema, docSchema, finalEntry, groupEntry, inboundEntry, kindPriority, replyEntry, titleEntry,
  type Entry, type AnchorLookup } from './documents.js';

const APPLICATION_ID = 0x42545331;
const SCHEMA_VERSION = 4;
const TABLES = ['sync_meta', 'sources', 'gc_chat_state', 'gc_pending', 'entries', 'docs', 'recalled',
  'docs_fts', 'docs_fts_data', 'docs_fts_idx', 'docs_fts_docsize', 'docs_fts_config'];
const SCHEMA = `
CREATE TABLE sync_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_sync_started_at INTEGER,last_sync_finished_at INTEGER,last_full_check_at INTEGER,last_skipped INTEGER,last_malformed_lines INTEGER) STRICT;
INSERT INTO sync_meta(singleton) VALUES(1);
CREATE TABLE sources(path TEXT PRIMARY KEY,kind TEXT NOT NULL,dev INTEGER,ino INTEGER,size INTEGER,mtime_ms REAL,
 wal_size INTEGER,wal_mtime_ms REAL,offset INTEGER NOT NULL DEFAULT 0,cursor_seq INTEGER,cursor_updated_at INTEGER,cursor_fingerprint TEXT) STRICT;
CREATE TABLE gc_chat_state(source_path TEXT NOT NULL,chat_id TEXT NOT NULL,pruned_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_path,chat_id)) STRICT;
CREATE TABLE gc_pending(source_path TEXT NOT NULL,seq INTEGER NOT NULL,reason TEXT NOT NULL,anchor TEXT,PRIMARY KEY(source_path,seq)) STRICT;
CREATE TABLE entries(id INTEGER PRIMARY KEY,source_path TEXT NOT NULL,source_key TEXT NOT NULL,kind TEXT NOT NULL,anchor TEXT NOT NULL,dedup_key TEXT NOT NULL,
 message_id TEXT,session_id TEXT,lark_app_id TEXT,sender_type TEXT,sender_id TEXT,sender_name TEXT,time_ms INTEGER,text TEXT NOT NULL,anchor_explicit INTEGER NOT NULL DEFAULT 0,related_session_ids TEXT,UNIQUE(source_path,source_key)) STRICT;
CREATE INDEX ix_entries_merge ON entries(anchor,dedup_key);
CREATE TABLE docs(id INTEGER PRIMARY KEY,anchor TEXT NOT NULL,dedup_key TEXT NOT NULL,kind TEXT NOT NULL,sources TEXT NOT NULL,
 message_id TEXT,session_id TEXT,lark_app_id TEXT,sender_type TEXT,sender_id TEXT,sender_name TEXT,time_ms INTEGER,text TEXT NOT NULL,related_session_ids TEXT,UNIQUE(anchor,dedup_key)) STRICT;
CREATE TABLE recalled(source_path TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(source_path,message_id)) STRICT;
CREATE VIRTUAL TABLE docs_fts USING fts5(text,content='docs',content_rowid='id',tokenize='trigram');`;
export const sourceSchema = z.object({ path: z.string(), kind: z.enum(['queue','turn_sends','session_store','group_context','output_journal']),
  dev: z.number().nullable(), ino: z.number().nullable(), size: z.number().nullable(), mtime_ms: z.number().nullable(),
  wal_size: z.number().nullable(), wal_mtime_ms: z.number().nullable(), offset: z.number(),
  cursor_seq: z.number().nullable(), cursor_updated_at: z.number().nullable(), cursor_fingerprint: z.string().nullable() });
type StoredSource = z.infer<typeof sourceSchema>;
export class TopicIndexError extends Error {
  constructor(message: string, readonly exitCode: 4 | 5 = 4) { super(message); this.name = 'TopicIndexError'; }
}
export function topicIndexPath(dataDir: string): string { return join(dataDir, 'topic-search', 'index.sqlite'); }
export function assertTopicIndexEngine(): void {
  const db = openDatabaseSyncOrThrow(':memory:');
  try { db.exec("CREATE VIRTUAL TABLE capability USING fts5(text,tokenize='trigram')"); }
  finally { db.close(); }
}
function version(db: DatabaseSyncLike): number {
  return z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version;
}
function validateIdentity(db: DatabaseSyncLike): void {
  const id = z.object({ application_id: z.number() }).parse(db.prepare('PRAGMA application_id').get()).application_id;
  if (id !== APPLICATION_ID) throw new TopicIndexError('foreign_topic_index');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(row => z.object({ name: z.string() }).parse(row).name);
  if (tables.some(name => !TABLES.includes(name))) throw new TopicIndexError('unknown_topic_index_table');
}
export function indexTransaction<T>(db: DatabaseSyncLike, run: () => T): T {
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    if (/busy|locked/i.test(String(error))) throw new TopicIndexError('topic_index_lock_timeout', 5);
    throw error;
  }
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back on an I/O error. */ }
    throw error;
  }
}

/** Read-only handles own a pinned read transaction, released by close(). */
export function openTopicIndex(dataDir: string, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}): DatabaseSyncLike {
  const path = topicIndexPath(dataDir);
  const directory = join(dataDir, 'topic-search');
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new TopicIndexError('unsafe_topic_index_directory');
  if (!options.readOnly) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      // Publish a complete database. Another first-time writer must never see
      // our empty file and misclassify it as a foreign database.
      const temporary = `${path}.${randomUUID()}.tmp`;
      closeSync(openSync(temporary,'wx',0o600));
      try {
        const fresh = openDatabaseSyncOrThrow(temporary);
        try {
          indexTransaction(fresh, () => {
            fresh.exec(`PRAGMA application_id=${APPLICATION_ID}`);
            fresh.exec(SCHEMA); fresh.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          });
        } finally { fresh.close(); }
        try { linkSync(temporary,path); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      } finally { rmSync(temporary,{ force: true }); }
    }
  }
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new TopicIndexError('topic_index_unavailable');
  if (options.readOnly) {
    const reader = beginPinnedRead(openDatabaseSyncOrThrow(path, { readOnly: true }), options.busyTimeoutMs);
    try {
      validateIdentity(reader);
      if (version(reader) !== SCHEMA_VERSION) throw new TopicIndexError('topic_index_schema_mismatch');
      return reader;
    } catch (error) { reader.close(); throw error; }
  }
  // Validate an existing file before any writable PRAGMA or permission change.
  const reader = openDatabaseSyncOrThrow(path, { readOnly: true });
  try { reader.exec('PRAGMA busy_timeout=5000'); validateIdentity(reader); }
  finally { reader.close(); }
  const db = openDatabaseSyncOrThrow(path);
  try {
    db.exec('PRAGMA busy_timeout=30000');
    indexTransaction(db, () => {
      validateIdentity(db);
      if (version(db) !== SCHEMA_VERSION) {
        db.exec('DROP TABLE IF EXISTS docs_fts');
        for (const name of ['recalled','docs','entries','gc_pending','gc_chat_state','sources','sync_meta']) db.exec(`DROP TABLE IF EXISTS ${name}`);
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      }
    });
    chmodSync(directory, 0o700); chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    return db;
  } catch (error) { db.close(); throw error; }
}

function storedSource(db: DatabaseSyncLike, path: string): StoredSource | undefined {
  const row = db.prepare('SELECT * FROM sources WHERE path=?').get(path);
  return row ? sourceSchema.parse(row) : undefined;
}
export function sameRevision(stored: StoredSource | undefined, current: SourceRevision): boolean {
  return !!stored && stored.dev === current.dev && stored.ino === current.ino && stored.size === current.size
    && stored.mtime_ms === current.mtimeMs && stored.wal_size === (current.wal?.size ?? null)
    && stored.wal_mtime_ms === (current.wal?.mtimeMs ?? null);
}
function replaced(stored: StoredSource | undefined, current: SourceRevision): boolean {
  return !!stored && (stored.dev !== current.dev || stored.ino !== current.ino);
}
function saveSource(db: DatabaseSyncLike, source: SourceFile, revision: SourceRevision, progress: {
  offset?: number; seq?: number; updatedAt?: number; fingerprint?: string | null; complete: boolean;
}): void {
  db.prepare(`INSERT INTO sources(path,kind,dev,ino,size,mtime_ms,wal_size,wal_mtime_ms,offset,cursor_seq,cursor_updated_at,cursor_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,dev=excluded.dev,ino=excluded.ino,
    size=excluded.size,mtime_ms=excluded.mtime_ms,wal_size=excluded.wal_size,wal_mtime_ms=excluded.wal_mtime_ms,
    offset=excluded.offset,cursor_seq=excluded.cursor_seq,cursor_updated_at=excluded.cursor_updated_at,cursor_fingerprint=excluded.cursor_fingerprint`)
    .run(source.relativePath, source.kind, revision.dev, revision.ino, revision.size, progress.complete ? revision.mtimeMs : null,
      revision.wal?.size ?? null, revision.wal?.mtimeMs ?? null, progress.offset ?? 0, progress.seq ?? null, progress.updatedAt ?? null,
      progress.fingerprint ?? null);
}

function touchEntry(db: DatabaseSyncLike, sourcePath: string, sourceKey: string, touched: Set<string>): void {
  const old = db.prepare('SELECT dedup_key FROM entries WHERE source_path=? AND source_key=?').get(sourcePath, sourceKey);
  if (old) touched.add(z.object({ dedup_key: z.string() }).parse(old).dedup_key);
}
function removeEntry(db: DatabaseSyncLike, sourcePath: string, sourceKey: string, touched: Set<string>): void {
  touchEntry(db, sourcePath, sourceKey, touched);
  db.prepare('DELETE FROM entries WHERE source_path=? AND source_key=?').run(sourcePath, sourceKey);
}
function putEntry(db: DatabaseSyncLike, entry: Entry, touched: Set<string>): void {
  touchEntry(db, entry.source_path, entry.source_key, touched);
  touched.add(entry.dedup_key);
  db.prepare(`INSERT INTO entries(source_path,source_key,kind,anchor,dedup_key,message_id,session_id,lark_app_id,sender_type,sender_id,sender_name,time_ms,text,anchor_explicit,related_session_ids)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_path,source_key) DO UPDATE SET kind=excluded.kind,anchor=excluded.anchor,
    dedup_key=excluded.dedup_key,message_id=excluded.message_id,session_id=excluded.session_id,lark_app_id=excluded.lark_app_id,
    sender_type=excluded.sender_type,sender_id=excluded.sender_id,sender_name=excluded.sender_name,time_ms=excluded.time_ms,text=excluded.text,
    anchor_explicit=excluded.anchor_explicit,related_session_ids=excluded.related_session_ids`)
    .run(entry.source_path,entry.source_key,entry.kind,entry.anchor,entry.dedup_key,entry.message_id,entry.session_id,
      entry.lark_app_id,entry.sender_type,entry.sender_id,entry.sender_name,entry.time_ms,entry.text,entry.anchor_explicit,
      entry.related_session_ids === null ? null : JSON.stringify(entry.related_session_ids));
}
function removeSource(db: DatabaseSyncLike, path: string, touched: Set<string>): void {
  for (const raw of db.prepare('SELECT dedup_key FROM entries WHERE source_path=? UNION SELECT message_id AS dedup_key FROM recalled WHERE source_path=?').all(path,path)) {
    touched.add(z.object({ dedup_key: z.string() }).parse(raw).dedup_key);
  }
  for (const table of ['entries','gc_chat_state','gc_pending','recalled']) db.prepare(`DELETE FROM ${table} WHERE source_path=?`).run(path);
  db.prepare('DELETE FROM sources WHERE path=?').run(path);
}
function mergeDocuments(db: DatabaseSyncLike, touched: ReadonlySet<string>): void {
  if (!touched.size) return;
  const keys = JSON.stringify([...touched]);
  for (const raw of db.prepare('SELECT * FROM docs WHERE dedup_key IN (SELECT value FROM json_each(?))').all(keys)) {
      const doc = docSchema.parse(raw);
      db.prepare("INSERT INTO docs_fts(docs_fts,rowid,text) VALUES('delete',?,?)").run(doc.id,doc.text);
      db.prepare('DELETE FROM docs WHERE id=?').run(doc.id);
  }
  const groups = new Map<string,Entry[]>();
  for (const raw of db.prepare('SELECT * FROM entries WHERE dedup_key IN (SELECT value FROM json_each(?)) ORDER BY source_path,source_key').all(keys)) {
    const entry = entrySchema.parse(raw);
    const group = groups.get(entry.dedup_key);
    if (group) group.push(entry); else groups.set(entry.dedup_key,[entry]);
  }
  for (const key of touched) {
    const entries = groups.get(key) ?? [];
    entries.sort((a,b) => kindPriority(a.kind)-kindPriority(b.kind) || a.source_path.localeCompare(b.source_path) || a.source_key.localeCompare(b.source_key));
    const winner = entries[0];
    if (!winner || (winner.message_id && db.prepare('SELECT 1 FROM recalled WHERE message_id=? LIMIT 1').get(winner.message_id))) continue;
    const sources = [...new Set(entries.map(entry => entry.kind))].sort((a,b) => kindPriority(a)-kindPriority(b));
    const related = [...new Set(entries.flatMap(entry => [
      ...(entry.session_id ? [entry.session_id] : []),...(entry.related_session_ids ?? []),
    ]))].sort();
    const inserted = db.prepare(`INSERT INTO docs(anchor,dedup_key,kind,sources,message_id,session_id,lark_app_id,sender_type,sender_id,sender_name,time_ms,text,related_session_ids)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(winner.anchor,key,winner.kind,JSON.stringify(sources),winner.message_id,winner.session_id,
        winner.lark_app_id,winner.sender_type,winner.sender_id,winner.sender_name,winner.time_ms,winner.text,
        related.length ? JSON.stringify(related) : null);
    db.prepare('INSERT INTO docs_fts(rowid,text) VALUES(?,?)').run(inserted.lastInsertRowid,winner.text);
  }
}

export interface SyncResult {
  processedSources: number; skipped: number; malformedLines: number; stopped: boolean;
  optionalSources: Record<string, SourceStatus>;
}

function applyGroupChanges(db: DatabaseSyncLike, source: SourceFile, changes: readonly GroupChange[], touched: Set<string>): void {
  for (const change of changes) {
    const value = change.value;
    const key = JSON.stringify([value.chatId,value.messageId]);
    if (change.kind === 'pending') {
      removeEntry(db,source.relativePath,key,touched);
      db.prepare(`INSERT INTO gc_pending(source_path,seq,reason,anchor) VALUES(?,?,?,?)
        ON CONFLICT(source_path,seq) DO UPDATE SET reason=excluded.reason,anchor=excluded.anchor
        WHERE gc_pending.reason<>excluded.reason OR gc_pending.anchor IS NOT excluded.anchor`)
        .run(source.relativePath,value.seq,change.reason,value.anchor);
    } else {
      db.prepare('DELETE FROM gc_pending WHERE source_path=? AND seq=?').run(source.relativePath,value.seq);
      if (change.kind === 'recall') {
        db.prepare('INSERT OR IGNORE INTO recalled(source_path,message_id) VALUES(?,?)').run(source.relativePath,value.messageId);
        touched.add(value.messageId);
        removeEntry(db,source.relativePath,key,touched);
      } else putEntry(db,groupEntry(source,value),touched);
    }
  }
}

function syncTitles(db: DatabaseSyncLike, source: SourceFile, sessions: readonly Session[], touched: Set<string>): void {
  const previous = new Map(db.prepare("SELECT * FROM entries WHERE source_path=? AND kind='title'").all(source.relativePath)
    .map(raw => { const entry = entrySchema.parse(raw); return [entry.source_key,entry] as const; }));
  for (const session of sessions) {
    if (!session.title?.trim()) continue;
    const entry = titleEntry(source,session);
    const old = previous.get(entry.source_key);
    if (!old || old.anchor !== entry.anchor || old.text !== entry.text || old.time_ms !== entry.time_ms) putEntry(db,entry,touched);
    previous.delete(entry.source_key);
  }
  for (const key of previous.keys()) removeEntry(db,source.relativePath,key,touched);
}

function reanchorEntries(db: DatabaseSyncLike, sessions: ReadonlyMap<string,Session | undefined>): void {
  const touched = new Set<string>();
  const changes = new Map<string,string>();
  for (const raw of db.prepare("SELECT DISTINCT session_id,anchor FROM entries WHERE kind IN ('reply','final') AND session_id IS NOT NULL AND anchor_explicit=0").all()) {
    const { session_id: id,anchor: previous } = z.object({ session_id: z.string(),anchor: z.string() }).parse(raw);
    const session = sessions.get(id);
    if (!session) continue;
    const anchor = sessionQueueAnchor(session);
    if (anchor !== previous) changes.set(id,anchor);
  }
  if (!changes.size) return;
  for (const [id,anchor] of changes) {
    for (const row of db.prepare(`UPDATE entries SET anchor=? WHERE session_id=? AND kind IN ('reply','final') AND anchor_explicit=0
      AND anchor<>? RETURNING dedup_key`).all(anchor,id,anchor)) touched.add(z.object({ dedup_key: z.string() }).parse(row).dedup_key);
  }
  mergeDocuments(db,touched);
}
function refreshInboundRelations(db: DatabaseSyncLike, lookupAnchor: AnchorLookup, unreadableAppIds: readonly string[]): void {
  // related_session_ids may span apps. Freeze the whole refresh whenever any
  // store is unreadable so a healthy app cannot erase an unreadable app's IDs.
  if (unreadableAppIds.length) return;
  const touched = new Set<string>();
  const rowSchema = z.object({ source_path: z.string(),source_key: z.string(),dedup_key: z.string(),
    lark_app_id: z.string().nullable(),related_session_ids: z.string().nullable() });
  for (const raw of db.prepare("SELECT source_path,source_key,dedup_key,lark_app_id,related_session_ids FROM entries WHERE kind='inbound'").all()) {
    const row = rowSchema.parse(raw);
    if (!row.source_path.startsWith('queues/') || !row.source_path.endsWith('.jsonl')) continue;
    const anchor = row.source_path.slice('queues/'.length,-'.jsonl'.length);
    const sessions = lookupAnchor(anchor);
    const relatedIds = sessions.map(session => session.sessionId).sort();
    const related = relatedIds.length ? JSON.stringify(relatedIds) : null;
    const appId = sessions[0]?.larkAppId ?? null;
    if (row.related_session_ids === related && row.lark_app_id === appId) continue;
    db.prepare('UPDATE entries SET related_session_ids=?,lark_app_id=? WHERE source_path=? AND source_key=?')
      .run(related,appId,row.source_path,row.source_key);
    touched.add(row.dedup_key);
  }
  mergeDocuments(db,touched);
}

function requireReadable(status: SourceStatus): void {
  if (status !== 'ready' && status !== 'empty') throw new Error(`topic_source_${status}`);
}

/** Each call owns its connection; all progress survives only in the specified tables. */
export async function syncTopicIndex(dataDir: string, options: {
  paths?: readonly string[]; rebuild?: boolean; shouldStop?: () => boolean;
} = {}): Promise<SyncResult> {
  const db = openTopicIndex(dataDir);
  const result: SyncResult = { processedSources: 0, skipped: 0, malformedLines: 0, stopped: false, optionalSources: {} };
  const full = options.paths === undefined;
  const selected = options.paths ? new Set(options.paths) : undefined;
  const stop = (): boolean => { result.stopped = options.shouldStop?.() ?? false; return result.stopped; };
  try {
    if (stop()) return result;
    indexTransaction(db, () => {
      if (options.rebuild) {
        db.exec("INSERT INTO docs_fts(docs_fts) VALUES('delete-all')");
        for (const table of ['entries','docs','recalled','gc_pending','gc_chat_state','sources']) db.exec(`DELETE FROM ${table}`);
      }
      db.prepare('UPDATE sync_meta SET last_sync_started_at=? WHERE singleton=1').run(Date.now());
    });
    // This view lives only for this invocation. Watch-driven reply/final scans
    // point-read each distinct session once; group scans need the anchor set.
    const sessionListing = full ? enumerateSources(dataDir,'session_store') : undefined;
    // Stamp before reading: a daemon write during the snapshot must remain
    // visible as a revision change on the next synchronization.
    const sessionRevisions = new Map<string,SourceRevision | null>();
    const skippedSessionPaths = new Set<string>();
    const countedBadApps = new Set(sessionListing?.unreadableKeys);
    for (const source of sessionListing?.files ?? []) {
      try { sessionRevisions.set(source.relativePath,sourceRevision(source.path)); }
      catch { skippedSessionPaths.add(source.relativePath); countedBadApps.add(source.key); result.skipped++; }
    }
    let snapshot: ReturnType<typeof readTopicSessions> | undefined;
    const sessionsById = new Map<string,Session | undefined>();
    const sessionsByApp = new Map<string,Session[]>();
    const sessionsByAnchor = new Map<string,Session[]>();
    const anchors = new Set<string>();
    const loadSnapshot = (): ReturnType<typeof readTopicSessions> => {
      if (snapshot) return snapshot;
      snapshot = readTopicSessions(dataDir);
      for (const appId of snapshot.unreadableAppIds) if (!countedBadApps.has(appId)) { countedBadApps.add(appId); result.skipped++; }
      for (const session of snapshot.sessions) {
        if (countedBadApps.has(session.larkAppId ?? '')) continue;
        sessionsById.set(session.sessionId,session); anchors.add(sessionQueueAnchor(session));
        const anchor = sessionQueueAnchor(session);
        const anchorSessions = sessionsByAnchor.get(anchor);
        if (anchorSessions) anchorSessions.push(session); else sessionsByAnchor.set(anchor,[session]);
        const appId = session.larkAppId ?? '';
        const appSessions = sessionsByApp.get(appId);
        if (appSessions) appSessions.push(session); else sessionsByApp.set(appId,[session]);
      }
      return snapshot;
    };
    const getAnchors = (): ReadonlySet<string> => { loadSnapshot(); return anchors; };
    const lookupSession = (id: string): Session | undefined => {
      if (full) loadSnapshot();
      if (!snapshot && !sessionsById.has(id)) sessionsById.set(id,readTopicSession(dataDir,id));
      return sessionsById.get(id);
    };
    const lookupAnchor = (anchor: string): readonly Session[] => {
      if (full) loadSnapshot();
      if (!snapshot && !sessionsByAnchor.has(anchor)) {
        sessionsByAnchor.set(anchor,readTopicSessions(dataDir).sessions.filter(session => sessionQueueAnchor(session) === anchor));
      }
      return sessionsByAnchor.get(anchor) ?? [];
    };
    const kinds: SourceKind[] = full ? ['session_store','queue','turn_sends','group_context','output_journal']
      : ['queue','turn_sends','group_context','output_journal'];
    let sessionsChanged = false;
    for (const kind of kinds) {
      if (stop()) break;
      const listed = kind === 'session_store' && sessionListing ? sessionListing : enumerateSources(dataDir,kind);
      result.skipped += listed.skipped;
      const files = listed.files.filter(source => !selected || selected.has(source.relativePath));
      const present = new Set(listed.files.map(source => source.relativePath));
      // An unsafe replacement is treated like deletion; never follow it to keep entries alive.
      for (const raw of db.prepare('SELECT * FROM sources WHERE kind=? ORDER BY path').all(kind)) {
        const old = sourceSchema.parse(raw);
        if ((!selected || selected.has(old.path)) && !present.has(old.path)) {
          if (kind === 'session_store' && listed.unreadableKeys.includes(old.path.split('/')[1])) continue;
          indexTransaction(db, () => { const touched = new Set<string>(); removeSource(db,old.path,touched); mergeDocuments(db,touched); });
          if (kind === 'session_store') sessionsChanged = true;
        }
      }
      for (const source of files) {
        if (stop()) break;
        let pageAfter: OutputPagePosition | undefined;
        let savedCursorUpdatedAt: number | null | undefined;
        let firstPage = true;
        let hasMore = true;
        let changed = false;
        let groupRevision: SourceRevision | undefined;
        while (hasMore && !stop()) {
          const pageResult = indexTransaction(db, () => {
            if (kind === 'session_store' && skippedSessionPaths.has(source.relativePath)) return { more: false,changed: false };
            const touched = new Set<string>();
            let revision: SourceRevision | null;
            try { revision = kind === 'session_store' ? sessionRevisions.get(source.relativePath) ?? null : sourceRevision(source.path); }
            catch (error) {
              if (kind !== 'group_context' && kind !== 'output_journal') throw error;
              result.optionalSources[source.relativePath] = 'unreadable';
              removeSource(db,source.relativePath,touched); mergeDocuments(db,touched);
              return { more: false, changed: true };
            }
            if (!revision) { removeSource(db,source.relativePath,touched); mergeDocuments(db,touched); return { more: false, changed: true }; }
            let old = storedSource(db,source.relativePath);
            const reset = (kind !== 'session_store' && replaced(old,revision))
              || ((kind === 'queue' || kind === 'turn_sends') && old?.size !== null && old?.size !== undefined && revision.size < old.size);
            if (reset) { removeSource(db,source.relativePath,touched); old = undefined; pageAfter = undefined; }
            const pending = kind === 'group_context' && !!db.prepare(`SELECT 1 FROM gc_pending WHERE source_path=?
              AND (reason='unverified_card' OR (? AND reason='no_session')) LIMIT 1`).get(source.relativePath,sessionsChanged ? 1 : 0);
            const unchangedRevision = !reset && firstPage && sameRevision(old,revision) && !pending;
            if (unchangedRevision && kind !== 'queue' && kind !== 'turn_sends') return { more: false, changed: false };
            if (kind === 'session_store') {
              if (loadSnapshot().unreadableAppIds.includes(source.key)) return { more: false,changed: false };
              syncTitles(db,source,sessionsByApp.get(source.key) ?? [],touched);
              // A stopped/failed call must retry reanchoring and no_session
              // backfill even if the daemon has not changed metadata again.
              saveSource(db,source,revision,{ complete: false });
            } else if (kind === 'queue' || kind === 'turn_sends') {
              const previous = old && old.dev !== null && old.ino !== null && old.size !== null && old.mtime_ms !== null
                ? { revision: { dev: old.dev, ino: old.ino, size: old.size, mtimeMs: old.mtime_ms }, offset: old.offset,
                  fingerprint: old.cursor_fingerprint } : undefined;
              // A partially processed page has a NULL mtime; the other revision fields still own its offset.
              const cursor = previous ?? (old && old.dev !== null && old.ino !== null && old.size !== null
                ? { revision: { dev: old.dev, ino: old.ino, size: old.size, mtimeMs: 0 }, offset: old.offset,
                  fingerprint: old.cursor_fingerprint } : undefined);
              const page = readJsonlPage(source,cursor);
              requireReadable(page.status);
              if (unchangedRevision && !page.reset) return { more: false, changed: false };
              if (!page.cursor) throw new Error('topic_jsonl_cursor_missing');
              // The reader can detect an in-place rewrite only after opening the
              // file. Drop every old offset before replaying from byte zero.
              if (page.reset && old) { removeSource(db,source.relativePath,touched); old = undefined; }
              result.malformedLines += page.malformedLines;
              for (const row of page.rows) {
                const entry = row.row.kind === 'inbound' ? inboundEntry(source,row.offset,row.row.value,lookupAnchor)
                  : replyEntry(source,row.offset,row.row.value,lookupSession);
                if (entry) putEntry(db,entry,touched);
              }
              saveSource(db,source,{ ...page.cursor.revision, wal: null },{ offset: page.cursor.offset,
                fingerprint: page.cursor.fingerprint, complete: !page.hasMore });
              mergeDocuments(db,touched);
              return { more: page.hasMore, changed: true };
            } else if (kind === 'output_journal') {
              if (pageAfter && (old?.cursor_updated_at ?? null) !== savedCursorUpdatedAt) pageAfter = undefined;
              const page = readOutputJournalPage(source.path,old?.cursor_updated_at === null || old?.cursor_updated_at === undefined
                ? undefined : { updatedAt: old.cursor_updated_at },pageAfter);
              result.optionalSources[source.relativePath] = page.status;
              if (page.status !== 'ready' && page.status !== 'empty') {
                removeSource(db,source.relativePath,touched); mergeDocuments(db,touched); return { more: false, changed: true };
              }
              if (page.status === 'empty') removeSource(db,source.relativePath,touched);
              result.malformedLines += page.malformedLines;
              for (const change of page.changes) {
                if (change.kind === 'remove') removeEntry(db,source.relativePath,change.id,touched);
                else {
                  const entry = finalEntry(source,change.value,lookupSession);
                  if (entry) putEntry(db,entry,touched); else removeEntry(db,source.relativePath,change.value.id,touched);
                }
              }
              pageAfter = page.nextPage;
              saveSource(db,source,revision,{ updatedAt: page.cursor?.updatedAt, complete: !page.hasMore });
              savedCursorUpdatedAt = page.cursor?.updatedAt ?? null;
              mergeDocuments(db,touched);
              return { more: page.hasMore, changed: true };
            } else {
              groupRevision = revision;
              const page = readGroupContextPage(source.path,getAnchors,{ afterSeq: old?.cursor_seq ?? 0 });
              result.optionalSources[source.relativePath] = page.status;
              if (page.status !== 'ready' && page.status !== 'empty') {
                groupRevision = undefined;
                removeSource(db,source.relativePath,touched); mergeDocuments(db,touched); return { more: false, changed: true };
              }
              if (page.status === 'empty') removeSource(db,source.relativePath,touched);
              result.malformedLines += page.malformedLines;
              applyGroupChanges(db,source,page.changes,touched);
              // Leave the revision incomplete until pending checks and retention reconciliation finish.
              saveSource(db,source,revision,{ seq: page.cursorSeq, complete: false });
              mergeDocuments(db,touched);
              return { more: page.hasMore, changed: true };
            }
            mergeDocuments(db,touched);
            return { more: false, changed: true };
          });
          hasMore = pageResult.more; changed ||= pageResult.changed; firstPage = false;
          await setImmediate();
        }
        if (changed) { result.processedSources++; if (kind === 'session_store') sessionsChanged = true; }
        if (kind === 'group_context' && changed && groupRevision && !stop()) {
          await finishGroupSync(db,source,groupRevision,getAnchors,sessionsChanged,stop,result);
        }
      }
      if (kind === 'session_store' && sessionsChanged && !stop()) {
        loadSnapshot();
        indexTransaction(db, () => {
          reanchorEntries(db,sessionsById);
          refreshInboundRelations(db,lookupAnchor,snapshot?.unreadableAppIds ?? []);
        });
      }
    }
    if (!stop()) indexTransaction(db, () => {
      for (const [path,revision] of sessionRevisions) {
        if (!revision || !snapshot || snapshot.unreadableAppIds.includes(path.split('/')[1])) continue;
        db.prepare(`UPDATE sources SET mtime_ms=? WHERE path=? AND kind='session_store' AND mtime_ms IS NULL
          AND dev=? AND ino=? AND size=? AND wal_size IS ? AND wal_mtime_ms IS ?`)
          .run(revision.mtimeMs,path,revision.dev,revision.ino,revision.size,revision.wal?.size ?? null,revision.wal?.mtimeMs ?? null);
      }
      db.prepare(`UPDATE sync_meta SET last_sync_finished_at=?,last_full_check_at=CASE WHEN ? THEN ? ELSE last_full_check_at END WHERE singleton=1`)
        .run(Date.now(),full ? 1 : 0,Date.now());
      if (full) db.prepare('UPDATE sync_meta SET last_skipped=?,last_malformed_lines=? WHERE singleton=1').run(result.skipped,result.malformedLines);
    });
    return result;
  } finally { db.close(); }
}

async function finishGroupSync(db: DatabaseSyncLike, source: SourceFile, revision: SourceRevision, anchors: () => ReadonlySet<string>, sessionsChanged: boolean, stop: () => boolean, result: SyncResult): Promise<void> {
  let unavailable = false;
  const discardUnavailable = (status: SourceStatus): void => {
    unavailable = true; result.optionalSources[source.relativePath] = status;
    const touched = new Set<string>(); removeSource(db,source.relativePath,touched); mergeDocuments(db,touched);
  };
  let afterPending = -1;
  while (!stop()) {
    const count = indexTransaction(db, () => {
      const rows = db.prepare(`SELECT seq FROM gc_pending WHERE source_path=? AND seq>?
        AND (reason='unverified_card' OR (? AND reason='no_session')) ORDER BY seq LIMIT 2000`).all(source.relativePath,afterPending,sessionsChanged ? 1 : 0)
        .map(raw => z.object({ seq: z.number() }).parse(raw).seq);
      if (!rows.length) return 0;
      const page = readGroupContextPage(source.path,anchors,{ pendingSeqs: rows });
      if (page.status !== 'ready' && page.status !== 'empty') { discardUnavailable(page.status); return 0; }
      const touched = new Set<string>();
      const returned = new Set(page.changes.map(change => change.value.seq));
      for (const seq of rows) if (!returned.has(seq)) db.prepare('DELETE FROM gc_pending WHERE source_path=? AND seq=?').run(source.relativePath,seq);
      applyGroupChanges(db,source,page.changes,touched); mergeDocuments(db,touched);
      result.malformedLines += page.malformedLines;
      afterPending = rows[rows.length-1];
      return rows.length;
    });
    if (!count) break;
    await setImmediate();
  }
  if (stop() || unavailable) return;
  const heads = readGroupContextPage(source.path,anchors,{ pendingSeqs: [] });
  if (heads.status !== 'ready' && heads.status !== 'empty') {
    indexTransaction(db, () => discardUnavailable(heads.status)); return;
  }
  for (const chat of heads.chats) {
    const old = db.prepare('SELECT pruned_count FROM gc_chat_state WHERE source_path=? AND chat_id=?').get(source.relativePath,chat.chatId);
    if (old && z.object({ pruned_count: z.number() }).parse(old).pruned_count === chat.prunedCount) continue;
    let afterId = 0;
    while (!stop()) {
      const count = indexTransaction(db, () => {
        const rows = db.prepare(`SELECT id,source_key,message_id FROM entries WHERE source_path=? AND kind='group'
          AND json_extract(source_key,'$[0]')=? AND id>? ORDER BY id LIMIT 2000`).all(source.relativePath,chat.chatId,afterId)
          .map(raw => z.object({ id: z.number(), source_key: z.string(), message_id: z.string() }).parse(raw));
        if (!rows.length) return 0;
        const live = readGroupContextExistingIds(source.path,chat.chatId,rows.map(row => row.message_id));
        if (live.status !== 'ready' && live.status !== 'empty') { discardUnavailable(live.status); return 0; }
        const touched = new Set<string>();
        for (const row of rows) if (!live.messageIds.has(row.message_id)) removeEntry(db,source.relativePath,row.source_key,touched);
        mergeDocuments(db,touched); afterId = rows[rows.length-1].id;
        return rows.length;
      });
      if (!count) break;
      await setImmediate();
    }
    if (stop() || unavailable) return;
    indexTransaction(db, () => db.prepare(`INSERT INTO gc_chat_state(source_path,chat_id,pruned_count) VALUES(?,?,?)
      ON CONFLICT(source_path,chat_id) DO UPDATE SET pruned_count=excluded.pruned_count`).run(source.relativePath,chat.chatId,chat.prunedCount));
  }
  indexTransaction(db, () => {
    const current = storedSource(db,source.relativePath);
    // Use the revision captured before reading. Concurrent source changes remain detectable.
    if (current && !replaced(current,revision)) saveSource(db,source,revision,{ seq: current.cursor_seq ?? 0, complete: true });
  });
}
