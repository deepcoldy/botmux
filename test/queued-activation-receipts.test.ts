import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';

afterEach(() => vi.useRealTimers());

describe('queued activation receipt observation', () => {
  it('continues past missing receipts and transient read failures, then acknowledges once', async () => {
    vi.useFakeTimers();
    const observer = createQueuedActivationReceiptObserver(20);
    const recheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('temporarily unreadable'))
      .mockResolvedValue({ submitted: true, cliSessionId: 'native-id' });
    const onConfirmed = vi.fn();
    observer.watch('head', { recheck, isCurrent: () => true, onConfirmed });
    await vi.advanceTimersByTimeAsync(100);
    expect(recheck).toHaveBeenCalledTimes(3);
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith({ submitted: true, cliSessionId: 'native-id' });
    expect(observer.size()).toBe(0);
  });

  it.each(['cancel', 'clear', 'generation', 'replacement'] as const)(
    'fences an awaited old receipt after %s without cancelling a replacement', async invalidation => {
      vi.useFakeTimers();
      const observer = createQueuedActivationReceiptObserver(20);
      let resolveOld!: (value: boolean) => void;
      let current = true;
      const oldAck = vi.fn();
      observer.watch('head', {
        recheck: () => new Promise<boolean>(resolve => { resolveOld = resolve; }),
        isCurrent: () => current,
        onConfirmed: oldAck,
      });
      await vi.advanceTimersByTimeAsync(20);
      const newAck = vi.fn();
      if (invalidation === 'cancel') observer.cancel('head');
      if (invalidation === 'clear') observer.clear();
      if (invalidation === 'generation') current = false;
      if (invalidation === 'replacement') {
        observer.watch('head', { recheck: () => true, isCurrent: () => true, onConfirmed: newAck });
      }
      resolveOld(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(oldAck).not.toHaveBeenCalled();
      expect(newAck).toHaveBeenCalledTimes(invalidation === 'replacement' ? 1 : 0);
      expect(observer.size()).toBe(0);
    },
  );

  it('does not even read an obsolete generation', async () => {
    vi.useFakeTimers();
    const observer = createQueuedActivationReceiptObserver(20);
    const recheck = vi.fn();
    observer.watch('head', { recheck, isCurrent: () => false, onConfirmed: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    expect(recheck).not.toHaveBeenCalled();
    expect(observer.size()).toBe(0);
  });
});
