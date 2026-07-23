/**
 * Ready-gate state machine — holds the FIRST prompt for Claude-family CLIs until
 * a SessionStart hook proves the outer startup selector has been passed.
 *
 * Why this exists: a custom launcher (e.g. `cjadk claude`) shows an interactive
 * model/session selector at startup whose cursor is `❯` (U+276F). That glyph
 * precisely matches the claude adapter's `readyPattern: /❯/`, and the selector
 * sits silent → the IdleDetector declares the CLI idle far too early → the worker
 * types the first prompt straight INTO the selector, which eats the text (and the
 * trailing Enter mis-selects a menu item). The selector clears before Claude's
 * real input box renders, so the message is silently lost.
 *
 * Claude Code's `SessionStart` hook crucially does NOT fire while the launcher
 * is still on its selector. Claude can run multiple matching hooks in parallel,
 * though, and renders the real prompt only after all finish. This gate therefore
 * establishes the anti-selector boundary; the worker separately waits for fresh
 * post-signal prompt evidence before it flushes Claude input.
 *
 * Lifecycle (recreated per CLI spawn in the worker):
 *   - `arm()`        — call at spawn when the adapter injects the SessionStart
 *                      hook and we're NOT in adopt mode. Left disarmed otherwise,
 *                      so every other CLI / adopt pane behaves exactly as before.
 *   - `shouldHold()` — true while armed and the signal hasn't arrived; the worker
 *                      checks this in markPromptReady() and flushPending() and
 *                      defers the first prompt while it holds.
 *   - `receive()`    — the hook fired, OR the fallback timeout elapsed. Opens the
 *                      gate permanently for this spawn. Returns true only on the
 *                      transition that actually releases held input, so the caller
 *                      knows whether a flush is warranted.
 *
 * Pure and self-contained (no timers, no IO) so the worker owns the fallback
 * timer and IPC wiring while the transition logic stays unit-testable.
 */
/**
 * Decide whether the worker should ARM the ready-gate for a given spawn. The
 * gate is only valid when a SessionStart hook will actually fire — i.e. a FRESH
 * ready-gated spawn whose hook/transport preflight succeeded:
 *
 *   - `injectsReadyHook`        — the adapter injects the hook (claude / seed).
 *   - `readySignalAvailable`    — the effective config contains the hook (or the
 *                                 CLI has a direct ready-command integration),
 *                                 and an isolated child has a usable callback
 *                                 route to the daemon.
 *   - NOT `adoptMode`           — adopt panes are pre-existing, never spawned with
 *                                 our ready integration, so they can't get a
 *                                 fresh SessionStart signal.
 *   - NOT `willReattachPersistent` — on daemon restart / worker recovery the
 *                                 worker re-attaches to an existing tmux/zellij/
 *                                 herdr session and does NOT re-run the CLI's
 *                                 bin/args, so NO new SessionStart hook fires. An
 *                                 already-idle Claude would otherwise have its
 *                                 first post-recovery message held until the
 *                                 fallback timeout — a user-visible regression.
 *
 * Any of the negatives → don't arm; the gate stays open and the spawn behaves
 * exactly as before (readyPattern + quiescence).
 *
 * NB: `wrapperCli=aiden x claude` strips our process-level `--settings`, but the
 * SessionStart hook is installed in the effective settings.json (see
 * claude-code.ts hookInstall.sessionStartCommand), which aiden's Claude still
 * reads. So the real signal fires there too → we KEEP arming for that case
 * (no readyPattern fallback, which could misjudge).
 */
export function shouldArmReadyGate(state: {
  injectsReadyHook: boolean;
  readySignalAvailable: boolean;
  adoptMode: boolean;
  willReattachPersistent: boolean;
}): boolean {
  return state.injectsReadyHook
    && state.readySignalAvailable
    && !state.adoptMode
    && !state.willReattachPersistent;
}

export class ReadyGate {
  private armed = false;
  private received = false;

  /** Arm the gate so it holds the first prompt until the ready signal. Idempotent. */
  arm(): void {
    this.armed = true;
  }

  /** True while the worker must hold pending input (armed and signal not yet seen). */
  shouldHold(): boolean {
    return this.armed && !this.received;
  }

  /**
   * Record the ready signal (real SessionStart hook) or the fallback timeout.
   * Returns `true` only on the first call that releases a holding gate (armed +
   * not previously received) — i.e. when the caller should now flush. Returns
   * `false` when the gate was never armed (nothing was held) or the signal was
   * already received (idempotent — late duplicate hook fires are no-ops).
   */
  receive(): boolean {
    if (this.received) return false;
    const wasHolding = this.armed;
    this.received = true;
    return wasHolding;
  }

  /** Whether the gate is currently armed (for diagnostics / tests). */
  get isArmed(): boolean {
    return this.armed;
  }

  /** Whether the ready signal (or fallback) has been recorded. */
  get isReceived(): boolean {
    return this.received;
  }
}
