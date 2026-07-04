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

/** Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 *  contract of codex-transcript.drainCodexRollout so the worker can reuse the
 *  same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue. */
export function drainCursorTranscript(path: string, fromOffset: number): CursorDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: fromOffset, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  // Cursor's mirror can briefly disappear / shrink while it rewrites. Do not
  // reset to 0 here: replaying the full history pollutes attribution state and
  // can wedge a live turn behind old events. Wait for the mirror to grow past
  // the last consumed byte instead.
  if (size < start) return { events: [], newOffset: fromOffset, pendingTail: '' };
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  let pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  let newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CodexBridgeEvent[] = [];
  // Track byte offset within the file so synthetic uuids are stable across
  // re-drains (the transcript is append-only).
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1; // the \n after an empty line
      continue;
    }
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // include \n
    const lineStart = cursor;
    cursor += lineByteLen;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    // No per-event timestamp in Cursor's JSONL — stamp with the drain
    // wall-clock. Combined with byte-offset baselining at attach, this keeps
    // the CodexBridgeQueue freshness gates happy without a real timestamp.
    const timestampMs = Date.now();
    const ev = eventFromLine(path, lineStart, obj, timestampMs);
    if (ev) events.push(ev);
  }

  // Cursor frequently leaves the final JSON object at EOF without a trailing
  // newline until the next turn mutates the mirror. If the tail is already a
  // complete JSON object, consume it now; otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const lineStart = newOffset;
      const obj = JSON.parse(pendingTail);
      const ev = eventFromLine(path, lineStart, obj, Date.now());
      if (ev) events.push(ev);
      newOffset = size;
      pendingTail = '';
    } catch {
      // Still being written.
    }
  }
  return { events, newOffset, pendingTail };
}
