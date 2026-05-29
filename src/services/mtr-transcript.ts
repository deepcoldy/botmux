/**
 * Reader for MTR's OpenCode-compatible SQLite session store.
 *
 * MTR persists conversations in an OpenCode-compatible SQLite store. The
 * default location is ~/.local/share/opencode/mtr*.db, but user installs can
 * relocate it via XDG_DATA_HOME / OPENCODE_DB. The schema stores message
 * role/finish metadata in message.data and visible text in the part table.
 * This reader maps completed user/assistant turns into the same bridge event
 * shape used by Codex/CoCo/Hermes.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';

const MTR_DB_RE = /^mtr(?:-[A-Za-z0-9._-]+)?\.db$/;
const MTR_SESSION_ID_RE = /^ses_[0-9A-Za-z]+$/;
const IS_LINUX = platform() === 'linux';
const schemaCache = new Map<string, boolean>();

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function mtrDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (isNonEmptyString(xdgDataHome)) return join(xdgDataHome, 'opencode');
  return join(homedir(), '.local', 'share', 'opencode');
}

function existingFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function configuredDbPath(dataDir: string): string | undefined {
  const raw = process.env.OPENCODE_DB;
  if (!isNonEmptyString(raw)) return undefined;
  return isAbsolute(raw) ? raw : join(dataDir, raw);
}

function runPythonJson<T>(script: string): T {
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || 'python3 sqlite query failed').trim());
  const stdout = proc.stdout.trim();
  return (stdout ? JSON.parse(stdout) : []) as T;
}

function runPythonText(script: string): string {
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || 'python3 sqlite query failed').trim());
  return proc.stdout.trim();
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
    (${JSON.stringify(source.sessionId)}, ${JSON.stringify(offset)}, ${JSON.stringify(offset)}),
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
`;
  return runPythonJson<MtrJoinedRow[]>(script);
}

export function mtrDbSchemaValid(dbPath: string): boolean {
  const cached = schemaCache.get(dbPath);
  if (cached !== undefined) return cached;
  if (!existsSync(dbPath)) return false;
  const script = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
required = {
    "session": {"id", "directory", "time_updated"},
    "message": {"id", "session_id", "time_created", "time_updated", "data"},
    "part": {"id", "message_id", "session_id", "time_created", "time_updated", "data"},
}
tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
ok = True
for table, columns in required.items():
    if table not in tables:
        ok = False
        break
    actual = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if not columns.issubset(actual):
        ok = False
        break
print("true" if ok else "false")
`;
  try {
    const ok = runPythonText(script) === 'true';
    if (ok) schemaCache.set(dbPath, true);
    return ok;
  } catch {
    return false;
  }
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

export function mtrDbCandidates(dataDir = mtrDataDir()): string[] {
  const candidates: Array<string | undefined> = [configuredDbPath(dataDir)];
  if (existsSync(dataDir)) {
    let names: string[];
    try { names = readdirSync(dataDir); } catch { names = []; }
    for (const name of names) {
      if (MTR_DB_RE.test(name)) candidates.push(join(dataDir, name));
    }
  }
  return uniquePaths(candidates).filter(existingFile);
}

function shellSplitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? undefined : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function mtrSessionIdFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--session' || arg === '--set-session') {
      const value = args[i + 1];
      if (value && MTR_SESSION_ID_RE.test(value)) return value;
      continue;
    }
    const equalsMatch = arg.match(/^--(?:session|set-session)=(.+)$/);
    if (equalsMatch?.[1] && MTR_SESSION_ID_RE.test(equalsMatch[1])) return equalsMatch[1];
  }
  return undefined;
}

export function mtrSessionIdFromCommand(command: string | undefined): string | undefined {
  if (!isNonEmptyString(command)) return undefined;
  return mtrSessionIdFromArgs(shellSplitCommand(command));
}

function readProcessCommand(pid: number): string | undefined {
  if (IS_LINUX) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`);
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const args = text.split('\0').filter(Boolean);
      const sessionId = mtrSessionIdFromArgs(args);
      if (sessionId) return args.join(' ');
    } catch {
      // Fall through to ps below.
    }
  }
  try {
    const out = execSync(`ps -o command= -p ${pid}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function findMtrSessionByPid(pid: number | undefined, dbPaths = mtrDbCandidates()): MtrTranscriptSource | undefined {
  if (!pid || !Number.isFinite(pid)) return undefined;
  const sessionId = mtrSessionIdFromCommand(readProcessCommand(pid));
  return findMtrSessionById(sessionId, dbPaths);
}

export function findMtrSessionForAdopt(pid: number | undefined, directory: string | undefined, dbPaths = mtrDbCandidates()): MtrTranscriptSource | undefined {
  return findMtrSessionByPid(pid, dbPaths) ?? findLatestMtrSessionByDirectory(directory, dbPaths);
}

export function findMtrSessionById(sessionId: string | undefined, dbPaths = mtrDbCandidates()): MtrTranscriptSource | undefined {
  if (!sessionId) return undefined;
  for (const dbPath of dbPaths) {
    if (!mtrDbSchemaValid(dbPath)) continue;
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
    if (!mtrDbSchemaValid(dbPath)) continue;
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
  if (!source || !mtrDbSchemaValid(source.dbPath)) return { events: [], newOffset: fromOffset };
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
  if (!source || !mtrDbSchemaValid(source.dbPath)) return 0;
  return currentOffset(source);
}
