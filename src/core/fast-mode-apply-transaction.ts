export type FastModeCancellationSource = 'worker_deadline' | 'daemon_timeout';

export class FastModeApplyCancelledError extends Error {
  constructor(
    readonly requestId: string,
    readonly source: FastModeCancellationSource,
  ) {
    super(`Fast Mode apply transaction ${requestId} was cancelled (${source})`);
    this.name = 'FastModeApplyCancelledError';
  }
}

/**
 * Lifetime guard for one exact Fast Mode request.
 *
 * The worker creates this object immediately after dequeuing the request. Every
 * asynchronous result must pass through waitFor() before it can mutate executor
 * or persisted state, so cancellation covers the applying window as well as the
 * later native prompt-ACK window.
 */
export class FastModeApplyTransaction {
  private readonly abortController = new AbortController();
  private cancellationSource?: FastModeCancellationSource;

  constructor(readonly requestId: string) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cancelledBy(): FastModeCancellationSource | undefined {
    return this.cancellationSource;
  }

  cancel(requestId: string, source: FastModeCancellationSource): boolean {
    if (requestId !== this.requestId) return false;
    if (!this.cancellationSource) {
      this.cancellationSource = source;
      this.abortController.abort();
    }
    return true;
  }

  assertActive(): void {
    if (this.cancellationSource) {
      throw new FastModeApplyCancelledError(this.requestId, this.cancellationSource);
    }
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const result = await operation;
    this.assertActive();
    return result;
  }
}
