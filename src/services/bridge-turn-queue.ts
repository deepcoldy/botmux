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
import {
  normaliseForFingerprint,
  isMeaningfulUserEvent,
  isMeaningfulQueuedCommand,
  extractTurnStartText,
  isClaudeTurnTerminalEvent,
  type TranscriptEvent,
} from './claude-transcript.js';

// Re-export so existing callers (worker.ts, tests) don't need to change
// their import path now that these helpers live in claude-transcript.ts.
export { normaliseForFingerprint };

function assistantHasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0);
}

export interface BridgePendingTurn {
  turnId: string;
  dispatchAttempt?: number;
  started: boolean;
  assistantUuids: string[];
  /** An authoritative transcript boundary closed this turn. Durable turns may
   * never settle from screen-idle alone; worker terminal emission requires
   * this bit (or an explicit failure/exit path outside the queue). */
  terminalObserved?: boolean;
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
  /** Full normalised content of the Lark message. Used by the rotation
   *  fallback's recovery path to gate a switch into an UNKNOWN sessionId
   *  on exact equality with a user/queue event in that file — much
   *  stronger than the substring fingerprint check, which can't tell
   *  "test" from "run tests" across sibling panes. Stored in addition to
   *  `contentFingerprint` (not instead of) because in-pane known-sid
   *  candidates still benefit from the cheaper substring path. */
  contentNormalized?: string;
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
  mark(
    turnId: string,
    contentFingerprint?: string,
    markTimeMs: number = Date.now(),
    contentNormalized?: string,
    dispatchAttempt?: number,
  ): string {
    this.queue.push({
      turnId,
      dispatchAttempt,
      started: false,
      assistantUuids: [],
      contentFingerprint,
      contentNormalized,
      markTimeMs,
    });
    return turnId;
  }

  /** Drop all pending turns. Used when the worker discovers it can't
   *  reliably attribute future events (e.g. baseline raced with a turn
   *  already in flight) and wants to clear the slate. */
  clearPending(): BridgePendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    return dropped;
  }

  /** Drop one exact pending delivery attempt iff it has not yet started
   *  collecting assistant text. A durable retry reuses turnId with a higher
   *  dispatchAttempt, so matching only turnId would let attempt N's delayed
   *  submit-failure timer delete the live mark for retry N+1. Returns the
   *  dropped turn or null if the exact attempt is not found / already started.
   *  Used by the worker when a writeInput's deferred recheck conclusively
   *  fails — the user has been notified the message was lost, so keeping a
   *  fingerprint-bearing mark around only fuels the per-tick rotation-fallback
   *  scan that already spammed 99% CPU once (no jsonl line will ever match). */
  dropPendingTurn(turnId: string, dispatchAttempt?: number): BridgePendingTurn | null {
    const idx = this.queue.findIndex(t =>
      t.turnId === turnId
      && t.dispatchAttempt === dispatchAttempt
      && !t.started,
    );
    if (idx === -1) return null;
    const [dropped] = this.queue.splice(idx, 1);
    return dropped;
  }

  /** Sweep pending (unstarted) turns whose mark is older than `maxAgeMs`.
   *  Returns the dropped turns for logging. Belt-and-braces backstop for
   *  any future code path that leaves an unstarted mark stranded — without
   *  it, `maybeSwitchBridgeJsonl` would keep doing full-directory jsonl
   *  scans every poll tick until the worker restarts. Started turns are
   *  never expired here: once Claude actually wrote the user line, the
   *  turn is collecting assistant text and we want to wait however long
   *  the model takes. */
  pruneExpired(maxAgeMs: number, now: number = Date.now()): BridgePendingTurn[] {
    const dropped: BridgePendingTurn[] = [];
    this.queue = this.queue.filter(t => {
      if (t.started) return true;
      if (t.markTimeMs === undefined) return true;
      if (now - t.markTimeMs <= maxAgeMs) return true;
      dropped.push(t);
      return false;
    });
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
        this.handleTurnStart(uuid, ev, sourceJsonlPath);
      } else if (ev.type === 'attachment' && ev.attachment?.type === 'queued_command') {
        // Type-ahead path: Claude writes `attachment(queued_command)` the
        // moment it dequeues a queued submit, immediately before the
        // assistant text for that turn starts streaming. Equivalent to
        // role:user for turn-start purposes; share the same handler so
        // fingerprint-match / HOL-block-drop / local-turn fallback all
        // apply identically. Without this the bridge attribution queue
        // would skip queued_command events and the type-ahead'd turn's
        // assistant text would either be dropped or attributed to a
        // sibling turn.
        if (!isMeaningfulQueuedCommand(ev)) continue;
        this.handleTurnStart(uuid, ev, sourceJsonlPath);
      } else if (role === 'assistant') {
        if ((ev as any).isSidechain === true) continue;
        const hasVisibleText = assistantHasVisibleText(ev.message?.content);
        if (hasVisibleText && !this.collecting) {
          // Headless local turn: an assistant boundary arrived without any
          // collecting context. Typical trigger: daemon restart cut off
          // an in-flight model stream — baseline absorbed the original
          // user event (uuid added to `seen`) and the worker process lost
          // its in-memory `collecting` pointer. Without this synthesis the
          // continuation would be silently dropped.
          // Headless turns have no userUuid; emit-side formatting omits
          // the user block. Inserted at the head of the unstarted region
          // so a subsequent normal turn doesn't get reordered ahead of it.
          const headless: BridgePendingTurn = {
            turnId: `local-headless-${uuid}`,
            started: true,
            isLocal: true,
            userUuid: undefined,
            assistantUuids: [],
            sourceJsonlPath,
            markTimeMs: Date.now(),
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(headless);
          else this.queue.splice(insertAt, 0, headless);
          this.collecting = headless;
        }
        if (hasVisibleText) this.collecting?.assistantUuids.push(uuid);
        if (isClaudeTurnTerminalEvent(ev) && this.collecting) {
          this.collecting.terminalObserved = true;
        }
      } else if (isClaudeTurnTerminalEvent(ev)) {
        // Claude normally writes this as `system/turn_duration` immediately
        // after the final assistant line. It is a second marker for the same
        // logical boundary; setting a bit is naturally idempotent.
        if (this.collecting) this.collecting.terminalObserved = true;
      }
    }
  }

  /** Shared turn-start handler. Called for both `role:user` and
   *  `attachment(queued_command)` events once meaningfulness has been
   *  established by the caller. Encapsulates:
   *    1. HOL-block drop of the previous collecting turn when it got no
   *       assistant text (Claude moved on).
   *    2. Fingerprint-gated start of the earliest unstarted Lark turn,
   *       falling through to local-turn synthesis on mismatch.
   *    3. markTimeMs override to the transcript event's own timestamp —
   *       critical for type-ahead, where the original markTimeMs (set when
   *       the worker wrote to PTY) can be many seconds earlier than the
   *       moment Claude actually dequeues and starts processing the turn.
   *       The bridge-fallback gate's [markTimeMs, nextBoundaryMs) window
   *       MUST anchor on the latter, otherwise a `botmux send` from the
   *       previous turn can leak into the next turn's window and the
   *       suppression decision flips to the wrong turn (real reply
   *       suppressed, fallback shown — exactly what the type-ahead-disable
   *       in commit b2d9791 was protecting against). */
  private handleTurnStart(uuid: string, ev: TranscriptEvent, sourceJsonlPath?: string): void {
    // A following real user/queued-command event is itself a transcript-order
    // proof that the previous durable turn ended. This covers older Claude
    // JSONL variants that omitted the explicit final marker, without trusting
    // the TUI's prompt-looking screen. Keep the turn queued so an empty/silent
    // durable delivery still produces its terminal receipt.
    if (this.collecting?.dispatchAttempt !== undefined && !this.collecting.terminalObserved) {
      this.collecting.terminalObserved = true;
      this.collecting = null;
    }
    // Head-of-line block drop: previous turn never produced any visible
    // assistant text and a new meaningful turn-start has arrived → Claude
    // is single-threaded over the PTY, so the old turn will never get
    // text. Applies to both Lark and local turns.
    if (this.collecting
      && !this.collecting.terminalObserved
      && this.collecting.assistantUuids.length === 0) {
      const idx = this.queue.indexOf(this.collecting);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.collecting = null;
    }
    const tsParsed = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    const eventTimeMs = Number.isFinite(tsParsed) ? tsParsed : Date.now();
    const next = this.queue.find(t => !t.started);
    let consumedNext = false;
    if (next) {
      if (next.contentFingerprint) {
        // Both sides normalised (whitespace-collapsed + trimmed) before
        // the substring check so a transcript line that preserved newlines
        // still matches a fingerprint built from the same text.
        const userText = normaliseForFingerprint(extractTurnStartText(ev));
        if (userText.includes(next.contentFingerprint)) {
          next.started = true;
          if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
          next.markTimeMs = eventTimeMs;
          this.collecting = next;
          consumedNext = true;
        }
        // Mismatch falls through to local-turn synthesis below.
      } else {
        // Legacy mark() with no fingerprint — start on the next turn-start.
        next.started = true;
        if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
        next.markTimeMs = eventTimeMs;
        this.collecting = next;
        consumedNext = true;
      }
    }
    if (!consumedNext) {
      // Local-terminal input (or a queued_command whose prompt didn't
      // match any pending Lark fingerprint). Synthesise a started turn
      // ahead of any unstarted Lark turn so chronological order matches
      // transcript order at emit time.
      const localTurn: BridgePendingTurn = {
        turnId: `local-${uuid}`,
        started: true,
        isLocal: true,
        userUuid: uuid,
        assistantUuids: [],
        sourceJsonlPath,
        markTimeMs: eventTimeMs,
      };
      const insertAt = this.queue.findIndex(t => !t.started);
      if (insertAt === -1) this.queue.push(localTurn);
      else this.queue.splice(insertAt, 0, localTurn);
      this.collecting = localTurn;
    }
  }

  /** Pop FIFO any leading turn that's started and normally has visible text.
   *  The worker calls with terminalBoundary=true only after the CLI's prompt
   *  detector reports idle; that explicit boundary also releases an empty or
   *  tool-only turn so durable delivery can settle without fabricating output.
   *  Returns the popped turns in order; the caller is responsible for
   *  rebuilding the optional visible payload from the assistant uuids. */
  drainEmittable(opts: {
    terminalBoundary?: boolean;
    /** Pop only turns carrying an authoritative transcript boundary. */
    explicitTerminalOnly?: boolean;
    /** Screen idle may release ordinary fallback turns, but never a durable
     * receiver turn whose receipt depends on an exact terminal contract. */
    requireExplicitTerminalForDurable?: boolean;
  } = {}): BridgePendingTurn[] {
    const out: BridgePendingTurn[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.started) break;
      if (opts.explicitTerminalOnly && !head.terminalObserved) break;
      if (opts.requireExplicitTerminalForDurable
        && head.dispatchAttempt !== undefined
        && !head.terminalObserved) break;
      if (!opts.terminalBoundary && !head.terminalObserved && head.assistantUuids.length === 0) break;
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
