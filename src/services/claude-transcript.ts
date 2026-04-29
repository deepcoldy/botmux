/**
 * Incremental reader for Claude Code transcript JSONL files.
 *
 * Used by the adopt-bridge pipeline (worker.ts) to:
 *   1. baseline the transcript at attach time so historical messages aren't
 *      replayed to Lark.
 *   2. drain newly-appended assistant messages between user turns.
 *   3. tolerate truncation, rotation, half-written JSON lines, and races with
 *      Claude Code's writer.
 *
 * The functions are pure (no fs.watch — that's the worker's wakeup concern)
 * to keep them unit-testable.
 */
import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Subset of Claude Code's JSONL event shape we care about. */
export interface TranscriptEvent {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export interface DrainResult {
  events: TranscriptEvent[];
  /** Byte offset to pass back on the next drain. */
  newOffset: number;
  /** Trailing partial line (no newline yet) — kept so the next drain can
   *  prepend it. Internal helper for chained drains; callers usually only
   *  need to remember `newOffset`. */
  pendingTail: string;
}

/**
 * Read everything from `path` starting at `fromOffset` and return parsed
 * JSONL events plus the new file offset.
 *
 * - Returns `{ events: [], newOffset: 0, pendingTail: '' }` if the file
 *   doesn't exist (caller treats this as "nothing yet").
 * - Detects truncation (size < fromOffset): resets to 0 and re-drains so a
 *   rotated/cleared transcript doesn't silently swallow new lines.
 * - Skips malformed JSON lines (logs nothing — robustness over noise).
 * - The trailing partial line (no `\n` yet) is *not* parsed and *not*
 *   counted toward `newOffset`, so the next drain re-reads it.
 */
export function drainTranscript(
  path: string,
  fromOffset: number,
): DrainResult {
  if (!existsSync(path)) {
    return { events: [], newOffset: 0, pendingTail: '' };
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], newOffset: fromOffset, pendingTail: '' };
  }
  let start = fromOffset;
  if (size < start) {
    // Truncated/rotated — re-read from the top.
    start = 0;
  }
  if (size === start) {
    return { events: [], newOffset: start, pendingTail: '' };
  }
  const len = size - start;
  const buf = Buffer.alloc(len);
  let read = 0;
  const fd = openSync(path, 'r');
  try {
    read = readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.subarray(0, read).toString('utf8');

  // Find the last '\n' — anything after it is a partial line we shouldn't
  // commit yet. Adjust newOffset to exclude the partial tail so the next
  // drain re-reads it.
  const lastNl = text.lastIndexOf('\n');
  let toParse: string;
  let pendingTail: string;
  let newOffset: number;
  if (lastNl < 0) {
    // No complete line at all — treat the whole buffer as pending.
    toParse = '';
    pendingTail = text;
    newOffset = start;
  } else {
    toParse = text.substring(0, lastNl);
    pendingTail = text.substring(lastNl + 1);
    newOffset = start + Buffer.byteLength(text.substring(0, lastNl + 1), 'utf8');
  }

  const events: TranscriptEvent[] = [];
  if (toParse) {
    for (const line of toParse.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') events.push(obj as TranscriptEvent);
      } catch {
        // Malformed line — skip silently. Claude Code's writer is atomic per
        // line, so this means a debug/non-JSON line snuck in; not our concern.
      }
    }
  }
  return { events, newOffset, pendingTail };
}

/**
 * Filter to assistant text events. Returns only events where:
 *   - type === 'assistant' OR message.role === 'assistant'
 *   - content has at least one text block
 *   - uuid is present
 *
 * Sub-agent / sidechain events (isSidechain === true) are excluded so that
 * spawn-internal Task agent chatter doesn't leak to Lark.
 */
export function pickAssistantTextEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  return events.filter(e => {
    if (!e || typeof e !== 'object') return false;
    if ((e as any).isSidechain === true) return false;
    const role = e.message?.role ?? e.type;
    if (role !== 'assistant') return false;
    if (!e.uuid) return false;
    const content = e.message?.content;
    if (!content) return false;
    if (typeof content === 'string') return content.length > 0;
    if (Array.isArray(content)) return content.some(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
    return false;
  });
}

/**
 * Extract the visible text from one assistant event. Walks all `type:'text'`
 * blocks in `message.content` (or the bare string) and joins them with
 * blank lines. Returns '' if no text blocks.
 */
export function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** Convenience: filter+extract a list of events into a single concatenated string. */
export function joinAssistantText(events: TranscriptEvent[]): string {
  return pickAssistantTextEvents(events)
    .map(extractAssistantText)
    .filter(s => s.length > 0)
    .join('\n\n');
}

/** XML wrappers Claude Code uses for synthetic user events that aren't real
 *  prompts (slash command invocation, local-command output caveat, etc.).
 *  These should usually carry `isMeta:true` and we'd filter on that — this
 *  list is a defense-in-depth check for jsonls where the flag is absent. */
const SYNTHETIC_USER_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
];

/** True when a `type:'user'` (or `message.role:'user'`) event represents a
 *  *real* prompt the human typed — not Claude Code's internal machinery
 *  (tool_result, slash-command wrappers, isMeta/isCompactSummary markers,
 *  sidechain spawn events). The bridge attribution queue and the adopt
 *  preamble extractor share this predicate to ensure they're seeing the
 *  same notion of "user input". */
export function isMeaningfulUserEvent(ev: TranscriptEvent | null | undefined): boolean {
  if (!ev || typeof ev !== 'object') return false;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'user') return false;
  const flags = ev as any;
  if (flags.isMeta === true) return false;
  if (flags.isCompactSummary === true) return false;
  if (flags.isSidechain === true) return false;
  const content = ev.message?.content;
  if (isPureToolResultUserEvent(content)) return false;
  const text = normaliseForFingerprint(stringifyUserContent(content));
  if (text.length === 0) return false;
  if (SYNTHETIC_USER_PREFIXES.some(p => text.startsWith(p))) return false;
  return true;
}

export interface AdoptPreamble {
  /** The most recent meaningful user prompt's text (post-stringify, no
   *  whitespace collapse — preserves the prompt's actual formatting). */
  userText: string;
  /** All assistant visible-text emitted between that user prompt and the
   *  end of the events list, joined with blank lines. tool_use blocks are
   *  excluded; sidechain assistant events are excluded. */
  assistantText: string;
}

/** Walk the events forward and return the last *completed* user/assistant
 *  exchange. "Completed" here means: a meaningful user prompt followed by
 *  at least one assistant event with visible text. tool_use / tool_result
 *  events do NOT reset the turn — they're intra-turn machinery, so a
 *  prompt → tool_use → tool_result → assistant text sequence still counts
 *  as a single turn. Returns null when there's no meaningful user yet, or
 *  the last user wasn't followed by any visible assistant text (Claude is
 *  mid-tool-use when /adopt fired).
 *
 *  Used by adopt-bridge to surface "the previous round" to the Lark thread
 *  so the user has context for continuing the conversation. */
export function extractLastAssistantTurn(events: TranscriptEvent[]): AdoptPreamble | null {
  let userText: string | null = null;
  let assistantTexts: string[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (isMeaningfulUserEvent(ev)) {
      // New turn boundary — reset the assistant accumulator.
      userText = stringifyUserContent(ev.message?.content);
      assistantTexts = [];
      continue;
    }
    const role = ev.message?.role ?? ev.type;
    if (role !== 'assistant') continue;
    if ((ev as any).isSidechain === true) continue;
    const text = extractAssistantText(ev);
    if (text.length === 0) continue;
    if (userText !== null) assistantTexts.push(text);
  }

  if (userText === null || assistantTexts.length === 0) return null;
  return {
    userText,
    assistantText: assistantTexts.join('\n\n'),
  };
}

/**
 * True when a user-role event carries ONLY tool_result blocks — Claude
 * Code's representation of "tool returned this output" between an
 * assistant tool_use and the assistant's continuation. Both the bridge
 * attribution queue and the on-disk fingerprint search must skip these:
 *
 *   - the queue would treat tool output as fresh local input and disable
 *     collection mid-turn,
 *   - the fingerprint search would false-positive on log content that
 *     happens to contain the Lark fingerprint substring (e.g. a short
 *     "hello" message hijacked by an unrelated jsonl whose tool_result
 *     dumped a log line containing "hello"). Re-exported by
 *     bridge-turn-queue.ts so both consumers share the same predicate
 *     and never drift apart.
 */
export function isPureToolResultUserEvent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block: any) => block?.type === 'tool_result');
}

/**
 * Stringify a transcript user event's content to a flat string. Handles
 * both legacy bare-string content and the array-of-blocks form.
 *
 * Lives here (not in bridge-turn-queue.ts) so the in-process attribution
 * state machine and the on-disk fingerprint search use *exactly* the
 * same text — otherwise multi-line / array-content Lark messages stop
 * matching one path or the other and bridges silently break.
 */
export function stringifyUserContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

/**
 * Collapse whitespace + trim. Same normalisation applied on both sides
 * of the fingerprint compare (the Lark message that produces the
 * fingerprint, and the transcript user content we search through),
 * so newlines / tabs / double-spaces don't break the match.
 */
export function normaliseForFingerprint(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Find the most recently-modified `.jsonl` file in a Claude Code project
 * directory. Helper kept for diagnostics and tests. The adopt-bridge
 * watcher does NOT use mtime to follow session switches — see
 * `findJsonlContainingFingerprint` for the safer fingerprint-based variant
 * that ignores unrelated panes writing in the same project directory.
 *
 * Returns null when the directory doesn't exist or has no jsonl files.
 */
export function findLatestJsonl(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let latestPath: string | null = null;
  let latestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestPath = full;
      }
    } catch {
      // File disappeared between readdir and stat — ignore.
    }
  }
  return latestPath;
}

/**
 * Search every `.jsonl` file in `dir` for one whose contents include the
 * given fingerprint. Used by the bridge watcher to detect a session
 * switch (`/clear` / `/resume`) caused by the user's pane: when a Lark
 * message is pending and its content fingerprint shows up in a NEW jsonl
 * file, that file is the user's current session and we should switch.
 *
 * Pinning the switch decision to fingerprint match (rather than mtime)
 * avoids hijacking by sibling Claude Code panes in the same project
 * directory — they'll write busy jsonls but won't ever contain our Lark
 * fingerprint.
 *
 * Optional `excludePath` skips the file we're already watching so the
 * caller's "did it change?" comparison is cheap.
 *
 * Reads only the trailing 1 MB of each candidate (fingerprints land near
 * the end of the jsonl when Claude has just written them) — long-lived
 * sessions can grow to tens of MB so a full read would be wasteful.
 * Callers should still gate on "an unstarted pending turn exists" rather
 * than calling this on every poll tick.
 */
export interface JsonlFingerprintSearchOptions {
  /** Skip the file the caller is already watching/checking. */
  excludePath?: string;
  /** Ignore older files when the caller is looking for a just-written submit. */
  minMtimeMs?: number;
  /** Also match Claude Code type-ahead enqueue events, whose content is not role:user. */
  includeQueueOperations?: boolean;
}

/** Scan a single jsonl file's tail for a Lark message fingerprint. Same
 *  parsing rules as `findJsonlContainingFingerprint` (decode role:user content,
 *  optionally also queue-operation/enqueue, normalise whitespace, then
 *  substring-match the fingerprint). Used by the claude-code adapter when
 *  the pid resolver has just switched to a rotated jsonl that may already
 *  contain the just-submitted user event. */
export function jsonlContainsFingerprint(
  path: string,
  fingerprint: string,
  opts?: { includeQueueOperations?: boolean },
): boolean {
  if (fingerprint.length === 0 || !existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size === 0) return false;
  const includeQueueOps = opts?.includeQueueOperations ?? false;
  const len = Math.min(size, 1024 * 1024);
  let buf: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // Skip the leading partial line when we read a strict tail (size > len).
  const startIdx = size > len ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    const role = ev.message?.role ?? ev.type;
    let lineText = '';
    if (role === 'user') {
      // Skip pure tool_result events — Claude Code records them as
      // role:user but they're internal turn machinery, not the user's
      // actual prompt. A tool_result that dumps log output containing
      // the fingerprint substring would otherwise hijack the search.
      if (isPureToolResultUserEvent(ev.message?.content)) continue;
      lineText = stringifyUserContent(ev.message?.content);
    } else if (
      includeQueueOps &&
      ev.type === 'queue-operation' &&
      ev.operation === 'enqueue'
    ) {
      lineText = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
    } else {
      continue;
    }
    const normalisedText = normaliseForFingerprint(lineText);
    if (normalisedText.length > 0 && normalisedText.includes(fingerprint)) return true;
  }
  return false;
}

export function findJsonlContainingFingerprint(
  dir: string,
  fingerprint: string,
  excludePathOrOptions?: string | JsonlFingerprintSearchOptions,
): string | null {
  if (!existsSync(dir) || fingerprint.length === 0) return null;
  const opts: JsonlFingerprintSearchOptions =
    typeof excludePathOrOptions === 'string'
      ? { excludePath: excludePathOrOptions }
      : (excludePathOrOptions ?? {});
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Walk newest-first so a recently-rotated jsonl is found before older
  // ones; if two files contain the fingerprint (rare, e.g. user pasted
  // the same message into two panes) we prefer the more recent.
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    if (opts.excludePath && full === opts.excludePath) continue;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) continue;
      candidates.push({ path: full, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of candidates) {
    try {
      const fd = openSync(path, 'r');
      try {
        const size = statSync(path).size;
        // Read at most the trailing 1MB — fingerprints land near the end
        // of the jsonl when Claude just wrote them. Cheaper than reading
        // an entire long-lived session.
        const len = Math.min(size, 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const text = buf.toString('utf8');
        // We must NOT do a raw includes() here: Claude writes user content
        // as a JSON-encoded string, so any newline in the Lark message is
        // serialized as `\n` on disk while our fingerprint has it
        // collapsed to a single space. Parse each complete jsonl line,
        // pick role:user events, and apply the same stringify+normalise
        // we use in BridgeTurnQueue.ingest. Skip the leading partial line
        // when we read a strict tail (size > len), since it likely begins
        // mid-line.
        const lines = text.split('\n');
        const startIdx = size > len ? 1 : 0;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== 'object') continue;
          const role = ev.message?.role ?? ev.type;
          let text = '';
          if (role === 'user') {
            // Skip pure tool_result events — see jsonlContainsFingerprint
            // for the full rationale; in short, tool_result content is
            // log output, not user input, and would false-match short
            // fingerprints like "hello" in unrelated jsonls.
            if (isPureToolResultUserEvent(ev.message?.content)) continue;
            text = stringifyUserContent(ev.message?.content);
          } else if (
            opts.includeQueueOperations &&
            ev.type === 'queue-operation' &&
            ev.operation === 'enqueue'
          ) {
            text = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
          } else {
            continue;
          }
          const normalisedText = normaliseForFingerprint(text);
          if (normalisedText.length > 0 && normalisedText.includes(fingerprint)) return path;
        }
      } finally {
        closeSync(fd);
      }
    } catch { /* unreadable — skip */ }
  }
  return null;
}
