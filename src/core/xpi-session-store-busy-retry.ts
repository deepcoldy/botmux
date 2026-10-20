export type XpiSessionStoreBusyRetryPhase = 'fast' | 'slow';

export type XpiSessionStoreBusyRetryEvent = {
  key: string;
  phase: XpiSessionStoreBusyRetryPhase;
  attempt: number;
  delayMs: number;
};

type RetryState = {
  fastAttempts: number;
  slowAttempts: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type XpiSessionStoreBusyRetryOptions = {
  fastAttemptLimit?: number;
  fastBaseDelayMs?: number;
  slowDelayMs?: number;
  onScheduled?: (event: XpiSessionStoreBusyRetryEvent) => void;
  onEscalated?: (event: XpiSessionStoreBusyRetryEvent) => void;
  onTaskError?: (key: string, error: unknown) => void;
  onSettled?: (key: string) => void;
};

/**
 * Keeps a single retry chain per durable compare-and-set key. Fast retries are
 * bounded and exponentially backed off; sustained contention then moves to a
 * deliberately slow, observable retry cadence. A task signals continued busy
 * by scheduling the same key again before it returns.
 *
 * Timers are runtime-only and unref'ed. The XPI queue/lease itself is durable,
 * so daemon startup re-drives persisted groups instead of relying on a timer
 * surviving process exit.
 */
export class XpiSessionStoreBusyRetryScheduler {
  private readonly states = new Map<string, RetryState>();
  private readonly fastAttemptLimit: number;
  private readonly fastBaseDelayMs: number;
  private readonly slowDelayMs: number;

  constructor(private readonly options: XpiSessionStoreBusyRetryOptions = {}) {
    this.fastAttemptLimit = options.fastAttemptLimit ?? 5;
    this.fastBaseDelayMs = options.fastBaseDelayMs ?? 100;
    this.slowDelayMs = options.slowDelayMs ?? 5_000;
  }

  schedule(key: string, task: () => unknown | Promise<unknown>): boolean {
    let state = this.states.get(key);
    if (state?.timer) return false;
    if (!state) {
      state = { fastAttempts: 0, slowAttempts: 0 };
      this.states.set(key, state);
    }

    const phase: XpiSessionStoreBusyRetryPhase = state.fastAttempts < this.fastAttemptLimit
      ? 'fast'
      : 'slow';
    let attempt: number;
    let delayMs: number;
    if (phase === 'fast') {
      attempt = ++state.fastAttempts;
      delayMs = this.fastBaseDelayMs * (2 ** (attempt - 1));
    } else {
      attempt = ++state.slowAttempts;
      delayMs = this.slowDelayMs;
    }
    const event = { key, phase, attempt, delayMs };
    this.options.onScheduled?.(event);
    if (phase === 'slow' && attempt === 1) this.options.onEscalated?.(event);

    const current = state;
    current.timer = setTimeout(() => {
      current.timer = undefined;
      void (async () => {
        try {
          await task();
        } catch (error) {
          this.options.onTaskError?.(key, error);
        } finally {
          // A busy task recursively schedules the same key while its timer is
          // empty. Preserve that new timer; otherwise the operation settled.
          if (this.states.get(key) === current && !current.timer) {
            this.states.delete(key);
            this.options.onSettled?.(key);
          }
        }
      })();
    }, delayMs);
    current.timer.unref?.();
    return true;
  }

  snapshot(key: string): { fastAttempts: number; slowAttempts: number; pending: boolean } | undefined {
    const state = this.states.get(key);
    return state ? {
      fastAttempts: state.fastAttempts,
      slowAttempts: state.slowAttempts,
      pending: !!state.timer,
    } : undefined;
  }
}
