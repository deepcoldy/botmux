/**
 * Trailing debounce with a maximum wait. Repeated schedule() calls postpone
 * the quiet-period timer, while the first call's max timer guarantees that a
 * continuously busy source still flushes at a bounded cadence.
 */
export class MaxWaitDebouncer {
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly settleMs: number,
    private readonly maxWaitMs: number,
    private readonly callback: () => void,
  ) {}

  schedule(): void {
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(this.fire, this.maxWaitMs);
      this.maxTimer.unref?.();
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(this.fire, this.settleMs);
    this.settleTimer.unref?.();
  }

  cancel(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.settleTimer = null;
    this.maxTimer = null;
  }

  private readonly fire = (): void => {
    this.cancel();
    this.callback();
  };
}
