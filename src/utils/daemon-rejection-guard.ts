/**
 * Keep the daemon alive when a fire-and-forget promise rejects.
 *
 * Node terminates the process on an unhandled rejection by default. In a worker
 * that is the right call — one worker owns one session, so exiting loses exactly
 * that session (see the handler at the bottom of worker.ts, which deliberately
 * calls process.exit(1) after tearing its sandbox down).
 *
 * The daemon is the opposite. It owns EVERY session, so the default turns one
 * missed `.catch` on one session's teardown into a total outage: every other
 * Lark session dies with it. That is not hypothetical — the repo already carries
 * a post-mortem of this exact shape in tmux-pipe-backend.ts, and the reason this
 * guard exists now is a corrupt containment store: a constructor threw above a
 * try block, the caller was a `void fn().then(...)` with no `.catch`, and the
 * rejection escaped to take the whole daemon with it.
 *
 * The failure mode this closes is structural, not local. Individual `.catch`
 * additions fix the holes we have already found; this makes the NEXT missed one
 * a logged incident on one session instead of an outage for all of them. Both
 * layers are wanted — this is the backstop, not a licence to drop `.catch`.
 *
 * Deliberately NOT swallowed silently. A rejection that reaches here is a real
 * bug: it is logged at error level with the stack, so pm2's error_file carries
 * an actionable signal rather than a mystery. Callers that legitimately expect a
 * rejection must still handle it themselves; nothing here makes a rejection
 * "fine", it only makes it survivable.
 *
 * Scope note, on purpose: this covers `unhandledRejection` only, NOT
 * `uncaughtException`. A rejected promise is usually a contained operation whose
 * caller forgot a `.catch`, so continuing is defensible. A synchronous throw
 * that unwound to the top can leave arbitrary state half-updated, and keeping a
 * process alive through that is a much stronger claim than this module is
 * entitled to make. Widening it needs its own analysis.
 */
import { isIgnorableStreamError } from './stdio-epipe-guard.js';

/** Minimal sink so tests can capture without touching the real logger. */
export interface RejectionLogSink {
  error(msg: string): void;
}

let installed = false;

/**
 * Render a rejection reason for the log.
 *
 * Prefers the stack: without it an `unhandledRejection` report is close to
 * useless, because the throw site is exactly what the caller failed to observe.
 * Non-Error reasons (a rejected string, a plain object) still have to produce
 * something readable, since `String({})` alone would log "[object Object]".
 */
export function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  if (reason !== null && typeof reason === 'object') {
    try {
      return `non-Error rejection: ${JSON.stringify(reason)}`;
    } catch {
      // Circular or otherwise unserialisable — still say something.
      return `non-Error rejection: ${Object.prototype.toString.call(reason)}`;
    }
  }
  return `non-Error rejection: ${String(reason)}`;
}

/**
 * The handler body, exported so a test can drive it directly instead of
 * emitting a real process-level event (which would leak across test files).
 *
 * Returns whether the rejection was logged; a broken-pipe-class reason is
 * dropped for the same reason stdio-epipe-guard drops it, and reporting that
 * would just add noise on every detached pm2 log stream.
 */
export function handleDaemonUnhandledRejection(
  reason: unknown,
  sink: RejectionLogSink,
): boolean {
  if (isIgnorableStreamError(reason as NodeJS.ErrnoException)) return false;
  sink.error(
    'Unhandled promise rejection in daemon — the daemon is STAYING UP so other '
    + `sessions keep running; this is a bug that needs a .catch: ${formatRejectionReason(reason)}`,
  );
  return true;
}

/**
 * Install the daemon-side guard. Idempotent, so multiple entry points may call
 * it. Returns true if it installed on this call.
 *
 * `target` is parameterized only so unit tests can inject a fake emitter rather
 * than registering a listener on the real process for the whole test run.
 */
export function installDaemonRejectionGuard(
  sink: RejectionLogSink,
  target: { on(event: 'unhandledRejection', cb: (reason: unknown) => void): unknown } = process,
): boolean {
  if (installed) return false;
  installed = true;
  target.on('unhandledRejection', (reason: unknown) => {
    // Never let the guard itself throw: an exception raised in here would
    // become an uncaughtException and kill the daemon in the very path that
    // exists to prevent that.
    try {
      handleDaemonUnhandledRejection(reason, sink);
    } catch { /* logging must never be fatal */ }
  });
  return true;
}

/** Test-only reset of the idempotency latch. */
export function resetDaemonRejectionGuardForTest(): void {
  installed = false;
}
