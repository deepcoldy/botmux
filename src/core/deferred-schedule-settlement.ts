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
  /** Interrupt only the exact scheduled turn on a shared pre-ready worker. */
  cancelTurn?: (ds: DaemonSession, turnId: string) => void | Promise<void>;
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

function persistCancelledTurnTombstones(
  ds: DaemonSession,
  turnIds: ReadonlySet<string>,
  update: (session: DaemonSession['session']) => void,
): boolean {
  const previous = ds.session.cancelledActivationTurnIds;
  ds.session.cancelledActivationTurnIds = [...new Set([...(previous ?? []), ...turnIds])];
  try {
    update(ds.session);
    ds.activationCancellationPending = undefined;
    return true;
  } catch {
    ds.session.cancelledActivationTurnIds = previous;
    ds.activationCancellationPending = true;
    return false;
  }
}

function clearCancelledActivationJournal(
  ds: DaemonSession,
  turnIds: ReadonlySet<string>,
  update: (session: DaemonSession['session']) => void,
): void {
  const turnId = ds.session.queuedActivationTurnId;
  if (!ds.session.queuedActivationPending || !turnId || !turnIds.has(turnId)) return;
  const previous = {
    pending: ds.session.queuedActivationPending,
    token: ds.session.queuedActivationToken,
    input: ds.session.queuedActivationInput,
    turnId: ds.session.queuedActivationTurnId,
    dispatchAttempt: ds.session.queuedActivationDispatchAttempt,
    resume: ds.session.queuedActivationResume,
    rawInput: ds.session.queuedActivationRawInput,
    rawTurnId: ds.session.queuedActivationRawTurnId,
    initialStartPending: ds.initialStartPending,
    pendingPrompt: ds.pendingPrompt,
  };
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
  try {
    update(ds.session);
  } catch (error) {
    Object.assign(ds.session, {
      queuedActivationPending: previous.pending,
      queuedActivationToken: previous.token,
      queuedActivationInput: previous.input,
      queuedActivationTurnId: previous.turnId,
      queuedActivationDispatchAttempt: previous.dispatchAttempt,
      queuedActivationResume: previous.resume,
      queuedActivationRawInput: previous.rawInput,
      queuedActivationRawTurnId: previous.rawTurnId,
    });
    ds.initialStartPending = previous.initialStartPending;
    ds.pendingPrompt = previous.pendingPrompt;
    throw error;
  }
}

/** Stop pre-ready work whose scheduled turn can no longer be allowed to execute.
 * Ready turns are never killed by this path. Tail entries are removed by exact
 * turn identity BEFORE any session-level close, so a ready old worker cannot
 * later promote a cancelled scheduled turn into its replacement. */
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
    if (!persistCancelledTurnTombstones(ds, turnIds, options.updateSession ?? sessionStore.updateSession)) {
      logger.warn(`[scheduler] Failed to persist cancellation tombstone for run ${runId}; promotion remains blocked`);
      continue;
    }
    const tail = ds.session.queuedActivationTail;
    if (tail?.some(entry => turnIds.has(entry.turnId))) {
      const retained = tail.filter(entry => !turnIds.has(entry.turnId));
      const previous = tail;
      ds.session.queuedActivationTail = retained.length > 0 ? retained : undefined;
      try {
        (options.updateSession ?? sessionStore.updateSession)(ds.session);
      } catch (error) {
        ds.session.queuedActivationTail = previous;
        logger.warn(`[scheduler] Failed to remove cancelled activation turn(s) for run ${runId}: ${String(error)}`);
        // The tombstone is already durable, so this turn cannot execute later.
        // Do not close/interrupt based on the restored tail as if it were new work.
        continue;
      }
    }
    try {
      clearCancelledActivationJournal(ds, turnIds, options.updateSession ?? sessionStore.updateSession);
    } catch (error) {
      logger.warn(`[scheduler] Failed to clear cancelled activation journal for run ${runId}: ${String(error)}`);
      continue;
    }
    const stagedPlaceholder = ds.initialStartPending === true && !ds.worker;
    const waitingWorker = !!ds.worker && !ds.worker.killed && ds.workerReady !== true;
    if (!stagedPlaceholder && !waitingWorker) continue;
    cancelled += 1;
    try {
      if (hasOtherQueuedWork(ds, turnIds)) {
        for (const turnId of turnIds) void Promise.resolve(options.cancelTurn?.(ds, turnId)).catch(error => {
          logger.warn(`[scheduler] Failed to interrupt scheduled turn ${turnId} for run ${runId}: ${String(error)}`);
        });
      } else {
        void Promise.resolve(close(ds)).catch(error => {
          logger.warn(`[scheduler] Failed to close pre-ready worker for run ${runId}: ${String(error)}`);
        });
      }
    } catch (error) {
      logger.warn(`[scheduler] Failed to close pre-ready worker for run ${runId}: ${String(error)}`);
    }
  }
  return cancelled;
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
