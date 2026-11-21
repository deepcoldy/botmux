import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Session } from '../../types.js';
import { sessionQueueAnchor, type InboundRow, type ReplyRow, type SourceFile } from './sources.js';
import type { FinalOutput } from './output-journal.js';
import type { GroupMessage } from './group-context.js';

const relatedSessionIdsSchema = z.string().nullable().transform(value => value === null ? null : z.array(z.string()).parse(JSON.parse(value)));
export const entryKindSchema = z.enum(['inbound', 'reply', 'final', 'group', 'title']);
export const entrySchema = z.object({
  source_path: z.string(), source_key: z.string(), kind: entryKindSchema,
  anchor: z.string(), anchor_explicit: z.number().int().min(0).max(1), dedup_key: z.string(), message_id: z.string().nullable(), session_id: z.string().nullable(),
  lark_app_id: z.string().nullable(), sender_type: z.string().nullable(), sender_id: z.string().nullable(),
  sender_name: z.string().nullable(), time_ms: z.number().nullable(), text: z.string(), related_session_ids: relatedSessionIdsSchema,
});
export type Entry = z.infer<typeof entrySchema>;
export const docSchema = entrySchema.omit({ source_path: true, source_key: true, anchor_explicit: true }).extend({
  id: z.number(), sources: z.string().transform(value => z.array(entryKindSchema).parse(JSON.parse(value))),
});
export type TopicDocument = z.infer<typeof docSchema>;
export type SessionLookup = (sessionId: string) => Session | undefined;
export type AnchorLookup = (anchor: string) => readonly Session[];
export const kindPriority = (kind: Entry['kind']): number => ({ final: 0, group: 1, inbound: 2, reply: 3, title: 4 })[kind];
export function timeMs(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const number = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(number) ? number : null;
}
function base(source: SourceFile, key: string): Entry {
  return { source_path: source.relativePath, source_key: key, kind: 'title', anchor: '', anchor_explicit: 0, dedup_key: '',
    message_id: null, session_id: null, lark_app_id: null, sender_type: null, sender_id: null,
    sender_name: null, time_ms: null, text: '', related_session_ids: null };
}
export function inboundEntry(source: SourceFile, offset: number, row: InboundRow, lookupAnchor: AnchorLookup): Entry {
  const related = lookupAnchor(source.key);
  return { ...base(source, String(offset)), kind: 'inbound', anchor: row.rootId || row.chatId || source.key, dedup_key: row.messageId,
    message_id: row.messageId, lark_app_id: related[0]?.larkAppId ?? null, related_session_ids: related.length ? related.map(session => session.sessionId) : null,
    sender_type: row.senderType ?? null, sender_id: row.senderId ?? null,
    sender_name: row.senderName ?? null, time_ms: timeMs(row.createTime), text: row.content };
}
export function replyEntry(source: SourceFile, offset: number, row: ReplyRow, lookup: SessionLookup): Entry | undefined {
  if (!row.previewText) return undefined;
  const sessionId = row.sessionId ?? source.key;
  const session = lookup(sessionId);
  const explicitAnchor = row.targetRootMessageId || row.targetChatId;
  const anchor = explicitAnchor || (session ? sessionQueueAnchor(session) : undefined);
  if (!anchor) return undefined;
  const hash = row.contentHash ?? createHash('sha256').update(row.previewText).digest('hex');
  return { ...base(source, String(offset)), kind: 'reply', anchor, anchor_explicit: explicitAnchor ? 1 : 0, message_id: row.messageId ?? null,
    dedup_key: row.messageId ?? `reply:${JSON.stringify([sessionId, row.sentAtMs, hash])}`,
    session_id: sessionId, lark_app_id: session?.larkAppId ?? null, sender_type: 'bot',
    time_ms: row.sentAtMs, text: row.previewText };
}
export function finalEntry(source: SourceFile, row: FinalOutput, lookup: SessionLookup): Entry | undefined {
  const session = lookup(row.sessionId);
  const explicitAnchor = row.rootMessageId || row.chatId;
  const anchor = explicitAnchor || (session ? sessionQueueAnchor(session) : undefined);
  if (!anchor) return undefined;
  return { ...base(source, row.id), kind: 'final', anchor, anchor_explicit: explicitAnchor ? 1 : 0, dedup_key: row.messageId ?? `final:${row.id}`,
    message_id: row.messageId ?? null, session_id: row.sessionId, lark_app_id: source.key,
    sender_type: 'bot', time_ms: row.createdAt, text: row.text };
}
export function titleEntry(source: SourceFile, session: Session): Entry {
  return { ...base(source, session.sessionId), kind: 'title', anchor: sessionQueueAnchor(session),
    dedup_key: `title:${session.sessionId}`, session_id: session.sessionId, lark_app_id: source.key,
    time_ms: timeMs(session.createdAt), text: session.title ?? '' };
}
export function groupEntry(source: SourceFile, row: GroupMessage): Entry {
  return { ...base(source, JSON.stringify([row.chatId, row.messageId])), kind: 'group', anchor: row.anchor,
    dedup_key: row.messageId, message_id: row.messageId, lark_app_id: source.key,
    sender_type: row.senderType, sender_id: row.senderId, sender_name: row.senderName ?? null,
    time_ms: row.updateTime ?? row.createTime, text: row.text };
}
