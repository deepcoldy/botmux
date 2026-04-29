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
  /** Drop events whose `timestamp` field is older than this (millis since
   *  epoch). Defends against short fingerprints ("hello", "test") matching
   *  old user lines in unrelated sibling jsonls — file mtime alone isn't
   *  enough since a sibling Claude pane could be actively writing. */
  minEventTimestampMs?: number;
  /** Also match Claude Code type-ahead enqueue events, whose content is not role:user. */
  includeQueueOperations?: boolean;
  /** Called on each candidate that already passed the fingerprint match.
   *  Returning `false` skips the candidate and continues searching older
   *  files in the directory (mtime-descending walk). Used by the bridge
   *  watcher to reject sibling-pane jsonls whose sessionId we don't trust,
   *  without losing the chance to find a legitimate /clear rotation buried
   *  under a busier sibling. Default (no callback): accept the first
   *  fingerprint match like the original behaviour. */
  acceptCandidate?: (path: string) => boolean;
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
  opts?: { includeQueueOperations?: boolean; minEventTimestampMs?: number },
): boolean {
  if (fingerprint.length === 0 || !existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size === 0) return false;
  const includeQueueOps = opts?.includeQueueOperations ?? false;
  const minEventTimestampMs = opts?.minEventTimestampMs;
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
    // Per-event timestamp guard: short fingerprints would otherwise
    // false-match old user events in unrelated sibling jsonls (file
    // mtime can be recent if a sibling Claude pane is actively writing
    // its own turns). We compare against `event.timestamp` rather than
    // file mtime to be precise.
    if (minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
      const evMs = Date.parse(ev.timestamp);
      if (Number.isFinite(evMs) && evMs < minEventTimestampMs) continue;
    }
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
          // Per-event timestamp guard — see jsonlContainsFingerprint for
          // the full rationale. Required to keep short fingerprints
          // ("hello", "test") from matching old user lines in unrelated
          // sibling jsonls.
          if (opts.minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
            const evMs = Date.parse(ev.timestamp);
            if (Number.isFinite(evMs) && evMs < opts.minEventTimestampMs) continue;
          }
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
          if (normalisedText.length > 0 && normalisedText.includes(fingerprint)) {
            // Allow caller to veto this candidate (e.g., sibling-pane
            // hijack guard rejecting an untrusted sessionId). On veto,
            // break out of the line loop so we move to the next, older
            // candidate instead of returning `null` after the first
            // fingerprint hit.
            if (opts.acceptCandidate && !opts.acceptCandidate(path)) {
              break;
            }
            return path;
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch { /* unreadable — skip */ }
  }
  return null;
}

/**
 * Stronger sibling-pane recovery anchor than the substring fingerprint
 * search. Walks every `.jsonl` in `dir` and returns the paths whose
 * trailing 1MB contains a user/queue event whose normalised text is
 * EXACTLY equal to `normalisedContent` (not a substring), respecting
 * `excludePath`, `minMtimeMs`, `minEventTimestampMs`,
 * `includeQueueOperations`, and `acceptCandidate` the same way as
 * `findJsonlContainingFingerprint`.
 *
 * Returns *all* matches in mtime-descending order — callers must
 * abstain when the result has length > 1, since multiple files containing
 * the same exact normalised content cannot be disambiguated without
 * stronger evidence (and forcing a switch would risk picking the wrong
 * pane). The caller's typical pattern is:
 *
 *   - 1 match → switch to it (legitimate post-/clear recovery)
 *   - 0 matches → no recovery this tick; wait for stronger signal
 *   - >1 match → log and abstain; surface a diagnostic to the user
 *
 * Used by the bridge fingerprint fallback's recovery path for in-pane
 * `/clear`: substring matches risk hijacking on short fingerprints (the
 * literal text "test" matches "run tests" / "test bridge"), but full
 * equality on a Lark message we just wrote is a much stronger anchor.
 */
export function findJsonlsContainingExactContent(
  dir: string,
  normalisedContent: string,
  options?: JsonlFingerprintSearchOptions,
): string[] {
  if (!existsSync(dir) || normalisedContent.length === 0) return [];
  const opts: JsonlFingerprintSearchOptions = options ?? {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
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
  const matches: string[] = [];
  for (const { path } of candidates) {
    if (opts.acceptCandidate && !opts.acceptCandidate(path)) continue;
    try {
      const fd = openSync(path, 'r');
      try {
        const size = statSync(path).size;
        const len = Math.min(size, 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        const startIdx = size > len ? 1 : 0;
        let hit = false;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== 'object') continue;
          if (opts.minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
            const evMs = Date.parse(ev.timestamp);
            if (Number.isFinite(evMs) && evMs < opts.minEventTimestampMs) continue;
          }
          const role = ev.message?.role ?? ev.type;
          let raw = '';
          if (role === 'user') {
            if (isPureToolResultUserEvent(ev.message?.content)) continue;
            raw = stringifyUserContent(ev.message?.content);
          } else if (
            opts.includeQueueOperations &&
            ev.type === 'queue-operation' &&
            ev.operation === 'enqueue'
          ) {
            raw = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
          } else {
            continue;
          }
          const normalised = normaliseForFingerprint(raw);
          if (normalised === normalisedContent) {
            hit = true;
            break;
          }
        }
        if (hit) matches.push(path);
      } finally {
        closeSync(fd);
      }
    } catch { /* unreadable — skip */ }
  }
  return matches;
}

/**
 * Partition transcript events into history (timestamp ≤ cutoff) and live
 * (timestamp > cutoff, or no parseable timestamp). Used by the bridge
 * watcher when it switches to a new jsonl that may contain pre-existing
 * conversation: anything older than the cutoff (e.g. iTerm-typed turns
 * the user produced before the Lark mark fired) belongs in the seen-set
 * via `BridgeTurnQueue.absorb` so the worker doesn't replay them as
 * "🖥️ 终端本地对话" cards. Anything newer is fed through `ingest()` so
 * the freshly-written Lark user event can match its pending fingerprint.
 *
 * Events with malformed / missing timestamps fall into `live`: better
 * to forward an unattributable event once than to silently drop a real
 * reply because Claude omitted a timestamp.
 */
export function splitTranscriptEventsByCutoff(
  events: TranscriptEvent[],
  cutoffMs: number,
): { history: TranscriptEvent[]; live: TranscriptEvent[] } {
  const history: TranscriptEvent[] = [];
  const live: TranscriptEvent[] = [];
  for (const ev of events) {
    let evMs = Number.NaN;
    if (typeof ev.timestamp === 'string') evMs = Date.parse(ev.timestamp);
    if (Number.isFinite(evMs) && evMs <= cutoffMs) history.push(ev);
    else live.push(ev);
  }
  return { history, live };
}

/**
 * Read the first event timestamp out of a jsonl. Reads only the leading
 * 4 KB — Claude's `file-history-snapshot` and `SessionStart` events both
 * land in the first few hundred bytes. Returns the parsed millis, or
 * undefined when no parseable timestamp is found in the leading chunk
 * (corrupted file, partial first line, format change).
 *
 * NOTE: not currently wired into the bridge rotation flow. The bridge
 * fingerprint fallback (`decideFingerprintSwitch` in
 * `bridge-rotation-policy.ts`) deliberately rejects candidates outside
 * the pid-derived trust set rather than relying on freshness heuristics
 * — file-creation timestamps cannot prove ownership across panes in
 * the same project dir. Kept here as a reusable primitive for
 * diagnostics and future /clear-recovery work.
 */
export function readFirstEventTimestamp(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const len = 4096;
    const buf = Buffer.alloc(len);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, len, 0);
    } catch {
      return undefined;
    }
    if (bytesRead <= 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    // Drop the trailing partial line if we read exactly `len` bytes — it
    // may not be a complete JSON object. When the whole file is shorter
    // than `len` bytes the last line is complete and we keep it.
    const usable = bytesRead === len ? lines.slice(0, -1) : lines;
    for (const line of usable) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      // Top-level `timestamp` field — covers both regular events
      // (user/assistant/attachment) and `file-history-snapshot` records
      // whose `timestamp` lives under `snapshot.timestamp` instead.
      const tsStr = typeof ev?.timestamp === 'string'
        ? ev.timestamp
        : typeof ev?.snapshot?.timestamp === 'string'
          ? ev.snapshot.timestamp
          : undefined;
      if (!tsStr) continue;
      const ms = Date.parse(tsStr);
      if (Number.isFinite(ms)) return ms;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
