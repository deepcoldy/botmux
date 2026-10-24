/**
 * Reader for Cursor Agent's per-chat transcript JSONL.
 *
 * `cursor-agent` keeps each chat's authoritative store in a SQLite file
 *   ~/.cursor/chats/<projectHash>/<chatId>/store.db
 * (held open via fd for the whole session) and, in parallel, mirrors the
 * conversation into an append-only JSONL transcript at
 *   ~/.cursor/projects/<projectSlug>/agent-transcripts/<chatId>/<chatId>.jsonl
 *
 * The bridge reads the JSONL (not the SQLite store) because it's plain text —
 * the same integration surface the Codex/CoCo bridges use. Each message line
 * is `{ role: 'user' | 'assistant', message: { content: [...] } }` where a
 * content block is either `{ type: 'text', text }` or `{ type: 'tool_use',
 * name, input }`. Tool *results* are not recorded.
 *
 * Message lines are append-only, but the file as a whole is NOT: at the end of
 * every turn cursor-agent appends a role-less status footer
 * (`{"type":"turn_ended","status":"success"|"error"|"aborted",...}`, 40-300
 * bytes), and the NEXT turn truncates that footer away and writes its new
 * lines starting at the footer's old byte position (the footer moves to the
 * new EOF). A byte-offset reader that consumed the footer would sit past the
 * truncation point, so every later turn's user line would start behind the
 * committed offset and be read only as an unparseable mid-line fragment.
 * Both the drain and the attach baseline therefore never commit past a
 * trailing footer, and do all offset arithmetic on raw bytes (see
 * scanCursorWindow) so a stale offset that lands inside a multi-byte
 * character cannot drift the frontier.
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
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';
import type { JsonlCursor } from './jsonl-cursor.js';
import { listProcessOpenFiles } from '../utils/process-open-files.js';


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
  const targets = listProcessOpenFiles(pid);
  if (!targets) return undefined;
  for (const target of targets) {
    const chatId = cursorChatIdFromStoreDbPath(target);
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
  /** Byte offset of the last fully-parsed line + its trailing \n — or the
   *  start of a trailing status footer, which is never committed past. The
   *  next drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
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

/** A parsed line that is not a conversation message: cursor-agent's
 *  role-less status footer (`{"type":"turn_ended",...}` — the only role-less
 *  shape observed in real transcripts). Classified by the ABSENCE of a role
 *  rather than by `type` so a future status line that cursor truncates the
 *  same way is still never committed past. */
function isStatusFooterObject(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return ((obj as any).role ?? (obj as any).message?.role) === undefined;
}

/** Leading bytes of a footer that is still being written (no closing brace
 *  yet). Only consulted for an unparseable EOF fragment at attach time. */
const STATUS_FOOTER_PREFIX = Buffer.from('{"type":"turn_ended"', 'utf8');

const PARSE_FAILED = Symbol('parse-failed');

function parseJsonBytes(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return PARSE_FAILED; }
}

interface CursorWindowScan {
  events: CodexBridgeEvent[];
  /** Absolute offset just past the window's last '\n' (= the window start
   *  when it holds none): the durable frontier of complete lines. */
  completeEnd: number;
  /** Absolute start of the trailing run of complete status-footer lines, if
   *  the complete lines end with one. Blank lines don't break the run. */
  footerRunStart: number | undefined;
  /** Raw bytes after the last '\n' (a line written without its '\n' yet). */
  tail: Buffer;
}

/** Walk the complete lines of `data` (file bytes starting at absolute offset
 *  `base`). Every offset comes from raw 0x0a positions, never from re-encoding
 *  decoded text: when `base` lands inside a multi-byte character (a stale
 *  offset after a footer rewrite, or an arbitrary tail-probe start) the decoded
 *  prefix gains U+FFFD replacement characters whose UTF-8 length differs from
 *  the original bytes, so `Buffer.byteLength(line)` arithmetic would push
 *  every later offset off the real line boundaries. Such a leading fragment
 *  simply fails JSON.parse here and costs nothing else. */
function scanCursorWindow(path: string, data: Buffer, base: number, emit: boolean): CursorWindowScan {
  const events: CodexBridgeEvent[] = [];
  let footerRunStart: number | undefined;
  let segStart = 0;
  for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, segStart)) {
    if (nl > segStart) {
      const lineStart = base + segStart;
      const obj = parseJsonBytes(data.subarray(segStart, nl));
      if (obj === PARSE_FAILED) {
        footerRunStart = undefined;
      } else if (isStatusFooterObject(obj)) {
        footerRunStart ??= lineStart;
      } else {
        footerRunStart = undefined;
        if (emit) {
          // No per-event timestamp in Cursor's JSONL — stamp with the drain
          // wall-clock. Combined with byte-offset baselining at attach, this
          // keeps the CodexBridgeQueue freshness gates happy without a real
          // timestamp.
          const ev = eventFromLine(path, lineStart, obj, Date.now());
          if (ev) events.push(ev);
        }
      }
    }
    segStart = nl + 1;
  }
  return { events, completeEnd: base + segStart, footerRunStart, tail: data.subarray(segStart) };
}

/** Open `path` read-only without ever blocking, and only if it is a regular
 *  file. O_NONBLOCK keeps a transcript path that is (or was swapped to) a FIFO
 *  from hanging the worker in open(2) waiting for a writer — the bridge attach
 *  and drain run synchronously on the worker's event loop. The type check uses
 *  the OPENED fd, so there is no stat→open replacement window. Returns null
 *  (fd closed) for a FIFO / directory / device; open errors propagate. */
function openRegularFile(path: string): { fd: number; size: number } | null {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let st;
  try { st = fstatSync(fd); } catch (err) { closeSync(fd); throw err; }
  if (!st.isFile()) { closeSync(fd); return null; }
  return { fd, size: st.size };
}

/** Increment-read the transcript from `fromOffset`. Same byte-offset contract
 *  as codex-transcript.drainCodexRollout so the worker reuses the same
 *  fs.watch / poll wakeup machinery and the shared CodexBridgeQueue.
 *
 *  Footer invariant: `newOffset` never advances past a trailing run of status
 *  footers (complete lines or a parseable EOF tail). The next turn rewrites
 *  from the footer's start, which is then exactly the committed offset. The
 *  cost is re-reading the ~40-300 byte footer on each poll; it re-parses to
 *  zero events, so nothing duplicates. A message line after the footer ends
 *  the run, so the frontier still only moves forward. */
export function drainCursorTranscript(path: string, fromOffset: number): CursorDrainResult {
  // Missing / unreadable / not a regular file: keep the offset. Shrunk below
  // it: hold — Cursor's mirror can briefly disappear or shrink while it
  // rewrites, and replaying the full history would pollute attribution state
  // and can wedge a live turn behind old events. Wait for the mirror to grow
  // past the last consumed byte instead. (Because the offset is parked at the
  // footer start, the footer truncation itself lands on size === offset: an
  // idle tick.)
  const unchanged: CursorDrainResult = { events: [], newOffset: fromOffset, pendingTail: '' };
  let file: { fd: number; size: number } | null;
  try { file = openRegularFile(path); } catch { return unchanged; }
  if (!file) return unchanged;
  let data: Buffer;
  try {
    if (file.size <= fromOffset) return unchanged;
    // A short read (the mirror shrank after fstat) yields only the bytes that
    // exist. Read errors propagate.
    const buf = Buffer.alloc(file.size - fromOffset);
    data = buf.subarray(0, readSync(file.fd, buf, 0, buf.length, fromOffset));
  } finally {
    closeSync(file.fd);
  }
  // Line offsets keep synthetic uuids stable across re-drains (message lines
  // are append-only; only the footer moves).
  const scan = scanCursorWindow(path, data, fromOffset, true);
  const { events } = scan;
  let footerRunStart = scan.footerRunStart;
  let newOffset = scan.completeEnd;
  let pendingTail = '';

  // Cursor frequently leaves the final JSON object at EOF without a trailing
  // newline until the next turn mutates the mirror. A complete message tail
  // is consumed now, a complete footer tail joins the footer run, and an
  // unparseable tail is still being written: it stays pending (never
  // committed), so it does not end the run either.
  if (scan.tail.length > 0) {
    const obj = parseJsonBytes(scan.tail);
    if (obj === PARSE_FAILED) {
      pendingTail = scan.tail.toString('utf8');
    } else if (isStatusFooterObject(obj)) {
      footerRunStart ??= scan.completeEnd;
    } else {
      footerRunStart = undefined;
      const ev = eventFromLine(path, scan.completeEnd, obj, Date.now());
      if (ev) events.push(ev);
      newOffset = fromOffset + data.length;
    }
  }
  if (footerRunStart !== undefined) {
    newOffset = footerRunStart;
    pendingTail = '';
  }
  return { events, newOffset, pendingTail };
}

const BASELINE_PROBE_BYTES = 64 * 1024;

/** Attach-time baseline for an EXISTING cursor transcript — the cursor
 *  counterpart of jsonl-cursor's baselineJsonlCursor: history stays behind the
 *  returned offset and is never re-ingested, but the offset REWINDS to the
 *  start of a trailing status footer so the next turn's footer-truncating
 *  rewrite begins exactly at the committed offset instead of behind it.
 *
 *  Only a footer EOF tail (complete, or still being written) rewinds to its
 *  start. Any other bytes after the last '\n' are history:
 *  - a COMPLETE record left without its '\n' is skipped in both modes — the
 *    cursor drain consumes a parseable EOF object as an event, so leaving it
 *    pending would replay that old prompt / reply with a fresh timestamp
 *    (a phantom local turn, or a bogus match for a same-fingerprint retry);
 *  - a window with no '\n' at all is skipped (baselineJsonlCursor's
 *    single-partial-line rule);
 *  - an unfinished fragment after complete lines is skipped with `skipTail`
 *    (adopt, 'baseline-existing-skip-tail': old in-flight output, like the
 *    plain size baseline it replaces) and otherwise kept as the pending tail
 *    exactly like baselineJsonlCursor (zero-prompt resume, codexBridgeAttach's
 *    'baseline-existing').
 *
 *  ONE stat-bounded read of the last 64 KiB decides the frontier, so no second
 *  stat can disagree with it; all offsets are raw-byte positions (see
 *  scanCursorWindow), so a probe start inside a multi-byte character cannot
 *  shift the result. A non-regular file (FIFO, directory) is opened without
 *  blocking and reported as empty. Returns undefined when the file is
 *  missing/unreadable so the caller keeps its existing degrade path. */
export function baselineCursorTranscript(path: string, opts: { skipTail?: boolean } = {}): JsonlCursor | undefined {
  let file: { fd: number; size: number } | null;
  try { file = openRegularFile(path); } catch { return undefined; }
  // FIFO / directory / device: no transcript content — the same answer the
  // stat-size baselines give for it (size 0), without blocking in open(2).
  if (!file) return { newOffset: 0, pendingTail: '' };
  const { fd, size } = file;
  try {
    if (size === 0) return { newOffset: 0, pendingTail: '' };
    const probeStart = Math.max(0, size - BASELINE_PROBE_BYTES);
    const buf = Buffer.alloc(size - probeStart);
    const data = buf.subarray(0, readSync(fd, buf, 0, buf.length, probeStart));
    const readEnd = probeStart + data.length;
    // A probe that starts mid-file begins with the back half of some line;
    // drop it rather than guess whether it is a line start.
    let skip = 0;
    if (probeStart > 0) {
      const firstNl = data.indexOf(0x0a);
      // One very long partial line: history (same as baselineJsonlCursor).
      if (firstNl < 0) return { newOffset: readEnd, pendingTail: '' };
      skip = firstNl + 1;
    }
    const scan = scanCursorWindow(path, data.subarray(skip), probeStart + skip, false);
    const tailStart = scan.completeEnd;
    let footerRunStart = scan.footerRunStart;
    if (scan.tail.length === 0) return { newOffset: footerRunStart ?? tailStart, pendingTail: '' };

    const obj = parseJsonBytes(scan.tail);
    const tailIsFooter = obj === PARSE_FAILED
      ? scan.tail.subarray(0, STATUS_FOOTER_PREFIX.length).equals(STATUS_FOOTER_PREFIX)
      : isStatusFooterObject(obj);
    if (tailIsFooter) return { newOffset: footerRunStart ?? tailStart, pendingTail: '' };
    // Non-footer tail: history (see the doc comment for the three cases).
    if (opts.skipTail || obj !== PARSE_FAILED || data.indexOf(0x0a) < 0) {
      return { newOffset: readEnd, pendingTail: '' };
    }
    // Unfinished fragment, zero-prompt resume: pending like baselineJsonlCursor
    // (holding before a footer run ahead of it costs nothing — the fragment is
    // never committed past either way).
    return footerRunStart !== undefined
      ? { newOffset: footerRunStart, pendingTail: '' }
      : { newOffset: tailStart, pendingTail: scan.tail.toString('utf8') };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
