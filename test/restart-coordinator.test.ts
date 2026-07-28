import { describe, expect, it, vi } from 'vitest';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('RestartCoordinator', () => {
  it('coalesces physical restart and orders progress before terminal per observer', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a1' });
    const start = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    expect(coordinator.request('s', { source: 'slash', notify: first }, start).joined).toBe(false);
    expect(coordinator.request('s', { source: 'card', notify: second }, start).joined).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(coordinator.resolve('s', 'a1', 'succeeded')).toBe(true);
    expect(coordinator.resolve('s', 'a1', 'failed')).toBe(false);
    await flush();
    expect(first.mock.calls.map(call => call[0])).toEqual(['in_progress', 'succeeded']);
    expect(second.mock.calls.map(call => call[0])).toEqual(['in_progress', 'succeeded']);
  });

  it('starts physical restart without waiting for a stuck progress notification', () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a2' });
    const start = vi.fn();
    coordinator.request('s', {
      source: 'slash',
      notify: () => new Promise<void>(() => {}),
    }, start);
    expect(start).toHaveBeenCalledWith('a2');
  });

  it('isolates observers when another observer notification is stuck', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a3' });
    const second = vi.fn();
    coordinator.request('s', {
      source: 'slash',
      notify: () => new Promise<void>(() => {}),
    }, vi.fn());
    coordinator.request('s', { source: 'card', notify: second }, vi.fn());

    expect(coordinator.resolve('s', 'a3', 'succeeded')).toBe(true);
    await flush();
    expect(second.mock.calls.map(call => call[0])).toEqual(['in_progress', 'succeeded']);
  });

  it('times out once and ignores late completion', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new RestartCoordinator({
        createAttemptId: () => 'a4',
        timeoutMs: 10,
      });
      const notify = vi.fn();
      coordinator.request('s', { source: 'slash', notify }, vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(notify.mock.calls.map(call => call[0])).toEqual(['in_progress', 'timed_out']);
      expect(coordinator.resolve('s', 'a4', 'succeeded')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a synchronously rejected physical restart once', async () => {
    const coordinator = new RestartCoordinator({ createAttemptId: () => 'a5' });
    const notify = vi.fn();
    coordinator.request('s', { source: 'slash', notify }, () => {
      throw new Error('send failed');
    });
    await flush();
    expect(notify.mock.calls.map(call => call[0])).toEqual(['in_progress', 'failed']);
  });
});
