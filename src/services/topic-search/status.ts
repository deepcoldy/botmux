import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readFleetState } from '../../core/fleet-state-store.js';
import { pidNotProvablyGone } from '../../utils/process-alive.js';
import { openTopicIndex,sameRevision,sourceSchema,topicIndexPath,assertTopicIndexEngine } from './index-store.js';
import { enumerateSources,sourceRevision,type SourceKind,type SourceStatus } from './sources.js';
import { openReadonlySource } from './readonly-sqlite.js';
import type { DatabaseSyncLike } from '../sqlite-compat.js';
import { resolveFleetDaemonEnv } from '../../core/fleet-runtime.js';

const kinds: SourceKind[] = ['session_store','queue','turn_sends','group_context','output_journal'];
export function topicSearchEnabled(): boolean {
  return resolveFleetDaemonEnv().BOTMUX_TOPIC_SEARCH !== '0';
}
export function topicIndexerStatus() {
  const logs = { out: join(homedir(),'.botmux/logs/topic-index-out.log'),err: join(homedir(),'.botmux/logs/topic-index-err.log') };
  const fleet = readFleetState(join(homedir(),'.botmux/fleet-state.json'));
  const row = fleet?.procs.find(proc => proc.name === 'topic-index');
  const state = !topicSearchEnabled() ? 'disabled' : !fleet ? 'unknown'
    : row?.status === 'errored' ? 'errored' : row?.status === 'online' && row.pid > 0 && pidNotProvablyGone(row.pid) ? 'running' : 'stopped';
  return { state,pid: row?.pid ?? 0,restarts: row?.restarts ?? 0,logs };
}
function optionalCoverage(files: { path: string }[], kind: 'group_context'|'output_journal', count: number): number | Exclude<SourceStatus,'ready'> {
  if (!files.length) return 'absent';
  const states: SourceStatus[] = [];
  for (const file of files) {
    const source = openReadonlySource(file.path,kind === 'group_context' ? [1,2,3,4,5] : [0],kind === 'group_context' ? ['messages','chat_meta'] : ['outputs']);
    if (source.status !== 'ready') { states.push(source.status); continue; }
    try { states.push(source.db.prepare(`SELECT 1 FROM ${kind === 'group_context' ? 'messages' : 'outputs'} LIMIT 1`).get() ? 'ready' : 'empty'); }
    catch { states.push('unreadable'); }
    finally { source.db.close(); }
  }
  if (states.includes('ready')) return count;
  return states.includes('unreadable') ? 'unreadable' : states.includes('schema_unknown') ? 'schema_unknown' : states.includes('empty') ? 'empty' : 'absent';
}
export function readTopicStatus(dataDir: string, mode: 'status' | 'query' = 'status') {
  const indexer = topicIndexerStatus();
  const index: { stale: boolean; staleSources: number; indexer: string; lastSyncAt: number | null } = { stale: true,staleSources: 0,indexer: indexer.state,lastSyncAt: null };
  const coverage: { sources: { queues: number; turnSends: number; sessionStores: number;
    groupContext: number | Exclude<SourceStatus,'ready'>; outputJournal: number | Exclude<SourceStatus,'ready'> };
    skipped: number; malformedLines: number; notes: string[] } = { sources: { queues: 0,turnSends: 0,sessionStores: 0,
    groupContext: 'absent',outputJournal: 'absent' },
    skipped: 0,malformedLines: 0,notes: process.env.BOTMUX_COORDINATION_MODE === 'primary' ? ['coordination_primary'] : [] };
  const base = { path: topicIndexPath(dataDir),index,indexer,coverage };
  let db: DatabaseSyncLike | undefined;
  try {
    const files = kinds.flatMap(kind => enumerateSources(dataDir,kind).files);
    coverage.sources.queues = files.filter(file => file.kind === 'queue').length;
    coverage.sources.turnSends = files.filter(file => file.kind === 'turn_sends').length;
    coverage.sources.sessionStores = files.filter(file => file.kind === 'session_store').length;
    coverage.sources.groupContext = mode === 'status' ? optionalCoverage(files.filter(file => file.kind === 'group_context'),'group_context',0) : files.some(file => file.kind === 'group_context') ? 0 : 'absent';
    coverage.sources.outputJournal = mode === 'status' ? optionalCoverage(files.filter(file => file.kind === 'output_journal'),'output_journal',0) : files.some(file => file.kind === 'output_journal') ? 0 : 'absent';
    db = openTopicIndex(dataDir,{ readOnly: true });
    const stored = new Map(db.prepare('SELECT * FROM sources').all().map(raw => { const source = sourceSchema.parse(raw); return [source.path,source] as const; }));
    for (const [path,source] of stored) if (source.kind === 'session_store') stored.delete(path);
    for (const file of files) {
      if (file.kind === 'session_store') continue;
      try { const revision = sourceRevision(file.path); if (!revision || !sameRevision(stored.get(file.relativePath),revision)) index.staleSources++; }
      catch { index.staleSources++; }
      stored.delete(file.relativePath);
    }
    index.staleSources += stored.size; index.stale = index.staleSources > 0;
    const meta = z.object({ last_sync_finished_at: z.number().nullable(),last_full_check_at: z.number().nullable(),
      last_skipped: z.number().nullable(),last_malformed_lines: z.number().nullable() }).parse(db.prepare('SELECT * FROM sync_meta WHERE singleton=1').get());
    index.lastSyncAt = meta.last_sync_finished_at;
    coverage.skipped = meta.last_skipped ?? 0; coverage.malformedLines = meta.last_malformed_lines ?? 0;
    const documentCount = mode === 'status' ? z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) AS n FROM docs').get()).n : 0;
    const counts = db.prepare("SELECT kind, COUNT(*) AS n FROM entries WHERE kind IN ('group','final') GROUP BY kind").all();
    for (const raw of counts) {
      const row = z.object({ kind: z.enum(['group','final']),n: z.number() }).parse(raw);
      const key = row.kind === 'group' ? 'groupContext' : 'outputJournal';
      if (typeof coverage.sources[key] === 'number') coverage.sources[key] = row.n;
    }
    if (mode === 'query') {
      if (coverage.sources.groupContext === 0) coverage.sources.groupContext = 'empty';
      if (coverage.sources.outputJournal === 0) coverage.sources.outputJournal = 'empty';
    }
    let trigram = true;
    try { if (mode === 'status') db.prepare('SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? LIMIT 1').all('"capability"'); } catch { trigram = false; }
    return { ...base,available: true,schemaVersion: z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version,
      documentCount,lastFullCheckAt: meta.last_full_check_at,engine: { fts5Trigram: trigram },error: null };
  } catch (error) {
    let trigram = true;
    try { if (mode === 'status') assertTopicIndexEngine(); } catch { trigram = false; }
    return { ...base,available: false,schemaVersion: null,documentCount: 0,lastFullCheckAt: null,
      engine: { fts5Trigram: trigram },error: error instanceof Error ? error.message : String(error) };
  } finally { db?.close(); }
}
