/**
 * Reader for MTR's OpenCode-compatible SQLite session store.
 *
 * MTR persists conversations under ~/.local/share/opencode/mtr*.db. The schema
 * stores message role/finish metadata in message.data and visible text in the
 * part table. This reader maps completed user/assistant turns into the same
 * bridge event shape used by Codex/CoCo/Hermes.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CodexBridgeEvent } from './codex-transcript.js';

const MTR_DATA_DIR = join(homedir(), '.local', 'share', 'opencode');
const MTR_DB_RE = /^mtr(?:-[A-Za-z0-9._-]+)?\.db$/;
const MTR_CURSOR_LOOKBACK_MS = 5_000;

export interface MtrTranscriptSource {
  dbPath: string;
  sessionId: string;
}

interface MtrSessionRow {
  id: string;
  time_updated?: number;
}

interface MtrJoinedRow {
  message_id: string;
  session_id: string;
  message_time_created?: number;
  message_time_updated?: number;
  message_data: string;
  part_id?: string | null;
  part_time_created?: number | null;
  part_time_updated?: number | null;
  part_data?: string | null;
}

interface GroupedMessage {
  id: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: Record<string, unknown>;
  parts: Array<{ id: string; timeUpdated: number; data: Record<string, unknown> }>;
}

function runPythonJson<T>(script: string): T {
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || 'python3 sqlite query failed').trim());
  const stdout = proc.stdout.trim();
  return (stdout ? JSON.parse(stdout) : []) as T;
}

function jsonParseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function messageTimestampMs(message: GroupedMessage, assistantFinal: boolean): number {
  const time = message.data.time;
  if (time && typeof time === 'object') {
    const t = time as Record<string, unknown>;
    const completed = numberValue(t.completed);
    if (assistantFinal && completed !== undefined) return completed;
    const created = numberValue(t.created);
    if (created !== undefined) return created;
  }
  return message.timeUpdated || message.timeCreated || Date.now();
}

function textFromParts(parts: GroupedMessage['parts']): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.data.type !== 'text') continue;
    if (part.data.ignored === true) continue;
    const text = part.data.text;
    if (typeof text === 'string' && text.trim()) out.push(text);
  }
  return out.join('');
}

function groupRows(rows: MtrJoinedRow[]): GroupedMessage[] {
  const map = new Map<string, GroupedMessage>();
  for (const row of rows) {
    let msg = map.get(row.message_id);
    if (!msg) {
      msg = {
        id: row.message_id,
        sessionId: row.session_id,
        timeCreated: row.message_time_created ?? 0,
        timeUpdated: row.message_time_updated ?? 0,
        data: jsonParseObject(row.message_data),
        parts: [],
      };
      map.set(row.message_id, msg);
    }
    if (typeof row.message_time_updated === 'number' && row.message_time_updated > msg.timeUpdated) {
      msg.timeUpdated = row.message_time_updated;
    }
    if (row.part_id && row.part_data) {
      msg.parts.push({
        id: row.part_id,
        timeUpdated: row.part_time_updated ?? 0,
        data: jsonParseObject(row.part_data),
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.timeCreated - b.timeCreated) || a.id.localeCompare(b.id));
}

function queryChangedRows(source: MtrTranscriptSource, offset: number): MtrJoinedRow[] {
  // MTR only gives us timestamp cursors. Re-read a small overlap so rows that
  // share the previous max timestamp but commit after the last poll are not
  // skipped by the exclusive SQL predicate. The bridge queue de-dupes by uuid.
  const lowerBound = Math.max(0, offset - MTR_CURSOR_LOOKBACK_MS);
  const script = `
import json
import sqlite3
conn = sqlite3.connect(${JSON.stringify(source.dbPath)})
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    WITH changed AS (
      SELECT m.id
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
        AND (m.time_updated > ? OR COALESCE(p.time_updated, 0) > ?)
      GROUP BY m.id
    )
    SELECT
      m.id AS message_id,
      m.session_id AS session_id,
      m.time_created AS message_time_created,
      m.time_updated AS message_time_updated,
      m.data AS message_data,
      p.id AS part_id,
      p.time_created AS part_time_created,
      p.time_updated AS part_time_updated,
      p.data AS part_data
    FROM message m
    LEFT JOIN part p ON p.message_id = m.id
    WHERE m.id IN (SELECT id FROM changed)
    ORDER BY m.time_created, m.id, p.time_created, p.id
    """,
    (${JSON.stringify(source.sessionId)}, ${JSON.stringify(lowerBound)}, ${JSON.stringify(lowerBound)}),
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
  return runPythonJson<MtrJoinedRow[]>(script);
}

function currentOffset(source: MtrTranscriptSource): number {
  const script = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(source.dbPath)})
row = conn.execute(
    """
    SELECT COALESCE(MAX(value), 0) FROM (
      SELECT time_updated AS value FROM message WHERE session_id = ?
      UNION ALL
      SELECT time_updated AS value FROM part WHERE session_id = ?
    )
    """,
    (${JSON.stringify(source.sessionId)}, ${JSON.stringify(source.sessionId)}),
).fetchone()
print(row[0] or 0)
`;
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (proc.status !== 0) return 0;
  return Number.parseInt(proc.stdout.trim(), 10) || 0;
}

function querySessionById(dbPath: string, sessionId: string): MtrSessionRow | undefined {
  const script = `
import json
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, time_updated FROM session WHERE id = ? LIMIT 1",
    (${JSON.stringify(sessionId)},),
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "null")
`;
  const row = runPythonJson<MtrSessionRow | null>(script);
  return row || undefined;
}

function queryLatestSessionByDirectory(dbPath: string, directory: string): MtrSessionRow | undefined {
  const script = `
import json
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
row = conn.execute(
    """
    SELECT id, time_updated
    FROM session
    WHERE directory = ?
    ORDER BY time_updated DESC
    LIMIT 1
    """,
    (${JSON.stringify(directory)},),
).fetchone()
print(json.dumps(dict(row), ensure_ascii=False) if row else "null")
`;
  const row = runPythonJson<MtrSessionRow | null>(script);
  return row || undefined;
}

export function mtrDbCandidates(dataDir = MTR_DATA_DIR): string[] {
  if (!existsSync(dataDir)) return [];
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return []; }
  return names
    .filter(name => MTR_DB_RE.test(name))
    .map(name => join(dataDir, name))
    .filter(path => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
}

export function findMtrSessionById(sessionId: string | undefined, dbPaths = mtrDbCandidates()): MtrTranscriptSource | undefined {
  if (!sessionId) return undefined;
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const row = querySessionById(dbPath, sessionId);
      if (row) return { dbPath, sessionId: row.id };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function findLatestMtrSessionByDirectory(directory: string | undefined, dbPaths = mtrDbCandidates()): MtrTranscriptSource | undefined {
  if (!directory) return undefined;
  let best: { dbPath: string; row: MtrSessionRow } | undefined;
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const row = queryLatestSessionByDirectory(dbPath, directory);
      if (!row) continue;
      if (!best || (row.time_updated ?? 0) > (best.row.time_updated ?? 0)) best = { dbPath, row };
    } catch {
      continue;
    }
  }
  return best ? { dbPath: best.dbPath, sessionId: best.row.id } : undefined;
}

export function drainMtrSession(source: MtrTranscriptSource | undefined, fromOffset: number): { events: CodexBridgeEvent[]; newOffset: number } {
  if (!source || !existsSync(source.dbPath)) return { events: [], newOffset: fromOffset };
  const rows = queryChangedRows(source, fromOffset);
  let newOffset = fromOffset;
  const events: CodexBridgeEvent[] = [];
  for (const msg of groupRows(rows)) {
    newOffset = Math.max(
      newOffset,
      msg.timeUpdated,
      ...msg.parts.map(part => part.timeUpdated),
    );
    const role = msg.data.role;
    if (role === 'user') {
      const text = textFromParts(msg.parts);
      if (!text) continue;
      events.push({
        uuid: `mtr:${source.dbPath}:${msg.id}`,
        timestampMs: messageTimestampMs(msg, false),
        kind: 'user',
        text,
        sourceSessionId: msg.sessionId,
      });
    } else if (role === 'assistant') {
      if (msg.data.finish !== 'stop') continue;
      const text = textFromParts(msg.parts);
      if (!text) continue;
      events.push({
        uuid: `mtr:${source.dbPath}:${msg.id}`,
        timestampMs: messageTimestampMs(msg, true),
        kind: 'assistant_final',
        text,
        sourceSessionId: msg.sessionId,
      });
    }
  }
  return { events, newOffset };
}

export function currentMtrSessionOffset(source: MtrTranscriptSource | undefined): number {
  if (!source || !existsSync(source.dbPath)) return 0;
  return currentOffset(source);
}
