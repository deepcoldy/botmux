/**
 * Reader for Hermes Agent's SQLite session store.
 *
 * Hermes persists CLI conversations in ~/.hermes/state.db. Unlike Codex/CoCo,
 * there is no append-only JSONL file to tail, so the bridge uses the messages
 * table's monotonically increasing row id as its offset. The worker only needs
 * user rows to match Lark turns and assistant rows with visible final content
 * to synthesize a fallback reply when Hermes printed to the terminal but did
 * not call `botmux send`.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CodexBridgeEvent } from './codex-transcript.js';

const HERMES_STATE_DB = join(homedir(), '.hermes', 'state.db');
const CONTENT_JSON_PREFIX = String.fromCharCode(0) + 'json:';

interface HermesMessageRow {
  id: number;
  session_id?: string;
  role: 'user' | 'assistant';
  content: unknown;
  timestamp?: number;
  finish_reason?: string | null;
}

function decodeContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content !== 'string') return String(content);
  if (!content.startsWith(CONTENT_JSON_PREFIX)) return content;
  try {
    return stringifyDecodedContent(JSON.parse(content.slice(CONTENT_JSON_PREFIX.length)));
  } catch {
    return content;
  }
}

function stringifyDecodedContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object') {
        const text = (item as { text?: unknown; content?: unknown }).text ?? (item as { content?: unknown }).content;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('');
  }
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown; content?: unknown }).text ?? (value as { content?: unknown }).content;
    if (typeof text === 'string') return text;
  }
  return '';
}

function runSql(offset: number, dbPath: string): HermesMessageRow[] {
  const script = `
import json
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    SELECT id, session_id, role, content, timestamp, finish_reason
    FROM messages
    WHERE id > ? AND role IN ('user', 'assistant')
    ORDER BY id
    """,
    (${JSON.stringify(offset)},),
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || 'python3 sqlite query failed').trim());
  const stdout = proc.stdout.trim();
  if (!stdout) return [];
  return JSON.parse(stdout) as HermesMessageRow[];
}

export function drainHermesStateDb(fromOffset: number, dbPath = HERMES_STATE_DB): { events: CodexBridgeEvent[]; newOffset: number } {
  if (!existsSync(dbPath)) return { events: [], newOffset: fromOffset };
  const rows = runSql(fromOffset, dbPath);
  let newOffset = fromOffset;
  const events: CodexBridgeEvent[] = [];
  for (const row of rows) {
    if (typeof row.id === 'number' && row.id > newOffset) newOffset = row.id;
    const text = decodeContent(row.content).trim();
    if (!text) continue;
    const timestampMs = typeof row.timestamp === 'number' ? row.timestamp * 1000 : Date.now();
    if (row.role === 'user') {
      events.push({ uuid: `hermes:${row.id}`, timestampMs, kind: 'user', text, sourceSessionId: row.session_id });
    } else if (row.role === 'assistant') {
      if (row.finish_reason !== 'stop') continue;
      events.push({ uuid: `hermes:${row.id}`, timestampMs, kind: 'assistant_final', text, sourceSessionId: row.session_id });
    }
  }
  return { events, newOffset };
}

export function currentHermesStateOffset(dbPath = HERMES_STATE_DB): number {
  if (!existsSync(dbPath)) return 0;
  const script = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()
print(row[0] or 0)
`;
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (proc.status !== 0) return 0;
  return Number.parseInt(proc.stdout.trim(), 10) || 0;
}
