// src/core/dashboard-locate.ts

/**
 * Per-sessionId 30s rate limiter for the dashboard locate action.
 * The slot is consumed on attempt, not on success — a 404 still burns the
 * slot. This keeps the rate limit useful against sessionId enumeration via
 * fast spam and matches the design spec.
 */
export class LocateRateLimiter {
  private last = new Map<string, number>();
  constructor(private windowMs: number) {}

  tryAcquire(sessionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = Date.now();
    const last = this.last.get(sessionId);
    if (last !== undefined && now - last < this.windowMs) {
      return { ok: false, retryAfterMs: this.windowMs - (now - last) };
    }
    this.last.set(sessionId, now);
    return { ok: true };
  }
}

/** Module singleton — process-wide rate limit shared across all routes. */
export const locateLimiter = new LocateRateLimiter(30_000);
