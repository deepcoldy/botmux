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
 *   - Non-adopt + isLocal: suppress. A local-typing turn means the
 *     attribution queue saw a user event whose content didn't match any
 *     pending Lark fingerprint. In a worker-spawned CLI that's a Web
 *     terminal hand-typed input — the user is already looking at it, no
 *     reason to push it back to the Lark thread.
 *   - Non-adopt + send observed in window: suppress. The window is
 *     [turn.markTimeMs, nextBoundaryMs). Legacy markers only carry time,
 *     so any marker in the window still suppresses. Newer markers carry the
 *     normalized length of the explicit `botmux send` body. When the
 *     transcript final is available, only emit fallback if that final is
 *     materially longer than any single explicit send in the same window.
 *     This lets short progress updates surface a later substantive final
 *     answer, while same-size rewrites and short acknowledgements stay
 *     suppressed. Boundary handling intentionally also considers
 *     queue items that haven't reached "ready" yet (passed in via
 *     nextBoundaryMs) — without that, a model that's still mid-tool-use
 *     for turn N+1 could leak a send credit into turn N's window.
 */
import { normaliseForFingerprint } from './bridge-turn-queue.js';

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

const BRIDGE_SENTINEL_TOKENS: readonly string[] = [
  BRIDGE_NOTHING_TO_SEND_SENTINEL,
  BRIDGE_NO_REPLY_SENTINEL_LEGACY,
];

export function isBridgeNothingToSendFinal(finalText: string | undefined): boolean {
  if (finalText === undefined) return false;
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
  return stripTrailingBridgeSentinelLine(finalText).trim().length === 0
    && hasTrailingBridgeSentinelLine(finalText);
}

/** True when the LAST non-empty line of `finalText` is exactly a sentinel token
 *  (current or legacy). Used to tell "model deliberately terminated with the
 *  sentinel" apart from a normal answer that merely mentions the token inline
 *  or has prose after it. */
function hasTrailingBridgeSentinelLine(finalText: string): boolean {
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
 *  ADOPT: return the text VERBATIM. The adopted CLI is botmux-unaware, transcript
 *  drain is its only channel to Lark, and it may legitimately output the literal
 *  sentinel string as content. shouldSuppressBridgeEmit(adoptMode) already
 *  refuses to interpret the sentinel; stripping here would break that contract
 *  (a real answer ending in the token would be truncated, and a verbatim token
 *  reply would be dropped by the caller's empty-guard). Callers must gate their
 *  own "skip if empty after post" check on !adoptMode to match.
 *
 *  Shared by emitReadyTurns and emitReadyCodexTurns so the per-mode rule lives in
 *  one place and is unit-tested directly. codex-app does not use adopt and drives
 *  its own strip on the deliverable content path. */
export function bridgePostText(finalText: string, adoptMode: boolean): string {
  return adoptMode ? finalText : stripTrailingBridgeSentinelLine(finalText);
}

export interface BridgeSendMarker {
  sentAtMs: number;
  messageId?: string;
  contentLength?: number;
  /** Bounded, whitespace-compacted copy for dashboard session previews.
   *  The fallback gate still uses contentLength only. */
  previewText?: string;
}

export interface BridgeGateInput {
  /** When the user message was queued — defines the lower bound of the
   *  send window. Undefined for legacy turns; the gate degrades to
   *  "never suppress" in that case. */
  markTimeMs: number | undefined;
  /** Whether the queue synthesised this turn from a local-terminal event
   *  (no fingerprint match for a Lark message). */
  isLocal: boolean | undefined;
  /** Transcript final text for this turn, when available. Lets structured
   *  send markers distinguish final-answer sends from earlier progress sends. */
  finalText?: string;
  /** Explicit transcript terminal semantics. Undefined preserves the
   * historical "assistant_final means completed" behavior. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
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
  const normalized = normaliseForFingerprint(content);
  if (!normalized) return undefined;
  return {
    // Length stays fingerprint-normalized: the fallback gate compares it against
    // normalise(finalText).length, so it must not count preview-only newlines.
    contentLength: normalized.length,
    // Preview keeps newlines — derive it from the raw body, NOT `normalized`.
    previewText: buildBridgeSendPreviewText(content),
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

export function shouldSuppressBridgeEmit(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (isBridgeNothingToSendFinal(turn.finalText)) return true;
  if (turn.isLocal) return true;
  if (turn.markTimeMs === undefined) return false;
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  const markersInWindow = markers.filter(m => m.sentAtMs >= lower && m.sentAtMs < upper);
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
  if (turn.finalText !== undefined
      && hasTrailingBridgeSentinelLine(turn.finalText)
      && markersInWindow.length > 0) {
    return true;
  }
  // Compare the SENTINEL-STRIPPED final against send markers: a prose+sentinel
  // final is delivered as the stripped prose (callers strip before send), so the
  // length used for the material-longer check must match what actually posts —
  // otherwise the trailing sentinel line inflates the final past a same-content
  // `botmux send` and defeats dedup.
  const gatedFinal = turn.finalText === undefined
    ? undefined
    : stripTrailingBridgeSentinelLine(turn.finalText);
  return markerSetCoversFinal(markersInWindow, gatedFinal);
}

/** Some structured CLIs can report a durable completed turn while their
 * terminal event carries no final text. If there was no explicit `botmux send`
 * in that turn window, silently completing leaves the Lark thread with no
 * visible outcome. Emit a diagnostic fallback only for that narrow case.
 *
 * Scope note (shared path): this gate feeds worker.ts:emitReadyCodexTurns,
 * which is shared by every structured-bridge CLI (Codex / Traex / Cursor / Pi /
 * Grok / Hermes / Mtr / Coco). In practice only two of them can produce an
 * empty-finalText `assistant_final` that reaches here:
 *   - Traex — `task_complete` with an empty `last_agent_message`
 *     (terminalStatus undefined → treated as completed below);
 *   - Grok  — `turn_completed` + stop_reason `end_turn` where the post-tool
 *     buffer is empty (terminalStatus 'completed').
 * The other six drainers drop empty text before enqueue (`if (!text) continue`),
 * so the fallback is unreachable for them.
 *
 * terminalStatus dependency: `undefined` is admitted as "completed" for
 * back-compat with legacy assistant_final events. This relies on Traex encoding
 * a cancel/abort as `turn_aborted` (terminalStatus 'ambiguous', excluded here)
 * rather than as an empty `task_complete`. If that fork contract ever changes,
 * a cancelled turn could surface a spurious "completed but empty" diagnostic.
 *
 * Marker caveat: `shouldSuppressBridgeEmit` only sees `botmux send` markers, and
 * detoured sends (`--top-level` / `--into` / `--override-chat`) intentionally
 * write no marker (cli.ts shouldRecordBridgeMarker). A turn whose only visible
 * reply went out via such a send therefore still trips this diagnostic; the
 * user-facing string (i18n `worker.empty_final_completed`) is worded to account
 * for that case rather than asserting no send happened. */
export function shouldEmitEmptyCompletedBridgeFallback(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return false;
  if (turn.terminalStatus !== undefined && turn.terminalStatus !== 'completed') return false;
  if ((turn.finalText ?? '').trim().length > 0) return false;
  return !shouldSuppressBridgeEmit(turn, nextBoundaryMs, markers, adoptMode);
}

/** 结构化失败回合补发可见错误；部分回答不能替代失败原因。 */
export function shouldEmitFailedBridgeFallback(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return false;
  if (turn.terminalStatus !== 'failed') return false;
  return !shouldSuppressBridgeEmit(turn, nextBoundaryMs, markers, adoptMode);
}
