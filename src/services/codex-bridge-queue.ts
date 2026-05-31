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
 *       * 'user' event: first classify it — does it START the head pending
 *         turn (fingerprint match, not tooOld) or SYNTHESISE a local turn
 *         (adopt-only)? Only a 'user' event that does one of those triggers
 *         HOL-block-drop: if a turn is still collecting with no finalText,
 *         discard it. Codex 0.134.0 type-ahead is an active-turn STEER: a
 *         queued message typed while a tool-running turn is in flight gets
 *         pulled into that SAME turn, which emits one merged final (rollout:
 *         user1 → user2 → assistant_final). The earlier turn never gets its
 *         own final, so without this drop it sits at the queue head forever
 *         and wedges drainEmittable(). A 'user' event that neither matches a
 *         fingerprint nor synthesises a local turn (e.g. the startup
 *         <environment_context>, or replayed history) is IGNORED and does NOT
 *         drop the collecting turn — keying HOL-drop off the turn-start
 *         decision reuses its tooOld/fingerprint freshness as one invariant.
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
  sourceSessionId?: string;
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
        // First decide whether this user event is a REAL turn-start: either it
        // matches the head pending Lark turn's fingerprint (and isn't tooOld),
        // or — in adopt mode — it synthesises a local turn. Both the HOL-drop
        // and the actual start key off this decision.
        const next = this.queue.find(t => !t.started);
        const tooOld = !!next && next.markTimeMs !== undefined && ev.timestampMs < next.markTimeMs - 5_000;
        let fingerprintOk = true;
        if (next?.contentFingerprint) {
          fingerprintOk = normaliseForFingerprint(ev.text).includes(next.contentFingerprint);
        }
        const willStartNext = !!next && !tooOld && fingerprintOk;
        const willSynthLocal = !willStartNext && this.localTurnsEnabled && ev.timestampMs >= this.localLowerBoundMs - 5_000;

        // HOL-block drop (codex 0.134.0 active-turn steer): when a real new
        // turn-start arrives while a turn is still collecting with no finalText,
        // codex steered/merged this input into the active turn — it processes
        // both as ONE turn and emits a single combined assistant_final, so the
        // collecting turn will NEVER get its own final. Drop it now, otherwise
        // it sits at the queue head forever and `drainEmittable()` wedges
        // (started, no finalText → breaks the FIFO scan). Gating on "is a real
        // turn-start" reuses the tooOld/fingerprint freshness already proven for
        // turn-start, so the same 5s-skew invariant applies to both: a replayed
        // historical user event is tooOld → won't start a turn → won't evict a
        // live collecting turn; and a non-matching stray user event (non-adopt)
        // is ignored rather than treated as a turn boundary. Mirrors Claude's
        // BridgeTurnQueue.handleTurnStart HOL drop (which keys off "no assistant
        // text yet" — the streaming-transcript equivalent of "no finalText").
        if ((willStartNext || willSynthLocal) && this.collecting && this.collecting.finalText === undefined) {
          const idx = this.queue.indexOf(this.collecting);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.collecting = null;
        }

        if (willStartNext) {
          next!.started = true;
          next!.sourceSessionId = ev.sourceSessionId;
          // Anchor the bridge-fallback suppression window to when the turn
          // ACTUALLY started processing (the transcript user event's
          // timestamp), not when the worker marked it. With type-ahead the
          // worker marks turn N+1 immediately after turn N (both at flush
          // time), but CoCo only writes turn N+1's user event when it
          // dequeues it — i.e. after turn N's assistant_final. Without this
          // override the [markTimeMs, nextTurn.markTimeMs) windows are all
          // bunched at flush time, so turn N's own `botmux send` (which
          // lands seconds later, after the model replies) falls OUTSIDE its
          // own window and the fallback isn't suppressed → duplicate emit.
          // `max` (not bare assignment) keeps the lower bound from ever
          // moving backwards: a dequeue event can only be at or after the
          // mark, and the -5s tooOld tolerance must not be able to widen the
          // window into a previous turn's sends. Mirrors what Claude's
          // BridgeTurnQueue.handleTurnStart does with eventTimeMs.
          if (next!.markTimeMs === undefined) next!.markTimeMs = ev.timestampMs;
          else next!.markTimeMs = Math.max(next!.markTimeMs, ev.timestampMs);
          this.collecting = next!;
        } else if (willSynthLocal) {
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
            sourceSessionId: ev.sourceSessionId,
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(localTurn);
          else this.queue.splice(insertAt, 0, localTurn);
          this.collecting = localTurn;
        }
      } else if (ev.kind === 'assistant_final') {
        if (this.collecting) {
          if (this.collecting.sourceSessionId && ev.sourceSessionId && this.collecting.sourceSessionId !== ev.sourceSessionId) continue;
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
