import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { DaemonToWorker, WorkerToDaemon } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';
import type { DaemonSession } from './types.js';
import {
  RIFF_ADMISSION_RESTORE_TIMEOUT_MS,
  RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS,
  RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS,
  RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS,
} from './shutdown-budgets.js';

type ShutdownPhase = 'prepare' | 'abort';

type ShutdownPhaseResult = {
  ok: boolean;
  taskId: string | null;
  error?: string;
};

export type PreparedRiffShutdown = {
  ok: true;
  fence: 'prepared';
  requestId: string;
  taskId: string | null;
  /** Runtime lineage sampled before the worker fence. A workerless transaction
   * must still own this exact value at persistence time; a live transaction may
   * advance only to its drained `taskId`. */
  runtimeTaskIdAtPrepare: string | null;
  /** Fresh durable lineage sampled before installing the fence. Phase 2 uses
   * it as a lock-protected compare-and-set guard, while also accepting an
   * already-idempotent target written by the ordinary task-id callback. */
  durableTaskIdAtPrepare: string | null;
  durableOwnerAtPrepare: {
    pid: number | null;
    larkAppId: string | null;
    backendType: string | null;
  };
  /** Set only after the exact cross-process fresh read succeeds. Used when a
   * prepared worker exits before an all-or-nothing rollback can reach it. */
  lineageVerified: boolean;
  /** Exact generation fenced by `requestId`. Null means the active logical
   * session was already workerless and only its runtime lineage needs an exact
   * durable verification. */
  worker: ChildProcess | null;
};

export type RiffShutdownFailure = {
  ok: false;
  requestId?: string;
  taskId: string | null;
  error: string;
  /** Phase-2 coordinator policy. Ownership ambiguity must stay fenced; a
   * plain atomic-write I/O failure may restore the exact prepared worker. */
  rollbackDisposition?: 'abort_safe' | 'retain_fence';
};

/** A prepare refusal that is proven to have happened before the worker/backend
 * fence. It must never be sent an abort request. */
export type UnfencedRiffShutdownRefusal = RiffShutdownFailure & {
  fence: 'none';
};

/** A prepare attempt whose exact worker may have installed its backend fence.
 * Preparation deliberately does not restore admission inline; the fleet
 * coordinator includes this handle in its one concurrent abort wave. */
export type PossiblyFencedRiffShutdown = RiffShutdownFailure & {
  fence: 'possible';
  requestId: string;
  worker: ChildProcess;
  expectedAbortTaskId?: string | null;
};

export type RiffShutdownPrepareResult =
  | PreparedRiffShutdown
  | UnfencedRiffShutdownRefusal
  | PossiblyFencedRiffShutdown;

export type RiffShutdownPrepareOptions = {
  drainTimeoutMs?: number;
  abortTimeoutMs?: number;
  /** Absolute transaction deadline. A worker is never asked to fence unless
   * phase-2 plus the configured admission-restore reserve remain after drain. */
  deadlineMs?: number;
  now?: () => number;
  /** One projection sampled by prepareRiffFleetForShutdown before any fence. */
  durableSnapshot?: sessionStore.ActiveRiffShutdownSnapshot;
};

export type RiffFleetPrepareEntry = {
  ds: DaemonSession;
  result: RiffShutdownPrepareResult;
};

export type FencedRiffShutdownParticipant =
  | PreparedRiffShutdown
  | PossiblyFencedRiffShutdown;

export type UniqueDaemonShutdownSessions =
  | { ok: true; sessions: DaemonSession[] }
  | { ok: false; sessionId: string; error: string };

/** The active registry can retain multiple aliases to one exact runtime object
 * after transfer/restore. Process that object once, but refuse two distinct
 * objects claiming the same durable session id: there is no unique generation
 * that shutdown can safely fence or retire. */
export function collectUniqueDaemonShutdownSessions(
  candidates: Iterable<DaemonSession>,
): UniqueDaemonShutdownSessions {
  const seenObjects = new Set<DaemonSession>();
  const bySessionId = new Map<string, DaemonSession>();
  const sessions: DaemonSession[] = [];
  for (const ds of candidates) {
    if (seenObjects.has(ds)) continue;
    seenObjects.add(ds);
    const sessionId = ds.session.sessionId;
    const existing = bySessionId.get(sessionId);
    if (existing && existing !== ds) {
      return {
        ok: false,
        sessionId,
        error: `distinct daemon session generations share session id ${sessionId}`,
      };
    }
    bySessionId.set(sessionId, ds);
    sessions.push(ds);
  }
  return { ok: true, sessions };
}

export type RiffShutdownDetachOutcome =
  | {
      ok: true;
      requestId: string;
      taskId: string | null;
      disposition: 'lineage_persisted';
      worker?: ChildProcess;
    }
  | RiffShutdownFailure;

function label(ds: DaemonSession): string {
  return ds.session.sessionId.slice(0, 8);
}

function workerHasExited(worker: ChildProcess): boolean {
  return (worker.exitCode !== null && worker.exitCode !== undefined)
    || (worker.signalCode !== null && worker.signalCode !== undefined);
}

function send(worker: ChildProcess, message: DaemonToWorker): boolean {
  try {
    worker.send(message);
    return true;
  } catch {
    return false;
  }
}

/** Attach the exact-worker response/exit listeners before publishing a phase
 * request. Results from another generation/session/request are inert. */
function requestPhase(
  ds: DaemonSession,
  worker: ChildProcess,
  requestId: string,
  phase: ShutdownPhase,
  timeoutMs: number,
): Promise<ShutdownPhaseResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: ShutdownPhaseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('exit', onExit);
      resolve(result);
    };
    const onMessage = (raw: unknown): void => {
      const msg = raw as WorkerToDaemon;
      if (msg?.type !== 'riff_shutdown_result'
          || msg.requestId !== requestId
          || msg.phase !== phase) return;
      if (ds.worker !== worker) {
        finish({ ok: false, taskId: msg.taskId, error: 'stale_worker_generation' });
        return;
      }
      finish({
        ok: msg.ok,
        taskId: msg.taskId,
        ...(msg.error ? { error: msg.error } : {}),
      });
    };
    const onExit = (): void => finish({
      ok: false,
      taskId: null,
      error: `worker_exited_during_shutdown_${phase}`,
    });
    const timer = setTimeout(() => finish({
      ok: false,
      taskId: null,
      error: `riff_shutdown_${phase}_timeout`,
    }), timeoutMs);
    timer.unref?.();
    worker.on('message', onMessage);
    worker.once('exit', onExit);
    const message: DaemonToWorker = phase === 'prepare'
      ? { type: 'riff_shutdown_prepare', requestId }
      : { type: 'riff_shutdown_abort', requestId };
    if (!send(worker, message)) {
      finish({ ok: false, taskId: null, error: `riff_shutdown_${phase}_send_failed` });
    }
  });
}

function clearWorkerOwnership(ds: DaemonSession, worker: ChildProcess): void {
  if (ds.worker !== worker) return;
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;
  ds.workerViewToken = null;
  ds.managedTurnOrigin = undefined;
  ds.riffShutdownState = undefined;
}

function clearWorkerlessShutdownState(ds: DaemonSession, requestId: string): void {
  if (ds.riffShutdownState?.requestId !== requestId) return;
  if (ds.worker) return;
  ds.riffShutdownState = undefined;
}

/** Daemon-owned accepted input has not crossed worker IPC yet. The bot-wide
 * mutation lease blocks new admissions, but these older buffers must also be
 * empty before a worker can be detached. */
function daemonInputBlocker(ds: DaemonSession): string | null {
  const parts: string[] = [];
  if (ds.initialStartPending) parts.push('initial_start=1');
  if (ds.pendingPrompt) parts.push('prompt=1');
  if (ds.pendingRawInput) parts.push('raw=1');
  if (ds.pendingFollowUpInput) parts.push('raw_followup=1');
  if ((ds.pendingFollowUps?.length ?? 0) > 0) {
    parts.push(`followups=${ds.pendingFollowUps!.length}`);
  }
  if ((ds.pendingQueuedActivationFollowUps?.length ?? 0) > 0) {
    parts.push(`activation_tail=${ds.pendingQueuedActivationFollowUps!.length}`);
  }
  if ((ds.session.queuedActivationTail?.length ?? 0) > 0) {
    parts.push(`durable_activation_tail=${ds.session.queuedActivationTail!.length}`);
  }
  if (ds.session.queued) parts.push('queued=1');
  if (ds.session.queuedActivationPending) parts.push('activation_journal=1');
  return parts.length > 0 ? parts.join(',') : null;
}

async function abortWorkerPreparation(
  ds: DaemonSession,
  worker: ChildProcess,
  requestId: string,
  timeoutMs: number,
  lineageVerified = false,
  exactTask?: { taskId: string | null },
): Promise<ShutdownPhaseResult> {
  if (workerHasExited(worker)) {
    if (ds.worker && ds.worker !== worker) {
      return {
        ok: false,
        taskId: ds.riffShutdownState?.taskId ?? ds.session.riffParentTaskId ?? null,
        error: 'new_worker_generation',
      };
    }
    if (lineageVerified) {
      if (ds.worker === worker) clearWorkerOwnership(ds, worker);
      else clearWorkerlessShutdownState(ds, requestId);
      return { ok: true, taskId: ds.session.riffParentTaskId ?? null };
    }
    // No backend remains to ACK admission restoration and the drained lineage
    // was not durably recovered. Retain a daemon-side fence instead of claiming
    // rollback success and permitting a stale-lineage replacement.
    if (!ds.riffShutdownState || ds.riffShutdownState.requestId === requestId) {
      ds.riffShutdownState = {
        phase: 'prepared',
        requestId,
        taskId: ds.session.riffParentTaskId ?? null,
      };
    }
    return {
      ok: false,
      taskId: ds.session.riffParentTaskId ?? null,
      error: 'worker_exited_before_admission_restore',
    };
  }
  if (ds.worker !== worker) {
    return {
      ok: false,
      taskId: ds.riffShutdownState?.taskId ?? ds.session.riffParentTaskId ?? null,
      error: 'new_worker_generation',
    };
  }
  const result = await requestPhase(ds, worker, requestId, 'abort', timeoutMs);
  if (result.ok && exactTask && result.taskId !== exactTask.taskId) {
    return {
      ok: false,
      taskId: result.taskId,
      error: `abort_task_lineage_mismatch:expected=${exactTask.taskId ?? 'none'},`
        + `actual=${result.taskId ?? 'none'}`,
    };
  }
  if (result.ok && ds.riffShutdownState?.requestId === requestId) {
    ds.riffShutdownState = undefined;
  }
  return result;
}

function unfencedRefusal(
  ds: DaemonSession,
  error: string,
  requestId?: string,
): UnfencedRiffShutdownRefusal {
  return {
    ok: false,
    fence: 'none',
    ...(requestId ? { requestId } : {}),
    taskId: ds.session.riffParentTaskId ?? null,
    error,
  };
}

/** Phase 1: fence one exact Riff generation and drain task-id materialization.
 * Nothing exits or restores admission here. A failure after the prepare send
 * returns an exact possibly-fenced handle so all peers can be restored in one
 * concurrent fleet wave rather than serial drain+abort chains. */
export async function prepareRiffSessionForShutdown(
  ds: DaemonSession,
  options: RiffShutdownPrepareOptions = {},
): Promise<RiffShutdownPrepareResult> {
  const frozenBackend = ds.initConfig?.backendType ?? ds.session.backendType;
  if (frozenBackend !== 'riff') {
    return unfencedRefusal(ds, 'not_riff_backend');
  }
  if (ds.riffCloseState || ds.riffShutdownState) {
    return unfencedRefusal(
      ds,
      ds.riffCloseState ? 'explicit_close_in_progress' : 'shutdown_detach_in_progress',
    );
  }
  const daemonBlockerBeforePrepare = daemonInputBlocker(ds);
  if (daemonBlockerBeforePrepare) {
    return unfencedRefusal(ds, `daemon_inputs_not_drained:${daemonBlockerBeforePrepare}`);
  }

  const runtimeTaskIdAtPrepare = ds.session.riffParentTaskId ?? null;
  let durableSnapshot = options.durableSnapshot;
  if (!durableSnapshot) {
    try {
      [durableSnapshot] = sessionStore.getActiveRiffShutdownSnapshotsBatch([
        ds.session.sessionId,
      ]);
    } catch (err) {
      return unfencedRefusal(
        ds,
        `durable_session_read_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!durableSnapshot || durableSnapshot.sessionId !== ds.session.sessionId) {
    return unfencedRefusal(ds, 'durable_session_snapshot_mismatch');
  }
  const durableTaskIdAtPrepare = durableSnapshot.taskId;
  const runtimeOwner = {
    pid: ds.session.pid ?? null,
    larkAppId: ds.session.larkAppId ?? null,
    backendType: ds.session.backendType ?? null,
  };
  const durableOwnerAtPrepare = durableSnapshot.owner;
  if (durableOwnerAtPrepare.pid !== runtimeOwner.pid
      || durableOwnerAtPrepare.larkAppId !== runtimeOwner.larkAppId
      || durableOwnerAtPrepare.backendType !== runtimeOwner.backendType) {
    return unfencedRefusal(
      ds,
      `durable_session_owner_mismatch:current=${JSON.stringify(durableOwnerAtPrepare)},`
        + `runtime=${JSON.stringify(runtimeOwner)}`,
    );
  }

  const now = options.now ?? Date.now;
  const abortReserveMs = options.abortTimeoutMs ?? RIFF_ADMISSION_RESTORE_TIMEOUT_MS;
  let drainTimeoutMs = options.drainTimeoutMs ?? RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (options.deadlineMs !== undefined) {
    const availableDrainMs = options.deadlineMs
      - now()
      - RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
      - abortReserveMs;
    if (availableDrainMs <= 0) {
      return unfencedRefusal(ds, 'insufficient_abort_budget_before_fence');
    }
    drainTimeoutMs = Math.min(drainTimeoutMs, availableDrainMs);
  }

  const requestId = randomUUID();
  const worker = ds.worker;
  if (!worker || workerHasExited(worker)) {
    // Retire a previously observed dead handle before installing the
    // workerless fence. Any later non-null ds.worker is then unambiguously a
    // new generation and cannot be blessed by this transaction.
    if (worker) clearWorkerOwnership(ds, worker);
    // Workerless rows can still carry a newer runtime-only lineage after a
    // failed ordinary riff_task_id save. Fence daemon admission now; phase 2
    // performs an exact owner/lineage CAS and fresh disk verification.
    ds.riffShutdownState = {
      phase: 'prepared',
      requestId,
      taskId: ds.session.riffParentTaskId ?? null,
    };
    return {
      ok: true,
      fence: 'prepared',
      requestId,
      taskId: ds.session.riffParentTaskId ?? null,
      runtimeTaskIdAtPrepare,
      durableTaskIdAtPrepare,
      durableOwnerAtPrepare,
      lineageVerified: false,
      worker: null,
    };
  }

  ds.riffShutdownState = { phase: 'preparing', requestId };
  const prepared = await requestPhase(
    ds,
    worker,
    requestId,
    'prepare',
    drainTimeoutMs,
  );
  if (!prepared.ok) {
    // This exact response proves the worker refused before installing a backend
    // fence. Every other failure has ambiguous fence state and requires a
    // positive admission-restored ACK.
    const unfencedWorkerRefusal = prepared.error === 'explicit_close_in_progress'
      || prepared.error === 'not_riff_backend'
      || prepared.error === 'riff_shutdown_prepare_send_failed'
      || prepared.error?.startsWith('worker_inputs_not_drained:') === true;
    if (unfencedWorkerRefusal && ds.riffShutdownState?.requestId === requestId) {
      ds.riffShutdownState = undefined;
    }
    if (unfencedWorkerRefusal) {
      return {
        ok: false,
        fence: 'none',
        requestId,
        taskId: prepared.taskId,
        error: prepared.error ?? 'riff_shutdown_prepare_failed',
      };
    }
    return {
      ok: false,
      fence: 'possible',
      requestId,
      taskId: prepared.taskId,
      error: prepared.error ?? 'riff_shutdown_prepare_failed',
      worker,
    };
  }
  if (ds.worker !== worker) {
    return {
      ok: false,
      fence: 'possible',
      requestId,
      taskId: prepared.taskId,
      error: 'stale_worker_generation',
      worker,
    };
  }
  ds.riffShutdownState = { phase: 'prepared', requestId, taskId: prepared.taskId };

  // Worker events can release a queued-activation journal/tail independently
  // of bot-turn admission. Re-sample after drain so commit cannot strand input.
  const daemonBlockerAfterPrepare = daemonInputBlocker(ds);
  if (daemonBlockerAfterPrepare) {
    return {
      ok: false,
      fence: 'possible',
      requestId,
      taskId: prepared.taskId,
      error: `daemon_inputs_not_drained:${daemonBlockerAfterPrepare}`,
      worker,
      expectedAbortTaskId: prepared.taskId,
    };
  }

  return {
    ok: true,
    fence: 'prepared',
    requestId,
    taskId: prepared.taskId,
    runtimeTaskIdAtPrepare,
    durableTaskIdAtPrepare,
    durableOwnerAtPrepare,
    lineageVerified: false,
    worker,
  };
}

export type RiffFleetPrepareOptions = Omit<
  RiffShutdownPrepareOptions,
  'durableSnapshot'
> & {
  snapshotTimeoutMs?: number;
};

/** Take one fresh projection for the complete candidate set, then (and only
 * then) publish prepare requests concurrently. */
export async function prepareRiffFleetForShutdown(
  candidates: readonly DaemonSession[],
  options: RiffFleetPrepareOptions = {},
): Promise<RiffFleetPrepareEntry[]> {
  if (candidates.length === 0) return [];
  const now = options.now ?? Date.now;
  const configuredSnapshotTimeout = options.snapshotTimeoutMs
    ?? RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS;
  const remaining = options.deadlineMs === undefined
    ? configuredSnapshotTimeout
    : Math.max(0, options.deadlineMs - now());
  if (remaining <= 0) {
    return candidates.map(ds => ({
      ds,
      result: unfencedRefusal(ds, 'shutdown_deadline_elapsed_before_initial_snapshot'),
    }));
  }

  let snapshots: sessionStore.ActiveRiffShutdownSnapshot[];
  try {
    snapshots = sessionStore.getActiveRiffShutdownSnapshotsBatch(
      candidates.map(ds => ds.session.sessionId),
      { maxWaitMs: Math.min(configuredSnapshotTimeout, remaining) },
    );
  } catch (error) {
    const message = `initial_riff_snapshot_failed:${error instanceof Error
      ? error.message
      : String(error)}`;
    return candidates.map(ds => ({ ds, result: unfencedRefusal(ds, message) }));
  }

  const snapshotsBySession = new Map(snapshots.map(snapshot => [snapshot.sessionId, snapshot]));
  return Promise.all(candidates.map(async ds => ({
    ds,
    result: await prepareRiffSessionForShutdown(ds, {
      ...options,
      durableSnapshot: snapshotsBySession.get(ds.session.sessionId),
    }),
  })));
}

function validatePreparedRiffShutdownForPersistence(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
): { ok: true } | RiffShutdownFailure {
  if (ds.riffShutdownState?.requestId !== prepared.requestId
      || ds.riffShutdownState.phase !== 'prepared') {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: 'shutdown_prepare_ownership_lost',
      rollbackDisposition: 'retain_fence',
    };
  }
  const daemonBlocker = daemonInputBlocker(ds);
  if (daemonBlocker) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `daemon_inputs_not_drained:${daemonBlocker}`,
      rollbackDisposition: 'abort_safe',
    };
  }

  if (prepared.worker) {
    if (ds.worker !== prepared.worker || workerHasExited(prepared.worker)) {
      return {
        ok: false,
        requestId: prepared.requestId,
        taskId: prepared.taskId,
        error: 'stale_worker_generation',
        rollbackDisposition: 'retain_fence',
      };
    }
  } else if (ds.worker) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: 'new_worker_generation',
      rollbackDisposition: 'retain_fence',
    };
  }
  const runtimeOwner = {
    pid: ds.session.pid ?? null,
    larkAppId: ds.session.larkAppId ?? null,
    backendType: ds.session.backendType ?? null,
  };
  if (runtimeOwner.pid !== prepared.durableOwnerAtPrepare.pid
      || runtimeOwner.larkAppId !== prepared.durableOwnerAtPrepare.larkAppId
      || runtimeOwner.backendType !== prepared.durableOwnerAtPrepare.backendType) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `runtime_owner_changed:${JSON.stringify(runtimeOwner)}`,
      rollbackDisposition: 'retain_fence',
    };
  }
  const runtimeTaskId = ds.session.riffParentTaskId ?? null;
  const runtimeLineageExpected = prepared.worker
    ? runtimeTaskId === prepared.runtimeTaskIdAtPrepare || runtimeTaskId === prepared.taskId
    : runtimeTaskId === prepared.runtimeTaskIdAtPrepare;
  if (!runtimeLineageExpected) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `runtime_lineage_changed:${runtimeTaskId ?? 'none'}`,
      rollbackDisposition: 'retain_fence',
    };
  }
  return { ok: true };
}

export type PreparedRiffFleetEntry = {
  ds: DaemonSession;
  result: PreparedRiffShutdown;
};

export type RiffFleetPersistenceResult = { ok: true }
| (RiffShutdownFailure & {
  sessionIds: readonly string[];
  retainFencedSessionIds: readonly string[];
});

/** Phase 2 fleet transaction: validate every runtime generation, then compare
 * and publish all durable lineage rows with one lock and one rename. */
export function persistPreparedRiffShutdownFleet(
  entries: readonly PreparedRiffFleetEntry[],
  options: {
    persistTimeoutMs?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): RiffFleetPersistenceResult {
  if (entries.length === 0) return { ok: true };
  const now = options.now ?? Date.now;

  const validationFailures = entries
    .map(({ ds, result }) => ({
      sessionId: ds.session.sessionId,
      failure: validatePreparedRiffShutdownForPersistence(ds, result),
    }))
    .filter((entry): entry is {
      sessionId: string;
      failure: RiffShutdownFailure;
    } => !entry.failure.ok);
  if (validationFailures.length > 0) {
    const retainFencedSessionIds = validationFailures
      .filter(({ failure }) => failure.rollbackDisposition === 'retain_fence')
      .map(({ sessionId }) => sessionId);
    return {
      ok: false,
      taskId: null,
      error: `Riff fleet persistence preflight failed: ${validationFailures
        .map(({ sessionId, failure }) => `${sessionId}:${failure.error}`)
        .join(';')}`,
      rollbackDisposition: retainFencedSessionIds.length > 0 ? 'retain_fence' : 'abort_safe',
      sessionIds: validationFailures.map(({ sessionId }) => sessionId),
      retainFencedSessionIds,
    };
  }

  const configuredPersistTimeout = options.persistTimeoutMs
    ?? RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS;
  const remaining = options.deadlineMs === undefined
    ? configuredPersistTimeout
    : Math.max(0, options.deadlineMs - now());
  if (remaining <= 0) {
    return {
      ok: false,
      taskId: null,
      error: 'Riff fleet lineage batch failed (prewrite_io): shutdown deadline elapsed',
      rollbackDisposition: 'abort_safe',
      sessionIds: entries.map(({ ds }) => ds.session.sessionId),
      retainFencedSessionIds: [],
    };
  }

  try {
    sessionStore.persistActiveRiffLineagesExactBatch(entries.map(({ ds, result }) => ({
      sessionId: ds.session.sessionId,
      taskId: result.durableTaskIdAtPrepare,
      owner: result.durableOwnerAtPrepare,
      targetTaskId: result.taskId,
      expectedCurrentTaskIds: [result.durableTaskIdAtPrepare, result.taskId],
    })), {
      maxWaitMs: Math.min(configuredPersistTimeout, remaining),
    });
  } catch (error) {
    const batchError = error instanceof sessionStore.RiffLineageBatchError ? error : undefined;
    const stage = batchError?.stage ?? 'prewrite_io';
    const retainFencedSessionIds = stage === 'postrename_ambiguity'
      ? entries.map(({ ds }) => ds.session.sessionId)
      : stage === 'prewrite_ownership'
        ? [...(batchError?.sessionIds ?? [])]
        : [];
    return {
      ok: false,
      taskId: null,
      error: `Riff fleet lineage batch failed (${stage}): ${error instanceof Error
        ? error.message
        : String(error)}`,
      rollbackDisposition: retainFencedSessionIds.length > 0 ? 'retain_fence' : 'abort_safe',
      sessionIds: batchError?.sessionIds ?? entries.map(({ ds }) => ds.session.sessionId),
      retainFencedSessionIds,
    };
  }

  for (const { ds, result } of entries) {
    ds.session.riffParentTaskId = result.taskId ?? undefined;
    result.lineageVerified = true;
  }
  if (options.deadlineMs !== undefined && now() >= options.deadlineMs) {
    const sessionIds = entries.map(({ ds }) => ds.session.sessionId);
    return {
      ok: false,
      taskId: null,
      error: 'shutdown_deadline_elapsed_after_batch_persist',
      rollbackDisposition: 'retain_fence',
      sessionIds,
      retainFencedSessionIds: sessionIds,
    };
  }
  const lost = entries
    .filter(({ ds, result }) => !isPreparedRiffSessionCurrent(ds, result))
    .map(({ ds }) => ds.session.sessionId);
  if (lost.length > 0) {
    return {
      ok: false,
      taskId: null,
      error: `shutdown_prepare_ownership_lost_after_batch_persist:${lost.join(',')}`,
      rollbackDisposition: 'retain_fence',
      sessionIds: lost,
      retainFencedSessionIds: lost,
    };
  }
  return { ok: true };
}

/** Single-session compatibility path. Fleet shutdown uses the batch function
 * above; this API remains for explicit focused operations and older callers. */
export function persistPreparedRiffShutdown(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
): { ok: true } | RiffShutdownFailure {
  const validation = validatePreparedRiffShutdownForPersistence(ds, prepared);
  if (!validation.ok) return validation;

  try {
    sessionStore.persistActiveRiffLineageExact(ds.session.sessionId, prepared.taskId, {
      expectedCurrentTaskIds: [prepared.durableTaskIdAtPrepare, prepared.taskId],
      expectedOwner: prepared.durableOwnerAtPrepare,
    });
  } catch (err) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `lineage_persist_failed:${err instanceof Error ? err.message : String(err)}`,
      rollbackDisposition: err instanceof sessionStore.RiffLineageOwnershipError
        ? 'retain_fence'
        : 'abort_safe',
    };
  }

  let fresh: ReturnType<typeof sessionStore.getSessionFresh>;
  try {
    fresh = sessionStore.getSessionFresh(ds.session.sessionId);
  } catch (err) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `fresh_lineage_verification_failed:${err instanceof Error ? err.message : String(err)}`,
      rollbackDisposition: 'retain_fence',
    };
  }
  const freshTaskId = fresh?.riffParentTaskId ?? null;
  const freshOwner = fresh
    ? {
        pid: fresh.pid ?? null,
        larkAppId: fresh.larkAppId ?? null,
        backendType: fresh.backendType ?? null,
      }
    : null;
  const freshOwnerMatches = freshOwner !== null
    && freshOwner.pid === prepared.durableOwnerAtPrepare.pid
    && freshOwner.larkAppId === prepared.durableOwnerAtPrepare.larkAppId
    && freshOwner.backendType === prepared.durableOwnerAtPrepare.backendType;
  if (!fresh
      || fresh.status !== 'active'
      || freshTaskId !== prepared.taskId
      || !freshOwnerMatches) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: `fresh_lineage_verification_failed:status=${fresh?.status ?? 'missing'},`
        + `task=${freshTaskId ?? 'none'},expected=${prepared.taskId ?? 'none'},`
        + `owner=${JSON.stringify(freshOwner)},`
        + `expectedOwner=${JSON.stringify(prepared.durableOwnerAtPrepare)}`,
      rollbackDisposition: 'retain_fence',
    };
  }
  ds.session.riffParentTaskId = prepared.taskId ?? undefined;
  prepared.lineageVerified = true;

  if (!isPreparedRiffSessionCurrent(ds, prepared)) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: 'shutdown_prepare_ownership_lost_after_persist',
      rollbackDisposition: 'retain_fence',
    };
  }
  return { ok: true };
}

export function isPreparedRiffSessionCurrent(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
): boolean {
  if (ds.riffShutdownState?.requestId !== prepared.requestId
      || ds.riffShutdownState.phase !== 'prepared') return false;
  if (prepared.worker) {
    return ds.worker === prepared.worker && !workerHasExited(prepared.worker);
  }
  return ds.worker === null;
}

/** After verified lineage persistence, an exact prepared worker that exited
 * and was cleared by worker-pool can be safely rolled back locally. A new
 * worker generation or a different fence remains ownership ambiguity. */
export function canAbortVerifiedExitedRiffPreparation(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
): boolean {
  return prepared.lineageVerified
    && !!prepared.worker
    && workerHasExited(prepared.worker)
    && ds.worker === null
    && ds.riffShutdownState?.requestId === prepared.requestId;
}

/** Roll back one prepared participant. State clears only after the exact worker
 * ACKs admission restoration; timeout/late ACK remains deliberately fail-closed. */
export async function abortPreparedRiffShutdown(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
  options: { abortTimeoutMs?: number } = {},
): Promise<ShutdownPhaseResult> {
  if (ds.riffShutdownState?.requestId !== prepared.requestId) {
    return { ok: false, taskId: prepared.taskId, error: 'shutdown_prepare_ownership_lost' };
  }
  if (!prepared.worker) {
    if (ds.worker) {
      return { ok: false, taskId: prepared.taskId, error: 'new_worker_generation' };
    }
    clearWorkerlessShutdownState(ds, prepared.requestId);
    return { ok: true, taskId: prepared.taskId };
  }
  if (workerHasExited(prepared.worker)) {
    return abortWorkerPreparation(
      ds,
      prepared.worker,
      prepared.requestId,
      options.abortTimeoutMs ?? RIFF_ADMISSION_RESTORE_TIMEOUT_MS,
      prepared.lineageVerified,
      { taskId: prepared.taskId },
    );
  }
  return abortWorkerPreparation(
    ds,
    prepared.worker,
    prepared.requestId,
    options.abortTimeoutMs ?? RIFF_ADMISSION_RESTORE_TIMEOUT_MS,
    prepared.lineageVerified,
    { taskId: prepared.taskId },
  );
}

async function abortPossiblyFencedRiffShutdown(
  ds: DaemonSession,
  participant: PossiblyFencedRiffShutdown,
  timeoutMs: number,
): Promise<ShutdownPhaseResult> {
  if (ds.riffShutdownState?.requestId !== participant.requestId) {
    return {
      ok: false,
      taskId: participant.taskId,
      error: 'shutdown_prepare_ownership_lost',
    };
  }
  return abortWorkerPreparation(
    ds,
    participant.worker,
    participant.requestId,
    timeoutMs,
    false,
    Object.prototype.hasOwnProperty.call(participant, 'expectedAbortTaskId')
      ? { taskId: participant.expectedAbortTaskId ?? null }
      : undefined,
  );
}

export type RiffFleetAbortEntry = {
  ds: DaemonSession;
  result: FencedRiffShutdownParticipant;
};

export type RiffFleetAbortResult = {
  ds: DaemonSession;
  participant: FencedRiffShutdownParticipant;
  result: ShutdownPhaseResult;
};

/** Restore every exact prepared/possibly-fenced generation concurrently. No
 * participant can consume another's timeout budget. */
export async function abortRiffShutdownFleet(
  entries: readonly RiffFleetAbortEntry[],
  options: {
    abortTimeoutMs?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<RiffFleetAbortResult[]> {
  const now = options.now ?? Date.now;
  const configuredTimeout = options.abortTimeoutMs ?? RIFF_ADMISSION_RESTORE_TIMEOUT_MS;
  const remaining = options.deadlineMs === undefined
    ? configuredTimeout
    : Math.max(0, options.deadlineMs - now());
  const timeoutMs = Math.min(configuredTimeout, remaining);

  return Promise.all(entries.map(async ({ ds, result: participant }) => {
    if (timeoutMs <= 0) {
      return {
        ds,
        participant,
        result: {
          ok: false,
          taskId: participant.taskId,
          error: 'shutdown_deadline_elapsed_before_abort',
        },
      };
    }
    const result = participant.ok
      ? await abortPreparedRiffShutdown(ds, participant, { abortTimeoutMs: timeoutMs })
      : await abortPossiblyFencedRiffShutdown(ds, participant, timeoutMs);
    return { ds, participant, result };
  }));
}

/** Phase 3: synchronous, infallible-after-validation commit. The coordinator
 * validates every participant first, then calls this without an intervening
 * await, so one session can never refuse after a peer was detached. */
export function commitPreparedRiffShutdown(
  ds: DaemonSession,
  prepared: PreparedRiffShutdown,
): boolean {
  if (!isPreparedRiffSessionCurrent(ds, prepared)) return false;
  if (!prepared.worker) {
    clearWorkerlessShutdownState(ds, prepared.requestId);
    return true;
  }
  if (!send(prepared.worker, { type: 'riff_shutdown_commit', requestId: prepared.requestId })) {
    // Lineage is already durably fresh-verified. Direct retirement is safe even
    // if the final IPC channel closed between validation and send.
    try { prepared.worker.kill('SIGTERM'); } catch { /* already exited */ }
  }
  clearWorkerOwnership(ds, prepared.worker);
  return true;
}

/** Single-session compatibility wrapper. Daemon shutdown intentionally uses
 * the explicit three-phase API above so a multi-Riff fleet cannot half-commit. */
export async function detachRiffWorkerForShutdown(
  ds: DaemonSession,
  options: { drainTimeoutMs?: number; abortTimeoutMs?: number } = {},
): Promise<RiffShutdownDetachOutcome> {
  const prepared = await prepareRiffSessionForShutdown(ds, options);
  if (!prepared.ok) {
    if (prepared.fence === 'none') return prepared;
    const [aborted] = await abortRiffShutdownFleet([{ ds, result: prepared }], options);
    const abortSuffix = aborted.result.ok
      ? ''
      : `;admission_restore_failed:${aborted.result.error ?? 'unknown'}`;
    logger.error(
      `[${label(ds)}] Riff shutdown drain failed (${prepared.error}${abortSuffix}); `
      + (aborted.result.ok
        ? 'worker retained with admission restored'
        : 'worker retained and admission fence kept fail-closed'),
    );
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: prepared.error + abortSuffix,
    };
  }
  const persisted = persistPreparedRiffShutdown(ds, prepared);
  if (!persisted.ok) {
    if (persisted.rollbackDisposition === 'retain_fence') return persisted;
    const aborted = await abortPreparedRiffShutdown(ds, prepared, options);
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: persisted.error
        + (aborted.ok ? '' : `;admission_restore_failed:${aborted.error ?? 'unknown'}`),
    };
  }
  if (!commitPreparedRiffShutdown(ds, prepared)) {
    return {
      ok: false,
      requestId: prepared.requestId,
      taskId: prepared.taskId,
      error: 'shutdown_prepare_ownership_lost_before_commit',
      rollbackDisposition: 'retain_fence',
    };
  }
  logger.info(
    `[${label(ds)}] Riff shutdown detach committed after durable lineage `
    + `${prepared.taskId ?? 'none'}`,
  );
  return {
    ok: true,
    requestId: prepared.requestId,
    taskId: prepared.taskId,
    disposition: 'lineage_persisted',
    ...(prepared.worker ? { worker: prepared.worker } : {}),
  };
}
