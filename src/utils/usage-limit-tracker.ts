import {
  detectCliUsageLimit,
  detectScreenUsageLimit,
  usageLimitStateKey,
  type CliUsageLimitState,
} from './cli-usage-limit.js';

/**
 * Per-turn usage-limit state machine. Owns the turn counter, the
 * "did this turn hit a limit" flag, the stale-banner suppression,
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
   * A turn reached its terminal.
   *
   * `outcome` distinguishes a real model answer from a failure/ambiguous
   * terminal, and ONLY 'answered' changes any state:
   *
   *  - 'answered' drops the structured-limit re-emit latch (preserving the
   *    existing self-heal: in an adopted session the user can recover from a
   *    structured rate limit in their own terminal without triggering
   *    beginTurn(), and without this the latch would re-pin the card /
   *    Dashboard after the daemon already cleared it) and arms the stale-banner
   *    suppression.
   *  - 'failed' is a NO-OP. A rate/usage refusal IS a failed terminal, so it is
   *    evidence FOR a limit, never against one — it must neither arm the
   *    suppression nor drop the latch. Dropping the latch on a failed terminal
   *    would silence a real 429 whose screen-scan verdict is suppressed because
   *    the structured signal is the authority (codex).
   */
  noteTurnCompleted(outcome?: 'answered' | 'failed'): void;
}

/**
 * Clock-free identity of a limit banner: what the SCREEN TEXT says, with no
 * resolved timestamp in it. usageLimitStateKey embeds retryAtMs, which
 * detectCliUsageLimit resolves against the current day — so one unchanged
 * banner produces a different key before and after midnight. Any "is this the
 * same banner I saw earlier?" comparison must therefore use this instead.
 */
function bannerTextIdentity(state: CliUsageLimitState): string {
  return `${state.kind}:${state.retryLabel}`;
}

/** Whether a bridge turn's terminal is positive evidence the CLI produced an
 *  answer (as opposed to a failure/ambiguous terminal). Keyed on
 *  `terminalStatus` and NOT on `structuredFallbackKind`: the latter decides
 *  WHICH fallback text to display and returns 'final' for a failed terminal
 *  whenever the failed fallback is gated away — including the codex
 *  rate-limit short-circuit (rateLimitHandled), i.e. precisely the limit case
 *  that must never be read as success. `undefined` means the drainer recorded
 *  no failure, which is the ordinary completed shape. */
export function bridgeTurnOutcome(
  turn: { terminalStatus?: 'failed' | 'ambiguous' | 'completed' },
): 'answered' | 'failed' {
  return turn.terminalStatus === undefined || turn.terminalStatus === 'completed'
    ? 'answered'
    : 'failed';
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
  /**
   * usageLimitStateKey of a retry-READY limit banner already on screen when this
   * turn opened — a previous episode whose reset time has demonstrably passed,
   * so it is definitionally leftover text. Unchanged from before; the
   * answered-turn rule below is what was added.
   */
  let staleBannerKey: string | undefined;
  /**
   * Clock-free identity (bannerTextIdentity) of ANY limit banner already on
   * screen when this turn opened, retry-ready or not. Consulted only once
   * turnProducedAnswer is true — see that flag for why an answer is the
   * discriminator, and why a key/text comparison alone could not be.
   *
   * Deliberately NOT usageLimitStateKey: that embeds retryAtMs, which
   * detectCliUsageLimit resolves against "today", so one unchanged banner
   * yields a different key after midnight and the suppression would silently
   * lapse — re-pinning the card at 00:01 with no new input at all.
   */
  let preExistingBannerKey: string | undefined;
  /**
   * This turn produced a harvested answer (noteTurnCompleted).
   *
   * This is the discriminator for the reported bug: a session that had hit its
   * limit stayed pinned at 「限额已达」 for every later turn, even after the CLI
   * answered normally. Codex prints its limit banner ONCE and leaves it in the
   * viewport indefinitely (verified on live panes: never a second occurrence,
   * even 20k scrollback lines back), so on each new turn the screen scan
   * re-detected that same leftover text and re-pinned the card — and because
   * clearUsageLimitState() also resets rateLimitNotifiedKey, re-sent the @owner
   * "turn paused" ping each time.
   *
   * An answer is POSITIVE evidence: a turn that is actually limit-blocked never
   * yields a harvested final_output. So "the CLI answered this turn" + "this
   * banner was already on screen when the turn opened" is sufficient to call the
   * text leftover, whatever its clock says. Without an answer we never suppress,
   * so a genuine re-refusal still reports — which matters because two weaker
   * discriminators do NOT work here:
   *
   *  - Comparing the banner text/key alone cannot separate "leftover banner"
   *    from "identical text from a fresh refusal".
   *  - Requiring a NEW structured record does not work for `usage`: across all
   *    1925 local rollouts, the 8 carrying a `usage_limit_exceeded`
   *    task_complete each carry exactly ONE, including sessions that went on to
   *    run 7 more turns / 12 more user messages afterwards. Unlike the 429 path
   *    (one appended record per refusal), a usage refusal is recorded once.
   *
   * Consequence, deliberately: CLIs that never reach noteTurnCompleted (gemini
   * is not in STRUCTURED_BRIDGE_ALWAYS_CLI_IDS) keep the previous behavior
   * exactly. Those are the CLIs with no authoritative limit signal at all, where
   * suppressing a repeated banner would risk hiding a real block.
   */
  let turnProducedAnswer = false;
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
    // Open a new turn; remember any limit banner still on screen so classify()
    // doesn't re-flag that leftover text as a fresh limit this turn.
    beginTurn(snapshot: string): number {
      turnSeq++;
      detectedTurn = undefined;
      activeStructured = undefined;
      const current = detectCliUsageLimit(snapshot, undefined, { suppressRateKind: opts.isRateKindSuppressed() });
      preExistingBannerKey = current.limited ? bannerTextIdentity(current) : undefined;
      staleBannerKey = current.limited && current.retryReady
        ? usageLimitStateKey(current)
        : undefined;
      turnProducedAnswer = false;
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
      // (a) master's rule: a banner already on screen whose reset time has
      //     already passed is definitionally leftover.
      // (b) the new rule: a banner that was ALREADY on screen when this turn
      //     opened, on a turn where the CLI has since produced a real answer.
      //     The answer is positive proof the limit is not blocking, so the
      //     text is leftover no matter what its clock says. Without an
      //     answer we never suppress — a genuine re-refusal still reports.
      if (key === staleBannerKey
        || (turnProducedAnswer && bannerTextIdentity(detected) === preExistingBannerKey)) {
        return { status };
      }

      staleBannerKey = undefined;
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
    // stale-banner suppression, and hold the state for re-emission until
    // the turn ends. The actual emit is done by the caller.
    noteStructuredLimit(state: CliUsageLimitState): void {
      staleBannerKey = undefined;
      // An authoritative limit arriving AFTER this turn produced an answer
      // (steered / multi-answer turns can interleave) supersedes that answer as
      // evidence: the CLI is blocked NOW. Re-arm both suppressions off, or the
      // answered-turn rule would keep swallowing the banner the structured
      // signal is telling us to show.
      preExistingBannerKey = undefined;
      turnProducedAnswer = false;
      detectedTurn = turnSeq;
      activeStructured = { seq: turnSeq, state };
    },
    // A turn reached its terminal. Only 'answered' is evidence the CLI is not
    // limit-blocked, and only 'answered' touches state at all — see below.
    // detectedTurn is intentionally left as a historical fact (it self-clears
    // on the next beginTurn).
    noteTurnCompleted(outcome: 'answered' | 'failed' = 'answered'): void {
      // A failed/ambiguous terminal proves nothing about limits — a rate/usage
      // refusal IS a failed terminal — so it must change NOTHING: it neither
      // arms the stale-banner suppression nor drops the structured re-emit
      // latch. Dropping the latch here would be actively harmful on the path
      // this fix newly routes through: with a `botmux send` marker on the turn,
      // a structured 429 sets activeStructured, then the gate branch reaches
      // this call with outcome='failed'; clearing the latch would let the next
      // `working` frame trigger the daemon's self-heal, and because codex's
      // screen-scan `rate` verdict is suppressed (structured signal is the
      // authority) nothing would ever re-report it — a real 429 gone silent.
      if (outcome !== 'answered') return;
      // Only a real answer is evidence the CLI recovered, so only here do we
      // drop the latch — the daemon's final_output handler already cleared
      // ds.usageLimit for the same recovery, and a re-emit would re-pin the
      // card / Dashboard.
      activeStructured = undefined;
      // Positive evidence this turn is NOT limit-blocked: the CLI produced a
      // harvested answer. Any limit banner that was already on screen when
      // the turn opened is therefore leftover text from an earlier episode.
      turnProducedAnswer = true;
    },
  };
}
