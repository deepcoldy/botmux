/**
 * Suppress EPIPE-class crashes on process.stdout / process.stderr.
 *
 * When botmux runs under pm2, the daemon's and each worker's stdout/stderr are
 * pipes to the pm2 God daemon (→ out_file / error_file). If the reader end
 * detaches — pm2 log streaming stops, the God daemon restarts, `botmux logs`
 * is piped to a command that exits early (e.g. `| head`), or the terminal
 * closes mid-stream — the next write fails with EPIPE. Because a piped
 * stdout/stderr is a Socket, the failed write surfaces as an 'error' event;
 * with no listener Node escalates it to an uncaughtException.
 *
 * That is fatal for botmux: the daemon registers no global uncaughtException
 * handler (so a broken pipe would kill the whole daemon), and the worker's
 * handler calls process.exit(1) on any uncaught error (so a broken pipe would
 * take down a live CLI session). The real logs are captured by pm2's out/err
 * files regardless, so the correct behavior is to drop the failed write
 * silently and keep running rather than crash.
 *
 * Attaching an 'error' listener that ignores the broken-pipe family achieves
 * exactly that. Genuinely unexpected stream errors are re-thrown so they still
 * surface (i.e. behavior for non-broken-pipe errors is unchanged).
 */

/**
 * Error codes that mean "the other end of stdout/stderr went away". These are
 * benign for a long-lived process whose real logs live in pm2's files.
 */
const IGNORED_STREAM_ERROR_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ECONNRESET',
  'EOF',
]);

let installed = false;

/** True if `err` is a broken-pipe-class stream error that is safe to swallow. */
export function isIgnorableStreamError(err: NodeJS.ErrnoException | null | undefined): boolean {
  return !!err && IGNORED_STREAM_ERROR_CODES.has(err.code ?? '');
}

/**
 * Attach a broken-pipe-tolerant 'error' listener to a single stream. Exported
 * for unit testing with an injected EventEmitter.
 */
export function attachStreamErrorGuard(stream: NodeJS.EventEmitter): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (isIgnorableStreamError(err)) return;
    // Not a broken pipe — re-throw so genuinely unexpected stream errors still
    // surface (same outcome as having no listener at all for these codes).
    throw err;
  });
}

/**
 * Install the guard on process.stdout/stderr. Idempotent — safe to call from
 * multiple entry points (daemon, worker). Returns true if it installed this
 * call, false if it was already installed.
 *
 * `streams` defaults to the real process streams; it is parameterized only so
 * unit tests can inject fakes without touching the test runner's own stdio.
 */
export function installStdioEpipeGuard(
  streams: NodeJS.EventEmitter[] = [process.stdout, process.stderr],
): boolean {
  if (installed) return false;
  installed = true;
  for (const stream of streams) attachStreamErrorGuard(stream);
  return true;
}
