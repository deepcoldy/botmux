/**
 * Worker input-gate — decide whether an incoming Lark message is written to the
 * CLI's PTY now, or queued until the CLI is ready.
 *
 * `pendingMessages` always buffers the message; this only decides whether to
 * kick `flushPending()` immediately. Three "write now" cases:
 *
 *  - `isPromptReady`  — the CLI is idle and waiting for input.
 *  - `isFlushing`     — a drain loop is already running; let it pick this up.
 *  - type-ahead       — the adapter (Codex/CoCo/Claude) can accept input while
 *                       BUSY: the TUI parks it in its own queue / steers it into
 *                       the active turn.
 *
 * The catch the type-ahead case must respect: parking only works once the TUI
 * is actually up. During STARTUP (and tmux re-attach) the input box doesn't
 * exist yet, so a write is silently dropped — this is exactly how dispatch's
 * brief reached Codex ~6s before its first idle and never landed. `awaitingFirstPrompt`
 * is the worker's "hasn't reached ready even once" flag; while it's true we must
 * QUEUE even type-ahead messages and let `markPromptReady()`'s flush deliver them.
 */
export function shouldWriteNow(state: {
  /** CLI is idle, waiting for input. */
  isPromptReady: boolean;
  /** A flushPending() drain loop is already in progress. */
  isFlushing: boolean;
  /** Adapter accepts input while the CLI is mid-turn (type-ahead). */
  supportsTypeAhead: boolean;
  /** True until the CLI has reached its first ready state (boot / re-attach window). */
  awaitingFirstPrompt: boolean;
}): boolean {
  if (state.isPromptReady || state.isFlushing) return true;
  // Type-ahead is only safe after the TUI has booted at least once.
  return state.supportsTypeAhead && !state.awaitingFirstPrompt;
}

export function shouldReleaseFirstPromptTimeout(state: {
  /** Adapter wants the soft timeout to wait for a real readyPattern. */
  deferFirstPromptTimeoutUntilReady: boolean;
  /** There is a readyPattern that can eventually prove the input box exists. */
  hasReadyPattern: boolean;
  /** Milliseconds elapsed since this CLI spawn armed the first-prompt timer. */
  elapsedMs: number;
  /** Absolute hard cap for keeping the first prompt queued. */
  hardTimeoutMs: number;
}): boolean {
  if (!state.deferFirstPromptTimeoutUntilReady) return true;
  if (!state.hasReadyPattern) return true;
  return state.elapsedMs >= state.hardTimeoutMs;
}

/**
 * After the ready-gate releases (real SessionStart signal OR the timeout
 * fallback), the worker settles for PTY quiescence and then decides whether to
 * mark the prompt ready (which flushes for ALL adapters) vs. just calling
 * flushPending() (which only flushes for type-ahead adapters). Marking ready is
 * correct when ANY of these hold:
 *   - promptReadyAfterSettle         — the real SessionStart/BOTMUX_READY_COMMAND
 *                                      signal fired (authoritative: input box exists).
 *   - promptReadyDetectedDuringSettle — the idle detector fired during the
 *                                      settle (a readyPattern/idle proved readiness).
 *   - readyPatternSeenDuringHold      — a readyPattern fired WHILE the gate was
 *                                      holding (markPromptReady was blocked by
 *                                      readyGate.shouldHold()). The input box
 *                                      exists; the gate only deferred delivery.
 *
 * Pins the Hermes regression: a non-type-ahead adapter that renders its prompt
 * (❯) during the hold but never fires the SessionStart signal must be marked
 * ready at settle — otherwise settle calls flushPending(), which bails on
 * !isPromptReady && !typeAheadAllowed and leaves the first message queued until
 * the hard timeout (and, before the hard-timeout fix, forever).
 */
export function decideSettleMarkReady(state: {
  promptReadyAfterSettle: boolean;
  promptReadyDetectedDuringSettle: boolean;
  readyPatternSeenDuringHold: boolean;
}): boolean {
  return state.promptReadyAfterSettle || state.promptReadyDetectedDuringSettle || state.readyPatternSeenDuringHold;
}

/**
 * At the first-prompt hard timeout the worker has waited the full cap. For
 * type-ahead adapters flushPending() drains the queue even while !isPromptReady
 * (the TUI parks input in its own queue). For non-type-ahead adapters
 * flushPending() bails on !isPromptReady && !typeAheadAllowed, so the worker
 * must mark the prompt ready first (markPromptReady() then flushes).
 * Returns the action the worker must take:
 *   - 'flush'      — call flushPending() (type-ahead adapters).
 *   - 'mark-ready' — call markPromptReady() (non-type-ahead adapters).
 *
 * Pins the regression where non-type-ahead adapters only logged "forcing
 * queued message flush" at the hard timeout without actually delivering the
 * held first message.
 */
export function decideHardTimeoutAction(supportsTypeAhead: boolean): 'flush' | 'mark-ready' {
  return supportsTypeAhead ? 'flush' : 'mark-ready';
}
