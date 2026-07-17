import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxWaitDebouncer } from '../src/utils/max-wait-debouncer.js';

afterEach(() => vi.useRealTimers());

describe('MaxWaitDebouncer', () => {
  it('flushes at max-wait even when events stay closer than the settle window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firedAt: number[] = [];
    const debouncer = new MaxWaitDebouncer(120, 600, () => firedAt.push(Date.now()));

    for (let index = 0; index < 12; index++) {
      debouncer.schedule();
      vi.advanceTimersByTime(50);
    }

    expect(firedAt).toEqual([600]);
  });

  it('still coalesces a short burst at the trailing settle boundary', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = new MaxWaitDebouncer(120, 600, callback);

    debouncer.schedule();
    vi.advanceTimersByTime(50);
    debouncer.schedule();
    vi.advanceTimersByTime(119);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels both the settle and max-wait timers', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = new MaxWaitDebouncer(120, 600, callback);

    debouncer.schedule();
    debouncer.cancel();
    vi.advanceTimersByTime(1_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
