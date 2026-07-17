/**
 * Worker inject-queue policy — pure decision functions for how the TUI
 * injection queue (`pendingInjections`) interacts with user-message flushing.
 *
 * `barrier=true` marks an injection that carries a cwd move (e.g. `/cd`):
 * the CLI process is still executing in its OLD working directory until that
 * line has actually been typed in and consumed, even though botmux's own
 * session record already reflects the NEW directory. Any user message
 * written before the barrier drains would land in the CLI while it's still
 * sitting in the old cwd — silently wrong, and easy to miss because nothing
 * throws.
 *
 * Two call sites need the exact same judgement:
 *  - `markPromptReady()` (idle path): once idle, should we drain
 *    `pendingInjections` before `pendingMessages`?
 *  - `flushPending()` (type-ahead path): type-ahead-capable adapters
 *    (Claude family) call `flushPending()` straight from `sendToPty()` even
 *    while the CLI is BUSY — that path bypasses `markPromptReady()` entirely,
 *    so it needs its own barrier check or a `/cd` queued while busy would be
 *    overtaken by the very next type-ahead user message.
 *
 * Extracted here (instead of inlined at both call sites in the very large
 * worker.ts) so the queueing policy has a unit-testable surface independent
 * of PTY/backend/session state.
 */
export interface PendingInjection {
  command: string;
  /** True when this injection carries a cwd move (e.g. `/cd`) and must drain before any user message. */
  barrier: boolean;
}

/**
 * True when a user-message flush (`flushPending()`) must be deferred because
 * a barrier injection is still queued. Applies to BOTH the idle flush path and
 * the type-ahead path — a barrier blocks user writes regardless of how the
 * flush was triggered.
 */
export function shouldDeferUserFlush(pending: readonly PendingInjection[]): boolean {
  return pending.some(i => i.barrier);
}

/**
 * True when, on reaching idle, the injection queue should be drained before
 * the user-message queue. A barrier anywhere in the queue means injections go
 * first; non-barrier injections alone don't need to preempt user messages.
 */
export function shouldFlushInjectionsFirst(pending: readonly PendingInjection[]): boolean {
  return pending.some(i => i.barrier);
}

/** Writer-state snapshot for deciding whether an injection flush may START.
 *  All fields are other writers that own (or may own) the PTY input line. */
export interface InjectionFlushGate {
  /** An injection flush is already draining (re-entrancy mutex). */
  injectionFlushing: boolean;
  /** A user-message flush holds its mutex. markPromptReady can fire while a
   *  flush is mid-write (spurious idle during startup-command quiescence or a
   *  slow submit-verify window) and would otherwise start typing an injection
   *  into a composer that already holds half a user message. flushPending
   *  checks `injectionFlushing` in the opposite direction — the exclusion must
   *  be symmetric or it isn't an exclusion. */
  userFlushing: boolean;
  /** Native /rename owns the TUI until its confirmation, beyond the raw write
   *  window itself. */
  sessionRenameInFlight: boolean;
  /** A literal command-line write (text → beat → Enter) is in flight. */
  commandLineWritesPending: number;
  /** Launch failed into a bare shell — never type commands into it. */
  bareShellLaunchBlocked: boolean;
}

/**
 * True when `flushPendingInjections()` may begin draining the queue. Deferred
 * injections are not lost: the queue persists and the next genuine
 * `markPromptReady()` re-kicks the drain once the competing writer is done.
 */
export function canStartInjectionFlush(gate: InjectionFlushGate): boolean {
  return !gate.injectionFlushing
    && !gate.userFlushing
    && !gate.sessionRenameInFlight
    && gate.commandLineWritesPending === 0
    && !gate.bareShellLaunchBlocked;
}
