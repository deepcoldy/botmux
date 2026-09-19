/**
 * Reader for Cursor Agent's per-chat transcript JSONL.
 *
 * `cursor-agent` keeps each chat's authoritative store in a SQLite file
 *   ~/.cursor/chats/<projectHash>/<chatId>/store.db
 * (held open via fd for the whole session) and, in parallel, mirrors the
 * conversation into an append-only JSONL transcript at
 *   ~/.cursor/projects/<projectSlug>/agent-transcripts/<chatId>/<chatId>.jsonl
 *
 * The bridge reads the JSONL (not the SQLite store) because it's append-only
 * plain text — the same integration surface the Codex/CoCo bridges use. Each
 * line is `{ role: 'user' | 'assistant', message: { content: [...] } }` where
 * a content block is either `{ type: 'text', text }` or `{ type: 'tool_use',
 * name, input }`. Tool *results* are not recorded.
 *
 * Where Cursor sits between the two existing bridge transcript shapes:
 *   - Claude is a STREAMING event stream — one role:user event, then a run of
 *     role:assistant events whose text grows incrementally; a turn has no
 *     explicit terminator, so the bridge queue tracks the in-flight turn with
 *     a `collecting` pointer.
 *   - Codex is DISCRETE complete events — exactly one user_message and one
 *     assistant_final per turn, each carrying the full text, with a definite
 *     terminator (phase=final_answer).
 * Cursor is a hybrid: each JSONL line is a DISCRETE, complete event (verified
 * empirically — assistant lines are never growing prefixes of one another, so
 * there is no Claude-style snapshot replay risk), but a turn is composed of
 * MANY assistant lines (one per step). Crucially it still has a definite
 * terminator: every intermediate step pairs its narration with a `tool_use`
 * block, and the agent loop only stops when the model returns a message with
 * NO tool_use. So a `text`-only assistant line is the end-of-turn final reply:
 *   - role=user                          → the user's prompt
 *   - role=assistant, text & no tool_use → the model's final reply
 * Every line carrying a tool_use block is an intermediate step and is dropped.
 * This lets the reader distill Cursor's multi-event turn down to Codex's
 * two-event (user, assistant_final) shape, so it can reuse the proven
 * CodexBridgeQueue attribution as-is rather than a Claude-style streaming
 * accumulator.
 *
 * Consequences of that distillation (intentional):
 *   - Only the final wrap-up text is forwarded; the short per-step narrations
 *     ("Let me read…", "Now I'll check…") are deliberately not relayed to Lark.
 *   - An interrupted turn (process killed / Esc mid-tool, leaving no text-only
 *     line) emits NOTHING rather than a half-answer — the safe failure mode.
 *
 * Cursor's JSONL carries no per-event timestamp, so the worker baselines this
 * transcript by byte offset at adopt time (history is behind the offset and
 * never re-ingested) and stamps live events with the drain wall-clock. That's
 * why every emitted event uses `Date.now()` for `timestampMs` — enough for the
 * shared CodexBridgeQueue's freshness gates given the offset baseline.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';

const IS_LINUX = platform() === 'linux';

const CHAT_ID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Default `~/.cursor/projects` root. Overridable by callers (tests) so the
 *  scan doesn't depend on a real home directory. */
export function cursorProjectsRoot(): string {
  return join(homedir(), '.cursor', 'projects');
}

/** Extract the chatId encoded in a Cursor store.db path of the shape
 *  `.../.cursor/chats/<projectHash>/<chatId>/store.db` (also matches the
 *  `-wal` / `-shm` sidecar files SQLite keeps open). The chatId is the same
 *  UUID used to name the agent-transcript JSONL, so it's the bridge between
 *  the open fd and the transcript file. Returns undefined for non-matching
 *  paths. */
export function cursorChatIdFromStoreDbPath(path: string): string | undefined {
  const re = new RegExp(`/\\.cursor/chats/[^/]+/(${CHAT_ID_RE})/store\\.db(?:-wal|-shm)?$`, 'i');
  const m = re.exec(path);
  return m ? m[1] : undefined;
}

/** Find the chatId of an externally-running cursor-agent process by reading
 *  the store.db file it keeps open. cursor-agent holds an fd on its current
 *  chat's SQLite store for the whole session lifetime, which makes this the
 *  authoritative pid→chatId binding — far more reliable than scanning chat
 *  dirs by mtime (which would race with sibling cursor-agent panes).
 *
 *  Linux: `/proc/<pid>/fd/*` fast path. macOS / BSD: `lsof -p <pid> -Fn`
 *  fallback (same shape as codex-transcript.findCodexRolloutByPid). */
export function findCursorChatIdByPid(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const chatId = cursorChatIdFromStoreDbPath(target);
        if (chatId) return chatId;
      }
      return undefined;
    }
    // /proc unreadable — fall through to lsof.
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
    const chatId = cursorChatIdFromStoreDbPath(line.slice(1));
    if (chatId) return chatId;
  }
  return undefined;
}

/** Locate the agent-transcript JSONL for a given chatId. The chatId is a
 *  globally-unique UUID, so a one-shot scan of the (small) projects root for
 *  `<slug>/agent-transcripts/<chatId>/<chatId>.jsonl` is unambiguous and
 *  avoids having to reproduce Cursor's opaque cwd→slug hashing. */
export function findCursorTranscriptByChatId(
  chatId: string,
  projectsRoot: string = cursorProjectsRoot(),
): string | undefined {
  if (!chatId || !existsSync(projectsRoot)) return undefined;
  let slugs: string[];
  try { slugs = readdirSync(projectsRoot); } catch { return undefined; }
  for (const slug of slugs) {
    const candidate = join(projectsRoot, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve the transcript path for an externally-running cursor-agent pid:
 *  pid → open store.db → chatId → agent-transcript JSONL. Returns both the
 *  path and the chatId so the caller can remember the chatId for a later
 *  retry if the JSONL isn't on disk yet. */
export function findCursorTranscriptByPid(
  pid: number,
  projectsRoot: string = cursorProjectsRoot(),
): { path: string; chatId: string } | undefined {
  const chatId = findCursorChatIdByPid(pid);
  if (!chatId) return undefined;
  const path = findCursorTranscriptByChatId(chatId, projectsRoot);
  return path ? { path, chatId } : undefined;
}

export interface CursorDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
  /** Byte offset of the snapshot EOF (start + bytes actually read). Same
   *  snapshot as the drain — no second statSync, so no TOCTOU. Used as the
   *  attach baseline when the snapshot ends mid in-flight MESSAGE line: that
   *  line is old output and must be skipped, restoring the old `size`
   *  baseline semantics without the 64 KiB tail-window probe (which could
   *  start mid-multibyte-char and drift the byte arithmetic). */
  readEndOffset: number;
  /** True when the drain read a complete, stable snapshot (bytesRead === len,
   *  no I/O failure). False on a short read (file truncated between stat and
   *  read) or any I/O failure — the caller must NOT commit a baseline from a
   *  partial snapshot. Trivially true for no-op drains (size <= start). */
  snapshotComplete: boolean;
}

/** Whether the cursor transcript fallback is disabled for this session.
 *  The 30s fail-safe sets `disabled=true` when the baseline can't be
 *  committed; this stops BOTH polling and mark attribution (not just
 *  polling). Other CLIs are unaffected — only cursor has the per-session
 *  disable switch. Pure function for testability. */
export function isCursorFallbackDisabled(cliId: string | undefined, disabled: boolean): boolean {
  return cliId === 'cursor' && disabled;
}

/** Classification of a pending-tail fragment (a partial JSON line at EOF)
 *  for baseline selection at attach time. */
export type CursorTailClass = 'message' | 'footer' | 'defer';

/** Classify a pending-tail fragment by its PREFIX. Cursor's JSONL is compact
 *  JSON: conversation messages start with `{"role":"user"` /
 *  `{"role":"assistant"`; the turn_ended status footer starts with
 *  `{"type":"turn_ended"`. Only a COMPLETE known discriminator classifies —
 *  a half-written value, unknown type, or unexpected shape returns 'defer'
 *  (the caller waits for the next tick rather than guessing). Cursor's
 *  internal schema is not promised stable: a future conversation line could
 *  carry a top-level `type`, so widening the match would reopen the
 *  stale-replay hole. A parseable COMPLETE line is handled by the object
 *  classifier (isStatusFooterObject) inside the drain, not here. */
export function classifyCursorPendingTail(fragment: string): CursorTailClass {
  if (fragment.startsWith('{"role":"user"') || fragment.startsWith('{"role":"assistant"')) return 'message';
  if (fragment.startsWith('{"type":"turn_ended"')) return 'footer';
  return 'defer';
}

/** Concatenate the text of all `type:'text'` blocks. Cursor uses the same
 *  `{type:'text', text}` shape for both user prompts and assistant replies;
 *  `tool_use` (and any other) blocks are ignored — the bridge only forwards
 *  text. Tolerates a bare-string content for defensiveness. */
function joinTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text') {
      const text = (block as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** True when an assistant content array contains at least one tool_use block,
 *  i.e. this is a mid-turn step rather than the final reply. */
function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(b => b && typeof b === 'object' && (b as any).type === 'tool_use');
}

const CURSOR_REASONING_LEAK_HEADING_RE = new RegExp([
  '\\n{2,}\\*\\*(?:',
  [
    'Considering',
    'Thinking',
    'Planning',
    'Inspecting',
    'Exploring',
    'Reviewing',
    'Troubleshooting',
    'Diagnosing',
    'Evaluating',
    'Running',
    'Checking',
    'Reading',
    'Understanding',
    'Analyzing',
    'Debugging',
    'Responding',
  ].join('|'),
  ')\\b[^*\\n]{0,80}\\*\\*\\n{2,}',
].join(''));

function stripCursorReasoningLeak(text: string): string {
  // Cursor's mirror can append the model's internal planning/debug summary to
  // the same text-only assistant line that otherwise represents the final user
  // reply. The leak starts with a bold English activity heading after a blank
  // paragraph, e.g. "**Considering user response**".
  const marker = CURSOR_REASONING_LEAK_HEADING_RE.exec(text);
  if (!marker || marker.index <= 0) return text;
  return text.slice(0, marker.index).trimEnd();
}

function eventFromLine(path: string, lineStart: number, obj: any, timestampMs: number): CodexBridgeEvent | undefined {
  const role = obj?.role ?? obj?.message?.role;
  const content = obj?.message?.content;
  if (role === 'user') {
    const t = joinTextBlocks(content);
    if (!t) return undefined;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text: t };
  }
  if (role === 'assistant') {
    // A turn ends with a text-only assistant line; any line carrying a
    // tool_use block is an intermediate step and must not be forwarded.
    if (hasToolUse(content)) return undefined;
    const t = stripCursorReasoningLeak(joinTextBlocks(content));
    if (!t) return undefined;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: t };
  }
  return undefined;
}

/** True for a parsed JSONL object that is NOT a conversation message —
 *  cursor-agent's status/footer lines like `{"type":"turn_ended",
 *  "status":"success"}`. These are NOT append-only: cursor appends one at EOF
 *  when a turn ends, then the NEXT turn's flush truncates it away and writes
 *  the new user/assistant lines starting at the footer's old byte position
 *  (footer re-appended at the new EOF). */
function isStatusFooterObject(obj: any): boolean {
  return (obj?.role ?? obj?.message?.role) === undefined;
}

/** Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 *  contract of codex-transcript.drainCodexRollout so the worker can reuse the
 *  same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue.
 *
 *  Footer invariant: `newOffset` NEVER advances past a trailing run of parsed
 *  status/footer objects (see isStatusFooterObject). Consuming the footer
 *  would strand the offset at the old EOF — the next turn REWRITES from the
 *  footer's start, so the new user line would begin BEHIND the committed
 *  offset and the drain would only ever see a mid-line fragment of it (the
 *  turn then never fingerprint-matches and the send-less fallback ghosts,
 *  observed live on cursor-agent 2026.08.11). Leaving the offset at the
 *  footer's start costs a ~40-byte re-read per poll and re-parses to zero
 *  events, so no duplicates can result. */
/** Optional dependency injection for deterministic short-read / race
 *  testing. Production callers omit this and use the real fs functions. */
export interface CursorDrainDeps {
  stat?: (path: string) => number;
  read?: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
}

export function drainCursorTranscript(path: string, fromOffset: number, deps: CursorDrainDeps = {}): CursorDrainResult {
  const statSize = deps.stat ?? ((p: string) => statSync(p).size);
  const readFn = deps.read ?? readSync;
  const empty = (offset: number, complete = true): CursorDrainResult =>
    ({ events: [], newOffset: offset, pendingTail: '', readEndOffset: offset, snapshotComplete: complete });
  if (!existsSync(path)) return empty(fromOffset, false);
  let size: number;
  try { size = statSize(path); } catch { return empty(fromOffset, false); }
  const start = fromOffset;
  // Cursor's mirror can briefly disappear / shrink while it rewrites. Do not
  // reset to 0 here: replaying the full history pollutes attribution state and
  // can wedge a live turn behind old events. Wait for the mirror to grow past
  // the last consumed byte instead. (The footer rewind below keeps the
  // committed offset at the truncation point, so the equal-size no-op window
  // during a footer-truncate is expected and harmless.)
  if (size < start) return empty(fromOffset);
  if (size === start) return empty(start);

  const len = size - start;
  const buf = Buffer.alloc(len);
  let bytesRead = 0;
  try {
    const fd = openSync(path, 'r');
    try { bytesRead = readFn(fd, buf, 0, len, start); } finally { closeSync(fd); }
  } catch { return empty(fromOffset, false); }
  // Capture the ACTUAL bytes read. If Cursor truncates the mirror between
  // statSync and readSync, bytesRead < len and the buffer tail is zero-filled
  // garbage — scanning it would push readEndOffset past the real data and
  // ghost the next turn. snapshotComplete=false tells the caller to defer
  // rather than commit a baseline from a partial snapshot.
  const snapshotComplete = bytesRead === len;
  const readEndOffset = start + bytesRead;
  const data = buf.subarray(0, bytesRead);

  // Walk raw newline (0x0a) positions instead of decoding the whole buffer
  // and re-encoding per line. When `start` lands mid-multibyte-char (a
  // baseline at the old `size` during a footer-truncate rewrite), the decoded
  // string's byte length no longer maps 1:1 to file offsets, and the old
  // `Buffer.byteLength(line, 'utf8') + 1` arithmetic drifts past the true
  // line boundary. Raw 0x0a indices are always exact file offsets; the first
  // segment after a mid-char start decodes with a U+FFFD prefix and fails
  // JSON.parse (skipped), so no drift accumulates.
  const events: CodexBridgeEvent[] = [];
  // Byte start (file-absolute) of the current TRAILING run of parsed
  // status/footer lines. Reset by any message line or unparseable fragment;
  // blank lines don't break the run. When set after the scan, newOffset
  // rewinds to it.
  let trailingFooterStart: number | undefined;
  let newOffset = start;
  let segStart = 0; // data-relative start of the current line segment
  let nlIdx = data.indexOf(0x0a);
  while (nlIdx !== -1) {
    const lineBuf = data.subarray(segStart, nlIdx); // excludes the \n
    const lineFileStart = start + segStart;
    newOffset = start + nlIdx + 1; // file-absolute, after the \n
    if (lineBuf.length > 0) {
      const line = lineBuf.toString('utf8');
      let obj: any;
      try { obj = JSON.parse(line); } catch {
        trailingFooterStart = undefined;
        segStart = nlIdx + 1;
        nlIdx = data.indexOf(0x0a, segStart);
        continue;
      }
      if (isStatusFooterObject(obj)) {
        trailingFooterStart ??= lineFileStart;
      } else {
        trailingFooterStart = undefined;
        // No per-event timestamp in Cursor's JSONL — stamp with the drain
        // wall-clock. Combined with byte-offset baselining at attach, this
        // keeps the CodexBridgeQueue freshness gates happy without a real
        // timestamp.
        const ev = eventFromLine(path, lineFileStart, obj, Date.now());
        if (ev) events.push(ev);
      }
    }
    segStart = nlIdx + 1;
    nlIdx = data.indexOf(0x0a, segStart);
  }
  // Pending tail: bytes after the last \n (or the whole buffer if no \n).
  // Starts at a line boundary, so it decodes cleanly even when `start` was
  // mid-char.
  let pendingTail = data.subarray(segStart).toString('utf8');

  // Cursor frequently leaves the final JSON object at EOF without a trailing
  // newline until the next turn mutates the mirror. If the tail is already a
  // complete JSON object, consume it now (message) or hold the offset before
  // it (status footer); otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const lineFileStart = newOffset;
      const obj = JSON.parse(pendingTail);
      if (isStatusFooterObject(obj)) {
        trailingFooterStart ??= lineFileStart;
      } else {
        trailingFooterStart = undefined;
        const ev = eventFromLine(path, lineFileStart, obj, Date.now());
        if (ev) events.push(ev);
        newOffset = readEndOffset;
      }
      pendingTail = '';
    } catch {
      // Still being written.
    }
  }
  if (trailingFooterStart !== undefined) {
    newOffset = trailingFooterStart;
    pendingTail = '';
  }
  return { events, newOffset, pendingTail, readEndOffset, snapshotComplete };
}
