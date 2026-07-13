/**
 * Reader for Grok Build's per-session ACP update stream.
 *
 * Path: `$GROK_HOME/sessions/<url-encoded-cwd>/<sessionId>/updates.jsonl`
 *
 * Bridge contract (same as Codex/CoCo/Pi): emit only
 *   - `user`            — real user prompt (`user_message_chunk`)
 *   - `assistant_final` — the LAST contiguous run of `agent_message_chunk`s
 *                         closed by `turn_completed`
 *
 * "Last contiguous run": grok streams progress narration between tool calls
 * as agent_message_chunks too (most real turns carry 2–5 such groups). Codex
 * parity is `phase=final_answer` only — the visible final reply — so any
 * agent-message group followed by a non-message event (tool_call / thought /
 * hook) is **dropped immediately** (buffer cleared, offset advanced). Only a
 * group that reaches `turn_completed` without an intervening non-message
 * event is emitted. This also keeps the 1s poller from rewinding across
 * long tool stretches (hundreds of tool_call_update lines).
 *
 * Mid-turn thoughts / tool calls are ignored so the queue never closes a
 * Lark turn on narration. Type-ahead follow-ups park until the active turn
 * finishes (Grok queue semantics ≈ CoCo), so the transcript stays interleaved
 * user1 → assistant_final1 → user2 → assistant_final2 — CodexBridgeQueue's
 * HOL-block-drop still applies if a steer-like merge ever appears.
 */
import {
  existsSync, statSync, openSync, readSync, closeSync, readdirSync, readFileSync, readlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent, CodexDrainResult } from './codex-transcript.js';
import {
  encodeGrokCwd, grokSessionsRoot, grokUpdatesPath, grokSummaryPath,
  resolveGrokCwdBucketDir,
} from './grok-paths.js';
import { isBotmuxInjectedPrompt } from './resumable-session-discovery.js';
import type { ResumableSession } from '../adapters/cli/types.js';

const IS_LINUX = platform() === 'linux';
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROK_SESSIONS_ANCHOR = '/.grok/sessions/';
const TITLE_MAX = 80;

export type GrokBridgeEvent = CodexBridgeEvent;
export type GrokDrainResult = CodexDrainResult;

function truncateTitle(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  return norm.length > TITLE_MAX ? `${norm.slice(0, TITLE_MAX - 1)}…` : norm;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: string; text?: string };
  if (typeof c.text === 'string') return c.text;
  return '';
}

/** Locate updates.jsonl for a session id, optionally scoped to cwd. */
export function findGrokUpdatesBySessionId(sessionId: string, cwd?: string): string | undefined {
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return undefined;
  if (cwd) {
    const p = grokUpdatesPath(sessionId, cwd);
    if (existsSync(p)) return p;
  }
  const root = grokSessionsRoot();
  if (!existsSync(root)) return undefined;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return undefined; }
  for (const name of entries) {
    if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
    const p = join(root, name, sessionId, 'updates.jsonl');
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function findGrokSummaryBySessionId(sessionId: string, cwd?: string): string | undefined {
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return undefined;
  if (cwd) {
    const p = grokSummaryPath(sessionId, cwd);
    if (existsSync(p)) return p;
  }
  const root = grokSessionsRoot();
  if (!existsSync(root)) return undefined;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return undefined; }
  for (const name of entries) {
    if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
    const p = join(root, name, sessionId, 'summary.json');
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** True when a session dir with summary.json exists (resume preflight). */
export function grokSessionExists(sessionId: string, cwd?: string): boolean | undefined {
  if (!sessionId) return false;
  try {
    // findGrokSummaryBySessionId already prefers cwd then scans every bucket.
    return !!findGrokSummaryBySessionId(sessionId, cwd);
  } catch {
    return undefined;
  }
}

/** True when the session DIRECTORY exists in any cwd bucket — regardless of
 *  summary.json. Grok creates the dir (with summary.json) at TUI startup and
 *  REFUSES `--session-id <id>` when the dir already exists ("Session ID is
 *  already in use", exit 1) — so a fresh spawn must probe the dir itself, not
 *  the resume preflight's summary.json. */
export function grokSessionDirExists(sessionId: string, cwd?: string): boolean {
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return false;
  try {
    if (cwd && existsSync(join(resolveGrokCwdBucketDir(cwd), sessionId))) return true;
    const root = grokSessionsRoot();
    if (!existsSync(root)) return false;
    for (const name of readdirSync(root)) {
      if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
      if (existsSync(join(root, name, sessionId))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function matchGrokSessionPath(target: string): { sessionId: string; updatesPath: string } | undefined {
  // Try the CONFIGURED sessions root first so a custom GROK_HOME is honored,
  // then fall back to the default `/.grok/sessions/` anchor.
  const root = grokSessionsRoot();
  let base: string | undefined;
  let rest: string | undefined;
  if (target.startsWith(root + '/')) {
    base = root;
    rest = target.slice(root.length + 1);
  } else {
    const idx = target.indexOf(GROK_SESSIONS_ANCHOR);
    if (idx >= 0) {
      base = target.slice(0, idx + GROK_SESSIONS_ANCHOR.length - 1);
      rest = target.slice(idx + GROK_SESSIONS_ANCHOR.length);
    }
  }
  if (!base || !rest) return undefined;
  // …/sessions/<encoded-cwd>/<sessionId>/…
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const sessionId = parts[1];
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return undefined;
  // Prefer the session dir + updates.jsonl even if the open fd is another file.
  const updatesPath = join(base, parts[0], sessionId, 'updates.jsonl');
  return { sessionId, updatesPath };
}

/** Extract the grok session id from any path under the sessions root — used
 *  by the worker to detect a `/new` / `/clear` / `/resume` rotation (new
 *  session id at the same pid) and re-attach the bridge. */
export function grokSessionIdFromPath(path: string): string | undefined {
  return matchGrokSessionPath(path)?.sessionId;
}

/** Bind a live Grok pid to its session via open fds (Linux /proc or lsof). */
export function findGrokSessionByPid(
  pid: number,
): { sessionId: string; updatesPath: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        if (target.endsWith(' (deleted)')) continue;
        const hit = matchGrokSessionPath(target);
        if (hit) return hit;
      }
      return undefined;
    }
  }
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const hit = matchGrokSessionPath(line.slice(1));
    if (hit) return hit;
  }
  return undefined;
}

function parseTimestampMs(obj: any, update: any): number {
  const meta = update?._meta ?? obj?.params?._meta ?? obj?._meta;
  if (meta && typeof meta.agentTimestampMs === 'number') return meta.agentTimestampMs;
  if (typeof obj?.timestamp === 'number') {
    // Grok uses seconds-ish unix in some builds and ms in others; treat
    // small values as seconds.
    return obj.timestamp < 1e12 ? obj.timestamp * 1000 : obj.timestamp;
  }
  return Date.now();
}

function eventUuid(path: string, lineStart: number, update: any, obj: any): string {
  const meta = update?._meta ?? obj?.params?._meta ?? obj?._meta;
  if (meta && typeof meta.eventId === 'string' && meta.eventId) return meta.eventId;
  return `${path}:${lineStart}`;
}

/**
 * Increment-read updates.jsonl. Agent chunks of the CURRENT contiguous group
 * are buffered. A non-message event (tool_call / thought / hook) while a
 * group is buffered **drops that group immediately** and advances the offset
 * (narration cannot become the final answer — codex final_answer parity).
 * The next agent chunk starts a fresh group; `turn_completed` emits only
 * whatever group is still buffered. If the file ends mid-group, newOffset
 * rewinds to the group's first chunk so the next poll re-reads it (queue
 * dedups by uuid).
 */
export function drainGrokUpdates(path: string, fromOffset: number): GrokDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;

  // Pure partial-line window (writer mid-flush, no '\n' yet): never advance.
  // ''.split('\n') yields [''] — treating that as a bare newline would push
  // offset by 1 and desync the next poll so the finished line fails JSON.parse
  // and is silently dropped (codex drainCodexRollout keeps newOffset = start).
  if (!completeText) {
    return { events: [], newOffset: start, pendingTail };
  }

  const events: GrokBridgeEvent[] = [];
  let agentParts: string[] = [];
  let openTurnStartOffset: number | null = null;
  let openTurnSessionId: string | undefined;
  let cursor = start;
  let lastFullyConsumedOffset = start;

  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1; // bare \n
      lastFullyConsumedOffset = cursor;
      continue;
    }
    const lineStart = cursor;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + \n
    cursor += lineBytes;

    let obj: any;
    try { obj = JSON.parse(line); } catch {
      lastFullyConsumedOffset = cursor;
      continue;
    }
    const update = obj?.params?.update ?? obj?.update;
    if (!update || typeof update !== 'object') {
      lastFullyConsumedOffset = cursor;
      continue;
    }
    const su = update.sessionUpdate as string | undefined;
    const sessionId =
      (typeof obj?.params?.sessionId === 'string' && obj.params.sessionId)
      || (typeof update.sessionId === 'string' && update.sessionId)
      || undefined;
    const timestampMs = parseTimestampMs(obj, update);
    const uuid = eventUuid(path, lineStart, update, obj);

    if (su === 'user_message_chunk') {
      // Drop any unfinished agent buffer — a new user turn supersedes it.
      agentParts = [];
      openTurnStartOffset = null;
      openTurnSessionId = undefined;
      const textContent = contentText(update.content).trim();
      if (textContent) {
        events.push({
          uuid,
          timestampMs,
          kind: 'user',
          text: textContent,
          sourceSessionId: sessionId,
        });
      }
      lastFullyConsumedOffset = cursor;
      continue;
    }

    if (su === 'agent_message_chunk') {
      const chunk = contentText(update.content);
      if (chunk) {
        if (openTurnStartOffset === null) openTurnStartOffset = lineStart;
        if (sessionId) openTurnSessionId = sessionId;
        agentParts.push(chunk);
      }
      // Do not advance lastFullyConsumedOffset past open group — handled at end.
      continue;
    }

    if (su === 'turn_completed') {
      // Emit only a still-buffered (post-tool) group. Narration groups were
      // already dropped on the tool_call/thought that followed them.
      const finalText = agentParts.join('').trim();
      agentParts = [];
      openTurnStartOffset = null;
      if (finalText) {
        events.push({
          uuid,
          timestampMs,
          kind: 'assistant_final',
          text: finalText,
          sourceSessionId: sessionId ?? openTurnSessionId,
        });
      }
      openTurnSessionId = undefined;
      lastFullyConsumedOffset = cursor;
      continue;
    }

    // tool_call / thought / hooks / etc. — any buffered agent group is
    // mid-turn narration and can never be the final answer. Drop it and
    // advance past this line so the 1s poller does not rewind through
    // hundreds of tool_call_update events every tick.
    if (agentParts.length > 0) {
      agentParts = [];
      openTurnStartOffset = null;
      openTurnSessionId = undefined;
    }
    lastFullyConsumedOffset = cursor;
  }

  // Mid-group at EOF (final reply still streaming): rewind so agent chunks
  // are re-read next tick.
  const newOffset = openTurnStartOffset !== null
    ? openTurnStartOffset
    : (completeText ? start + Buffer.byteLength(completeText, 'utf8') : lastFullyConsumedOffset);

  return { events, newOffset, pendingTail };
}

/** Current file size helper for submit-verify baseByte. */
export function grokFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Scan the bucket-level prompt_history.jsonl from `fromByte` for a submit
 * whose `prompt` equals `expectedText` (modulo newline normalisation — the
 * composer stores multi-line input verbatim with `\n`). prompt_history is
 * written AT SUBMIT TIME even while a turn is running (verified 0.2.93), so
 * this confirms busy-turn type-ahead submits that updates.jsonl (dequeue-time
 * user events) cannot. Returns the owning session id when found.
 *
 * Concurrent safety: the file is cwd-bucket shared. Two workers in the same
 * repo can append identical prompt text under different session_ids. Callers
 * MUST pass `preferSessionId` (from {@link findGrokSessionByPid} of their
 * CLI pid) so we never claim another worker's line. Without a prefer id we
 * only accept a match when all matching lines agree on a single session_id
 * (or have no id); ambiguous multi-sid hits fail closed.
 */
export function matchGrokPromptAppend(
  path: string,
  fromByte: number,
  expectedText: string,
  opts?: { preferSessionId?: string },
): { found: boolean; cliSessionId?: string } {
  if (!expectedText || !existsSync(path)) return { found: false };
  let size: number;
  try { size = statSync(path).size; } catch { return { found: false }; }
  const start = size < fromByte ? 0 : fromByte;
  if (size <= start) return { found: false };
  const len = size - start;
  const buf = Buffer.alloc(len);
  try {
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  } catch { return { found: false }; }
  const expected = normaliseNewlines(expectedText);
  const expectedTrimmed = expected.trim();
  const matches: Array<{ cliSessionId?: string }> = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; } // partial tail — later poll re-reads
    if (typeof obj?.prompt !== 'string') continue;
    const got = normaliseNewlines(obj.prompt);
    // Exact match modulo newline normalisation; trim fallback tolerates the
    // composer stripping leading/trailing whitespace on submit.
    if (obj.prompt === expectedText || got === expected || got.trim() === expectedTrimmed) {
      const sid = typeof obj.session_id === 'string' && SESSION_UUID_RE.test(obj.session_id)
        ? obj.session_id
        : undefined;
      matches.push({ cliSessionId: sid });
    }
  }
  if (matches.length === 0) return { found: false };

  const prefer = opts?.preferSessionId?.trim();
  if (prefer) {
    const hit = matches.find((m) => m.cliSessionId === prefer);
    if (hit) return { found: true, cliSessionId: hit.cliSessionId };
    // Preferred sid not among matches yet (slow append / other worker's lines
    // only) — keep polling; never fall through to another sid.
    return { found: false };
  }

  // No process binding: only safe when every match agrees on the same sid
  // (or none). Multiple distinct sids ⇒ concurrent workers — fail closed.
  const sids = new Set(
    matches.map((m) => m.cliSessionId).filter((s): s is string => !!s),
  );
  if (sids.size > 1) return { found: false };
  if (sids.size === 1) {
    const only = [...sids][0]!;
    return { found: true, cliSessionId: only };
  }
  // Matched text but no session_id fields — confirm submit without rotation.
  return { found: true };
}

function looksLikeBotmuxPrompt(text: string): boolean {
  return isBotmuxInjectedPrompt(text);
}

/** Head-read cap for /adopt discovery: real updates.jsonl files run to
 *  megabytes, and the first user prompt (title + botmux-filter input) sits
 *  within the first few KB after the startup hook events — never read the
 *  whole file per session just to list candidates. */
const DISCOVER_HEAD_BYTES = 256 * 1024;

/** First real user prompt from the head of updates.jsonl (bounded read). */
function readFirstUserChunk(path: string): string | undefined {
  try {
    const size = statSync(path).size;
    const len = Math.min(size, DISCOVER_HEAD_BYTES);
    if (len <= 0) return undefined;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, 0); } finally { closeSync(fd); }
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line || !line.includes('user_message_chunk')) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; } // truncated tail line
      const update = obj?.params?.update ?? obj?.update;
      if (!update || update.sessionUpdate !== 'user_message_chunk') continue;
      const text = contentText(update.content).trim();
      if (text) return text;
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Discover resumable Grok sessions for `/adopt` import.
 * Most-recent first, capped to `limit`, excluding live ids.
 */
export async function discoverGrokSessions(
  limit: number,
  exclude?: ReadonlySet<string>,
): Promise<ResumableSession[]> {
  const root = grokSessionsRoot();
  if (!existsSync(root) || limit <= 0) return [];

  type Cand = { sessionId: string; cwd: string; mtimeMs: number; title: string };
  const cands: Cand[] = [];

  let cwdBuckets: string[];
  try { cwdBuckets = readdirSync(root); } catch { return []; }

  for (const bucket of cwdBuckets) {
    if (bucket.endsWith('.sqlite') || bucket.endsWith('.lock')) continue;
    const bucketPath = join(root, bucket);
    let sessionIds: string[];
    try { sessionIds = readdirSync(bucketPath); } catch { continue; }
    let cwd = '';
    try { cwd = decodeURIComponent(bucket); } catch { cwd = bucket; }

    for (const sessionId of sessionIds) {
      if (exclude?.has(sessionId)) continue;
      if (!SESSION_UUID_RE.test(sessionId)) continue;
      const summaryPath = join(bucketPath, sessionId, 'summary.json');
      if (!existsSync(summaryPath)) continue;
      let mtimeMs = 0;
      try { mtimeMs = statSync(summaryPath).mtimeMs; } catch { continue; }

      let title = '';
      let summaryCwd = cwd;
      try {
        const raw = JSON.parse(readFileSync(summaryPath, 'utf8')) as any;
        title = String(raw?.generated_title || raw?.session_summary || '').trim();
        const infoCwd = raw?.info?.cwd;
        if (typeof infoCwd === 'string' && infoCwd) summaryCwd = infoCwd;
      } catch { /* title optional */ }

      // Prefer first real user_message_chunk for title when summary empty;
      // also filter botmux-spawned sessions. Bounded head read — see
      // readFirstUserChunk.
      const updatesPath = join(bucketPath, sessionId, 'updates.jsonl');
      const firstPrompt = existsSync(updatesPath) ? readFirstUserChunk(updatesPath) : undefined;
      if (firstPrompt) {
        if (looksLikeBotmuxPrompt(firstPrompt)) continue;
        if (!title) title = truncateTitle(firstPrompt);
      }

      cands.push({
        sessionId,
        cwd: summaryCwd,
        mtimeMs,
        title: title || sessionId.slice(0, 8),
      });
    }
  }

  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cands.slice(0, limit).map((c) => ({
    cliSessionId: c.sessionId,
    cwd: c.cwd,
    title: c.title,
    lastActivityAt: Math.round(c.mtimeMs),
  }));
}

/** Encode helper re-export for adapters that need the bucket name. */
export { encodeGrokCwd };
