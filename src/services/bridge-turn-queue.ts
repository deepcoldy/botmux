/**
 * Adopt-bridge turn attribution state machine.
 *
 * Pure (no fs / IPC / timers) so the worker can wrap it with watchers and
 * tests can drive it deterministically. The worker feeds it transcript
 * events (already drained from JSONL) and Lark-message markers; this class
 * decides which assistant uuids belong to which Lark turn.
 *
 * Attribution rule:
 *   - mark()           — pushes a new pending turn entry (state: not started)
 *   - ingest(events)   — for each new user/assistant event:
 *       * user event → the earliest unstarted pending turn becomes 'started'
 *         (its assistantUuids will collect from now on). A user event with
 *         no unstarted pending turn is treated as local terminal input and
 *         disables collection so subsequent assistant events don't bleed
 *         into a previous Lark turn.
 *       * assistant text event (non-sidechain) → appended to the
 *         currently-collecting turn, if any.
 *   - drainEmittable() — pops any leading turn that has been started AND has
 *     accumulated at least one visible assistant-text uuid. Started turns with no text
 *     yet (Claude is mid-tool-use) stay queued for the next idle.
 *
 * Baseline (`absorb()`) takes a batch of historical events and registers
 * their uuids as already-seen so future ingest doesn't double-attribute.
 */
import type { TranscriptEvent } from './claude-transcript.js';

export interface BridgePendingTurn {
  turnId: string;
  started: boolean;
  assistantUuids: string[];
  /** A short substring of the Lark message that we expect to find inside
   *  the next matching `user` event's content. When set, only a user event
   *  whose stringified content contains this fingerprint is allowed to
   *  start the turn. Local-terminal input (whose content won't contain
   *  the Lark fingerprint) leaves the turn unstarted. */
  contentFingerprint?: string;
}

/** Stringify a transcript user event's content to a flat string for
 *  fingerprint matching. Handles both legacy string content and the
 *  array-of-blocks form. */
function stringifyUserContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

function isPureToolResultUserEvent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block: any) => block?.type === 'tool_result');
}

function assistantHasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0);
}

/** Collapse whitespace + trim. Used both when building the fingerprint
 *  from the Lark message and when normalising the transcript's user
 *  content for the substring check — same normalisation on both sides
 *  keeps the match stable when Claude Code preserves newlines that the
 *  fingerprint doesn't.
 *  Exported for tests. */
export function normaliseForFingerprint(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Trim a Lark message into a stable fingerprint. Keeps a leading window
 *  of non-whitespace-collapsed content; long enough to disambiguate, short
 *  enough that minor formatting differences (newlines, attachment hints
 *  appended below) don't break the match. */
export function makeFingerprint(message: string, len = 30): string | undefined {
  if (typeof message !== 'string') return undefined;
  const collapsed = normaliseForFingerprint(message);
  if (collapsed.length === 0) return undefined;
  return collapsed.substring(0, len);
}

export class BridgeTurnQueue {
  private seen = new Set<string>();
  private queue: BridgePendingTurn[] = [];
  private collecting: BridgePendingTurn | null = null;

  /** Register events as historical — their uuids are now considered seen
   *  but no attribution happens. Used at attach time to baseline. */
  absorb(events: TranscriptEvent[]): void {
    for (const ev of events) {
      if (ev.uuid) this.seen.add(ev.uuid);
    }
  }

  /** Push a new pending turn for the next Lark message. `contentFingerprint`
   *  (when set) restricts which user event can start this turn — only a
   *  user event whose content contains the fingerprint qualifies. Pass
   *  `undefined` to start on the next user event regardless (legacy). */
  mark(turnId: string, contentFingerprint?: string): void {
    this.queue.push({ turnId, started: false, assistantUuids: [], contentFingerprint });
  }

  /** Drop all pending turns. Used when the worker discovers it can't
   *  reliably attribute future events (e.g. baseline raced with a turn
   *  already in flight) and wants to clear the slate. */
  clearPending(): BridgePendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    return dropped;
  }

  /** Process newly-appended events. Idempotent on uuid: events with seen
   *  uuids are skipped, so callers can safely replay. */
  ingest(events: TranscriptEvent[]): void {
    for (const ev of events) {
      const uuid = ev.uuid;
      if (!uuid || this.seen.has(uuid)) continue;
      this.seen.add(uuid);
      const role = ev.message?.role ?? ev.type;
      if (role === 'user') {
        // Claude Code records tool results as role:user entries between the
        // assistant's tool_use and final text. They are part of the same turn,
        // not local user input, so they must not stop collection.
        if (isPureToolResultUserEvent(ev.message?.content)) continue;
        const next = this.queue.find(t => !t.started);
        if (next) {
          // If this turn has a fingerprint, gate on a content match. Both
          // sides are normalised (whitespace-collapsed + trimmed) before
          // the substring check so a transcript line that preserved
          // newlines still matches a fingerprint built from the same text.
          if (next.contentFingerprint) {
            const userText = normaliseForFingerprint(stringifyUserContent(ev.message?.content));
            if (!userText.includes(next.contentFingerprint)) {
              // Treat as local input — keep next unstarted, disable collection.
              this.collecting = null;
              continue;
            }
          }
          next.started = true;
          this.collecting = next;
        } else {
          // Local-terminal input — disable collection so the assistant
          // events that follow this user line aren't attributed to a stale
          // collecting turn from before.
          this.collecting = null;
        }
      } else if (role === 'assistant') {
        if ((ev as any).isSidechain === true) continue;
        if (this.collecting && assistantHasVisibleText(ev.message?.content)) {
          this.collecting.assistantUuids.push(uuid);
        }
      }
    }
  }

  /** Pop FIFO any leading turn that's started AND has assistant text.
   *  Returns the popped turns in order; the caller is responsible for
   *  rebuilding the text payload from the assistant uuids. */
  drainEmittable(): BridgePendingTurn[] {
    const out: BridgePendingTurn[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.started || head.assistantUuids.length === 0) break;
      this.queue.shift();
      if (this.collecting === head) this.collecting = null;
      out.push(head);
    }
    return out;
  }

  /** Number of queued (not-yet-emitted) Lark turns. */
  size(): number {
    return this.queue.length;
  }

  /** Test helper — peek the queue without mutating. */
  peek(): readonly BridgePendingTurn[] {
    return this.queue;
  }
}
