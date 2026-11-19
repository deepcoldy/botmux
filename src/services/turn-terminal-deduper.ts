function terminalKey(sessionId: string, turnId: string, dispatchAttempt?: number): string {
  return `${sessionId}:${turnId}:${dispatchAttempt ?? 'generic'}`;
}

/** Bounded worker-local gate. Observer loss may later be resolved by a real
 * native terminal; two contradictory confirmed terminals remain suppressed. */
export class TurnTerminalDeduper {
  /** Claimed terminal → the status it was claimed with. */
  private readonly emitted = new Map<string, string>();

  constructor(private readonly maxEntries = 4_096) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  /**
   * Claim one `(session, logical turn, dispatch attempt)` terminal. The first
   * confirmed caller wins. An ambiguous/unknown observation can be resolved by
   * a later native terminal without allowing contradictory confirmed results.
   */
  claim(sessionId: string, turnId: string, dispatchAttempt?: number, status = 'unknown'): boolean {
    if (!sessionId || !turnId) return false;
    const key = terminalKey(sessionId, turnId, dispatchAttempt);
    const previous = this.emitted.get(key);
    if (previous !== undefined && !(['ambiguous', 'unknown'].includes(previous) && ['completed', 'failed', 'cancelled'].includes(status))) return false;
    this.emitted.set(key, status);
    if (this.emitted.size > this.maxEntries) {
      const oldest = this.emitted.keys().next().value;
      if (oldest !== undefined) this.emitted.delete(oldest);
    }
    return true;
  }

  /** The status this terminal was claimed with, without claiming it;
   *  undefined while unclaimed. */
  statusOf(sessionId: string, turnId: string, dispatchAttempt?: number): string | undefined {
    if (!sessionId || !turnId) return undefined;
    return this.emitted.get(terminalKey(sessionId, turnId, dispatchAttempt));
  }

  size(): number {
    return this.emitted.size;
  }
}
