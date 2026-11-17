/**
 * Explicit state for a prompt-ready edge that a busy signal withheld.
 *
 * `deferPromptReadyWhileBusy` can refuse prompt-ready for a whole session:
 * the authoritative viewport keeps matching the adapter's busy pattern (a
 * stale glyph left behind by an interrupted/tool-running turn), so every
 * quiescence edge is rejected and nothing records *why* readiness never
 * arrived. The probe loop is the only retry path; when an async settle aborts
 * (settle declined, or the screen revision moved during the settle) it returns
 * without re-arming, which permanently breaks that chain.
 *
 * This module keeps the deferral as data — reason, source, turn identity and
 * the instant the episode started — so the worker can (a) re-arm the probe
 * only for real deferrals, (b) re-drive it at `turn_terminal` until an actual
 * ready edge releases it, and
 * (c) emit one throttled WARN per reason+turn instead of a silent return or a
 * 3.5s log flood. It is clock-injectable and side-effect free, so the state
 * machine and the throttle are unit-testable without the worker harness.
 */

/** Why prompt-ready is currently withheld. */
export type BusyReadyDeferReason = 'busy-marker' | 'db-busy' | 'settle-aborted';

/** Reasons a prompt-ready publication attempt was skipped (observability). */
export type PromptReadySkipReason =
  | 'turn-authority-missing'
  | 'startup-pending'
  | 'native-session-fork-hold'
  | 'structured-turn-unfinished'
  | 'submit-verification-pending'
  | 'settle-aborted';

export interface BusyReadyDeferInput {
  reason: BusyReadyDeferReason;
  /** Caller label, e.g. `Pi first-prompt-timeout` or `Pi turn-terminal`. */
  source: string;
  turnId?: string;
  dispatchAttempt?: number;
}

export interface BusyReadyDeferState extends BusyReadyDeferInput {
  /** Epoch ms at which this continuous deferral episode started. */
  since: number;
}

export interface BusyReadyDeferClearance {
  state: BusyReadyDeferState;
  /** Free-form label for the release site (`turn-terminal`, `prompt-ready`, …). */
  clearedBy: string;
}

/**
 * Tracks at most one active deferral episode.
 *
 * A re-`defer()` during the same turn keeps the original `since` (so the
 * reported wait covers the whole blocked episode) while letting the reason
 * become more specific (`db-busy` → `busy-marker`). A different turn identity
 * starts a fresh episode: the previous turn's wait must not be attributed to
 * the new one.
 */
export class BusyReadyDeferralTracker {
  private state: BusyReadyDeferState | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  defer(input: BusyReadyDeferInput): Readonly<BusyReadyDeferState> {
    const current = this.state;
    if (current && current.turnId === input.turnId
      && current.dispatchAttempt === input.dispatchAttempt) {
      this.state = { ...current, reason: input.reason, source: input.source };
      return this.state;
    }
    this.state = { ...input, since: this.now() };
    return this.state;
  }

  /** Release the episode (if any) and hand back what was released. */
  clear(clearedBy: string): BusyReadyDeferClearance | null {
    const state = this.state;
    this.state = null;
    return state ? { state, clearedBy } : null;
  }

  get active(): boolean {
    return this.state !== null;
  }

  get current(): Readonly<BusyReadyDeferState> | null {
    return this.state;
  }

  /** Wall-clock the active episode has been withholding prompt-ready, in ms. */
  waitedMs(): number {
    return this.state ? Math.max(0, this.now() - this.state.since) : 0;
  }

  reset(): void {
    this.state = null;
  }
}

export interface BusyReadyLogThrottleOptions {
  /** Minimum spacing between two *different* reason keys. Default 30s. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * One WARN per reason+turn, plus a minimum spacing between distinct reasons.
 *
 * `seen` deliberately survives `clear()` of the deferral tracker: once a skip
 * reason has been reported for a turn, a later release-then-re-skip in the
 * same turn must stay quiet. `reset()` is for tests / a genuinely new worker
 * lifetime.
 */
export class BusyReadyLogThrottle {
  private readonly seen = new Set<string>();
  private lastLogAt = Number.NEGATIVE_INFINITY;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(opts: BusyReadyLogThrottleOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  shouldLog(reason: string, turnId: string | undefined): boolean {
    const key = `${reason}\u0000${turnId ?? '-'}`;
    if (this.seen.has(key)) return false;
    const now = this.now();
    if (now - this.lastLogAt < this.intervalMs) return false;
    this.seen.add(key);
    this.lastLogAt = now;
    return true;
  }

  reset(): void {
    this.seen.clear();
    this.lastLogAt = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Whether an aborted busy-probe settle must re-arm the probe loop.
 *
 * Only a real deferral is retried: adopt-idle and screen-idle probes also use
 * `probeBusyPatternIdle`, and they must not gain a polling loop. A pending
 * settle that proceeded and saw a stable revision publishes readiness itself,
 * so only a declined settle or a revision change needs another tick.
 */
export function shouldRearmBusyProbeAfterSettleAbort(input: {
  deferralActive: boolean;
  promptReady: boolean;
  settleProceeded: boolean;
  revisionChanged: boolean;
}): boolean {
  if (!input.deferralActive || input.promptReady) return false;
  return !input.settleProceeded || input.revisionChanged;
}
