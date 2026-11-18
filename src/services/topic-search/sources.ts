import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sessionQueueAnchor } from '../../core/session-message-preview.js';
import { listUnmigratedAppIds, readBotSessionsStrict, readSessionRowFromDisk } from '../session-store.js';
import type { Session } from '../../types.js';

export { sessionQueueAnchor };
export type SourceKind = 'queue' | 'turn_sends' | 'session_store' | 'output_journal' | 'group_context';
export interface SourceFile { kind: SourceKind; key: string; path: string; relativePath: string }
export interface FileRevision { dev: number; ino: number; size: number; mtimeMs: number }
export interface SourceRevision extends FileRevision { wal: FileRevision | null }
export type SourceStatus = 'absent' | 'empty' | 'unreadable' | 'schema_unknown' | 'ready';
export const safeSourceKey = (key: string): boolean => /^[A-Za-z0-9_-]+$/.test(key);

export function fileRevision(path: string): FileRevision | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function sourceRevision(path: string): SourceRevision | null {
  const revision = fileRevision(path);
  return revision ? { ...revision, wal: fileRevision(`${path}-wal`) } : null;
}

export function enumerateSources(dataDir: string, kind: SourceKind): { files: SourceFile[]; skipped: number; unreadableKeys: string[] } {
  const directory = { queue: 'queues', turn_sends: 'turn-sends', session_store: 'session-stores',
    output_journal: 'output-delivery-journals', group_context: 'group-context' }[kind];
  const extension = { queue: '.jsonl', turn_sends: '.jsonl', session_store: '',
    output_journal: '.db', group_context: '.sqlite' }[kind];
  const root = join(dataDir, directory);
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) return { files: [], skipped: 1,unreadableKeys: [] };
    names = readdirSync(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { files: [], skipped: 0,unreadableKeys: [] };
    throw error;
  }
  const files: SourceFile[] = [];
  let skipped = 0;
  const unreadableKeys: string[] = [];
  for (const name of names.sort()) {
    // SQLite sidecars belong to the main source's revision, never to the source list.
    if (extension && (name.endsWith(`${extension}-wal`) || name.endsWith(`${extension}-shm`))) continue;
    const key = extension ? name.slice(0, -extension.length) : name;
    if ((extension && !name.endsWith(extension)) || !safeSourceKey(key)) { skipped++; continue; }
    try {
      const candidate = join(root, name);
      if (kind === 'session_store' && !lstatSync(candidate).isDirectory()) { skipped++; continue; }
      const path = kind === 'session_store' ? join(candidate, 'sessions.db') : candidate;
      if (!fileRevision(path)) { skipped++; continue; }
      files.push({ kind, key, path, relativePath: kind === 'session_store'
        ? `${directory}/${key}/sessions.db` : `${directory}/${name}` });
    } catch (error) {
      skipped++;
      if (kind === 'session_store' && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadableKeys.push(key);
    }
  }
  return { files, skipped,unreadableKeys };
}

const inboundSchema = z.object({
  messageId: z.string().min(1), content: z.string(), rootId: z.string().optional(),
  threadId: z.string().optional(), chatId: z.string().optional(), senderId: z.string().optional(),
  senderType: z.string().optional(), senderName: z.string().optional(), msgType: z.string().optional(),
  createTime: z.union([z.string(), z.number()]).optional(),
});
const replySchema = z.object({
  sessionId: z.string().optional(), messageId: z.string().optional(), sentAtMs: z.number().finite(),
  previewText: z.string().optional(), responseKind: z.string().optional(), targetChatId: z.string().optional(),
  targetRootMessageId: z.string().optional(), contentHash: z.string().optional(),
});
export type InboundRow = z.infer<typeof inboundSchema>;
export type ReplyRow = z.infer<typeof replySchema>;
export type JsonlRow = { kind: 'inbound'; value: InboundRow } | { kind: 'reply'; value: ReplyRow };
export interface JsonlCursor { revision: FileRevision; offset: number }
export interface JsonlPage {
  status: 'ready' | 'absent' | 'unreadable'; reset: boolean;
  rows: { offset: number; row: JsonlRow }[]; cursor?: JsonlCursor;
  malformedLines: number; hasMore: boolean;
}

/** Offsets count bytes, including malformed rows; a partial UTF-8 line stays unconsumed. */
export function readJsonlPage(source: SourceFile, previous?: JsonlCursor): JsonlPage {
  const empty = { rows: [], malformedLines: 0, hasMore: false };
  let fd: number | undefined;
  try {
    fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ...empty, status: 'unreadable', reset: true };
    const revision: FileRevision = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    const reset = !previous || previous.revision.dev !== revision.dev || previous.revision.ino !== revision.ino
      || revision.size < previous.revision.size;
    const start = reset ? 0 : previous.offset;
    const chunks: Buffer[] = [];
    let position = start;
    let completeLength = 0;
    // Permit one long line to exceed the page budget, so it cannot wedge the cursor forever.
    while (position < revision.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, revision.size - position));
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      const newline = chunk.subarray(0, count).lastIndexOf(10);
      if (newline >= 0) completeLength = position - start + newline + 1;
      position += count;
      if (position - start >= 256 * 1024 && completeLength > 0) break;
    }
    const bytes = Buffer.concat(chunks).subarray(0, completeLength);
    const rows: JsonlPage['rows'] = [];
    let malformedLines = 0;
    let lineStart = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      const line = bytes.subarray(lineStart, i).toString('utf8');
      const offset = start + lineStart;
      lineStart = i + 1;
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (source.kind === 'queue') {
          const parsed = inboundSchema.safeParse(value);
          if (!parsed.success) { malformedLines++; continue; }
          rows.push({ offset, row: { kind: 'inbound', value: parsed.data } });
        } else {
          const parsed = replySchema.safeParse(value);
          if (!parsed.success) { malformedLines++; continue; }
          if (!parsed.data.previewText) continue;
          rows.push({ offset, row: { kind: 'reply', value: parsed.data } });
        }
      } catch { malformedLines++; }
    }
    return { status: 'ready', reset, rows, malformedLines,
      cursor: { revision, offset: start + completeLength }, hasMore: position < revision.size };
  } catch (error) {
    const absent = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { ...empty, status: absent ? 'absent' : 'unreadable', reset: true };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readTopicSessions(dataDir: string): {
  sessions: Session[]; sources: SourceFile[]; skipped: number; unreadableStores: number; unreadableAppIds: string[]; unmigratedAppIds: string[];
} {
  const { files, skipped,unreadableKeys } = enumerateSources(dataDir, 'session_store');
  const sessions: Session[] = [];
  let unreadableStores = unreadableKeys.length;
  const unreadableAppIds = [...unreadableKeys];
  for (const source of files) {
    try {
      sessions.push(...readBotSessionsStrict(source.key, dataDir).map(session => ({
        ...session, larkAppId: session.larkAppId ?? source.key,
      })));
    } catch { unreadableStores++; unreadableAppIds.push(source.key); }
  }
  return { sessions, sources: files, skipped, unreadableStores, unreadableAppIds,
    unmigratedAppIds: listUnmigratedAppIds(dataDir).filter(safeSourceKey) };
}

/** Each lookup reads the current row, independently of the last full session scan. */
export function readTopicSession(dataDir: string, sessionId: string, appId?: string): Session | undefined {
  const sources = enumerateSources(dataDir, 'session_store').files;
  for (const source of sources) {
    if (appId !== undefined && source.key !== appId) continue;
    const session = readSessionRowFromDisk(sessionId, source.key, dataDir);
    if (session) return { ...session, larkAppId: session.larkAppId ?? source.key };
  }
  return undefined;
}
