/**
 * Codex bridge fallback's pending-turn queue.
 *
 * Two operating modes via `setLocalTurns()`:
 *
 *   - **non-adopt** (default): worker owns the PTY and the only legitimate
 *     user input source is Lark. user_message events that don't match a
 *     pending fingerprint are history (resume / late-attach) and get
 *     silently dropped. Synthesising local turns here would replay
 *     yesterday's prompts to the Lark thread.
 *
 *   - **adopt**: Codex is the user's externally-running process; the user
 *     can type directly into the iTerm pane (or via Lark). Both should
 *     reach the Lark thread. user_message events that don't match a
 *     pending Lark fingerprint AND happen after `localLowerBoundMs - 5s`
 *     synthesise a local turn — formatted by the worker as
 *     "🖥️ 终端本地对话".
 *
 * Attribution rule:
 *   - mark()           — push a pending turn anchored to Lark fingerprint.
 *   - ingest(events)   —
 *       * 'user' event whose text matches the head pending turn's
 *         fingerprint → that turn becomes 'started' (collecting).
 *       * 'user' event with no match: dropped, OR (adopt-only) synthesised
 *         as a started local turn ahead of any unstarted Lark turn so
 *         emit ordering reflects when the event landed.
 *       * 'assistant_final' event → the currently-collecting turn closes
 *         with finalText set; eligible for emit on the next drain.
 *   - drainEmittable() — pop FIFO any leading turn that is started AND
 *     has finalText.
 */
import { makeFingerprint, normaliseForFingerprint } from './bridge-turn-queue.js';
import type { CodexBridgeEvent } from './codex-transcript.js';

export interface CodexPendingTurn {
  turnId: string;
  started: boolean;
  contentFingerprint?: string;
  /** Wall-clock millis when mark() was called. The emit gate uses this as
   *  the lower bound of the "did `botmux send` happen for this turn?"
   *  window. Optional only for legacy / test-injected turns. */
  markTimeMs?: number;
  /** Set once an assistant_final event closes this turn. */
  finalText?: string;
  /** Set when this turn was synthesised from a user_message that didn't
   *  match any pending Lark fingerprint. Adopt-only. The worker emit path
   *  formats these with both userText and finalText under a "终端本地对话"
   *  header — same rationale as Claude's BridgeTurnQueue local turns. */
  isLocal?: boolean;
  /** For local turns: the user's typed text, surfaced alongside the
   *  assistant reply so the Lark thread sees both sides of the exchange. */
  userText?: string;
}

export class CodexBridgeQueue {
  private seen = new Set<string>();
  private queue: CodexPendingTurn[] = [];
  private collecting: CodexPendingTurn | null = null;
  private localTurnsEnabled = false;
  /** Lower bound (ms) for synthesising local turns — protects against a
   *  fresh-empty attach replaying historical iTerm conversation as
   *  "live" local input. Typically set to the moment adopt was wired up. */
  private localLowerBoundMs = 0;

  /** Register events as historical without producing pending-turn side
   *  effects. Used at attach time when resume mode wants to swallow prior
   *  conversation as already-processed. */
  absorb(events: CodexBridgeEvent[]): void {
    for (const ev of events) this.seen.add(ev.uuid);
  }

  /** Toggle adopt-mode local-turn synthesis. `lowerBoundMs` (typically
   *  Date.now() at adopt-time) protects against a fresh-empty attach
   *  feeding historical user_messages back as "live" local turns. */
  setLocalTurns(enabled: boolean, lowerBoundMs: number = Date.now()): void {
    this.localTurnsEnabled = enabled;
    this.localLowerBoundMs = lowerBoundMs;
  }

  /** Push a pending Lark turn anchored to the message text. The fingerprint
   *  derived from `message` is what the upcoming `user` event must contain
   *  to start this turn. Pre-path-known marking is allowed: the worker can
   *  call this before late-attach has located the rollout file, and the
   *  ingest call after attach will still match correctly. */
  mark(turnId: string, message: string, markTimeMs: number = Date.now()): void {
    this.queue.push({
      turnId,
      started: false,
      contentFingerprint: makeFingerprint(message),
      markTimeMs,
    });
  }

  /** Drop all pending turns. Used when the worker decides it can't reliably
   *  attribute future events (e.g. a teardown). */
  clearPending(): CodexPendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    return dropped;
  }

  /** Process newly-appended events. Idempotent on uuid: events with seen
   *  uuids are skipped, so callers can replay safely. */
  ingest(events: CodexBridgeEvent[]): void {
    for (const ev of events) {
      if (!ev.uuid || this.seen.has(ev.uuid)) continue;
      this.seen.add(ev.uuid);
      if (ev.kind === 'user') {
        const next = this.queue.find(t => !t.started);
        let consumedNext = false;
        if (next) {
          const tooOld = next.markTimeMs !== undefined && ev.timestampMs < next.markTimeMs - 5_000;
          let fingerprintOk = true;
          if (next.contentFingerprint) {
            const userText = normaliseForFingerprint(ev.text);
            fingerprintOk = userText.includes(next.contentFingerprint);
          }
          if (!tooOld && fingerprintOk) {
            next.started = true;
            this.collecting = next;
            consumedNext = true;
          }
        }
        if (!consumedNext && this.localTurnsEnabled && ev.timestampMs >= this.localLowerBoundMs - 5_000) {
          // Adopt mode local input: user typed in iTerm, no Lark
          // fingerprint match. Synthesise a local turn so the assistant
          // reply still reaches Lark. Insert AHEAD of any unstarted Lark
          // turn so emit order matches when the event hit the transcript.
          const localTurn: CodexPendingTurn = {
            turnId: `codex-local-${ev.uuid}`,
            started: true,
            isLocal: true,
            userText: ev.text,
            markTimeMs: ev.timestampMs,
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(localTurn);
          else this.queue.splice(insertAt, 0, localTurn);
          this.collecting = localTurn;
        }
      } else if (ev.kind === 'assistant_final') {
        if (this.collecting) {
          this.collecting.finalText = ev.text;
          this.collecting = null;
        }
      }
    }
  }

  /** Pop FIFO any leading turn that is started AND has finalText. */
  drainEmittable(): CodexPendingTurn[] {
    const out: CodexPendingTurn[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.started || !head.finalText) break;
      this.queue.shift();
      if (this.collecting === head) this.collecting = null;
      out.push(head);
    }
    return out;
  }

  size(): number {
    return this.queue.length;
  }

  /** Test helper — peek the queue without mutating. */
  peek(): readonly CodexPendingTurn[] {
    return this.queue;
  }
}
