import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import type { TurnSendKind } from './turn-send-ledger.js';
import type { LarkAttachment, LarkMessage } from '../types.js';
import { safeScrubAndTruncate } from './insight/scrub.js';

export interface SessionTurnInbound {
  messageId: string;
  text: string;
  sender?: { type: string; openId: string; name?: string };
  via: 'lark' | 'trigger' | 'owner_actor';
  quotedMessageId?: string;
  attachments?: { kind: string; name?: string; mimeType?: string }[];
  mentions?: { openId: string; name?: string }[];
  placement: { kind: 'thread'; rootMessageId: string } | { kind: 'chat' };
}

interface SessionTurnAnchor {
  cliId: string;
  cliSessionId?: string;
  inputSha256: string;
  cliEntryId?: string;
}

interface SessionTurnReply {
  messageId: string;
  responseKind: TurnSendKind;
  at: number;
  text?: string;
  textTruncated?: boolean;
}

interface SessionTurn {
  turnId: string;
  seq: number;
  at: number;
  inbound: SessionTurnInbound[];
  replies: SessionTurnReply[];
  anchor?: SessionTurnAnchor;
}

type TurnEvent =
  | { inbound: SessionTurnInbound }
  | { anchor: SessionTurnAnchor }
  | { reply: SessionTurnReply };

interface StoredEvent {
  seq: number;
  turn_id: string;
  at: number;
  payload: string;
}

export interface SessionTurnRetention {
  maxEventsPerSession?: number;
  eventTtlMs?: number;
}

interface TurnRetentionSummary {
  turn_id: string;
  event_count: number;
  last_seq: number;
  last_at: number;
  has_final: number;
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 2000;
const DEFAULT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_PATH_PATTERN = /(?:file:\/\/|(?:^|(?<=[\s:：=(\[{`"'（「『【《“‘，、；]))(?:~\/|\/(?:home|Users|tmp|private|var|data\d*|workspace|mnt)\/)|\b[A-Za-z]:\\)[^\s`)"'\]}）」』】》”’，。；：、！？]+/gm;

function databasePath(dataDir: string): string {
  return join(dataDir, 'session-turns', 'turns.sqlite');
}

function accessTurns<Result>(
  dataDir: string,
  write: boolean,
  operation: (db: DatabaseSyncLike) => Result,
): Result {
  if (write) mkdirSync(join(dataDir, 'session-turns'), { recursive: true, mode: 0o700 });
  const db = openDatabaseSyncOrThrow(databasePath(dataDir), { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    if (write) db.exec('PRAGMA journal_mode = WAL');
    if (write) db.exec('PRAGMA secure_delete = ON');
    if (write) db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE (session_id, turn_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS events_session_seq ON events (session_id, seq);
      CREATE TABLE IF NOT EXISTS pending_inbound (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS closed_sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pending_native (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        cli_session_id TEXT,
        cli_entry_id TEXT,
        PRIMARY KEY (session_id, turn_id)
      );
    `);
    return operation(db);
  } finally {
    db.close();
  }
}

function inTransaction(db: DatabaseSyncLike, operation: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function publicMessageWithTruncation(text: string): { text: string; truncated: boolean } {
  const scrubbed = safeScrubAndTruncate(text, 256 * 1024);
  return {
    text: scrubbed.text
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '<redacted>')
      .replace(LOCAL_PATH_PATTERN, '<redacted>'),
    truncated: scrubbed.truncated,
  };
}

function publicMessageText(text: string): string {
  return publicMessageWithTruncation(text).text;
}

function pruneSessionEvents(
  db: DatabaseSyncLike,
  sessionId: string,
  now: number,
  protectedTurnId?: string,
  retention?: SessionTurnRetention,
): void {
  const maxEvents = Math.max(1, Math.floor(retention?.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION));
  const ttlMs = Math.max(1, Math.floor(retention?.eventTtlMs ?? DEFAULT_EVENT_TTL_MS));
  const cutoff = now - ttlMs;
  const stats = db.prepare(
    'SELECT COUNT(*) AS count, MIN(at) AS oldest_at FROM events WHERE session_id = ?',
  ).get(sessionId) as { count: number; oldest_at: number | null } | undefined;
  if (!stats || stats.count === 0) return;
  const needsCountPrune = stats.count > maxEvents;
  const needsTtlPrune = stats.oldest_at !== null && stats.oldest_at < cutoff;
  if (!needsCountPrune && !needsTtlPrune) return;

  const turns = db.prepare(`
    SELECT
      turn_id,
      COUNT(*) AS event_count,
      MAX(seq) AS last_seq,
      MAX(at) AS last_at,
      MAX(CASE WHEN event_key LIKE 'reply:final:%' THEN 1 ELSE 0 END) AS has_final
    FROM events
    WHERE session_id = ?
    GROUP BY turn_id
    ORDER BY last_seq ASC
  `).all(sessionId) as TurnRetentionSummary[];
  if (turns.length === 0) return;

  const newestTurnId = turns.at(-1)?.turn_id;
  const isProtected = (turnId: string): boolean => turnId === protectedTurnId || turnId === newestTurnId;
  const evict = new Set<string>();
  let remainingEvents = stats.count;

  // 第一阶段：按 TTL 淘汰超时未活跃的整轮事件（保护当前写入与最新轮次）
  if (needsTtlPrune) {
    for (const turn of turns) {
      if (isProtected(turn.turn_id)) continue;
      if (turn.last_at < cutoff) {
        evict.add(turn.turn_id);
        remainingEvents -= turn.event_count;
      }
    }
  }

  // 第二阶段：超过单会话事件上限时，优先按最旧活动顺序淘汰已完成轮次
  if (remainingEvents > maxEvents) {
    for (const turn of turns) {
      if (remainingEvents <= maxEvents) break;
      if (evict.has(turn.turn_id) || isProtected(turn.turn_id) || turn.has_final !== 1) continue;
      evict.add(turn.turn_id);
      remainingEvents -= turn.event_count;
    }
  }

  // 第三阶段：若仅剩未完成轮次仍超上限，兜底淘汰最旧的非保护轮次以守住硬上限
  if (remainingEvents > maxEvents) {
    for (const turn of turns) {
      if (remainingEvents <= maxEvents) break;
      if (evict.has(turn.turn_id) || isProtected(turn.turn_id)) continue;
      evict.add(turn.turn_id);
      remainingEvents -= turn.event_count;
    }
  }

  if (evict.size) {
    const deleteEvents = db.prepare('DELETE FROM events WHERE session_id = ? AND turn_id = ?');
    const deletePendingInbound = db.prepare('DELETE FROM pending_inbound WHERE session_id = ? AND turn_id = ?');
    const deletePendingNative = db.prepare('DELETE FROM pending_native WHERE session_id = ? AND turn_id = ?');
    for (const turnId of evict) {
      deleteEvents.run(sessionId, turnId);
      deletePendingInbound.run(sessionId, turnId);
      deletePendingNative.run(sessionId, turnId);
    }
  }

  // 第四阶段：保护中的当前/最新轮次不能整轮淘汰。单轮次会话（或所有旧轮次
  // 清完后）若仍超上限，在轮内裁剪：先删被取代的旧 anchor，再删较早的
  // progress 回执，最后才动其他旧回执。input 事件、最新 anchor 与最新回执
  // 始终保留——input 本身超上限时以此为底线，不删用户消息。
  let currentCount = (db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?')
    .get(sessionId) as { count: number }).count;
  if (currentCount > maxEvents) {
    const protectedIds = [...new Set([protectedTurnId, newestTurnId].filter(
      (id): id is string => !!id && !evict.has(id),
    ))];
    for (const turnId of protectedIds) {
      if (currentCount <= maxEvents) break;
      currentCount -= trimTurnEvents(db, sessionId, turnId, currentCount - maxEvents);
    }
  }
}

/** Deletes at most `need` trim-eligible events inside one turn; returns how
 *  many were actually removed. Never touches `input:` events. */
function trimTurnEvents(db: DatabaseSyncLike, sessionId: string, turnId: string, need: number): number {
  if (need <= 0) return 0;
  const rows = db.prepare('SELECT event_key, seq FROM events WHERE session_id = ? AND turn_id = ? ORDER BY seq ASC')
    .all(sessionId, turnId) as { event_key: string; seq: number }[];
  const anchorSeqs = rows.filter(row => row.event_key.startsWith('anchor:')).map(row => row.seq);
  const latestAnchorSeq = anchorSeqs.length ? Math.max(...anchorSeqs) : undefined;
  const replySeqs = rows.filter(row => row.event_key.startsWith('reply:')).map(row => row.seq);
  const latestReplySeq = replySeqs.length ? Math.max(...replySeqs) : undefined;
  const orderedCandidates: number[] = [
    ...anchorSeqs.filter(seq => seq !== latestAnchorSeq),
    ...replySeqs.filter(seq => seq !== latestReplySeq && rows.find(row => row.seq === seq)?.event_key.startsWith('reply:progress:')),
    ...replySeqs.filter(seq => seq !== latestReplySeq
      && !rows.find(row => row.seq === seq)?.event_key.startsWith('reply:progress:')),
  ];
  const doomed = orderedCandidates.slice(0, need);
  if (!doomed.length) return 0;
  const placeholders = doomed.map(() => '?').join(',');
  db.prepare(`DELETE FROM events WHERE session_id = ? AND turn_id = ? AND seq IN (${placeholders})`)
    .run(sessionId, turnId, ...doomed);
  return doomed.length;
}

export function projectLarkTurnInbound(
  message: LarkMessage,
  attachments: readonly LarkAttachment[],
  rootMessageId?: string,
  senderName?: string,
): SessionTurnInbound {
  return {
    via: 'lark',
    messageId: message.messageId,
    text: message.content,
    ...(message.senderId ? { sender: {
      type: message.senderType,
      openId: message.senderId,
      name: senderName ?? message.senderName,
    } } : {}),
    ...(message.parentId ? { quotedMessageId: message.parentId } : {}),
    attachments: attachments.map(({ name, type, mimeType }) => ({
      kind: type,
      name: name.split(/[/\\]/).at(-1),
      mimeType,
    })),
    mentions: message.mentions?.flatMap(({ openId, name }) => openId ? [{ openId, name }] : []),
    placement: rootMessageId ? { kind: 'thread', rootMessageId } : { kind: 'chat' },
  };
}

export function stageSessionTurnInbound(dataDir: string, sessionId: string, turnId: string, inbound: SessionTurnInbound): void {
  accessTurns(dataDir, true, db => {
    db.prepare(`
      INSERT OR IGNORE INTO pending_inbound (session_id, turn_id, payload)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM closed_sessions WHERE session_id = ?)
    `).run(sessionId, turnId, JSON.stringify([{ ...inbound, text: publicMessageText(inbound.text) }]), sessionId);
  });
}

export function mergeStagedSessionTurnInputs(dataDir: string, sessionId: string, turnId: string, sourceTurnIds: readonly string[]): void {
  if (!existsSync(databasePath(dataDir))) return;
  accessTurns(dataDir, true, db => inTransaction(db, () => {
    const messages = loadInbound(db, sessionId, sourceTurnIds);
    if (messages.length) db.prepare(`
      INSERT OR REPLACE INTO pending_inbound (session_id, turn_id, payload) VALUES (?, ?, ?)
    `).run(sessionId, turnId, JSON.stringify(messages));
  }));
}

function loadInbound(db: DatabaseSyncLike, sessionId: string, sourceTurnIds: readonly string[]): SessionTurnInbound[] {
  const select = db.prepare('SELECT payload FROM pending_inbound WHERE session_id = ? AND turn_id = ?');
  const messages = new Map<string, SessionTurnInbound>();
  for (const sourceTurnId of sourceTurnIds) {
    const row = select.get(sessionId, sourceTurnId) as { payload: string } | undefined;
    if (row) for (const message of JSON.parse(row.payload) as SessionTurnInbound[]) {
      messages.set(message.messageId, message);
    }
  }
  return [...messages.values()];
}

export function recordSessionTurnInput(opts: {
  dataDir: string;
  sessionId: string;
  turnId: string;
  sourceTurnIds?: readonly string[];
  input: string;
  cliId: string;
  cliSessionId?: string;
  cliEntryId?: string;
  at?: number;
  retention?: SessionTurnRetention;
}): void {
  if (!existsSync(databasePath(opts.dataDir))) return;
  const anchor: SessionTurnAnchor = {
    cliId: opts.cliId,
    ...(opts.cliSessionId ? { cliSessionId: opts.cliSessionId } : {}),
    inputSha256: createHash('sha256').update(opts.input).digest('hex'),
    ...(opts.cliEntryId ? { cliEntryId: opts.cliEntryId } : {}),
  };
  const at = opts.at ?? Date.now();
  accessTurns(opts.dataDir, true, db => inTransaction(db, () => {
    const inbound = loadInbound(db, opts.sessionId, opts.sourceTurnIds ?? [opts.turnId]);
    if (!inbound.length) return;
    const append = db.prepare('INSERT OR IGNORE INTO events (session_id, turn_id, at, event_key, payload) VALUES (?, ?, ?, ?, ?)');
    for (const message of inbound) {
      append.run(opts.sessionId, opts.turnId, at, `input:${message.messageId}`, JSON.stringify({ inbound: message }));
    }
    const previous = latestAnchor(db, opts.sessionId, opts.turnId);
    const native = db.prepare('SELECT cli_session_id, cli_entry_id FROM pending_native WHERE session_id = ? AND turn_id = ?')
      .get(opts.sessionId, opts.turnId) as { cli_session_id?: string; cli_entry_id?: string } | undefined;
    anchor.cliSessionId ??= native?.cli_session_id ?? undefined;
    anchor.cliEntryId ??= native?.cli_entry_id ?? undefined;
    db.prepare('DELETE FROM pending_native WHERE session_id = ? AND turn_id = ?').run(opts.sessionId, opts.turnId);
    if (previous?.inputSha256 === anchor.inputSha256 && previous.cliId === anchor.cliId) {
      anchor.cliSessionId ??= previous.cliSessionId;
      anchor.cliEntryId ??= previous.cliEntryId;
    }
    if (!sameAnchor(previous, anchor)) {
      append.run(opts.sessionId, opts.turnId, at, `anchor:${randomUUID()}`, JSON.stringify({ anchor }));
    }
    pruneSessionEvents(db, opts.sessionId, at, opts.turnId, opts.retention);
  }));
}

function sameAnchor(left: SessionTurnAnchor | undefined, right: SessionTurnAnchor): boolean {
  return left?.cliId === right.cliId && left.inputSha256 === right.inputSha256
    && left.cliSessionId === right.cliSessionId && left.cliEntryId === right.cliEntryId;
}

function latestAnchor(db: DatabaseSyncLike, sessionId: string, turnId: string): SessionTurnAnchor | undefined {
  const row = db.prepare(`
    SELECT payload FROM events
    WHERE session_id = ? AND turn_id = ? AND event_key LIKE 'anchor:%'
    ORDER BY seq DESC LIMIT 1
  `).get(sessionId, turnId) as { payload: string } | undefined;
  return row && (JSON.parse(row.payload) as { anchor: SessionTurnAnchor }).anchor;
}

export function updateSessionTurnNativeAnchor(
  dataDir: string,
  sessionId: string,
  turnId: string,
  cliSessionId?: string,
  cliEntryId?: string,
  retention?: SessionTurnRetention,
): void {
  if (!existsSync(databasePath(dataDir))) return;
  accessTurns(dataDir, true, db => inTransaction(db, () => {
    const previous = latestAnchor(db, sessionId, turnId);
    if (!previous) {
      db.prepare(`
        INSERT OR REPLACE INTO pending_native
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM pending_inbound WHERE session_id = ? AND turn_id = ?
        )
      `).run(sessionId, turnId, cliSessionId ?? null, cliEntryId ?? null, sessionId, turnId);
      return;
    }
    const anchor = {
      ...previous,
      cliSessionId: cliSessionId ?? previous.cliSessionId,
      cliEntryId: cliEntryId ?? previous.cliEntryId,
    };
    if (sameAnchor(previous, anchor)) return;
    const now = Date.now();
    db.prepare('INSERT OR IGNORE INTO events (session_id, turn_id, at, event_key, payload) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, turnId, now, `anchor:${randomUUID()}`, JSON.stringify({ anchor }));
    pruneSessionEvents(db, sessionId, now, turnId, retention);
  }));
}

export function recordSessionTurnReply(
  dataDir: string,
  sessionId: string,
  turnId: string,
  reply: SessionTurnReply,
  retention?: SessionTurnRetention,
): void {
  if (!existsSync(databasePath(dataDir))) return;
  const publicReply = reply.text === undefined ? undefined : publicMessageWithTruncation(reply.text);
  const storedReply: SessionTurnReply = {
    ...reply,
    ...(publicReply ? {
      text: publicReply.text,
      textTruncated: publicReply.truncated,
    } : {}),
  };
  accessTurns(dataDir, true, db => inTransaction(db, () => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO events (session_id, turn_id, at, event_key, payload)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM pending_inbound WHERE session_id = ? AND turn_id = ?)
    `).run(sessionId, turnId, reply.at, `reply:${reply.responseKind}:${reply.messageId}:${reply.at}`,
      JSON.stringify({ reply: storedReply }), sessionId, turnId);
    if (Number(result.changes) > 0) {
      pruneSessionEvents(db, sessionId, reply.at, turnId, retention);
    }
  }));
}

/** Exact final reply text for supervision, without the dashboard's 4k preview
 * boundary. The persisted flag distinguishes full text from a scrubbed prefix. */
export function readSessionTurnFinalReply(
  dataDir: string, sessionId: string, turnId: string,
): { text: string; complete: boolean } | undefined {
  if (!existsSync(databasePath(dataDir))) return undefined;
  return accessTurns(dataDir, false, db => {
    const rows = db.prepare(`
      SELECT payload FROM events
      WHERE session_id = ? AND turn_id = ? AND event_key LIKE 'reply:final:%'
      ORDER BY seq DESC
    `).all(sessionId, turnId) as { payload: string }[];
    for (const row of rows) {
      const event = JSON.parse(row.payload) as TurnEvent;
      // Attachment-only carriers do not erase an earlier full text response.
      if (!('reply' in event) || typeof event.reply.text !== 'string') continue;
      // Only an explicit false proves completeness. Legacy rows have no marker,
      // and post-truncation redaction can hide both length and trailing ellipsis.
      return { text: event.reply.text, complete: event.reply.textTruncated === false };
    }
    return undefined;
  });
}

export function cleanupSessionTurns(dataDir: string, sessionId: string): void {
  accessTurns(dataDir, true, db => inTransaction(db, () => purgeClosedSession(db, sessionId)));
}

function purgeClosedSession(db: DatabaseSyncLike, sessionId: string): void {
  db.prepare('INSERT OR IGNORE INTO closed_sessions VALUES (?)').run(sessionId);
  db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM pending_inbound WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM pending_native WHERE session_id = ?').run(sessionId);
}

export function reconcileClosedSessionTurns(dataDir: string, closedIds: ReadonlySet<string>): void {
  if (!closedIds.size || !existsSync(databasePath(dataDir))) return;
  accessTurns(dataDir, true, db => inTransaction(db, () => {
    const sessions = db.prepare(`
      SELECT DISTINCT session_id FROM pending_inbound
      UNION
      SELECT DISTINCT session_id FROM events
      UNION
      SELECT DISTINCT session_id FROM pending_native
    `).all() as { session_id: string }[];
    for (const { session_id: sessionId } of sessions) {
      if (closedIds.has(sessionId)) purgeClosedSession(db, sessionId);
    }
  }));
}

export function resumeSessionTurns(dataDir: string, sessionId: string): void {
  if (!existsSync(databasePath(dataDir))) return;
  accessTurns(dataDir, true, db => inTransaction(db, () => {
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM pending_inbound WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM pending_native WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM closed_sessions WHERE session_id = ?').run(sessionId);
  }));
}

export function parseSessionTurnsPage(query: URLSearchParams): { since: number; limit: number } | undefined {
  const since = query.get('since') || '0';
  const limit = query.get('limit') || '50';
  if (!/^\d+$/.test(since) || !/^\d+$/.test(limit)) return;
  const cursor = Number(since);
  const size = Number(limit);
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(size) || size < 1 || size > 100) return;
  return { since: cursor, limit: size };
}

export function readSessionTurns(dataDir: string, sessionId: string, since: number, limit: number) {
  const turns: SessionTurn[] = [];
  if (limit > 0 && existsSync(databasePath(dataDir))) accessTurns(dataDir, false, db => {
    const rows = db.prepare(`
      WITH page AS (
        SELECT turn_id, MAX(seq) AS last_seq
        FROM events WHERE session_id = ? AND seq > ?
        AND EXISTS (
          SELECT 1 FROM events AS inputs
          WHERE inputs.session_id = events.session_id AND inputs.turn_id = events.turn_id
          AND inputs.event_key LIKE 'input:%'
        )
        GROUP BY turn_id ORDER BY last_seq LIMIT ?
      )
      SELECT events.seq, events.turn_id, events.at, events.payload
      FROM page JOIN events ON events.session_id = ? AND events.turn_id = page.turn_id
      ORDER BY page.last_seq, events.seq
    `).all(sessionId, since, limit, sessionId) as StoredEvent[];
    for (const row of rows) {
      let turn = turns.at(-1);
      if (turn?.turnId !== row.turn_id) {
        turn = { turnId: row.turn_id, seq: row.seq, at: row.at, inbound: [], replies: [] };
        turns.push(turn);
      }
      turn.seq = row.seq;
      const event = JSON.parse(row.payload) as TurnEvent;
      if ('inbound' in event) {
        if (!turn.inbound.length) turn.at = row.at;
        turn.inbound.push(event.inbound);
      }
      else if ('reply' in event) {
        // The explicit false bit is internal evidence for supervision. Keep the
        // established page API shape for ordinary complete replies.
        const { textTruncated, ...publicReply } = event.reply;
        turn.replies.push(textTruncated === false ? publicReply : event.reply);
      }
      else turn.anchor = event.anchor;
    }
  });
  return {
    ok: true,
    schema: 'botmux.session-turns.v1',
    capabilities: ['ownerActor'],
    next: String(turns.at(-1)?.seq ?? since),
    turns,
  } as const;
}
