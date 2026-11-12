import type { BackendType, PersistentBackendTarget } from '../adapters/backend/types.js';
import type { RiffBackendConfig } from '../adapters/backend/riff-backend.js';
import { cancelRiffTaskById, queryRiffThreadTasks } from '../adapters/backend/riff-backend.js';
import {
  isSuspendableBackendType,
  killPersistentBackendTarget,
  killPersistentSession,
  persistentSessionName,
  probePersistentBackendTarget,
  probePersistentSession,
} from './persistent-backend.js';

export type ExplicitSessionBackingCleanupResult =
  | { ok: true; kind: 'skipped_adopted' | 'no_backing' }
  | { ok: true; kind: 'destroyed_persistent'; backendType: 'tmux' | 'herdr' | 'zellij' | 'zmx'; name: string }
  | { ok: true; kind: 'cancelled_riff'; taskId: string }
  | {
      ok: false;
      kind: 'persistent_destroy_failed' | 'riff_config_missing' | 'riff_cancel_failed';
      backendType: BackendType;
      taskId?: string;
      error?: string;
    };

export interface ExplicitSessionBackingCleanupInput {
  sessionId: string;
  backendType?: BackendType;
  riffParentTaskId?: string;
  /** Adopted panes/agents are user-owned. Explicit Botmux close only detaches
   * its logical row and must never destroy the observed backing resource. */
  adopted?: boolean;
  /** Current authoritative config for the row's bot. Required only when the
   * row is frozen to Riff and still carries a remote task id. */
  riffConfig?: RiffBackendConfig;
  /** The row's frozen backing target. A tmux session may live on the
   * dedicated socket (`socketName`), which a name-only kill/probe on the
   * default server would miss — and then report a live pane as destroyed. */
  persistentBackendTarget?: PersistentBackendTarget;
}

export interface ExplicitSessionBackingCleanupDeps {
  cancelRiffTask?: typeof cancelRiffTaskById;
  killPersistent?: typeof killPersistentSession;
  probePersistent?: typeof probePersistentSession;
  killTarget?: typeof killPersistentBackendTarget;
  probeTarget?: typeof probePersistentBackendTarget;
}

/**
 * Destroy the Botmux-owned backing resource before an offline/worker-less
 * explicit close is published.
 *
 * This helper never mutates the session record. In particular, callers may
 * erase `riffParentTaskId` only after `kind === 'cancelled_riff'`; a failed or
 * unconfigurable cancellation therefore retains the durable retry handle.
 */
export async function cleanupExplicitSessionBacking(
  input: ExplicitSessionBackingCleanupInput,
  deps: ExplicitSessionBackingCleanupDeps = {},
): Promise<ExplicitSessionBackingCleanupResult> {
  if (input.adopted) return { ok: true, kind: 'skipped_adopted' };

  if (input.backendType === 'riff') {
    const taskId = input.riffParentTaskId;
    if (!taskId) return { ok: true, kind: 'no_backing' };
    if (!input.riffConfig?.baseUrl) {
      return { ok: false, kind: 'riff_config_missing', backendType: 'riff', taskId };
    }
    const cancel = deps.cancelRiffTask ?? cancelRiffTaskById;
    try {
      const cancelled = await cancel(input.riffConfig, taskId);
      return cancelled
        ? { ok: true, kind: 'cancelled_riff', taskId }
        : { ok: false, kind: 'riff_cancel_failed', backendType: 'riff', taskId };
    } catch (err) {
      return {
        ok: false,
        kind: 'riff_cancel_failed',
        backendType: 'riff',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!isSuspendableBackendType(input.backendType)) {
    // Explicit pty and legacy unstamped rows have no deterministic persistent
    // backing session to destroy. Never guess that an unstamped row was tmux.
    return { ok: true, kind: 'no_backing' };
  }

  // No production caller reaches this persistent branch today: the only one,
  // prepareRiffExplicitClose (worker-pool.ts), returns early for non-Riff rows
  // and Riff rows return above. It still addresses the frozen target, so a
  // future caller cannot silently probe the default tmux server for a pane
  // that lives on the dedicated socket.
  const target = input.persistentBackendTarget?.backendType === input.backendType
    ? input.persistentBackendTarget
    : undefined;
  const name = target?.sessionName ?? persistentSessionName(input.backendType, input.sessionId);
  const kill = deps.killPersistent ?? killPersistentSession;
  const probe = deps.probePersistent ?? probePersistentSession;
  try {
    let after;
    if (target) {
      (deps.killTarget ?? killPersistentBackendTarget)(target, input.sessionId);
      after = (deps.probeTarget ?? probePersistentBackendTarget)(target);
    } else {
      // ZMX destruction is identity-verified and refuses a name-only kill. Keep
      // the established two-argument contract for the other backends.
      if (input.backendType === 'zmx') kill(input.backendType, name, input.sessionId);
      else kill(input.backendType, name);
      // Backend kill helpers are intentionally idempotent and historically
      // swallow command errors. Offline explicit abandon needs a stronger
      // contract: only publish closed after a post-kill probe confirms absence.
      after = probe(input.backendType, name);
    }
    if (after !== 'missing') {
      return {
        ok: false,
        kind: 'persistent_destroy_failed',
        backendType: input.backendType,
        error: after === 'exists' ? 'backing_session_still_exists' : 'backing_session_state_unknown',
      };
    }
    return { ok: true, kind: 'destroyed_persistent', backendType: input.backendType, name };
  } catch (err) {
    return {
      ok: false,
      kind: 'persistent_destroy_failed',
      backendType: input.backendType,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type RiffThreadStopProof =
  | { ok: true; cancelledTaskIds: string[] }
  | {
      ok: false;
      kind:
        | 'riff_config_missing'
        | 'riff_thread_query_failed'
        | 'riff_thread_listing_incomplete'
        | 'riff_thread_quiet_period_pending'
        | 'riff_cancel_failed'
        | 'riff_thread_still_running';
      taskId?: string;
      error?: string;
    };

export interface RiffThreadStopDeps {
  queryThread?: typeof queryRiffThreadTasks;
  cancelRiffTask?: typeof cancelRiffTaskById;
  sleep?: (ms: number) => Promise<void>;
  /** Thread listings, including the first. At least 1. */
  attempts?: number;
  /** Wait between cancelling and listing again, for the cancel to land. */
  settleDelayMs?: number;
  /** A clean listing counts only once this much time has passed since the
   *  worker was gone (see `quietSinceMs`). */
  quietPeriodMs?: number;
  now?: () => number;
}

/**
 * How long a create/follow-up that a now-dead worker had already sent can still
 * be accepted by Riff and only then show up in the thread: the longest Riff
 * request budget (cold follow-up, 60s), plus slack for server-side lag. A
 * listing taken before this has passed since the worker died may simply be
 * too early to see that task.
 */
export const RIFF_ORPHAN_REQUEST_QUIET_MS = 75_000;

/**
 * Prove that nothing in a Riff thread is still running, cancelling whatever is.
 *
 * For the case where the worker that tracked the thread's in-flight requests
 * is gone (crashed or retired mid-close): its last create/follow-up may have
 * produced a task the session never recorded, so cancelling the persisted
 * lineage alone proves nothing about it. Every task in the thread is listed,
 * every non-terminal one cancelled (task-cancel is idempotent), and the thread
 * listed again until all are terminal. Proof requires a successful listing in
 * which every task is terminal; a failed listing, a failed cancel, or a task
 * still running after the last attempt is not proof.
 *
 * The listing is owner-scoped: asked under the wrong identity it answers with
 * an empty list, which reads exactly like "nothing running". So every task the
 * caller already knows belongs to this thread (`knownTaskIds`) must appear in
 * it, or the listing does not count.
 *
 * A request the dead worker had already sent may still create its task after
 * the worker is gone, so a clean listing is accepted only once
 * `quietPeriodMs` has passed since `quietSinceMs` (when the worker was last
 * known to be gone). Waiting longer than `maxWaitMs` for that is refused
 * instead (`riff_thread_quiet_period_pending`): the caller retries later.
 */
export async function proveRiffThreadStopped(
  input: {
    threadId: string;
    riffConfig?: RiffBackendConfig;
    knownTaskIds?: string[];
    quietSinceMs?: number;
    maxWaitMs?: number;
  },
  deps: RiffThreadStopDeps = {},
): Promise<RiffThreadStopProof> {
  const riffConfig = input.riffConfig;
  if (!riffConfig?.baseUrl) return { ok: false, kind: 'riff_config_missing' };
  const query = deps.queryThread ?? queryRiffThreadTasks;
  const cancel = deps.cancelRiffTask ?? cancelRiffTaskById;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const attempts = Math.max(1, deps.attempts ?? 3);
  const settleDelayMs = deps.settleDelayMs ?? 1_500;
  const now = deps.now ?? Date.now;
  if (input.quietSinceMs !== undefined) {
    const remainingMs = input.quietSinceMs + (deps.quietPeriodMs ?? RIFF_ORPHAN_REQUEST_QUIET_MS) - now();
    if (remainingMs > (input.maxWaitMs ?? 0)) {
      return {
        ok: false,
        kind: 'riff_thread_quiet_period_pending',
        error: `a request the old worker sent may still create a task for ${Math.ceil(remainingMs / 1000)}s`,
      };
    }
    if (remainingMs > 0) await sleep(remainingMs);
  }
  const cancelled = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const listed = await query(riffConfig, input.threadId);
    if (!listed.ok) return { ok: false, kind: 'riff_thread_query_failed', error: listed.error };
    const missing = (input.knownTaskIds ?? []).find(id => !listed.tasks.some(task => task.id === id));
    if (missing) {
      return {
        ok: false,
        kind: 'riff_thread_listing_incomplete',
        taskId: missing,
        error: `known task ${missing} is not in the thread listing`,
      };
    }
    const running = listed.tasks.filter(task => !task.terminal);
    if (running.length === 0) return { ok: true, cancelledTaskIds: [...cancelled] };
    if (attempt >= attempts) {
      return {
        ok: false,
        kind: 'riff_thread_still_running',
        taskId: running[0]!.id,
        error: running.map(task => `${task.id}:${task.status ?? 'unknown'}`).join(','),
      };
    }
    for (const task of running) {
      let accepted = false;
      try { accepted = await cancel(riffConfig, task.id); } catch { accepted = false; }
      if (!accepted) return { ok: false, kind: 'riff_cancel_failed', taskId: task.id };
      cancelled.add(task.id);
    }
    await sleep(settleDelayMs);
  }
}
