import {
  detectCliUsageLimit,
  detectScreenUsageLimit,
  usageLimitStateKey,
  type CliUsageLimitState,
} from './cli-usage-limit.js';

/**
 * Per-turn usage-limit state machine. Owns the turn counter, the
 * "did this turn hit a limit" flag, the stale retry-ready banner suppression,
 * and the stickiness of authoritative STRUCTURED limits — so classify()'s
 * state writes are explicit method calls rather than hidden mutations of
 * module globals.
 *
 * Generic over the runtime status union so the worker can plug in its
 * RuntimeScreenStatus while tests drive it with plain strings.
 */
export interface UsageLimitTracker<S extends string = string> {
  currentTurn(): number;
  beginTurn(snapshot: string): number;
  classify(content: string, status: S): { status: S | 'limited'; usageLimit?: CliUsageLimitState };
  detectedThisTurn(seq: number): boolean;
  noteStructuredLimit(state: CliUsageLimitState): void;
  /**
   * A turn completed successfully (a harvested bridge final_output is being
   * emitted). Clears the structured-limit latch so a stale limit is not
   * re-emitted on the next classify(). Mirrors the daemon's final_output
   * self-heal (worker-pool clears ds.usageLimit on a real harvested answer):
   * in an adopted session the user can recover from a structured rate limit
   * in their own terminal without triggering beginTurn(), so without this the
   * latch would re-pin the card / Dashboard after the daemon already cleared.
   */
  noteTurnCompleted(): void;
}

export function createUsageLimitTracker<S extends string = string>(opts: {
  isRateKindSuppressed: () => boolean;
  /**
   * Whether the CLI is demonstrably producing output (PTY activity within the
   * caller's freshness window). The screen-scan active-work gate only
   * suppresses the verdict while this returns true: a `working` status alone
   * does not prove output is progressing (it is the default projection
   * whenever promptReady === false), so a non-structured CLI blocked at a
   * rate-limit error screen that never renders its ready prompt would
   * otherwise be suppressed forever. Omit to keep the conservative
   * suppress-on-working behavior (used by pure unit tests).
   */
  isOutputActive?: () => boolean;
}): UsageLimitTracker<S> {
  let turnSeq = 0;
  let detectedTurn: number | undefined;
  let suppressedRetryReadyKey: string | undefined;
  // A STRUCTURED limit (transcript error record, Claude/Codex) is authoritative
  // and one-shot at the source (UUID-deduped emit). Re-emit it on every
  // classify() until the turn ends: a genuinely blocked CLI keeps its
  // 「限额已达」 card even while the active-work gate suppresses the
  // (rate-suppressed) screen text — otherwise a working frame that races ahead
  // of prompt detection would let the daemon-side self-heal clear an
  // authoritative limit, and nothing would re-report it for the rest of the
  // blocked turn. Screen-scan detections stay one-shot: the daemon self-heal is
  // the correct remedy for THEIR false positives (idle-flicker mis-hits).
  let activeStructured: { seq: number; state: CliUsageLimitState } | undefined;

  return {
    currentTurn(): number {
      return turnSeq;
    },
    // Open a new turn; remember any stale retry-ready banner still on screen so
    // classify() doesn't re-flag it as a fresh limit this turn.
    beginTurn(snapshot: string): number {
      turnSeq++;
      detectedTurn = undefined;
      activeStructured = undefined;
      const current = detectCliUsageLimit(snapshot, undefined, { suppressRateKind: opts.isRateKindSuppressed() });
      suppressedRetryReadyKey = current.limited && current.retryReady
        ? usageLimitStateKey(current)
        : undefined;
      return turnSeq;
    },
    // Map a runtime status to a usage-limit-aware status, recording whether this
    // turn hit a limit (read back via detectedThisTurn).
    classify(
      content: string,
      status: S,
    ): { status: S | 'limited'; usageLimit?: CliUsageLimitState } {
      // Gate the screen-scan verdict on the runtime status: while the CLI is
      // actively working, limit-shaped text on screen is its own output (a
      // model answer / tool output quoting a business 429) or a transient retry
      // it is handling internally — never a live block, which would park the
      // CLI at an error/prompt screen (idle/stalled). Suppressing here is the
      // primary fix for the "CLI 还在跑却提示限额已达" false reports. The
      // isOutputActive hint refines the gate: `working` alone does not prove
      // output is progressing, so a parked error screen on a non-structured
      // CLI is still detected (see cli-usage-limit.detectScreenUsageLimit).
      const outputActive = opts.isOutputActive?.();
      const detected = detectScreenUsageLimit(content, status, undefined, {
        suppressRateKind: opts.isRateKindSuppressed(),
        ...(outputActive !== undefined ? { outputActive } : {}),
      });
      if (!detected.limited) {
        // Re-emit an authoritative structured limit recorded this turn so a
        // genuinely blocked CLI keeps its card (see activeStructured).
        if (activeStructured?.seq === turnSeq) {
          return { status: 'limited', usageLimit: activeStructured.state };
        }
        return { status };
      }

      const key = usageLimitStateKey(detected);
      if (detected.retryReady && key === suppressedRetryReadyKey) {
        return { status };
      }

      suppressedRetryReadyKey = undefined;
      detectedTurn = turnSeq;
      return { status: 'limited', usageLimit: detected };
    },
    detectedThisTurn(seq: number): boolean {
      return detectedTurn === seq;
    },
    // Record a limit that came from a STRUCTURED signal (transcript error
    // record) rather than screen text. Mirrors classify()'s state writes so
    // the tracker stays coherent: mark this turn as having hit a limit (read
    // by detectedThisTurn for the submit-confirmation recheck), clear any
    // stale retry-ready suppression, and hold the state for re-emission until
    // the turn ends. The actual emit is done by the caller.
    noteStructuredLimit(state: CliUsageLimitState): void {
      suppressedRetryReadyKey = undefined;
      detectedTurn = turnSeq;
      activeStructured = { seq: turnSeq, state };
    },
    // A successfully harvested turn (bridge final_output) is definitive
    // evidence the CLI recovered from any structured limit that parked it.
    // Drop the latch so the next classify() does not re-emit the stale limit
    // — the daemon's final_output handler already cleared ds.usageLimit for
    // the same recovery, and a re-emit would re-pin the card / Dashboard.
    // detectedTurn is intentionally left as a historical fact (it self-clears
    // on the next beginTurn).
    noteTurnCompleted(): void {
      activeStructured = undefined;
    },
  };
}
