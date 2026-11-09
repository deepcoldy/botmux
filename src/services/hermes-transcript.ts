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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CodexBridgeEvent } from './codex-transcript.js';

const HERMES_STATE_DB = join(homedir(), '.hermes', 'state.db');
const CONTENT_JSON_PREFIX = String.fromCharCode(0) + 'json:';

// Prefix for every python3 invocation below:
//  - `-I` isolated mode: the worker cwd is the user-controlled session working
//    directory, and without it `python3 -c` prepends cwd to sys.path, so a
//    project-planted json.py/sqlite3.py executes inside the unsandboxed worker;
//    it also ignores PYTHON* env and user site-packages.
//  - `-X utf8`: -I implies -E, which would otherwise discard the operator's
//    PYTHONUTF8/PYTHONIOENCODING escape hatch, leaving a non-UTF-8 LC_ALL able
//    to make stdout print raise (whole drain fails) or silently emit mojibake,
//    and make the literal U+2192 in the -c script undecodable. As a CLI flag
//    UTF-8 mode cannot be injected from the environment. All embedded scripts
//    import stdlib only.
export const PYTHON_ARGV_PREFIX = ['-I', '-X', 'utf8'];

// Keep lookup beneath a pinned home/pastes directory, not a path supplied by
// transcript text. Python is already required by this reader; dir_fd gives
// POSIX openat semantics without adding a native dependency. Unsupported hosts
// fail closed. Recovery is one-pass and all-or-nothing per user, with budgets
// independent of the queue's attribution leases.
const PASTE_RECOVERY_SCRIPT = String.raw`
import json, os, re, stat, sys

REF = re.compile(r'\[Pasted text #([1-9][0-9]{0,8}): ([1-9][0-9]{0,6}) lines → ([^\]\r\n\x00]+)\]')
NAME = re.compile(r'paste_([1-9][0-9]{0,8})_([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]\.txt')
FILE_CAP = 1024 * 1024
USER_CAP = 4 * FILE_CAP
DRAIN_CAP = 8 * FILE_CAP
ATTEMPT_CAP = 128
used = attempts = 0

def owned(info, directory=False):
    kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    return kind and info.st_uid == os.getuid() and not (info.st_mode & 0o022) and (directory or info.st_nlink == 1)

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_uid,
            info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)

def paste_directory(home):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(os.sep, flags)
    try:
        # Canonicalize the trusted configured home only, never a reference path.
        # Each subsequent component is opened relative to the previous FD.
        for component in os.path.realpath(home).split(os.sep):
            if not component:
                continue
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        if not owned(os.fstat(fd), True):
            raise ValueError('untrusted home')
        child = os.open('pastes', flags, dir_fd=fd)
        os.close(fd)
        fd = child
        if not owned(os.fstat(fd), True):
            raise ValueError('untrusted paste directory')
        return fd
    except Exception:
        os.close(fd)
        raise

def read_paste(directory, name):
    global used, attempts
    attempts += 1
    if attempts > ATTEMPT_CAP or used >= DRAIN_CAP:
        raise ValueError('read budget')
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    cap = min(FILE_CAP, DRAIN_CAP - used)
    if not owned(before) or before.st_size > cap:
        raise ValueError('untrusted file')
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    fd = os.open(name, flags, dir_fd=directory)
    try:
        if identity(os.fstat(fd)) != identity(before):
            raise ValueError('replaced file')
        data = bytearray()
        while len(data) <= cap:
            chunk = os.read(fd, min(65536, cap + 1 - len(data)))
            if not chunk:
                break
            used += len(chunk)
            data.extend(chunk)
        if len(data) > cap or len(data) != before.st_size or identity(os.fstat(fd)) != identity(before):
            raise ValueError('changed or oversized file')
        return data.decode('utf-8-sig')
    finally:
        os.close(fd)

def restore(text, home, directory):
    matches = list(REF.finditer(text))
    if not matches or len(matches) > 8 or len(matches) != text.count('[Pasted text #'):
        raise ValueError('reference format')
    pieces = []
    size = cursor = 0
    for match in matches:
        number, lines, path = match.groups()
        name = os.path.basename(path)
        shape = NAME.fullmatch(name)
        if (len(path.encode('utf-8')) > 4096 or not shape or shape.group(1) != number
                or path != os.path.join(home, 'pastes', name)):
            raise ValueError('reference boundary')
        recovered = read_paste(directory, name)
        if recovered.count('\n') + 1 != int(lines):
            raise ValueError('line count')
        prefix = text[cursor:match.start()]
        size += len(prefix.encode('utf-8')) + len(recovered.encode('utf-8'))
        if size > USER_CAP:
            raise ValueError('user budget')
        pieces.extend((prefix, recovered))
        cursor = match.end()
    suffix = text[cursor:]
    if size + len(suffix.encode('utf-8')) > USER_CAP:
        raise ValueError('user budget')
    pieces.append(suffix)
    return ''.join(pieces)

result = {}
directory = None
try:
    if (os.name != 'posix' or os.open not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd or os.getuid() != os.geteuid()):
        raise ValueError('unsupported host')
    home = os.path.abspath(sys.argv[1])
    rows = json.load(sys.stdin)
    directory = paste_directory(home)
    for row in rows:
        try:
            result[str(row['index'])] = restore(row['text'], home, directory)
        except (OSError, ValueError, UnicodeError):
            # Preserve the original whole user on any failed reference. Never
            # publish partial recovery or reflect paths/content into diagnostics.
            continue
except (OSError, ValueError, AttributeError):
    pass
finally:
    if directory is not None:
        os.close(directory)
print(json.dumps(result, ensure_ascii=False))
`;

/** Restore matching text ONLY after the caller's raw session filter.
 * Recovered markers must never authorize or rebind a native source. A wholly
 * folded unbound first turn deliberately remains unbound. */
export function restoreFilteredHermesUserEvents(
  events: CodexBridgeEvent[],
  dbPath: string,
): CodexBridgeEvent[] {
  const users = events.flatMap((event, index) => event.kind === 'user'
    && event.sourceSessionId && event.text?.includes('[Pasted text #')
    ? [{ index, text: event.text }] : []);
  if (users.length === 0) return events;
  try {
    const proc = spawnSync('python3', [...PYTHON_ARGV_PREFIX, '-c', PASTE_RECOVERY_SCRIPT, dirname(dbPath)], {
      // Recovered UTF-8 budgets do not count JSON escaping (up to 6x).
      input: JSON.stringify(users), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout: 1_000, killSignal: 'SIGKILL', windowsHide: true,
    });
    if (proc.status !== 0 || proc.error) return events;
    const recovered: unknown = JSON.parse(proc.stdout);
    if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered)) return events;
    const eligible = new Set(users.map(user => user.index));
    return events.map((event, index) => {
      const text = (recovered as Record<string, unknown>)[String(index)];
      return eligible.has(index) && typeof text === 'string' ? { ...event, text: text.trim() } : event;
    });
  } catch {
    return events;
  }
}

interface HermesMessageRow {
  id: number;
  session_id?: string;
  role: 'user' | 'assistant';
  content: unknown;
  timestamp?: number;
  finish_reason?: string | null;
}

export function resolveHermesStateDbPath(
  env: Record<string, string | undefined> = process.env,
  opts: { botmuxSessionProfile?: boolean } = {},
): string {
  const explicitStateDb = env.BOTMUX_HERMES_STATE_DB?.trim();
  if (explicitStateDb) return explicitStateDb;
  if (opts.botmuxSessionProfile) {
    const sessionId = env.BOTMUX_SESSION_ID?.trim();
    if (sessionId) {
      const sourceHome = env.HERMES_BOTMUX_SOURCE_HOME?.trim() || env.HERMES_HOME?.trim() || join(homedir(), '.hermes');
      const profilesRoot = env.HERMES_BOTMUX_PROFILES_ROOT?.trim() || join(sourceHome, 'profiles');
      const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
      return join(profilesRoot, `botmux-${sessionHash}`, 'state.db');
    }
  }
  const hermesHome = env.HERMES_HOME?.trim();
  return hermesHome ? join(hermesHome, 'state.db') : HERMES_STATE_DB;
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
  const proc = spawnSync('python3', [...PYTHON_ARGV_PREFIX, '-c', script], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
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
    const sourceSessionId = row.session_id?.trim() || undefined;
    const timestampMs = typeof row.timestamp === 'number' ? row.timestamp * 1000 : Date.now();
    if (row.role === 'user') {
      events.push({ uuid: `hermes:${row.id}`, timestampMs, kind: 'user', text, sourceSessionId, preserveMarkTimeMs: true });
    } else if (row.role === 'assistant') {
      if (row.finish_reason !== 'stop') continue;
      events.push({ uuid: `hermes:${row.id}`, timestampMs, kind: 'assistant_final', text, sourceSessionId });
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
  const proc = spawnSync('python3', [...PYTHON_ARGV_PREFIX, '-c', script], { encoding: 'utf8' });
  if (proc.status !== 0) return 0;
  return Number.parseInt(proc.stdout.trim(), 10) || 0;
}

export function hermesSessionExists(sessionId: string | undefined, dbPath = HERMES_STATE_DB): boolean | undefined {
  const sid = sessionId?.trim();
  if (!sid || !existsSync(dbPath)) return undefined;
  // Three-state, deliberately conservative (the CliAdapter contract only lets us
  // force a fresh session when we can PROVE the target is absent):
  //   1       -> session provably exists  -> true
  //   0       -> session provably absent  -> false
  //   unknown -> can't tell (unrecognized schema / query error) -> undefined
  //
  // Hermes resume is authoritative on `sessions.id` (SessionDB.get_session in
  // hermes-agent 0.18.x). An orphan row in `messages` whose session_id is not
  // in `sessions` is NOT resumable, so once a `sessions` table is present we
  // trust it alone and never let a stray message vote "exists". The `messages`
  // fallback is only for older schemas that predate the `sessions` table. If we
  // recognize neither table (unknown/future schema) we return unknown rather
  // than "absent", so the worker keeps the resume attempt instead of silently
  // dropping context to a fresh start.
  const script = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
sid = ${JSON.stringify(sid)}

def has_table(name):
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (name,)).fetchone()
    return row is not None

if has_table('sessions'):
    row = conn.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (sid,)).fetchone()
    print('1' if row is not None else '0')
    raise SystemExit(0)

if has_table('messages'):
    row = conn.execute("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (sid,)).fetchone()
    print('1' if row is not None else '0')
    raise SystemExit(0)

print('unknown')
`;
  const proc = spawnSync('python3', [...PYTHON_ARGV_PREFIX, '-c', script], { encoding: 'utf8' });
  if (proc.status !== 0) return undefined;
  const out = proc.stdout.trim();
  if (out === '1') return true;
  if (out === '0') return false;
  return undefined;
}
