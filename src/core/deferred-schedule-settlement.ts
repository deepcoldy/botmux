import type { DaemonSession } from './types.js';

export type DeferredScheduleSettlementResult =
  | { action: 'ignored' }
  | { action: 'materialized'; rootMessageId: string }
  | { action: 'closed' }
  /**
   * The close was REFUSED (e.g. a remote session could not be proven cancelled),
   * so the row is still active. Distinct from `closed` on purpose: reporting it as
   * closed is the same false success this work exists to remove, just moved from a
   * UI seam to the settlement seam.
   */
  | { action: 'close_refused'; error?: string };

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
  return { action: 'closed' };
}
