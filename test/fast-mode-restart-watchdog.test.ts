import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAST_MODE_RESTART_ACK_TIMEOUT_MS,
  FastModeRestartWatchdog,
} from '../src/core/fast-mode-restart-watchdog.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Fast Mode native restart watchdog', () => {
  it('expires only the active request after the bounded worker deadline', async () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const watchdog = new FastModeRestartWatchdog();

    watchdog.arm('req-active', requestId => expired.push(requestId));
    await vi.advanceTimersByTimeAsync(FAST_MODE_RESTART_ACK_TIMEOUT_MS - 1);
    expect(expired).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toEqual(['req-active']);
    expect(watchdog.clear('req-active')).toBe(false);
  });

  it('cannot clear a newer transaction with a stale request id', async () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const watchdog = new FastModeRestartWatchdog(25);

    watchdog.arm('req-new', requestId => expired.push(requestId));
    expect(watchdog.clear('req-old')).toBe(false);
    await vi.advanceTimersByTimeAsync(25);

    expect(expired).toEqual(['req-new']);
  });

  it('does not expire a transaction confirmed at the prompt', async () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const watchdog = new FastModeRestartWatchdog(25);

    watchdog.arm('req-confirmed', requestId => expired.push(requestId));
    expect(watchdog.clear('req-confirmed')).toBe(true);
    await vi.advanceTimersByTimeAsync(25);

    expect(expired).toEqual([]);
  });
});
