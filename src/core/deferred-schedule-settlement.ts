import type { DaemonSession } from './types.js';
import type { ScheduledTask } from '../types.js';
import { logger } from '../utils/logger.js';
import * as sessionStore from '../services/session-store.js';

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

/** A scheduled turn still held by the runtime gate cannot become accepted after
 * its worker has exited. Settle that exact parked run immediately rather than
 * leaving it until the handoff timeout. Accepted turns and unrelated waiting
 * sessions do not take this exit. The scheduler settlement is idempotent, so
 * duplicate session run indexes and repeated exit edges remain single-shot. */
export function settleHeldScheduleRunsOnWorkerExit(
  session: Pick<DaemonSession['session'], 'scheduledRun' | 'scheduledRuns' | 'queuedActivationTail'>,
  larkAppId: string,
  deps: {
    getDeferredRun: (taskId: string, appId: string) => ScheduledTask['deferredRun'] | undefined;
    settle: (taskId: string, runId: string, reason: string, appId?: string) => boolean;
  },
  exit: { currentWorker: boolean; transferredTurnIds?: ReadonlySet<string> },
): number {
  // Late exit events from an old generation say nothing about a replacement
  // that now owns the turn. Only the worker still bound to the session at the
  // moment it exited may settle scheduled work.
  if (!exit.currentWorker) return 0;
  const scheduledRuns = [
    ...(session.scheduledRun ? [session.scheduledRun] : []),
    ...Object.values(session.scheduledRuns ?? {}),
  ];
  let settled = 0;
  for (const run of scheduledRuns) {
    const parked = deps.getDeferredRun(run.taskId, larkAppId);
    if (!parked || parked.runId !== run.runId) continue;
    // The exit handler captured replacement ownership before detach promoted
    // the tail. That durable journal belongs to the successor, not this exit.
    if (exit.transferredTurnIds?.has(run.turnId)) continue;
    // The old runtime has explicitly transferred this exact turn to its
    // replacement. Its exit must not fail work that is waiting in that queue.
    if (session.queuedActivationTail?.some(entry =>
      entry.turnId === run.turnId && entry.ownerRuntime === 'new')) continue;
    if (Object.values(parked.acceptedTargets ?? {}).includes(run.turnId)) continue;
    if (!Object.values(parked.heldTargets ?? {}).includes(run.turnId)) continue;
    if (deps.settle(
      run.taskId,
      run.runId,
      'scheduled turn worker exited while the TRAE runtime handoff was still waiting',
      larkAppId,
    )) settled += 1;
  }
  return settled;
}

export interface ScheduledWorkerCancellationOptions {
  /** Exact accepted turns must survive cancellation of the other targets. */
  acceptedTurnIds?: ReadonlySet<string>;
  /** Cancel an exact unsubmitted turn; no active runtime is required. */
  cancelTurn?: (ds: DaemonSession, turnId: string) => unknown | Promise<unknown>;
  /** Last-resort retirement when the worker cannot prove queue removal. The
   *  session row and retained human conversation stay active. */
  retireWorker?: (ds: DaemonSession) => unknown | Promise<unknown>;
  /** Release/promote retained work after a cancelled head or tail is removed. */
  release?: (ds: DaemonSession) => unknown | Promise<unknown>;
  /** Test seam for an isolated session-store instance. */
  updateSession?: (session: DaemonSession['session']) => void;
}

function hasOtherQueuedWork(ds: DaemonSession, cancelledTurnIds: ReadonlySet<string>): boolean {
  if ((ds.session.queuedActivationTail?.length ?? 0) > 0) return true;
  const journalTurnId = ds.session.queuedActivationTurnId;
  if (ds.session.queuedActivationPending && journalTurnId && !cancelledTurnIds.has(journalTurnId)) return true;
  if ((ds.pendingFollowUps?.length ?? 0) > 0 || ds.pendingRepo || ds.pendingRepoCommitInFlight) return true;
  if (ds.pendingRawInput !== undefined || ds.pendingFollowUpInput !== undefined || ds.pendingTurnId !== undefined) return true;
  if (ds.pendingPrompt !== undefined || ds.cascadeInFlight || (ds.cascadeDeferred?.length ?? 0) > 0) return true;
  if (ds.initialStartPending && journalTurnId && !cancelledTurnIds.has(journalTurnId)) return true;
  return false;
}

function clearCancelledActivationJournal(ds: DaemonSession, turnIds: ReadonlySet<string>): boolean {
  const turnId = ds.session.queuedActivationTurnId;
  if (!ds.session.queuedActivationPending || !turnId || !turnIds.has(turnId)) return false;
  ds.session.queuedActivationPending = undefined;
  ds.session.queuedActivationToken = undefined;
  ds.session.queuedActivationInput = undefined;
  ds.session.queuedActivationTurnId = undefined;
  ds.session.queuedActivationDispatchAttempt = undefined;
  ds.session.queuedActivationResume = undefined;
  ds.session.queuedActivationRawInput = undefined;
  ds.session.queuedActivationRawTurnId = undefined;
  ds.initialStartPending = false;
  ds.pendingPrompt = undefined;
  return true;
}

/** Retry the exact in-memory tombstone/tail/journal state before any later
 * promotion. A transient write failure must not become a permanent quarantine. */
export function retryCancelledActivationPersistence(
  ds: DaemonSession,
  update: (session: DaemonSession['session']) => void = sessionStore.updateSession,
): boolean {
  if (!ds.activationCancellationPending) return true;
  try {
    update(ds.session);
    ds.activationCancellationPending = undefined;
    return true;
  } catch {
    return false;
  }
}

/** Stop pre-ready work whose scheduled turn can no longer be allowed to execute.
 * A durable tombstone is written ahead of tail/journal cleanup. If either write
 * fails, in-memory tombstones remain fail-closed and a later promotion retries
 * the complete current state instead of losing the cancelled turn ids. */
export function cancelPreReadyScheduledWorkers(
  sessions: Iterable<DaemonSession>,
  runId: string,
  close: (ds: DaemonSession) => void | Promise<void>,
  options: ScheduledWorkerCancellationOptions = {},
): number {
  let cancelled = 0;
  for (const ds of sessions) {
    const runs = [
      ...(ds.session.scheduledRun ? [ds.session.scheduledRun] : []),
      ...Object.values(ds.session.scheduledRuns ?? {}),
    ];
    const turnIds = new Set(runs.filter(run => run.runId === runId).map(run => run.turnId)
      .filter(turnId => !options.acceptedTurnIds?.has(turnId)));
    if (turnIds.size === 0) continue;
    const update = options.updateSession ?? sessionStore.updateSession;
    const tail = ds.session.queuedActivationTail;
    const tailCancelled = !!tail?.some(entry => turnIds.has(entry.turnId));
    const journalCancelled = !!ds.session.queuedActivationTurnId
      && turnIds.has(ds.session.queuedActivationTurnId);
    const stagedPlaceholder = ds.initialStartPending === true && !ds.worker;
    const retainedHumanConversation = ds.hasHistory === true || !!ds.session.cliSessionId
      || (!!ds.session.creationSource && ds.session.creationSource !== 'schedule');

    ds.session.cancelledActivationTurnIds = [...new Set([
      ...(ds.session.cancelledActivationTurnIds ?? []), ...turnIds,
    ])];
    // Write-ahead cancellation: the tombstone becomes durable BEFORE any tail
    // or journal entry is removed. If the cleanup write later fails and the
    // daemon restarts, recovery still filters this exact turn from the old tail.
    try {
      update(ds.session);
      ds.activationCancellationPending = undefined;
    } catch (error) {
      ds.activationCancellationPending = true;
      logger.warn(`[scheduler] Cancellation tombstone write-ahead for run ${runId} failed; worker execution is still blocked: ${String(error)}`);
    }
    if (tailCancelled) {
      const retained = tail!.filter(entry => !turnIds.has(entry.turnId));
      ds.session.queuedActivationTail = retained.length > 0 ? retained : undefined;
    }
    clearCancelledActivationJournal(ds, turnIds);
    if (stagedPlaceholder && !retainedHumanConversation) {
      // This prompt belongs to the cancelled scheduled opening itself, not to
      // unrelated queued work that would justify keeping a placeholder alive.
      ds.pendingPrompt = undefined;
      ds.scheduledStagedInput = undefined;
    }
    try {
      update(ds.session);
      ds.activationCancellationPending = undefined;
    } catch (error) {
      ds.activationCancellationPending = true;
      logger.warn(`[scheduler] Cancellation cleanup write for run ${runId} failed; retained in-memory tombstones and pruned state for retry: ${String(error)}`);
    }

    const waitingWorker = !!ds.worker && !ds.worker.killed && ds.workerReady !== true;
    const otherWork = hasOtherQueuedWork(ds, turnIds);
    const disposable = !retainedHumanConversation && !otherWork;
    if (!stagedPlaceholder && !waitingWorker) {
      if ((tailCancelled || journalCancelled) && options.release) {
        void Promise.resolve(options.release(ds)).catch(error => {
          logger.warn(`[scheduler] Failed to release retained activation work for run ${runId}: ${String(error)}`);
        });
      }
      continue;
    }
    cancelled += 1;
    void (async () => {
      if (disposable) {
        await close(ds);
        return;
      }
      if (waitingWorker) {
        // A tail-only item has already been removed from durable FIFO and needs
        // no active-turn interrupt. Opening or worker-queued turns need the
        // worker's exact unsubmitted-queue cancellation.
        const needsWorkerCancel = journalCancelled || !tailCancelled;
        let mustRetire = false;
        if (needsWorkerCancel) {
          for (const turnId of turnIds) {
            const status = await options.cancelTurn?.(ds, turnId);
            if (status !== undefined && status !== 'queued_removed') mustRetire = true;
          }
        }
        let releaseAllowed = true;
        if (mustRetire) {
          if (!options.retireWorker) releaseAllowed = false;
          else releaseAllowed = (await options.retireWorker(ds)) !== false;
        }
        if (!releaseAllowed) {
          logger.warn(`[scheduler] Worker retirement for run ${runId} was not proven; retained successor stays queued`);
          return;
        }
      }
      if (options.release) await options.release(ds);
    })().catch(error => {
      logger.warn(`[scheduler] Failed to cancel pre-ready work for run ${runId}: ${String(error)}`);
    });
  }
  return cancelled;
}

/** A durable activation head is recoverable only when its exact turn is not
 *  tombstoned. Restore paths must check this again at the final fork boundary. */
export function hasRecoverableActivationHead(
  session: Pick<DaemonSession['session'], 'queuedActivationPending' | 'queuedActivationTurnId' | 'cancelledActivationTurnIds'>,
): boolean {
  return session.queuedActivationPending === true && !!session.queuedActivationTurnId
    && !(session.cancelledActivationTurnIds ?? []).includes(session.queuedActivationTurnId);
}

/** After a proven retirement, an already-promoted human journal must not wait
 * for an unrelated inbound merely because the eager retry claim was cleared. */
export async function releaseCancelledActivationWork(
  ds: DaemonSession,
  deps: {
    release: () => Promise<boolean>;
    startJournal: () => void;
    scheduleRetry: () => void;
  },
): Promise<void> {
  if (await deps.release()) return;
  if ((!ds.worker || ds.worker.killed)
    && ds.session.queuedActivationPending && ds.session.queuedActivationInput) {
    deps.startJournal();
    return;
  }
  deps.scheduleRetry();
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
