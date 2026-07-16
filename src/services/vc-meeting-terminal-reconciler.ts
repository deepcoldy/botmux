import type { WorkerToDaemon } from '../types.js';

/** A worker terminal for a single logical CLI turn. */
export type VcMeetingTurnTerminal = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;

export interface VcMeetingTerminalSettleContext {
  workerGeneration: number;
}

export interface VcMeetingTerminalSettleResult {
  handled: boolean;
  reason?: string;
}

export type VcMeetingTerminalSettle = (
  terminal: VcMeetingTurnTerminal,
  context: VcMeetingTerminalSettleContext,
) => VcMeetingTerminalSettleResult | Promise<VcMeetingTerminalSettleResult>;

/** Structural timer handle so tests do not need Node's concrete Timeout type. */
export interface VcMeetingTerminalRetryTimer {
  unref?: () => void;
}

export interface VcMeetingTerminalRetryScheduler {
  setTimeout(callback: () => void, delayMs: number): VcMeetingTerminalRetryTimer;
  clearTimeout(timer: VcMeetingTerminalRetryTimer): void;
}

export type VcMeetingTerminalFinalState =
  | 'handled'
  | 'permanent_failure'
  | 'retry_exhausted'
  | 'one_shot_failure';

export interface VcMeetingTerminalFinalizedEvent {
  key: string;
  terminal: VcMeetingTurnTerminal;
  context: VcMeetingTerminalSettleContext;
  attempts: number;
  state: VcMeetingTerminalFinalState;
  reason?: string;
  error?: unknown;
}

export interface VcMeetingTerminalReconcilerOptions {
  settle: VcMeetingTerminalSettle;
  scheduler?: VcMeetingTerminalRetryScheduler;
  /** Total settle calls, including the immediate first call. */
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  /** Recently finalized keys are retained as bounded in-process tombstones. */
  maxRememberedKeys?: number;
  isRetryableReason?: (reason: string | undefined) => boolean;
  onFinalized?: (event: VcMeetingTerminalFinalizedEvent) => void;
}

export type VcMeetingTerminalEnqueueResult =
  | { accepted: true; key: string }
  | { accepted: false; key: string; reason: 'duplicate' | 'stopped' };

interface PendingTerminal {
  key: string;
  terminal: VcMeetingTurnTerminal;
  context: VcMeetingTerminalSettleContext;
  attempts: number;
  timer?: VcMeetingTerminalRetryTimer;
}

const PERMANENT_SETTLE_REASONS: ReadonlySet<string> = new Set([
  'dispatch_attempt_missing',
  'stale_terminal',
  'stale_dispatch_attempt',
  'stale_worker_generation',
  'receiver_session_mismatch',
  'wrong_agent_receipt',
  'receipt_not_found',
  'invalid_transition',
  'already_dispatched',
  'stream_abandoned',
]);

/**
 * `handled:false` is retryable by default unless the receiver has proved the
 * terminal stale or otherwise permanently invalid. Unknown reasons deliberately
 * get a bounded retry so a newly-added transient store error cannot wedge the
 * delivery cursor forever.
 */
export function isRetryableVcMeetingTerminalSettleReason(reason: string | undefined): boolean {
  if (!reason) return true;
  return !reason.startsWith('stale_') && !PERMANENT_SETTLE_REASONS.has(reason);
}

export function deriveVcMeetingTerminalReconcileKey(
  terminal: VcMeetingTurnTerminal,
  context: VcMeetingTerminalSettleContext,
): string {
  return [
    terminal.sessionId,
    terminal.turnId,
    terminal.dispatchAttempt ?? 'ordinary',
    context.workerGeneration,
  ].join('\u0000');
}

const defaultScheduler: VcMeetingTerminalRetryScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/**
 * In-process write-behind reconciliation for durable meeting terminals.
 *
 * The worker emits a terminal only once. If the synchronous receipt store is
 * temporarily unavailable at that exact point, dropping the terminal would
 * leave the delivery cursor at its in-flight head forever. This queue retries
 * durable terminals (identified by dispatchAttempt) with bounded backoff.
 * Ordinary IM terminals remain one-shot and are never turned into durable work.
 */
export class VcMeetingTerminalReconciler {
  private readonly settle: VcMeetingTerminalSettle;
  private readonly scheduler: VcMeetingTerminalRetryScheduler;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxDelayMs: number;
  private readonly maxRememberedKeys: number;
  private readonly isRetryableReason: (reason: string | undefined) => boolean;
  private readonly onFinalized?: (event: VcMeetingTerminalFinalizedEvent) => void;
  private readonly pending = new Map<string, PendingTerminal>();
  private readonly remembered = new Set<string>();
  private stopped = false;

  constructor(options: VcMeetingTerminalReconcilerOptions) {
    if (!Number.isInteger(options.maxAttempts ?? 5) || (options.maxAttempts ?? 5) < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(options.initialDelayMs ?? 250) || (options.initialDelayMs ?? 250) < 0) {
      throw new Error('initialDelayMs must be a non-negative finite number');
    }
    if (!Number.isFinite(options.backoffMultiplier ?? 2) || (options.backoffMultiplier ?? 2) < 1) {
      throw new Error('backoffMultiplier must be a finite number >= 1');
    }
    if (!Number.isFinite(options.maxDelayMs ?? 10_000) || (options.maxDelayMs ?? 10_000) < 0) {
      throw new Error('maxDelayMs must be a non-negative finite number');
    }
    if (!Number.isInteger(options.maxRememberedKeys ?? 4_096)
      || (options.maxRememberedKeys ?? 4_096) < 0) {
      throw new Error('maxRememberedKeys must be a non-negative integer');
    }

    this.settle = options.settle;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.initialDelayMs = options.initialDelayMs ?? 250;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.maxRememberedKeys = options.maxRememberedKeys ?? 4_096;
    this.isRetryableReason = options.isRetryableReason
      ?? isRetryableVcMeetingTerminalSettleReason;
    this.onFinalized = options.onFinalized;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  enqueue(
    terminal: VcMeetingTurnTerminal,
    context: VcMeetingTerminalSettleContext,
  ): VcMeetingTerminalEnqueueResult {
    const key = deriveVcMeetingTerminalReconcileKey(terminal, context);
    if (this.stopped) return { accepted: false, key, reason: 'stopped' };
    if (this.pending.has(key) || this.remembered.has(key)) {
      return { accepted: false, key, reason: 'duplicate' };
    }

    const entry: PendingTerminal = {
      key,
      terminal: { ...terminal },
      context: { ...context },
      attempts: 0,
    };
    this.pending.set(key, entry);
    void this.run(entry);
    return { accepted: true, key };
  }

  /** Cancels retry timers. A settle already in progress is ignored on return. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) {
      if (entry.timer) this.scheduler.clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.remembered.clear();
  }

  private async run(entry: PendingTerminal): Promise<void> {
    if (this.stopped || this.pending.get(entry.key) !== entry) return;
    entry.attempts += 1;

    let result: VcMeetingTerminalSettleResult | undefined;
    let error: unknown;
    try {
      result = await this.settle(entry.terminal, entry.context);
    } catch (err) {
      error = err;
    }

    // stop() or another terminal path may have retired this entry while the
    // injected settle promise was pending.
    if (this.stopped || this.pending.get(entry.key) !== entry) return;
    if (result?.handled) {
      this.finalize(entry, 'handled');
      return;
    }

    const durable = entry.terminal.dispatchAttempt !== undefined;
    const reason = result?.reason;
    if (!durable) {
      this.finalize(entry, 'one_shot_failure', reason, error);
      return;
    }
    if (!error && !this.isRetryableReason(reason)) {
      this.finalize(entry, 'permanent_failure', reason);
      return;
    }
    if (entry.attempts >= this.maxAttempts) {
      this.finalize(entry, 'retry_exhausted', reason, error);
      return;
    }

    const delay = Math.min(
      this.maxDelayMs,
      this.initialDelayMs * (this.backoffMultiplier ** (entry.attempts - 1)),
    );
    entry.timer = this.scheduler.setTimeout(() => {
      entry.timer = undefined;
      void this.run(entry);
    }, delay);
    entry.timer.unref?.();
  }

  private finalize(
    entry: PendingTerminal,
    state: VcMeetingTerminalFinalState,
    reason?: string,
    error?: unknown,
  ): void {
    if (entry.timer) this.scheduler.clearTimeout(entry.timer);
    this.pending.delete(entry.key);
    this.remember(entry.key);
    try {
      this.onFinalized?.({
        key: entry.key,
        terminal: entry.terminal,
        context: entry.context,
        attempts: entry.attempts,
        state,
        ...(reason ? { reason } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    } catch {
      // Observability callbacks must never compromise receipt reconciliation.
    }
  }

  private remember(key: string): void {
    if (this.maxRememberedKeys === 0) return;
    this.remembered.add(key);
    while (this.remembered.size > this.maxRememberedKeys) {
      const oldest = this.remembered.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remembered.delete(oldest);
    }
  }
}
