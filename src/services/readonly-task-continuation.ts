export const READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE = 'codex_output_limit_exceeded';

export const READONLY_TASK_CONTINUATION_PROMPT = [
  '[BOTMUX_READONLY_CONTINUATION]',
  '这是同一个只读长程任务的受限自动续跑。请读取当前会话与工作区中的过程账本，从最后一个可验证检查点继续；',
  '保持只读，不执行任何写入、发布、重启、配置修改或其他外部副作用，也不要重复已经完成的查询。',
  '本轮最终输出必须是单个 JSON 对象且不要使用代码块：任务完成时输出 {"status":"completed","content":"给用户的最终结论"}；仍可继续时输出 {"status":"continue"}；需要用户输入时输出 {"status":"await_user","content":"要问用户的问题"}。',
  '不要调用 botmux send，不要用自然语言猜测或声明内部完成状态；daemon 只接受上述严格结构并负责最终投递。',
].join('\n');

export const READONLY_TASK_CONTINUATION_DEFAULT_TTL_MS = 60 * 60_000;
export const READONLY_TASK_CONTINUATION_MAX_TTL_MS = 4 * 60 * 60_000;
export const READONLY_TASK_CONTINUATION_DEFAULT_MAX = 6;
export const READONLY_TASK_CONTINUATION_HARD_MAX = 12;
export const READONLY_TASK_CONTINUATION_WARNING_RETRY_MS = 60_000;
/** Feishu UUID idempotency is guaranteed for one hour. Leave a five-minute
 * margin so a restored daemon never replays an uncertain delivery outside
 * that provider-side dedupe window. */
export const READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS = 55 * 60_000;

export type ReadonlyTaskContinuationStatus =
  | 'active'
  | 'backoff'
  | 'dispatching'
  | 'delivering'
  | 'completed'
  | 'awaiting_user'
  | 'cancelled'
  | 'expired'
  | 'exhausted'
  | 'failed';

export interface ReadonlyTaskContinuationState {
  leaseId: string;
  logicalTurnId: string;
  currentTurnId: string;
  currentDispatchAttempt?: number;
  currentWorkerGeneration?: number;
  createdAt: number;
  expiresAt: number;
  maxContinuations: number;
  continuationsStarted: number;
  status: ReadonlyTaskContinuationStatus;
  nextAttemptAt?: number;
  lastErrorCode?: string;
  completedMessageId?: string;
  pendingDelivery?: {
    kind: 'completed' | 'await_user';
    content: string;
    startedAt: number;
  };
  cancelledByTurnId?: string;
  pendingWarning?: {
    startedAt: number;
    deliveryAttempts: number;
    nextAttemptAt?: number;
  };
  warningDispatched?: boolean;
  warningMessageId?: string;
}

export interface ReadonlyTaskContinuationTerminal {
  turnId: string;
  dispatchAttempt?: number;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
  workerGeneration?: number;
}

export interface ReadonlyTaskContinuationDispatch {
  logicalTurnId: string;
  turnId: string;
  dispatchAttempt: number;
  prompt: string;
  continuation: number;
}

export interface ReadonlyTaskContinuationDeps<TTimer = unknown> {
  schedule: (delayMs: number, run: () => void) => TTimer;
  cancel: (timer: TTimer) => void;
  persist: (state: ReadonlyTaskContinuationState) => void;
  /** A restored lease may outlive its worker. Keep the durable backoff pending
   * until the exact worker/RPC proof is ready instead of consuming an attempt. */
  canEnqueue?: () => boolean;
  enqueue: (dispatch: ReadonlyTaskContinuationDispatch) => number | false;
  /** Deliver one already-persisted warning with a stable provider key. */
  warn: (state: ReadonlyTaskContinuationState) => void;
  /** Restore daemon-local attention independently from provider delivery. */
  attend?: (state: ReadonlyTaskContinuationState) => void;
  enabled: () => boolean;
  /** Re-send one already-persisted daemon-owned final with its stable UUID. */
  recoverDelivery?: (state: ReadonlyTaskContinuationState) => void;
  /** Keep a local fail-closed fence when the durable store is unavailable. */
  retain?: (state: ReadonlyTaskContinuationState) => void;
  now?: () => number;
  randomId?: () => string;
  delayMs?: number;
}

export interface ReadonlyTaskContinuationSession {
  sessionId: string;
  readonlyTaskContinuation?: ReadonlyTaskContinuationState;
  turnReplyContexts?: Record<string, unknown>;
  replyTargets?: Record<string, unknown>;
}

export interface StartReadonlyTaskContinuationInput {
  turnId: string;
  workerGeneration: number;
  ttlMs?: number;
  maxContinuations?: number;
}

type AttachedContinuation = {
  session: ReadonlyTaskContinuationSession;
  coordinator: ReadonlyTaskContinuationCoordinator<any>;
  dispose: () => void;
};

const attachedContinuations = new Map<string, AttachedContinuation>();

function isLiveStatus(status: ReadonlyTaskContinuationStatus): boolean {
  return status === 'active' || status === 'backoff' || status === 'dispatching'
    || status === 'delivering';
}

function isOpenStatus(status: ReadonlyTaskContinuationStatus): boolean {
  return isLiveStatus(status) || status === 'awaiting_user';
}

export type ReadonlyContinuationOutput =
  | { status: 'continue' }
  | { status: 'completed' | 'await_user'; content: string };

export function parseReadonlyContinuationOutput(text: string): ReadonlyContinuationOutput | undefined {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.status === 'continue') {
    return keys.length === 1 && keys[0] === 'status' ? { status: 'continue' } : undefined;
  }
  if (record.status !== 'completed' && record.status !== 'await_user') return undefined;
  if (keys.length !== 2 || keys[0] !== 'content' || keys[1] !== 'status') return undefined;
  if (typeof record.content !== 'string' || !record.content.trim()) return undefined;
  return { status: record.status, content: record.content.trim() };
}

export function readonlyTaskContinuationRecoversTerminal(
  state: ReadonlyTaskContinuationState | undefined,
  terminal: ReadonlyTaskContinuationTerminal,
): boolean {
  if (!state || state.status !== 'active'
    || terminal.turnId !== state.currentTurnId
    || terminal.dispatchAttempt !== state.currentDispatchAttempt
    || terminal.workerGeneration !== state.currentWorkerGeneration) return false;
  return terminal.status === 'completed'
    || (terminal.status === 'failed'
      && terminal.errorCode === READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE);
}

/** A deliberately narrow task lease. It never infers completion from prose:
 * only the daemon-validated strict JSON terminal can complete it. A normal CLI
 * terminal therefore means "continue" while the lease remains live. */
export class ReadonlyTaskContinuationCoordinator<TTimer = unknown> {
  private state: ReadonlyTaskContinuationState | undefined;
  private timer: TTimer | undefined;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly delayMs: number;

  constructor(private readonly deps: ReadonlyTaskContinuationDeps<TTimer>) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => Math.random().toString(36).slice(2));
    this.delayMs = deps.delayMs ?? 1_000;
  }

  restore(state: ReadonlyTaskContinuationState): void {
    this.cancelTimer();
    this.state = { ...state };
    if (this.state.pendingWarning && this.state.warningDispatched !== true) {
      this.publishAttention(this.state);
      if (!Number.isFinite(this.state.pendingWarning.startedAt)
        || this.now() - this.state.pendingWarning.startedAt >= READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS) {
        this.expireWarningDelivery(this.state);
        return;
      }
      if ((this.state.pendingWarning.nextAttemptAt ?? 0) > this.now()) this.armWarningRetry();
      else this.requestWarningDelivery({ ...this.state, pendingWarning: { ...this.state.pendingWarning } });
      return;
    }
    if (this.state.warningDispatched === true) this.publishAttention(this.state);
    if (!this.deps.enabled()) {
      if (isLiveStatus(this.state.status)) {
        this.commit({
          ...this.state,
          status: 'cancelled',
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_disabled',
        });
      }
      return;
    }
    if (this.state.status === 'dispatching') {
      this.warnOnce({
        ...this.state,
        status: 'failed',
        lastErrorCode: 'readonly_continuation_dispatch_interrupted',
      });
      return;
    }
    if (this.state.status === 'delivering') {
      const pending = this.state.pendingDelivery;
      if (!pending
        || !Number.isFinite(pending.startedAt)
        || this.now() - pending.startedAt >= READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS
        || !this.deps.recoverDelivery) {
        this.warnOnce({
          ...this.state,
          status: 'failed',
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_delivery_recovery_unavailable',
        });
        return;
      }
      try {
        this.deps.recoverDelivery({ ...this.state, pendingDelivery: { ...pending } });
      } catch {
        this.warnOnce({
          ...this.state,
          status: 'failed',
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_delivery_recovery_failed',
        });
      }
      return;
    }
    if (isLiveStatus(this.state.status) && this.now() >= this.state.expiresAt) {
      this.warnOnce({
        ...this.state,
        status: 'expired',
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_expired',
      });
      return;
    }
    if (this.state.status === 'backoff') this.armBackoff();
    else if (this.state.status === 'active') this.armExpiry();
  }

  start(input: StartReadonlyTaskContinuationInput): ReadonlyTaskContinuationState {
    if (!this.deps.enabled()) throw new Error('readonly_continuation_disabled');
    const current = this.state;
    if (current && (isLiveStatus(current.status)
      || (!!current.pendingWarning && current.warningDispatched !== true))) {
      if (current.currentTurnId === input.turnId && current.logicalTurnId === input.turnId) {
        return current;
      }
      throw new Error('readonly_continuation_already_active');
    }
    const ttlMs = Math.min(
      Math.max(1, input.ttlMs ?? READONLY_TASK_CONTINUATION_DEFAULT_TTL_MS),
      READONLY_TASK_CONTINUATION_MAX_TTL_MS,
    );
    const maxContinuations = Math.min(
      Math.max(1, input.maxContinuations ?? READONLY_TASK_CONTINUATION_DEFAULT_MAX),
      READONLY_TASK_CONTINUATION_HARD_MAX,
    );
    const createdAt = this.now();
    this.cancelTimer();
    const started = this.commit({
      leaseId: `readonly-${this.randomId()}`,
      logicalTurnId: input.turnId,
      currentTurnId: input.turnId,
      currentWorkerGeneration: input.workerGeneration,
      createdAt,
      expiresAt: createdAt + ttlMs,
      maxContinuations,
      continuationsStarted: 0,
      status: 'active',
    });
    this.armExpiry();
    return started;
  }

  onTerminal(
    current: ReadonlyTaskContinuationState,
    terminal: ReadonlyTaskContinuationTerminal,
  ): ReadonlyTaskContinuationState {
    if (terminal.turnId !== current.currentTurnId
      || terminal.dispatchAttempt !== current.currentDispatchAttempt
      || terminal.workerGeneration !== current.currentWorkerGeneration
      || current.status !== 'active') return current;
    if (!readonlyTaskContinuationRecoversTerminal(current, terminal)) {
      this.cancelTimer();
      const stopped = {
        ...current,
        status: (terminal.status === 'cancelled' ? 'cancelled' : 'failed') as 'cancelled' | 'failed',
        nextAttemptAt: undefined,
        ...(terminal.errorCode ? { lastErrorCode: terminal.errorCode } : {}),
      };
      try { return this.commit(stopped); } catch { this.retain(stopped); return stopped; }
    }
    return this.scheduleContinuation(current);
  }

  complete(
    turnId: string,
    dispatchAttempt: number | undefined,
    messageId: string,
    workerGeneration: number,
  ): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || !isLiveStatus(current.status)
      || current.currentTurnId !== turnId
      || current.currentDispatchAttempt !== dispatchAttempt
      || current.currentWorkerGeneration !== workerGeneration) return current;
    this.cancelTimer();
    const settled = {
      ...current,
      status: 'completed' as const,
      nextAttemptAt: undefined,
      completedMessageId: messageId,
      pendingDelivery: undefined,
    };
    try { return this.commit(settled); } catch { this.retain(settled); return settled; }
  }

  completeOriginalBusinessFinal(
    turnId: string,
    workerGeneration: number,
    messageId?: string,
  ): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || current.status !== 'active'
      || current.logicalTurnId !== turnId
      || current.currentTurnId !== turnId
      || current.currentDispatchAttempt !== undefined
      || current.currentWorkerGeneration !== workerGeneration) return current;
    this.cancelTimer();
    const settled = {
      ...current,
      status: 'completed' as const,
      nextAttemptAt: undefined,
      ...(messageId ? { completedMessageId: messageId } : {}),
    };
    try {
      return this.commit(settled);
    } catch (error) {
      this.retain({
        ...current,
        status: 'failed',
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_business_final_persist_failed',
      });
      throw error;
    }
  }

  beginDelivery(
    turnId: string,
    dispatchAttempt: number | undefined,
    workerGeneration: number,
    delivery: { kind: 'completed' | 'await_user'; content: string },
  ): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || (current.status !== 'active' && current.status !== 'backoff')
      || current.currentTurnId !== turnId
      || current.currentDispatchAttempt !== dispatchAttempt
      || current.currentWorkerGeneration !== workerGeneration) return current;
    this.cancelTimer();
    try {
      return this.commit({
        ...current,
        status: 'delivering',
        nextAttemptAt: undefined,
        pendingDelivery: { ...delivery, startedAt: this.now() },
      });
    } catch {
      return this.retainFailed(current, 'readonly_continuation_delivery_persist_failed');
    }
  }

  finishAwaitUser(
    turnId: string,
    dispatchAttempt: number | undefined,
    messageId: string,
    workerGeneration: number,
  ): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || current.status !== 'delivering'
      || current.currentTurnId !== turnId
      || current.currentDispatchAttempt !== dispatchAttempt
      || current.currentWorkerGeneration !== workerGeneration
      || current.pendingDelivery?.kind !== 'await_user') return current;
    const settled = {
      ...current,
      status: 'awaiting_user' as const,
      completedMessageId: messageId,
      pendingDelivery: undefined,
    };
    try { return this.commit(settled); } catch { this.retain(settled); return settled; }
  }

  completeWarning(leaseId: string, messageId: string): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || current.leaseId !== leaseId || !current.pendingWarning
      || current.warningDispatched === true) return current;
    const settled = {
      ...current,
      pendingWarning: undefined,
      warningDispatched: true,
      warningMessageId: messageId,
    };
    this.cancelTimer();
    try { return this.commit(settled); } catch { this.retain(settled); return settled; }
  }

  warningDeliveryFailed(leaseId: string): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || current.leaseId !== leaseId || !current.pendingWarning
      || current.warningDispatched === true) return current;
    const deadline = current.pendingWarning.startedAt
      + READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS;
    if (this.now() >= deadline) return this.expireWarningDelivery(current);
    const pending = {
      ...current,
      pendingWarning: {
        ...current.pendingWarning,
        deliveryAttempts: current.pendingWarning.deliveryAttempts + 1,
        nextAttemptAt: Math.min(this.now() + READONLY_TASK_CONTINUATION_WARNING_RETRY_MS, deadline),
      },
    };
    try { this.commit(pending); } catch { this.retain(pending); }
    this.armWarningRetry();
    return this.state;
  }

  failVisible(
    turnId: string,
    dispatchAttempt: number | undefined,
    workerGeneration: number,
    errorCode: string,
  ): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || !isLiveStatus(current.status)
      || current.currentTurnId !== turnId
      || current.currentDispatchAttempt !== dispatchAttempt
      || current.currentWorkerGeneration !== workerGeneration) return current;
    this.cancelTimer();
    this.warnOnce({ ...current, status: 'failed', lastErrorCode: errorCode });
    return this.state;
  }

  awaitUser(turnId: string): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || !isLiveStatus(current.status) || current.currentTurnId !== turnId) return current;
    this.cancelTimer();
    const settled = { ...current, status: 'awaiting_user' as const, nextAttemptAt: undefined };
    try { return this.commit(settled); } catch { this.retain(settled); return settled; }
  }

  cancelForUserInput(turnId: string): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || !isOpenStatus(current.status)) return current;
    this.cancelTimer();
    const cancelled = {
      ...current,
      status: 'cancelled' as const,
      nextAttemptAt: undefined,
      cancelledByTurnId: turnId,
    };
    try {
      return this.commit(cancelled);
    } catch (error) {
      this.retain({
        ...current,
        status: 'failed',
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_user_cancel_persist_failed',
      });
      throw error;
    }
  }

  cancelExplicit(turnId: string): ReadonlyTaskContinuationState | undefined {
    const current = this.state;
    if (!current || !isOpenStatus(current.status) || current.currentTurnId !== turnId) return current;
    this.cancelTimer();
    const cancelled = {
      ...current,
      status: 'cancelled' as const,
      nextAttemptAt: undefined,
      cancelledByTurnId: turnId,
    };
    try {
      return this.commit(cancelled);
    } catch (error) {
      this.retain({
        ...current,
        status: 'failed',
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_explicit_cancel_persist_failed',
      });
      throw error;
    }
  }

  private scheduleContinuation(
    current: ReadonlyTaskContinuationState,
  ): ReadonlyTaskContinuationState {
    if (!this.deps.enabled()) {
      const cancelled = {
        ...current,
        status: 'cancelled' as const,
        lastErrorCode: 'readonly_continuation_disabled',
      };
      try { return this.commit(cancelled); } catch { this.retain(cancelled); return cancelled; }
    }
    if (this.now() >= current.expiresAt) {
      const expired = {
        ...current,
        status: 'expired' as const,
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_expired',
      };
      this.warnOnce(expired);
      return this.state ?? expired;
    }
    if (current.continuationsStarted >= current.maxContinuations) {
      const exhausted = {
        ...current,
        status: 'exhausted' as const,
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_exhausted',
      };
      this.warnOnce(exhausted);
      return this.state ?? exhausted;
    }
    let next: ReadonlyTaskContinuationState;
    try {
      next = this.commit({
        ...current,
        status: 'backoff',
        nextAttemptAt: this.now() + this.delayMs,
      });
    } catch {
      return this.retainFailed(current, 'readonly_continuation_backoff_persist_failed');
    }
    this.armBackoff();
    return next;
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
      if (!this.deps.enabled()) {
        const cancelled = {
          ...live,
          status: 'cancelled' as const,
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_disabled',
        };
        try { this.commit(cancelled); } catch { this.retain(cancelled); }
        return;
      }
      if (this.now() >= live.expiresAt) {
        this.warnOnce({
          ...live,
          status: 'expired',
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_expired',
        });
        return;
      }
      if (this.deps.canEnqueue && !this.deps.canEnqueue()) {
        const waiting = {
          ...live,
          nextAttemptAt: Math.min(this.now() + this.delayMs, live.expiresAt),
        };
        try {
          this.commit(waiting);
          this.armBackoff();
        } catch {
          this.retainFailed(live, 'readonly_continuation_readiness_persist_failed');
        }
        return;
      }
      const continuation = live.continuationsStarted + 1;
      const turnId = `bmx-readonly-${this.randomId()}`;
      let dispatching: ReadonlyTaskContinuationState;
      try {
        dispatching = this.commit({
          ...live,
          currentTurnId: turnId,
          currentDispatchAttempt: continuation,
          continuationsStarted: continuation,
          status: 'dispatching',
          nextAttemptAt: undefined,
        });
      } catch {
        this.warnOnce({
          ...live,
          status: 'failed' as const,
          nextAttemptAt: undefined,
          lastErrorCode: 'readonly_continuation_dispatch_persist_failed',
        });
        return;
      }
      let enqueued: number | false = false;
      try {
        enqueued = this.deps.enqueue({
          logicalTurnId: dispatching.logicalTurnId,
          turnId,
          dispatchAttempt: continuation,
          prompt: READONLY_TASK_CONTINUATION_PROMPT,
          continuation,
        });
      } catch {
        enqueued = false;
      }
      if (!enqueued) {
        this.warnOnce({
          ...dispatching,
          status: 'failed',
          lastErrorCode: 'readonly_continuation_enqueue_failed',
        });
        return;
      }
      try {
        this.commit({
          ...dispatching,
          status: 'active',
          currentWorkerGeneration: enqueued,
        });
        this.armExpiry();
      } catch {
        // The child already owns the prompt, so replay is unsafe. Keep the
        // local state failed closed even if the durable store is unavailable.
        // A later daemon restore sees the durable dispatching fence and also
        // refuses replay, so this can never become an automatic duplicate.
        const failed = {
          ...dispatching,
          status: 'failed' as const,
          lastErrorCode: 'readonly_continuation_activation_persist_failed',
        };
        this.retain(failed);
        this.warnOnce(failed);
      }
    });
  }

  private armExpiry(): void {
    const current = this.state;
    if (!current || current.status !== 'active') return;
    this.cancelTimer();
    const delayMs = Math.max(0, current.expiresAt - this.now());
    this.timer = this.deps.schedule(delayMs, () => {
      this.timer = undefined;
      const live = this.state;
      if (!live || live.status !== 'active') return;
      if (this.now() < live.expiresAt) {
        this.armExpiry();
        return;
      }
      this.warnOnce({
        ...live,
        status: 'expired',
        nextAttemptAt: undefined,
        lastErrorCode: 'readonly_continuation_expired',
      });
    });
  }

  private warnOnce(state: ReadonlyTaskContinuationState): void {
    const prior = this.state;
    if (prior?.warningDispatched || prior?.pendingWarning
      || state.warningDispatched || state.pendingWarning) return;
    const pending = {
      ...state,
      pendingDelivery: undefined,
      pendingWarning: { startedAt: this.now(), deliveryAttempts: 0 },
    };
    try {
      this.commit(pending);
    } catch {
      // A warning is an outbox item: never perform the external send unless the
      // exact payload is durable first. Keep only a local fail-closed fence.
      this.retain(pending);
      return;
    }
    this.publishAttention(pending);
    this.requestWarningDelivery(pending);
  }

  private requestWarningDelivery(state: ReadonlyTaskContinuationState): void {
    try { this.deps.warn(state); } catch { /* pending outbox remains recoverable */ }
  }

  private publishAttention(state: ReadonlyTaskContinuationState): void {
    try { this.deps.attend?.(state); } catch { /* local projection is best effort */ }
  }

  private armWarningRetry(): void {
    const current = this.state;
    if (!current?.pendingWarning || current.warningDispatched === true) return;
    this.cancelTimer();
    const deadline = current.pendingWarning.startedAt
      + READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS;
    const retryAt = Math.min(current.pendingWarning.nextAttemptAt ?? this.now(), deadline);
    this.timer = this.deps.schedule(Math.max(0, retryAt - this.now()), () => {
      this.timer = undefined;
      const live = this.state;
      if (!live?.pendingWarning || live.warningDispatched === true) return;
      if (this.now() >= live.pendingWarning.startedAt
        + READONLY_TASK_CONTINUATION_DELIVERY_RECOVERY_MS) {
        this.expireWarningDelivery(live);
        return;
      }
      this.requestWarningDelivery({ ...live, pendingWarning: { ...live.pendingWarning } });
    });
  }

  private expireWarningDelivery(
    state: ReadonlyTaskContinuationState,
  ): ReadonlyTaskContinuationState {
    this.cancelTimer();
    const expired = {
      ...state,
      pendingWarning: undefined,
      lastErrorCode: 'readonly_continuation_warning_delivery_expired',
    };
    try { return this.commit(expired); } catch { this.retain(expired); return expired; }
  }

  private retainFailed(
    state: ReadonlyTaskContinuationState,
    errorCode: string,
  ): ReadonlyTaskContinuationState {
    const failed = {
      ...state,
      status: 'failed' as const,
      nextAttemptAt: undefined,
      lastErrorCode: errorCode,
    };
    this.retain(failed);
    this.warnOnce(failed);
    return failed;
  }

  private commit(state: ReadonlyTaskContinuationState): ReadonlyTaskContinuationState {
    const prior = this.state;
    const next = { ...state };
    this.state = next;
    try {
      this.deps.persist(next);
    } catch (err) {
      this.state = prior;
      throw err;
    }
    return next;
  }

  private retain(state: ReadonlyTaskContinuationState): void {
    this.state = { ...state };
    this.deps.retain?.(this.state);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancelTimer();
  }
}

export function attachReadonlyTaskContinuation<TTimer>(
  session: ReadonlyTaskContinuationSession,
  deps: ReadonlyTaskContinuationDeps<TTimer>,
): void {
  if (attachedContinuations.get(session.sessionId)?.session === session) return;
  disposeReadonlyTaskContinuation(session);
  let coordinator!: ReadonlyTaskContinuationCoordinator<TTimer>;
  const wrapped: ReadonlyTaskContinuationDeps<TTimer> = {
    ...deps,
    persist: state => {
      const prior = session.readonlyTaskContinuation;
      session.readonlyTaskContinuation = structuredClone(state);
      try {
        deps.persist(state);
      } catch (err) {
        session.readonlyTaskContinuation = prior;
        throw err;
      }
    },
    retain: state => {
      session.readonlyTaskContinuation = structuredClone(state);
      deps.retain?.(state);
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
      if (contextCopied && session.readonlyTaskContinuation) {
        deps.persist(session.readonlyTaskContinuation);
      }
      return deps.enqueue(dispatch);
    },
  };
  coordinator = new ReadonlyTaskContinuationCoordinator(wrapped);
  attachedContinuations.set(session.sessionId, {
    session,
    coordinator,
    dispose: () => coordinator.dispose(),
  });
  const restored = session.readonlyTaskContinuation;
  if (restored) coordinator.restore(restored);
}

export function startReadonlyTaskContinuation(
  session: ReadonlyTaskContinuationSession,
  input: StartReadonlyTaskContinuationInput,
): ReadonlyTaskContinuationState | undefined {
  const attached = attachedContinuations.get(session.sessionId);
  if (!attached) return session.readonlyTaskContinuation;
  if (session.readonlyTaskContinuation) attached.coordinator.restore(session.readonlyTaskContinuation);
  return attached.coordinator.start(input);
}

export function handleReadonlyTaskContinuationTerminal(
  session: ReadonlyTaskContinuationSession,
  terminal: ReadonlyTaskContinuationTerminal,
): ReadonlyTaskContinuationState | undefined {
  const attached = attachedContinuations.get(session.sessionId);
  const current = session.readonlyTaskContinuation;
  if (!attached || !current) return current;
  return attached.coordinator.onTerminal(current, terminal);
}

export function readonlyTaskContinuationHandlesTerminal(
  session: ReadonlyTaskContinuationSession,
  terminal: ReadonlyTaskContinuationTerminal,
): boolean {
  return attachedContinuations.get(session.sessionId)?.session === session
    && readonlyTaskContinuationRecoversTerminal(session.readonlyTaskContinuation, terminal);
}

export function completeReadonlyTaskContinuation(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  messageId: string,
  workerGeneration: number,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.complete(
    turnId,
    dispatchAttempt,
    messageId,
    workerGeneration,
  )
    ?? session.readonlyTaskContinuation;
}

export function completeReadonlyTaskContinuationOriginalBusinessFinal(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
  workerGeneration: number,
  messageId?: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.completeOriginalBusinessFinal(
    turnId, workerGeneration, messageId,
  ) ?? session.readonlyTaskContinuation;
}

export function beginReadonlyTaskContinuationDelivery(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  workerGeneration: number,
  delivery: { kind: 'completed' | 'await_user'; content: string },
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.beginDelivery(
    turnId, dispatchAttempt, workerGeneration, delivery,
  ) ?? session.readonlyTaskContinuation;
}

export function failReadonlyTaskContinuationVisible(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  workerGeneration: number,
  errorCode: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.failVisible(
    turnId, dispatchAttempt, workerGeneration, errorCode,
  ) ?? session.readonlyTaskContinuation;
}

export function completeReadonlyTaskContinuationWarning(
  session: ReadonlyTaskContinuationSession,
  leaseId: string,
  messageId: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.completeWarning(leaseId, messageId)
    ?? session.readonlyTaskContinuation;
}

export function failReadonlyTaskContinuationWarningDelivery(
  session: ReadonlyTaskContinuationSession,
  leaseId: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.warningDeliveryFailed(leaseId)
    ?? session.readonlyTaskContinuation;
}

export function finishReadonlyTaskContinuationAwaitUser(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
  dispatchAttempt: number | undefined,
  messageId: string,
  workerGeneration: number,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.finishAwaitUser(
    turnId, dispatchAttempt, messageId, workerGeneration,
  ) ?? session.readonlyTaskContinuation;
}

export function awaitReadonlyTaskContinuationUser(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.awaitUser(turnId)
    ?? session.readonlyTaskContinuation;
}

export function cancelReadonlyTaskContinuationExplicit(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.cancelExplicit(turnId)
    ?? session.readonlyTaskContinuation;
}

export function cancelReadonlyTaskContinuationForUserInput(
  session: ReadonlyTaskContinuationSession,
  turnId: string,
): ReadonlyTaskContinuationState | undefined {
  return attachedContinuations.get(session.sessionId)?.coordinator.cancelForUserInput(turnId)
    ?? session.readonlyTaskContinuation;
}

export function disposeReadonlyTaskContinuation(
  session: Pick<ReadonlyTaskContinuationSession, 'sessionId'>,
): void {
  const attached = attachedContinuations.get(session.sessionId);
  if (!attached) return;
  attached.dispose();
  attachedContinuations.delete(session.sessionId);
}
