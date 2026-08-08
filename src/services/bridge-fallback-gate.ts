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
 *   - Non-adopt + nothing-to-send sentinel terminator: suppress the whole turn.
 *     Botmux-aware models use this explicit protocol when a turn has nothing
 *     left to send (already sent, or genuinely no reply needed). The signal is
 *     the LAST non-empty line of the final being exactly `BOTMUX_NOTHING_TO_SEND`
 *     (or the legacy `BOTMUX_NO_REPLY`) — models almost always explain the
 *     silence first and then append the token on its own line, so a full-string
 *     exact match leaked the literal token into Lark. A token that only appears
 *     inline (mid-sentence, or with prose after it) is still a normal answer and
 *     is NOT guessed away. See isBridgeNothingToSendFinal.
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
  // Suppress the whole turn when the model's final ENDS WITH a standalone
  // nothing-to-send sentinel line. We look at the LAST non-empty line only:
  //   - pure `BOTMUX_NOTHING_TO_SEND`                → suppress
  //   - `<prose>\n\nBOTMUX_NOTHING_TO_SEND`          → suppress the whole turn
  //   - a final whose last non-empty line is prose   → NOT a sentinel signal
  //     (the token inline in a sentence, or followed by more prose, still posts)
  // Full-string exact match was too brittle: botmux-aware models almost always
  // explain the silence first ("...no reply needed.") and then append the token
  // on its own line, which exact match let leak the literal token into Lark.
  // Trade-off (accepted): a genuine answer that happens to end with a bare
  // sentinel line is dropped WHOLE — the product wants a fully silent turn
  // over the safer strip-and-forward. The last-non-empty-line rule (not a
  // substring / endsWith test) keeps that risk to finals the model deliberately
  // terminated with the sentinel. Both the current and legacy tokens match.
  const lines = finalText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    return BRIDGE_SENTINEL_TOKENS.includes(line);
  }
  return false;
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
  return markerSetCoversFinal(markersInWindow, turn.finalText);
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
