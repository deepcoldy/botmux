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

export interface BridgeSendMarker {
  sentAtMs: number;
  messageId?: string;
  contentLength?: number;
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

export function buildBridgeSendMarkerContent(content: string): Pick<BridgeSendMarker, 'contentLength'> | undefined {
  const normalized = normaliseForFingerprint(content);
  if (!normalized) return undefined;
  return { contentLength: normalized.length };
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
