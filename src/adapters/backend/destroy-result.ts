/**
 * How a worker must read a backend's destroySession() answer.
 *
 * Both decisions below used to be inline in worker.ts, where nothing could reach
 * them from a test: the malformed-result branch had no coverage at all, and the
 * rollback decision was a bare `if (!result.ok)`. They live here so the exact
 * production logic is executable in isolation.
 */
import type { SessionDestroyResult } from './types.js';

/**
 * Normalize a raw destroySession() return value.
 *
 * Local multiplexers legitimately return void: their destroy is a synchronous,
 * already-completed teardown, so "no result" really does mean success.
 *
 * Remote backends (mojo, riff) are the opposite. Their teardown is an
 * asynchronous cancellation reportable only through SessionDestroyResult, so a
 * missing or malformed result is an UNKNOWN outcome -- and treating unknown as
 * success is what lets the daemon publish a closed row while a credentialed
 * remote session (and its local child) keeps running.
 */
export function normalizeDestroyResult(
  raw: unknown,
  opts: { remote: boolean },
): SessionDestroyResult {
  // typeof, NOT `'ok' in raw`: a truthy non-boolean such as { ok: 'yes' }
  // satisfies the `in` test and then passes a plain `result.ok` check, so a
  // malformed payload was read as a successful teardown.
  const structured = !!raw
    && typeof raw === 'object'
    && typeof (raw as { ok?: unknown }).ok === 'boolean';
  if (structured) return raw as SessionDestroyResult;
  return opts.remote
    ? { ok: false, error: 'remote_close_result_missing', recovery: 'retryable' }
    : { ok: true };
}

/**
 * May a FAILED prepare restore write admission?
 *
 * Only a REVERSIBLE failure may. Rolling back on every ok:false re-opened writes
 * on a lineage that had already been cancelled remotely (a session that looks
 * writable but can never continue), and it also started a fresh lineage on top of
 * a possible unnamed orphan when the outcome was merely unknown.
 *
 * Absent `recovery` keeps the historical rollback behaviour.
 */
export function mayRestoreWriteAdmission(result: SessionDestroyResult): boolean {
  if (result.ok) return false;
  return (result.recovery ?? 'retryable') === 'retryable';
}
