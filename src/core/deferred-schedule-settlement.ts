import type { DaemonSession } from './types.js';

/** Worker → daemon terminal error code: a hidden schedule run's CLI never
 *  recorded the prompt it was started with, so the run never executed (#1607). */
export const SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE = 'schedule_prompt_undelivered';

export type DeferredScheduleSettlementResult =
  | { action: 'ignored' }
  | { action: 'materialized'; rootMessageId: string }
  /** `undelivered`: the run closed without its prompt ever reaching the CLI.
   *  A hidden run has no other surface, so the caller must report it. */
  | { action: 'closed'; undelivered?: true }
  /**
   * The close was REFUSED (e.g. a remote session could not be proven cancelled),
   * so the row is still active. Distinct from `closed` on purpose: reporting it as
   * closed is the same false success this work exists to remove, just moved from a
   * UI seam to the settlement seam.
   */
  | { action: 'close_refused'; error?: string };

/** Keep a worker's "prompt never reached the CLI" verdict for the hidden
 *  run's turn. The worker reports it as a failed terminal and then releases
 *  its idle, and that idle re-arms the debounced settlement with a context of
 *  its own — so the verdict lives on the session, not on one edge. */
export function noteDeferredScheduleRunFailure(
  ds: DaemonSession,
  context: { turnId: string; errorCode?: string },
): void {
  if (context.errorCode === SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE) {
    ds.deferredScheduleUndeliveredTurnId = context.turnId;
  }
}

/** Execute the exact-turn lifecycle decision after a hidden schedule run
 * reaches a terminal/idle edge. Timer debounce lives in daemon.ts; keeping the
 * decision here makes the close-vs-retain contract independently testable. */
export async function settleDeferredScheduleRun(
  ds: DaemonSession,
  context: { turnId: string; source: 'terminal' | 'idle' },
  deps: {
    reconcile: (ds: DaemonSession) => string | undefined;
    /** Typed on purpose: `Promise<unknown>` made the refusal unreadable here. */
    closeSession: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  },
): Promise<DeferredScheduleSettlementResult> {
  const run = ds.session.deferredScheduleRun;
  if (!run || run.turnId !== context.turnId || ds.session.status === 'closed') {
    return { action: 'ignored' };
  }
  if (context.source === 'idle' && ds.lastScreenStatus !== 'idle') {
    return { action: 'ignored' };
  }
  const rootMessageId = deps.reconcile(ds);
  if (rootMessageId) return { action: 'materialized', rootMessageId };
  const result = await deps.closeSession(ds.session.sessionId);
  if (!result.ok) {
    return { action: 'close_refused', ...(result.error ? { error: result.error } : {}) };
  }
  return ds.deferredScheduleUndeliveredTurnId === context.turnId
    ? { action: 'closed', undelivered: true }
    : { action: 'closed' };
}

/** Make an undelivered hidden run visible where silent runs otherwise leave no
 *  trace: its run-log record turns into an error, and the chat gets one line.
 *  Each step is best-effort and independent — one failing must not hide the
 *  other. */
export async function reportUndeliveredScheduleRun(
  run: NonNullable<DaemonSession['session']['deferredScheduleRun']>,
  deps: {
    /** Rewrite the run's execution-log record as an error; false when the
     *  record cannot be found (older run, trimmed history). */
    markRunLogUndelivered: (taskId: string, runId: string) => boolean;
    notifyChat: () => Promise<unknown>;
    warn: (message: string) => void;
  },
): Promise<void> {
  if (run.runId) {
    try {
      if (!deps.markRunLogUndelivered(run.taskId, run.runId)) {
        deps.warn(`[scheduler] Undelivered run ${run.runId} of task ${run.taskId} has no execution-log record to update`);
      }
    } catch (err) {
      deps.warn(`[scheduler] Could not record undelivered run ${run.runId} of task ${run.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await deps.notifyChat();
  } catch (err) {
    deps.warn(`[scheduler] Could not post the undelivered notice for task ${run.taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
