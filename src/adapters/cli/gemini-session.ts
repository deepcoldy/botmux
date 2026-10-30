import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Gemini CLI (verified on 0.66.0) keeps one session per file under
 * `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`,
 * where `<project>` is the short name `projects.json` maps the working dir to,
 * and the first line is the session metadata (`{"sessionId": …}`).
 *
 * - `--session-id <uuid>` starts a new session with that id (exit 42 if a file
 *   with that id already exists for the project);
 * - `--resume <uuid>` resumes it, but only within the same project and only a
 *   session with resumable content (see isResumableRecord); anything else
 *   exits 42 ("No previous sessions found" / "Invalid session identifier").
 *
 * So botmux can name the session itself (its session id is a UUID) and must
 * check the file before asking Gemini to resume it.
 */

/** `GEMINI_CLI_HOME` replaces the home dir Gemini resolves `.gemini` under. */
export function geminiDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GEMINI_CLI_HOME?.trim() || homedir(), '.gemini');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gemini only accepts a UUID as a session id. */
export function isGeminiSessionId(id: string | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

/** The project short name Gemini uses for `workingDir`, from projects.json. */
function geminiProjectName(workingDir: string, gDir: string): string | undefined {
  let projects: Record<string, string>;
  try {
    const parsed = JSON.parse(readFileSync(join(gDir, 'projects.json'), 'utf8')) as { projects?: unknown };
    if (!parsed.projects || typeof parsed.projects !== 'object') return undefined;
    projects = parsed.projects as Record<string, string>;
  } catch { return undefined; }
  const keys = [resolve(workingDir)];
  try { keys.push(realpathSync(workingDir)); } catch { /* lexical only */ }
  for (const key of keys) {
    const name = projects[key];
    if (typeof name === 'string' && name && !name.includes('/') && name !== '.' && name !== '..') return name;
  }
  return undefined;
}

function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    closeSync(fd);
  }
}

/** Text of a message's `content` (a string, a part, or a list of parts). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).join('');
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isIgnoredUserText(text: string): boolean {
  return text.length === 0 || text.startsWith('/') || text.startsWith('?')
    || text.startsWith('<session_context>') || text.startsWith('<hook_context>');
}

interface ResumableRecordShape { type?: unknown; content?: unknown; toolCalls?: unknown; thoughts?: unknown }

/**
 * Gemini's own test (0.66 `isResumableMessageRecord` / `isIgnoredUserContent`):
 * a session resumes only with a real user message or a non-empty model turn.
 * The `<session_context>` line Gemini writes at startup, slash commands and
 * `?` help do not count, so a session that crashed before the first prompt
 * landed is not resumable and `--resume` would exit 42.
 */
function isResumableRecord(record: ResumableRecordShape): boolean {
  const text = contentText(record.content).trim();
  if (record.type === 'user') return !isIgnoredUserText(text);
  if (record.type === 'gemini') {
    return text.length > 0
      || (Array.isArray(record.toolCalls) && record.toolCalls.length > 0)
      || (Array.isArray(record.thoughts) && record.thoughts.length > 0);
  }
  return false;
}

/**
 * Decide resumability the way Gemini 0.66 lists sessions
 * (`createJsonlRecordAccumulator`, metadataOnly branch): replay the append-only
 * edit log into the LIVE message table, then ask whether any live row is
 * resumable. The file is not a flat message list:
 *  - a record with a string `id` and no `$patch` registers the row (info /
 *    error / warning rows register too — never resumable, but they still hold a
 *    table index that `$rewindTo` can target);
 *  - `{$set:{messages:[…]}}` REPLACES the whole table (clear + reset order);
 *  - `{$patch}` edits content / removes / reorders rows that already exist — it
 *    never creates a row;
 *  - `{$rewindTo:id}` drops that row and every row after it (or every row when
 *    the id is unknown).
 * A first turn that fails (bad key 401 / offline) is written as a user row and
 * immediately rewound, or collapsed by a later `$set`; scanning physical lines
 * would still see it and produce a `--resume` that exits 42. On 728 real 0.66
 * session files flat scanning over-reports resumability on 92 of them.
 */
function hasResumableContent(jsonl: string): boolean {
  return replayLiveMessages(jsonl).some((m) => m.isResumable);
}

/**
 * Whether the live message table contains a resumable *user* row whose text is
 * the submitted prompt. Matching is on the unique ACK marker line the mock (or
 * any caller) puts in the prompt, so a full-envelope compare is unnecessary and
 * a trimmed/wrapped store representation still matches. Returns the row text.
 */
function findSubmittedUserText(jsonl: string, expected: string): string | undefined {
  const needle = submittedPromptNeedle(expected);
  if (!needle) return undefined;
  for (const m of replayLiveMessages(jsonl)) {
    if (!m.isUser || !m.isResumable) continue;
    const text = contentText(m.content).trim();
    if (text === expected || text.includes(needle) || (text.length > 0 && expected.includes(text))) return text;
  }
  return undefined;
}

/**
 * The stable, turn-unique fragment to match a submitted prompt: prefer the
 * `ACK-…` marker (timestamped, ASCII), else fall back to the whole trimmed
 * prompt. Empty for empty/whitespace input.
 */
function submittedPromptNeedle(expected: string): string | undefined {
  const m = expected.match(/ACK-[A-Za-z0-9_.:#@-]{8,}/);
  if (m) return m[0];
  const t = expected.trim();
  return t.length > 0 ? t : undefined;
}

interface LiveMessage { type?: unknown; content?: unknown; isUser: boolean; isResumable: boolean }

/**
 * Replay a session jsonl edit log into the LIVE message table, mirroring Gemini
 * 0.66 (`createJsonlRecordAccumulator`). Returns the live rows in order with the
 * resumability decision already applied. See {@link hasResumableContent} for why
 * a physical line scan over-counts ($set/$patch/$rewindTo reshape the table).
 */
function replayLiveMessages(jsonl: string): LiveMessage[] {
  const order: string[] = [];
  const kinds = new Map<string, LiveMessage>();

  const register = (record: unknown): void => {
    if (!isObjectRecord(record) || typeof record.id !== 'string' || '$patch' in record) return;
    const id = record.id;
    if (!kinds.has(id)) order.push(id);
    kinds.set(id, {
      type: record.type,
      content: record.content,
      isUser: record.type === 'user',
      isResumable: isResumableRecord(record),
    });
  };

  const applyPatch = (patch: unknown): void => {
    if (!isObjectRecord(patch)) return;
    const changes: Record<string, unknown>[] = [];
    if (typeof patch.id === 'string') changes.push(patch);
    if (Array.isArray(patch.updates)) {
      for (const update of patch.updates) {
        if (isObjectRecord(update) && typeof update.id === 'string') changes.push(update);
      }
    }
    for (const change of changes) {
      if (!('content' in change) || change.content === undefined) continue;
      const kind = kinds.get(change.id as string);
      if (!kind) continue;
      kind.content = change.content;
      kind.isResumable = isResumableRecord({ type: kind.type, content: change.content });
    }
    if (Array.isArray(patch.removeIds)) {
      for (const removed of patch.removeIds) {
        if (typeof removed !== 'string') continue;
        const at = order.indexOf(removed);
        if (at !== -1) order.splice(at, 1);
        kinds.delete(removed);
      }
    }
    if (Array.isArray(patch.orderIds)) {
      const kept = patch.orderIds.filter((id): id is string => typeof id === 'string' && kinds.has(id));
      const keptSet = new Set(kept);
      order.splice(0, order.length, ...order.filter((id) => !keptSet.has(id)), ...kept);
    }
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isObjectRecord(record)) continue;
    if (typeof record.$rewindTo === 'string') {
      const at = order.indexOf(record.$rewindTo);
      if (at === -1) { order.length = 0; kinds.clear(); }
      else { for (const id of order.splice(at)) kinds.delete(id); }
    } else if (isObjectRecord(record.$patch)) {
      applyPatch(record.$patch);
    } else if (typeof record.id === 'string' && !('$patch' in record)) {
      register(record);
    } else if (isObjectRecord(record.$set) && Array.isArray(record.$set.messages)) {
      order.length = 0;
      kinds.clear();
      for (const message of record.$set.messages) register(message);
    }
  }

  return order.map((id) => kinds.get(id)!).filter(Boolean);
}

export interface GeminiSessionFile {
  path: string;
  /** Has resumable content by Gemini's own rule (isResumableRecord). */
  resumable: boolean;
}

/** The session file of `sessionId` for `workingDir`, if Gemini has one. */
export function findGeminiSessionFile(
  sessionId: string,
  workingDir: string,
  env: NodeJS.ProcessEnv = process.env,
): GeminiSessionFile | undefined {
  if (!isGeminiSessionId(sessionId)) return undefined;
  const gDir = geminiDir(env);
  const project = geminiProjectName(workingDir, gDir);
  if (!project) return undefined;
  const chats = join(gDir, 'tmp', project, 'chats');
  let names: string[];
  try { names = readdirSync(chats); } catch { return undefined; }
  const short = sessionId.slice(0, 8).toLowerCase();
  for (const name of names) {
    if (!name.startsWith('session-') || !(name.endsWith(`-${short}.jsonl`) || name.endsWith(`-${short}.json`))) continue;
    const path = join(chats, name);
    try {
      const meta = JSON.parse(firstLine(path)) as { sessionId?: unknown };
      if (meta.sessionId !== sessionId) continue;
      return { path, resumable: hasResumableContent(readFileSync(path, 'utf8')) };
    } catch { continue; }
  }
  return undefined;
}

/**
 * Submit-evidence support (core-clis live lane / first-prompt delivery).
 *
 * Gemini gives no synchronous "the input was submitted" signal in the Ink TUI,
 * and writing to the PTY while the TextInput is unmounted silently drops the
 * first prompt. The session jsonl is the authoritative store: a submitted
 * prompt appears as a live resumable `user` record. These helpers mirror the
 * OpenCode SQLite baseline/find pair, scanning every project's chats dir
 * globally (the adapter is a singleton with no per-session cwd) and matching
 * on the turn-unique ACK marker.
 */

/** All `tmp/<project>/chats/session-*.{json,jsonl}` files, newest first. */
function listGeminiChatFiles(gDir: string): string[] {
  const tmp: string[] = [];
  try { tmp.push(...readdirSync(join(gDir, 'tmp'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)); }
  catch { return []; }
  const files: { path: string; mtimeMs: number }[] = [];
  for (const project of tmp) {
    const chats = join(gDir, 'tmp', project, 'chats');
    let names: string[];
    try { names = readdirSync(chats); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('session-') || !(name.endsWith('.jsonl') || name.endsWith('.json'))) continue;
      const p = join(chats, name);
      try { files.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* unreadable entry */ }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

/**
 * Pre-spawn baseline: mtimeMs of the newest chat file (0 when none). Returns
 * null only when the `.gemini` root itself cannot be read, so a later null can
 * be distinguished from "read successfully, nothing submitted yet".
 */
export function snapGeminiSubmitBaseline(env: NodeJS.ProcessEnv = process.env): number | null {
  const gDir = geminiDir(env);
  let entries: string[];
  try { entries = readdirSync(gDir); } catch { return null; }
  void entries;
  const [newest] = listGeminiChatFiles(gDir);
  if (!newest) return 0;
  try { return statSync(newest).mtimeMs; } catch { return 0; }
}

export interface GeminiPromptSubmission {
  submitted: boolean;
  /** Gemini's own session id, when the matching row was located. */
  cliSessionId?: string;
  /** Stores were reachable but could not be read this time — not evidence of absence. */
  unreadable?: true;
}

/**
 * Find a resumable user record matching `expected` in any chat file newer than
 * `baseline`. Strictly newer-than-baseline avoids matching an older turn with
 * identical-looking text (the ACK marker is timestamped regardless, but the
 * mtime floor is a second guard).
 */
export function findGeminiPromptSubmission(
  baseline: number | null,
  expected: string,
  env: NodeJS.ProcessEnv = process.env,
): GeminiPromptSubmission {
  if (baseline === null) return { submitted: false, unreadable: true };
  if (!submittedPromptNeedle(expected)) return { submitted: false };
  const gDir = geminiDir(env);
  let sawReadableFile = false;
  for (const file of listGeminiChatFiles(gDir)) {
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
    if (mtimeMs <= baseline) continue;
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    sawReadableFile = true;
    if (!findSubmittedUserText(raw, expected)) continue;
    let cliSessionId: string | undefined;
    try {
      const meta = JSON.parse(firstLine(file)) as { sessionId?: unknown };
      if (typeof meta.sessionId === 'string') cliSessionId = meta.sessionId;
    } catch { /* meta unreadable — submitted still established by content */ }
    return cliSessionId ? { submitted: true, cliSessionId } : { submitted: true };
  }
  // Files existed and were readable but none matched: authoritative absence.
  // No file newer than baseline: indistinguishable from a not-yet-flushed
  // store; report unreadable so the caller retries rather than concluding.
  return sawReadableFile ? { submitted: false } : { submitted: false, unreadable: true };
}
