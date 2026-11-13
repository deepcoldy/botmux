/** Upper bound for waiting on a host observer decision that never arrives
 * (the binding was refused, or its native identity was never published). */
export const RESTORED_OBSERVER_GRANT_WAIT_MS = 30_000;

/**
 * A restored transcript terminal can be drained before the host grants this
 * worker observation of its original execution. The structured bridge queue is
 * FIFO, so a held head also holds every successor behind it. Waiting is
 * therefore bounded by facts that end it:
 * - the host only grants where `supported` (the same predicate it evaluates);
 * - the host's decision for the current binding's native identity has arrived
 *   (`decide`), and anything it did not grant will never be granted to it;
 * - otherwise a timer closes the wait and redrives once.
 * After that, an unproven turn returns to ordinary admission instead of
 * blocking its successors.
 */
export class RestoredObserverGrantWait {
  private decided?: string;
  private pending?: { bindingId: string; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly maxWaitMs = RESTORED_OBSERVER_GRANT_WAIT_MS) {}

  /** Whether unproven restored turns of `bindingId` should stay queued. */
  hold(bindingId: string | undefined, supported: boolean, redrive: () => void): boolean {
    if (!supported || !bindingId || this.decided === bindingId) return false;
    if (this.pending?.bindingId !== bindingId) {
      if (this.pending) clearTimeout(this.pending.timer);
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = undefined;
        this.decided = bindingId;
        redrive();
      }, this.maxWaitMs);
      timer.unref?.();
      this.pending = { bindingId, timer };
    }
    return true;
  }

  /** The host evaluated observer grants for this binding's native identity.
   * Returns true when restored turns were waiting for exactly this decision. */
  decide(bindingId: string): boolean {
    this.decided = bindingId;
    const waiting = this.pending?.bindingId === bindingId;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    return waiting;
  }
}
