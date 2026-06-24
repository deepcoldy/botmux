/**
 * LivenessGate — debounce transient liveness-probe failures for /adopt backends.
 *
 * The adopt observers (TmuxPipeBackend, ZellijObserveBackend) poll the external
 * pane/CLI once per second to detect when the adopted target really exited. The
 * original logic tore the session down on the FIRST failed probe, so any
 * transient hiccup — a `tmux display-message` timeout, a busy zellij server, fd
 * pressure (EMFILE) when many workers are live — produced a spurious
 * "⏏ /adopt的 CLI 会话已断开" even though the CLI was still alive and still
 * receiving messages.
 *
 * This gate counts CONSECUTIVE failures and only reports the target as gone once
 * `threshold` failures pile up with no intervening success. Any single success
 * resets the counter, so steady-state liveness never trips it. Callers should
 * follow a tripped gate with one final authoritative re-probe (ideally with a
 * more lenient timeout) before actually tearing down — see the backends.
 */
export class LivenessGate {
  private failures = 0;

  constructor(private readonly threshold: number) {
    if (threshold < 1) throw new Error(`LivenessGate threshold must be >= 1, got ${threshold}`);
  }

  /**
   * Feed one probe verdict.
   * @returns true iff this verdict pushed the consecutive-failure count to the
   *          threshold — the caller should now confirm + tear down. A success
   *          resets the counter and always returns false.
   */
  record(alive: boolean): boolean {
    if (alive) {
      this.failures = 0;
      return false;
    }
    this.failures += 1;
    return this.failures >= this.threshold;
  }

  /** Consecutive failures observed so far (0 once a success resets it). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  reset(): void {
    this.failures = 0;
  }
}

/** Default consecutive-failure budget before an adopt backend declares its
 *  target gone. 3 one-second probes (~3s of sustained failure) plus a final
 *  lenient confirm — enough to ride out command timeouts / server hiccups while
 *  still detecting a genuine exit promptly. */
export const ADOPT_LIVENESS_MAX_FAILURES = 3;
