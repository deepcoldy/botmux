/**
 * Reader for Codex's per-session rollout JSONL.
 *
 * Codex stores each session's full transcript at
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * and creates the file lazily on the first user submit. The bridge fallback
 * cares about exactly two records:
 *
 *   - user turn-start: `response_item.payload` message role=user
 *     (input_text content). Stable across every codex version.
 *   - turn terminal: `event_msg.payload` `task_complete`, which carries the
 *     final visible text in `last_agent_message` (may be empty) and fires
 *     exactly ONCE per turn.
 *
 * Why task_complete and NOT the assistant `response_item` message:
 *   - Codex USED to tag the final assistant message `phase:'final_answer'`,
 *     which older readers keyed on. Newer codex (observed >=0.146, and
 *     model-provider dependent) DROPPED that field: the final assistant
 *     message and every mid-turn assistant message are now byte-identically
 *     `phase:undefined`, so no assistant `response_item` is a safe boundary —
 *     keying on one would close the turn on the first mid-turn preamble and
 *     truncate (or, if a stale second final is buffered, double-emit).
 *   - `task_complete` is present in every observed schema (0.139 / 0.145 /
 *     0.146), fires once per turn, and dedups codex's THREE representations of
 *     one answer (event_msg agent_message / response_item message / event_msg
 *     task_complete) down to a single emit — no cross-source dedup needed.
 *   - A cancelled turn writes `turn_aborted` (no task_complete); we surface it
 *     as an `ambiguous` terminal so the durable delivery is released instead
 *     of wedging as "running" forever.
 *
 * This mirrors the traex reader (traex-transcript.ts), which adopted the same
 * task_complete boundary earlier for the identical no-reliable-phase reason.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { codexHistoryPath, codexSessionsRoot } from './codex-paths.js';

const IS_LINUX = platform() === 'linux';
const UNTRUSTED_SESSION_SCAN_MAX_DEPTH = 3;
const UNTRUSTED_SESSION_SCAN_MAX_ENTRIES = 50_000;

/** Extract the cliSessionId encoded in a rollout filename. Codex's session
 *  id is UUID-shaped (8-4-4-4-12 hex), which lets us anchor the regex on
 *  the UUID alone — the `<ts>` segment between "rollout-" and the sid
 *  contains its own dashes that would otherwise let a greedy match swallow
 *  parts of the sid. Returns undefined for paths that don't match. */
export function codexSessionIdFromRolloutPath(path: string): string | undefined {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1] : undefined;
}

/** Find the rollout file an externally-running Codex process has open. The
 *  Codex process keeps fd open on its current rollout for the entire
 *  lifetime of the session, so this is the authoritative way to bind a
 *  Codex pid to its sessionId — far more reliable than scanning
 *  `~/.codex/sessions` by mtime (which would race with sibling Codex panes
 *  in the same project).
 *
 *  Linux: `/proc/<pid>/fd/*` fast path.
 *  macOS / BSD: `lsof -p <pid> -Fn` 兜底（同 session-discovery 里的 readCwd）。
 *  两种平台都用 `codexSessionIdFromRolloutPath` 提取 sid。 */
export function findCodexRolloutByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const hit = matchCodexRolloutPath(target);
        if (hit) return hit;
      }
      return undefined;
    }
    // /proc 不可读时落到下面的 lsof 兜底（极少见，但兜一下）
  }
  // BSD ps 的 lsof：每个 fd 输出一行 `f<n>` 加一行 `n<path>`，socket / pipe
  // 之类的内部条目以 `n->0x...` 或 `n<garbage>` 开头，所以只接受 `n/` 开头。
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
    const target = line.slice(1);
    const hit = matchCodexRolloutPath(target);
    if (hit) return hit;
  }
  return undefined;
}

function matchCodexRolloutPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  if (!target.includes('/.codex/sessions/')) return undefined;
  const sid = codexSessionIdFromRolloutPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

export interface CodexBridgeEvent {
  /** Synthetic uuid for dedup: `<absPath>:<byteOffset>` of the line start.
   *  Stable across re-drains because rollout files are append-only. */
  uuid: string;
  /** Wall-clock ms parsed from the event's `timestamp` field. Falls back
   *  to Date.now() if missing/unparseable so the gate's window math still
   *  has something to compare against. */
  timestampMs: number;
  /** Discriminator for the queue layer:
   *   - 'user' starts a pending Lark turn (fingerprint-matched)
   *   - 'assistant_final' closes the currently-collecting turn */
  kind: 'user' | 'assistant_final';
  /** Concatenated text from the message's content blocks (input_text for
   *  user, output_text for assistant). */
  text: string;
  /** Optional durable-delivery terminal outcome carried by bridges with an
   *  explicit completion record (for example Grok `turn_completed`). Codex
   *  final-answer records omit it and retain the historical completed
   *  default. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  sourceSessionId?: string;
  /** Keep the pending turn's original markTimeMs instead of moving it to the
   *  transcript user timestamp. Used by bridges whose committed user
   *  timestamp can lag behind in-turn delivery markers. */
  preserveMarkTimeMs?: boolean;
}

/** Extract the last completed user/assistant turn from a Codex / CoCo bridge
 *  event sequence. Used by /adopt to surface the previous turn as a
 *  preamble card in the Lark thread — gives the user context to continue
 *  from. CoCo events share the same shape (uuid/timestampMs/kind/text),
 *  so this works for both bridges.
 *
 *  Algorithm: scan tail-first for the most recent `assistant_final`, then
 *  pair it with the most recent `user` event that precedes it. Returns
 *  undefined when either side is missing — typically a fresh session whose
 *  user typed something but the model hasn't replied yet. */
export function extractLastCodexTurn(
  events: readonly { kind: 'user' | 'assistant_final'; text: string }[],
): { userText: string; assistantText: string } | undefined {
  let assistantIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'assistant_final') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return undefined;
  let userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (events[i].kind === 'user') { userIdx = i; break; }
  }
  if (userIdx < 0) return undefined;
  return {
    userText: events[userIdx].text,
    assistantText: events[assistantIdx].text,
  };
}

/** Split a drained event list into "history" (older than the live cutoff)
 *  and "live" (cutoff or newer). The Codex adopt bridge uses this when
 *  it discovers the rollout file LATE (after the user already typed in
 *  iTerm or sent a Lark message): drain-from-0 produces a mix of pre-
 *  adopt history and post-adopt live events. The worker then `absorb()`s
 *  the history (so it isn't replayed) and `ingest()`s the live partition
 *  (so the local-turn synthesis / fingerprint match still works). Pure
 *  function — no I/O, easy to test against fixed timestamps. */
export function splitCodexEventsByCutoff(
  events: readonly CodexBridgeEvent[],
  liveSinceMs: number,
): { history: CodexBridgeEvent[]; live: CodexBridgeEvent[] } {
  const history: CodexBridgeEvent[] = [];
  const live: CodexBridgeEvent[] = [];
  for (const ev of events) {
    if (ev.timestampMs < liveSinceMs) history.push(ev);
    else live.push(ev);
  }
  return { history, live };
}

export interface CodexDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line that was written without its terminating \n yet. Currently
   *  informational — only complete lines produce events. */
  pendingTail: string;
}

/** Locate the rollout file for a given Codex sessionId. Codex names files
 *  `rollout-<ts>-<sid>.jsonl`, so a suffix match is unambiguous. The
 *  directory tree is small (year/month/day) — a one-shot recursive scan
 *  is cheap enough that we don't bother caching. */
export function findCodexRolloutBySessionId(
  cliSessionId: string,
  opts?: { codexHome?: string; noFollow?: boolean },
): string | undefined {
  const sessionsRoot = opts?.codexHome
    ? join(opts.codexHome, 'sessions')
    : codexSessionsRoot();
  if (!cliSessionId) return undefined;
  try {
    // BOT_HOME is untrusted and requires no-follow roots. A normal CODEX_HOME
    // remains compatible with legitimate user-managed symlinks.
    if (opts?.noFollow && opts.codexHome && !lstatSync(opts.codexHome).isDirectory()) return undefined;
    const rootStat = opts?.noFollow ? lstatSync(sessionsRoot) : statSync(sessionsRoot);
    if (!rootStat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const suffix = `-${cliSessionId}.jsonl`;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  let visitedEntries = 0;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    try {
      const dirStat = opts?.noFollow ? lstatSync(dir) : statSync(dir);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    let directory: ReturnType<typeof opendirSync>;
    try { directory = opendirSync(dir); } catch { continue; }
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        visitedEntries++;
        if (opts?.noFollow && visitedEntries > UNTRUSTED_SESSION_SCAN_MAX_ENTRIES) {
          return undefined;
        }
        const full = join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        // Some filesystems report DT_UNKNOWN. Resolve those with the same trust
        // policy, but never stat through a known symlink in untrusted BOT_HOME.
        if (!isDirectory && !isFile && !entry.isSymbolicLink()) {
          try {
            const stat = opts?.noFollow ? lstatSync(full) : statSync(full);
            isDirectory = stat.isDirectory();
            isFile = stat.isFile();
          } catch {
            continue;
          }
        }
        if (isDirectory) {
          if (!opts?.noFollow || depth < UNTRUSTED_SESSION_SCAN_MAX_DEPTH) {
            stack.push({ dir: full, depth: depth + 1 });
          }
        } else if (isFile && entry.name.endsWith(suffix)) {
          try {
            const fileStat = opts?.noFollow ? lstatSync(full) : statSync(full);
            if (fileStat.isFile()) return full;
          } catch {
            continue;
          }
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
  return undefined;
}

function codexHistoryCliSessionId(parsed: unknown): string | undefined {
  return parsed && typeof parsed === 'object' && typeof (parsed as any).session_id === 'string'
    ? (parsed as any).session_id
    : undefined;
}

/** history.jsonl grows without bound; recent sessions live at the end, so a
 *  bounded tail window keeps the lookup O(window) instead of O(file). */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Find the newest Codex session whose history entry includes a botmux
 *  session id. Fresh dashboard rows often only know botmux's UUID; Codex's
 *  rollout filename uses its own UUID, and history.jsonl is the durable bridge
 *  between the two. Only the trailing `maxTailBytes` of the file is scanned. */
export function findCodexSessionIdByBotmuxSessionId(
  botmuxSessionId: string,
  opts?: { maxTailBytes?: number; codexHome?: string; noFollow?: boolean },
): string | undefined {
  if (!botmuxSessionId) return undefined;
  const historyPath = opts?.codexHome
    ? join(opts.codexHome, 'history.jsonl')
    : codexHistoryPath();
  let fd: number | undefined;
  try {
    // O_NOFOLLOW rejects a symlink swapped in after lstat; O_NONBLOCK keeps a
    // malicious FIFO from blocking the daemon. fstat then accepts only regular
    // files. (O_NOFOLLOW is available on the supported Linux/macOS targets.)
    if (opts?.noFollow && opts.codexHome && !lstatSync(opts.codexHome).isDirectory()) return undefined;
    const pathStat = opts?.noFollow ? lstatSync(historyPath) : statSync(historyPath);
    if (!pathStat.isFile()) return undefined;
    fd = openSync(
      historyPath,
      constants.O_RDONLY
        | (opts?.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    const size = opened.size;
    const maxTailBytes = Math.max(1, opts?.maxTailBytes ?? HISTORY_TAIL_BYTES);
    const start = Math.max(0, size - maxTailBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The window almost certainly opens mid-line — drop the partial line.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const marker = JSON.stringify(botmuxSessionId).slice(1, -1);
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes(marker)) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.text === 'string' && parsed.text.includes(botmuxSessionId)) {
          return codexHistoryCliSessionId(parsed);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / invalid fd */ }
    }
  }
  return undefined;
}

/** Concatenate all text blocks of a content array. Codex rollout content
 *  is always an array of `{type, text}`; the kinds we care about are
 *  `input_text` (user) and `output_text` (assistant). Other block types
 *  (image_url, audio, etc.) are ignored — the bridge only forwards text. */
function joinTextBlocks(content: unknown, kind: 'input_text' | 'output_text'): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === kind) {
      const text = (block as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/** Normalise a `turn_aborted.reason` into a stable, bounded error code for the
 *  durable-delivery terminal outcome. Mirrors the traex reader. */
function codexAbortErrorCode(reason: unknown): string {
  const normalized = (typeof reason === 'string' ? reason : 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
  return `codex_turn_aborted:${normalized}`;
}

/** Increment-read the rollout from `fromOffset`. Mirrors the byte-offset
 *  contract of claude-transcript.drainTranscript so callers can swap them
 *  out and reuse the existing fs.watch / poll wakeup machinery. */
export function drainCodexRollout(path: string, fromOffset: number): CodexDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  // Truncated/rotated jsonl — re-read from the top. Codex doesn't normally
  // rewrite rollouts, but mirror Claude's defensive handling.
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
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CodexBridgeEvent[] = [];
  // Track byte offset within the file as we walk lines so synthetic uuids
  // are stable across re-drains.
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;  // the \n after an empty line
      continue;
    }
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1;  // include \n
    const lineStart = cursor;
    cursor += lineByteLen;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const p = obj?.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    // User turn-start: response_item message role=user. Stable across every
    // codex version, and the ONLY event the RPC rollout-match probe reads
    // (codex-rpc-lifecycle.rolloutUserTurnMatches), so it must stay a
    // response_item user message.
    if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = joinTextBlocks(p.content, 'input_text');
      if (!text) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text });
      continue;
    }
    // Turn terminal: event_msg `task_complete` carries the final visible text
    // in `last_agent_message` (may be empty) and fires exactly ONCE per turn.
    // This is the SOLE assistant_final source. Codex assistant `response_item`
    // messages are NOT a safe boundary: the `phase:'final_answer'` marker was
    // dropped (>=0.146), and mid-turn assistant messages are byte-identical to
    // the final one (both phase:undefined) — keying on them would close a turn
    // on the first mid-turn preamble and truncate/duplicate. Taking only
    // task_complete also dedups codex's triple representation of one answer
    // (event_msg agent_message / response_item message / event_msg
    // task_complete). Mirrors the traex reader. See file header.
    if (obj.type === 'event_msg'
      && p.type === 'task_complete'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: typeof p.last_agent_message === 'string' ? p.last_agent_message : '',
      });
      continue;
    }
    // A cancelled turn writes `turn_aborted` (turn_id, reason) and NO
    // task_complete. Side effects may already have run, so release the durable
    // delivery as `ambiguous` rather than wedge the turn as running forever.
    if (obj.type === 'event_msg'
      && p.type === 'turn_aborted'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: codexAbortErrorCode(p.reason),
      });
      continue;
    }
    // Everything else is skipped: role=developer/system instructions,
    // reasoning, function_call*, and every assistant `response_item` message
    // (mid-turn OR final) — the turn boundary comes only from task_complete.
  }
  return { events, newOffset, pendingTail };
}
