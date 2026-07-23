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
 *       * terminal event → the currently-collecting turn closes with
 *         finalText set; an abort uses empty text plus an ambiguous terminal
 *         outcome so durable delivery settles without inventing a reply.
 *   - drainEmittable() — pop FIFO any leading turn that is started AND has
 *     reached either terminal edge.
 */
import { makeFingerprint, normaliseForFingerprint } from './bridge-turn-queue.js';
import type { CodexBridgeEvent } from './codex-transcript.js';

const UNMATCHED_REPLAY_WINDOW_MS = 5_000;
const MAX_BUFFERED_UNMATCHED_EVENTS = 20;
/** A verified submit may be parked in a type-ahead queue before its transcript
 *  user event is written. Keep that hand-off busy for a bounded interval: long
 *  enough for the active turn to finish and dequeue it, but never forever if
 *  the CLI accepted the keypress without producing a structured event. */
export const STRUCTURED_SUBMIT_START_GRACE_MS = 20_000;
/** Maximum time an unconfirmed worker mark may remain at the attribution
 *  head after the adapter write/verification path stops. This lease never
 *  contributes to lifecycle busy: it exists only so a late transcript user
 *  event can still claim the mark without allowing a silent write to wedge
 *  every later turn forever. */
export const STRUCTURED_UNCONFIRMED_ATTRIBUTION_GRACE_MS = 20_000;
/** Maximum time a worker may wait for an adapter/history verification call.
 *  This covers Codex/CoCo's in-band polling plus the 20s deferred recheck,
 *  while remaining bounded if an adapter promise or recheck is stranded. */
export const STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS = 30_000;

export interface CodexPendingTurn {
  turnId: string;
  dispatchAttempt?: number;
  started: boolean;
  contentFingerprint?: string;
  /** Wall-clock millis when mark() was called. The emit gate uses this as
   *  the lower bound of the "did `botmux send` happen for this turn?"
   *  window. Optional only for legacy / test-injected turns. */
  markTimeMs?: number;
  /** Wall-clock millis when an authoritative adapter/history check confirmed
   *  the submit. Unverified writes deliberately leave this unset. */
  submitConfirmedAtMs?: number;
  /** Wall-clock millis anchoring the bounded attribution-only lease for an
   *  unconfirmed mark. Unlike verification/confirmation leases, this never
   *  gates screen-ready or reports the CLI busy. */
  unconfirmedAttributionStartedAtMs?: number;
  /** Wall-clock millis when worker-side authoritative submit verification
   *  began. This closes the race where screen-ready arrives while writeInput
   *  is still polling history, before it can return `submitted: true`. */
  submitVerificationStartedAtMs?: number;
  /** Set once an assistant_final event closes this turn. */
  finalText?: string;
  /** Explicit transcript terminal semantics. Undefined keeps the historical
   *  assistant-final => completed behaviour. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  /** Set when this turn was synthesised from a user_message that didn't
   *  match any pending Lark fingerprint. Adopt-only. The worker emit path
   *  formats these with both userText and finalText under a "终端本地对话"
   *  header — same rationale as Claude's BridgeTurnQueue local turns. */
  isLocal?: boolean;
  /** For local turns: the user's typed text, surfaced alongside the
   *  assistant reply so the Lark thread sees both sides of the exchange. */
  userText?: string;
  sourceSessionId?: string;
  /** True when the turn was delivered via Codex RPC (turn/start) and the
   *  app-server has acknowledged it. RPC turns have no local transcript to
   *  ingest, so they can never reach the started state; this flag keeps the
   *  lifecycle gate asserted for the full server-side execution instead of
   *  letting the bounded 20s confirmation lease expire mid-turn (which would
   *  falsely release idle and prune a still-running turn). Cleared by the
   *  terminal edge or an explicit stop. */
  rpcActive?: boolean;
}

export class CodexBridgeQueue {
  private seen = new Set<string>();
  private queue: CodexPendingTurn[] = [];
  private collecting: CodexPendingTurn | null = null;
  private localTurnsEnabled = false;
  private bufferedUnmatched: CodexBridgeEvent[] = [];
  private lastClosedAssistantFinalTimeMs: number | undefined;
  /** Lower bound (ms) for synthesising local turns — protects against a
   *  fresh-empty attach replaying historical iTerm conversation as
   *  "live" local input. Typically set to the moment adopt was wired up. */
  private localLowerBoundMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Register events as historical without producing pending-turn side
   *  effects. Used at attach time when resume mode wants to swallow prior
   *  conversation as already-processed. */
  absorb(events: CodexBridgeEvent[]): void {
    for (const ev of events) this.seen.add(ev.uuid);
  }

  /** Toggle adopt-mode local-turn synthesis. `lowerBoundMs` (typically
   *  Date.now() at adopt-time) protects against a fresh-empty attach
   *  feeding historical user_messages back as "live" local turns. */
  setLocalTurns(enabled: boolean, lowerBoundMs: number = this.now()): void {
    this.localTurnsEnabled = enabled;
    this.localLowerBoundMs = lowerBoundMs;
    if (enabled) this.bufferedUnmatched = [];
  }

  /** Push a pending Lark turn anchored to the message text. The fingerprint
   *  derived from `message` is what the upcoming `user` event must contain
   *  to start this turn. Pre-path-known marking is allowed: the worker can
   *  call this before late-attach has located the rollout file, and the
   *  ingest call after attach will still match correctly. */
  mark(turnId: string, message: string, markTimeMs: number = this.now(), dispatchAttempt?: number): void {
    this.queue.push({
      turnId,
      dispatchAttempt,
      started: false,
      contentFingerprint: makeFingerprint(message),
      markTimeMs,
      unconfirmedAttributionStartedAtMs: markTimeMs,
    });
    this.replayBufferedUnmatched(markTimeMs);
  }

  /** Drop all pending turns. Used when the worker decides it can't reliably
   *  attribute future events (e.g. a teardown). */
  clearPending(): CodexPendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    this.bufferedUnmatched = [];
    this.lastClosedAssistantFinalTimeMs = undefined;
    return dropped;
  }

  /** Remove one exact worker delivery attempt. Submit-confirmation cleanup is
   *  pre-start-only by default: once the transcript has started a turn, only a
   *  structured terminal may retire it. An authoritative failed/ambiguous
   *  terminal may opt into removing a started attempt via `allowStarted`.
   *  Matching dispatchAttempt keeps a replay of the same turnId isolated from
   *  the retired delivery attempt. */
  dropPendingTurn(
    turnId: string,
    dispatchAttempt?: number,
    allowStarted = false,
  ): CodexPendingTurn | null {
    const index = this.queue.findIndex(turn =>
      turn.turnId === turnId
      && turn.dispatchAttempt === dispatchAttempt
      && (allowStarted || !turn.started),
    );
    if (index < 0) return null;
    const [dropped] = this.queue.splice(index, 1);
    if (this.collecting === dropped) this.collecting = null;
    if (allowStarted) this.refreshNextPreStartLease();
    // A later turn's user event can already be buffered behind this failed
    // head mark: ingestOne only matches the first unstarted fingerprint. Once
    // the failed head is gone, replay recent events against the new head or it
    // can remain unstarted forever and wedge fallback delivery.
    const next = this.queue.find(turn => !turn.started);
    if (next?.markTimeMs !== undefined) this.replayBufferedUnmatched(next.markTimeMs);
    return dropped ?? null;
  }

  /** Remove expired pre-start queue heads that never reached transcript
   *  start, whether positively confirmed or only retained for attribution.
   *  Only the first unresolved fingerprint(s) are eligible, and never
   *  while an earlier started turn is still running: that predecessor's final
   *  is the dequeue boundary that refreshes the next legitimate type-ahead
   *  lease. Dropping a stale head replays buffered events immediately, so a
   *  later real turn can become started instead of remaining hidden behind a
   *  dead fingerprint. */
  pruneExpiredPreStartHeads(nowMs: number = this.now()): CodexPendingTurn[] {
    const dropped: CodexPendingTurn[] = [];
    for (;;) {
      // A long-running predecessor legitimately keeps later confirmed input in
      // the CLI's type-ahead queue. Its assistant_final refreshes the next head
      // from local observation time, so expiring anything before that boundary
      // would drop valid queued work.
      if (this.queue.some(turn => turn.started && turn.finalText === undefined)) break;

      const head = this.queue.find(turn => !turn.started && turn.finalText === undefined);
      if (!head) break;

      // An RPC turn is running server-side with no local transcript to ingest.
      // It can never reach started, so the bounded lease must NOT be used to
      // prune it — that would falsely release idle while the app-server is still
      // executing. Keep it until the terminal edge or explicit stop.
      if (head.rpcActive) break;

      // An authoritative adapter/history check can legitimately outlive the
      // shorter attribution lease. Do not prune under that in-flight await;
      // once it finishes, finishSubmitVerification refreshes attribution from
      // local observation time, and once this bounded verification lease
      // expires the old mark becomes eligible again.
      const verificationActive = head.submitVerificationStartedAtMs !== undefined
        && nowMs - head.submitVerificationStartedAtMs <= STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS;
      if (verificationActive) break;

      const leaseStartedAtMs = head.submitConfirmedAtMs
        ?? head.unconfirmedAttributionStartedAtMs;
      if (leaseStartedAtMs === undefined) break;
      const leaseGraceMs = head.submitConfirmedAtMs !== undefined
        ? STRUCTURED_SUBMIT_START_GRACE_MS
        : STRUCTURED_UNCONFIRMED_ATTRIBUTION_GRACE_MS;
      if (nowMs - leaseStartedAtMs <= leaseGraceMs) break;

      const removed = this.dropPendingTurn(head.turnId, head.dispatchAttempt);
      if (!removed) break;
      dropped.push(removed);
      // dropPendingTurn replays buffered user/final events. If that starts the
      // next real turn, the started-turn guard above stops the loop.
    }
    return dropped;
  }

  /** Record positive submit evidence from an adapter/history check. The turn
   *  can still be waiting in the CLI's type-ahead queue, so this starts a
   *  bounded hand-off lease until its transcript user event appears. */
  confirmPendingTurn(
    turnId: string,
    confirmedAtMs: number = this.now(),
    dispatchAttempt?: number,
  ): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText === undefined);
    if (!turn) return false;
    turn.submitVerificationStartedAtMs = undefined;
    turn.unconfirmedAttributionStartedAtMs = undefined;
    turn.submitConfirmedAtMs = confirmedAtMs;
    return true;
  }

  /** Mark a turn as actively running server-side via Codex RPC. The app-server
   *  ack for turn/start is authoritative confirmation that execution has begun,
   *  but no local transcript event will follow to flip started. This flag keeps
   *  the lifecycle gate asserted and protects the turn from lease expiry pruning
   *  until the terminal edge (or an explicit stop) clears it. */
  markRpcActive(turnId: string, dispatchAttempt?: number): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText === undefined);
    if (!turn) return false;
    turn.rpcActive = true;
    turn.submitVerificationStartedAtMs = undefined;
    turn.unconfirmedAttributionStartedAtMs = undefined;
    turn.submitConfirmedAtMs = undefined;
    return true;
  }

  /** Clear the server-side active flag when an RPC turn reaches a terminal edge
   *  or is otherwise retired. Without this, a completed RPC turn would keep the
   *  lifecycle gate asserted forever (permanent false-busy). */
  stopRpcActive(turnId: string, dispatchAttempt?: number): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt);
    if (!turn || !turn.rpcActive) return false;
    turn.rpcActive = undefined;
    return true;
  }

  /** Start bounded adapter/history verification before awaiting writeInput. */
  beginSubmitVerification(
    turnId: string,
    startedAtMs: number = this.now(),
    dispatchAttempt?: number,
  ): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText === undefined);
    if (!turn) return false;
    turn.submitVerificationStartedAtMs = startedAtMs;
    return true;
  }

  /** Finish verification without positive submit evidence. A bare mark remains
   *  available for transcript attribution but no longer gates screen-ready. */
  finishSubmitVerification(
    turnId: string,
    finishedAtMs: number = this.now(),
    dispatchAttempt?: number,
  ): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt);
    if (!turn || turn.submitVerificationStartedAtMs === undefined) return false;
    turn.submitVerificationStartedAtMs = undefined;
    if (!turn.started && turn.submitConfirmedAtMs === undefined) {
      turn.unconfirmedAttributionStartedAtMs = finishedAtMs;
    }
    return true;
  }

  /** Exact-attempt existence check for deferred callbacks. A replay reuses
   *  turnId with a higher dispatchAttempt, so an old timer must treat that as
   *  a missing target rather than mutating the new delivery generation. */
  hasPendingTurn(turnId: string, dispatchAttempt?: number): boolean {
    return this.queue.some(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText === undefined);
  }

  /** True when buffered transcript replay has already closed this exact turn
   *  before its RPC turn/start continuation installs rpcActive. */
  hasTerminalTurn(turnId: string, dispatchAttempt?: number): boolean {
    return this.queue.some(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText !== undefined);
  }

  /** True while the transcript proves a turn is running, or while a verified
   *  submit is in the bounded pre-start hand-off window. A bare worker mark is
   *  never authoritative, preventing a dropped Enter from causing permanent
   *  false-busy. */
  hasBlockingTurn(nowMs: number = this.now()): boolean {
    return this.queue.some(turn => {
      if (turn.finalText !== undefined) return false;
      if (turn.started) return true;
      if (turn.rpcActive) return true;
      const confirmed = turn.submitConfirmedAtMs !== undefined
        && nowMs - turn.submitConfirmedAtMs <= STRUCTURED_SUBMIT_START_GRACE_MS;
      const verifying = turn.submitVerificationStartedAtMs !== undefined
        && nowMs - turn.submitVerificationStartedAtMs <= STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS;
      return confirmed || verifying;
    });
  }

  /** Remaining bounded pre-start verification/confirmation lease. The worker
   *  uses this to re-drive a previously rejected ready signal once every active
   *  lease expires. Started turns return undefined because their eventual
   *  assistant_final is the authoritative re-drive. */
  preStartLeaseRemainingMs(nowMs: number = this.now()): number | undefined {
    if (this.queue.some(turn => (turn.started || turn.rpcActive) && turn.finalText === undefined)) return undefined;
    const activeRemaining = this.queue.flatMap(candidate => {
      if (candidate.started || candidate.finalText !== undefined) return [];
      const leases: number[] = [];
      if (candidate.submitConfirmedAtMs !== undefined) {
        leases.push(STRUCTURED_SUBMIT_START_GRACE_MS - (nowMs - candidate.submitConfirmedAtMs));
      }
      if (candidate.submitVerificationStartedAtMs !== undefined) {
        leases.push(STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS - (nowMs - candidate.submitVerificationStartedAtMs));
      }
      return leases.filter(remaining => remaining >= 0);
    });
    return activeRemaining.length > 0 ? Math.max(...activeRemaining) : undefined;
  }
  /** Process newly-appended events. Idempotent on uuid: events with seen
   *  uuids are skipped, so callers can replay safely. */
  ingest(events: CodexBridgeEvent[]): void {
    for (const ev of events) {
      if (!ev.uuid || this.seen.has(ev.uuid)) continue;
      this.seen.add(ev.uuid);
      this.ingestOne(ev, true);
    }
  }

  private replayBufferedUnmatched(markTimeMs: number): void {
    if (this.bufferedUnmatched.length === 0) return;
    const replay = this.bufferedUnmatched.filter(ev => ev.timestampMs >= markTimeMs - UNMATCHED_REPLAY_WINDOW_MS);
    this.bufferedUnmatched = [];
    // Keep still-unmatched events buffered: more than one failed head can sit
    // ahead of the successful turn. Each drop gets another chance to replay
    // the same bounded event set against the new head.
    for (const ev of replay) this.ingestOne(ev, true);
  }

  private rememberUnmatched(ev: CodexBridgeEvent): void {
    this.bufferedUnmatched.push(ev);
    if (this.bufferedUnmatched.length > MAX_BUFFERED_UNMATCHED_EVENTS) {
      this.bufferedUnmatched.splice(0, this.bufferedUnmatched.length - MAX_BUFFERED_UNMATCHED_EVENTS);
    }
  }

  /** Refresh the next queued submit from the locally-observed terminal edge.
   *  External transcript clocks may be skewed, so lease boundedness must use
   *  this process's clock for both successful and aborted predecessors. */
  private refreshNextPreStartLease(): void {
    const nextPending = this.queue.find(turn => !turn.started
      && turn.finalText === undefined);
    if (!nextPending) return;
    // RPC turns keep their own rpcActive flag for lifecycle gating; do not
    // overwrite it with a bounded confirmation/attribution lease.
    if (nextPending.rpcActive) return;
    const observedAtMs = this.now();
    if (nextPending.submitConfirmedAtMs !== undefined) {
      nextPending.submitConfirmedAtMs = observedAtMs;
    } else {
      nextPending.unconfirmedAttributionStartedAtMs = observedAtMs;
    }
  }

  private ingestOne(ev: CodexBridgeEvent, bufferUnmatched: boolean): void {
    if (ev.kind === 'user') {
      // First decide whether this user event is a REAL turn-start: either it
      // matches the head pending Lark turn's fingerprint (and isn't tooOld),
      // or — in adopt mode — it synthesises a local turn. Both the HOL-drop
      // and the actual start key off this decision.
      const next = this.queue.find(t => !t.started);
      const tooOld = !!next && next.markTimeMs !== undefined && ev.timestampMs < next.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS;
      let fingerprintOk = true;
      if (next?.contentFingerprint) {
        fingerprintOk = normaliseForFingerprint(ev.text).includes(next.contentFingerprint);
      }
      const willStartNext = !!next && !tooOld && fingerprintOk;
      const willSynthLocal = !willStartNext && this.localTurnsEnabled && ev.timestampMs >= this.localLowerBoundMs - UNMATCHED_REPLAY_WINDOW_MS;

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
        next!.submitVerificationStartedAtMs = undefined;
        next!.unconfirmedAttributionStartedAtMs = undefined;
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
        //
        // Hermes is the exception: its SQLite message timestamps can be
        // committed near turn completion, after in-turn `botmux send` markers
        // have already landed. Preserve the original worker mark so those
        // markers stay inside the bridge-fallback suppression window. For
        // adjacent queued Hermes turns, still advance the next turn to at
        // least the previous assistant final so batch-drain boundaries don't
        // collapse to back-to-back enqueue times.
        if (next!.markTimeMs === undefined) {
          next!.markTimeMs = ev.preserveMarkTimeMs === true && this.lastClosedAssistantFinalTimeMs !== undefined
            ? this.lastClosedAssistantFinalTimeMs
            : ev.timestampMs;
        } else if (ev.preserveMarkTimeMs === true) {
          if (this.lastClosedAssistantFinalTimeMs !== undefined) {
            next!.markTimeMs = Math.max(next!.markTimeMs, this.lastClosedAssistantFinalTimeMs);
          }
        } else {
          next!.markTimeMs = Math.max(next!.markTimeMs, ev.timestampMs);
        }
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
      } else if (bufferUnmatched && !this.localTurnsEnabled) {
        // Cursor can write the Lark/user line to JSONL before the daemon IPC
        // that marks the turn reaches this worker. Keep a tiny recent buffer
        // so mark() can replay it instead of losing the line to `seen`.
        this.rememberUnmatched(ev);
      }
    } else if (ev.kind === 'assistant_final') {
      if (this.collecting) {
        if (this.collecting.sourceSessionId && ev.sourceSessionId && this.collecting.sourceSessionId !== ev.sourceSessionId) return;
        this.collecting.finalText = ev.text;
        this.collecting.terminalStatus = ev.terminalStatus;
        this.collecting.terminalErrorCode = ev.terminalErrorCode;
        this.lastClosedAssistantFinalTimeMs = ev.timestampMs;
        this.collecting = null;
        // CoCo-style type-ahead writes the next user event only after this
        // final dequeues it. Refresh the next turn's pre-start lease at that
        // hand-off boundary instead of letting either its confirmed lease or
        // attribution-only lease expire while the predecessor was legitimately
        // running.
        this.refreshNextPreStartLease();
      } else if (bufferUnmatched && !this.localTurnsEnabled) {
        this.rememberUnmatched(ev);
      }
    } else if (ev.kind === 'turn_aborted') {
      if (!this.collecting) {
        if (bufferUnmatched && !this.localTurnsEnabled) this.rememberUnmatched(ev);
        return;
      }
      if (this.collecting.sourceSessionId && ev.sourceSessionId && this.collecting.sourceSessionId !== ev.sourceSessionId) return;
      // Interrupted Codex turns have no assistant_final. Close with empty text
      // so the worker skips final_output but still publishes the authoritative
      // exact-attempt turn_terminal required by reliable durable delivery.
      // Side effects may already have happened, so mirror TRAE-X and classify
      // an otherwise-untyped abort as ambiguous rather than completed/failed.
      this.collecting.finalText = '';
      this.collecting.terminalStatus = ev.terminalStatus ?? 'ambiguous';
      this.collecting.terminalErrorCode = ev.terminalErrorCode ?? 'structured_turn_aborted';
      this.collecting = null;
      this.lastClosedAssistantFinalTimeMs = ev.timestampMs;
      this.refreshNextPreStartLease();
    }
  }

  /** Pop FIFO any leading turn that is started AND observed a terminal edge.
   *  Empty final text closes a durable turn without producing final_output. */
  drainEmittable(): CodexPendingTurn[] {
    const out: CodexPendingTurn[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.started || head.finalText === undefined) break;
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

/** Explicit mutation boundary for lease expiry. Pruning can replay a buffered
 *  successor user+final pair, so callers must drain/emit in the same call
 *  stack; keeping that invariant here prevents a status/query path from
 *  silently creating an unconsumed completion. */
export function pruneExpiredPreStartHeadsAndEmit(
  queue: CodexBridgeQueue,
  emitReady: () => void,
  nowMs?: number,
  /** Settle exact durable attempts before a replayed successor is emitted.
   *  The queue removal can expose buffered successor user/final events, so
   *  running this after emitReady would publish N+1 ahead of N's terminal. */
  onDropped?: (dropped: readonly CodexPendingTurn[]) => void,
): CodexPendingTurn[] {
  const dropped = queue.pruneExpiredPreStartHeads(nowMs);
  if (dropped.length > 0) {
    onDropped?.(dropped);
    emitReady();
  }
  return dropped;
}
