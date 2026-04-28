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
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';

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
