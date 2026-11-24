/**
 * Bounded wait for a started structured-transcript turn whose terminal record
 * never arrives. The worker supplies an identity ONLY while the same CLI is
 * demonstrably idle and quiet; output, transcript activity, a new turn, stop,
 * or generation change therefore resets the wait before it can expire.
 */
export class StructuredMissingFinalWatchdog {
  private candidate: { key: string; sinceMs: number } | undefined;

  constructor(private readonly timeoutMs: number = 20_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid missing-final timeout');
  }

  /** Returns true once the SAME idle identity has survived the full timeout.
   *  Callers must re-drain and revalidate that identity before retiring it. */
  observe(key: string | undefined, nowMs: number = Date.now()): boolean {
    if (!key) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.key !== key) {
      this.candidate = { key, sinceMs: nowMs };
      return false;
    }
    return nowMs - this.candidate.sinceMs >= this.timeoutMs;
  }
}
