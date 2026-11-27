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
 *         turn (fingerprint match, not tooOld), START a later pending turn
 *         whose whole input it is (adopt-only, passing heads that never
 *         reached the CLI), or SYNTHESISE a local turn (adopt-only)? Only a
 *         'user' event that does one of those triggers
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
import type { CodexBridgeEvent, CodexCotEntry } from './codex-transcript.js';
import { createHash } from 'node:crypto';

function exactInputHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

/** Digest of a mark's whole normalised input; see CodexPendingTurn.wholeInputHash. */
export function wholeInputHash(text: string): string {
  return createHash('sha256').update(normaliseForFingerprint(text), 'utf8').digest('hex');
}

const UNMATCHED_REPLAY_WINDOW_MS = 5_000;
const MAX_BUFFERED_UNMATCHED_EVENTS = 20;
const CORRELATION_TRAILER_RE = / <botmux_routing> botmux_input_id: [0-9a-f]{32} <\/botmux_routing>$/;
/** Bound busy-screen lease refresh for Cursor's delayed transcript. A stuck
 *  busy marker leaves only the ordinary attribution lease after this age. */
export const CURSOR_BUSY_REFRESH_MAX_MS = 120_000;
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
/** Maximum time a task_started-only claim may wait for its fingerprinted user
 *  record. Real Codex rollouts have shown delays just under ten minutes, but
 *  this is an empirical bound rather than a provider guarantee: a missing
 *  record must not make an uncorroborated claim permanently busy. */
export const STRUCTURED_TASK_START_CORROBORATION_GRACE_MS = 10 * 60_000;
/** Maximum time a worker may wait for an adapter/history verification call.
 *  This covers Codex/CoCo's in-band polling plus the 20s deferred recheck,
 *  while remaining bounded if an adapter promise or recheck is stranded. */
export const STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS = 30_000;
/** A restored passed mark has no live submit-verification flag, but its own
 * rollout record may still be appended just after attach. Keep a short revival
 * window that does not participate in stale-restored lifecycle classification. */
export const STRUCTURED_RESTORED_PASS_REVIVIAL_GRACE_MS = 30_000;

export interface CodexTurnStartEvidence {
  /** True only when the corroborated transcript user record matches this turn's
   *  entire normalised input (or driver-proved exact alias), never a 30-char
   *  prefix-only match or an uncorroborated provisional task_started claim. */
  exactUserInputMatch: boolean;
}

export interface CodexPendingTurn {
  turnId: string;
  dispatchAttempt?: number;
  linkRefMode?: 'observe' | 'enabled';
  /** This attribution mark came from the previous worker generation's durable
   * journal. Recovery-only cleanup may retire these marks without touching a
   * new turn that the replacement process accepted during startup. */
  restoredFromJournal?: boolean;
  started: boolean;
  /** True only once a corroborated user record matched this turn's complete
   *  normalised input (see CodexTurnStartEvidence). Cleared on provisional
   *  rollback and left undefined on bare task_started claims. */
  exactUserInputMatch?: boolean;
  contentFingerprint?: string;
  /** Full normalised mark, retained in memory only. Doubao's native request
   * row ownership uses it, and so does whole-input attribution: a shared
   * 30-char prefix cannot tell an old retry from the next input, nor two
   * messages that open with the same link. Restart journals deliberately keep
   * only the existing fingerprint/hash fields, so restored turns fail closed
   * here and fall back to the head-only fingerprint match. */
  nativeInputText?: string;
  /** Full normalised submitted text when the worker appended runtime wrappers
   *  (e.g. deferred skill catalog) to logicalMsg before writing to the CLI.
   *  Checked with strict whole-string equality alongside nativeInputText. */
  submittedInputText?: string;
  /** Exact-input digest for submittedInputText (used for driver-proved alias
   *  inputs such as TraeX native /skill with an appended catalog wrapper). */
  submittedInputTextHash?: string;
  /** Digest of the full normalised mark. Unlike nativeInputText it survives a
   * restart journal (no prompt text is persisted), so a restored mark can
   * still prove a later record is its whole input. */
  wholeInputHash?: string;
  /** Digest of the full written input for driver-proved input aliases.
   * The historical prefix fingerprint alone cannot prove a rewritten skill
   * input whose arguments differ after its first 30 characters. Persist the
   * digest for restart recovery without retaining the full private prompt. */
  inputTextHash?: string;
  /** Wall-clock millis when mark() was called. The emit gate uses this as
   *  the lower bound of the "did `botmux send` happen for this turn?"
   *  window. Optional only for legacy / test-injected turns. */
  markTimeMs?: number;
  /** Monotonic submission order within this queue. Queue rows move ahead of
   * unstarted/passed marks, so their current array position is not FIFO proof.
   * Restored marks use a negative range older than every pre-attach live mark. */
  markOrder?: number;
  /** Transcript identity and durable byte frontier observed at mark time.
   * Stored on the turn because the path may not be officially attached yet;
   * a later checkpoint must not replace this with an attach/post-ingest cursor. */
  recoveryJsonlPathAtMark?: string;
  recoveryOffsetAtMark?: number;
  /** Timestamp of the transcript user record that actually started this
   *  turn. Kept separate from markTimeMs, whose max(worker mark, transcript)
   *  semantics intentionally serve the outbound-send suppression window. */
  transcriptStartTimeMs?: number;
  /** Exact native user record corroborated at the actual attribution edge. */
  nativeUserProof?: { uuid: string; hash: string; timestampMs: number };
  /** Local observation time for a task_started-only provisional claim. Cleared
   *  once the fingerprinted user record corroborates the claim. */
  provisionalTaskStartedAtMs?: number;
  /** Local observation time when a provisional task_started claim was rolled
   *  back. While the mark remains unstarted, unmatched terminals are dropped
   *  rather than buffered back onto it. */
  taskStartedRollbackAtMs?: number;
  /** A later mark's whole input reached the transcript while this one never
   *  started. The CLI takes input in submit order, so this input is presumed
   *  not coming (an unknown slash command, input swallowed by a modal). It
   *  claims no start by fingerprint, holds no lease and keeps nothing busy;
   *  expiry retires it, with its usual notice, once no started turn is
   *  running and its own submit verification has run out. A positive submit
   *  receipt, or its own whole-input record, takes the presumption back. */
  passedBySuccessor?: true;
  /** Local-clock deadline for a restored passed mark's own late user record.
   * Unlike submit verification this never marks the previous worker's lifecycle
   * as active and never holds the session busy; it only delays attribution prune. */
  restoredPassedRevivalUntilMs?: number;
  /** Wall-clock millis when an authoritative adapter/history check confirmed
   *  the submit. Unverified writes deliberately leave this unset. */
  submitConfirmedAtMs?: number;
  /** True when `submitConfirmedAtMs` came only from weak `pty-output`
   *  activity during a deferred recheck rather than an actual history/transcript
   *  or botmux-send receipt. Keeps the bounded start lease alive while alone,
   *  but must not block a later whole-input successor from passing it. */
  weakSubmitConfirmation?: true;
  /** Local time the CLI reported it accepted this input while busy and is
   *  holding it until its current work ends (`input_queued`). While set the
   *  pre-start lease cannot expire: the user record is coming, just late.
   *  Cleared when the turn starts or the CLI settles without taking it up. */
  cliQueuedAtMs?: number;
  /** Wall-clock millis anchoring the bounded attribution-only lease for an
   *  unconfirmed mark. Unlike verification/confirmation leases, this never
   *  gates screen-ready or reports the CLI busy. */
  unconfirmedAttributionStartedAtMs?: number;
  /** Wall-clock millis when worker-side authoritative submit verification
   *  began. This closes the race where screen-ready arrives while writeInput
   *  is still polling history, before it can return `submitted: true`. */
  submitVerificationStartedAtMs?: number;
  /** When the adapter write/verification for this mark ended. Unlike the
   *  lease anchors it is never refreshed, so it can be compared with later
   *  screen observations of whether the CLI still holds the input. */
  writeSettledAtMs?: number;
  /** Local observation time when an earlier started turn reached its terminal
   *  edge while this mark was waiting unstarted behind it. Busy-tick lease
   *  refresh caps (`maxSinceMarkMs`) measure from the later of `markTimeMs` and
   *  this hand-off edge so a type-ahead follow-up that waited > 120s behind a
   *  long predecessor still gets its own bounded window to flush its `user` row. */
  predecessorTerminalAtMs?: number;
  /** The worker still owns an ambiguous draft in this CLI generation. Keep
   * its exact fingerprint for a later manual submit, without claiming success. */
  inputDeliveryQuarantined?: true;
  /** Set once an assistant_final event closes this turn. */
  finalText?: string;
  replyModel?: string;
  replyReasoningEffort?: string;
  /** Explicit transcript terminal semantics. Undefined keeps the historical
   *  assistant-final => completed behaviour. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  terminalErrorSummary?: string;
  /** Set when this turn was synthesised from a user_message that didn't
   *  match any pending Lark fingerprint. Adopt-only. The worker emit path
   *  formats these with both userText and finalText under a "终端本地对话"
   *  header — same rationale as Claude's BridgeTurnQueue local turns. */
  isLocal?: boolean;
  /** For local turns: the user's typed text, surfaced alongside the
   *  assistant reply so the Lark thread sees both sides of the exchange. */
  userText?: string;
  sourceSessionId?: string;
  /** Native provider turn id learned from the transcript user event. */
  sourceTurnId?: string;
  sourceMessageId?: string;
  /** A fresh lifecycle observed while this HOL successor still owns the
   * input. It is only a candidate until a terminal or another user arrives;
   * replay reconstructs it from lifecycle records, never from a pending mark. */
  replacementNativeTurnId?: string;
  /** Inputs folded into this native execution by a confirmed same-turn steer.
   * Their send attribution must retire with the single native terminal. */
  supersededTurns?: Array<Pick<CodexPendingTurn, 'turnId' | 'dispatchAttempt'>>;
  /** This input reached the CLI as a confirmed same-turn steer: Codex pulled
   * it into the execution already running, so the model answers it in the
   * middle of that work (see CodexMidTurnReplyCollector). */
  steeredMidTurn?: boolean;
  /** True when the turn was delivered via Codex RPC (turn/start) and the
   *  app-server has acknowledged it. RPC turns have no local transcript to
   *  ingest, so they can never reach the started state; this flag keeps the
   *  lifecycle gate asserted for the full server-side execution instead of
   *  letting the bounded 20s confirmation lease expire mid-turn (which would
   *  falsely release idle and prune a still-running turn). Cleared by the
   *  terminal edge or an explicit stop. */
  rpcActive?: boolean;
}

/** Journal-restored marks whose lifecycle the PREVIOUS worker process had
 *  already accepted when it died: the replacement CLI cannot complete them, so
 *  a cold-resume first prompt may retire them and let the restart-interruption
 *  note own recovery.
 *
 *  The activity disjunction is load-bearing. `restorePendingTurns()` rebuilds
 *  every mark as `started:false` with none of the submit/rpc flags. A mark
 *  that never reached the transcript (its user record was still buffered when
 *  the process died) must STAY queued: the resumed CLI may still emit that
 *  user record — or genuinely run queued input — and a later ingest owns the
 *  attribution. Only a mark the baseline replay proved the dead process had
 *  already started / queued / confirmed is safe to retire. */
export function selectStaleRestoredJournalTurns(
  turns: readonly CodexPendingTurn[],
): CodexPendingTurn[] {
  return turns.filter(turn => turn.restoredFromJournal === true
    && turn.finalText === undefined
    && (turn.started
      || turn.rpcActive === true
      || turn.cliQueuedAtMs !== undefined
      || turn.submitConfirmedAtMs !== undefined
      || turn.submitVerificationStartedAtMs !== undefined));
}

/** Byte offset of the rollout line a Codex event came from (`<path>:<offset>`). */
function rolloutLineOffset(uuid: string): number | undefined {
  const offset = Number(uuid.slice(uuid.lastIndexOf(':') + 1));
  return Number.isSafeInteger(offset) ? offset : undefined;
}

/** Byte position used by restart recovery to distinguish already-checkpointed
 * rows from late append-only records. Stable replay ids carry it explicitly;
 * raw drain ids encode it as <path>:<offset>. */
export function codexBridgeEventRolloutOffset(
  ev: Pick<CodexBridgeEvent, 'uuid' | 'rolloutOffset'>,
): number | undefined {
  return ev.rolloutOffset ?? rolloutLineOffset(ev.uuid);
}

/** Rollout file of a raw `<path>:<offset>` event id. Stable content ids carry
 * the same information explicitly in `rolloutPath`. */
function rolloutLinePath(uuid: string): string | undefined {
  const separator = uuid.lastIndexOf(':');
  return separator > 0 ? uuid.slice(0, separator) : undefined;
}

/**
 * What the model says to a Lark turn in the middle of its work. Fed the 'cot'
 * records attributed to one turn in order, it collects each run of assistant
 * messages and reports it once the model moves on to a tool call: it said
 * something and went back to work. A message the turn simply ends with is its
 * final answer, which the turn's own reply already carries, so that never
 * completes here. Only a record of the model calling a tool counts: not one
 * written before the message (a deferred shell call surfacing at the turn's
 * end), and not a command's completion record, which can land after the final
 * message or belong to an earlier execution.
 *
 * The first report of a turn that started as a same-turn steer
 * (`steeredMidTurn`: Codex pulled the input into the execution already
 * running) is the answer to that input; every other report is progress.
 */
export class CodexMidTurnReplyCollector {
  private run: Array<{ text: string; uuid: string; timestampMs: number; offset?: number; path?: string }> = [];
  private reported = false;

  constructor(private readonly turn: Pick<CodexPendingTurn, 'steeredMidTurn'>) {}

  /** Feed the next record; returns each completed run exactly once.
   *  `saidAtMs` is the transcript time of the run's last message. */
  feed(ev: CodexBridgeEvent): { text: string; lastUuid: string; saidAtMs: number; answersSteer: boolean } | undefined {
    const message = ev.assistantMessage?.trim();
    if (message) {
      this.run.push({ text: message, uuid: ev.uuid, timestampMs: ev.timestampMs,
        offset: codexBridgeEventRolloutOffset(ev),
        path: ev.rolloutPath ?? rolloutLinePath(ev.uuid) });
      return undefined;
    }
    const toolCall = ev.toolCompletion !== true
      && (ev.toolCallBoundary === true || ev.cotEntries?.some(entry => entry.kind === 'tool_call'));
    if (this.run.length === 0 || !toolCall) return undefined;
    const at = codexBridgeEventRolloutOffset(ev);
    const path = ev.rolloutPath ?? rolloutLinePath(ev.uuid);
    const said = this.run[this.run.length - 1];
    if (path === said.path && at !== undefined && said.offset !== undefined && at < said.offset) return undefined;
    const reply = {
      text: this.run.map(part => part.text).join('\n\n'),
      lastUuid: said.uuid,
      saidAtMs: said.timestampMs,
      answersSteer: !this.reported && this.turn.steeredMidTurn === true,
    };
    this.run = [];
    this.reported = true;
    return reply;
  }
}

export class CodexBridgeQueue {
  private seen = new Set<string>();
  private seenNativeUserMessages = new Map<string, true>();
  private queue: CodexPendingTurn[] = [];
  private nextMarkOrder = 0;
  private nextRestoredMarkOrder = 0;
  private lastTranscriptEventTimeMs: number | undefined;
  private collecting: CodexPendingTurn | null = null;
  /** Recently closed native turns. Providers can replay terminal/CoT records
   *  after the owning local turn has already drained; without this tombstone
   *  those stable-id events could fall back onto a newer id-less turn. */
  private closedNativeTurns: Array<{ sourceSessionId?: string; sourceTurnId: string }> = [];
  /** Cosmetic observer for 'cot' events attributed to the collecting turn —
   *  feeds the native CoT (thinking process) message. Never affects
   *  attribution or lifecycle; exceptions are swallowed at the call site. */
  private cotObserver?: (entries: readonly CodexCotEntry[], turn: CodexPendingTurn) => void;
  /** A steer can retire a collecting turn without producing its terminal or
   * any CoT on the successor. Let the UI close that exact abandoned timeline;
   * this notification is not evidence that the work completed. */
  private cotSupersededObserver?: (turn: CodexPendingTurn) => void;
  /** Read-only observer for each 'cot' record attributed to a started turn —
   * what the model writes and calls in the middle of its work (see
   * CodexMidTurnReplyCollector). Never affects attribution. */
  private midTurnReplyObserver?: (ev: CodexBridgeEvent, turn: CodexPendingTurn) => void;
  /** A Lark turn's own user record reached the transcript: the CLI has its
   *  input. Never affects attribution; exceptions are swallowed. */
  private turnStartObserver?: (turn: CodexPendingTurn, evidence?: CodexTurnStartEvidence) => void;
  private localTurnsEnabled = false;
  /** See wholeInputSuccessor. Off unless the worker enables it for a driver
   *  whose transcript timestamps and submit order it trusts. */
  private wholeInputPassing = false;
  /** Quantisation step (ms) of transcript event timestamps for whole-input
   *  passing (e.g. 1_000 for RFC3339 1-second timestamps such as agy). */
  private wholeInputTimestampGranularityMs = 1;
  private bufferedUnmatched: CodexBridgeEvent[] = [];
  private readonly ambiguousSoftNewlineInputs = new WeakSet<NonNullable<CodexBridgeEvent['softNewlineInput']>>();
  private readonly recentlyDroppedInputs: Array<{ hashes: readonly string[]; droppedAtMs: number }> = [];
  private lastClosedAssistantFinalTimeMs: number | undefined;
  /** Lower bound (ms) for synthesising local turns — protects against a
   *  fresh-empty attach replaying historical iTerm conversation as
   *  "live" local input. Typically set to the moment adopt was wired up. */
  private localLowerBoundMs = 0;
  private static readonly CLOSED_NATIVE_TURNS_MAX = 4_096;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onLocalTurnStarted?: (turn: CodexPendingTurn) => void,
  ) {}

  private matchesUserInput(turn: CodexPendingTurn, event: CodexBridgeEvent): boolean {
    if (event.inputTextAliases !== undefined) {
      if (turn.inputTextHash === undefined && turn.submittedInputTextHash === undefined) return false;
      return [event.text, ...event.inputTextAliases]
        .some(text => {
          const digest = exactInputHash(text);
          return digest === turn.inputTextHash
            || (turn.submittedInputTextHash !== undefined && digest === turn.submittedInputTextHash);
        });
    }
    return !turn.contentFingerprint
      || normaliseForFingerprint(event.text).includes(turn.contentFingerprint);
  }

  /** Whole-input equality: the transcript user record is exactly what was
   *  written for this mark. Stronger than the fingerprint (a 30-char prefix
   *  found anywhere in the record), which two messages opening with the same
   *  link both pass. Driver-proved aliases are already exact. A restored mark
   *  has only its digest (older journals: nothing, and it never matches). */
  private exactlyMatchesUserInput(turn: CodexPendingTurn, event: CodexBridgeEvent): boolean {
    if (event.inputTextAliases !== undefined) return this.matchesUserInput(turn, event);
    if (!turn.contentFingerprint && turn.inputTextHash === undefined
      && !turn.wholeInputHash && !turn.nativeInputText && !turn.submittedInputText) {
      return false;
    }
    return this.matchesWholeInput(turn, normaliseForFingerprint(event.text));
  }

  private matchesWholeInput(turn: CodexPendingTurn, normalised: string): boolean {
    const stripped = CORRELATION_TRAILER_RE.test(normalised)
      ? normalised.replace(CORRELATION_TRAILER_RE, '')
      : undefined;
    if (turn.nativeInputText || turn.submittedInputText) {
      const matchesTarget = (target: string | undefined): boolean => {
        if (!target) return false;
        if (normalised === target) return true;
        return stripped !== undefined && !CORRELATION_TRAILER_RE.test(target) && stripped === target;
      };
      return matchesTarget(turn.nativeInputText) || matchesTarget(turn.submittedInputText);
    }
    if (!turn.wholeInputHash) return false;
    if (wholeInputHash(normalised) === turn.wholeInputHash) return true;
    return stripped !== undefined && wholeInputHash(stripped) === turn.wholeInputHash;
  }

  /** Match a transport-rewritten input to the FIFO head. The original
   * record may instead be a later mark with a literal line-ending backslash. */
  private matchSoftNewlineInput(turn: CodexPendingTurn, event: CodexBridgeEvent): 'matched' | 'ambiguous' | undefined {
    const candidate = event.softNewlineInput?.candidate;
    if (!candidate || event.inputTextAliases !== undefined || !this.matchesWholeInput(turn, candidate)) return undefined;
    const original = normaliseForFingerprint(event.text);
    const competingMark = this.queue.some(other => other !== turn && !other.started && other.finalText === undefined
      && (other.markTimeMs === undefined || event.timestampMs >= other.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS)
      && this.matchesWholeInput(other, original));
    if (competingMark) return 'ambiguous';
    const originalHashes = [wholeInputHash(original)];
    if (CORRELATION_TRAILER_RE.test(original)) {
      originalHashes.push(wholeInputHash(original.replace(CORRELATION_TRAILER_RE, '')));
    }
    const nowMs = this.now();
    const competingDrop = this.recentlyDroppedInputs.some(({ hashes, droppedAtMs }) =>
      nowMs - droppedAtMs <= CURSOR_BUSY_REFRESH_MAX_MS + STRUCTURED_SUBMIT_START_GRACE_MS
      && hashes.some(hash => originalHashes.includes(hash)));
    return competingDrop ? 'ambiguous' : 'matched';
  }

  /** A mark the CLI may still deliver: never passed over. */
  private mayStillArrive(turn: CodexPendingTurn): boolean {
    return turn.rpcActive === true
      || turn.cliQueuedAtMs !== undefined
      || turn.inputDeliveryQuarantined === true
      || (turn.submitConfirmedAtMs !== undefined && turn.weakSubmitConfirmation !== true)
      || turn.finalText !== undefined;
  }

  private wholeInputMarkFloorMs(markTimeMs: number): number {
    if (this.wholeInputTimestampGranularityMs <= 1) return markTimeMs;
    return Math.floor(markTimeMs / this.wholeInputTimestampGranularityMs) * this.wholeInputTimestampGranularityMs;
  }

  /** Adopt / zero-prompt mode only: the later unstarted mark whose whole
   *  input this user record is, and the unstarted marks it passes.
   *
   *  The CLI takes input in submit order, so when a later input's own record
   *  arrives, earlier inputs that never started never reached it (an unknown
   *  slash command, input swallowed by a modal). With local-turn synthesis on,
   *  an unmatched record becomes a local turn: without passing, the later
   *  input's reply posts as a terminal turn and its own mark expires with a
   *  "not collected" notice; and when the head shares the record's 30-char
   *  opening (every Lark wiki link does), the head claims a reply to an input
   *  it never sent.
   *
   *  Only whole-input equality passes, never the fingerprint. Nothing passes
   *  a mark the CLI may still deliver (RPC-active, CLI-queued, quarantined,
   *  strongly submit-confirmed), and a record older than the later mark's
   *  timestamp-granularity floor cannot be that mark's input. Identical texts
   *  keep FIFO order. Non-local-turn sessions keep their buffer instead: the
   *  record replays once the dead heads expire. */
  private wholeInputSuccessor(
    ev: CodexBridgeEvent,
    alsoPassing: readonly CodexPendingTurn[] = [],
  ): { mark: CodexPendingTurn; ahead: CodexPendingTurn[] } | undefined {
    if (!this.localTurnsEnabled || !this.wholeInputPassing) return undefined;
    const unstarted = this.queue.filter(turn => !turn.started && !turn.passedBySuccessor);
    const index = unstarted.findIndex(turn => turn.finalText === undefined
      && this.exactlyMatchesUserInput(turn, ev));
    // The head itself is a successor only to a start claim being passed.
    if (index < 0 || (index === 0 && alsoPassing.length === 0)) return undefined;
    const mark = unstarted[index];
    const ahead = unstarted.slice(0, index);
    if (mark.markTimeMs !== undefined && ev.timestampMs < this.wholeInputMarkFloorMs(mark.markTimeMs)) return undefined;
    if ([...alsoPassing, ...ahead].some(turn => this.mayStillArrive(turn))) return undefined;
    return { mark, ahead };
  }

  /** Current array order is deliberately not submission order: started marks
   * move ahead of unstarted/passed rows so their replies can drain. */
  private isEarlierSubmission(left: CodexPendingTurn, right: CodexPendingTurn): boolean {
    const leftOrder = left.markOrder ?? left.markTimeMs ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.markOrder ?? right.markTimeMs ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder;
    return this.queue.indexOf(left) < this.queue.indexOf(right);
  }

  /** Which unstarted mark a transcript user record starts: the earliest exact
   * eligible submission. A later whole-input successor may pass dead heads;
   * an older passed mark whose own identical record arrives late revives first. */
  private userRecordOwner(ev: CodexBridgeEvent): { next?: CodexPendingTurn; passed: CodexPendingTurn[] } {
    const head = this.queue.find(turn => !turn.started && !turn.passedBySuccessor);
    const exactHead = head && this.exactlyMatchesUserInput(head, ev) ? head : undefined;
    const successor = this.wholeInputSuccessor(ev);
    const revived = this.localTurnsEnabled && this.wholeInputPassing
      ? this.queue.find(turn => turn.passedBySuccessor && !turn.started && turn.finalText === undefined
        && !(turn.markTimeMs !== undefined && ev.timestampMs < this.wholeInputMarkFloorMs(turn.markTimeMs))
        && this.exactlyMatchesUserInput(turn, ev))
      : undefined;
    const exact = [exactHead, successor?.mark, revived].filter((turn): turn is CodexPendingTurn => !!turn);
    const earliest = exact.reduce<CodexPendingTurn | undefined>(
      (best, turn) => !best || this.isEarlierSubmission(turn, best) ? turn : best,
      undefined,
    );
    if (earliest && earliest === revived) return { next: revived, passed: [] };
    if (earliest && earliest === exactHead) return { next: exactHead, passed: [] };
    if (successor && earliest === successor.mark) return { next: successor.mark, passed: successor.ahead };
    return { next: revived ?? head, passed: [] };
  }

  /** A turn that starts behind passed marks moves ahead of them:
   *  drainEmittable stops at the first unstarted turn, so leaving it behind a
   *  passed mark would hold its reply until that mark expires. */
  private moveAheadOfUnstarted(turn: CodexPendingTurn): void {
    const firstUnstarted = this.queue.findIndex(candidate => !candidate.started);
    const at = this.queue.indexOf(turn);
    if (firstUnstarted < 0 || at < firstUnstarted) return;
    this.queue.splice(at, 1);
    this.queue.splice(firstUnstarted, 0, turn);
  }

  private isClosedNativeTurn(sourceSessionId: string | undefined, sourceTurnId: string): boolean {
    return this.closedNativeTurns.some(closed => closed.sourceTurnId === sourceTurnId
      && (!closed.sourceSessionId || !sourceSessionId || closed.sourceSessionId === sourceSessionId));
  }

  private rememberClosedNativeTurn(turn: CodexPendingTurn): void {
    if (!turn.sourceTurnId
      || this.isClosedNativeTurn(turn.sourceSessionId, turn.sourceTurnId)) return;
    this.closedNativeTurns.push({
      ...(turn.sourceSessionId ? { sourceSessionId: turn.sourceSessionId } : {}),
      sourceTurnId: turn.sourceTurnId,
    });
    if (this.closedNativeTurns.length > CodexBridgeQueue.CLOSED_NATIVE_TURNS_MAX) {
      this.closedNativeTurns.splice(
        0, this.closedNativeTurns.length - CodexBridgeQueue.CLOSED_NATIVE_TURNS_MAX,
      );
    }
  }

  private sourceSessionsCompatible(left: string | undefined, right: string | undefined): boolean {
    return !left || !right || left === right;
  }

  private nativeUserMessageKey(ev: CodexBridgeEvent): string | undefined {
    if (!ev.sourceTurnId || !ev.sourceMessageId) return undefined;
    return JSON.stringify([ev.sourceSessionId ?? '', ev.sourceTurnId, ev.sourceMessageId]);
  }

  private rememberNativeUserMessage(ev: CodexBridgeEvent): void {
    const key = this.nativeUserMessageKey(ev);
    if (!key) return;
    this.seenNativeUserMessages.set(key, true);
    if (this.seenNativeUserMessages.size > CodexBridgeQueue.CLOSED_NATIVE_TURNS_MAX) {
      this.seenNativeUserMessages.delete(this.seenNativeUserMessages.keys().next().value!);
    }
  }

  private isProvisionalTaskStart(turn: CodexPendingTurn | null | undefined): boolean {
    return !!turn
      && turn.started
      && turn.finalText === undefined
      && turn.transcriptStartTimeMs === undefined
      && turn.provisionalTaskStartedAtMs !== undefined;
  }

  private matchingProvisionalTaskStart(ev: CodexBridgeEvent): CodexPendingTurn | null {
    if (!ev.sourceTurnId) return null;
    return this.queue.find(turn => this.isProvisionalTaskStart(turn)
      && turn.sourceTurnId === ev.sourceTurnId
      && this.sourceSessionsCompatible(turn.sourceSessionId, ev.sourceSessionId)) ?? null;
  }

  /** A lost earlier mark can hold the provisional claim on a native turn whose
   *  user record then started a later mark. The terminal belongs to that
   *  corroborated turn; dropping it would leave it started without a final. */
  private hasCorroboratedNativeTurn(ev: CodexBridgeEvent): boolean {
    return !!ev.sourceTurnId && this.queue.some(turn => turn.started && turn.finalText === undefined
      && !this.isProvisionalTaskStart(turn)
      && turn.sourceTurnId === ev.sourceTurnId
      && this.sourceSessionsCompatible(turn.sourceSessionId, ev.sourceSessionId));
  }

  private rollbackProvisionalTaskStart(turn: CodexPendingTurn, observedAtMs: number = this.now()): void {
    if (!this.isProvisionalTaskStart(turn)) return;
    turn.started = false;
    turn.exactUserInputMatch = undefined;
    turn.provisionalTaskStartedAtMs = undefined;
    turn.taskStartedRollbackAtMs = observedAtMs;
    turn.sourceSessionId = undefined;
    turn.sourceTurnId = undefined;
    turn.submitVerificationStartedAtMs = undefined;
    if (turn.submitConfirmedAtMs !== undefined) {
      turn.submitConfirmedAtMs = observedAtMs;
      turn.unconfirmedAttributionStartedAtMs = undefined;
    } else {
      turn.unconfirmedAttributionStartedAtMs = observedAtMs;
    }
    if (this.collecting === turn) this.collecting = null;
  }

  private hasRolledBackTaskStart(): boolean {
    return this.queue.some(turn => !turn.started
      && turn.finalText === undefined
      && turn.taskStartedRollbackAtMs !== undefined);
  }

  private targetForNativeEvent(ev: CodexBridgeEvent): CodexPendingTurn | null {
    if (!ev.sourceTurnId) {
      return this.isProvisionalTaskStart(this.collecting) ? null : this.collecting;
    }
    const exact = this.queue.find(turn => turn.started && turn.finalText === undefined
      && !this.isProvisionalTaskStart(turn)
      && turn.sourceTurnId === ev.sourceTurnId
      && this.sourceSessionsCompatible(turn.sourceSessionId, ev.sourceSessionId));
    if (exact) return exact;
    const fallback = this.collecting;
    // A same-native HOL steer can inherit an abandoned task_started id X,
    // while Codex completes the execution as Y without another start. Only a
    // terminal may replace that inherited identity. Require exact session
    // evidence and no competing active turn; ordinary native turns and CoT
    // retain exact-id routing. Credit from X cannot suppress Y's answer.
    if (fallback?.sourceTurnId && fallback.supersededTurns?.length
      && (ev.kind === 'assistant_final' || ev.kind === 'turn_aborted')
      && fallback.sourceSessionId === ev.sourceSessionId
      && fallback.transcriptStartTimeMs !== undefined
      && ev.timestampMs >= fallback.transcriptStartTimeMs
      // With multiple active turns and no exact match, refuse an ambiguous
      // reassignment to avoid merging independent replies. Exact-id routing
      // above stays available; if X never terminates, its turn may stay pending.
      && !this.queue.some(turn => turn !== fallback && turn.started && turn.finalText === undefined)) {
      this.rememberClosedNativeTurn(fallback);
      fallback.sourceTurnId = ev.sourceTurnId;
      fallback.supersededTurns = undefined;
      return fallback;
    }
    if (!fallback
      || this.isProvisionalTaskStart(fallback)
      || fallback.sourceTurnId
      || !this.sourceSessionsCompatible(fallback.sourceSessionId, ev.sourceSessionId)
      // Native records for a legacy turn cannot precede that turn's user
      // record in the append-only transcript. This remains a replay guard
      // after an old closed-turn tombstone ages out of the bounded cache.
      || (fallback.transcriptStartTimeMs !== undefined
        && ev.timestampMs < fallback.transcriptStartTimeMs)) return null;
    return fallback;
  }

  private observeTranscriptEventTimes(events: readonly CodexBridgeEvent[]): void {
    for (const ev of events) {
      if (!Number.isFinite(ev.timestampMs)) continue;
      this.lastTranscriptEventTimeMs = Math.max(this.lastTranscriptEventTimeMs ?? ev.timestampMs, ev.timestampMs);
    }
  }

  /** High watermark of transcript rows already absorbed or ingested. A passed
   * mark's journal uses it only as a fallback when a replay event lacks a byte
   * offset; append-only offsets remain the authoritative recovery partition. */
  transcriptEventTimeUpperBound(): number | undefined {
    return this.lastTranscriptEventTimeMs;
  }

  /** Register events as historical without producing pending-turn side
   *  effects. Used at attach time when resume mode wants to swallow prior
   *  conversation as already-processed. */
  absorb(events: CodexBridgeEvent[]): void {
    this.observeTranscriptEventTimes(events);
    for (const ev of events) this.seen.add(ev.uuid);
  }

  /** Toggle adopt-mode local-turn synthesis. `lowerBoundMs` (typically
   *  Date.now() at adopt-time) protects against a fresh-empty attach
   *  feeding historical user_messages back as "live" local turns. */
  /** Allow adopt-mode whole-input passing (see wholeInputSuccessor). Only for
   *  drivers that write each user record when the CLI takes the input, with
   *  its own clock: a reader that stamps records at read time cannot tell an
   *  old identical record from the new input. */
  setWholeInputPassing(enabled: boolean, options?: { timestampGranularityMs?: number }): void {
    this.wholeInputPassing = enabled;
    const granularity = options?.timestampGranularityMs;
    this.wholeInputTimestampGranularityMs = enabled && typeof granularity === 'number' && Number.isFinite(granularity) && granularity > 1
      ? granularity
      : 1;
  }

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
  /** Read-only live-offset evidence for an unstarted mark during an
   *  authoritative transcript rebind. Uses the same fingerprint and freshness
   *  rules as started-turn rebinding, but never changes native ownership. */
  matchPendingTurnToUser(turnId: string, ev: CodexBridgeEvent): boolean {
    if (ev.kind !== 'user') return false;
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && !candidate.started && candidate.finalText === undefined);
    if (!turn || !this.matchesUserInput(turn, ev)) return false;
    return turn.markTimeMs === undefined || ev.timestampMs >= turn.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS;
  }

  /** Rebind an already-started owner to the SAME logical user record in an
   *  authoritative replacement transcript. The fingerprint and normal replay
   *  freshness window must both match; the real event supplies its exact native
   *  id (including byte offsets) and user proof. No event is ingested here.
   *  `commit=false` is a side-effect-free match for atomic multi-turn rebinds. */
  rebindStartedTurnToUser(turnId: string, ev: CodexBridgeEvent, commit = true): boolean {
    if (ev.kind !== 'user') return false;
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.started && candidate.finalText === undefined);
    if (!turn || (turn.sourceTurnId && !ev.sourceTurnId) || !this.matchesUserInput(turn, ev)) return false;
    if (turn.markTimeMs !== undefined && ev.timestampMs < turn.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS) return false;
    if (!commit) return true;
    const prevExact = turn.exactUserInputMatch;
    const prevSid = turn.sourceSessionId;
    turn.sourceSessionId = ev.sourceSessionId;
    if (ev.sourceTurnId) turn.sourceTurnId = ev.sourceTurnId;
    turn.sourceMessageId = ev.sourceMessageId;
    turn.transcriptStartTimeMs = ev.timestampMs;
    turn.exactUserInputMatch = this.exactlyMatchesUserInput(turn, ev);
    turn.nativeUserProof = {
      uuid: ev.uuid,
      hash: createHash('sha256').update(ev.text).digest('hex'),
      timestampMs: ev.timestampMs,
    };
    if (turn.exactUserInputMatch === true && (prevExact !== true || turn.sourceSessionId !== prevSid)) {
      try { this.turnStartObserver?.(turn, { exactUserInputMatch: true }); } catch { /* observer only */ }
    }
    return true;
  }

  /** Record the exact normalised submitted text when the worker appended
   *  runtime wrappers (e.g. deferred skill catalog) to logicalMsg before write,
   *  so strict whole-input proof matches the actual transcript user record. */
  setSubmittedInputText(
    turnId: string,
    submittedMessage: string,
    dispatchAttempt?: number,
  ): void {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && !candidate.started
      && candidate.finalText === undefined);
    if (!turn) return;
    const normalised = normaliseForFingerprint(submittedMessage);
    if (normalised) turn.submittedInputText = normalised;
    if (turn.inputTextHash !== undefined || /^[ \t]*(?:[/$]|\[\$)/.test(submittedMessage)) {
      turn.submittedInputTextHash = exactInputHash(submittedMessage);
    }
  }

  mark(
    turnId: string,
    message: string,
    markTimeMs: number = this.now(),
    dispatchAttempt?: number,
    recoveryCursorAtMark?: { jsonlPath: string; offsetAtMark: number },
    linkRefMode?: 'observe' | 'enabled',
    requireExactInput = false,
    submittedMessage?: string,
  ): void {
    const normalisedSubmitted = submittedMessage && submittedMessage !== message
      ? normaliseForFingerprint(submittedMessage)
      : undefined;
    const trackExactHash = requireExactInput || /^[ \t]*(?:[/$]|\[\$)/.test(message);
    const submittedHash = submittedMessage && submittedMessage !== message
      && (trackExactHash || /^[ \t]*(?:[/$]|\[\$)/.test(submittedMessage))
      ? exactInputHash(submittedMessage)
      : undefined;
    this.queue.push({
      turnId,
      dispatchAttempt,
      ...(linkRefMode ? { linkRefMode } : {}),
      started: false,
      markOrder: this.nextMarkOrder++,
      contentFingerprint: makeFingerprint(message),
      nativeInputText: normaliseForFingerprint(message),
      ...(normalisedSubmitted ? { submittedInputText: normalisedSubmitted } : {}),
      wholeInputHash: wholeInputHash(message),
      ...(trackExactHash ? { inputTextHash: exactInputHash(message) } : {}),
      ...(submittedHash ? { submittedInputTextHash: submittedHash } : {}),
      markTimeMs,
      recoveryJsonlPathAtMark: recoveryCursorAtMark?.jsonlPath,
      recoveryOffsetAtMark: recoveryCursorAtMark?.offsetAtMark,
      unconfirmedAttributionStartedAtMs: markTimeMs,
    });
    this.replayBufferedUnmatched(markTimeMs);
  }

  /** Restore older marks before input accepted during rollout discovery. Only
   * valid before the first transcript ingest; preserve current delivery owners
   * and their confirmation state when a message is already in this queue. */
  restorePendingTurns(entries: readonly {
    turnId: string;
    fingerprint: string;
    inputTextHash?: string;
    wholeInputHash?: string;
    passedBySuccessor?: { replayFloorMs: number };
    markTimeMs: number;
    linkRefMode?: 'observe' | 'enabled';
    jsonlPath?: string;
    offsetAtMark?: number;
    mergedExecution?: {
      sourceTurnId: string;
      sourceSessionId?: string;
      supersededTurnIds: readonly string[];
    };
  }[]): void {
    const existing = new Set(this.queue.map(turn => turn.turnId));
    const restored: CodexPendingTurn[] = [];
    for (const entry of entries) {
      if (existing.has(entry.turnId)) continue;
      existing.add(entry.turnId);
      restored.push({ turnId: entry.turnId, started: false,
        restoredFromJournal: true,
        ...(entry.passedBySuccessor ? {
          passedBySuccessor: true as const,
          restoredPassedRevivalUntilMs: this.now() + STRUCTURED_RESTORED_PASS_REVIVIAL_GRACE_MS,
        } : {}),
        ...(entry.linkRefMode ? { linkRefMode: entry.linkRefMode } : {}),
        contentFingerprint: makeFingerprint(entry.fingerprint), markTimeMs: entry.markTimeMs,
        ...(entry.inputTextHash ? { inputTextHash: entry.inputTextHash } : {}),
        ...(entry.wholeInputHash ? { wholeInputHash: entry.wholeInputHash } : {}),
        recoveryJsonlPathAtMark: entry.jsonlPath,
        recoveryOffsetAtMark: entry.offsetAtMark,
        ...(entry.mergedExecution ? {
          sourceTurnId: entry.mergedExecution.sourceTurnId,
          sourceSessionId: entry.mergedExecution.sourceSessionId,
          supersededTurns: entry.mergedExecution.supersededTurnIds.map(turnId => ({ turnId })),
          // A persisted superseded host is the same same-turn steer evidence
          // that armed the observer before the worker restarted.
          ...(entry.mergedExecution.supersededTurnIds.length > 0 ? { steeredMidTurn: true } : {}),
        } : {}),
        unconfirmedAttributionStartedAtMs: entry.markTimeMs });
    }
    if (restored.length > 0) {
      const base = this.nextRestoredMarkOrder - restored.length;
      restored.forEach((turn, index) => { turn.markOrder = base + index; });
      this.nextRestoredMarkOrder = base;
    }
    this.queue.unshift(...restored);
  }

  /** Drop all pending turns. Used when the worker decides it can't reliably
   *  attribute future events (e.g. a teardown). */
  clearPending(): CodexPendingTurn[] {
    const dropped = this.queue.splice(0);
    if (this.collecting && dropped.includes(this.collecting)) this.collecting = null;
    this.bufferedUnmatched = [];
    this.recentlyDroppedInputs.length = 0;
    this.lastClosedAssistantFinalTimeMs = undefined;
    this.lastTranscriptEventTimeMs = undefined;
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
    if (dropped && !dropped.started && dropped.finalText === undefined) {
      // A cancelled or expired input can still reach the transcript. Retain
      // its whole-input digests as short-lived conflict evidence only.
      const hashes = dropped.wholeInputHash === undefined ? [] : [dropped.wholeInputHash];
      if (dropped.submittedInputText) hashes.push(wholeInputHash(dropped.submittedInputText));
      if (hashes.length > 0) {
        this.recentlyDroppedInputs.push({ hashes, droppedAtMs: this.now() });
        if (this.recentlyDroppedInputs.length > MAX_BUFFERED_UNMATCHED_EVENTS) this.recentlyDroppedInputs.shift();
      }
    }
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
      const expiredProvisional = this.queue.find(turn => this.isProvisionalTaskStart(turn)
        && nowMs - turn.provisionalTaskStartedAtMs!
          > STRUCTURED_TASK_START_CORROBORATION_GRACE_MS);
      if (expiredProvisional) {
        this.rollbackProvisionalTaskStart(expiredProvisional, nowMs);
        continue;
      }
      // A long-running predecessor legitimately keeps later confirmed input in
      // the CLI's type-ahead queue. Its assistant_final refreshes the next head
      // from local observation time, so expiring anything before that boundary
      // would drop valid queued work.
      if (this.queue.some(turn => turn.started && turn.finalText === undefined)) break;

      // A passed mark's input is presumed not coming (a later input already
      // started), so its attribution lease no longer applies. Retire it
      // wherever it sits: a later mark whose start was rolled back can be
      // ahead of it and must not hold its notice behind that mark's lease.
      // Only an in-flight submit check or late delivery evidence may still
      // prove it arrived. Setters for positive evidence also revoke the pass,
      // but keep this guard fail-closed against every future evidence field.
      const passed = this.queue.find(turn => turn.passedBySuccessor
        && !turn.started && turn.finalText === undefined
        && !this.mayStillArrive(turn)
        && !(turn.restoredPassedRevivalUntilMs !== undefined
          && nowMs <= turn.restoredPassedRevivalUntilMs)
        && !(turn.submitVerificationStartedAtMs !== undefined
          && nowMs - turn.submitVerificationStartedAtMs <= STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS));
      if (passed) {
        const removed = this.dropPendingTurn(passed.turnId, passed.dispatchAttempt);
        if (!removed) break;
        dropped.push(removed);
        continue;
      }

      const head = this.queue.find(turn => !turn.started && !turn.passedBySuccessor
        && turn.finalText === undefined);
      if (!head) break;

      // An RPC turn is running server-side with no local transcript to ingest.
      // It can never reach started, so the bounded lease must NOT be used to
      // prune it — that would falsely release idle while the app-server is still
      // executing. Keep it until the terminal edge or explicit stop.
      if (head.rpcActive) break;
      // The CLI holds this input in its own queue (input_queued); its user
      // record will start it, or cli_settled restarts the lease.
      if (head.cliQueuedAtMs !== undefined) break;
      if (head.inputDeliveryQuarantined) break;

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

  /** Refresh the bounded pre-start leases of EVERY queued head while the CLI
   *  is visibly busy. Cursor's transcript mirror may not flush a turn's user
   *  line until the first assistant step (a tool-less reply flushes the whole
   *  turn at once, at the end), which can exceed the 20s lease measured from
   *  write time; the worker ticks this every second while the CLI works, so
   *  the countdown effectively starts at idle. Both unconfirmed attribution
   *  leases AND submit-confirmed leases are refreshed: cursor's argv-baked
   *  first turn is confirmPendingTurn'd at init (the most common spawn path)
   *  yet its user line flushes just as late, and a type-ahead successor must
   *  not be pruned behind a still-unstarted confirmed predecessor (the
   *  started-predecessor shield in pruneExpiredPreStartHeads does not cover
   *  that case).
   *
   *  Bounds preserved:
   *  - rpc-active and provisional-task heads keep their own leases;
   *  - a head with submit verification in flight keeps its verification
   *    grace (the check owns that window);
   *  - `maxSinceMarkMs` is a HARD ceiling measured from the mark: a false
   *    "busy" screen (swallowed Enter / modal redraw) can refresh only up to
   *    it, after which the head prunes and the structured_start_timeout /
   *    successor queue recover — no permanent wedge.
   *  `eligible` narrows the refresh to heads the caller's evidence covers.
   *  Returns the number of refreshed heads. */
  refreshUnstartedHeadAttributionLease(
    nowMs: number = this.now(),
    maxSinceMarkMs?: number,
    eligible?: (turn: CodexPendingTurn) => boolean,
  ): number {
    let refreshed = 0;
    for (const head of this.queue) {
      if (head.started || head.finalText !== undefined) continue;
      if (eligible && !eligible(head)) continue;
      if (head.rpcActive) continue;
      if (this.isProvisionalTaskStart(head)) continue;
      if (head.submitVerificationStartedAtMs !== undefined
        && nowMs - head.submitVerificationStartedAtMs <= STRUCTURED_SUBMIT_VERIFICATION_GRACE_MS) {
        continue;
      }
      const capAnchorMs = head.predecessorTerminalAtMs !== undefined
        && (head.markTimeMs === undefined || head.predecessorTerminalAtMs > head.markTimeMs)
        ? head.predecessorTerminalAtMs
        : head.markTimeMs;
      if (maxSinceMarkMs !== undefined
        && capAnchorMs !== undefined
        && nowMs - capAnchorMs > maxSinceMarkMs) {
        continue;
      }
      if (head.submitConfirmedAtMs !== undefined) {
        head.submitConfirmedAtMs = nowMs;
        refreshed++;
      } else if (head.unconfirmedAttributionStartedAtMs !== undefined) {
        head.unconfirmedAttributionStartedAtMs = nowMs;
        refreshed++;
      }
    }
    return refreshed;
  }

  /** Record positive submit evidence from an adapter/history check. The turn
   *  can still be waiting in the CLI's type-ahead queue, so this starts a
   *  bounded hand-off lease until its transcript user event appears.
   *  When `options.weak` is true (deferred `pty-output` only), the bounded
   *  lease still protects a sole pending head, but it does not block a later
   *  whole-input successor or revive an already-passed mark. */
  confirmPendingTurn(
    turnId: string,
    confirmedAtMs: number = this.now(),
    dispatchAttempt?: number,
    options?: { weak?: boolean },
  ): boolean {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText === undefined);
    if (!turn) return false;
    if (options?.weak === true) {
      if (turn.passedBySuccessor) return false;
      if (turn.submitConfirmedAtMs !== undefined && turn.weakSubmitConfirmation !== true) {
        return true;
      }
      turn.weakSubmitConfirmation = true;
    } else {
      // The CLI did take this input after all: its record is coming.
      turn.weakSubmitConfirmation = undefined;
      turn.passedBySuccessor = undefined;
      turn.restoredPassedRevivalUntilMs = undefined;
    }
    turn.submitVerificationStartedAtMs = undefined;
    turn.unconfirmedAttributionStartedAtMs = undefined;
    turn.submitConfirmedAtMs = confirmedAtMs;
    turn.writeSettledAtMs ??= confirmedAtMs;
    return true;
  }

  /** Whether this exact mark has already been passed over by a later
   *  whole-input successor in the transcript. */
  isPassedBySuccessor(turnId: string, dispatchAttempt?: number): boolean {
    return this.queue.some(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.passedBySuccessor === true);
  }

  /** Expire, on their ordinary pre-start lease, the unstarted heads queued
   *  AHEAD of a later input the CLI has positively received. For a CLI that
   *  sends held input strictly in submit order, an earlier input that has not
   *  started by then is no longer held anywhere; keeping its lease alive
   *  would only park the successor's native start behind a dead head.
   *  Quarantined, verifying, RPC-active and CLI-queued heads are left alone.
   *  The caller prunes (and notifies) through its usual expiry path. */
  expireUnstartedBefore(
    turnId: string,
    dispatchAttempt?: number,
    preserve?: (turn: CodexPendingTurn) => boolean,
  ): CodexPendingTurn[] {
    const index = this.queue.findIndex(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt);
    if (index <= 0) return [];
    const expired: CodexPendingTurn[] = [];
    for (const turn of this.queue.slice(0, index)) {
      if (turn.started || turn.finalText !== undefined || turn.rpcActive
        || preserve?.(turn) || turn.inputDeliveryQuarantined || turn.cliQueuedAtMs !== undefined
        || turn.submitVerificationStartedAtMs !== undefined) continue;
      if (turn.submitConfirmedAtMs !== undefined) turn.submitConfirmedAtMs = Number.NEGATIVE_INFINITY;
      else if (turn.unconfirmedAttributionStartedAtMs !== undefined) {
        turn.unconfirmedAttributionStartedAtMs = Number.NEGATIVE_INFINITY;
      } else continue;
      expired.push(turn);
    }
    return expired;
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
    // A server-side ACK is positive late delivery evidence, just like an
    // adapter submit receipt: the earlier successor's presumption is revoked.
    turn.passedBySuccessor = undefined;
    turn.restoredPassedRevivalUntilMs = undefined;
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

  setInputDeliveryQuarantined(turnId: string, quarantined: boolean, dispatchAttempt?: number): void {
    const turn = this.queue.find(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt);
    if (!turn) return;
    if (quarantined) {
      // The CLI still owns a parked draft. This evidence can arrive after a
      // successor already passed the mark, so restore attribution before the
      // next prune rather than letting the passed fast path delete the draft.
      turn.passedBySuccessor = undefined;
      turn.restoredPassedRevivalUntilMs = undefined;
      turn.inputDeliveryQuarantined = true;
    } else {
      turn.inputDeliveryQuarantined = undefined;
    }
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
    turn.writeSettledAtMs ??= finishedAtMs;
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

  /** True only when this exact turn reached a native terminal after a
   *  corroborated whole-input user match (never provisional or prefix-only). */
  hasExactTerminalTurn(
    turnId: string,
    dispatchAttempt?: number,
    expectedSourceSessionId?: string,
  ): boolean {
    return this.queue.some(candidate => candidate.turnId === turnId
      && candidate.dispatchAttempt === dispatchAttempt
      && candidate.finalText !== undefined
      && candidate.provisionalTaskStartedAtMs === undefined
      && candidate.exactUserInputMatch === true
      && !candidate.isLocal
      && !candidate.restoredFromJournal
      && (!expectedSourceSessionId
        || !candidate.sourceSessionId
        || candidate.sourceSessionId === expectedSourceSessionId));
  }

  /** Whether a native user record (the CoT reader's USER_INPUT boundary in
   *  adopt mode) starts a turn owned by a Lark marker rather than a local
   *  terminal input. Uses the same fingerprint/exact-hash match and the same
   *  5s replay tolerance as the transcript ingest path, so the thinking-timeline
   *  side channel cannot attribute local-turn entries to an active Lark card.
   *  Open marks that have not reached their transcript `user` event yet still
   *  qualify: the mark is installed before the literal write. */
  nativeInputOwner(
    text: string,
    timestampMs: number,
    requireCompleteInput = false,
  ): { turnId: string; dispatchAttempt?: number } | undefined {
    const normalisedText = normaliseForFingerprint(text);
    const candidates = this.queue.filter(turn => {
      if (turn.isLocal || turn.finalText !== undefined || turn.passedBySuccessor) return false;
      if (turn.markTimeMs !== undefined
        && timestampMs < turn.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS) return false;
      // Doubao's request-row parking needs the complete mark, not the shared
      // envelope prefix used by the ordinary CoT attribution side channel.
      // The native row may add provider context around the original input.
      if (requireCompleteInput) {
        return !!turn.nativeInputText && normalisedText.includes(turn.nativeInputText);
      }
      // Mirror the adopt-mode antigravity user event shape: an exact-input mark
      // pairs with an empty alias list so the match is hash-only, never the
      // looser fingerprint containment.
      const event: CodexBridgeEvent = turn.inputTextHash !== undefined
        ? { uuid: '', timestampMs, kind: 'user', text, inputTextAliases: [] }
        : { uuid: '', timestampMs, kind: 'user', text };
      return this.matchesUserInput(turn, event);
    });
    // If zero-injection texts contain one another, the most specific complete
    // input owns the row. Fingerprint fallback deliberately retains FIFO order.
    if (requireCompleteInput) {
      candidates.sort((left, right) => (right.nativeInputText?.length ?? 0) - (left.nativeInputText?.length ?? 0));
    }
    const owner = candidates[0];
    return owner ? { turnId: owner.turnId, ...(owner.dispatchAttempt !== undefined
      ? { dispatchAttempt: owner.dispatchAttempt } : {}) } : undefined;
  }

  ownsTurnForNativeInput(text: string, timestampMs: number, requireCompleteInput = false): boolean {
    return this.nativeInputOwner(text, timestampMs, requireCompleteInput) !== undefined;
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
      if (turn.cliQueuedAtMs !== undefined) return true;
      // Its input is not coming: nothing the CLI does can still be this turn.
      if (turn.passedBySuccessor) return false;
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
    if (this.queue.some(turn => ((turn.started && !this.isProvisionalTaskStart(turn)) || turn.rpcActive
      || turn.cliQueuedAtMs !== undefined)
      && turn.finalText === undefined)) return undefined;
    const activeRemaining = this.queue.flatMap(candidate => {
      if (candidate.finalText !== undefined) return [];
      const leases: number[] = [];
      if (this.isProvisionalTaskStart(candidate)) {
        leases.push(STRUCTURED_TASK_START_CORROBORATION_GRACE_MS
          - (nowMs - candidate.provisionalTaskStartedAtMs!));
        return leases.filter(remaining => remaining >= 0);
      }
      if (candidate.started) return [];
      if (candidate.passedBySuccessor) return [];
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
  /** Register the CoT observer (see field doc). */
  setCotObserver(fn: (entries: readonly CodexCotEntry[], turn: CodexPendingTurn) => void): void {
    this.cotObserver = fn;
  }

  setCotSupersededObserver(fn: (turn: CodexPendingTurn) => void): void {
    this.cotSupersededObserver = fn;
  }

  setMidTurnReplyObserver(fn: (ev: CodexBridgeEvent, turn: CodexPendingTurn) => void): void {
    this.midTurnReplyObserver = fn;
  }

  setTurnStartObserver(fn: (turn: CodexPendingTurn, evidence?: CodexTurnStartEvidence) => void): void {
    this.turnStartObserver = fn;
  }

  /** Process newly-appended events. Idempotent on uuid: events with seen
   *  uuids are skipped, so callers can replay safely. */
  ingest(events: CodexBridgeEvent[]): void {
    this.observeTranscriptEventTimes(events);
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

  /** Refresh queued unstarted submits from the locally-observed terminal edge.
   *  External transcript clocks may be skewed, so lease boundedness must use
   *  this process's clock for both successful and aborted predecessors. Every
   *  unstarted successor that waited behind the completed turn gets its lease
   *  and busy-refresh cap re-anchored to this hand-off time. */
  private refreshNextPreStartLease(): void {
    const observedAtMs = this.now();
    for (const nextPending of this.queue) {
      if (nextPending.started || nextPending.finalText !== undefined || nextPending.passedBySuccessor) continue;
      // RPC turns keep their own rpcActive flag for lifecycle gating; do not
      // overwrite it with a bounded confirmation/attribution lease.
      if (nextPending.rpcActive) continue;
      nextPending.predecessorTerminalAtMs = observedAtMs;
      if (nextPending.submitConfirmedAtMs !== undefined) {
        nextPending.submitConfirmedAtMs = observedAtMs;
      } else {
        nextPending.unconfirmedAttributionStartedAtMs = observedAtMs;
      }
    }
  }

  private revalidateRestoredMerge(turn: CodexPendingTurn, ev: CodexBridgeEvent): void {
    // A pending mark may carry merge evidence from a previous worker. A new
    // provider execution (or missing proof) cannot inherit its send credit.
    if (turn.supersededTurns?.length && (turn.sourceTurnId !== ev.sourceTurnId
      || turn.sourceSessionId !== ev.sourceSessionId)) {
      turn.supersededTurns = undefined;
      turn.steeredMidTurn = undefined;
    }
  }

  private ingestOne(ev: CodexBridgeEvent, bufferUnmatched: boolean): void {
    if (ev.softNewlineInput && this.ambiguousSoftNewlineInputs.has(ev.softNewlineInput)) return;
    // A stable-id replay from a closed turn is never evidence for the current
    // id-less turn. Reject it before any compatibility fallback can run.
    if (ev.sourceTurnId && this.isClosedNativeTurn(ev.sourceSessionId, ev.sourceTurnId)) return;
    if (ev.kind === 'turn_bind') {
      // A provider may expose its stable turn id only in a duplicate user
      // record after an id-less legacy record already started the turn. Bind
      // that id without treating the mirror as another user/steer boundary.
      const target = this.queue.find(turn => turn.started && turn.finalText === undefined
        && turn.sourceTurnId === ev.sourceTurnId
        && this.sourceSessionsCompatible(turn.sourceSessionId, ev.sourceSessionId))
        ?? this.queue.find(turn => turn.started && turn.finalText === undefined
          && !turn.sourceTurnId
          && this.sourceSessionsCompatible(turn.sourceSessionId, ev.sourceSessionId)
          && (turn.transcriptStartTimeMs === undefined
            || ev.timestampMs >= turn.transcriptStartTimeMs));
      if (!target || !ev.sourceTurnId) return;
      if (target.sourceSessionId && ev.sourceSessionId
        && target.sourceSessionId !== ev.sourceSessionId) return;
      target.sourceTurnId = ev.sourceTurnId;
      if (ev.sourceMessageId) target.sourceMessageId = ev.sourceMessageId;
      this.rememberNativeUserMessage(ev);
      return;
    }
    if (ev.kind === 'turn_started') {
      // task_started is an authoritative native lifecycle edge. When the
      // fingerprinted response_item/user is delayed, bind and start the
      // pending head now so its short pre-start attribution lease cannot
      // expire while Codex is demonstrably running the task.
      const active = this.collecting;
      if (active && active.finalText === undefined
        && this.sourceSessionsCompatible(active.sourceSessionId, ev.sourceSessionId)) {
        if (active.sourceTurnId) {
          if (!ev.sourceTurnId || active.sourceTurnId === ev.sourceTurnId) return;
          // Codex can abandon one native task_started id and immediately
          // retry the same logical turn under another id, without ever
          // emitting a terminal for the first. A still-provisional claim has
          // no fingerprint evidence tying it to that abandoned id, so let the
          // new start supersede it and reclaim the same queue head below.
          if (this.isProvisionalTaskStart(active)) {
            this.rollbackProvisionalTaskStart(active);
          } else if (active.supersededTurns?.length
            && active.sourceSessionId === ev.sourceSessionId
            && active.transcriptStartTimeMs !== undefined
            && ev.timestampMs >= active.transcriptStartTimeMs
            // With multiple active turns, refuse a candidate that could make
            // a later user handoff drop an independent reply. Exact native ids
            // still route; if X never terminates, its turn may stay pending.
            && !this.queue.some(turn => turn !== active && turn.started && turn.finalText === undefined)) {
            // A new start can replace the abandoned execution containing the
            // HOL successor. Do not let an unread pending input claim it. If
            // that input's user record arrives, its fingerprint below decides
            // the handoff; otherwise the terminal still belongs to active.
            // This is only a candidate: exact X terminals can still settle active
            // until a valid user handoff removes it or a terminal replaces its id.
            active.replacementNativeTurnId = ev.sourceTurnId;
            return;
          }
        } else {
          // A native start cannot precede the user record of the same turn.
          // Reject stale starts instead of binding them onto an id-less active
          // turn and making its real terminal impossible to route.
          if (active.transcriptStartTimeMs !== undefined
            && ev.timestampMs < active.transcriptStartTimeMs) return;
          if (ev.sourceTurnId) active.sourceTurnId = ev.sourceTurnId;
          if (!active.sourceSessionId && ev.sourceSessionId) active.sourceSessionId = ev.sourceSessionId;
          return;
        }
      }
      const next = this.queue.find(turn => !turn.started && turn.finalText === undefined
        && !turn.passedBySuccessor);
      if (!next) return;
      const tooOld = next.markTimeMs !== undefined
        && ev.timestampMs < next.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS;
      if (tooOld) return;
      this.revalidateRestoredMerge(next, ev);
      next.started = true;
      this.moveAheadOfUnstarted(next);
      next.submitVerificationStartedAtMs = undefined;
      next.unconfirmedAttributionStartedAtMs = undefined;
      next.provisionalTaskStartedAtMs = this.now();
      next.taskStartedRollbackAtMs = undefined;
      next.sourceSessionId = ev.sourceSessionId;
      next.sourceTurnId = ev.sourceTurnId;
      next.markTimeMs = next.markTimeMs === undefined
        ? ev.timestampMs
        : Math.max(next.markTimeMs, ev.timestampMs);
      this.collecting = next;
      return;
    }
    if (ev.kind === 'input_queued') {
      // One accepted input per marker, in submit order. Never starts the
      // head: the work still running belongs to an earlier turn.
      const next = this.queue.find(turn => !turn.started && turn.finalText === undefined
        && turn.cliQueuedAtMs === undefined && !turn.rpcActive && !turn.passedBySuccessor);
      if (!next) return;
      if (next.markTimeMs !== undefined
        && ev.timestampMs < next.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS) return;
      next.cliQueuedAtMs = this.now();
      return;
    }
    if (ev.kind === 'cli_settled') {
      // Queued input is taken up before the CLI settles. A head still held
      // here went back to the editor (abort) or was otherwise dropped, so its
      // normal lease runs again from now.
      const observedAtMs = this.now();
      for (const turn of this.queue) {
        if (turn.cliQueuedAtMs === undefined || turn.started || turn.finalText !== undefined) continue;
        turn.cliQueuedAtMs = undefined;
        if (turn.submitConfirmedAtMs !== undefined) turn.submitConfirmedAtMs = observedAtMs;
        else turn.unconfirmedAttributionStartedAtMs = observedAtMs;
      }
      return;
    }
    if (ev.kind === 'cot') {
      // Cosmetic thinking-timeline record. Only meaningful while a turn is
      // collecting; history replay / unmatched events are dropped (never
      // buffered — a late replay into the wrong turn is worse than a gap).
      const target = this.targetForNativeEvent(ev);
      if (!target) return;
      // Native tool rows can flush after a stop but before the next submit.
      // A parse-time timestamp must not turn those old bytes into new work.
      if (ev.progressCursor && ev.progressCursor.jsonlPath === target.recoveryJsonlPathAtMark
        && target.recoveryOffsetAtMark !== undefined
        && ev.progressCursor.offset < target.recoveryOffsetAtMark) return;
      if (target.sourceSessionId && ev.sourceSessionId && target.sourceSessionId !== ev.sourceSessionId) return;
      if (this.midTurnReplyObserver) {
        try { this.midTurnReplyObserver(ev, target); } catch { /* observer channel — never break attribution */ }
      }
      if (this.cotObserver && ev.cotEntries && ev.cotEntries.length > 0) {
        if (!target.sourceTurnId && ev.sourceTurnId) target.sourceTurnId = ev.sourceTurnId;
        try { this.cotObserver(ev.cotEntries, target); } catch { /* cosmetic channel — never break attribution */ }
      }
      return;
    }
    if (ev.kind === 'user') {
      const messageKey = this.nativeUserMessageKey(ev);
      if (messageKey && this.seenNativeUserMessages.has(messageKey)) return;
      // task_started can precede the response_item/user by well over the
      // pre-start lease. When that delayed record matches the already-started
      // collecting turn, treat it as corroborating metadata rather than a new
      // turn boundary. Preserve markTimeMs: in-turn botmux sends may have
      // landed after task_started but before this late user record.
      const collecting = this.collecting;
      const provisional = this.isProvisionalTaskStart(collecting)
        && this.sourceSessionsCompatible(collecting?.sourceSessionId, ev.sourceSessionId)
        ? collecting
        : null;
      if (provisional) {
        const collectingTooOld = provisional.markTimeMs !== undefined
          && ev.timestampMs < provisional.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS;
        // Adopt: another unstarted mark is this record's whole input, so the
        // native start belongs to that input and the claim sits on one that
        // never arrived. A prefix-only match (both open with the same link)
        // must not corroborate the claim then; the rollback below lets the
        // claimed head be passed.
        const wholeInputElsewhere = this.wholeInputSuccessor(ev, [provisional]) !== undefined;
        const exactUserInputMatch = this.exactlyMatchesUserInput(provisional, ev);
        const collectingFingerprintOk = this.matchesUserInput(provisional, ev)
          && (exactUserInputMatch || !wholeInputElsewhere);
        if (!collectingTooOld && collectingFingerprintOk) {
          provisional.transcriptStartTimeMs = ev.timestampMs;
          provisional.sourceMessageId = ev.sourceMessageId;
          this.rememberNativeUserMessage(ev);
          provisional.provisionalTaskStartedAtMs = undefined;
          provisional.taskStartedRollbackAtMs = undefined;
          provisional.exactUserInputMatch = exactUserInputMatch;
          provisional.nativeUserProof = { uuid: ev.uuid, hash: createHash('sha256').update(ev.text).digest('hex'), timestampMs: ev.timestampMs };
          if (!provisional.sourceSessionId && ev.sourceSessionId) {
            provisional.sourceSessionId = ev.sourceSessionId;
          }
          if (!provisional.sourceTurnId && ev.sourceTurnId) {
            provisional.sourceTurnId = ev.sourceTurnId;
          }
          // Corroboration is the turn's own user record: the same evidence a
          // direct start reports, so in-flight input is not re-delivered to a
          // resumed CLI that already holds it.
          try { this.turnStartObserver?.(provisional, { exactUserInputMatch }); } catch { /* observer only */ }
          return;
        }
        // In non-adopt mode an unmatched user record may only be transcript
        // scaffolding (AGENTS/environment) written before the real prompt, so
        // it is not evidence of a competing turn. Keep the provisional claim
        // until its exact terminal, a distinct native start, or the bounded
        // corroboration timeout releases it. Adopt mode can synthesize a real
        // local turn from the mismatch and must roll back immediately.
        if (!collectingTooOld && this.localTurnsEnabled) {
          this.rollbackProvisionalTaskStart(provisional);
        }
      }
      // Some providers mirror one native user turn in more than one record.
      // Without a native message id retain the historical turn-level mirror
      // guard. A previously unseen message id is a genuine same-turn steer;
      // its fingerprint/freshness checks below still decide whether it starts.
      // A task_started-only claim is not a corroborated user record. It must
      // not hide the fingerprinted successor that actually owns this native
      // turn when an older, missing input temporarily claimed the start.
      if (ev.sourceTurnId && !messageKey && this.queue.some(turn => turn.started
        && !this.isProvisionalTaskStart(turn)
        && turn.sourceTurnId === ev.sourceTurnId)) return;
      // First decide whether this user event is a REAL turn-start: either it
      // matches the head pending Lark turn's fingerprint (and isn't tooOld),
      // or a later mark's whole input (passing a head that never arrived, see
      // userRecordOwner), or — in adopt mode — it synthesises a local turn.
      // Both the HOL-drop and the actual start key off this decision.
      const { next, passed } = this.userRecordOwner(ev);
      const tooOld = !!next && next.markTimeMs !== undefined && ev.timestampMs < next.markTimeMs - UNMATCHED_REPLAY_WINDOW_MS;
      const rawMatch = !!next && !tooOld && this.matchesUserInput(next, ev);
      const softNewlineMatch = next && !tooOld && !rawMatch ? this.matchSoftNewlineInput(next, ev) : undefined;
      // Buffering cannot resolve two possible owners: cancelling or expiring
      // one mark would let the other claim the same ambiguous record on replay.
      if (softNewlineMatch === 'ambiguous' && ev.softNewlineInput) {
        this.ambiguousSoftNewlineInputs.add(ev.softNewlineInput);
        return;
      }
      const willStartNext = rawMatch || softNewlineMatch === 'matched';
      const willSynthLocal = !willStartNext && this.localTurnsEnabled && ev.timestampMs >= this.localLowerBoundMs - UNMATCHED_REPLAY_WINDOW_MS;
      if (willStartNext) this.revalidateRestoredMerge(next!, ev);

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
      // A same-session replacement candidate permits a valid user handoff below.
      // Once that handoff removes the old HOL successor, late X terminals cannot
      // settle that removed turn; X's receipt credit is not inherited by Y.
      // This treats X as abandoned, assuming no separate X answer is still owed.
      // The handoff does not tombstone X: a late terminal may still be absorbed
      // by a later started turn lacking a native id. This unhandled ordering
      // boundary is synthetically reachable, without production evidence (#2707).
      const isDistinctNativeTurn = !!ev.sourceTurnId
        && !!this.collecting?.sourceTurnId
        && ev.sourceTurnId !== this.collecting.sourceTurnId
        && !(this.collecting.replacementNativeTurnId === ev.sourceTurnId
          && this.collecting.sourceSessionId === ev.sourceSessionId);
      if ((willStartNext || willSynthLocal)
        && this.collecting
        && this.collecting.finalText === undefined
        && !this.isProvisionalTaskStart(this.collecting)
        && !isDistinctNativeTurn
        && ev.preserveCollecting !== true) {
        const superseded = this.collecting;
        if (willStartNext && ev.sourceTurnId && ev.sourceTurnId === superseded.sourceTurnId
          && ev.sourceSessionId === superseded.sourceSessionId
          && this.sourceSessionsCompatible(superseded.sourceSessionId, ev.sourceSessionId)) {
          next!.supersededTurns = [...(superseded.supersededTurns ?? []),
            { turnId: superseded.turnId, dispatchAttempt: superseded.dispatchAttempt }];
          next!.steeredMidTurn = true;
        }
        const idx = this.queue.indexOf(superseded);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.collecting = null;
        if (idx >= 0) {
          try { this.cotSupersededObserver?.(superseded); } catch { /* cosmetic only */ }
        }
      }

      if (willStartNext) {
        const exactUserInputMatch = this.exactlyMatchesUserInput(next!, ev);
        next!.started = true;
        next!.exactUserInputMatch = exactUserInputMatch;
        next!.passedBySuccessor = undefined;
        next!.restoredPassedRevivalUntilMs = undefined;
        for (const turn of passed) {
          turn.passedBySuccessor = true;
          turn.restoredPassedRevivalUntilMs = undefined;
        }
        this.moveAheadOfUnstarted(next!);
        next!.submitVerificationStartedAtMs = undefined;
        next!.unconfirmedAttributionStartedAtMs = undefined;
        next!.cliQueuedAtMs = undefined;
        next!.provisionalTaskStartedAtMs = undefined;
        next!.taskStartedRollbackAtMs = undefined;
        next!.sourceSessionId = ev.sourceSessionId;
        next!.sourceTurnId = ev.sourceTurnId;
        next!.sourceMessageId = ev.sourceMessageId;
        this.rememberNativeUserMessage(ev);
        next!.transcriptStartTimeMs = ev.timestampMs;
        next!.nativeUserProof = { uuid: ev.uuid, hash: createHash('sha256').update(ev.text).digest('hex'), timestampMs: ev.timestampMs };
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
        try { this.turnStartObserver?.(next!, { exactUserInputMatch }); } catch { /* observer only */ }
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
          transcriptStartTimeMs: ev.timestampMs,
          sourceSessionId: ev.sourceSessionId,
          sourceTurnId: ev.sourceTurnId,
          sourceMessageId: ev.sourceMessageId,
        };
        const insertAt = this.queue.findIndex(t => !t.started);
        if (insertAt === -1) this.queue.push(localTurn);
        else this.queue.splice(insertAt, 0, localTurn);
        this.collecting = localTurn;
        this.rememberNativeUserMessage(ev);
        this.onLocalTurnStarted?.(localTurn);
      } else if (bufferUnmatched && !this.localTurnsEnabled) {
        // Cursor can write the Lark/user line to JSONL before the daemon IPC
        // that marks the turn reaches this worker. Keep a tiny recent buffer
        // so mark() can replay it instead of losing the line to `seen`.
        this.rememberUnmatched(ev);
      }
    } else if (ev.kind === 'assistant_final') {
      const provisional = this.matchingProvisionalTaskStart(ev);
      if (provisional) {
        // A terminal before fingerprint corroboration proves that this native
        // turn must not settle the pending Lark mark. Roll back immediately;
        // the terminal is intentionally not buffered onto another turn.
        this.rollbackProvisionalTaskStart(provisional);
        if (!this.hasCorroboratedNativeTurn(ev)) return;
      }
      const target = this.targetForNativeEvent(ev);
      if (target) {
        if (target.sourceSessionId && ev.sourceSessionId && target.sourceSessionId !== ev.sourceSessionId) return;
        if (!target.sourceTurnId && ev.sourceTurnId) target.sourceTurnId = ev.sourceTurnId;
        target.finalText = ev.text;
        target.replyModel = ev.replyModel;
        target.replyReasoningEffort = ev.replyReasoningEffort;
        target.terminalStatus = ev.terminalStatus;
        target.terminalErrorCode = ev.terminalErrorCode;
        target.terminalErrorSummary = ev.terminalErrorSummary;
        this.rememberClosedNativeTurn(target);
        this.lastClosedAssistantFinalTimeMs = ev.timestampMs;
        if (this.collecting === target) this.collecting = null;
        // CoCo-style type-ahead writes the next user event only after this
        // final dequeues it. Refresh the next turn's pre-start lease at that
        // hand-off boundary instead of letting either its confirmed lease or
        // attribution-only lease expire while the predecessor was legitimately
        // running.
        this.refreshNextPreStartLease();
      } else if (bufferUnmatched && !this.localTurnsEnabled && !this.hasRolledBackTaskStart()) {
        this.rememberUnmatched(ev);
      }
    } else if (ev.kind === 'turn_aborted') {
      const provisional = this.matchingProvisionalTaskStart(ev);
      if (provisional) {
        this.rollbackProvisionalTaskStart(provisional);
        if (!this.hasCorroboratedNativeTurn(ev)) return;
      }
      const target = this.targetForNativeEvent(ev);
      if (!target) {
        if (bufferUnmatched && !this.localTurnsEnabled && !this.hasRolledBackTaskStart()) {
          this.rememberUnmatched(ev);
        }
        return;
      }
      if (target.sourceSessionId && ev.sourceSessionId && target.sourceSessionId !== ev.sourceSessionId) return;
      if (!target.sourceTurnId && ev.sourceTurnId) target.sourceTurnId = ev.sourceTurnId;
      // Interrupted Codex turns have no assistant_final. Close with empty text
      // so the worker skips final_output but still publishes the authoritative
      // exact-attempt turn_terminal required by reliable durable delivery.
      // Side effects may already have happened, so mirror TRAE-X and classify
      // an otherwise-untyped abort as ambiguous rather than completed/failed.
      target.finalText = '';
      target.terminalStatus = ev.terminalStatus ?? 'ambiguous';
      target.terminalErrorCode = ev.terminalErrorCode ?? 'structured_turn_aborted';
      this.rememberClosedNativeTurn(target);
      if (this.collecting === target) this.collecting = null;
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

  restoreDrained(turns: readonly CodexPendingTurn[]): void {
    const retained = new Set(this.queue);
    this.queue.unshift(...turns.filter(turn => !retained.has(turn)));
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
