function terminalKey(sessionId: string, turnId: string, dispatchAttempt?: number): string {
  return `${sessionId}:${turnId}:${dispatchAttempt ?? 'generic'}`;
}

/** Bounded worker-local exactly-once gate for terminal IPC emission. */
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
   * caller wins regardless of status; transcript-final, submit-failure and CLI
   * exit races therefore emit one IPC message, never contradictory duplicates.
   */
  claim(sessionId: string, turnId: string, dispatchAttempt?: number, status = 'unknown'): boolean {
    if (!sessionId || !turnId) return false;
    const key = terminalKey(sessionId, turnId, dispatchAttempt);
    if (this.emitted.has(key)) return false;
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
