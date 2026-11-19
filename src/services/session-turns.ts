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
  via: 'lark' | 'trigger';
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
    db.exec('PRAGMA busy_timeout = 500');
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

function publicMessageText(text: string): string {
  return safeScrubAndTruncate(text, 256 * 1024).text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '<redacted>')
    .replace(/(?:file:\/\/|(?:^|(?<=[\s(`]))(?:~\/|\/(?:home|Users|tmp|private|var|data\d*|workspace|mnt)\/)|\b[A-Za-z]:\\)[^\s`)"']+/gm, '<redacted>');
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
    if (sameAnchor(previous, anchor)) return;
    append.run(opts.sessionId, opts.turnId, at, `anchor:${randomUUID()}`, JSON.stringify({ anchor }));
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
  dataDir: string, sessionId: string, turnId: string, cliSessionId?: string, cliEntryId?: string,
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
    db.prepare('INSERT OR IGNORE INTO events (session_id, turn_id, at, event_key, payload) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, turnId, Date.now(), `anchor:${randomUUID()}`, JSON.stringify({ anchor }));
  }));
}

export function recordSessionTurnReply(dataDir: string, sessionId: string, turnId: string, reply: SessionTurnReply): void {
  if (!existsSync(databasePath(dataDir))) return;
  accessTurns(dataDir, true, db => {
    db.prepare(`
      INSERT OR IGNORE INTO events (session_id, turn_id, at, event_key, payload)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM pending_inbound WHERE session_id = ? AND turn_id = ?)
    `).run(sessionId, turnId, reply.at, `reply:${reply.responseKind}:${reply.messageId}:${reply.at}`,
      JSON.stringify({ reply: { ...reply, text: reply.text === undefined ? undefined : publicMessageText(reply.text) } }), sessionId, turnId);
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
    const sessions = db.prepare('SELECT DISTINCT session_id FROM pending_inbound').all() as { session_id: string }[];
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
      else if ('reply' in event) turn.replies.push(event.reply);
      else turn.anchor = event.anchor;
    }
  });
  return {
    ok: true,
    schema: 'botmux.session-turns.v1',
    capabilities: [],
    next: String(turns.at(-1)?.seq ?? since),
    turns,
  } as const;
}
