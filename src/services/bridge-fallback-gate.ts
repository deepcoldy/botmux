/**
 * Decision logic for "should the worker suppress its transcript-driven
 * fallback emit for this Lark turn?"
 *
 * Pure function with no I/O — kept separate from worker.ts so the rules
 * (including the type-ahead window and the adopt-vs-non-adopt branching)
 * can be tested deterministically. The worker reads marker entries from
 * disk and threads them through here.
 *
 * Rules:
 *   - Non-adopt + sentinel terminator: the model ended its final with a
 *     standalone `BOTMUX_NOTHING_TO_SEND` (or the legacy `BOTMUX_NO_REPLY`)
 *     line. Sub-cases:
 *       · NOTHING remains after stripping the sentinel → genuine silence (#554):
 *         the model was triggered but deliberately produced no answer (ambient
 *         group chatter, or a message addressed to another bot). Suppress the
 *         whole turn. isBridgeNothingToSendFinal.
 *       · PROSE remains AND the model ALREADY sent ≥1 message in-window → the
 *         trailing prose is narration / thinking the model kept out of chat and
 *         then ended with the sentinel. SUPPRESS (do not re-post it as a new
 *         answer — the length heuristic would otherwise mistake longer narration
 *         for a substantive final). This is the "already sent, then narrated,
 *         ended with sentinel" leak the send-marker branch guards.
 *       · PROSE remains AND the model sent NOTHING in-window → the prose is a
 *         real answer produced but never sent (ghosting). Do NOT drop it: callers
 *         strip the sentinel line and forward the prose (empty marker set → not
 *         suppressed).
 *     A token that only appears inline (mid-sentence, or with prose after it) is
 *     a normal answer and is left untouched.
 *   - Adopt mode never suppresses: in /adopt the model in the adopted
 *     session is unaware of botmux, so transcript drain is the ONLY
 *     channel from model to Lark. There's no `botmux send` to compete
 *     with, hence no marker to gate on.
 *   - Non-adopt + isLocal: suppress unless zero-injection forwards local
 *     finals (`forwardLocalFinal`). A local-typing turn means the
 *     attribution queue saw a user event whose content didn't match any
 *     pending Lark fingerprint. In a worker-spawned CLI that's a Web
 *     terminal hand-typed input — the user is already looking at it, no
 *     reason to push it back to the Lark thread.
 *   - Non-adopt + attributable send/report observed: suppress. New markers use
 *     exact session + turn + dispatch-attempt identity (even when provider
 *     completion crosses a timestamp boundary). Legacy markers use the bounded
 *     [turn.markTimeMs, nextBoundaryMs) window. Newer markers also carry the
 *     normalized length of the explicit `botmux send` body. A marker tagged
 *     responseKind/replyCardResponseKind 'final' is an explicit final-answer
 *     delivery, so it suppresses the fallback UNCONDITIONALLY (regardless of
 *     length) under EVERY replyDelivery, including when the marker carries no
 *     body length at all (image-only / voice sends) — see the note on
 *     markerSetDuplicatesFinal. That comparison only ever runs for
 *     progress/kind-less sends. When the transcript final is available, only
 *     emit fallback if that final is materially longer than any single
 *     explicit send in the same window.
 *     This lets short progress updates surface a later substantive final
 *     answer, while same-size rewrites and short acknowledgements stay
 *     suppressed. Boundary handling intentionally also considers
 *     queue items that haven't reached "ready" yet (passed in via
 *     nextBoundaryMs) — without that, a model that's still mid-tool-use
 *     for turn N+1 could leak a send credit into turn N's window.
 */
import type { TurnTerminalCarrierKind } from '../core/types.js';
import { normaliseForFingerprint } from './bridge-turn-queue.js';
import { CODEX_RATE_LIMIT_ERROR_CODE } from './codex-transcript.js';
import type { TurnSendKind } from './turn-send-ledger.js';

const MATERIAL_FINAL_LENGTH_RATIO = 2;
const MATERIAL_FINAL_MIN_EXTRA_CHARS = 120;

export const BRIDGE_NOTHING_TO_SEND_SENTINEL = 'BOTMUX_NOTHING_TO_SEND';
/** Superseded token name. Instructions no longer teach it, but the matcher
 *  below still accepts it: during a rollout (and after a restart that restores
 *  sessions spawned before the rename) in-flight turns still carry the old
 *  token in their captured system prompt, and dropping recognition would leak
 *  that literal sentinel line into Lark. The reader stays liberal; only the
 *  instruction surface moved to the new name. */
export const BRIDGE_NO_REPLY_SENTINEL_LEGACY = 'BOTMUX_NO_REPLY';

const OAI_MEMORY_CITATION_OPEN = '<oai-mem-citation>';
const OAI_MEMORY_CITATION_SUFFIX = /^<oai-mem-citation>\s*<citation_entries>(?:(?!<\/citation_entries>)[\s\S])*?<\/citation_entries>\s*<rollout_ids>(?:(?!<\/rollout_ids>)[\s\S])*?<\/rollout_ids>\s*<\/oai-mem-citation>\s*$/;

/** Remove TraeX/Codex's internal memory-attribution envelope when it is a
 * complete suffix of an outbound answer. The rollout keeps the block in its
 * source transcript; only the copy headed to a user-facing surface is cleaned.
 *
 * Deliberately conservative:
 *   - the block must begin at a line boundary and be the final non-whitespace
 *     content;
 *   - both required child sections and every closing tag must be present;
 *   - inline/mid-body mentions, malformed blocks, and fenced examples (whose
 *     closing fence follows the XML) are preserved verbatim. */
export function stripTrailingOaiMemoryCitation(text: string): string {
  const start = text.lastIndexOf(OAI_MEMORY_CITATION_OPEN);
  if (start < 0) return text;
  if (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') return text;
  if (!OAI_MEMORY_CITATION_SUFFIX.test(text.slice(start))) return text;

  // Remove the blank-line separator that belonged to the metadata suffix, but
  // otherwise leave the visible answer byte-for-byte unchanged.
  return text.slice(0, start).replace(/[ \t]*(?:\r?\n[ \t]*)+$/, '');
}

const BRIDGE_SENTINEL_TOKENS: readonly string[] = [
  BRIDGE_NOTHING_TO_SEND_SENTINEL,
  BRIDGE_NO_REPLY_SENTINEL_LEGACY,
];

export function isBridgeNothingToSendFinal(finalText: string | undefined): boolean {
  if (finalText === undefined) return false;
  const visibleFinalText = stripTrailingOaiMemoryCitation(finalText);
  // "Genuine silence" signal: the final, after stripping a trailing sentinel
  // line, has NOTHING left. This is the #554 case the sentinel exists for — the
  // model was triggered (e.g. ambient group chatter, or a message addressed to
  // another bot) and deliberately produced no answer, terminating with only the
  // sentinel. Suppress the whole turn so no noise reaches Lark.
  //
  // NOTE (behavior change vs the old drop-whole-turn rule): a final that is
  // PROSE followed by a trailing sentinel line is NO LONGER treated as silence.
  // Earlier the whole turn was dropped, which ghosted users who did real work,
  // forgot to `botmux send`, and ended with the sentinel. Now the prose is the
  // real answer: stripTrailingBridgeSentinelLine removes the sentinel line and
  // callers forward the remainder through the normal send-marker gate (so a turn
  // that already `botmux send`-ed is still suppressed, but an un-sent answer is
  // delivered instead of lost). Only a final that is EMPTY once the sentinel is
  // stripped counts as silence here.
  return stripTrailingBridgeSentinelLine(visibleFinalText).trim().length === 0
    && hasTrailingBridgeSentinelLine(visibleFinalText);
}

/** True when the LAST non-empty line of `finalText` is exactly a sentinel token
 *  (current or legacy). Used to tell "model deliberately terminated with the
 *  sentinel" apart from a normal answer that merely mentions the token inline
 *  or has prose after it. */
export function hasTrailingBridgeSentinelLine(finalText: string): boolean {
  const lines = finalText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    return BRIDGE_SENTINEL_TOKENS.includes(line);
  }
  return false;
}

/** Remove the trailing RUN of standalone sentinel lines (current or legacy
 *  token, mixable) plus interleaved blank lines from `finalText`, returning the
 *  text that should actually reach Lark.
 *
 *  Stripping the whole trailing run — not just one line — is required to keep the
 *  "literal token never reaches Lark" guarantee: a model can emit the sentinel
 *  more than once (`prose\nTOKEN\nTOKEN`, or a bare `TOKEN\nTOKEN`). A one-line
 *  strip would leave a surviving token to leak, and a bare multi-token final
 *  would be misjudged as "not silence" and post a literal token — a regression
 *  vs the old whole-turn suppression. We peel blank + sentinel lines off the end
 *  until the last remaining line is real prose (or nothing is left).
 *
 *    - `BOTMUX_NOTHING_TO_SEND`                 → "" (silence)
 *    - `TOKEN\nTOKEN` / `TOKEN\n\nTOKEN`        → "" (silence — all tokens peeled)
 *    - `<prose>\n\nBOTMUX_NOTHING_TO_SEND`      → `<prose>` (the real answer)
 *    - `<prose>\nTOKEN\nTOKEN`                  → `<prose>` (both tokens peeled)
 *    - `<prose ending mid-sentence …TOKEN>`     → unchanged (token inline)
 *    - `TOKEN\n\n<more prose>`                  → unchanged (token not trailing)
 *  When the last non-empty line is NOT a sentinel, the input is returned as-is;
 *  leading content is untouched. Mixed current/legacy tokens in the run all peel. */
export function stripTrailingBridgeSentinelLine(finalText: string): string {
  const lines = finalText.split('\n');
  // Walk back from the end, skipping blank lines and standalone sentinel lines.
  // Stop at the first line that is real prose (or run off the top).
  let end = lines.length - 1;
  let strippedASentinel = false;
  while (end >= 0) {
    const trimmed = lines[end].trim();
    if (trimmed.length === 0) { end--; continue; }          // blank — peel
    if (BRIDGE_SENTINEL_TOKENS.includes(trimmed)) {          // standalone token — peel
      strippedASentinel = true;
      end--;
      continue;
    }
    break;                                                   // real prose — stop
  }
  // If the tail had no standalone sentinel at all, return verbatim (don't trim
  // trailing blanks of an ordinary answer — matches prior behavior).
  if (!strippedASentinel) return finalText;
  // Drop any blank lines now orphaned before the first surviving prose line.
  while (end >= 0 && lines[end].trim().length === 0) end--;
  return lines.slice(0, end + 1).join('\n');
}

/** The text a transcript-drain emit path should actually post for `finalText`.
 *
 *  NON-ADOPT: strip a trailing sentinel line so the literal token never reaches
 *  Lark (prose+sentinel = the "did work, forgot to send" shape → post the prose).
 *
 *  ADOPT: preserve sentinel text verbatim. The adopted CLI is botmux-unaware,
 *  transcript drain is its only channel to Lark, and it may legitimately output
 *  that literal sentinel as content. Internal memory-citation metadata is still
 *  removed in both modes because it is never user-facing answer content.
 *
 *  Shared by emitReadyTurns and emitReadyCodexTurns so the per-mode rule lives in
 *  one place and is unit-tested directly. codex-app does not use adopt and drives
 *  its own strip on the deliverable content path. */
export function hasUserVisibleText(text: string): boolean {
  // String.trim() deliberately does not remove Unicode format controls. A
  // Remote Runner final containing only U+200B therefore used to produce a
  // footer-only Lark card. Ignore Unicode whitespace and Cf controls for the
  // visibility predicate, but preserve the original bytes whenever any real
  // text remains (for example an emoji ZWJ sequence still has visible bases).
  return String(text ?? '').replace(/[\p{White_Space}\p{Cf}]/gu, '').length > 0;
}

export function bridgePostText(finalText: string, adoptMode: boolean): string {
  const withoutMemoryCitation = stripTrailingOaiMemoryCitation(finalText);
  const postText = adoptMode
    ? withoutMemoryCitation
    : stripTrailingBridgeSentinelLine(withoutMemoryCitation);
  return hasUserVisibleText(postText) ? postText : '';
}

export interface BridgeSendMarker {
  sentAtMs: number;
  /** Owning worker session. Older markers omit this and remain window-gated. */
  sessionId?: string;
  messageId?: string;
  /** Non-Lark delivery receipt, for example a dispatch relay trigger id. */
  deliveryId?: string;
  /** Where the successful user-visible action went. */
  deliveryKind?: 'current_session_send' | 'detoured_send' | 'dispatch_report';
  targetChatId?: string;
  targetRootMessageId?: string;
  targetSessionId?: string;
  dispatchRootId?: string;
  responseKind?: TurnSendKind;
  turnId?: string;
  dispatchAttempt?: number;
  /** The last user-visible carrier left by this send. The daemon uses this
   *  positive evidence at turn_terminal to PATCH a normal BotMux reply card
   *  in place, while files/voice/custom cards deliberately fall back to a
   *  separate compact terminal strip. Older markers omit the field and simply
   *  degrade to the live streaming-card terminal state. */
  terminalCarrier?: TurnTerminalCarrierKind;
  /** Present only for opted-in managed replies; legacy marker semantics stay intact. */
  replyCardResponseKind?: TurnSendKind;
  /** The send is explicitly an interim side effect and must never stand in for
   * the turn's eventual final/failure delivery. Remote Runner outbound_message
   * uses this while ordinary historical `botmux send` keeps its old heuristic. */
  terminalIndependent?: true;
  contentLength?: number;
  /** Bounded, whitespace-compacted copy for dashboard session previews.
   *  The fallback gate still uses contentLength only. */
  previewText?: string;
}

/** Only an explicit final response proves completion; progress, auxiliary,
 *  and legacy markers without responseKind must not retire a pending turn. */
export function isFinalBridgeSendMarker(marker: Pick<BridgeSendMarker, 'responseKind'>): boolean {
  return marker.responseKind === 'final';
}

export interface BridgeGateInput {
  /** Owning chat, when the caller knows it. A detour into another chat does
   *  not replace the non-empty answer this conversation is waiting for. */
  chatId?: string;
  /** Owning topic root. Same-chat delivery into another root is still a
   *  different conversation; same-chat top-level markers omit this field. */
  rootMessageId?: string;
  /** Owning BotMux session. The marker file is already per-session; retaining
   *  this field also fails closed if a misplaced new-schema marker is read. */
  sessionId?: string;
  /** Exact BotMux turn identity. Headless backends may not have a transcript
   * mark time, so a delivered final marker can still deduplicate by this
   * stronger correlation (including the durable dispatch attempt). */
  turnId?: string;
  dispatchAttempt?: number;
  /** When the user message was queued — defines the lower bound of the
   *  send window. Undefined for legacy turns; the gate degrades to
   *  "never suppress" in that case. */
  markTimeMs: number | undefined;
  /** Whether the queue synthesised this turn from a local-terminal event
   *  (no fingerprint match for a Lark message). */
  isLocal: boolean | undefined;
  /** Zero-injection sessions forward real terminal answers through the same
   * delivery channel. Keep local attribution for failure/empty-turn filtering. */
  forwardLocalFinal?: boolean;
  /** A Claude Code built-in scheduled turn (CronCreate fire). It is attributed
   *  as a local turn (no Lark fingerprint) but its final is auto-forwarded
   *  into the originating Lark thread, so it must bypass the ambient
   *  local-typing suppression — while the NOTHING_TO_SEND check above and the
   *  send-marker dedup below still apply exactly as for ordinary turns. */
  isScheduled?: boolean;
  /** Transcript final text for this turn, when available. Lets structured
   *  send markers distinguish final-answer sends from earlier progress sends. */
  finalText?: string;
  /** Explicit transcript terminal semantics. Undefined preserves the
   * historical "assistant_final means completed" behavior. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
}

/** Build one gate input from the worker's exact source-turn identity.
 *
 * Both transcript queues and managed Codex App finals already own this tuple;
 * centralising the projection keeps those production paths from accidentally
 * falling back to timestamp-only attribution when their marker carries a
 * turnId. Identity fields are applied last so caller payloads cannot override
 * the source turn. */
export function bridgeGateInputForTurn<
  T extends Omit<BridgeGateInput,
    'sessionId' | 'turnId' | 'dispatchAttempt' | 'chatId' | 'rootMessageId'>,
>(
  sessionId: string | undefined,
  turn: { turnId: string; dispatchAttempt?: number },
  input: T,
  chatId?: string,
  rootMessageId?: string,
): BridgeGateInput & T {
  return {
    ...input,
    ...(sessionId ? { sessionId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(rootMessageId ? { rootMessageId } : {}),
    turnId: turn.turnId,
    ...(turn.dispatchAttempt !== undefined
      ? { dispatchAttempt: turn.dispatchAttempt }
      : {}),
  };
}

const BRIDGE_SEND_PREVIEW_MAX_CHARS = 4_000;

/** Bounded, newline-preserving copy of a `botmux send` body for dashboard
 *  previews. Unlike the fingerprint normaliser (which collapses ALL whitespace
 *  incl. newlines into single spaces — right for dedup, wrong for display), this
 *  keeps line breaks so the dashboard can render the reply's Markdown structure
 *  (paragraphs / lists / code blocks). Horizontal runs of spaces/tabs within a
 *  line are collapsed and trailing spaces trimmed to keep the stored copy tidy;
 *  blank-line runs are capped at one to bound size without flattening structure. */
export function buildBridgeSendPreviewText(content: string): string | undefined {
  const tidy = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (!tidy) return undefined;
  return tidy.length > BRIDGE_SEND_PREVIEW_MAX_CHARS
    ? `${tidy.slice(0, BRIDGE_SEND_PREVIEW_MAX_CHARS - 1)}…`
    : tidy;
}

export function buildBridgeSendMarkerContent(
  content: string,
): Pick<BridgeSendMarker, 'contentLength' | 'previewText'> | undefined {
  const visibleContent = stripTrailingOaiMemoryCitation(content);
  const normalized = normaliseForFingerprint(visibleContent);
  if (!normalized) return undefined;
  return {
    // Length stays fingerprint-normalized: the fallback gate compares it against
    // normalise(finalText).length, so it must not count preview-only newlines.
    contentLength: normalized.length,
    // Preview keeps newlines — derive it from the raw body, NOT `normalized`.
    previewText: buildBridgeSendPreviewText(visibleContent),
  };
}

type StructuredBridgeSendMarker = BridgeSendMarker & {
  contentLength: number;
};

function hasStructuredContentMarker(marker: BridgeSendMarker): marker is StructuredBridgeSendMarker {
  return typeof marker.contentLength === 'number';
}

function finalIsMateriallyLongerThanSends(finalLength: number, markers: readonly StructuredBridgeSendMarker[]): boolean {
  const maxSentLength = markers.reduce((max, marker) => Math.max(max, marker.contentLength), 0);
  return finalLength >= maxSentLength * MATERIAL_FINAL_LENGTH_RATIO
    && finalLength - maxSentLength >= MATERIAL_FINAL_MIN_EXTRA_CHARS;
}

function markerSetCoversFinal(markers: readonly BridgeSendMarker[], finalText: string | undefined): boolean {
  if (markers.length === 0) return false;

  // Back-compat: old marker files only have sentAtMs/messageId. Keep the old
  // conservative behavior for those entries instead of risking duplicates.
  if (markers.some(m => !hasStructuredContentMarker(m))) return true;

  const finalNormalized = normaliseForFingerprint(finalText ?? '');
  if (!finalNormalized) return true;

  const structuredMarkers = markers.filter(hasStructuredContentMarker);
  return !finalIsMateriallyLongerThanSends(finalNormalized.length, structuredMarkers);
}

/** A bounded preview is a prefix of the send body, with a trailing「…」when it
 *  was cut. Compare it against the final on that basis. */
function previewMatchesFinal(previewText: string, finalNormalized: string): boolean {
  const body = previewText.endsWith('…') ? previewText.slice(0, -1) : previewText;
  const normalizedPreview = normaliseForFingerprint(body);
  if (!normalizedPreview) return true;
  return finalNormalized.startsWith(normalizedPreview);
}

/**
 * transcript-mode duplicate test — the counterpart of {@link markerSetCoversFinal}.
 *
 * Under `send` the final is a FALLBACK, so "the model already sent something
 * comparable" is reason enough to drop it. Under `transcript` the final IS the
 * delivery channel, so the same reasoning would silently eat the turn's real
 * answer whenever the model also pushed something mid-turn (an attachment note,
 * a progress line) — and mid-turn sends are explicitly legitimate there.
 *
 * So the bar is inverted: suppress ONLY when the final is the same content that
 * already went out. A marker stores the fingerprint-normalized LENGTH plus a
 * bounded preview, never the full body, so "same content" is judged by exact
 * length equality confirmed by the preview prefix. Anything of a different
 * length is delivered.
 *
 * Markers with no `contentLength` (`botmux send --images` with no body, and the
 * `--voice` path, whose marker is hand-assembled) cannot establish equality at
 * all, so they never suppress HERE — a duplicate message is a far cheaper
 * failure than a silently swallowed answer. This leniency applies only to
 * progress/kind-less markers: an explicit responseKind='final' marker, body or
 * no body, is already an unconditional return-true in shouldSuppressBridgeEmit
 * before this function is reached, under every replyDelivery (an image-only or
 * voice `--response-kind final` IS the declared final delivery; letting the
 * transcript final through would double-post).
 */
function markerSetDuplicatesFinal(markers: readonly BridgeSendMarker[], finalText: string | undefined): boolean {
  const finalNormalized = normaliseForFingerprint(finalText ?? '');
  // Empty final. This is NOT only "the model said nothing": emitReadyCodexTurns
  // re-runs this gate for SYNTHESISED failure cards / empty-turn diagnostics,
  // whose visible text lives in `content`, never in finalText. Suppressing them
  // unconditionally would swallow the failure reason on a turn where the model
  // sent nothing at all — and it would not even match `send`, which delivers on
  // "empty final + zero markers" (markerSetCoversFinal returns false there).
  // So mirror that: suppress only when something actually went out this turn.
  if (!finalNormalized) return markers.length > 0;
  return markers.some(marker => {
    if (marker.contentLength !== finalNormalized.length) return false;
    return marker.previewText === undefined
      || previewMatchesFinal(marker.previewText, finalNormalized);
  });
}

function markerMatchesSession(turn: BridgeGateInput, marker: BridgeSendMarker): boolean {
  return !turn.sessionId || !marker.sessionId || marker.sessionId === turn.sessionId;
}

function markerMatchesExactTurn(turn: BridgeGateInput, marker: BridgeSendMarker): boolean {
  return !!turn.turnId
    && marker.turnId === turn.turnId
    && marker.dispatchAttempt === turn.dispatchAttempt
    && markerMatchesSession(turn, marker);
}

/** Whether this delivery can replace the non-empty answer expected here.
 *
 * A cross-chat / cross-thread delivery still explains an EMPTY terminal, but
 * it must not consume this conversation's non-empty final or failure notice.
 * Legacy markers predate routing metadata and retain their historical credit. */
function markerCoversOwnThread(turn: BridgeGateInput, marker: BridgeSendMarker): boolean {
  if (marker.deliveryKind === undefined) return true;
  if (turn.chatId && marker.targetChatId && marker.targetChatId !== turn.chatId) {
    return false;
  }
  if (marker.deliveryKind !== 'current_session_send'
    && turn.rootMessageId && marker.targetRootMessageId
    && marker.targetRootMessageId !== turn.rootMessageId) {
    return false;
  }
  if (marker.deliveryKind === 'current_session_send') return true;
  // A relay into this exact source session is this conversation's answer even
  // when it has no independently-addressable Lark target.
  if (!marker.targetChatId && marker.targetSessionId
    && marker.targetSessionId === turn.sessionId) {
    return true;
  }
  // Detours/reports elsewhere need positive same-chat proof. A supplied root
  // was already checked above; an omitted root is the same chat's top level.
  if (turn.chatId) return marker.targetChatId === turn.chatId;
  return !marker.targetChatId
    && !!marker.targetSessionId
    && marker.targetSessionId === turn.sessionId;
}

/**
 * Successful reply markers attributable to one structured turn.
 *
 * New-schema markers with a turn id must match the exact turn/attempt and may
 * not borrow timestamp credit from a neighbouring turn. Exact identity is
 * stronger than clock ordering, which covers provider/relay completion after a
 * successor window opened. Legacy markers without a turn id retain the bounded
 * time-window fallback for rolling-upgrade compatibility.
 */
export function attributableBridgeReplyMarkers(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
): BridgeSendMarker[] {
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  return markers.filter(marker => {
    if (marker.terminalIndependent === true || !markerMatchesSession(turn, marker)) return false;
    // Use exact identity only when BOTH sides carry a turn. A rolling-upgrade
    // marker or an unmigrated caller keeps the bounded legacy time window.
    if (marker.turnId !== undefined && turn.turnId !== undefined) {
      return markerMatchesExactTurn(turn, marker);
    }
    return lower !== undefined && marker.sentAtMs >= lower && marker.sentAtMs < upper;
  });
}

export function shouldSuppressBridgeEmit(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
  /** How this session's final reply reaches Lark. Under 'transcript' the final
   *  is the delivery channel rather than a fallback, which inverts two of the
   *  rules below. Defaults to the historical 'send' semantics. */
  replyDelivery: 'send' | 'transcript' = 'send',
): boolean {
  if (adoptMode) return false;
  if (isBridgeNothingToSendFinal(turn.finalText)) return true;
  // Built-in scheduled turns are isLocal but user-scheduled: their final
  // belongs in the Lark thread. The marker rules below still dedup an explicit
  // `botmux send` and the NOTHING_TO_SEND check above already ran.
  if (turn.isLocal && !turn.forwardLocalFinal && !turn.isScheduled) return true;
  if (turn.isLocal && turn.forwardLocalFinal && turn.terminalStatus
    && turn.terminalStatus !== 'completed') return true;
  // Headless backends (notably Remote Runner) do not always own a transcript
  // mark window. An exact delivered final marker is stronger than timestamp
  // attribution and survives provider completion latency / host recovery.
  // Keep the dispatch attempt in the identity so a stale durable retry cannot
  // suppress a later attempt of the same logical turn.
  if (turn.turnId && markers.some(marker => markerMatchesExactTurn(turn, marker)
      && markerCoversOwnThread(turn, marker)
      && marker.terminalIndependent !== true
      && isFinalBridgeSendMarker(marker)
      && (marker.replyCardResponseKind === undefined
        || marker.replyCardResponseKind === 'final'))) {
    return true;
  }
  const attributable = attributableBridgeReplyMarkers(turn, nextBoundaryMs, markers);
  // A successful detour still explains an EMPTY terminal. Only non-empty
  // duplicate delivery is restricted to markers that reached this chat/root.
  const hasVisibleFinal = turn.finalText !== undefined
    && normaliseForFingerprint(turn.finalText).length > 0;
  const inWindow = hasVisibleFinal
    ? attributable.filter(marker => markerCoversOwnThread(turn, marker))
    : attributable;
  if (turn.markTimeMs === undefined) {
    if (inWindow.length === 0) return false;
    // Without a clock window, an exact unclassified/progress delivery proves
    // only that an EMPTY completion already produced visible output. It must
    // not swallow a later non-empty final. Explicit responseKind='final' was
    // handled above and remains the sole headless non-empty dedup proof.
    if (turn.finalText === undefined || normaliseForFingerprint(turn.finalText).length > 0) {
      return false;
    }
  }
  // An explicit `botmux send --response-kind final` already delivered this
  // turn's final answer to Lark. The unified-reply path also writes
  // replyCardResponseKind='final'; the plain (non-unified) path writes only
  // responseKind='final' (replyCardResponseKind is absent). Suppress the
  // terminal-transcription fallback in both cases, otherwise the same answer
  // is double-posted (e.g. Chinese answer sent, then an English summary).
  // Managed-card progress/auxiliary markers are not final deliveries.
  if (inWindow.some(m => isFinalBridgeSendMarker(m)
      && (m.replyCardResponseKind === undefined || m.replyCardResponseKind === 'final'))) {
    return true;
  }
  const markersInWindow = inWindow.filter(m => m.replyCardResponseKind === undefined
    || m.replyCardResponseKind === 'final');
  // A built-in scheduled turn whose final text hasn't been read yet must not be
  // declared "already delivered" on a progress/legacy marker alone: that marker
  // may be a short progress note followed by the real (materially longer)
  // final, and suppressing here would swallow it before the length comparison
  // can run. Defer — the caller re-evaluates WITH finalText. An explicit
  // responseKind:'final' marker above already returned true, so a declared
  // final send still dedups even pre-text.
  if (turn.isScheduled && turn.finalText === undefined) return false;
  // A trailing sentinel line is the model's explicit "I have nothing more to
  // send" signal. Split the two prose+sentinel cases by whether the model
  // ALREADY sent this turn:
  //   · sent ≥1 in-window + trailing sentinel → the trailing prose is narration
  //     / thinking the model deliberately kept out of chat (it explicitly ended
  //     with the sentinel after sending). SUPPRESS — do NOT let the length
  //     heuristic below mistake longer narration for a new substantive answer
  //     and re-post it. This is the "already sent, then narrated, ended with
  //     sentinel" leak.
  //   · zero sends in-window + trailing sentinel → the prose is a real answer
  //     the model produced but never sent (ghosting). Fall through: the
  //     stripped prose is forwarded by the length check below (markers empty →
  //     markerSetCoversFinal=false → not suppressed → caller posts it).
  // A final WITHOUT a trailing sentinel keeps the pure length-based behavior.
  const visibleFinalText = turn.finalText === undefined
    ? undefined
    : stripTrailingOaiMemoryCitation(turn.finalText);
  // transcript 例外：那里 prose 就是本轮答案，模型习惯性在末尾补 sentinel
  // （提示词仍教它）不该让整轮答案消失。剥掉 sentinel 后交给下面的重复判定。
  if (replyDelivery !== 'transcript'
      && visibleFinalText !== undefined
      && hasTrailingBridgeSentinelLine(visibleFinalText)
      && markersInWindow.length > 0) {
    return true;
  }
  // Compare the SENTINEL-STRIPPED final against send markers: a prose+sentinel
  // final is delivered as the stripped prose (callers strip before send), so the
  // length used for the material-longer check must match what actually posts —
  // otherwise the trailing sentinel line inflates the final past a same-content
  // `botmux send` and defeats dedup.
  const gatedFinal = visibleFinalText === undefined
    ? undefined
    : stripTrailingBridgeSentinelLine(visibleFinalText);
  return replyDelivery === 'transcript'
    ? markerSetDuplicatesFinal(markersInWindow, gatedFinal)
    : markerSetCoversFinal(markersInWindow, gatedFinal);
}

/** Some structured CLIs can report a durable completed turn while their
 * terminal event carries no final text. If there was no attributable successful
 * `botmux send` / `botmux report`, silently completing leaves the Lark thread with no
 * visible outcome. Emit a diagnostic fallback only for that narrow case.
 *
 * Scope note (shared path): this gate feeds worker.ts:emitReadyCodexTurns,
 * which is shared by every structured-bridge CLI (Codex / Traex / Cursor /
 * Antigravity / Pi / Grok / Hermes / Mtr / Coco). In practice these structured
 * producers can emit an empty-finalText `assistant_final` that reaches here:
 *   - Traex — `task_complete` with an empty `last_agent_message`
 *     (terminalStatus undefined → treated as completed below);
 *   - Pi — a completed stop/length terminal with empty text;
 *   - Grok  — `turn_completed` + stop_reason `end_turn` where the post-tool
 *     buffer is empty (terminalStatus 'completed').
 * The other drainers drop empty text before enqueue (`if (!text) continue`),
 * so the fallback is unreachable for them.
 *
 * terminalStatus dependency: `undefined` is admitted as "completed" for
 * back-compat with legacy assistant_final events. This relies on Traex encoding
 * a cancel/abort as `turn_aborted` (terminalStatus 'ambiguous', excluded here)
 * rather than as an empty `task_complete`. If that fork contract ever changes,
 * a cancelled turn could surface a spurious "completed but empty" diagnostic.
 *
 * Successful current-session sends, exact-turn detours, and dispatch reports
 * share the same marker journal. Unattributed manual detours intentionally do
 * not earn suppression credit; a real worker turn remains fail-open when no
 * exact identity or bounded legacy window proves the delivery. */
export function shouldEmitEmptyCompletedBridgeFallback(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
  replyDelivery: 'send' | 'transcript' = 'send',
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return false;
  if (turn.terminalStatus !== undefined && turn.terminalStatus !== 'completed') return false;
  if ((turn.finalText ?? '').trim().length > 0) return false;
  return !shouldSuppressBridgeEmit(turn, nextBoundaryMs, markers, adoptMode, replyDelivery);
}

/** 结构化失败回合补发可见错误；进度回复不能替代失败原因。 */
export function shouldEmitFailedBridgeFallback(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return false;
  if (turn.terminalStatus !== 'failed') return false;
  // A bare sentinel is an explicit request for silence, even when the provider
  // also reports a failed terminal. Never turn that internal token into visible
  // failure content.
  if (isBridgeNothingToSendFinal(turn.finalText)) return false;
  // Keep the structured failure as an execution fact. The opt-in delivery gate
  // below may suppress its notification after an exact explicit final, but
  // progress and legacy sends must never replace the terminal failure reason.
  return true;
}

/** Failure fallbacks are terminal diagnostics, not another model answer. Do not
 * apply the ordinary length/preview heuristic to them. By default only the
 * adopt / isLocal / bare-sentinel gates apply. The experimental opt-in
 * additionally treats an acknowledged, explicit final for this exact
 * turn/attempt as making the notice redundant; it trusts that final and does
 * not compare it with later transcript text.
 * Execution status and retry accounting remain independent of notification. */
export function shouldSuppressStructuredFallback(
  fallbackKind: StructuredFallbackKind,
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
  /** failed 走下面的 mode-agnostic 门禁，用不到它；non-failed 必须透传，
   *  否则 transcript 下的重复判定会退回 send 缺省的「明显更长才放行」。 */
  replyDelivery: 'send' | 'transcript' = 'send',
  /** 实验性、默认关闭（per-bot `suppressDeliveredFinalFailureNotice`）。只有显式
   *  true 才启用下面的「已送达 final」门禁；缺省与旧行为逐字一致。 */
  suppressDeliveredFinalFailureNotice = false,
): boolean {
  if (fallbackKind !== 'failed') {
    return shouldSuppressBridgeEmit(turn, nextBoundaryMs, markers, adoptMode, replyDelivery);
  }
  if (adoptMode || turn.isLocal || isBridgeNothingToSendFinal(turn.finalText)) return true;
  if (suppressDeliveredFinalFailureNotice !== true) return false;
  if (!turn.turnId || turn.markTimeMs === undefined) return false;
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  return markers.some(marker => isFinalBridgeSendMarker(marker)
    && markerMatchesExactTurn(turn, marker)
    && markerCoversOwnThread(turn, marker)
    && typeof marker.messageId === 'string' && marker.messageId.trim().length > 0
    && marker.sentAtMs >= lower && marker.sentAtMs < upper
    && marker.terminalIndependent !== true
    && (marker.replyCardResponseKind === undefined || marker.replyCardResponseKind === 'final'));
}

/** Compose a failed-turn diagnostic without replaying partial text that the
 * ordinary marker gate already classifies as delivered or deliberately kept
 * out of chat. Any retained partial text is sentinel-cleaned before the
 * diagnostic is appended, so the protocol token can never become body text. */
export function composeFailedBridgeFallbackContent(
  failureText: string,
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
  replyDelivery: 'send' | 'transcript' = 'send',
): string {
  if (shouldSuppressBridgeEmit(turn, nextBoundaryMs, markers, adoptMode, replyDelivery)) {
    return failureText;
  }
  const visiblePartialText = bridgePostText(turn.finalText ?? '', adoptMode).trim();
  return visiblePartialText ? `${visiblePartialText}\n\n${failureText}` : failureText;
}

/** Which fallback content the worker should post for a ready structured turn.
 *  Extracted from emitReadyCodexTurns so the rate-limit skip — which depends
 *  on whether the CLI owns a dedicated structured rate-limit notification
 *  chain (Codex only today) — is testable without a live worker.
 *
 *  Rate-limit contract: a `codex_rate_limited` terminal is handed to the
 *  CLI's dedicated chain when one exists, so the generic failed fallback is
 *  skipped to avoid double-posting. A CLI WITHOUT the chain (e.g. TRAE) must
 *  fall through to the generic failed fallback — otherwise a 429 turn posts
 *  nothing at all, regressing "misleading but visible" into "silent". */
export type StructuredFallbackKind = 'failed' | 'final' | 'empty_completed' | 'none';

export function structuredFallbackKind(
  turn: BridgeGateInput & { terminalErrorCode?: string },
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
  hasDedicatedRateLimitChain: boolean,
  replyDelivery: 'send' | 'transcript' = 'send',
): StructuredFallbackKind {
  const rateLimitHandled = hasDedicatedRateLimitChain
    && turn.terminalErrorCode === CODEX_RATE_LIMIT_ERROR_CODE;
  // Failure classification is mode-agnostic. Delivery suppression is a separate
  // decision below the caller's composition step; do not erase failure facts.
  if (!rateLimitHandled
    && shouldEmitFailedBridgeFallback(turn, nextBoundaryMs, markers, adoptMode)) {
    return 'failed';
  }
  if (turn.finalText && turn.finalText.trim()) return 'final';
  if (shouldEmitEmptyCompletedBridgeFallback(turn, nextBoundaryMs, markers, adoptMode, replyDelivery)) {
    return 'empty_completed';
  }
  return 'none';
}
