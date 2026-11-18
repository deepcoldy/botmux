import { z } from 'zod';
import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import type { Session } from '../../types.js';
import { isNativeTopicId } from '../../core/native-topic-id.js';
import { chatAppLink, threadAppLink } from '../../im/lark/lark-hosts.js';
import { docSchema, kindPriority, timeMs, type TopicDocument } from './documents.js';
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
function compareHits(a: TopicDocument, b: TopicDocument): number {
  return (b.time_ms ?? 0)-(a.time_ms ?? 0) || kindPriority(a.kind)-kindPriority(b.kind) || a.id-b.id;
}
function summary(db: DatabaseSyncLike, anchor: string, allSessions: readonly Session[], bots: readonly BotDisplay[], hits: readonly TopicDocument[]): TopicSummary {
  const sessions = allSessions.filter(session => sessionQueueAnchor(session) === anchor).sort((a,b) =>
    (timeMs(b.lastMessageAt ?? b.createdAt) ?? 0)-(timeMs(a.lastMessageAt ?? a.createdAt) ?? 0) || a.sessionId.localeCompare(b.sessionId));
  const representative = sessions[0];
  const scope = representative?.scope ?? (anchor.startsWith('oc_') ? 'chat' : 'thread');
  const chatId = representative?.chatId ?? (scope === 'chat' ? anchor : null);
  const bot = bots.find(item => item.larkAppId === representative?.larkAppId);
  const threadId = representative?.larkThreadId;
  const earliest = representative ? undefined : db.prepare("SELECT text FROM docs WHERE anchor=? AND kind='inbound' ORDER BY time_ms,id LIMIT 1").get(anchor);
  const title = representative?.title || (earliest ? z.object({ text: z.string() }).parse(earliest).text : anchor);
  const notes: string[] = [];
  if (!sessions.length || hits.some(hit => (hit.kind === 'reply' || hit.kind === 'final')
    && !allSessions.some(session => session.sessionId === hit.session_id))) notes.push('meta_missing');
  const closed = sessions.length > 0 && sessions.every(session => session.status === 'closed');
  if (closed && !db.prepare("SELECT 1 FROM docs WHERE anchor=? AND (kind IN ('reply','final') OR (kind='group' AND sender_type IN ('bot','app'))) LIMIT 1").get(anchor)) {
    notes.push('replies_removed_on_close');
  }
  if (hits.some(hit => hit.kind === 'reply' && hit.text.endsWith('…'))) notes.push('reply_truncated');
  return { anchor,scope,chatId,chatName: representative?.chatDisplayName ?? null,title,
    link: !chatId ? null : scope === 'thread' && isNativeTopicId(threadId)
      ? threadAppLink(chatId,threadId,bot?.brand) : chatAppLink(chatId,bot?.brand),
    lastActiveAt: Math.max(0,...sessions.map(session => timeMs(session.lastMessageAt ?? session.createdAt) ?? 0)),
    status: closed ? 'closed' : 'open',
    sessions: sessions.map(session => ({ sessionId: session.sessionId, bot: bots.find(item => item.larkAppId === session.larkAppId)?.name
      ?? session.larkAppId ?? '',cliId: session.cliId ?? null,status: session.status })), notes };
}

export function searchTopics(dataDir: string, input: SearchRequest, providedBots?: readonly BotDisplay[]): {
  query: string; results: TopicResult[]; truncated: boolean;
} {
  const request = parseTopicQuery(input);
  const db = openTopicIndex(dataDir,{ readOnly: true });
  try {
    const long = request.terms.filter(term => Array.from(term).length >= 3);
    const short = request.terms.filter(term => Array.from(term).length < 3);
    const matching = new Map<string, { terms: Set<string>; docs: Map<number,TopicDocument> }>();
    let candidates: Set<string> | undefined;
    for (const term of [...long,...short]) {
      const isLong = Array.from(term).length >= 3;
      const params: unknown[] = [isLong ? `"${term.replace(/"/g,'""')}"` : `%${term.replace(/[\\%_]/g,'\\$&')}%`];
      let sql = isLong ? 'SELECT d.* FROM docs d JOIN docs_fts ON docs_fts.rowid=d.id WHERE docs_fts MATCH ?'
        : "SELECT d.* FROM docs d WHERE d.text LIKE ? ESCAPE '\\'";
      if (request.since !== undefined) { sql += ' AND d.time_ms>=?'; params.push(request.since); }
      if (request.until !== undefined) { sql += ' AND d.time_ms<=?'; params.push(request.until); }
      if (!isLong && candidates) { sql += ' AND d.anchor IN (SELECT value FROM json_each(?))'; params.push(JSON.stringify([...candidates])); }
      const rows = db.prepare(sql).all(...params).map(raw => docSchema.parse(raw));
      const anchors = new Set<string>();
      for (const doc of rows) {
        anchors.add(doc.anchor);
        let group = matching.get(doc.anchor);
        if (!group) { group = { terms: new Set(),docs: new Map() }; matching.set(doc.anchor,group); }
        group.terms.add(term); group.docs.set(doc.id,doc);
      }
      if (isLong) candidates = candidates ? new Set([...candidates].filter(anchor => anchors.has(anchor))) : anchors;
    }
    const sessions = readTopicSessions(dataDir).sessions;
    const bots = configuredBots(providedBots);
    const results: TopicResult[] = [];
    for (const [anchor,group] of matching) {
      if (group.terms.size !== request.terms.length) continue;
      const docs = [...group.docs.values()].sort(compareHits);
      const topic = summary(db,anchor,sessions,bots,docs);
      if (request.bot && !sessions.some(session => sessionQueueAnchor(session) === anchor
        && (session.larkAppId === request.bot || bots.some(bot => bot.larkAppId === session.larkAppId && bot.name === request.bot)))) continue;
      results.push({ ...topic,hits: { count: docs.length,items: docs.slice(0,request.hits).map(doc => ({
        kind: doc.kind,messageId: doc.message_id ?? undefined,senderType: doc.sender_type ?? undefined,time: doc.time_ms,
        snippet: topicSnippet(doc.text,request.terms),bot: doc.sender_type === 'bot'
          ? bots.find(bot => bot.larkAppId === doc.lark_app_id)?.name ?? doc.lark_app_id ?? undefined : undefined,
      })) } });
    }
    results.sort((a,b) => (b.hits.items[0]?.time ?? 0)-(a.hits.items[0]?.time ?? 0)
      || b.lastActiveAt-a.lastActiveAt || a.anchor.localeCompare(b.anchor));
    return { query: request.query,results: results.slice(0,request.limit),truncated: results.length > request.limit };
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
    return { topic: summary(db,anchor,readTopicSessions(dataDir).sessions,configuredBots(providedBots),rows),
      documents: rows.slice(0,limit),truncated: rows.length > limit };
  } finally { db.close(); }
}

export { TopicIndexError };
