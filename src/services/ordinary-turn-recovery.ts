export const ORDINARY_TURN_RECOVERY_PROMPT = [
  '[BOTMUX_RECOVERY]',
  '上一执行因暂态 provider 故障中止。请读取当前会话和工作区状态，从最后一个可验证 checkpoint 继续原任务；',
  '不要重复已经完成的外部副作用。完成后按原任务的交付协议回复；若无法安全判断 checkpoint，请停止并明确请求人工决策。',
].join('\n');

export type OrdinaryTurnRecoveryStatus =
  | 'running'
  | 'backoff'
  | 'dispatching'
  | 'completed'
  | 'cancelled'
  | 'exhausted'
  | 'attention_required';

export interface OrdinaryTurnRecoveryState {
  logicalTurnId: string;
  currentTurnId: string;
  continuationsStarted: number;
  status: OrdinaryTurnRecoveryStatus;
  nextAttemptAt?: number;
  lastErrorCode?: string;
  alertSentAt?: number;
  /** True once the one user-visible warning has been scheduled. */
  warningDispatched?: boolean;
  cancelledByTurnId?: string;
  /** Type-ahead successors admitted while the owner was still running, in
   *  admission order. Claude runs them after the owner, so ownership moves to
   *  the head of this list when the owner completes; a terminal for one of them
   *  while the owner is still `running` means the owner's terminal was lost and
   *  the successor is adopted on the spot. Absent when empty. */
  queuedLogicalTurnIds?: string[];
  /** Logical turns (owner or queued successor) whose fire was a silent
   *  scheduled run. Frozen at admission from the daemon's runtime silent
   *  registry and persisted here, because that registry does not survive a
   *  daemon restart while a backoff timer or a delivered continuation does:
   *  every continuation of such a turn must stay silent, and restore re-arms
   *  the registry from this list before re-arming the timer. Pruned to the live
   *  owner + queue on every commit; absent when empty (pre-upgrade archives have
   *  no field and are read as loud, the pre-existing semantics). */
  silentLogicalTurnIds?: string[];
}

/** The slot is held by the original logical turn itself, still running — no
 *  continuation has been dispatched for it. Only then may a queued successor's
 *  terminal mean "the owner's terminal was lost" and be adopted. */
function ownerAwaitingOwnTerminal(state: OrdinaryTurnRecoveryState): boolean {
  return state.status === 'running' && state.currentTurnId === state.logicalTurnId;
}

/** Bound on remembered type-ahead successors; older ones are forgotten first. */
const MAX_QUEUED_LOGICAL_TURNS = 32;

function withQueuedLogicalTurnIds(
  state: OrdinaryTurnRecoveryState,
  queued: readonly string[],
): OrdinaryTurnRecoveryState {
  const { queuedLogicalTurnIds: _dropped, ...rest } = state;
  return queued.length > 0 ? { ...rest, queuedLogicalTurnIds: [...queued] } : rest;
}

export interface OrdinaryTurnRecoveryTerminal {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
  retryable?: boolean;
}

export interface OrdinaryTurnRecoveryDispatch {
  logicalTurnId: string;
  turnId: string;
  prompt: string;
  continuation: number;
  /** The logical turn was a silent scheduled fire: the continuation must be
   *  armed silent too. Read from the persisted state, never from runtime. */
  silent: boolean;
}

export interface OrdinaryTurnBeginOptions {
  /** Freeze "this fire is silent" onto the logical turn at admission. */
  silent?: boolean;
}

function isSilentLogicalTurn(state: OrdinaryTurnRecoveryState, logicalTurnId: string): boolean {
  return (state.silentLogicalTurnIds ?? []).includes(logicalTurnId);
}

/** Keep silent marks only for turns the state still tracks (owner + queue).
 *  Applied at commit time, i.e. after a promotion/adoption has already chosen
 *  the new owner, so the promoted turn's own mark is never dropped early. */
function pruneSilentLogicalTurnIds(state: OrdinaryTurnRecoveryState): OrdinaryTurnRecoveryState {
  const { silentLogicalTurnIds, ...rest } = state;
  if (!silentLogicalTurnIds) return rest;
  const live = new Set([state.logicalTurnId, ...(state.queuedLogicalTurnIds ?? [])]);
  const kept = silentLogicalTurnIds.filter((id, index, all) => live.has(id) && all.indexOf(id) === index);
  return kept.length > 0 ? { ...rest, silentLogicalTurnIds: kept } : rest;
}

/** Turn ids a daemon restore must re-arm in its runtime silent registry before
 *  re-arming the recovery timer: every silent logical turn still tracked, plus
 *  the delivered continuation of a silent owner (its id differs from the
 *  logical id). Settled states are included on purpose: the registry keeps a
 *  mark past turn_terminal so late idle/final events stay hushed, and a restart
 *  right after a silent continuation settled must not turn those late events
 *  loud. Marks are turn-exact and TTL/size bounded, so re-arming a finished id
 *  can never hush another turn. */
export function ordinaryTurnRecoverySilentTurnIds(
  state: OrdinaryTurnRecoveryState | undefined,
): string[] {
  if (!state) return [];
  const ids = [...(state.silentLogicalTurnIds ?? [])];
  if (isSilentLogicalTurn(state, state.logicalTurnId) && state.currentTurnId !== state.logicalTurnId) {
    ids.push(state.currentTurnId);
  }
  return ids;
}

export interface OrdinaryTurnRecoveryDeps<TTimer = unknown> {
  schedule: (delayMs: number, run: () => void) => TTimer;
  cancel: (timer: TTimer) => void;
  persist: (state: OrdinaryTurnRecoveryState) => void;
  enqueue: (dispatch: OrdinaryTurnRecoveryDispatch) => boolean;
  warn: (state: OrdinaryTurnRecoveryState) => void;
  /** Identity for the next continuation of `logicalTurnId`. Return undefined
   *  to keep the default `bmx-recovery-<random>` id. The daemon uses this to
   *  keep a scheduled turn's `schedule:<taskId>:<uuid>` provenance on its
   *  continuation, so the continuation authenticates exactly like the fire. */
  mintContinuationTurnId?: (logicalTurnId: string, continuation: number) => string | undefined;
  now?: () => number;
  randomId?: () => string;
  backoffMs?: readonly number[];
}

export interface OrdinaryTurnRecoverySession {
  sessionId: string;
  ordinaryTurnRecovery?: OrdinaryTurnRecoveryState;
  turnReplyContexts?: Record<string, unknown>;
  replyTargets?: Record<string, unknown>;
}

type AttachedRecovery = {
  session: OrdinaryTurnRecoverySession;
  coordinator: OrdinaryTurnRecoveryCoordinator<any>;
  dispose: () => void;
};

const attachedRecoveries = new Map<string, AttachedRecovery>();

/** Purely orchestrates one ordinary logical turn. Session eligibility and
 * durable state ownership remain with the daemon/worker-pool integration. */
export class OrdinaryTurnRecoveryCoordinator<TTimer = unknown> {
  private state: OrdinaryTurnRecoveryState | undefined;
  private timer: TTimer | undefined;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly backoffMs: readonly number[];

  constructor(private readonly deps: OrdinaryTurnRecoveryDeps<TTimer>) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => Math.random().toString(36).slice(2));
    this.backoffMs = deps.backoffMs ?? [2_000, 8_000];
  }

  restore(state: OrdinaryTurnRecoveryState): void {
    this.cancelTimer();
    this.state = { ...state };
    if (this.state.status === 'backoff') this.armBackoff();
  }

  begin(logicalTurnId: string, opts: OrdinaryTurnBeginOptions = {}): OrdinaryTurnRecoveryState {
    // Claude can accept type-ahead while the preceding turn is still running.
    // A session-level slot must keep owning that earlier terminal instead of
    // being overwritten by the queued successor; otherwise the earlier failed
    // terminal has no recovery consumer. Once the current turn has actually
    // entered backoff (or reached a terminal state), a fresh admitted user turn
    // may replace it as before.
    if (this.state?.status === 'running' || this.state?.status === 'dispatching') {
      // Remember the successor without disturbing the live owner. A persist
      // failure here degrades to the old behaviour (successor not tracked).
      const live = this.state;
      const queued = live.queuedLogicalTurnIds ?? [];
      if (logicalTurnId === live.currentTurnId || logicalTurnId === live.logicalTurnId
        || queued.includes(logicalTurnId)) return live;
      try {
        const withQueue = withQueuedLogicalTurnIds(
          live,
          [...queued, logicalTurnId].slice(-MAX_QUEUED_LOGICAL_TURNS),
        );
        return this.commit(opts.silent
          ? { ...withQueue, silentLogicalTurnIds: [...(withQueue.silentLogicalTurnIds ?? []), logicalTurnId] }
          : withQueue);
      } catch {
        return live;
      }
    }
    const wasBackoff = this.state?.status === 'backoff';
    this.cancelTimer();
    try {
      return this.commit({
        logicalTurnId,
        currentTurnId: logicalTurnId,
        continuationsStarted: 0,
        status: 'running',
        ...(opts.silent ? { silentLogicalTurnIds: [logicalTurnId] } : {}),
      });
    } catch (err) {
      if (wasBackoff) this.armBackoff();
      throw err;
    }
  }

  onTerminal(
    current: OrdinaryTurnRecoveryState,
    terminal: OrdinaryTurnRecoveryTerminal,
  ): OrdinaryTurnRecoveryState {
    if (terminal.turnId !== current.currentTurnId) {
      const queued = current.queuedLogicalTurnIds ?? [];
      if (!queued.includes(terminal.turnId)) return current;
      const remaining = withQueuedLogicalTurnIds(current, queued.filter(id => id !== terminal.turnId));
      // The owner's own recovery is in flight (backoff timer, dispatching, or
      // an already-delivered continuation that is still running) or the owner
      // already settled: the successor ran on its own and is simply forgotten
      // here — the delivered continuation keeps the slot.
      if (!ownerAwaitingOwnTerminal(current)) return this.commit(remaining);
      // The owner never reported a terminal (lost/missed) yet its successor
      // did: the successor is the live turn now, and its terminal is handled
      // exactly as an owner terminal would be.
      const adopted = this.commit({
        ...remaining,
        logicalTurnId: terminal.turnId,
        currentTurnId: terminal.turnId,
        continuationsStarted: 0,
        status: 'running',
        nextAttemptAt: undefined,
        lastErrorCode: undefined,
        alertSentAt: undefined,
        warningDispatched: undefined,
      });
      return this.onTerminal(adopted, terminal);
    }
    if (current.status !== 'running') return current;
    if (terminal.status === 'completed') {
      const [next, ...rest] = current.queuedLogicalTurnIds ?? [];
      if (next === undefined) return this.commit({ ...current, status: 'completed' });
      // Hand the slot to the type-ahead successor Claude is about to run, so
      // its failure has a recovery consumer instead of only the fallback card.
      // The silent marks ride along; commit prunes them to the new owner + queue.
      return this.commit(withQueuedLogicalTurnIds({
        logicalTurnId: next,
        currentTurnId: next,
        continuationsStarted: 0,
        status: 'running',
        ...(current.silentLogicalTurnIds ? { silentLogicalTurnIds: current.silentLogicalTurnIds } : {}),
      }, rest));
    }
    if (terminal.errorCode === 'provider_rate_limited') return current;
    if (terminal.status !== 'failed' || terminal.retryable !== true) {
      const next = {
        ...current,
        status: 'attention_required' as const,
        ...(terminal.errorCode ? { lastErrorCode: terminal.errorCode } : {}),
      };
      this.warnOnce(next);
      return next;
    }
    if (current.continuationsStarted >= this.backoffMs.length) {
      const exhausted = {
        ...current,
        status: 'exhausted' as const,
        lastErrorCode: terminal.errorCode,
      };
      this.warnOnce(exhausted);
      return exhausted;
    }
    const delayMs = this.backoffMs[current.continuationsStarted];
    const next = this.commit({
      ...current,
      status: 'backoff',
      nextAttemptAt: this.now() + delayMs,
      lastErrorCode: terminal.errorCode,
    });
    this.armBackoff();
    return next;
  }

  requireAttention(
    current: OrdinaryTurnRecoveryState,
    errorCode: string,
  ): OrdinaryTurnRecoveryState {
    if (current.status === 'completed'
      || current.status === 'cancelled'
      || current.status === 'exhausted'
      || current.status === 'attention_required') {
      if (current.warningDispatched !== true) this.warnOnce(current);
      return this.state ?? current;
    }
    this.cancelTimer();
    const next = {
      ...current,
      status: 'attention_required' as const,
      nextAttemptAt: undefined,
      lastErrorCode: errorCode,
    };
    this.warnOnce(next);
    return this.state ?? next;
  }

  cancelForUserInput(turnId: string): OrdinaryTurnRecoveryState {
    const current = this.state;
    if (!current) {
      return {
        logicalTurnId: turnId,
        currentTurnId: turnId,
        continuationsStarted: 0,
        status: 'cancelled',
        cancelledByTurnId: turnId,
      };
    }
    const wasBackoff = current.status === 'backoff';
    this.cancelTimer();
    try {
      return this.commit({
        ...current,
        status: 'cancelled',
        nextAttemptAt: undefined,
        cancelledByTurnId: turnId,
      });
    } catch (err) {
      if (wasBackoff) this.armBackoff();
      throw err;
    }
  }

  private armBackoff(): void {
    const current = this.state;
    if (!current || current.status !== 'backoff') return;
    this.cancelTimer();
    const delayMs = Math.max(0, (current.nextAttemptAt ?? this.now()) - this.now());
    this.timer = this.deps.schedule(delayMs, () => {
      this.timer = undefined;
      const live = this.state;
      if (!live || live.status !== 'backoff') return;
      const continuation = live.continuationsStarted + 1;
      const turnId = this.deps.mintContinuationTurnId?.(live.logicalTurnId, continuation)
        ?? `bmx-recovery-${this.randomId()}`;
      // Persist the exact synthetic turn before handing it to IPC. If the
      // daemon crashes after this write, restore fails closed instead of
      // replaying a continuation whose external effects may already have
      // started. A successful enqueue advances the same identity to running.
      const dispatching = this.commit({
        ...live,
        currentTurnId: turnId,
        continuationsStarted: continuation,
        status: 'dispatching',
        nextAttemptAt: undefined,
      });
      let enqueued = false;
      try {
        enqueued = this.deps.enqueue({
          logicalTurnId: dispatching.logicalTurnId,
          turnId,
          prompt: ORDINARY_TURN_RECOVERY_PROMPT,
          continuation,
          silent: isSilentLogicalTurn(dispatching, dispatching.logicalTurnId),
        });
      } catch {
        enqueued = false;
      }
      if (!enqueued) {
        const failed = this.commit({
          ...dispatching,
          status: 'attention_required',
          nextAttemptAt: undefined,
          lastErrorCode: 'recovery_enqueue_failed',
        });
        this.warnOnce(failed);
        return;
      }
      this.commit({
        ...dispatching,
        status: 'running',
      });
    });
  }

  private warnOnce(state: OrdinaryTurnRecoveryState): void {
    const prior = this.state;
    const alerted = this.commit({
      ...state,
      alertSentAt: state.alertSentAt ?? prior?.alertSentAt ?? this.now(),
      warningDispatched: true,
    });
    if (prior?.warningDispatched || state.warningDispatched) return;
    this.deps.warn(alerted);
  }

  private commit(state: OrdinaryTurnRecoveryState): OrdinaryTurnRecoveryState {
    const prior = this.state;
    const next = pruneSilentLogicalTurnIds({ ...state });
    this.state = next;
    try {
      this.deps.persist(next);
    } catch (err) {
      this.state = prior;
      throw err;
    }
    return next;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancelTimer();
  }
}

/** Bind the pure coordinator to one persisted Session. This registry is only a
 * runtime timer owner; the state itself remains in `session.ordinaryTurnRecovery`
 * and is re-armed from there after daemon restore. */
export function attachOrdinaryTurnRecovery<TTimer>(
  session: OrdinaryTurnRecoverySession,
  deps: OrdinaryTurnRecoveryDeps<TTimer>,
): void {
  if (attachedRecoveries.get(session.sessionId)?.session === session) return;
  disposeOrdinaryTurnRecovery(session);
  let coordinator!: OrdinaryTurnRecoveryCoordinator<TTimer>;
  const wrapped: OrdinaryTurnRecoveryDeps<TTimer> = {
    ...deps,
    persist: state => {
      const prior = session.ordinaryTurnRecovery;
      session.ordinaryTurnRecovery = structuredClone(state);
      try {
        deps.persist(state);
      } catch (err) {
        session.ordinaryTurnRecovery = prior;
        throw err;
      }
    },
    enqueue: dispatch => {
      let contextCopied = false;
      const sourceContext = session.turnReplyContexts?.[dispatch.logicalTurnId];
      if (sourceContext !== undefined) {
        session.turnReplyContexts = {
          ...(session.turnReplyContexts ?? {}),
          [dispatch.turnId]: structuredClone(sourceContext),
        };
        contextCopied = true;
      }
      const sourceTarget = session.replyTargets?.[dispatch.logicalTurnId];
      if (sourceTarget !== undefined) {
        session.replyTargets = {
          ...(session.replyTargets ?? {}),
          [dispatch.turnId]: structuredClone(sourceTarget),
        };
        contextCopied = true;
      }
      // `botmux send` runs in the CLI child and reads this routing context from
      // the session store. Land the inherited destination before IPC can make
      // the continuation executable.
      if (contextCopied && session.ordinaryTurnRecovery) {
        deps.persist(session.ordinaryTurnRecovery);
      }
      return deps.enqueue(dispatch);
    },
  };
  coordinator = new OrdinaryTurnRecoveryCoordinator(wrapped);
  attachedRecoveries.set(session.sessionId, {
    session,
    coordinator,
    dispose: () => coordinator.dispose(),
  });
  if (session.ordinaryTurnRecovery) {
    if (session.ordinaryTurnRecovery.status === 'dispatching') {
      const wasAlreadyDispatched = session.ordinaryTurnRecovery.warningDispatched === true;
      const interrupted = {
        ...session.ordinaryTurnRecovery,
        status: 'attention_required' as const,
        lastErrorCode: 'recovery_dispatch_interrupted',
        alertSentAt: session.ordinaryTurnRecovery.alertSentAt ?? Date.now(),
        warningDispatched: true,
      };
      session.ordinaryTurnRecovery = interrupted;
      deps.persist(interrupted);
      if (!wasAlreadyDispatched) deps.warn(interrupted);
      coordinator.restore(interrupted);
    } else {
      coordinator.restore(session.ordinaryTurnRecovery);
      if ((session.ordinaryTurnRecovery.status === 'exhausted'
        || session.ordinaryTurnRecovery.status === 'attention_required')
        && session.ordinaryTurnRecovery.warningDispatched !== true) {
        coordinator.requireAttention(
          session.ordinaryTurnRecovery,
          session.ordinaryTurnRecovery.lastErrorCode ?? 'recovery_attention_required',
        );
      }
    }
  }
}

export function handleOrdinaryTurnRecoveryTerminal(
  session: OrdinaryTurnRecoverySession,
  terminal: OrdinaryTurnRecoveryTerminal,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  const current = session.ordinaryTurnRecovery;
  if (!attached || !current) return current;
  return attached.coordinator.onTerminal(current, terminal);
}

/** Positive proof that this exact terminal currently has an attached recovery
 * consumer. Callers use it before suppressing any fallback notification. */
export function ordinaryTurnRecoveryHandlesTerminal(
  session: OrdinaryTurnRecoverySession,
  terminal: OrdinaryTurnRecoveryTerminal,
): boolean {
  const current = session.ordinaryTurnRecovery;
  if (attachedRecoveries.get(session.sessionId)?.session !== session || !current) return false;
  if (current.currentTurnId === terminal.turnId) return true;
  // A queued type-ahead successor is adopted by onTerminal only while the
  // original owner itself is still running (no continuation dispatched); in any
  // other state its terminal is merely forgotten and the fallback notice must
  // stay in charge.
  return ownerAwaitingOwnTerminal(current)
    && (current.queuedLogicalTurnIds ?? []).includes(terminal.turnId);
}

export function beginOrdinaryTurnRecovery(
  session: OrdinaryTurnRecoverySession,
  logicalTurnId: string,
  opts: OrdinaryTurnBeginOptions = {},
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached) return session.ordinaryTurnRecovery;
  // The persisted session projection is authoritative. Re-sync before intake
  // so restore/reconciliation (or a prior transactional rollback) cannot leave
  // the runtime coordinator making an admission decision from stale state.
  if (session.ordinaryTurnRecovery) {
    attached.coordinator.restore(session.ordinaryTurnRecovery);
  }
  return attached.coordinator.begin(logicalTurnId, opts);
}

export function cancelOrdinaryTurnRecoveryForUserInput(
  session: OrdinaryTurnRecoverySession,
  turnId: string,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached || !session.ordinaryTurnRecovery
    || !['backoff', 'exhausted', 'attention_required']
      .includes(session.ordinaryTurnRecovery.status)) return session.ordinaryTurnRecovery;
  return attached.coordinator.cancelForUserInput(turnId);
}

export function requireOrdinaryTurnRecoveryAttention(
  session: OrdinaryTurnRecoverySession,
  turnId: string,
  errorCode: string,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  const current = session.ordinaryTurnRecovery;
  if (!attached || !current || current.currentTurnId !== turnId) return current;
  return attached.coordinator.requireAttention(current, errorCode);
}

export function disposeOrdinaryTurnRecovery(
  session: Pick<OrdinaryTurnRecoverySession, 'sessionId'>,
): void {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached) return;
  attached.dispose();
  attachedRecoveries.delete(session.sessionId);
}
