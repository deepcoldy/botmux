import { z } from 'zod';
import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import type { Session } from '../../types.js';
import { isNativeTopicId } from '../../core/native-topic-id.js';
import { chatAppLink, threadAppLink } from '../../im/lark/lark-hosts.js';
import { docSchema, entryKindSchema, kindPriority, timeMs, type TopicDocument } from './documents.js';
import { openTopicIndex, TopicIndexError } from './index-store.js';
import { readTopicSessions, sessionQueueAnchor } from './sources.js';
import type { DatabaseSyncLike } from '../sqlite-compat.js';

export class TopicQueryError extends Error {
  readonly exitCode = 2;
  constructor(message: string) { super(message); this.name = 'TopicQueryError'; }
}
const requestSchema = z.object({ query: z.union([z.string(),z.array(z.string())]), limit: z.number().int().min(1).max(100).default(20),
  hits: z.number().int().min(1).max(20).default(3), since: z.union([z.string(),z.number().finite()]).optional(),
  until: z.union([z.string(),z.number().finite()]).optional(), bot: z.string().optional() }).strict();
export type SearchRequest = z.input<typeof requestSchema>;
type BotDisplay = Pick<BotConfig,'larkAppId'|'name'|'brand'>;
export interface TopicSummary {
  anchor: string; scope: 'chat' | 'thread'; chatId: string | null; chatName: string | null;
  title: string; link: string | null; lastActiveAt: number; status: 'open' | 'closed';
  sessions: { sessionId: string; bot: string; cliId: string | null; status: Session['status'] }[];
  notes: string[];
}
export interface TopicHit {
  kind: TopicDocument['kind']; messageId?: string; senderType?: string; time: number | null; snippet: string; bot?: string;
}
export interface TopicResult extends TopicSummary { hits: { count: number; items: TopicHit[] } }

export function parseTopicQuery(input: SearchRequest): {
  query: string; terms: string[]; limit: number; hits: number; since?: number; until?: number; bot?: string;
} {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new TopicQueryError('invalid_topic_search_arguments');
  const value = parsed.data;
  const raw = Array.isArray(value.query) ? value.query.join(' ') : value.query;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw new TopicQueryError('invalid_topic_query_control_character');
  const query = raw.trim().replace(/\s+/g,' ');
  if (!query || query.length > 200) throw new TopicQueryError('invalid_topic_query_length');
  const since = value.since === undefined ? undefined : timeMs(value.since);
  const until = value.until === undefined ? undefined : timeMs(value.until);
  if (since === null || until === null || (since !== undefined && until !== undefined && since > until)) throw new TopicQueryError('invalid_topic_time_range');
  return { query, terms: [...new Set(query.split(' '))], limit: value.limit, hits: value.hits, since, until, bot: value.bot };
}
export function topicSnippet(text: string, terms: readonly string[]): string {
  const compact = text.replace(/\s+/g,' ').trim();
  const points = Array.from(compact);
  if (points.length <= 160) return compact;
  const lower = compact.toLowerCase();
  let index = -1;
  for (const term of terms) { index = lower.indexOf(term.toLowerCase()); if (index >= 0) break; }
  const center = index < 0 ? 0 : Array.from(compact.slice(0,index)).length;
  let start = Math.max(0,center-79);
  const end = Math.min(points.length,start+158);
  start = Math.max(0,end-158);
  return `${start ? '…' : ''}${points.slice(start,end).join('')}${end < points.length ? '…' : ''}`;
}
function configuredBots(provided?: readonly BotDisplay[]): readonly BotDisplay[] {
  if (provided) return provided;
  try { return loadBotConfigs(); } catch { return []; }
}
interface MatchingHit {
  id: number;
  anchor: string;
  kind: TopicDocument['kind'];
  time_ms: number | null;
  session_id: string | null;
  reply_truncated: number;
}
function parseHit(raw: unknown): MatchingHit {
  if (raw === null || typeof raw !== 'object' || !('id' in raw)
    || typeof raw.id !== 'number' || !Number.isFinite(raw.id)) throw new Error('invalid_topic_hit.id');
  if (!('anchor' in raw) || typeof raw.anchor !== 'string') throw new Error('invalid_topic_hit.anchor');
  const kind = 'kind' in raw ? entryKindSchema.options.find(kind => kind === raw.kind) : undefined;
  if (kind === undefined) throw new Error('invalid_topic_hit.kind');
  if (!('time_ms' in raw) || (raw.time_ms !== null
    && (typeof raw.time_ms !== 'number' || !Number.isFinite(raw.time_ms)))) throw new Error('invalid_topic_hit.time_ms');
  if (!('session_id' in raw) || (raw.session_id !== null && typeof raw.session_id !== 'string')) {
    throw new Error('invalid_topic_hit.session_id');
  }
  if (!('reply_truncated' in raw) || typeof raw.reply_truncated !== 'number' || !Number.isFinite(raw.reply_truncated)) {
    throw new Error('invalid_topic_hit.reply_truncated');
  }
  return { id: raw.id, anchor: raw.anchor, kind, time_ms: raw.time_ms,
    session_id: raw.session_id, reply_truncated: raw.reply_truncated };
}
interface SessionIndex {
  byAnchor: Map<string, Session[]>;
  ids: Set<string>;
}
interface HitNotes { metaMissing: boolean; replyTruncated: boolean }

function indexSessions(sessions: readonly Session[]): SessionIndex {
  const byAnchor = new Map<string, Session[]>();
  const ids = new Set<string>();
  for (const session of sessions) {
    const anchor = sessionQueueAnchor(session);
    const group = byAnchor.get(anchor);
    if (group) group.push(session); else byAnchor.set(anchor, [session]);
    ids.add(session.sessionId);
  }
  for (const group of byAnchor.values()) group.sort((a,b) =>
    (timeMs(b.lastMessageAt ?? b.createdAt) ?? 0)-(timeMs(a.lastMessageAt ?? a.createdAt) ?? 0) || a.sessionId.localeCompare(b.sessionId));
  return { byAnchor, ids };
}
function lastActiveAt(sessions: readonly Session[]): number {
  return sessions.reduce((latest, session) => Math.max(latest, timeMs(session.lastMessageAt ?? session.createdAt) ?? 0), 0);
}
function compareHits(a: Pick<TopicDocument, 'id' | 'kind' | 'time_ms'>, b: Pick<TopicDocument, 'id' | 'kind' | 'time_ms'>): number {
  return (b.time_ms ?? 0)-(a.time_ms ?? 0) || kindPriority(a.kind)-kindPriority(b.kind) || a.id-b.id;
}
function missingHitSession(hit: Pick<TopicDocument, 'kind' | 'session_id'>, sessions: SessionIndex): boolean {
  return (hit.kind === 'reply' || hit.kind === 'final')
    && (hit.session_id === null || !sessions.ids.has(hit.session_id));
}
function summary(db: DatabaseSyncLike, anchor: string, sessionIndex: SessionIndex, bots: readonly BotDisplay[], hitNotes: HitNotes): TopicSummary {
  const sessions = sessionIndex.byAnchor.get(anchor) ?? [];
  const representative = sessions[0];
  const scope = representative?.scope ?? (anchor.startsWith('oc_') ? 'chat' : 'thread');
  const chatId = representative?.chatId ?? (scope === 'chat' ? anchor : null);
  const bot = bots.find(item => item.larkAppId === representative?.larkAppId);
  const threadId = representative?.larkThreadId;
  const earliest = representative ? undefined : db.prepare("SELECT text FROM docs WHERE anchor=? AND kind='inbound' ORDER BY time_ms,id LIMIT 1").get(anchor);
  const title = representative?.title || (earliest ? z.object({ text: z.string() }).parse(earliest).text : anchor);
  const notes: string[] = [];
  if (!sessions.length || hitNotes.metaMissing) notes.push('meta_missing');
  const closed = sessions.length > 0 && sessions.every(session => session.status === 'closed');
  if (closed && !db.prepare("SELECT 1 FROM docs WHERE anchor=? AND (kind IN ('reply','final') OR (kind='group' AND sender_type IN ('bot','app'))) LIMIT 1").get(anchor)) {
    notes.push('replies_removed_on_close');
  }
  if (hitNotes.replyTruncated) notes.push('reply_truncated');
  return { anchor,scope,chatId,chatName: representative?.chatDisplayName ?? null,title,
    link: !chatId ? null : scope === 'thread' && isNativeTopicId(threadId)
      ? threadAppLink(chatId,threadId,bot?.brand) : chatAppLink(chatId,bot?.brand),
    lastActiveAt: lastActiveAt(sessions),
    status: closed ? 'closed' : 'open',
    sessions: sessions.map(session => ({ sessionId: session.sessionId, bot: bots.find(item => item.larkAppId === session.larkAppId)?.name
      ?? session.larkAppId ?? '',cliId: session.cliId ?? null,status: session.status })), notes };
}

export interface TopicSearchOptions {
  sessions?: readonly Session[];
  busyTimeoutMs?: number;
}

export function searchTopics(dataDir: string, input: SearchRequest, providedBots?: readonly BotDisplay[], options: TopicSearchOptions = {}): {
  query: string; results: TopicResult[]; truncated: boolean;
} {
  const request = parseTopicQuery(input);
  const db = openTopicIndex(dataDir,{ readOnly: true, busyTimeoutMs: options.busyTimeoutMs });
  try {
    const long = request.terms.filter(term => Array.from(term).length >= 3);
    const short = request.terms.filter(term => Array.from(term).length < 3);
    const matching = new Map<string, { terms: Set<string>; docs: Map<number, MatchingHit> }>();
    let candidates: Set<string> | undefined;
    // Byte suffix comparison preserves endsWith semantics even with embedded NULs.
    const columns = `d.id,d.anchor,d.kind,d.time_ms,d.session_id,
      CASE WHEN d.kind='reply' THEN substr(CAST(d.text AS BLOB),-3)=CAST('…' AS BLOB) ELSE 0 END AS reply_truncated`;
    for (const term of [...long,...short]) {
      const isLong = Array.from(term).length >= 3;
      const params: unknown[] = [isLong ? `"${term.replace(/"/g,'""')}"` : `%${term.replace(/[\\%_]/g,'\\$&')}%`];
      let sql = isLong ? `SELECT ${columns} FROM docs d JOIN docs_fts ON docs_fts.rowid=d.id WHERE docs_fts MATCH ?`
        : `SELECT ${columns} FROM docs d WHERE d.text LIKE ? ESCAPE '\\'`;
      if (request.since !== undefined) { sql += ' AND d.time_ms>=?'; params.push(request.since); }
      if (request.until !== undefined) { sql += ' AND d.time_ms<=?'; params.push(request.until); }
      if (!isLong && candidates) { sql += ' AND d.anchor IN (SELECT value FROM json_each(?))'; params.push(JSON.stringify([...candidates])); }
      const rows = db.prepare(sql).all(...params);
      const anchors = new Set<string>();
      for (const raw of rows) {
        const doc = parseHit(raw);
        anchors.add(doc.anchor);
        let group = matching.get(doc.anchor);
        if (!group) { group = { terms: new Set(),docs: new Map() }; matching.set(doc.anchor,group); }
        group.terms.add(term); group.docs.set(doc.id,doc);
      }
      if (isLong) candidates = candidates ? new Set([...candidates].filter(anchor => anchors.has(anchor))) : anchors;
    }
    const sessions = indexSessions(options.sessions ?? readTopicSessions(dataDir).sessions);
    const bots = configuredBots(providedBots);
    const botApps = new Set(bots.filter(bot => bot.name === request.bot).map(bot => bot.larkAppId));
    const ranked: Array<{ anchor: string; docs: MatchingHit[]; lastActiveAt: number; notes: HitNotes }> = [];
    for (const [anchor,group] of matching) {
      if (group.terms.size !== request.terms.length) continue;
      const topicSessions = sessions.byAnchor.get(anchor) ?? [];
      if (request.bot && !topicSessions.some(session => session.larkAppId === request.bot
        || (session.larkAppId !== undefined && botApps.has(session.larkAppId)))) continue;
      const docs = [...group.docs.values()].sort(compareHits);
      ranked.push({ anchor, docs, lastActiveAt: lastActiveAt(topicSessions), notes: {
        metaMissing: docs.some(doc => missingHitSession(doc, sessions)),
        replyTruncated: docs.some(doc => doc.reply_truncated !== 0),
      } });
    }
    ranked.sort((a,b) => (b.docs[0]?.time_ms ?? 0)-(a.docs[0]?.time_ms ?? 0)
      || b.lastActiveAt-a.lastActiveAt || a.anchor.localeCompare(b.anchor));
    const selected = ranked.slice(0,request.limit);
    const ids = selected.flatMap(topic => topic.docs.slice(0,request.hits).map(doc => doc.id));
    const fullByAnchor = new Map<string, TopicDocument[]>();
    if (ids.length) {
      for (const raw of db.prepare('SELECT * FROM docs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))) {
        const doc = docSchema.parse(raw);
        const group = fullByAnchor.get(doc.anchor);
        if (group) group.push(doc); else fullByAnchor.set(doc.anchor, [doc]);
      }
    }
    const results: TopicResult[] = selected.map(({ anchor, docs, notes }) => {
      const topic = summary(db,anchor,sessions,bots,notes);
      const hits = (fullByAnchor.get(anchor) ?? []).sort(compareHits);
      return { ...topic,hits: { count: docs.length,items: hits.map(doc => ({
        kind: doc.kind,messageId: doc.message_id ?? undefined,senderType: doc.sender_type ?? undefined,time: doc.time_ms,
        snippet: topicSnippet(doc.text,request.terms),bot: doc.sender_type === 'bot'
          ? bots.find(bot => bot.larkAppId === doc.lark_app_id)?.name ?? doc.lark_app_id ?? undefined : undefined,
      })) } };
    });
    return { query: request.query,results,truncated: ranked.length > request.limit };
  } finally { db.close(); }
}

export function showTopic(dataDir: string, target: string, limit = 200, providedBots?: readonly BotDisplay[]): {
  topic: TopicSummary; documents: TopicDocument[]; truncated: boolean;
} | undefined {
  if (!target || !Number.isInteger(limit) || limit < 1 || limit > 2000) throw new TopicQueryError('invalid_topic_show_arguments');
  const db = openTopicIndex(dataDir,{ readOnly: true });
  try {
    const direct = db.prepare('SELECT anchor FROM docs WHERE anchor=? LIMIT 1').get(target);
    const found = direct ?? db.prepare('SELECT anchor FROM docs WHERE message_id=? ORDER BY anchor LIMIT 1').get(target);
    if (!found) return undefined;
    const anchor = z.object({ anchor: z.string() }).parse(found).anchor;
    const rows = db.prepare(`SELECT * FROM docs WHERE anchor=? ORDER BY time_ms,
      CASE kind WHEN 'final' THEN 0 WHEN 'group' THEN 1 WHEN 'inbound' THEN 2 WHEN 'reply' THEN 3 ELSE 4 END,id LIMIT ?`)
      .all(anchor,limit+1).map(raw => docSchema.parse(raw));
    const sessions = indexSessions(readTopicSessions(dataDir).sessions);
    const notes = {
      metaMissing: rows.some(doc => missingHitSession(doc, sessions)),
      replyTruncated: rows.some(doc => doc.kind === 'reply' && doc.text.endsWith('…')),
    };
    return { topic: summary(db,anchor,sessions,configuredBots(providedBots),notes),
      documents: rows.slice(0,limit),truncated: rows.length > limit };
  } finally { db.close(); }
}

export { TopicIndexError };
