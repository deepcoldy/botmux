export type ReadOnlyRemoteScrollDirection = 'up' | 'down';

export interface ReadOnlyRemoteScrollPayload {
  readonly direction: ReadOnlyRemoteScrollDirection;
  readonly eventCount: number;
}

const READ_ONLY_REMOTE_SCROLL_MAX_EVENTS = 6;

export function parseReadOnlyRemoteScrollPayload(data: string): ReadOnlyRemoteScrollPayload | null {
  if (!data) return null;

  const eventPattern = /\x1b\[<(64|65);[1-9]\d{0,3};[1-9]\d{0,3}M/g;
  let offset = 0;
  let eventCount = 0;
  let direction: ReadOnlyRemoteScrollDirection | undefined;

  for (let match = eventPattern.exec(data); match; match = eventPattern.exec(data)) {
    const fullMatch = match[0];
    const button = match[1];
    if (match.index !== offset) return null;
    offset += fullMatch.length;
    eventCount += 1;
    if (eventCount > READ_ONLY_REMOTE_SCROLL_MAX_EVENTS) return null;

    const nextDirection: ReadOnlyRemoteScrollDirection = button === '64' ? 'up' : 'down';
    if (direction !== undefined && direction !== nextDirection) return null;
    direction = nextDirection;
  }

  if (offset !== data.length || eventCount === 0 || direction === undefined) return null;
  return { direction, eventCount };
}

export const READ_ONLY_REMOTE_SCROLL_SESSION_BUDGET = 12;
export const READ_ONLY_REMOTE_SCROLL_WINDOW_MS = 1_000;

export interface ReadOnlyRemoteScrollLimiterOptions {
  readonly budget: number;
  readonly windowMs: number;
}

/**
 * Session-scoped fixed-window limiter for read-only remote scroll events.
 * One instance is shared by every read-only WebSocket client of a session,
 * so the budget aggregates across sockets. The window resets on the first
 * consumption after it expires; excess events are dropped, never queued.
 */
export class ReadOnlyRemoteScrollLimiter {
  private usedEvents = 0;
  private windowStartMs: number | undefined;

  constructor(
    private readonly options: ReadOnlyRemoteScrollLimiterOptions,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (options.budget <= 0) throw new Error('ReadOnlyRemoteScrollLimiter: budget must be positive');
    if (options.windowMs <= 0) throw new Error('ReadOnlyRemoteScrollLimiter: windowMs must be positive');
  }

  tryConsume(eventCount: number): boolean {
    const now = this.nowMs();
    if (this.windowStartMs === undefined || now - this.windowStartMs >= this.options.windowMs) {
      this.windowStartMs = now;
      this.usedEvents = 0;
    }
    if (this.usedEvents + eventCount > this.options.budget) return false;
    this.usedEvents += eventCount;
    return true;
  }
}
