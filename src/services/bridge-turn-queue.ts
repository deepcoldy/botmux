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
 *       * user event → the earliest unstarted pending turn whose fingerprint
 *         matches becomes 'started' (its assistantUuids will collect from
 *         now on). A user event that does NOT match any pending fingerprint
 *         (or arrives with no pending Lark turn at all) is treated as
 *         **local terminal input**: a synthetic local turn is created on
 *         the spot, started immediately, and inserted ahead of any
 *         still-unstarted Lark turns so emit ordering reflects when the
 *         user event actually landed in the transcript. The local turn is
 *         emitted with `isLocal: true` so the worker can format it with a
 *         "user typed in the terminal" marker for the Lark thread.
 *       * assistant text event (non-sidechain) → appended to the
 *         currently-collecting turn (Lark or local), if any.
 *   - drainEmittable() — pops any leading turn that has been started AND has
 *     accumulated at least one visible assistant-text uuid. Started turns with no text
 *     yet (Claude is mid-tool-use) stay queued for the next idle.
 *
 * Baseline (`absorb()`) takes a batch of historical events and registers
 * their uuids as already-seen so future ingest doesn't double-attribute.
 */
import { stringifyUserContent, normaliseForFingerprint, isMeaningfulUserEvent, type TranscriptEvent } from './claude-transcript.js';

// Re-export so existing callers (worker.ts, tests) don't need to change
// their import path now that these helpers live in claude-transcript.ts.
export { normaliseForFingerprint };

export interface BridgePendingTurn {
  turnId: string;
  started: boolean;
  assistantUuids: string[];
  /** Set when this turn was synthesised from a local-terminal user event
   *  (no matching Lark fingerprint). Causes the worker emit path to format
   *  the Lark message with both user text and assistant text under a
   *  "🖥️ 终端本地对话" header — otherwise the user would see an orphan
   *  reply with no prompt for context. Lark-driven turns keep this unset. */
  isLocal?: boolean;
  /** Transcript uuid of the user event that started this turn. Stored for
   *  local turns so emit can fetch the user-typed content from the source
   *  jsonl alongside the assistant uuids. Lark turns don't need it because
   *  the user content is already known on the daemon side. */
  userUuid?: string;
  /** A short substring of the Lark message that we expect to find inside
   *  the next matching `user` event's content. When set, only a user event
   *  whose stringified content contains this fingerprint is allowed to
   *  start the turn. Local-terminal input (whose content won't contain
   *  the Lark fingerprint) leaves the turn unstarted. */
  contentFingerprint?: string;
  /** JSONL file the turn's user event was first seen in. Stamped by ingest()
   *  when the turn transitions to started. Lets the emit step re-read text
   *  from the original transcript even after a sessionId rotation has
   *  pointed bridgeJsonlPath at a *different* file — without this stamp,
   *  uuid → text resolution would fail and the reply would be silently
   *  dropped. */
  sourceJsonlPath?: string;
  /** Wall-clock millis when mark() was called. Lets the fingerprint-based
   *  rotation fallback bound its scan to events written after we marked
   *  the turn — short fingerprints ("hello", "test") would otherwise risk
   *  matching pre-existing user lines in unrelated sibling jsonls. */
  markTimeMs?: number;
}

function assistantHasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0);
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
   *  `undefined` to start on the next user event regardless (legacy).
   *
   *  `markTimeMs` is captured here so the rotation fallback can bound its
   *  fingerprint scan to events written after this point — protects short
   *  fingerprints from matching old history in unrelated sibling jsonls. */
  mark(turnId: string, contentFingerprint?: string, markTimeMs: number = Date.now()): void {
    this.queue.push({ turnId, started: false, assistantUuids: [], contentFingerprint, markTimeMs });
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
   *  uuids are skipped, so callers can safely replay.
   *
   *  `sourceJsonlPath` (when provided) is stamped onto a turn at the moment
   *  it transitions from "pending" to "started" — so that emit-time text
   *  resolution reads the same transcript file the user/assistant uuids
   *  were originally observed in. Without this, a sessionId rotation
   *  between ingest and emit would silently drop the reply, since the
   *  global current jsonl path would no longer contain those uuids. */
  ingest(events: TranscriptEvent[], sourceJsonlPath?: string): void {
    for (const ev of events) {
      const uuid = ev.uuid;
      if (!uuid || this.seen.has(uuid)) continue;
      this.seen.add(uuid);
      const role = ev.message?.role ?? ev.type;
      if (role === 'user') {
        // Skip ALL non-meaningful user events: tool_result (intra-turn
        // machinery), `<command-name>/clear</command-name>` and other
        // slash-command wrappers (Claude rewrites them after /clear /
        // /resume — same in-process rotation that broke bridge tracking
        // before), isMeta / isCompactSummary markers, sidechain spawns,
        // empty content. These are NOT real user input; treating them as
        // turn boundaries would (a) drop `collecting` mid-stream and lose
        // assistant text after them, and (b) let a synthetic line that
        // accidentally contains the fingerprint substring start the
        // wrong turn.
        if (!isMeaningfulUserEvent(ev)) continue;
        // Defensive: if the previous local turn never accumulated any
        // assistant text (Claude crashed / was killed / user cancelled
        // mid-response), drop it now so its empty `assistantUuids` doesn't
        // head-of-line block every subsequent emit. Lark turns are NOT
        // dropped here — they may still be in tool-use legitimately, and
        // Lark-side timeout is tracked separately by the daemon.
        if (this.collecting && this.collecting.isLocal && this.collecting.assistantUuids.length === 0) {
          const idx = this.queue.indexOf(this.collecting);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.collecting = null;
        }
        const next = this.queue.find(t => !t.started);
        let consumedNext = false;
        if (next) {
          // If this turn has a fingerprint, gate on a content match. Both
          // sides are normalised (whitespace-collapsed + trimmed) before
          // the substring check so a transcript line that preserved
          // newlines still matches a fingerprint built from the same text.
          if (next.contentFingerprint) {
            const userText = normaliseForFingerprint(stringifyUserContent(ev.message?.content));
            if (userText.includes(next.contentFingerprint)) {
              next.started = true;
              if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
              this.collecting = next;
              consumedNext = true;
            }
            // Mismatch falls through to the local-turn branch below.
          } else {
            // Legacy mark() with no fingerprint — start on the next user.
            next.started = true;
            if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
            this.collecting = next;
            consumedNext = true;
          }
        }
        if (!consumedNext) {
          // Local-terminal input. Synthesise a started turn so the
          // assistant text that follows is captured (and pushed to the
          // Lark thread) instead of being silently dropped — that's the
          // /adopt symptom users hit when typing directly in the iterm
          // pane. Insert AHEAD of any still-unstarted Lark turn so
          // chronological order is preserved: this user event landed in
          // the transcript before the next Lark turn's user event will.
          const localTurn: BridgePendingTurn = {
            turnId: `local-${uuid}`,
            started: true,
            isLocal: true,
            userUuid: uuid,
            assistantUuids: [],
            sourceJsonlPath,
            markTimeMs: Date.now(),
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(localTurn);
          else this.queue.splice(insertAt, 0, localTurn);
          this.collecting = localTurn;
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
