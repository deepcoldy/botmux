import { z } from 'zod';
import { openReadonlySource } from './readonly-sqlite.js';
import type { SourceStatus } from './sources.js';

const groupRowSchema = z.object({
  seq: z.number().int(), chat_id: z.string(), message_id: z.string(), revision: z.number().int(),
  root_id: z.string().nullable(), thread_id: z.string().nullable(),
  conversation_scope: z.enum(['main', 'thread']).nullable(), sender_id: z.string(), sender_type: z.string(),
  sender_name: z.string().nullable(), msg_type: z.string(), text: z.string(), create_time: z.number(),
  update_time: z.number().nullable(), deleted: z.number(), card_content_version: z.number().nullable(),
  is_latest: z.number(),
});
const chatSchema = z.object({ chat_id: z.string(), pruned_through_seq: z.number(), pruned_count: z.number() });
export interface GroupMessage {
  seq: number; revision: number; chatId: string; messageId: string; anchor: string;
  senderId: string; senderType: string; senderName?: string; msgType: string;
  text: string; createTime: number; updateTime?: number;
}
export type GroupChange =
  | { kind: 'upsert'; value: GroupMessage }
  | { kind: 'recall'; value: GroupMessage }
  | { kind: 'pending'; reason: 'unverified_card' | 'no_session'; value: GroupMessage };
export interface GroupChatState { chatId: string; prunedThroughSeq: number; prunedCount: number }
export interface GroupContextPage {
  status: SourceStatus; changes: GroupChange[]; cursorSeq: number; hasMore: boolean;
  chats: GroupChatState[]; malformedLines: number;
}

type SessionAnchors = ReadonlySet<string> | (() => ReadonlySet<string>);
function groupChange(raw: unknown, sessionAnchors: SessionAnchors, legacyScope: boolean): GroupChange | undefined {
  const row = groupRowSchema.parse(raw);
  if (!row.is_latest) return undefined;
  // v1..v3 have no conversation_scope column; only those versions infer from thread_id.
  const thread = row.conversation_scope === 'thread'
    || (legacyScope && !!row.thread_id);
  const value: GroupMessage = {
    seq: row.seq, revision: row.revision, chatId: row.chat_id, messageId: row.message_id,
    anchor: thread ? row.root_id ?? '' : row.chat_id,
    senderId: row.sender_id, senderType: row.sender_type, senderName: row.sender_name ?? undefined,
    msgType: row.msg_type, text: row.text, createTime: row.create_time, updateTime: row.update_time ?? undefined,
  };
  // Recall evidence survives both pending reasons and applies across all other sources.
  if (row.deleted) return { kind: 'recall', value };
  if (row.msg_type === 'interactive' && row.card_content_version === null) {
    return { kind: 'pending', reason: 'unverified_card', value };
  }
  const anchors = typeof sessionAnchors === 'function' ? sessionAnchors() : sessionAnchors;
  if (!anchors.has(value.anchor)) return { kind: 'pending', reason: 'no_session', value };
  return { kind: 'upsert', value };
}

/** A seq scan also serves per-chat existence reconciliation after retention changes.
 * Supplying pendingSeqs rereads in-place card upgrades or newly admitted anchors. */
export function readGroupContextPage(path: string, sessionAnchors: SessionAnchors, options: {
  afterSeq?: number; chatId?: string; pendingSeqs?: readonly number[];
} = {}): GroupContextPage {
  if (options.pendingSeqs && options.pendingSeqs.length > 2000) throw new Error('group_pending_page_too_large');
  const afterSeq = options.afterSeq ?? 0;
  const empty = { changes: [], cursorSeq: afterSeq, hasMore: false, chats: [], malformedLines: 0 };
  const source = openReadonlySource(path, [1, 2, 3, 4, 5], ['messages', 'chat_meta']);
  if (source.status !== 'ready') return { ...empty, status: source.status };
  const { db, version } = source;
  try {
    // Only select columns guaranteed by the declared schema version.
    const columns = `m.seq,m.chat_id,m.message_id,m.revision,m.root_id,m.thread_id,
      m.sender_id,m.sender_type,m.sender_name,m.msg_type,m.text,m.create_time,m.deleted,
      ${version >= 2 ? 'm.update_time' : 'NULL'} AS update_time,
      ${version >= 3 ? 'm.card_content_version' : 'NULL'} AS card_content_version,
      ${version >= 4 ? 'm.conversation_scope' : 'NULL'} AS conversation_scope,
      NOT EXISTS(SELECT 1 FROM messages newer WHERE newer.chat_id=m.chat_id
        AND newer.message_id=m.message_id AND newer.revision>m.revision) AS is_latest`;
    const pending = options.pendingSeqs;
    const params: unknown[] = pending ? [...pending] : [afterSeq];
    let where = pending ? (pending.length ? `m.seq IN (${pending.map(() => '?').join(',')})` : '0') : 'm.seq>?';
    if (options.chatId !== undefined) { where += ' AND m.chat_id=?'; params.push(options.chatId); }
    const rows = db.prepare(`SELECT ${columns} FROM messages m WHERE ${where} ORDER BY m.seq LIMIT 2000`).all(...params);
    const changes: GroupChange[] = [];
    let cursorSeq = afterSeq;
    let malformedLines = 0;
    for (const raw of rows) {
      const { seq } = z.object({ seq: z.number().int() }).parse(raw);
      if (!pending) cursorSeq = seq;
      try { const change = groupChange(raw, sessionAnchors, version < 4); if (change) changes.push(change); }
      catch { malformedLines++; }
    }
    const chats = db.prepare('SELECT chat_id,pruned_through_seq,pruned_count FROM chat_meta').all().map(raw => {
      const row = chatSchema.parse(raw);
      return { chatId: row.chat_id, prunedThroughSeq: row.pruned_through_seq, prunedCount: row.pruned_count };
    });
    const present = !!db.prepare('SELECT 1 FROM messages LIMIT 1').get();
    return { status: present ? 'ready' : 'empty', changes, cursorSeq,
      hasMore: !pending && rows.length === 2000, chats, malformedLines };
  } catch { return { ...empty, status: 'unreadable' }; }
  finally { db.close(); }
}

/** Bounded existence check for retention reconciliation; no source writes. */
export function readGroupContextExistingIds(path: string, chatId: string, messageIds: readonly string[]): {
  status: SourceStatus; messageIds: Set<string>;
} {
  if (messageIds.length > 2000) throw new Error('group_existence_page_too_large');
  const source = openReadonlySource(path, [1,2,3,4,5], ['messages','chat_meta']);
  if (source.status !== 'ready') return { status: source.status, messageIds: new Set() };
  try {
    const rows = messageIds.length ? source.db.prepare(`SELECT DISTINCT message_id FROM messages WHERE chat_id=?
      AND message_id IN (${messageIds.map(() => '?').join(',')})`).all(chatId, ...messageIds) : [];
    return { status: 'ready', messageIds: new Set(rows.map(raw => z.object({ message_id: z.string() }).parse(raw).message_id)) };
  } catch { return { status: 'unreadable', messageIds: new Set() }; }
  finally { source.db.close(); }
}
