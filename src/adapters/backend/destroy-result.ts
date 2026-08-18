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
  // `uncertain`, NOT `retryable`: the comment above already called this outcome
  // UNKNOWN, but returning retryable told the caller to roll back and re-open
  // write admission — on a session whose remote teardown may well have completed.
  // An unknown outcome must fence, not roll back.
  // `admission: 'fenced'` is stated EXPLICITLY rather than left to the
  // recovery-derived default: this is the one outcome where we know nothing at
  // all, so the fence must not depend on a second field keeping its value.
  return opts.remote
    ? {
      ok: false,
      error: 'remote_close_result_missing',
      recovery: 'uncertain',
      admission: 'fenced',
    }
    : { ok: true };
}

/**
 * Is the close itself retryable — i.e. did nothing irreversible happen?
 *
 * This is the CLOSE-side question only. It must never be used to decide whether
 * writes may be admitted again; see mayRestoreWriteAdmission for why the two
 * answers legitimately differ.
 */
export function mayRetryClose(result: SessionDestroyResult): boolean {
  if (result.ok) return false;
  return (result.recovery ?? 'retryable') !== 'irreversible';
}

/**
 * May a FAILED prepare restore write admission?
 *
 * Deliberately keyed on `admission`, NOT on `recovery`. Reading `recovery` here
 * conflated two different questions and produced a real fencing hole: an
 * unproven local child termination is `retryable` (the irreversible remote
 * cancel has not run, so the close may be retried) yet a credentialed process
 * may still be alive, so admitting a write would layer a fresh turn on top of a
 * live orphan. Rolling back on every ok:false was worse still — it re-opened
 * writes on a lineage already cancelled remotely.
 *
 * When `admission` is absent it is derived from `recovery`, which keeps the
 * historical behaviour for results that predate the field.
 */
export function mayRestoreWriteAdmission(result: SessionDestroyResult): boolean {
  if (result.ok) return false;
  if (result.admission) return result.admission === 'restorable';
  return (result.recovery ?? 'retryable') === 'retryable';
}

/**
 * Did abortDestroySession() actually restore write admission?
 *
 * A rollback can be legitimately REFUSED (the backend is holding a latched fence
 * because a credentialed local subtree could not be proven dead). The daemon used
 * to infer success from "the worker answered without throwing", so a refused
 * rollback was recorded durably as `admissionRestored: true` — the journal then
 * claimed admission was back while write() kept returning false.
 *
 * Legacy backends return void from abortDestroySession, which genuinely means
 * "restored"; that is the ONLY unknown shape treated as success. Anything else
 * malformed fails closed, because a fence wrongly cleared is unrecoverable while
 * a fence wrongly kept is merely retried.
 */
export function interpretAbortOutcome(raw: unknown): { admissionRestored: boolean; reason?: string } {
  if (raw === undefined || raw === null) return { admissionRestored: true };
  if (typeof raw === 'object' && typeof (raw as { admissionRestored?: unknown }).admissionRestored === 'boolean') {
    const { admissionRestored, reason } = raw as { admissionRestored: boolean; reason?: unknown };
    return {
      admissionRestored,
      ...(typeof reason === 'string' && reason ? { reason } : {}),
    };
  }
  return { admissionRestored: false, reason: 'abort_result_malformed' };
}

/**
 * How a restart's teardown ended.
 *
 * `absent` is the local-backend case: destroySession is synchronous (or missing),
 * so there is no promise to race and nothing to be uncertain about.
 */
export type RestartTeardownOutcome =
  | { kind: 'absent' }
  | { kind: 'settled'; raw: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' };

/**
 * May restartCliProcess() respawn after this teardown?
 *
 * restartCliProcess used to compute the teardown and throw it away:
 *
 *     try { await Promise.race([teardown, sleep(22_000)]); } catch {}
 *     killCli(...);   // respawns regardless
 *
 * which laundered three distinct failures into "clean close": a resolved
 * `ok: false` (never read), a won timeout (the timeout IS the signal that teardown
 * is unfinished), and a rejection (swallowed by `catch {}`). All three then reached
 * killCli() + respawn, so a fresh lineage — and a fresh env nonce — was layered on
 * top of a subtree that may still hold the injected credential, while the old tree
 * became unenumerable.
 *
 * This is the same fail-closed rule the close path uses, applied to restart: an
 * unproven teardown must not silently start a second lineage. Note the deliberate
 * asymmetry with the close path — the answer here is only "may we respawn?" and it
 * NEVER authorises abortDestroySession(), because rollback is not the legitimate
 * exit from an uncertain teardown.
 */
export function classifyRestartTeardown(
  outcome: RestartTeardownOutcome,
  opts: { remote: boolean },
): { mayRespawn: boolean; reason?: string; recovery?: 'retryable' | 'uncertain' | 'irreversible' } {
  switch (outcome.kind) {
    case 'absent':
      return { mayRespawn: true };
    case 'timeout':
      // Bounded wait expired: teardown is still in flight, so its side effects are
      // unknown. Respawning here is what produced a second credentialed lineage.
      return { mayRespawn: false, reason: 'restart_teardown_timeout', recovery: 'uncertain' };
    case 'rejected':
      return {
        mayRespawn: false,
        reason: outcome.error instanceof Error
          ? `restart_teardown_threw: ${outcome.error.message}`
          : `restart_teardown_threw: ${String(outcome.error)}`,
        recovery: 'uncertain',
      };
    case 'settled': {
      // Reuses the close path's normalizer so a malformed remote answer is UNKNOWN
      // here too, rather than a truthy object passing for success.
      const result = normalizeDestroyResult(outcome.raw, { remote: opts.remote });
      if (result.ok) return { mayRespawn: true };
      return {
        mayRespawn: false,
        reason: result.error ?? 'restart_teardown_failed',
        recovery: result.recovery ?? 'retryable',
      };
    }
  }
}

/**
 * Why a local termination could not be proven, and therefore what the close may do.
 *
 * Two failures look identical at the call site and must NOT be punished the same:
 *
 *   - "the platform can never prove it"  — there is no instrument. On a host with
 *     no /proc (Darwin), the scan answers `unsupported-platform` FOREVER, so a
 *     latched write fence turns into a permanent wedge: every close fails, every
 *     retry fails for the same unchangeable reason, and write() never returns true
 *     again. Nothing about that state is evidence of a survivor; it is evidence
 *     that we cannot look.
 *   - "it should have been provable and was not" — `alive` is a positive sighting,
 *     and `unscannable` is a transient or partial read failure on a host that CAN
 *     normally enumerate. Both mean a credentialed process may be running right
 *     now, and both may resolve on a retry, so both must keep the fence.
 *
 * The residual verdict is only safe because the credential-boundary question moves
 * to the layer that can actually hold it: an unprovable containment handle is
 * persisted and can NEVER be released, so the device-isolation blocker survives the
 * closed row. Without that backstop this would be a fail-open hole, so do not reuse
 * `residual-close` anywhere the blocker is not retained.
 *
 * Takes the kind as a plain string on purpose: this keeps the decision free of any
 * import from the process-tree module, so the two files can be edited and merged
 * independently. Unknown and absent kinds FAIL CLOSED.
 */
export function classifyUnprovenTermination(
  kind: string | undefined,
): { outcome: 'residual-close' | 'fence'; reason: string } {
  if (kind === 'unsupported-platform') {
    return {
      outcome: 'residual-close',
      reason: 'mojo_local_termination_unprovable_on_platform',
    };
  }
  // Everything else, including an unrecognised kind, keeps the fence. A fence
  // wrongly kept costs a retry; a fence wrongly released strands a credentialed
  // process behind a row that claims to be closed.
  return {
    outcome: 'fence',
    reason: kind === 'alive'
      ? 'mojo_local_child_termination_unproven'
      : kind === 'unscannable'
        ? 'mojo_local_termination_unscannable'
        : 'mojo_local_child_termination_unproven',
  };
}

/**
 * The `close_result` payload a worker sends back for a close prepare.
 *
 * This is a function, not an inline object literal, because the daemon owns the
 * rollback decision: dropping `recovery` here silently laundered every
 * `uncertain` / `irreversible` verdict back into `retryable` at the IPC boundary,
 * and an inline literal inside worker.ts was not reachable from any test.
 */
export function buildCloseResultMessage(
  requestId: string,
  result: SessionDestroyResult,
): {
  type: 'close_result';
  requestId: string;
  ok: boolean;
  taskId?: string;
  error?: string;
  recovery?: 'retryable' | 'uncertain' | 'irreversible';
  admission?: 'restorable' | 'fenced';
  residual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
} {
  return {
    type: 'close_result',
    requestId,
    ok: result.ok,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.recovery ? { recovery: result.recovery } : {}),
    // `admission` must cross the IPC boundary for the same reason `recovery`
    // does: dropping it here would let the daemon re-derive "retryable ⇒ writes
    // are fine" and undo a fence the backend deliberately kept.
    ...(result.admission ? { admission: result.admission } : {}),
    // `residual` must cross too, and dropping it was NOT symmetric with dropping
    // `recovery`: an ok:true close whose local subtree was never proven gone would
    // arrive as a bare success, so the daemon published an ORDINARY closed row.
    // That is the fail-open this round exists to remove -- the backend kept the
    // containment handle, the row said the session was fully gone, and the two
    // disagreed about a still-credentialed process. The daemon cannot re-derive
    // this: only the backend saw the evidence grade.
    ...(result.residual ? { residual: result.residual } : {}),
  };
}
