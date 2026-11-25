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
  normaliseTranscriptFingerprintCandidates,
  isClaudeApiRequestBlob,
  isMeaningfulUserEvent,
  isMeaningfulQueuedCommand,
  isMidTurnAbsorbedQueuedCommand,
  isScheduledTurnStartEvent,
  cronCreateToolUseIds,
  cronCreateAcks,
  isPureToolResultUserEvent,
  extractTurnStartText,
  isClaudeTurnTerminalEvent,
  isClaudeTurnDurationEvent,
  isClaudeUserInterruptEvent,
  isSyntheticUserPrefixEvent,
  assistantToolUseIds,
  userToolResultIds,
  isMainThreadApiRequestEvent,
  isIntraTurnAttachmentEvent,
  eventTimeMs,
  hasTranscriptRole,
  backgroundTaskLaunches,
  backgroundTaskSettledIds,
  parseTaskNotification,
  isTranscriptRateLimitEvent,
  isSyntheticAssistantRecord,
  isSyntheticNoModelReplyEvent,
  classifyClaudeTerminalEvent,
  apiErrorMessageText,
  AbsorbedReplyCollector,
  type BackgroundTaskKind,
  type BackgroundTaskLaunch,
  type ParsedTaskNotification,
  type ClaudeTerminalOutcome,
  type TranscriptEvent,
} from './claude-transcript.js';
import type { ClaudeOpenTurnQueueEvidence } from './claude-open-turn-watchdog.js';

// Re-export so existing callers (worker.ts, tests) don't need to change
// their import path now that these helpers live in claude-transcript.ts.
export { normaliseForFingerprint };

/** How long the worker's provisional-exit watchdog waits for a fresh turn's
 *  closing records when NO idle edge ever fires (a background task can keep
 *  program-status `working`, and stale status keeps waiting). Same bound as
 *  the idle-edge settle: closing records normally land ~90-140ms after the
 *  terminal record. */
export const PROVISIONAL_EXIT_WATCH_MS = 2_000;

function assistantHasVisibleText(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0);
}

export interface BridgePendingTurn {
  turnId: string;
  dispatchAttempt?: number;
  linkRefMode?: 'observe' | 'enabled';
  started: boolean;
  /** True only when the transcript user/queued_command record's untouched
   *  legacy-normalised text contained the entire normalised marked content
   *  (never prefix-only, residue-only, truncation, or unfingerprinted binds). */
  fullContentMatch?: boolean;
  /** Strict whole-string equality against the normalised marked content (or its
   *  sanitized/submitted exact variants). Unlike fullContentMatch (substring),
   *  prevents short prompts like "ok" from matching unrelated longer inputs. */
  exactContentMatch?: boolean;
  /** Additional normalised exact-match targets (e.g. sanitized Claude input or
   *  catalog-appended submitted text) checked with strict whole-string equality. */
  extraExactContents?: readonly string[];
  assistantUuids: string[];
  /** An authoritative transcript boundary closed this turn. Durable turns may
   * never settle from screen-idle alone; worker terminal emission requires
   * this bit (or an explicit failure/exit/ambiguous outcome outside the
   * transcript's completion evidence). */
  terminalObserved?: boolean;
  /** The latest terminal evidence is an assistant record's stop_reason that no
   * `system/turn_duration` has confirmed yet. Claude Code stamps EVERY content
   * block record with its message's stop reason, so the thinking block of a
   * final message reads `end_turn` while the text block, an API error that cut
   * the stream and the Stop hooks may all still follow. See drainEmittable. */
  awaitingDurationMarker?: boolean;
  /** Its `system/turn_duration` was read: the turn's last record. Anything the
   *  assistant writes after it belongs to the next turn. */
  closedByDurationMarker?: boolean;
  /** Structured execution result. This is independent from whether transcript
   * fallback text is visible or suppressed by a prior `botmux send`. */
  terminalOutcome?: Exclude<ClaudeTerminalOutcome, { status: 'rate_limited' }>;
  /** Transcript timestamp of the record that set a non-completed
   * terminalOutcome. Tells a failure the worker watched happen from one it is
   * replaying out of an earlier generation's history. */
  terminalOutcomeAtMs?: number;
  /** Text of the API-error record that set a non-completed terminalOutcome
   *  (unmasked; the worker masks and clips it before it leaves). */
  terminalErrorDetail?: string;
  /** Transcript time of the last real model reply this queue read before the
   *  record that set a non-completed terminalOutcome — the last request the
   *  provider answered, i.e. when its prompt cache was last refreshed. It may
   *  belong to an earlier turn (a turn whose first request failed). Absent
   *  when no reply was read since this queue started (e.g. right after a
   *  worker restart, whose baseline skips history). */
  terminalProviderLastSuccessAtMs?: number;
  /** Structured 429 observed for this turn. It remains owned by the existing
   * limited/reset path and must not be converted into ordinary ambiguity when
   * the following turn_duration closes the transcript boundary. */
  rateLimited?: boolean;
  /** Set when this turn was synthesised from a local-terminal user event
   *  (no matching Lark fingerprint). Causes the worker emit path to format
   *  the Lark message with both user text and assistant text under a
   *  "🖥️ 终端本地对话" header — otherwise the user would see an orphan
   *  reply with no prompt for context. Lark-driven turns keep this unset. */
  isLocal?: boolean;
  /** Set for a turn opened by Claude Code's BUILT-IN scheduler
   *  (CronCreate): the opening user record is `isMeta:true` with
   *  `turnOrigin:"scheduled"`. Such a turn stays `isLocal` (no Lark
   *  fingerprint, no CoT card, no durable journal), but unlike terminal
   *  typing its final answer is auto-forwarded to the originating Lark
   *  thread — the fire was scheduled on the user's behalf. Explicit
   *  `botmux send` dedup and BOTMUX_NOTHING_TO_SEND silence still apply. */
  isScheduled?: boolean;
  /** Set on a headless turn that a LIVE main-thread `<task-notification>`
   *  opened: a background task (Bash `run_in_background`, background Agent,
   *  Monitor) launched inside a Lark turn finished and Claude answered on its
   *  own. Otherwise an ordinary headless local turn (same id, same
   *  failure-notice anchoring); only the worker's transcript-delivery path
   *  forwards its final, to {@link replyAnchorTurnId}. Claude queue only. */
  isBackgroundWake?: boolean;
  /** Set instead of {@link isBackgroundWake} when the notices that opened this
   *  headless turn resolve to no single launching Lark turn (different topics,
   *  or one task without an anchor). The turn stays an ordinary local turn;
   *  the flag only lets the worker log why a transcript-mode wake was not
   *  forwarded. */
  backgroundWakeUnrouted?: boolean;
  /** Lark turn id this scheduled turn's final should anchor to (chat-scope
   *  topic routing). Captured as the latest marked Lark turn at fire time.
   *  Unused in thread scope, where the session root is the anchor. For a
   *  background wake: the Lark turn that launched the task. */
  replyAnchorTurnId?: string;
  /** Durable dispatch attempt of {@link replyAnchorTurnId} when the launching
   *  Lark turn carried one. Keeps CoT forwarding on the exact `turnId|attempt`
   *  key of the launching turn instead of superseding its live CoT bubble. */
  replyAnchorDispatchAttempt?: number;
  /** Set ONLY on a headless local turn opened by `<task-notification>` when
   *  EVERY notice opening or folded into the turn (pre-synthesis and mid-turn)
   *  is a system-origin non-terminal, non-expiry, non-expired event from a
   *  known non-persistent (`persistent === false`) Monitor, with no mid-turn
   *  human prompt folded in. Fail-open (unset) for all other turns. */
  wakeNonTerminalMonitor?: true;
  /** Sticky CoT anchor that actually received leading `thinking_update`
   *  entries before this wake turn was synthesised or unrouted. Lets Loop 2
   *  flush buffered anchor CoT even if `replyAnchorTurnId` was later cleared. */
  cotAnchor?: BackgroundTaskAnchor;
  /** Monitor task ids that opened this headless wake (used to disarm
   *  `wakeNonTerminalMonitor` if any of them is killed mid-wake). */
  monitorWakeTaskIds?: Set<string>;
  /** Transcript uuid of the user event that started this turn. Stored for
   *  local turns so emit can fetch the user-typed content from the source
   *  jsonl alongside the assistant uuids. Lark turns don't need it because
   *  the user content is already known on the daemon side. */
  userUuid?: string;
  /** A late text block after an empty terminal still belongs to the same
   * native local input; reuse its captured reply address. */
  replyContextTurnId?: string;
  /** Local turns only: the Lark turn that most recently started before this
   * one was synthesised — where a failure notice for it is anchored. */
  precedingLarkTurnId?: string;
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
  /** When Claude's own transcript recorded this input entering its type-ahead
   *  queue (`queue-operation enqueue`). While it sits there the mark is not
   *  stranded: see {@link isHeldInCliQueue}. */
  cliQueuedAtMs?: number;
  /** When the input left that queue (`dequeue` / `remove`), or the queue stopped
   *  being observable. The record that binds the mark follows right behind, so
   *  the normal TTL runs again from here. */
  cliQueueReleasedAtMs?: number;
  /** The worker is still typing / submitting this input. A mark is not
   *  stranded while its own write is running: under tmux overload a long
   *  chunked write can outlast the TTL, and expiring it then would leave the
   *  reply that follows the eventual submit without a Lark turn. */
  writeInFlight?: boolean;
  /** When that write settled; the TTL runs from here like from a queue release. */
  writeSettledAtMs?: number;
  /** Last prune at which an earlier turn was still running when this mark was
   *  pending. Claude Code persists the queue records of type-ahead input only
   *  when the running turn next writes to its transcript (observed: enqueue
   *  lines first appearing 3m40s late, together with the dequeue), so a busy
   *  CLI is itself proof the input cannot have been consumed yet. The normal
   *  TTL runs again from the moment the CLI stopped being busy. */
  heldWhileBusyAtMs?: number;
  /** Set when this mark was re-created from the durable turn journal after a
   *  worker/daemon restart interrupted the turn. The emit path prefixes the
   *  delivered fallback with an "interrupted by restart" notice so the user
   *  can tell a recovered partial answer from a live one. */
  restoredFromJournal?: boolean;
  /** A turn carried out of an older transcript when an in-process rotation
   *  was discovered (/clear, /resume, pid/fingerprint switch). Its missing
   *  marker belongs to the old writer and can never arrive on the new file,
   *  so releasing it must not teach the CURRENT generation it is marker-less. */
  carriedAcrossGeneration?: boolean;
  /** Observed at least one non-error assistant event (including tool calls). */
  hasAssistantActivity?: boolean;
  /** Per-turn monotonic counter bumped whenever a non-sidechain, non-error
   *  assistant record is attributed to the turn while it is collecting. The
   *  worker's no-idle watchdog snapshots it when arming and restarts its bound
   *  whenever it grows: a final message flushed block-by-block seconds apart
   *  (every block stamped with the terminal stop_reason) must be measured from
   *  the LAST block ("transcript quiet 2s"), not from the first one. */
  attributedActivitySeq?: number;
  /** Set on a Lark turn whose input Claude Code folded into the turn already
   *  running (a mid-turn system reminder) instead of starting its own. It has
   *  no reply of its own and ends when that turn ends — see `absorbedTurns`. */
  absorbedIntoTurnId?: string;
  /** uuid of the `attachment(queued_command)` record that folded this turn's
   *  input into the host turn: where its reply starts in the transcript (see
   *  absorbedInputReplyText). Set together with `absorbedIntoTurnId`. */
  absorbedAtUuid?: string;
  /** Host assistant-activity sequence when this input was folded. Two folds
   *  with the same sequence have no output boundary between them. */
  absorbedActivitySeqAtFold?: number;
  /** Multiple inputs share one uninterrupted output segment, so the next
   *  output cannot be attributed to this later input without guessing. */
  absorbedReplyAmbiguous?: boolean;
  /** The worker handed this folded turn's reply to the daemon. The host still
   *  carries its text unless actual delivery is confirmed, and a failure the
   *  host meets afterwards is not this turn's. */
  absorbedReplySent?: boolean;
  /** The daemon confirmed the live card's actual POST. Distinct from IPC
   *  handoff: a failed host may settle on a confirmed reply, but an unconfirmed
   *  one still needs its own final fallback. */
  absorbedReplyDelivered?: boolean;
  /** Records whose text is known to have gone out whole as this folded turn's
   *  live reply (empty for a thinking summary, a reply too long for one card,
   *  or a delivery not confirmed by the daemon). They are the host turn's
   *  records too, so the host's own final leaves them out — see
   *  liveFoldedReplyUuids. */
  absorbedReplyTextUuids?: string[];
  /** Records the host turn's final carried whole into the chat this folded
   *  message came from (noteHostFinalCarried). An answer among them is not
   *  posted to this turn again. Kept on the turn, so an emit retried after a
   *  throw still knows. */
  absorbedHostFinalUuids?: ReadonlySet<string>;
  /** The live check for this folded turn's reply has run (see
   *  takeAbsorbedReplyCandidates); whatever it found, it does not run again. */
  absorbedLiveChecked?: boolean;
  /** Lark turns folded into this one. They leave the queue right behind it and
   *  share its terminal, so each still gets the end signal its card waits for. */
  absorbedTurns?: BridgePendingTurn[];
}

/** Upper bound on holding a mark for an input in Claude's own queue. The queue
 *  normally lets go at the next tool boundary or turn end (longest seen: 27
 *  minutes), and the hold also ends when Claude returns to its prompt. The bound
 *  covers an input dropped without any record while Claude stays busy: a stale
 *  mark at the queue head keeps later Lark turns from binding. */
export const CLI_QUEUE_HOLD_MAX_MS = 30 * 60_000;
/** Same allowance as the fingerprint scan's floor: an enqueue record is written
 *  after the mark, but clocks and write order can differ slightly. */
const CLI_QUEUE_MARK_SKEW_MS = 5_000;
/** Background-task launch anchors kept per queue (oldest evicted first). */
const BACKGROUND_TASK_ANCHORS_MAX = 256;
/** Background-task launch metadata entries kept per queue (oldest evicted first). */
const BACKGROUND_TASK_META_MAX = 512;

export interface BackgroundTaskAnchor {
  turnId: string;
  dispatchAttempt?: number;
}

export interface BackgroundTaskLaunchMeta {
  kind: BackgroundTaskKind;
  persistent?: boolean;
  expiresAtMs?: number;
}

/** Read-only side-channel observer for leading thinking/tool records during an
 *  armed non-terminal Monitor wake BEFORE the first visible text block (and for
 *  text-less Monitor wakes that close at `turn_duration` with no visible text). */
export interface PendingWakeCotObserver {
  onActivity?: (ev: TranscriptEvent, anchor: BackgroundTaskAnchor) => void;
  onTextlessComplete?: (anchor: BackgroundTaskAnchor) => void;
}

interface PendingBackgroundWake {
  anchor: BackgroundTaskAnchor | null;
  nonTerminalMonitor: boolean;
  hasAssistantActivity: boolean;
  /** Sticky anchor that already received at least one `onActivity` CoT event. */
  emittedAnchorCot?: BackgroundTaskAnchor;
  /** Non-terminal Monitor task ids observed in this armed wake. */
  monitorTaskIds: Set<string>;
}

function sameBackgroundTaskAnchor(
  a: BackgroundTaskAnchor | undefined | null,
  b: BackgroundTaskAnchor | undefined | null,
): boolean {
  return !!a && !!b && a.turnId === b.turnId && a.dispatchAttempt === b.dispatchAttempt;
}

/** Change detector for the worker's `background_task_pins_sync` snapshots
 *  (see BridgeTurnQueue.backgroundTaskAnchorTurnIds). It starts as "never
 *  sent", so a worker's first snapshot goes out even when empty: a takeover
 *  installs the new worker before the old one's exit is handled, and the
 *  daemon's exit cleanup then skips the pins the old worker left — this first
 *  snapshot replaces them. */
export class BackgroundTaskPinSnapshot {
  private sent: string | undefined;

  /** Whether `turnIds` differs from the last snapshot marked sent. */
  changed(turnIds: readonly string[]): boolean {
    return turnIds.join('\n') !== this.sent;
  }

  /** Record `turnIds` as delivered to the daemon. */
  markSent(turnIds: readonly string[]): void {
    this.sent = turnIds.join('\n');
  }
}

/** Minimum gap between the worker's sibling-jsonl fingerprint fallback scans
 *  for one mark. 10s is far wider than the milliseconds Claude needs to write
 *  a normal user line, and the fallback only runs after the primary jsonl scan
 *  already missed the line — i.e. Claude rotated via `/clear` / `/resume`,
 *  which happens hours apart, so the delay is invisible. */
export const BRIDGE_FINGERPRINT_SCAN_MIN_INTERVAL_MS = 10_000;
/** A held mark is proven to wait inside Claude's queue, so its fallback runs
 *  even less often — but not never: an in-pane `/clear` while the input waits
 *  moves it to another file. Must stay strictly larger than the normal gap. */
export const BRIDGE_HELD_FINGERPRINT_SCAN_MIN_INTERVAL_MS = 60_000;

/** The mark is being held past the normal TTL: either Claude's transcript shows
 *  the input in its queue, or it was pending while an earlier turn was still
 *  running. Either way the rotation fallback scan only needs the rare cadence. */
export function isHeldPendingMark(turn: BridgePendingTurn): boolean {
  return !turn.started && (isHeldInCliQueue(turn) || turn.heldWhileBusyAtMs !== undefined);
}

/** Inputs folded into `host` whose reply `ev` may have completed. Feeds `ev` —
 *  the next record attributed to the running host turn — to the collector of
 *  each folded turn not yet checked, and returns the turns whose collector now
 *  reports a complete, non-empty reply, marking them `absorbedLiveChecked` so
 *  each is returned once. This is only the moment to look: the worker reads
 *  the reply itself from the transcript (absorbedInputReplyText), because a
 *  collector misses whatever the transcript reader ingested without this
 *  observer, and it never sees the records that bound a reply (a later fold,
 *  the turn's duration marker). A turn not answered live is answered when its
 *  host turn ends. `collectors` holds the per-turn state between calls. */
export function takeAbsorbedReplyCandidates(
  host: BridgePendingTurn,
  ev: TranscriptEvent,
  collectors: WeakMap<BridgePendingTurn, AbsorbedReplyCollector>,
): BridgePendingTurn[] {
  const due: BridgePendingTurn[] = [];
  for (const absorbed of host.absorbedTurns ?? []) {
    if (absorbed.absorbedLiveChecked || absorbed.absorbedReplySent || !absorbed.absorbedAtUuid) continue;
    let collector = collectors.get(absorbed);
    if (!collector) {
      collector = new AbsorbedReplyCollector();
      collectors.set(absorbed, collector);
    }
    if (!collector.feed(ev)) continue;
    absorbed.absorbedLiveChecked = true;
    due.push(absorbed);
  }
  return due;
}

/** Records the host turn's own final leaves out: their text already went out,
 *  live, as the reply to an input folded into it (absorbedReplyTextUuids).
 *  Claude Code writes that reply inside the host turn, so a final joined from
 *  all of the host's text would post it a second time — word for word when it
 *  is all the host said before an idle edge cut it. A reply still unsent when
 *  the host ends is not left out: the host's final carries it instead. */
export function liveFoldedReplyUuids(host: BridgePendingTurn): Set<string> {
  const uuids = new Set<string>();
  for (const folded of host.absorbedTurns ?? []) {
    if (!folded.absorbedReplySent) continue;
    for (const uuid of folded.absorbedReplyTextUuids ?? []) uuids.add(uuid);
  }
  return uuids;
}

/** The host turn's final went out carrying `records`, `whole` or cut short.
 *  Each input folded into it may then settle on that final instead of posting
 *  its answer again (absorbedHostFinalUuids) — but only when the final went
 *  out whole into the chat the folded message came from: a Lark message turn
 *  (`om_…`) or a terminal-typed turn mirrored there. A trigger's or a
 *  schedule's final may go elsewhere (an HTTP caller, a doc, nowhere). */
export function noteHostFinalCarried(
  host: BridgePendingTurn,
  records: readonly TranscriptEvent[],
  whole: boolean,
): void {
  if (!whole || !host.absorbedTurns?.length) return;
  if (!host.turnId.startsWith('om_') && !(host.isLocal && !host.isScheduled)) return;
  const uuids = new Set<string>();
  for (const ev of records) if (ev.uuid) uuids.add(ev.uuid);
  for (const folded of host.absorbedTurns) folded.absorbedHostFinalUuids = uuids;
}

/** Claude's own transcript proves this input is waiting in its queue. There is
 *  nothing to search other transcripts for, and no reason to expire the mark:
 *  the record that binds it arrives when Claude takes the input. */
export function isHeldInCliQueue(turn: BridgePendingTurn): boolean {
  return turn.cliQueuedAtMs !== undefined && turn.cliQueueReleasedAtMs === undefined;
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

/** Minimum tail length (normalised chars) required for a truncation-proof
 *  match. A non-trivial length floor so a very short surviving tail can't
 *  coincide with an unrelated short local prompt. This is a length gate, NOT a
 *  uniqueness/entropy claim — the actual proof is the SUFFIX anchor below. */
const TRUNCATION_MATCH_MIN_CHARS = 16;

/** Capability-agnostic proof that a recorded transcript user line is THIS
 *  turn's user event even though its head-substring fingerprint didn't match.
 *
 *  claude-code TRUNCATES the leading envelope lines (`<user_message>` +
 *  `<botmux_task …>`) when persisting the user turn, so the head fingerprint is
 *  gone — but the surviving text is exactly the TAIL of what we sent, i.e. a
 *  contiguous SUFFIX of the mark's full normalised content. We anchor the proof
 *  to that observed invariant with `endsWith`, NOT a loose `includes`: an
 *  interior substring (a command like `run pnpm test --project unit`, or the
 *  bare closing tags `</botmux_task> </user_message>`) that happens to appear
 *  in the middle of the task body is NOT a suffix, so a Web Terminal operator
 *  typing such a phrase can't spoof this and steal the pending durable mark
 *  (the interior-substring false-match codex demonstrated on PR #724). Length
 *  (16) is a floor, not the proof — the suffix anchor is. Proof is by CONTENT
 *  shape, not session type (apiOnly/adopt), so it holds regardless of whether
 *  the session can mint a Web Terminal write token.
 *
 *  `recordedNorm` and `markContentNorm` are both already normaliseForFingerprint'd.
 *  Guards: require a real mark content, a recorded tail of at least
 *  TRUNCATION_MATCH_MIN_CHARS, and a strict suffix match.
 *
 *  NOTE: if a future claude-code build stops truncating at the head (recorded
 *  line no longer a suffix of what we sent), this correctly returns false and
 *  the turn falls back to local-synth — never a wrong-mark bind. Re-proving a
 *  non-suffix truncation would need a truncation-surviving turn nonce/closing
 *  marker, not a relaxed substring test. */
export function isTruncatedMatch(recordedNorm: string, markContentNorm?: string): boolean {
  if (!markContentNorm || markContentNorm.length === 0) return false;
  if (recordedNorm.length < TRUNCATION_MATCH_MIN_CHARS) return false;
  return markContentNorm.endsWith(recordedNorm);
}

interface TranscriptMarkMatch {
  /** Any transcript candidate contains the short mark fingerprint. */
  fingerprintMatch: boolean;
  /** Any transcript candidate contains the entire legacy-normalised mark. */
  anyFullContentMatch: boolean;
  /** Any transcript candidate is a provable truncation of the mark. */
  truncationMatch: boolean;
  /** Only the untouched legacy candidate can prove native consumption. */
  legacyFullContentMatch: boolean;
  /** Strict whole-string equality on the untouched legacy candidate against the
   *  normalised mark (or its exact submitted/sanitized variants). */
  legacyExactContentMatch: boolean;
  /** A bind that exists only because the residue candidate was considered. */
  residueOnlyMatch: boolean;
  /** A strong bind that exists only because the residue candidate was considered. */
  residueOnlyStrongMatch: boolean;
}

/** Compare transcript text against a legacy mark without weakening mark identity.
 * Candidate zero is the legacy value returned by
 * normaliseTranscriptFingerprintCandidates; the optional residue-tolerant
 * candidate may bind a turn, but can never upgrade that bind to durable
 * full-content consumption evidence. */
function matchTranscriptAgainstMark(
  candidates: readonly string[],
  contentFingerprint?: string,
  contentNormalized?: string,
  extraExactContents?: readonly string[],
): TranscriptMarkMatch {
  const legacy = candidates.slice(0, 1);
  const residue = candidates.slice(1);
  const fingerprint = (texts: readonly string[]) => !!contentFingerprint
    && texts.some(text => text.includes(contentFingerprint));
  const full = (texts: readonly string[]) => !!contentNormalized
    && texts.some(text => text.includes(contentNormalized));
  const exact = (texts: readonly string[]) => (!!contentNormalized || (extraExactContents?.length ?? 0) > 0)
    && texts.some(text => (!!contentNormalized && text === contentNormalized)
      || (extraExactContents?.includes(text) ?? false));
  const truncated = (texts: readonly string[]) => texts.some(text => isTruncatedMatch(text, contentNormalized));
  const legacyFingerprintMatch = fingerprint(legacy);
  const legacyFull = full(legacy);
  const legacyExact = exact(legacy);
  const legacyTruncationMatch = truncated(legacy);
  const residueFingerprintMatch = fingerprint(residue);
  const residueFull = full(residue);
  const residueTruncationMatch = truncated(residue);
  const legacyMatch = legacyFingerprintMatch || legacyTruncationMatch;
  const legacyStrongMatch = legacyFull || legacyTruncationMatch;
  return {
    fingerprintMatch: legacyFingerprintMatch || residueFingerprintMatch,
    anyFullContentMatch: legacyFull || residueFull,
    truncationMatch: legacyTruncationMatch || residueTruncationMatch,
    legacyFullContentMatch: legacyFull,
    legacyExactContentMatch: legacyExact,
    residueOnlyMatch: !legacyMatch && (residueFingerprintMatch || residueTruncationMatch),
    residueOnlyStrongMatch: !legacyStrongMatch && (residueFull || residueTruncationMatch),
  };
}

interface MarkMatchEvaluation {
  turn: BridgePendingTurn;
  match: TranscriptMarkMatch;
}

interface ResidueConflictGroup {
  turns: Set<BridgePendingTurn>;
  sinceMs: number;
}

function evaluateMarksAgainstTranscript(
  turns: readonly BridgePendingTurn[],
  candidates: readonly string[],
): MarkMatchEvaluation[] {
  return turns.map(turn => ({
    turn,
    match: matchTranscriptAgainstMark(
      candidates,
      turn.contentFingerprint,
      turn.contentNormalized,
      turn.extraExactContents,
    ),
  }));
}

function residueAttributionConflictTurns(
  evaluations: readonly MarkMatchEvaluation[],
  head: MarkMatchEvaluation,
): BridgePendingTurn[] {
  if (!head.match.fingerprintMatch && !head.match.truncationMatch) return [];
  const conflict: BridgePendingTurn[] = [];
  for (const other of evaluations) {
    if (other.turn === head.turn) continue;
    if (!other.match.anyFullContentMatch && !other.match.truncationMatch) continue;
    if (other.turn.contentNormalized === head.turn.contentNormalized) continue;
    if (head.match.residueOnlyMatch || other.match.residueOnlyStrongMatch) conflict.push(other.turn);
  }
  return conflict.length > 0 ? [head.turn, ...conflict] : [];
}

/** How a transcript user/queued-command record bound a pending Lark turn.
 *  `fullContentMatch` is true only when the record's untouched legacy-normalised
 *  text contains the ENTIRE normalised marked content — the one binding strong
 *  enough to prove that this exact input (envelope included) entered the
 *  conversation. A residue-tolerant candidate may bind a turn, but always
 *  reports false here; fingerprint-prefix and truncation binds are likewise
 *  attribution heuristics, not consumption proof. */
export interface BridgeTurnStartEvidence {
  fullContentMatch: boolean;
  exactContentMatch?: boolean;
  sourceJsonlPath?: string;
}

const MAX_TRACKED_CHAIN_UUIDS = 512;
const MAX_TRACKED_PROGRESS_UUIDS = 128;
const MAX_SEEN_API_REQUEST_KEYS = 512;

function addBoundedKey(set: Set<string>, key: string, maxSize: number): void {
  if (set.has(key)) return;
  if (set.size >= maxSize) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

/** Per-turn intra-turn execution evidence stored outside `BridgePendingTurn`
 *  so the queue can prove active work and conversation-tree lineage without
 *  altering the persisted/public turn record shape. */
interface ClaudeTurnLiveState {
  startUuid?: string;
  chainUuids: Set<string>;
  /** Separate bounded set for `type:"progress"` UUIDs so long tool-call progress
   *  bursts (>512 events) never evict conversation-backbone UUIDs (`u1`, `tool_use`). */
  progressChainUuids: Set<string>;
  sawParentUuid: boolean;
  pendingToolUseIds: Set<string>;
  apiRequestInFlight: boolean;
  awaitingPostToolAssistant: boolean;
  /** True between a manual `compact_boundary` (`trigger:"manual"`) and its
   *  paired `isCompactSummary` record so manual `/compact` does not upgrade
   *  the watchdog to `in_flight_model`. */
  manualCompactPending?: boolean;
  /** Epoch ms when this turn was re-opened via Scenario 3 recovery (bounds mid-tool hold). */
  reattachedAtMs?: number;
  /** Mirrors `trailingAssistantText`: true iff the latest assistant block with
   *  text/tool_use carried visible text without a `tool_use` block. Determines
   *  default Sub-case 3A vs 3B when `emitReadyTurns` does not report ground truth. */
  hasTrailingVisibleText: boolean;
  /** Monotonic intra-turn transcript progress counter (separate from
   *  `attributedActivitySeq` so provisional-exit semantics stay untouched). */
  activitySeq: number;
}

/** Snapshot of an IM turn popped at an unobserved boundary (`!terminalObserved`).
 *  Lets late records proving the same conversation-tree lineage re-attach to
 *  the originating IM turn instead of synthesising a suppressed `local-headless-*`. */
interface RecentUnobservedTurn {
  turnId: string;
  dispatchAttempt?: number;
  linkRefMode?: 'observe' | 'enabled';
  markTimeMs?: number;
  sourceJsonlPath?: string;
  startUuid?: string;
  chainUuids: Set<string>;
  progressChainUuids: Set<string>;
  sawParentUuid: boolean;
  pendingToolUseIds: Set<string>;
  apiRequestInFlight: boolean;
  awaitingPostToolAssistant: boolean;
  hadTrailingVisibleText: boolean;
  closedAtMs: number;
}

function matchesRecentUnobservedLineage(
  ev: TranscriptEvent,
  sourceJsonlPath: string | undefined,
  anchor: RecentUnobservedTurn,
  nowMs: number,
): boolean {
  if (nowMs - anchor.closedAtMs > CLI_QUEUE_HOLD_MAX_MS) return false;
  if (anchor.sourceJsonlPath && sourceJsonlPath && anchor.sourceJsonlPath !== sourceJsonlPath) return false;
  if (ev.parentUuid !== undefined) {
    return typeof ev.parentUuid === 'string' && ev.parentUuid.length > 0
      && (anchor.chainUuids.has(ev.parentUuid) || anchor.progressChainUuids.has(ev.parentUuid));
  }
  if (anchor.sawParentUuid || !anchor.startUuid) return false;
  const atMs = eventTimeMs(ev);
  if (atMs !== undefined && anchor.markTimeMs !== undefined && atMs < anchor.markTimeMs) return false;
  return true;
}

export class BridgeTurnQueue {
  constructor(
    private readonly onLocalTurnStarted?: (turn: BridgePendingTurn) => void,
    /** Fired ONCE per CronCreate call, when its tool_result ack resolves the
     *  scheduled task id: hands the worker the (taskId → create-time topic
     *  anchor) pair so it can persist it across worker restarts. `undefined`
     *  anchor means the task was created with no Lark context (local turn). */
    private readonly onScheduledTaskAnchored?: (taskId: string, anchor: string | undefined) => void,
    /** Fired when a pending Lark turn is started by a transcript record, with
     *  the strength of that binding. Durable receipts must only act on
     *  `fullContentMatch`. */
    private readonly onLarkTurnStarted?: (turn: BridgePendingTurn, evidence: BridgeTurnStartEvidence) => void,
    /** Sees every batch {@link ingest} reads from a known transcript file,
     *  before attribution. Read-only: must not touch the queue. */
    private readonly onEventsRead?: (events: readonly TranscriptEvent[], sourceJsonlPath: string) => void,
  ) {}
  private seen = new Set<string>();
  /** Mirror of Claude's type-ahead queue, in order, from the queue-operation
   *  records read so far. `dequeue` records carry no content, so only the order
   *  says which input left. A mirror that started mid-queue can release a mark
   *  early, which falls back to the normal TTL. */
  private cliQueue: Array<{ text: string; candidates: string[]; turn?: BridgePendingTurn }> = [];
  /** Pending marks and cancellation tombstones whose residue interpretations
   * conflict. Members wait and expire as one group so TTL cannot leave one
   * competitor behind to accept a late line as legacy full-content proof. */
  private residueConflictGroups: ResidueConflictGroup[] = [];
  private queue: BridgePendingTurn[] = [];
  private collecting: BridgePendingTurn | null = null;
  private lastLocalTurnId?: string;
  /** Turn id of the most recent Lark turn that actually STARTED (its user
   *  event arrived and fingerprint-bound a mark). Used as the create-time
   *  anchor when a CronCreate call is not itself inside a Lark or scheduled
   *  turn. Only updated at bind time — a queued-but-unstarted mark from
   *  another topic must NOT move it before that turn has really begun. */
  private lastLarkTurnId?: string;
  /** CronCreate tool_use block ids awaiting their tool_result ack, each
   *  carrying the Lark anchor captured at the moment of the CALL. The
   *  scheduled task id only comes back in the ack text, at which point the
   *  anchor is filed under it in {@link scheduledTaskAnchors}. */
  private pendingCronCreates = new Map<string, string | undefined>();
  /** scheduledTaskId → Lark topic anchor captured when the task was CREATED.
   *  Fires of a KNOWN task anchor here (a stored `undefined` means "created
   *  from a local turn, no topic"), NOT to whatever topic is current at fire
   *  time. An UNKNOWN task (no CronCreate/ack observed this process and
   *  nothing restored) gets NO anchor — never a later topic's anchor, which
   *  would route cross-topic after a restart. Restored by the worker from the
   *  durable anchor store on startup. */
  private scheduledTaskAnchors = new Map<string, string | undefined>();
  /** Background task id → launch metadata (kind, Monitor persistence, timeout
   *  deadline). Recorded for ALL main-thread launches (including local/zero-
   *  injection turns and re-attached seeded tasks), independent of whether a
   *  Lark topic anchor exists. */
  private backgroundTaskMeta = new Map<string, BackgroundTaskLaunchMeta>();
  /** Background task id → Lark turn (`turnId` + optional `dispatchAttempt`)
   *  whose tool_result acked its launch (inherited through a scheduled /
   *  background-wake turn's own anchor). Tasks launched from terminal-typed
   *  turns, or before this queue existed, have no entry: their wake stays an
   *  ordinary local turn. */
  private backgroundTaskAnchors = new Map<string, BackgroundTaskAnchor>();
  /** Background wake armed by the `<task-notification>`s that opened the next
   *  turn and have not yet produced the visible text that synthesises its
   *  headless turn. Claude may answer several notices in one turn, so this
   *  accumulates: the shared anchor while every notice resolves to the same
   *  launching Lark turn (`null` once two differ or any one has no anchor),
   *  plus whether every notice so far is a qualifying non-terminal Monitor
   *  mid-stream event (`nonTerminalMonitor`). `undefined` when nothing pending. */
  private pendingBackgroundWake: PendingBackgroundWake | undefined;
  /** Records written before this queue existed were written while no worker
   *  of this process was watching: replaying them (journal restore, rotation)
   *  must never open a background-wake delivery. */
  private readonly liveSinceMs = Date.now();
  /** Lark turns removed by the head-of-line drop, awaiting journal cleanup by
   *  the worker. This queue is pure (no fs), so it cannot clear the durable
   *  journal itself — it reports, the worker retires. Same contract as
   *  `pruneExpired`'s return value, just accumulated because the drop happens
   *  deep inside ingest() rather than at an explicit call boundary. */
  private droppedNeedingJournalClear: BridgePendingTurn[] = [];
  /** This transcript has shown it ends turns with `system/turn_duration`
   *  (seen live, in absorbed history, or by the worker's baseline probe).
   *  Survives clearPending: it describes the CLI, not one generation's turns. */
  private durationMarkerSeen = false;
  /** An idle-edge wait for a turn's duration marker ran out before this
   *  transcript ever showed one: the CLI most likely never writes it (older
   *  Claude JSONL), so later turns settle on the stop_reason again instead of
   *  each waiting out the bound. A marker read afterwards outranks this.
   *  Survives clearPending for the same reason as durationMarkerSeen. */
  private durationMarkerWaitExpired = false;
  /** Transcript time of the newest real model reply read (any main-thread
   *  assistant record that is neither an API error nor a synthetic local record,
   *  real-model tool_use blocks included). Survives clearPending like the markers above:
   *  it describes the provider session, not one generation's turns. */
  private lastProviderReplyAtMs: number | undefined;
  private readonly liveStates = new WeakMap<BridgePendingTurn, ClaudeTurnLiveState>();
  private readonly seenApiRequestKeys = new Set<string>();
  private apiRequestObservedInGeneration = false;
  private recentUnobservedTurn: RecentUnobservedTurn | null = null;
  private readonly reattachedFromUnobserved = new WeakSet<BridgePendingTurn>();

  private liveStateFor(turn: BridgePendingTurn): ClaudeTurnLiveState {
    let state = this.liveStates.get(turn);
    if (!state) {
      state = {
        chainUuids: new Set(),
        progressChainUuids: new Set(),
        sawParentUuid: false,
        pendingToolUseIds: new Set(),
        apiRequestInFlight: false,
        awaitingPostToolAssistant: false,
        hasTrailingVisibleText: false,
        activitySeq: 0,
      };
      this.liveStates.set(turn, state);
    }
    return state;
  }

  private recordChainUuid(turn: BridgePendingTurn, uuid: string, ev: TranscriptEvent, isProgress = false): ClaudeTurnLiveState {
    const state = this.liveStateFor(turn);
    if (isProgress) {
      addBoundedKey(state.progressChainUuids, uuid, MAX_TRACKED_PROGRESS_UUIDS);
    } else {
      addBoundedKey(state.chainUuids, uuid, MAX_TRACKED_CHAIN_UUIDS);
    }
    if (ev.parentUuid !== undefined) state.sawParentUuid = true;
    return state;
  }

  private extendRecentUnobservedChain(uuid: string, ev: TranscriptEvent, isProgress = false): void {
    const anchor = this.recentUnobservedTurn;
    if (!anchor) return;
    if (isProgress) {
      addBoundedKey(anchor.progressChainUuids, uuid, MAX_TRACKED_PROGRESS_UUIDS);
    } else {
      addBoundedKey(anchor.chainUuids, uuid, MAX_TRACKED_CHAIN_UUIDS);
    }
    if (ev.parentUuid !== undefined) anchor.sawParentUuid = true;
  }

  /** Clear the late-recovery lineage anchor (generation boundary, CLI exit, teardown). */
  clearRecentUnobservedTurn(): void {
    this.recentUnobservedTurn = null;
  }

  /** True when `turn` was re-opened from a recent unobserved-boundary IM close
   *  (Scenario 3). Such turns get a fresh bounded open-turn episode, but must
   *  not enter V1 handoff admission or emit a duplicate `turn_terminal`. */
  isLateUnobservedRecovery(turn: BridgePendingTurn): boolean {
    return this.reattachedFromUnobserved.has(turn);
  }

  /** Reconcile Scenario 3A vs 3B against whether `emitReadyTurns` actually
   *  emitted or offered a `final_output` when this unobserved turn was popped. */
  noteUnobservedTurnEmittedFinalOutput(
    turnId: string,
    dispatchAttempt: number | undefined,
    emitted: boolean,
  ): void {
    if (this.recentUnobservedTurn
      && this.recentUnobservedTurn.turnId === turnId
      && this.recentUnobservedTurn.dispatchAttempt === dispatchAttempt) {
      this.recentUnobservedTurn.hadTrailingVisibleText = emitted;
    }
  }

  /** Record that an unobserved-popped IM turn was already covered by an explicit
   *  final `botmux send` marker (not by emitting bridge `final_output`). Keeping
   *  `hadTrailingVisibleText = false` guarantees a late trailing summary re-opens
   *  under the original `turnId` so `shouldSuppressBridgeEmit` deduplicates it. */
  noteUnobservedTurnDeliveredBySend(turnId: string, dispatchAttempt?: number): void {
    this.noteUnobservedTurnEmittedFinalOutput(turnId, dispatchAttempt, false);
  }

  /** True when the queue head is actively running, awaiting a duration marker,
   *  or held in Claude's input queue — including local, scheduled, and
   *  background-wake turns. Used to guard post-settlement redrive so we never
   *  fire a premature idle boundary on top of a live successor turn. */
  hasActiveOrQueuedHead(opts: { ignoreCarried?: boolean } = {}): boolean {
    const head = this.queue[0];
    if (!head) return false;
    if (opts.ignoreCarried && head.carriedAcrossGeneration) return false;
    if (head.started && !head.terminalObserved && !head.closedByDurationMarker && !head.rateLimited) return true;
    if (this.isAwaitingDurationMarker(head)) return true;
    if (isHeldInCliQueue(head)) return true;
    return false;
  }

  /** Record an explicit worker-side ambiguity for the exact durable head.
   *  Unlike `terminalObserved`, this does not claim any transcript terminal:
   *  the model may have run, but its precise completion contract is unknown.
   *  The bounded worker release drains this outcome without normal final_output. */
  markDurableTurnAmbiguous(turn: BridgePendingTurn, errorCode: string): boolean {
    if (this.queue[0] !== turn || turn.dispatchAttempt === undefined
      || turn.closedByDurationMarker || turn.rateLimited) return false;
    turn.terminalOutcome = { status: 'ambiguous', errorCode, retryable: false };
    turn.terminalOutcomeAtMs = Date.now();
    turn.awaitingDurationMarker = false;
    return true;
  }

  /** Head live non-local turn that has started collecting in the current
   *  transcript generation and has not yet observed any terminal record. */
  openLiveNonLocalTurn(): BridgePendingTurn | undefined {
    const head = this.queue[0];
    if (!head || head.isLocal || !head.started || head !== this.collecting) return undefined;
    if (head.terminalObserved || head.closedByDurationMarker || head.rateLimited) return undefined;
    if (head.restoredFromJournal || head.carriedAcrossGeneration) return undefined;
    return head;
  }

  /** Snapshot of deterministic intra-turn transcript evidence for `turn`. */
  getOpenTurnEvidence(turn: BridgePendingTurn): ClaudeOpenTurnQueueEvidence {
    const live = this.liveStates.get(turn);
    return {
      activitySeq: live?.activitySeq ?? 0,
      unmatchedToolUseCount: live?.pendingToolUseIds.size ?? 0,
      apiRequestInFlight: live?.apiRequestInFlight ?? false,
      awaitingPostToolAssistant: live?.awaitingPostToolAssistant ?? false,
      hasVisibleAssistantText: turn.assistantUuids.length > 0,
      apiRequestObservedInGeneration: this.apiRequestObservedInGeneration,
    };
  }

  private stampProviderLastSuccess(turn: BridgePendingTurn): void {
    if (this.lastProviderReplyAtMs !== undefined) turn.terminalProviderLastSuccessAtMs = this.lastProviderReplyAtMs;
    else delete turn.terminalProviderLastSuccessAtMs;
  }

  /** Record that this transcript writes `system/turn_duration` markers. */
  noteDurationMarkerObserved(): void {
    this.durationMarkerSeen = true;
  }

  /** The worker's bounded idle-edge wait for the head turn's close ran out. */
  noteDurationMarkerWaitExpired(): void {
    if (!this.durationMarkerSeen) this.durationMarkerWaitExpired = true;
  }

  /** Forget both verdicts for a NEW writer/transcript. clearPending() within
   *  one CLI generation intentionally keeps them (the CLI did not change),
   *  but a watcher teardown/fresh-empty start and an in-process transcript
   *  rotation (/clear, /resume, pid-state, fingerprint switch) begin a new
   *  generation: an `absent` learned from the old writer must not strip the
   *  next session's first-turn protection. The baseline probe then re-proves
   *  `seen` from the new file. */
  resetDurationMarkerVerdicts(): void {
    this.durationMarkerSeen = false;
    this.durationMarkerWaitExpired = false;
    this.recentUnobservedTurn = null;
    this.seenApiRequestKeys.clear();
    this.apiRequestObservedInGeneration = false;
  }

  /** Claude's queue is not observable from another transcript or CLI process:
   *  the dequeue may land where we are not reading. */
  forgetCliQueue(now: number = Date.now()): void {
    this.cliQueue = [];
    for (const turn of this.queue) {
      if (isHeldInCliQueue(turn)) turn.cliQueueReleasedAtMs = now;
    }
  }

  /** Claude is back at its prompt, so its queue should be empty: an input
   *  still held left without a record we could match. The normal TTL runs from
   *  here, which also covers an idle edge seen while input was still queued. */
  cliQueueDrained(now: number = Date.now()): void {
    this.forgetCliQueue(now);
  }

  /** Mark turns already STARTED in the generation that is ending as carried
   *  across the rotation, so releasing them on the new file never teaches a
   *  negative marker verdict. UNSTARTED marks are deliberately left untagged:
   *  they have not bound a user record in the old file, so when the new file's
   *  own user event starts them they are live turns of the new writer and must
   *  keep its normal marker hold (including after a proven marker-present
   *  history), not inherit the old writer's terminal-boundary exception. */
  markPendingTurnsCarriedAcrossGeneration(): void {
    this.recentUnobservedTurn = null;
    for (const turn of this.queue) {
      if (turn.started) turn.carriedAcrossGeneration = true;
    }
  }

  /** True when a head turn is waiting for a duration marker while this
   *  transcript has no marker verdict yet (a session's first turn). This is
   *  the ONLY state the worker's provisional-exit watchdog may time out: a
   *  transcript proven to write markers keeps waiting for the marker (an API
   *  error can still follow a text record), and an idle-expired verdict
   *  already settles on the stop_reason. */
  isFreshHeadAwaitingMarker(turn: BridgePendingTurn): boolean {
    // `!durationMarkerWaitExpired` needs no term of its own: with no marker
    // seen yet, isAwaitingDurationMarker's (durationMarkerSeen || !waitExpired)
    // gate reduces exactly to !durationMarkerWaitExpired.
    return !this.durationMarkerSeen
      && this.isAwaitingDurationMarker(turn);
  }
  /** True while `turn` is held for its duration marker: its terminal so far is
   *  a block-level stop_reason and no later turn has started collecting (a new
   *  turn start is itself the boundary, and must never leave the head blocked
   *  behind it). The hold does not need the marker to have been seen before:
   *  the first turn of a session is cut by an API error as easily as any other.
   *  Only a CLI shown not to write the marker (see durationMarkerWaitExpired)
   *  settles on the stop_reason. */
  isAwaitingDurationMarker(turn: BridgePendingTurn): boolean {
    return (this.durationMarkerSeen || !this.durationMarkerWaitExpired)
      && turn.awaitingDurationMarker === true
      && turn === this.collecting;
  }

  /** True while the transcript is still writing `turn`: it started, it is the
   *  turn collecting records, and nothing has closed it yet — no terminal
   *  record was read, or it is held for its duration marker. Claude shows its
   *  prompt (and its hooks report done) before the records that close a turn —
   *  its final blocks, an API error that cut the stream, the marker — reach the
   *  file, so the worker waits (bounded) on this at an idle edge before
   *  settling from it. */
  isTurnOpenAtIdle(turn: BridgePendingTurn): boolean {
    if (!turn.started || turn !== this.collecting || turn.closedByDurationMarker) return false;
    return !turn.terminalObserved || this.isAwaitingDurationMarker(turn);
  }

  /** Hand over (and forget) the turns dropped head-of-line since the last
   *  call. The worker drains this after every ingest and clears each one's
   *  journal entry; leaving them would let a later restart re-mark a turn
   *  that can never complete. */
  takeDroppedNeedingJournalClear(): BridgePendingTurn[] {
    if (this.droppedNeedingJournalClear.length === 0) return [];
    return this.droppedNeedingJournalClear.splice(0);
  }

  /** Register events as historical — their uuids are now considered seen
   *  but no attribution happens. Used at attach time to baseline. Also retains
   *  background-task launch metadata (not Lark anchors) so Monitor mid-stream
   *  events after attach still know whether the Monitor is persistent/bounded.
   *  When `opts.liveSinceMs` is passed, launches stamped earlier than that CLI
   *  lifetime floor are ignored (preventing dead-CLI Monitors from leaking on
   *  `/resume`). */
  absorb(events: TranscriptEvent[], opts?: { liveSinceMs?: number }): void {
    const liveSinceMs = opts?.liveSinceMs;
    for (const ev of events) {
      if (ev.uuid) this.seen.add(ev.uuid);
      if (isClaudeTurnDurationEvent(ev)) this.durationMarkerSeen = true;
      if (isMainThreadApiRequestEvent(ev)) this.apiRequestObservedInGeneration = true;
      const atMs = liveSinceMs !== undefined ? eventTimeMs(ev) : undefined;
      if (liveSinceMs === undefined || (atMs !== undefined && atMs >= liveSinceMs)) {
        this.recordBackgroundTaskMetadata(backgroundTaskLaunches(ev));
      }
      for (const id of backgroundTaskSettledIds(ev)) this.backgroundTaskMeta.delete(id);
    }
  }

  /** Seed background-task launch metadata from a re-attach transcript scan
   *  (metadata only: never writes `seen`, Lark anchors, or turn state). */
  seedBackgroundTasks(tasks: readonly BackgroundTaskLaunch[]): void {
    this.recordBackgroundTaskMetadata(tasks);
  }

  /** Seed background-task launch metadata from a historical event batch,
   *  ignoring launches older than (or missing timestamps under) `liveSinceMs`. */
  seedBackgroundTasksFromHistory(events: readonly TranscriptEvent[], liveSinceMs: number): void {
    for (const ev of events) {
      const atMs = eventTimeMs(ev);
      if (atMs === undefined || atMs < liveSinceMs) continue;
      this.recordBackgroundTaskMetadata(backgroundTaskLaunches(ev));
      for (const id of backgroundTaskSettledIds(ev)) this.backgroundTaskMeta.delete(id);
    }
  }

  /** Forget all tracked background-task metadata, anchors, and any armed wake
   *  when the backing CLI process is replaced (its background tasks died). */
  resetBackgroundTasks(): void {
    this.backgroundTaskMeta.clear();
    this.backgroundTaskAnchors.clear();
    this.pendingBackgroundWake = undefined;
  }

  /** True while a non-terminal Monitor mid-stream wake is armed (pre-text) or
   *  actively collecting (before `turn_duration`). Keeps the launching turn's
   *  held CoT bubble open if the Monitor crosses `expiresAtMs` mid-micro-turn. */
  hasActiveSuppressedMonitorWake(): boolean {
    if (this.pendingBackgroundWake?.nonTerminalMonitor === true) return true;
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    return running?.wakeNonTerminalMonitor === true;
  }

  /** True while a non-local (IM/API) turn is actively collecting. Prevents
   *  `computeBackgroundCotHold()` from holding an earlier turn's CoT during a
   *  brand-new human turn, while excluding Scenario 3 late-recovery continuations
   *  of an already-terminated launching turn. */
  hasActiveNonLocalTurn(): boolean {
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    return !!running && !running.isLocal && !running.terminalObserved
      && !this.reattachedFromUnobserved.has(running);
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
    opts?: {
      restoredFromJournal?: boolean;
      linkRefMode?: 'observe' | 'enabled';
      extraExactContents?: readonly string[];
    },
  ): string {
    this.queue.push({
      turnId,
      dispatchAttempt,
      ...(opts?.linkRefMode ? { linkRefMode: opts.linkRefMode } : {}),
      started: false,
      assistantUuids: [],
      contentFingerprint,
      contentNormalized,
      ...(opts?.extraExactContents?.length ? { extraExactContents: opts.extraExactContents } : {}),
      markTimeMs,
      ...(opts?.restoredFromJournal ? { restoredFromJournal: true } : {}),
    });
    return turnId;
  }

  private noteResidueConflict(turns: readonly BridgePendingTurn[], sinceMs: number): void {
    const overlapping = this.residueConflictGroups.filter(group => turns.some(turn => group.turns.has(turn)));
    const merged = new Set(turns);
    let mergedSinceMs = sinceMs;
    for (const group of overlapping) {
      for (const turn of group.turns) merged.add(turn);
      mergedSinceMs = Math.min(mergedSinceMs, group.sinceMs);
    }
    this.residueConflictGroups = this.residueConflictGroups.filter(group => !overlapping.includes(group));
    this.residueConflictGroups.push({ turns: merged, sinceMs: mergedSinceMs });
  }

  /** A real turn start resolves one member. Explicit drops keep their
   * tombstones; queue holds do not resolve anything because the input can
   * still be another member's residue-bearing line until its actual user
   * record is attributed. */
  private resolveResidueConflictFor(turn: BridgePendingTurn): void {
    for (let i = this.residueConflictGroups.length - 1; i >= 0; i--) {
      const group = this.residueConflictGroups[i]!;
      if (!group.turns.delete(turn)) continue;
      if (group.turns.size < 2) this.residueConflictGroups.splice(i, 1);
    }
    this.discardInactiveResidueConflictGroups();
  }

  private residueConflictGroupFor(turn: BridgePendingTurn): ResidueConflictGroup | undefined {
    return this.residueConflictGroups.find(group => group.turns.has(turn));
  }

  /** Tombstones have no independent expiry work of their own. Once no active
   * queue member remains, there is no survivor to protect and the whole group
   * can be forgotten instead of leaking into a later mark's conflict window. */
  private discardInactiveResidueConflictGroups(): void {
    this.residueConflictGroups = this.residueConflictGroups.filter(group =>
      [...group.turns].some(turn => this.queue.includes(turn) && !turn.started));
  }

  /** Current candidates plus conflict tombstones. Dropped turns never become
   * bindable heads, but their content still disambiguates later records. */
  private attributionMatchTurns(turns: readonly BridgePendingTurn[]): BridgePendingTurn[] {
    const all = [...turns];
    for (const group of this.residueConflictGroups) {
      for (const turn of group.turns) if (!all.includes(turn)) all.push(turn);
    }
    return all;
  }

  /** Drop all pending turns. Used when the worker discovers it can't
   *  reliably attribute future events (e.g. baseline raced with a turn
   *  already in flight) and wants to clear the slate. */
  clearPending(): BridgePendingTurn[] {
    this.lastLocalTurnId = undefined;
    this.pendingBackgroundWake = undefined;
    this.recentUnobservedTurn = null;
    this.cliQueue = [];
    this.residueConflictGroups = [];
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
    // Keep a dropped mark in its conflict group as a tombstone. Submit
    // failure cancels this delivery attempt, not the possibility that its
    // residue-bearing record arrives late and explains a competitor's line.
    this.discardInactiveResidueConflictGroups();
    return dropped;
  }

  /** Hold one exact unstarted mark while the worker writes its input. */
  holdForWrite(turnId: string, dispatchAttempt?: number): void {
    const turn = this.queue.find(t =>
      t.turnId === turnId && t.dispatchAttempt === dispatchAttempt && !t.started);
    if (turn) turn.writeInFlight = true;
  }

  /** The write of a held mark settled: its TTL starts now. */
  releaseWriteHold(turnId: string, dispatchAttempt?: number, now: number = Date.now()): void {
    const turn = this.queue.find(t =>
      t.turnId === turnId && t.dispatchAttempt === dispatchAttempt && t.writeInFlight);
    if (!turn) return;
    turn.writeInFlight = undefined;
    turn.writeSettledAtMs = now;
  }

  /** Sweep pending (unstarted) turns whose mark is older than `maxAgeMs`.
   *  Returns the dropped turns for logging. Belt-and-braces backstop for
   *  any future code path that leaves an unstarted mark stranded — without
   *  it, `maybeSwitchBridgeJsonl` would keep doing full-directory jsonl
   *  scans every poll tick until the worker restarts. Started turns are
   *  never expired here: once Claude actually wrote the user line, the
   *  turn is collecting assistant text and we want to wait however long
   *  the model takes. The same goes for a mark whose input Claude holds in its
   *  own queue, up to {@link CLI_QUEUE_HOLD_MAX_MS}, for one whose input
   *  the worker is still writing ({@link holdForWrite}), or that was written
   *  while an earlier turn is still running. */
  pruneExpired(maxAgeMs: number, now: number = Date.now()): BridgePendingTurn[] {
    const dropped: BridgePendingTurn[] = [];
    // An earlier turn is still running: type-ahead input waits behind it.
    const busy = !!this.collecting && !this.collecting.terminalObserved;
    this.queue = this.queue.filter(t => {
      if (t.started) return true;
      if (t.markTimeMs === undefined) return true;
      const conflict = this.residueConflictGroupFor(t);
      // Group expiry is atomic and therefore outranks an individual write
      // hold: retaining only the writer would erase the conflict and let a
      // competitor's late line become its legacy full-content proof.
      if (conflict) {
        if (now - conflict.sinceMs <= CLI_QUEUE_HOLD_MAX_MS) return true;
        dropped.push(t);
        return false;
      }
      if (t.writeInFlight) return true;
      if (isHeldInCliQueue(t) && now - t.cliQueuedAtMs! <= CLI_QUEUE_HOLD_MAX_MS) return true;
      if (busy && now - t.markTimeMs <= CLI_QUEUE_HOLD_MAX_MS) { t.heldWhileBusyAtMs = now; return true; }
      const ttlStartMs = Math.max(
        t.markTimeMs,
        t.cliQueueReleasedAtMs ?? 0,
        t.writeSettledAtMs ?? 0,
        t.heldWhileBusyAtMs ?? 0,
      );
      if (now - ttlStartMs <= maxAgeMs) return true;
      dropped.push(t);
      return false;
    });
    for (const turn of dropped) this.resolveResidueConflictFor(turn);
    this.discardInactiveResidueConflictGroups();
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
  ingest(
    events: TranscriptEvent[],
    sourceJsonlPath?: string,
    /** Read-only side-channel observer: called at the moment an event is
     *  attributed to a turn (the then-collecting turn) for
     *    - every non-sidechain, non-error assistant event, and
     *    - every non-sidechain pure-tool_result user event (intra-turn tool
     *      output — skipped by turn-start handling but part of the turn).
     *  The worker uses this for the native CoT message and for proof that a
     *  replay actually attributed a reply to a turn. It must never mutate the
     *  queue or influence attribution. */
    onAssistantAttributed?: (ev: TranscriptEvent, turn: BridgePendingTurn) => void,
    /** Read-only observer for a main-thread duration marker actually closing
     *  the then-collecting turn. Unlike a raw timestamp match, this carries the
     *  turn identity, so a replayed previous turn's marker cannot settle the
     *  current unread run. Must not mutate the queue or influence attribution. */
    onTurnDurationAttributed?: (ev: TranscriptEvent, turn: BridgePendingTurn) => void,
    /** Read-only observer for leading thinking/tool records during an armed
     *  non-terminal Monitor wake before the first visible text block (and for
     *  text-less Monitor wakes closed by `system/turn_duration`). */
    pendingWakeObserver?: PendingWakeCotObserver,
  ): void {
    if (sourceJsonlPath && events.length > 0) this.onEventsRead?.(events, sourceJsonlPath);
    let batchMadeUuidProgress = false;
    for (const ev of events) {
      if (ev.type === 'queue-operation') {
        this.observeCliQueueOperation(ev);
        this.settleBackgroundTasksFromEvent(ev, true);
        continue;
      }
      if (isClaudeApiRequestBlob(ev)) continue;
      if (isMainThreadApiRequestEvent(ev)) {
        const hasStableId = typeof ev.id === 'string' && ev.id.length > 0;
        const apiKey = hasStableId
          ? `id:${ev.id}`
          : typeof ev.timestamp === 'string' && ev.timestamp.length > 0
            ? `ts:${ev.timestamp}:${sourceJsonlPath ?? ''}`
            : undefined;
        // An id-less request is distinguishable from a same-timestamp successor
        // only when this batch also contains NEW uuid progress. Without such
        // progress, treat timestamp+path as a replay key: using the mutable
        // last-seen batch cursor made the same request gain a fresh key whenever a
        // replay batch started at the request after later records had landed.
        const seen = !!apiKey && this.seenApiRequestKeys.has(apiKey);
        if (!apiKey || (seen && (hasStableId || !batchMadeUuidProgress))) continue;
        if (!seen) addBoundedKey(this.seenApiRequestKeys, apiKey, MAX_SEEN_API_REQUEST_KEYS);
        this.apiRequestObservedInGeneration = true;
        if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
          const live = this.liveStateFor(this.collecting);
          live.apiRequestInFlight = true;
          live.awaitingPostToolAssistant = false;
          live.manualCompactPending = false;
          live.activitySeq++;
        }
        continue;
      }
      const uuid = ev.uuid;
      if (!uuid || this.seen.has(uuid)) continue;
      this.seen.add(uuid);
      batchMadeUuidProgress = true;
      if ((ev as any).isSidechain === true) {
        if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
          const live = this.liveStates.get(this.collecting);
          if (live && live.pendingToolUseIds.size > 0) live.activitySeq++;
        }
        continue;
      }
      if (hasTranscriptRole(ev, 'user')) {
        // Built-in CronCreate fire: isMeta + turnOrigin:"scheduled". It is
        // NOT a meaningful human event (fingerprint matching must never bind a
        // pending Lark mark to the scheduler's prompt), but it DOES open a
        // real model turn whose final belongs in the originating Lark thread.
        // Handle it before the isMeaningfulUserEvent filter below.
        if (isScheduledTurnStartEvent(ev)) {
          this.clearPendingBackgroundWake(pendingWakeObserver);
          this.handleScheduledTurnStart(uuid, ev, sourceJsonlPath);
          continue;
        }
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
        // Resolve CronCreate acks BEFORE the meaningful/non-meaningful split.
        // Real acks are pure tool_result batches (non-meaningful), but if a
        // future build appends a text block to the same event it becomes
        // meaningful and would otherwise skip ack pairing. The handler is
        // idempotent (a paired call is deleted immediately) and gated on a
        // pending CronCreate tool_use id, so calling it on every user event
        // is safe and cheap.
        this.handleCronCreateAcks(ev);
        this.recordBackgroundTaskLaunches(ev);
        this.notePendingBackgroundWake(ev);
        this.settleBackgroundTasksFromEvent(ev, isPureToolResultUserEvent(ev.message?.content));
        if (isClaudeUserInterruptEvent(ev)) {
          this.clearPendingBackgroundWake(pendingWakeObserver);
          this.recentUnobservedTurn = null;
          if (this.collecting && !this.collecting.closedByDurationMarker) {
            const live = this.recordChainUuid(this.collecting, uuid, ev);
            live.pendingToolUseIds.clear();
            live.apiRequestInFlight = false;
            live.awaitingPostToolAssistant = false;
            live.activitySeq++;
            this.collecting.terminalObserved = true;
            this.collecting.awaitingDurationMarker = false;
            this.collecting.closedByDurationMarker = true;
            this.collecting.terminalOutcome ??= {
              status: 'cancelled',
              errorCode: 'user_interrupted',
              retryable: false,
            };
            this.collecting.terminalOutcomeAtMs = eventTimeMs(ev);
            this.collecting = null;
          }
          continue;
        }
        if (!isMeaningfulUserEvent(ev)) {
          // Pure tool_result events are intra-turn tool output — never a
          // turn boundary, but the CoT observer wants them for the tool
          // timeline of the currently-collecting turn (or an armed pre-text
          // non-terminal Monitor wake that has already emitted assistant work).
          if (isPureToolResultUserEvent(ev.message?.content)) {
            if (this.collecting && onAssistantAttributed) {
              try { onAssistantAttributed(ev, this.collecting); } catch { /* observer channel — never break attribution */ }
            } else if (!this.collecting
              && pendingWakeObserver?.onActivity
              && this.pendingBackgroundWake?.nonTerminalMonitor === true
              && this.pendingBackgroundWake.hasAssistantActivity
              && this.pendingBackgroundWake.anchor !== null) {
              this.pendingBackgroundWake.emittedAnchorCot ??= { ...this.pendingBackgroundWake.anchor };
              try { pendingWakeObserver.onActivity(ev, { ...this.pendingBackgroundWake.anchor }); } catch { /* observer channel */ }
            }
            if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
              const live = this.recordChainUuid(this.collecting, uuid, ev);
              for (const toolUseId of userToolResultIds(ev)) live.pendingToolUseIds.delete(toolUseId);
              live.awaitingPostToolAssistant = true;
              live.manualCompactPending = false;
              live.activitySeq++;
            } else if (!this.collecting && this.recentUnobservedTurn) {
              if (matchesRecentUnobservedLineage(ev, sourceJsonlPath, this.recentUnobservedTurn, Date.now())) {
                for (const toolUseId of userToolResultIds(ev)) {
                  this.recentUnobservedTurn.pendingToolUseIds.delete(toolUseId);
                }
                this.recentUnobservedTurn.awaitingPostToolAssistant = true;
                this.extendRecentUnobservedChain(uuid, ev);
              } else {
                this.recentUnobservedTurn = null;
              }
            }
          } else {
            if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
              if ((ev as any).isCompactSummary === true) {
                const live = this.recordChainUuid(this.collecting, uuid, ev);
                if (!live.manualCompactPending) {
                  live.awaitingPostToolAssistant = true;
                  live.activitySeq++;
                }
                live.manualCompactPending = false;
              } else if ((ev as any).isMeta === true && !isSyntheticUserPrefixEvent(ev)) {
                // Mid-turn non-synthetic meta records (e.g. expanded Skill
                // instructions) participate in the conversation parentUuid chain
                // without opening a new turn or extending awaitingPostToolAssistant.
                this.recordChainUuid(this.collecting, uuid, ev);
              }
            }
            // Wall 1: any non-tool_result user record (local slash command,
            // `<task-notification>`, `isMeta`, `isCompactSummary`) invalidates
            // the late-recovery anchor so subsequent replies never cross-attach.
            this.recentUnobservedTurn = null;
          }
          continue;
        }
        this.clearPendingBackgroundWake(pendingWakeObserver);
        this.handleTurnStart(uuid, ev, sourceJsonlPath);
      } else if (ev.type === 'attachment' && ev.attachment?.type === 'queued_command') {
        this.noteAbsorbedBackgroundNotice(ev);
        this.settleBackgroundTasksFromEvent(ev, false);
        // Type-ahead path: Claude writes `attachment(queued_command)` the
        // moment it dequeues a queued submit, immediately before the
        // assistant text for that turn starts streaming. Equivalent to
        // role:user for turn-start purposes; share the same handler so
        // fingerprint-match / HOL-block-drop / local-turn fallback all
        // apply identically. Without this the bridge attribution queue
        // would skip queued_command events and the type-ahead'd turn's
        // assistant text would either be dropped or attributed to a
        // sibling turn.
        if (isMidTurnAbsorbedQueuedCommand(ev)) {
          // A human prompt folded into a Monitor wake turn means the model's
          // reply now answers the human too. Try binding a pending Lark mark
          // first (which promotes that Lark turn to `collecting` instead of
          // burying it inside a headless background wake); if the prompt did
          // not promote a new collecting turn (e.g. local-typed mid-turn input),
          // fail open by disarming the Monitor wake so its answer is delivered.
          const beforeHost = this.collecting;
          if (this.pendingBackgroundWake) this.pendingBackgroundWake.nonTerminalMonitor = false;
          const matched = this.handleAbsorbedInput(ev, sourceJsonlPath, pendingWakeObserver);
          if (this.collecting === beforeHost) {
            this.disarmCollectingMonitorWake();
          }
          if (!matched) {
            if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
              const live = this.recordChainUuid(this.collecting, uuid, ev);
              live.awaitingPostToolAssistant = true;
              live.activitySeq++;
            } else {
              this.recentUnobservedTurn = null;
            }
          }
          continue;
        }
        if (!isMeaningfulQueuedCommand(ev)) {
          if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
            const live = this.recordChainUuid(this.collecting, uuid, ev);
            live.awaitingPostToolAssistant = true;
            live.activitySeq++;
          } else {
            this.recentUnobservedTurn = null;
          }
          continue;
        }
        this.clearPendingBackgroundWake(pendingWakeObserver);
        this.handleTurnStart(uuid, ev, sourceJsonlPath);
      } else if (isIntraTurnAttachmentEvent(ev)) {
        if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
          const live = this.recordChainUuid(this.collecting, uuid, ev);
          live.awaitingPostToolAssistant = true;
          live.manualCompactPending = false;
          live.activitySeq++;
        } else if (!this.collecting && this.recentUnobservedTurn) {
          if (matchesRecentUnobservedLineage(ev, sourceJsonlPath, this.recentUnobservedTurn, Date.now())) {
            this.recentUnobservedTurn.awaitingPostToolAssistant = true;
            this.extendRecentUnobservedChain(uuid, ev);
          } else {
            this.recentUnobservedTurn = null;
          }
        }
      } else if (ev.type === 'progress') {
        if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
          const live = this.recordChainUuid(this.collecting, uuid, ev, true);
          live.activitySeq++;
        } else if (!this.collecting && this.recentUnobservedTurn
          && matchesRecentUnobservedLineage(ev, sourceJsonlPath, this.recentUnobservedTurn, Date.now())) {
          this.extendRecentUnobservedChain(uuid, ev, true);
        }
      } else if (hasTranscriptRole(ev, 'assistant')) {
        // An assistant record after the collecting turn's duration marker (or
        // after a markerless turn's `end_turn` once a `<task-notification>`
        // armed a new background wake) opens the next turn. A live drain has
        // emitted the closed turn by then; a batch spanning several turns must
        // not fold the next turn's reply into it.
        if (this.collecting?.closedByDurationMarker
          || (this.collecting?.terminalObserved && !this.isAwaitingDurationMarker(this.collecting)
            && this.pendingBackgroundWake !== undefined)) {
          this.collecting = null;
        }
        // Capture CronCreate calls with the topic anchor of the turn that is
        // running them: when the ack returns the task id, fires of that task
        // route back to THIS topic even if other topics receive messages
        // before the first fire.
        for (const toolUseId of cronCreateToolUseIds(ev)) {
          // Anchor precedence: a Lark turn currently running → that turn;
          // a scheduled turn currently running → its own inherited topic
          // anchor (a task (re)created during a scheduled run belongs in that
          // same topic); otherwise the latest started Lark turn; else none.
          const anchor = this.collecting && !this.collecting.isLocal
            ? (this.reattachedFromUnobserved.has(this.collecting) && this.collecting.replyAnchorTurnId
              ? this.collecting.replyAnchorTurnId
              : this.collecting.turnId)
            : this.collecting?.isScheduled
              ? this.collecting.replyAnchorTurnId
              : this.lastLarkTurnId;
          this.pendingCronCreates.set(toolUseId, anchor);
        }
        // The rate_limit API-error record (isApiErrorMessage + error:'rate_limit')
        // is type:"assistant" with a human text block, but it is not a model
        // reply — the worker surfaces it as a `limited` state via
        // isTranscriptRateLimitEvent. Skip attribution so its text isn't leaked
        // to Lark as a final_output. We intentionally do NOT set terminalObserved
        // here: a rate-limited turn produced no real answer, so let the normal
        // terminal marker (or retry) close it.
        //
        // Every API-error record is execution metadata, never a model answer.
        // Its structured terminal outcome is retained below; user visibility
        // and bounded retry are owned by the worker/daemon, respectively.
        if (isTranscriptRateLimitEvent(ev)) {
          // Ends a wake cut before any visible text, like the API-error
          // records below; flush any leading anchor CoT first.
          this.clearPendingBackgroundWake(pendingWakeObserver);
          this.recentUnobservedTurn = null;
          if (this.collecting) {
            this.collecting.rateLimited = true;
            const live = this.liveStates.get(this.collecting);
            if (live) {
              live.pendingToolUseIds.clear();
              live.apiRequestInFlight = false;
              live.awaitingPostToolAssistant = false;
            }
          }
          continue;
        }
        const terminalOutcome = classifyClaudeTerminalEvent(ev);
        // The `<synthetic>` no-model-reply placeholder (see
        // isSyntheticNoModelReplyEvent) takes the same exit as an API error:
        // its "No response requested." text must not become the turn's reply,
        // it must not synthesise a headless local turn, and the turn closes
        // with the retryable failure the classifier produced. The exit is
        // shared; the assignment below is NOT - see the two branches.
        if (ev.isApiErrorMessage === true || isSyntheticNoModelReplyEvent(ev)) {
          // A wake turn this record cut before any visible text has failed,
          // exactly as the record fails a turn already collecting below (the
          // error outranks a later answer). Its wake ends here, whether or not
          // a duration marker follows: left armed it would claim whatever
          // headless text comes next — a continuation of the failed turn or
          // an unrelated turn — for the launching topic.
          this.clearPendingBackgroundWake(pendingWakeObserver);
          this.recentUnobservedTurn = null;
          if (this.collecting) {
            const live = this.liveStates.get(this.collecting);
            if (live) {
              live.pendingToolUseIds.clear();
              live.apiRequestInFlight = false;
              live.awaitingPostToolAssistant = false;
            }
          }
          if (this.collecting && terminalOutcome?.status !== 'rate_limited') {
            // The two signals that share this exit are NOT of equal authority,
            // so they do not share an assignment operator (maintainer ruling on
            // PR #1330):
            if (ev.isApiErrorMessage === true) {
              // An API-error line is authoritative execution metadata. When the
              // connection drops mid-response, Claude force-closes the stream
              // with an `end_turn` record whose text is a half-finished
              // sentence, and that record has already written `completed` here.
              // Letting the error win is what keeps the turn `failed` +
              // retryable, which is the only thing ordinary-turn-recovery acts
              // on (`status !== 'failed' || retryable !== true` → no
              // continuation). Unconditional assignment, therefore.
              this.collecting.terminalOutcome = terminalOutcome;
              this.collecting.terminalOutcomeAtMs = eventTimeMs(ev);
              const detail = apiErrorMessageText(ev).trim();
              if (detail) this.collecting.terminalErrorDetail = detail;
              else delete this.collecting.terminalErrorDetail;
              this.stampProviderLastSuccess(this.collecting);
            } else {
              // The `<synthetic>` placeholder is the WEAKEST terminal signal
              // there is - no model call happened at all (no requestId, usage
              // all zero). It must not downgrade an already-`completed` turn:
              // `emitReadyTurns` (`status !== 'completed' → continue`) would
              // then withhold the real answer text AND let the daemon post a
              // failure card for a turn that had in fact been answered. With no
              // earlier terminal outcome it still records the failure.
              if (this.collecting.terminalOutcome === undefined) {
                this.collecting.terminalOutcome = terminalOutcome;
                this.collecting.terminalOutcomeAtMs = eventTimeMs(ev);
                this.stampProviderLastSuccess(this.collecting);
              }
            }
            this.collecting.terminalObserved = true;
          }
          continue;
        }
        // A real model reply: the provider answered this request.
        const replyAtMs = eventTimeMs(ev);
        // Synthetic local tool calls still follow ordinary attribution below,
        // but no provider answered, so they must not move recovery's clock.
        if (!isSyntheticAssistantRecord(ev) && replyAtMs !== undefined
          && (this.lastProviderReplyAtMs === undefined || replyAtMs > this.lastProviderReplyAtMs)) {
          this.lastProviderReplyAtMs = replyAtMs;
        }
        const hasVisibleText = assistantHasVisibleText(ev.message?.content);
        // Scenario 3: an IM turn was popped at a bounded unobserved boundary
        // before its real assistant records arrived. If the arriving record
        // proves conversation-tree lineage back to that exact turn (with zero
        // intervening prompts/commands/wakes), re-attach instead of minting a
        // suppressed `local-headless-*` turn.
        if (!this.collecting && this.recentUnobservedTurn && this.pendingBackgroundWake === undefined) {
          const anchor = this.recentUnobservedTurn;
          if (!matchesRecentUnobservedLineage(ev, sourceJsonlPath, anchor, Date.now())) {
            this.recentUnobservedTurn = null;
          } else if (!hasVisibleText) {
            this.extendRecentUnobservedChain(uuid, ev);
          } else if (!anchor.hadTrailingVisibleText || anchor.turnId.startsWith('om_')) {
            const recovered: BridgePendingTurn = anchor.hadTrailingVisibleText
              ? {
                  turnId: `late-recovery-${uuid}`,
                  replyAnchorTurnId: anchor.turnId,
                  ...(anchor.dispatchAttempt !== undefined ? { replyAnchorDispatchAttempt: anchor.dispatchAttempt } : {}),
                  ...(anchor.linkRefMode ? { linkRefMode: anchor.linkRefMode } : {}),
                  started: true,
                  isLocal: false,
                  assistantUuids: [],
                  sourceJsonlPath: sourceJsonlPath ?? anchor.sourceJsonlPath,
                  markTimeMs: anchor.markTimeMs,
                }
              : {
                  turnId: anchor.turnId,
                  dispatchAttempt: anchor.dispatchAttempt,
                  ...(anchor.linkRefMode ? { linkRefMode: anchor.linkRefMode } : {}),
                  started: true,
                  isLocal: false,
                  assistantUuids: [],
                  sourceJsonlPath: sourceJsonlPath ?? anchor.sourceJsonlPath,
                  markTimeMs: anchor.markTimeMs,
                };
            this.reattachedFromUnobserved.add(recovered);
            const live = this.liveStateFor(recovered);
            live.startUuid = anchor.startUuid;
            live.sawParentUuid = anchor.sawParentUuid;
            live.pendingToolUseIds = new Set(anchor.pendingToolUseIds);
            live.apiRequestInFlight = anchor.apiRequestInFlight;
            live.awaitingPostToolAssistant = anchor.awaitingPostToolAssistant;
            live.reattachedAtMs = Date.now();
            for (const id of anchor.chainUuids) addBoundedKey(live.chainUuids, id, MAX_TRACKED_CHAIN_UUIDS);
            for (const id of anchor.progressChainUuids) addBoundedKey(live.progressChainUuids, id, MAX_TRACKED_PROGRESS_UUIDS);
            const insertAt = this.queue.findIndex(t => !t.started);
            if (insertAt === -1) this.queue.push(recovered);
            else this.queue.splice(insertAt, 0, recovered);
            this.collecting = recovered;
            this.recentUnobservedTurn = null;
          } else {
            this.recentUnobservedTurn = null;
          }
        }
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
          const wake = this.pendingBackgroundWake;
          this.pendingBackgroundWake = undefined;
          const headless: BridgePendingTurn = {
            turnId: `local-headless-${uuid}`,
            started: true,
            isLocal: true,
            ...(wake?.anchor ? {
              isBackgroundWake: true,
              replyAnchorTurnId: wake.anchor.turnId,
              ...(wake.anchor.dispatchAttempt !== undefined ? { replyAnchorDispatchAttempt: wake.anchor.dispatchAttempt } : {}),
            } : {}),
            ...(wake && wake.anchor === null ? { backgroundWakeUnrouted: true } : {}),
            ...(wake?.nonTerminalMonitor ? { wakeNonTerminalMonitor: true as const } : {}),
            ...(wake?.emittedAnchorCot ? { cotAnchor: { ...wake.emittedAnchorCot } } : {}),
            ...(wake?.monitorTaskIds.size ? { monitorWakeTaskIds: new Set(wake.monitorTaskIds) } : {}),
            userUuid: undefined,
            replyContextTurnId: this.lastLocalTurnId,
            precedingLarkTurnId: this.lastLarkTurnId,
            assistantUuids: [],
            sourceJsonlPath,
            markTimeMs: Date.now(),
          };
          const insertAt = this.queue.findIndex(t => !t.started);
          if (insertAt === -1) this.queue.push(headless);
          else this.queue.splice(insertAt, 0, headless);
          this.collecting = headless;
          this.onLocalTurnStarted?.(headless);
        }
        if (this.collecting) {
          this.collecting.hasAssistantActivity = true;
          this.collecting.attributedActivitySeq
            = (this.collecting.attributedActivitySeq ?? 0) + 1;
          const live = this.recordChainUuid(this.collecting, uuid, ev);
          const toolIds = assistantToolUseIds(ev);
          // Preserve `apiRequestInFlight` across intermediate streaming blocks
          // (`stop_reason: null`) so a thinking-only or narration block before a
          // large `Write`/`Edit` `tool_use` does not collapse the watchdog tier
          // from `in_flight_model` (120s) down to `unmarked_partial` (4s).
          const isStreamingNullBlock = ev.message?.stop_reason == null;
          if (!(isStreamingNullBlock
            && ((!hasVisibleText && toolIds.length === 0) || (this.durationMarkerSeen && toolIds.length === 0)))) {
            live.apiRequestInFlight = false;
          }
          live.awaitingPostToolAssistant = false;
          live.manualCompactPending = false;
          live.activitySeq++;
          for (const toolId of toolIds) live.pendingToolUseIds.add(toolId);
          // Match `trailingAssistantText`: a record carrying `tool_use` (even
          // paired with a `text` block) does NOT leave trailing visible text.
          if (toolIds.length > 0) live.hasTrailingVisibleText = false;
          else if (hasVisibleText) live.hasTrailingVisibleText = true;
          if (ev.message?.stop_reason === 'pause_turn') live.awaitingPostToolAssistant = true;
        } else if (this.pendingBackgroundWake) {
          // Text-less leading assistant record (thinking / tool_use) during an
          // armed background wake: do not synthesise early, but expose CoT
          // entries to the anchor observer while the wake stays a pure
          // non-terminal Monitor mid-stream event.
          this.pendingBackgroundWake.hasAssistantActivity = true;
          if (pendingWakeObserver?.onActivity
            && this.pendingBackgroundWake.nonTerminalMonitor
            && this.pendingBackgroundWake.anchor !== null) {
            this.pendingBackgroundWake.emittedAnchorCot ??= { ...this.pendingBackgroundWake.anchor };
            try { pendingWakeObserver.onActivity(ev, { ...this.pendingBackgroundWake.anchor }); } catch { /* observer channel */ }
          }
        }
        if (hasVisibleText) this.collecting?.assistantUuids.push(uuid);
        if (this.collecting && onAssistantAttributed) {
          try { onAssistantAttributed(ev, this.collecting); } catch { /* observer channel — never break attribution */ }
        }
        if (isClaudeTurnTerminalEvent(ev) && this.collecting) {
          this.collecting.terminalObserved = true;
          // Provisional: this may be any block of the final message, not its
          // last one. Records that follow stay attributed here because the turn
          // keeps `collecting`; drainEmittable holds it for the duration marker.
          this.collecting.awaitingDurationMarker = true;
          const live = this.liveStates.get(this.collecting);
          if (live) live.pendingToolUseIds.clear();
          if (terminalOutcome?.status !== 'rate_limited') {
            this.collecting.terminalOutcome ??= terminalOutcome;
          }
        }
      } else if (isClaudeTurnTerminalEvent(ev)) {
        // Claude normally writes this as `system/turn_duration` immediately
        // after the final assistant line. A local transcript can legitimately
        // contain visible text with `stop_reason:null`; the duration marker is
        // still authoritative proof that the turn completed. Keep a previously
        // classified API failure, but otherwise use the same completed default
        // as the next-turn-start compatibility boundary below.
        if (isClaudeTurnDurationEvent(ev)) {
          this.durationMarkerSeen = true;
          // Flush any anchor CoT buffered during a text-less pre-text wake
          // (even if the wake was later disarmed mid-turn) before clearing it.
          this.clearPendingBackgroundWake(pendingWakeObserver);
        }
        if (this.collecting) {
          const live = this.recordChainUuid(this.collecting, uuid, ev);
          live.pendingToolUseIds.clear();
          live.apiRequestInFlight = false;
          live.awaitingPostToolAssistant = false;
          live.activitySeq++;
          this.collecting.terminalObserved = true;
          this.collecting.awaitingDurationMarker = false;
          if (isClaudeTurnDurationEvent(ev)) {
            this.collecting.closedByDurationMarker = true;
            try { onTurnDurationAttributed?.(ev, this.collecting); } catch { /* observer channel — never break attribution */ }
          }
          if (!this.collecting.rateLimited) {
            this.collecting.terminalOutcome ??= { status: 'completed' };
          }
        } else if (isClaudeTurnDurationEvent(ev)) {
          this.recentUnobservedTurn = null;
        }
      } else if (ev.type === 'system') {
        if (ev.subtype === 'compact_boundary') {
          if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
            const live = this.recordChainUuid(this.collecting, uuid, ev);
            if (ev.compactMetadata?.trigger === 'manual') {
              live.manualCompactPending = true;
            } else {
              live.manualCompactPending = false;
              live.awaitingPostToolAssistant = true;
              live.activitySeq++;
            }
          } else {
            this.recentUnobservedTurn = null;
          }
        } else if (ev.subtype === 'local_command') {
          this.recentUnobservedTurn = null;
        } else if (ev.subtype !== 'away_summary') {
          if (this.collecting && !this.collecting.terminalObserved && !this.collecting.closedByDurationMarker) {
            this.recordChainUuid(this.collecting, uuid, ev);
          } else if (!this.collecting && this.recentUnobservedTurn
            && matchesRecentUnobservedLineage(ev, sourceJsonlPath, this.recentUnobservedTurn, Date.now())) {
            this.extendRecentUnobservedChain(uuid, ev);
          }
        }
      }
    }
  }

  /** Pair CronCreate tool_result acks with their earlier tool_use calls and
   *  file the call-time topic anchor under the scheduled task id.
   *
   *  Must-fix: only accept an ack whose tool_use_id matches a PENDING
   *  CronCreate call. An unrelated Read/Bash tool_result whose text merely
   *  CONTAINS the literal "Scheduled recurring job task-A …" (e.g. grepping a
   *  log) must not overwrite task-A's anchor — without the has() check it
   *  would be filed under undefined and reroute A's next fire to the wrong
   *  topic. */
  private handleCronCreateAcks(ev: TranscriptEvent): void {
    for (const ack of cronCreateAcks(ev)) {
      if (!this.pendingCronCreates.has(ack.toolUseId)) continue;
      const anchor = this.pendingCronCreates.get(ack.toolUseId);
      this.pendingCronCreates.delete(ack.toolUseId);
      this.scheduledTaskAnchors.set(ack.taskId, anchor);
      try { this.onScheduledTaskAnchored?.(ack.taskId, anchor); } catch { /* observer only */ }
    }
  }

  private recordBackgroundTaskMetadata(launches: Iterable<BackgroundTaskLaunch>): void {
    for (const launch of launches) {
      this.backgroundTaskMeta.delete(launch.taskId);
      this.backgroundTaskMeta.set(launch.taskId, {
        kind: launch.kind,
        ...(launch.persistent !== undefined ? { persistent: launch.persistent } : {}),
        ...(launch.expiresAtMs !== undefined ? { expiresAtMs: launch.expiresAtMs } : {}),
      });
    }
    while (this.backgroundTaskMeta.size > BACKGROUND_TASK_META_MAX) {
      this.backgroundTaskMeta.delete(this.backgroundTaskMeta.keys().next().value!);
    }
  }

  /** File the launch metadata (always) and Lark anchor (when known) of the
   *  running turn under each background task a main-thread tool_result just
   *  acked as launched. A wake turn that has not said anything yet has no
   *  headless turn collecting; the wake it armed is what is running, so its
   *  launches inherit that anchor (never an ambiguous one). */
  private recordBackgroundTaskLaunches(ev: TranscriptEvent): void {
    const launches = backgroundTaskLaunches(ev);
    if (launches.length === 0) return;
    this.recordBackgroundTaskMetadata(launches);
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    const isLateRecovery = !!running && this.reattachedFromUnobserved.has(running) && !!running.replyAnchorTurnId;
    const anchor: BackgroundTaskAnchor | undefined = running && !running.isLocal
      ? {
        turnId: isLateRecovery ? running.replyAnchorTurnId! : running.turnId,
        ...((isLateRecovery ? running.replyAnchorDispatchAttempt : running.dispatchAttempt) !== undefined
          ? { dispatchAttempt: isLateRecovery ? running.replyAnchorDispatchAttempt : running.dispatchAttempt }
          : {}),
      }
      : (running?.isScheduled || running?.isBackgroundWake) && running.replyAnchorTurnId
        ? {
          turnId: running.replyAnchorTurnId,
          ...(running.replyAnchorDispatchAttempt !== undefined ? { dispatchAttempt: running.replyAnchorDispatchAttempt } : {}),
        }
        : !running && this.pendingBackgroundWake?.anchor
          ? this.pendingBackgroundWake.anchor
          : undefined;
    if (!anchor) return;
    for (const launch of launches) {
      this.backgroundTaskAnchors.delete(launch.taskId);
      this.backgroundTaskAnchors.set(launch.taskId, { ...anchor });
    }
    while (this.backgroundTaskAnchors.size > BACKGROUND_TASK_ANCHORS_MAX) {
      this.backgroundTaskAnchors.delete(this.backgroundTaskAnchors.keys().next().value!);
    }
  }

  /** Strict predicate for whether a delivered `<task-notification>` is a pure
   *  non-terminal mid-stream event from a known non-persistent (`persistent:
   *  false`) Monitor that has not reached its expiry boundary. Fails open
   *  (`false`) on any uncertainty (including missing event timestamp when the
   *  Monitor carries an `expiresAtMs` deadline) so terminal/persistent/expired
   *  notices are never suppressed. */
  private isNonTerminalMonitorNotice(ev: TranscriptEvent, notice: ParsedTaskNotification): boolean {
    if (ev.type !== 'attachment' && ev.promptSource !== 'system') return false;
    if (notice.hasTerminalStatus || notice.isMonitorExpiry) return false;
    const meta = this.backgroundTaskMeta.get(notice.taskId);
    if (!meta || meta.kind !== 'monitor' || meta.persistent !== false) return false;
    const atMs = eventTimeMs(ev);
    if (meta.expiresAtMs !== undefined && (atMs === undefined || atMs >= meta.expiresAtMs)) return false;
    return true;
  }

  /** Clear `pendingBackgroundWake` and flush any anchor CoT that already
   *  streamed pre-text records to `pendingWakeObserver`. */
  private clearPendingBackgroundWake(pendingWakeObserver?: PendingWakeCotObserver): void {
    const cotAnchor = this.pendingBackgroundWake?.emittedAnchorCot
      ? { ...this.pendingBackgroundWake.emittedAnchorCot }
      : undefined;
    this.pendingBackgroundWake = undefined;
    if (cotAnchor && pendingWakeObserver?.onTextlessComplete) {
      try { pendingWakeObserver.onTextlessComplete(cotAnchor); } catch { /* observer channel */ }
    }
  }

  /** Retire settled background tasks from `backgroundTaskMeta` so late notices
   *  fail open, and disarm any active/armed Monitor wake when Claude explicitly
   *  stops a task (`TaskStop`) or the TUI kills the wake's own Monitor. */
  private settleBackgroundTasksFromEvent(ev: TranscriptEvent, disarmActiveWake: boolean): void {
    const settled = backgroundTaskSettledIds(ev);
    if (settled.length === 0) return;
    for (const id of settled) this.backgroundTaskMeta.delete(id);
    if (!disarmActiveWake) return;
    const isTaskStop = hasTranscriptRole(ev, 'user') && isPureToolResultUserEvent(ev.message?.content);
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    if (isTaskStop) {
      if (this.pendingBackgroundWake) this.pendingBackgroundWake.nonTerminalMonitor = false;
      this.disarmCollectingMonitorWake();
      return;
    }
    // `queue-operation: enqueue` (e.g. TUI kill): disarm only if one of the
    // settled task ids belongs to the currently armed/collecting Monitor wake.
    if (this.pendingBackgroundWake?.nonTerminalMonitor
      && settled.some(id => this.pendingBackgroundWake!.monitorTaskIds.has(id))) {
      this.pendingBackgroundWake.nonTerminalMonitor = false;
    }
    if (running?.wakeNonTerminalMonitor
      && settled.some(id => running.monitorWakeTaskIds?.has(id) === true)) {
      delete running.wakeNonTerminalMonitor;
    }
  }

  /** True when `this.collecting` is no longer open for a new `<task-notification>`
   *  to fold into (nothing collecting, closed by `system/turn_duration`, or a
   *  markerless turn that already observed `end_turn`). */
  private isCollectingClosedForWake(): boolean {
    return !this.collecting
      || this.collecting.closedByDurationMarker === true
      || (this.collecting.terminalObserved === true && !this.isAwaitingDurationMarker(this.collecting));
  }

  /** A delivered main-thread `role:user` `<task-notification>` that OPENS a
   *  turn (nothing collecting, or the last turn already terminated) for a task
   *  with a known launch anchor arms a background wake for the headless turn
   *  its reply synthesises. Independently of Lark anchoring, it tracks whether
   *  EVERY notice opening this turn is a qualifying non-terminal Monitor
   *  mid-stream event (`nonTerminalMonitor`). A notice folded into a running
   *  turn, a sidechain one, one written before this queue existed, one not
   *  written by Claude Code itself (`promptSource` other than `system`), or
   *  one for a task without an anchor arms no Lark route — and any mixed or
   *  id-less batch fails open regardless of arrival order. */
  private notePendingBackgroundWake(ev: TranscriptEvent): void {
    if (ev.isSidechain === true || !hasTranscriptRole(ev, 'user')) return;
    const opensTurn = this.isCollectingClosedForWake();
    const notice = parseTaskNotification(ev);
    if (!notice) {
      // Defensive fail-open: an id-less `<task-notification>` still poisons a
      // wake batch regardless of whether it arrived before or after a Monitor
      // notice, without retroactively mutating an already-closed turn.
      if (!isPureToolResultUserEvent(ev.message?.content)
        && extractTurnStartText(ev).trimStart().startsWith('<task-notification>')) {
        if (opensTurn) {
          this.pendingBackgroundWake = {
            anchor: null,
            nonTerminalMonitor: false,
            hasAssistantActivity: this.pendingBackgroundWake?.hasAssistantActivity ?? false,
            ...(this.pendingBackgroundWake?.emittedAnchorCot ? { emittedAnchorCot: this.pendingBackgroundWake.emittedAnchorCot } : {}),
            monitorTaskIds: this.pendingBackgroundWake?.monitorTaskIds ?? new Set(),
          };
        } else {
          this.unrouteCollectingWake(undefined);
          this.disarmCollectingMonitorWake();
        }
      }
      return;
    }
    const isNonTerminalMon = this.isNonTerminalMonitorNotice(ev, notice);
    if (!opensTurn) {
      this.unrouteCollectingWake(this.backgroundTaskAnchors.get(notice.taskId));
      if (!isNonTerminalMon) this.disarmCollectingMonitorWake();
      return;
    }
    const atMs = eventTimeMs(ev);
    const liveAnchor = ev.promptSource === 'system' && atMs !== undefined && atMs >= this.liveSinceMs
      ? this.backgroundTaskAnchors.get(notice.taskId)
      : undefined;
    const prev = this.pendingBackgroundWake;
    if (!prev) {
      this.pendingBackgroundWake = {
        anchor: liveAnchor ? { ...liveAnchor } : null,
        nonTerminalMonitor: isNonTerminalMon,
        hasAssistantActivity: false,
        monitorTaskIds: new Set(isNonTerminalMon ? [notice.taskId] : []),
      };
    } else {
      const monitorTaskIds = prev.monitorTaskIds;
      if (isNonTerminalMon) monitorTaskIds.add(notice.taskId);
      this.pendingBackgroundWake = {
        anchor: sameBackgroundTaskAnchor(prev.anchor, liveAnchor) ? prev.anchor : null,
        nonTerminalMonitor: prev.nonTerminalMonitor && isNonTerminalMon,
        hasAssistantActivity: prev.hasAssistantActivity,
        ...(prev.emittedAnchorCot ? { emittedAnchorCot: prev.emittedAnchorCot } : {}),
        monitorTaskIds,
      };
    }
  }

  /** A `<task-notification>` Claude Code folded into a turn via
   *  `attachment(queued_command)` (with `commandMode: 'task-notification'` OR
   *  whose prompt starts with `<task-notification>`): the turn's answer now
   *  covers that task too. It only ever DISARMS — never arms an anchor or
   *  suppression — and poisons `pendingBackgroundWake` even if it arrives
   *  before a `role:user` Monitor notice while idle, without mutating a turn
   *  already closed by `turn_duration`. */
  private noteAbsorbedBackgroundNotice(ev: TranscriptEvent): void {
    if (ev.isSidechain === true) return;
    const isTaskNoticeAttachment = ev.attachment?.commandMode === 'task-notification'
      || extractTurnStartText(ev).trimStart().startsWith('<task-notification>');
    if (!isTaskNoticeAttachment) return;
    const opensTurn = this.isCollectingClosedForWake();
    const notice = parseTaskNotification(ev);
    const anchor = notice ? this.backgroundTaskAnchors.get(notice.taskId) : undefined;
    const isNonTerminalMon = notice !== undefined && this.isNonTerminalMonitorNotice(ev, notice);
    if (opensTurn) {
      if (this.pendingBackgroundWake) {
        if (this.pendingBackgroundWake.anchor !== null
          && !sameBackgroundTaskAnchor(this.pendingBackgroundWake.anchor, anchor)) {
          this.pendingBackgroundWake.anchor = null;
        }
        if (!isNonTerminalMon) this.pendingBackgroundWake.nonTerminalMonitor = false;
        else if (notice) this.pendingBackgroundWake.monitorTaskIds.add(notice.taskId);
      } else {
        // Poison when idle so a subsequent role:user Monitor notice in the same
        // batch cannot arm suppression or single-topic routing over this notice.
        this.pendingBackgroundWake = {
          anchor: null,
          nonTerminalMonitor: false,
          hasAssistantActivity: false,
          monitorTaskIds: new Set(),
        };
      }
      return;
    }
    this.unrouteCollectingWake(anchor);
    if (!isNonTerminalMon) this.disarmCollectingMonitorWake();
  }

  /** A notice folded into the collecting wake turn whose launch anchor differs
   *  (or is unknown): the merged answer no longer belongs to one topic, so the
   *  turn falls back to an ordinary local turn (logged as unrouted). */
  private unrouteCollectingWake(noticeAnchor: BackgroundTaskAnchor | undefined): void {
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    if (!running?.isBackgroundWake) return;
    const current: BackgroundTaskAnchor | undefined = running.replyAnchorTurnId
      ? {
        turnId: running.replyAnchorTurnId,
        ...(running.replyAnchorDispatchAttempt !== undefined ? { dispatchAttempt: running.replyAnchorDispatchAttempt } : {}),
      }
      : undefined;
    if (sameBackgroundTaskAnchor(current, noticeAnchor)) return;
    delete running.isBackgroundWake;
    delete running.replyAnchorTurnId;
    delete running.replyAnchorDispatchAttempt;
    running.backgroundWakeUnrouted = true;
  }

  private disarmCollectingMonitorWake(): void {
    const running = this.collecting?.closedByDurationMarker ? null : this.collecting;
    if (running?.wakeNonTerminalMonitor) delete running.wakeNonTerminalMonitor;
  }

  /** Distinct Lark turns that the given (still running) background tasks
   *  were launched from, in launch order. The worker reports them to the
   *  daemon, which keeps their reply-routing records past its bounded
   *  eviction while the task can still wake the session — the same pin a
   *  CronCreate task holds on its create-time topic. Tasks without an anchor
   *  contribute nothing. */
  backgroundTaskAnchorTurnIds(liveTaskIds: Iterable<string>): string[] {
    const live = new Set(liveTaskIds);
    const out = new Set<string>();
    for (const [taskId, anchor] of this.backgroundTaskAnchors) {
      if (live.has(taskId)) out.add(anchor.turnId);
    }
    return [...out];
  }

  /** Restore task→anchor pairs from the worker's durable store after a
   *  restart. Does not overwrite a pair established THIS process (a live
   *  re-create wins over stale disk), and never creates an anchor for a task
   *  the store doesn't know. */
  restoreScheduledTaskAnchors(restored: ReadonlyMap<string, string | undefined>): void {
    for (const [taskId, anchor] of restored) {
      if (!this.scheduledTaskAnchors.has(taskId)) {
        this.scheduledTaskAnchors.set(taskId, anchor);
      }
    }
  }

  /** Test/inspection helper: the anchor recorded for a known task. */
  scheduledTaskAnchor(taskId: string): string | undefined {
    return this.scheduledTaskAnchors.get(taskId);
  }

  /** Full taskId → create-time turnId snapshot (undefined anchor renders as
   *  null), used to sync the durable map to the daemon so it can pin the
   *  referenced replyTargets records against its 32-entry eviction. */
  scheduledTaskAnchorsSnapshot(): Array<{ taskId: string; turnId: string | null }> {
    return [...this.scheduledTaskAnchors.entries()]
      .map(([taskId, turnId]) => ({ taskId, turnId: turnId ?? null }));
  }

  /** Built-in CronCreate fire handler. Like a local-terminal turn it matches
   *  no Lark fingerprint, but it is user-scheduled rather than ambient typing,
   *  so the worker forwards its final (isScheduled) and anchors the reply to
   *  the topic captured when THIS task was created. Pending Lark marks stay
   *  unstarted — the scheduler's prompt must never fingerprint-bind them. */
  private handleScheduledTurnStart(uuid: string, ev: TranscriptEvent, sourceJsonlPath?: string): void {
    this.pendingBackgroundWake = undefined;
    this.recentUnobservedTurn = null;
    // Same transcript-order closeout as a real turn start.
    if (this.collecting && !this.collecting.terminalObserved) {
      if (this.collecting.dispatchAttempt !== undefined || this.collecting.hasAssistantActivity) {
        this.collecting.terminalObserved = true;
        this.collecting = null;
      }
    }
    if (this.collecting
      && !this.collecting.terminalObserved
      && this.collecting.assistantUuids.length === 0
      && !this.collecting.hasAssistantActivity) {
      const idx = this.queue.indexOf(this.collecting);
      if (idx >= 0) this.queue.splice(idx, 1);
      if (!this.collecting.isLocal) this.droppedNeedingJournalClear.push(this.collecting);
      this.dropAbsorbedTurns(this.collecting);
      this.collecting = null;
    }
    const tsParsed = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    const eventTimeMs = Number.isFinite(tsParsed) ? tsParsed : Date.now();
    // scheduledFireId is unique per fire and always present; fall back to the
    // record uuid only defensively.
    const fireId = typeof ev.scheduledFireId === 'string' && ev.scheduledFireId
      ? ev.scheduledFireId
      : uuid;
    // Route to the topic captured when THIS task was created. The anchor is
    // taken STRICTLY from the task map (live CronCreate/ack or restored from
    // the durable store). An unknown task — no create/ack observed this
    // process and nothing restored — gets NO anchor: borrowing lastLarkTurnId
    // here would route a pre-attach task into whatever topic happened to be
    // most recent, which after a worker restart is exactly the cross-topic
    // leak this class guards against. The worker omits replyTurnId and the
    // daemon falls back to its default routing.
    const taskId = typeof ev.scheduledTaskId === 'string' && ev.scheduledTaskId
      ? ev.scheduledTaskId
      : undefined;
    const anchor = taskId && this.scheduledTaskAnchors.has(taskId)
      ? this.scheduledTaskAnchors.get(taskId)
      : undefined;
    const scheduledTurn: BridgePendingTurn = {
      turnId: `scheduled-${fireId}`,
      started: true,
      isLocal: true,
      isScheduled: true,
      replyAnchorTurnId: anchor,
      // Inherit the previous local turn's reply context (zero-injection
      // sessions capture it daemon-side via terminal_turn_started).
      replyContextTurnId: this.lastLocalTurnId,
      userUuid: uuid,
      assistantUuids: [],
      sourceJsonlPath,
      markTimeMs: eventTimeMs,
    };
    const insertAt = this.queue.findIndex(t => !t.started);
    if (insertAt === -1) this.queue.push(scheduledTurn);
    else this.queue.splice(insertAt, 0, scheduledTurn);
    this.collecting = scheduledTurn;
    this.lastLocalTurnId = scheduledTurn.turnId;
    this.onLocalTurnStarted?.(scheduledTurn);
  }

  /** Queue records have no uuid, so they are deduped on their own identity: a
   *  transcript switch can replay them. They never start a turn. */
  private observeCliQueueOperation(ev: TranscriptEvent): void {
    const atMs = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isFinite(atMs)) return;
    const candidates = typeof ev.content === 'string' ? normaliseTranscriptFingerprintCandidates(ev.content) : [''];
    const text = candidates[0]!;
    // Several dequeues can share one millisecond; replaying them is harmless
    // because a transcript switch empties the mirror first.
    if (ev.operation !== 'dequeue') {
      // Same-millisecond records of equal length but DIFFERENT content really
      // occur (same-ms removes carrying distinct commandUuid: 14 groups in
      // fleet transcripts), so the identity is the record's own id, falling
      // back to the full normalised text — never the text's length.
      const identity = ev.commandUuid ?? ev.deliveryId ?? text;
      const key = `queue:${ev.operation}:${ev.timestamp}:${identity}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    if (ev.operation === 'enqueue') {
      const eligible = this.queue.filter(t => !(t.started || t.cliQueuedAtMs !== undefined
        || t.markTimeMs === undefined || atMs < t.markTimeMs - CLI_QUEUE_MARK_SKEW_MS
        || !t.contentNormalized || t.contentNormalized.length < TRUNCATION_MATCH_MIN_CHARS));
      const evaluations = evaluateMarksAgainstTranscript(this.attributionMatchTurns(eligible), candidates);
      const eligibleSet = new Set(eligible);
      const first = evaluations.find(evaluation => eligibleSet.has(evaluation.turn)
        && (evaluation.match.anyFullContentMatch || evaluation.match.truncationMatch));
      const conflict = first ? residueAttributionConflictTurns(evaluations, first) : [];
      if (conflict.length > 0) this.noteResidueConflict(conflict, atMs);
      const turn = first && conflict.length === 0 ? first.turn : undefined;
      if (turn) turn.cliQueuedAtMs = atMs;
      this.cliQueue.push({ text, candidates, ...(turn ? { turn } : {}) });
      return;
    }
    // A content-less remove (e.g. dropped by a hook) cannot say which input left.
    if (ev.operation !== 'dequeue' && text.length === 0) {
      this.forgetCliQueue(atMs);
      return;
    }
    // A remove may match more than one mirror item once residue candidates
    // are considered. Exact duplicates can leave in FIFO order, but an
    // exact-vs-residue or multi-candidate ambiguity proves nothing about
    // which input left: keep every mark held for dequeue/idle evidence.
    let idx = ev.operation === 'dequeue' ? 0 : -1;
    if (ev.operation !== 'dequeue') {
      const exact: number[] = [];
      const compatible: number[] = [];
      for (let i = 0; i < this.cliQueue.length; i++) {
        const item = this.cliQueue[i]!;
        if (item.text === text) exact.push(i);
        if (item.text === text || item.candidates.some(candidate => candidates.includes(candidate))) compatible.push(i);
      }
      if (exact.length > 0 && exact.length === compatible.length) idx = exact[0]!;
      else if (exact.length === 0 && compatible.length === 1) idx = compatible[0]!;
    }
    const [left] = idx >= 0 ? this.cliQueue.splice(idx, 1) : [];
    if (left?.turn) left.turn.cliQueueReleasedAtMs = atMs;
  }

  /** A message typed while a turn ran, which Claude Code folded into that turn
   *  as a system reminder instead of starting a new one. Not a turn boundary
   *  (the running turn keeps collecting), but it is where the pending Lark
   *  mark's input entered the conversation, and no `role:user` line follows.
   *  Bind the mark here — under the same fingerprint / truncation proof as a
   *  real turn start — and end it together with the turn that absorbed it;
   *  otherwise the mark expires unmatched and its turn never gets a terminal.
   *  A non-matching or unfingerprinted mark is left alone. */
  private handleAbsorbedInput(
    ev: TranscriptEvent,
    sourceJsonlPath?: string,
    pendingWakeObserver?: PendingWakeCotObserver,
  ): boolean {
    const next = this.queue.find(t => !t.started);
    if (!next?.contentFingerprint) return false;
    const evaluations = evaluateMarksAgainstTranscript(
      this.attributionMatchTurns(this.queue.filter(turn => !turn.started)),
      normaliseTranscriptFingerprintCandidates(extractTurnStartText(ev)),
    );
    const evaluation = evaluations.find(item => item.turn === next)!;
    const tsParsed = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    const eventTimeMs = Number.isFinite(tsParsed) ? tsParsed : Date.now();
    const conflict = residueAttributionConflictTurns(evaluations, evaluation);
    if (conflict.length > 0) this.noteResidueConflict(conflict, eventTimeMs);
    if ((!evaluation.match.fingerprintMatch && !evaluation.match.truncationMatch)
      || conflict.length > 0) return false;
    const fullContentMatch = evaluation.match.legacyFullContentMatch;
    const exactContentMatch = evaluation.match.legacyExactContentMatch;
    next.started = true;
    next.fullContentMatch = fullContentMatch;
    next.exactContentMatch = exactContentMatch;
    this.resolveResidueConflictFor(next);
    if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
    next.markTimeMs = eventTimeMs;
    const host = this.collecting;
    if (host && !host.terminalObserved
      && host.isLocal && !host.userUuid && (host.wakeNonTerminalMonitor || host.isBackgroundWake)) {
      // A real Lark turn folded mid-turn into a headless background-wake turn:
      // promote the Lark turn to own subsequent output instead of burying it
      // inside `host.absorbedTurns` (which would swallow it in send mode or
      // misroute it to the Monitor's launching topic in transcript mode).
      host.terminalObserved = true;
      const hostLive = this.liveStates.get(host);
      if (hostLive) {
        hostLive.pendingToolUseIds.clear();
        hostLive.apiRequestInFlight = false;
        hostLive.awaitingPostToolAssistant = false;
      }
      this.clearPendingBackgroundWake(pendingWakeObserver);
      this.recentUnobservedTurn = null;
      this.collecting = next;
      if (typeof ev.uuid === 'string' && ev.uuid) {
        const live = this.recordChainUuid(next, ev.uuid, ev);
        live.startUuid = ev.uuid;
        live.awaitingPostToolAssistant = true;
      }
    } else if (host && !host.terminalObserved) {
      next.absorbedIntoTurnId = host.turnId;
      if (typeof ev.uuid === 'string' && ev.uuid) next.absorbedAtUuid = ev.uuid;
      const activitySeq = host.attributedActivitySeq ?? 0;
      const previous = host.absorbedTurns?.at(-1);
      if (previous?.absorbedActivitySeqAtFold === activitySeq) next.absorbedReplyAmbiguous = true;
      next.absorbedActivitySeqAtFold = activitySeq;
      (host.absorbedTurns ??= []).push(next);
      if (typeof ev.uuid === 'string' && ev.uuid) {
        const hostLive = this.recordChainUuid(host, ev.uuid, ev);
        hostLive.awaitingPostToolAssistant = true;
        hostLive.activitySeq++;
      }
    } else {
      // Nothing is collecting (e.g. the worker restarted mid-turn and lost the
      // running turn): what the model does from here on answers this input.
      this.clearPendingBackgroundWake(pendingWakeObserver);
      this.recentUnobservedTurn = null;
      this.collecting = next;
      if (typeof ev.uuid === 'string' && ev.uuid) {
        const live = this.recordChainUuid(next, ev.uuid, ev);
        live.startUuid = ev.uuid;
      }
    }
    this.lastLarkTurnId = next.turnId;
    this.lastLocalTurnId = undefined;
    this.onLarkTurnStarted?.(next, {
      fullContentMatch,
      exactContentMatch,
      ...(sourceJsonlPath ? { sourceJsonlPath } : {}),
    });
    return true;
  }

  /** A head-of-line dropped turn takes the input it absorbed with it: left
   *  behind, a started turn that can never see a terminal would block the
   *  queue head for good. */
  private dropAbsorbedTurns(host: BridgePendingTurn): void {
    for (const absorbed of host.absorbedTurns ?? []) {
      const idx = this.queue.indexOf(absorbed);
      if (idx < 0) continue;
      this.queue.splice(idx, 1);
      this.droppedNeedingJournalClear.push(absorbed);
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
    this.pendingBackgroundWake = undefined;
    this.recentUnobservedTurn = null;
    // A following real user/queued-command event is itself a transcript-order
    // proof that the previous durable turn ended. This covers older Claude
    // JSONL variants that omitted the explicit final marker, without trusting
    // the TUI's prompt-looking screen. Keep the turn queued so an empty/silent
    // durable delivery still produces its terminal receipt.
    if (this.collecting && !this.collecting.terminalObserved) {
      if (this.collecting.dispatchAttempt !== undefined || this.collecting.hasAssistantActivity) {
        this.collecting.terminalObserved = true;
        this.collecting = null;
      }
    }
    // Head-of-line block drop: previous turn never produced any visible
    // assistant text or assistant activity and a new meaningful turn-start has arrived → Claude
    // is single-threaded over the PTY, so the old turn will never get
    // text. Applies to both Lark and local turns.
    if (this.collecting
      && !this.collecting.terminalObserved
      && this.collecting.assistantUuids.length === 0
      && !this.collecting.hasAssistantActivity) {
      const idx = this.queue.indexOf(this.collecting);
      if (idx >= 0) this.queue.splice(idx, 1);
      // This turn will never reach drainEmittable, which is where the worker
      // retires its durable journal entry. Record it so the worker can clear
      // the journal here too — otherwise the entry survives, and every later
      // restart re-marks it and replays the same stretch of transcript. That
      // is not hypothetical: one entry was restored on six consecutive
      // restarts, twice resurfacing a hours-old provider error as a fresh
      // 「本轮执行失败」card. Local turns are skipped: they are synthesised by
      // this queue and never had a journal entry to begin with.
      if (!this.collecting.isLocal) this.droppedNeedingJournalClear.push(this.collecting);
      this.dropAbsorbedTurns(this.collecting);
      this.collecting = null;
    }
    const tsParsed = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    const eventTimeMs = Number.isFinite(tsParsed) ? tsParsed : Date.now();
    const next = this.queue.find(t => !t.started);
    let consumedNext = false;
    let fullContentMatch = false;
    let exactContentMatch = false;
    if (next) {
      if (next.contentFingerprint) {
        // The mark keeps its legacy identity. Transcript text additionally
        // gets a residue-tolerant candidate, but only the legacy candidate
        // can prove full-content consumption.
        const evaluations = evaluateMarksAgainstTranscript(
          this.attributionMatchTurns(this.queue.filter(turn => !turn.started)),
          normaliseTranscriptFingerprintCandidates(extractTurnStartText(ev)),
        );
        const evaluation = evaluations.find(item => item.turn === next)!;
        const match = evaluation.match;
        const conflict = residueAttributionConflictTurns(evaluations, evaluation);
        if (conflict.length > 0) this.noteResidueConflict(conflict, eventTimeMs);
        const ambiguous = conflict.length > 0;
        fullContentMatch = match.legacyFullContentMatch;
        exactContentMatch = match.legacyExactContentMatch;
        if (!ambiguous && match.fingerprintMatch) {
          next.started = true;
          if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
          next.markTimeMs = eventTimeMs;
          this.collecting = next;
          consumedNext = true;
        } else if (!ambiguous && match.truncationMatch) {
          // TRUNCATION-PROOF bind (capability-agnostic — see isTruncatedMatch).
          // The head-substring fingerprint didn't match because claude-code
          // TRUNCATES the leading envelope lines (`<user_message>` +
          // `<botmux_task …>`) when persisting the user turn. But the recorded
          // line is PROVABLY this turn's user event: its normalised text is a
          // non-trivial contiguous substring of the FULL marked content
          // (`contentNormalized`), i.e. exactly the surviving tail of what we
          // sent. This does NOT guess from session type (apiOnly/adopt) —
          // unrelated local terminal input like `pwd` is not a substring of the
          // marked API/Lark prompt, so it can never steal the durable mark
          // (the write-terminal race codex flagged on PR #724).
          next.started = true;
          if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
          next.markTimeMs = eventTimeMs;
          this.collecting = next;
          consumedNext = true;
        }
        // Otherwise (no fingerprint match, not a provable truncation) falls
        // through to local-turn synthesis below (adopt) or is skipped (managed).
      } else {
        // Legacy mark() with no fingerprint — start on the next turn-start.
        next.started = true;
        if (!next.sourceJsonlPath) next.sourceJsonlPath = sourceJsonlPath;
        next.markTimeMs = eventTimeMs;
        this.collecting = next;
        consumedNext = true;
      }
    }
    if (consumedNext && next) {
      next.fullContentMatch = fullContentMatch;
      next.exactContentMatch = exactContentMatch;
      const live = this.recordChainUuid(next, uuid, ev);
      live.startUuid = uuid;
      this.resolveResidueConflictFor(next);
      this.onLarkTurnStarted?.(next, {
        fullContentMatch,
        exactContentMatch,
        ...(sourceJsonlPath ? { sourceJsonlPath } : {}),
      });
    }
    if (!consumedNext) {
      // The user event neither fingerprint-matched nor proved a truncation of a
      // pending durable mark. Treat it as local-terminal input: synthesise a
      // started local turn ahead of any unstarted turn so chronological order
      // matches transcript order at emit time. This is SAFE regardless of
      // session type — it never steals a pending durable mark (the mark stays
      // unstarted, to be bound by its real user line). Restoring the original
      // pre-PR behavior here (no session-type gate) is what keeps codex's
      // requirement: a genuine local turn on a normal managed writable terminal
      // still emits and is not silently dropped. The mark-stealing bug lived in
      // the fingerprint-MISMATCH bind above, now gated on the truncation proof.
      const localTurn: BridgePendingTurn = {
        turnId: `local-${uuid}`,
        started: true,
        isLocal: true,
        precedingLarkTurnId: this.lastLarkTurnId,
        userUuid: uuid,
        assistantUuids: [],
        sourceJsonlPath,
        markTimeMs: eventTimeMs,
      };
      const insertAt = this.queue.findIndex(t => !t.started);
      if (insertAt === -1) this.queue.push(localTurn);
      else this.queue.splice(insertAt, 0, localTurn);
      this.collecting = localTurn;
      this.lastLocalTurnId = localTurn.turnId;
      this.onLocalTurnStarted?.(localTurn);
    } else {
      // A real Lark mark bound to its user event: it becomes the topic anchor
      // for any CronCreate task scheduled inside the turn and for fires whose
      // create/ack state is unavailable.
      this.lastLarkTurnId = this.collecting?.turnId;
      this.lastLocalTurnId = undefined;
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
     * receiver turn without an exact terminal or an explicit ambiguous outcome. */
    requireExplicitTerminalForDurable?: boolean;
    /** The CLI generation is ending (exit, kill, teardown): a duration marker
     *  still due will never be written, so a turn held for it is final now. */
    releaseHeldTerminals?: boolean;
    /** Release ONLY the turn with this identity; stop before any other head.
     *  Used by the no-idle watchdog, which has no idle guarantee and must not
     *  settle a type-ahead turn that merely follows the bound one (a global
     *  terminal-boundary drain would pop that follower even mid-tool). */
    onlyTurn?: { turnId: string; dispatchAttempt?: number };
    /** Adopt sessions keep their existing headless-continuation / folded-turn
     *  attribution. They never arm the open-turn watchdog, so an idle drain must
     *  not mint a Scenario 3 unobserved-recovery anchor that would re-attach what
     *  is deliberately a suppressed `local-headless-*` continuation. */
    adoptMode?: boolean;
  } = {}): BridgePendingTurn[] {
    const out: BridgePendingTurn[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.started) break;
      // Identity gate: a bounded caller (the no-idle watchdog) may release its
      // own turn only, never a follower that became the head.
      if (opts.onlyTurn
        && (head.turnId !== opts.onlyTurn.turnId
          || head.dispatchAttempt !== opts.onlyTurn.dispatchAttempt)) break;
      if (opts.explicitTerminalOnly && !head.terminalObserved) break;
      if (opts.requireExplicitTerminalForDurable
        && head.dispatchAttempt !== undefined
        && !head.terminalObserved
        && !(opts.releaseHeldTerminals && head.terminalOutcome?.status === 'ambiguous')) break;
      // Neither the per-read drain nor the idle edge may settle a turn on a
      // block-level stop_reason when its duration marker is due: the reader can
      // stop between two records of one message (the idle edge, too, can beat
      // the transcript flush). The rest of the turn would then arrive with
      // nothing collecting, be synthesised as a local turn, and a stream that
      // died there would fail that local turn instead of this one — answer
      // text gone, failure unreported.
      if (!opts.releaseHeldTerminals
        && this.isAwaitingDurationMarker(head)
        // A journal-restored turn's writer generation has ended: its marker is
        // never coming, so an idle/terminal boundary releases it (a per-read
        // drain still waits). It is settled without learning the wait-expired
        // verdict, which belongs to a live CLI only.
        && !(opts.terminalBoundary && (head.restoredFromJournal || head.carriedAcrossGeneration))) break;
      if (!opts.terminalBoundary && !head.terminalObserved && head.assistantUuids.length === 0) break;
      // Finding 8: a Scenario 3 re-attached turn can emit interim narration and
      // then start a tool call. Do not pop it mid-tool on a subsequent screen
      // idle while strong in-flight proof remains (bounded by CLI_QUEUE_HOLD_MAX_MS).
      if (this.reattachedFromUnobserved.has(head)
        && !head.terminalObserved
        && !opts.releaseHeldTerminals) {
        const live = this.liveStates.get(head);
        const withinCap = live?.reattachedAtMs === undefined
          || (Date.now() - live.reattachedAtMs) < CLI_QUEUE_HOLD_MAX_MS;
        if (withinCap && live
          && (live.pendingToolUseIds.size > 0 || live.apiRequestInFlight || live.awaitingPostToolAssistant)) {
          break;
        }
      }
      this.queue.shift();
      if (this.collecting === head) this.collecting = null;
      out.push(head);
      for (const absorbed of head.absorbedTurns ?? []) {
        const idx = this.queue.indexOf(absorbed);
        if (idx < 0) continue;
        this.queue.splice(idx, 1);
        if (this.collecting === absorbed) this.collecting = null;
        absorbed.terminalObserved = head.terminalObserved;
        if (absorbed.absorbedReplySent) {
          // Already answered while the host ran: whatever the host meets
          // afterwards (an API error, a usage limit) is the host's, not this
          // turn's, so it settles as completed.
          absorbed.terminalOutcome ??= { status: 'completed' };
          out.push(absorbed);
          continue;
        }
        if (head.terminalOutcome && absorbed.terminalOutcome === undefined) {
          absorbed.terminalOutcome = head.terminalOutcome;
          if (head.terminalErrorDetail) absorbed.terminalErrorDetail = head.terminalErrorDetail;
          if (head.terminalProviderLastSuccessAtMs !== undefined) {
            absorbed.terminalProviderLastSuccessAtMs = head.terminalProviderLastSuccessAtMs;
          }
        }
        if (head.rateLimited) absorbed.rateLimited = true;
        out.push(absorbed);
      }
      // Scenario 3 anchor: remember a live non-local turn popped without an
      // explicit transcript terminal (and with no later started turn behind it)
      // so late assistant records proving the same conversation-tree lineage
      // re-attach rather than becoming a suppressed `local-headless-*` turn.
      if (!head.isLocal
        && head.dispatchAttempt === undefined
        && !head.terminalObserved
        && !head.rateLimited
        && !head.restoredFromJournal
        && !head.carriedAcrossGeneration
        && !this.reattachedFromUnobserved.has(head)
        && !opts.releaseHeldTerminals
        && !opts.adoptMode
        && this.queue.every(t => !t.started)) {
        const live = this.liveStates.get(head);
        this.recentUnobservedTurn = {
          turnId: head.turnId,
          dispatchAttempt: head.dispatchAttempt,
          linkRefMode: head.linkRefMode,
          markTimeMs: head.markTimeMs,
          sourceJsonlPath: head.sourceJsonlPath,
          startUuid: live?.startUuid,
          chainUuids: new Set(live?.chainUuids ?? []),
          progressChainUuids: new Set(live?.progressChainUuids ?? []),
          sawParentUuid: live?.sawParentUuid ?? false,
          pendingToolUseIds: new Set(live?.pendingToolUseIds ?? []),
          apiRequestInFlight: live?.apiRequestInFlight ?? false,
          awaitingPostToolAssistant: live?.awaitingPostToolAssistant ?? false,
          hadTrailingVisibleText: live?.hasTrailingVisibleText ?? false,
          closedAtMs: Date.now(),
        };
      } else {
        this.recentUnobservedTurn = null;
      }
    }
    return out;
  }

  /** A journal write failed before offer. Restore these exact drained objects;
   * already submitted siblings stay with their output owner. */
  restoreDrained(turns: readonly BridgePendingTurn[]): void {
    const existing = new Set(this.queue.map(turn => `${turn.turnId}:${turn.dispatchAttempt ?? ''}`));
    const restored = turns.filter(turn => !existing.has(`${turn.turnId}:${turn.dispatchAttempt ?? ''}`));
    if (restored.length === 0) return;
    this.queue.unshift(...restored);
    this.recentUnobservedTurn = null;
    if (!this.collecting) {
      for (let i = restored.length - 1; i >= 0; i--) {
        const candidate = restored[i]!;
        if (candidate.started
          && !candidate.absorbedIntoTurnId
          && !candidate.closedByDurationMarker
          && !candidate.rateLimited
          && (!candidate.terminalObserved || candidate.awaitingDurationMarker)) {
          this.collecting = candidate;
          break;
        }
      }
    }
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
