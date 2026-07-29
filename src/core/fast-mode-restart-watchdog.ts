export const FAST_MODE_RESTART_ACK_TIMEOUT_MS = 110_000;

type ActiveWatchdog = {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
};

/** One Fast apply transaction may be active at a time. The worker arms this at
 * dequeue, before native probing or RPC work; the request id fences stale
 * clears/cancels so transaction N cannot release transaction N+1. */
export class FastModeRestartWatchdog {
  private active?: ActiveWatchdog;

  constructor(
    private readonly timeoutMs = FAST_MODE_RESTART_ACK_TIMEOUT_MS,
  ) {}

  arm(
    requestId: string,
    onTimeout: (requestId: string) => void | Promise<void>,
  ): void {
    if (this.active) {
      throw new Error(`Fast Mode restart watchdog already armed for ${this.active.requestId}`);
    }
    const timer = setTimeout(() => {
      if (this.active?.requestId !== requestId) return;
      this.active = undefined;
      void onTimeout(requestId);
    }, this.timeoutMs);
    timer.unref?.();
    this.active = { requestId, timer };
  }

  clear(requestId: string): boolean {
    if (this.active?.requestId !== requestId) return false;
    clearTimeout(this.active.timer);
    this.active = undefined;
    return true;
  }

  dispose(): void {
    if (!this.active) return;
    clearTimeout(this.active.timer);
    this.active = undefined;
  }
}
