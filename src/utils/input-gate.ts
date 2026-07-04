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
