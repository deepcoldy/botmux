/**
 * Ready-gate state machine — holds the FIRST prompt for Claude-family CLIs until
 * a SessionStart hook fires a "真就绪" (true-ready) signal.
 *
 * Why this exists: a custom launcher (e.g. `cjadk claude`) shows an interactive
 * model/session selector at startup whose cursor is `❯` (U+276F). That glyph
 * precisely matches the claude adapter's `readyPattern: /❯/`, and the selector
 * sits silent → the IdleDetector declares the CLI idle far too early → the worker
 * types the first prompt straight INTO the selector, which eats the text (and the
 * trailing Enter mis-selects a menu item). The selector clears before Claude's
 * real input box renders, so the message is silently lost.
 *
 * Claude Code's `SessionStart` hook fires within ~3ms of the real input box
 * rendering, and crucially does NOT fire while the launcher is still on its
 * selector — so it's an unambiguous "the CLI is genuinely ready" signal. This
 * gate suspends the first flush until that signal (or a fallback timeout) so the
 * selector can never eat the first message.
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
 * Claude-family spawn that re-runs the CLI binary with our `--settings`:
 *
 *   - `injectsReadyHook`        — the adapter injects the hook (claude / seed).
 *   - NOT `adoptMode`           — adopt panes are pre-existing, never spawned with
 *                                 our `--settings`, so they can't get the hook.
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
 * SessionStart hook is ALSO installed globally (~/.claude/settings.json — see
 * claude-code.ts hookInstall.sessionStartCommand), which aiden's Claude still
 * reads. So the real signal fires there too → we KEEP arming for that case
 * (no readyPattern fallback, which could misjudge).
 */
export function shouldArmReadyGate(state: {
  injectsReadyHook: boolean;
  adoptMode: boolean;
  willReattachPersistent: boolean;
}): boolean {
  return state.injectsReadyHook && !state.adoptMode && !state.willReattachPersistent;
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
