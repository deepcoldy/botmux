/**
 * Codex bridge fallback's pending-turn queue.
 *
 * Lighter than Claude's BridgeTurnQueue because Codex's bridge has no /adopt
 * surface and no local-terminal dual-write: the worker is the only writer,
 * so any user_message in the rollout that doesn't match a pending Lark turn
 * by fingerprint is either history (resume / late-attach) or somebody else's
 * session — either way, ignore it. The Claude queue's "synthesise a local
 * turn and forward to Lark" branch would just spam the thread here.
 *
 * Attribution rule:
 *   - mark()           — push a pending turn entry (state: not started),
 *                        anchored to a fingerprint of the Lark message.
 *   - ingest(events)   —
 *       * 'user' event whose text matches the head pending turn's
 *         fingerprint → that turn becomes 'started' (collecting). User
 *         events with no fingerprint match are silently dropped (history
 *         or local input).
 *       * 'assistant_final' event → the currently-collecting turn closes
 *         with finalText set; eligible for emit on the next drain.
 *   - drainEmittable() — pop FIFO any leading turn that is started AND
 *     has finalText. Started turns that don't yet have finalText (model
 *     mid-turn at idle wakeup, e.g. between idle ticks) stay queued.
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
}

export class CodexBridgeQueue {
  private seen = new Set<string>();
  private queue: CodexPendingTurn[] = [];
  private collecting: CodexPendingTurn | null = null;

  /** Register events as historical without producing pending-turn side
   *  effects. Used at attach time when resume mode wants to swallow prior
   *  conversation as already-processed. */
  absorb(events: CodexBridgeEvent[]): void {
    for (const ev of events) this.seen.add(ev.uuid);
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
        if (!next) continue;
        // Time lower bound: a user_message older than the turn's mark
        // (minus a small skew tolerance) cannot have been triggered by
        // this Lark turn. Without this, fresh-empty attach over a long
        // resume rollout could let a historical prompt with the same
        // fingerprint start the current pending turn and emit yesterday's
        // assistant reply. 5s skew absorbs clock drift between worker
        // mark() and Codex's transcript timestamp.
        if (next.markTimeMs !== undefined && ev.timestampMs < next.markTimeMs - 5_000) continue;
        if (next.contentFingerprint) {
          const userText = normaliseForFingerprint(ev.text);
          if (!userText.includes(next.contentFingerprint)) continue;
        }
        next.started = true;
        this.collecting = next;
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
