import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canWakeDormantBackendForAttach,
  wakeDormantBackendForAttach,
} from '../src/cli/session-list-wake.js';

const target = { backendType: 'tmux' as const, sessionName: 'bmx-deadbeef' };

afterEach(() => vi.useRealTimers());

describe('botmux list dormant backend wake', () => {
  it('offers recovery only for a missing Botmux-managed attachable backend', () => {
    expect(canWakeDormantBackendForAttach({
      isAdopt: false,
      probe: 'missing',
      realManagedSession: true,
      attachBackend: 'tmux',
      target,
    })).toBe(true);
    expect(canWakeDormantBackendForAttach({
      isAdopt: false,
      probe: 'unknown',
      realManagedSession: true,
      attachBackend: 'tmux',
      target,
    })).toBe(false);
    expect(canWakeDormantBackendForAttach({
      isAdopt: true,
      probe: 'missing',
      realManagedSession: true,
      attachBackend: 'tmux',
      target,
    })).toBe(false);
  });

  it('wakes once and waits through missing/unknown probes until attachable', async () => {
    let now = 1_000;
    const wake = vi.fn(async ({ signal, deadlineMs }: { signal: AbortSignal; deadlineMs: number }) => {
      expect(signal.aborted).toBe(false);
      expect(deadlineMs).toBe(1_030);
      return { ok: true as const };
    });
    const probe = vi.fn()
      .mockReturnValueOnce('missing')
      .mockReturnValueOnce('unknown')
      .mockReturnValueOnce('exists');
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    await expect(wakeDormantBackendForAttach({
      target,
      wake,
      probe,
      sleep,
      timeoutMs: 30,
      pollIntervalMs: 10,
      now: () => now,
    })).resolves.toEqual({ ok: true });
    expect(wake).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not probe when the owning daemon refuses the wake', async () => {
    const probe = vi.fn(() => 'exists' as const);
    const result = await wakeDormantBackendForAttach({
      target,
      wake: async () => ({ ok: false, error: 'session_transferring' }),
      probe,
    });

    expect(result).toEqual({ ok: false, error: 'session_transferring' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports a bounded timeout without treating an unknown probe as missing', async () => {
    let now = 1_000;
    const result = await wakeDormantBackendForAttach({
      target,
      wake: async () => ({ ok: true }),
      probe: () => 'unknown',
      sleep: async ms => { now += ms; },
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => now,
    });

    expect(result).toMatchObject({
      ok: false,
      lastProbe: 'unknown',
      error: expect.stringContaining('无法确认'),
    });
  });

  it('aborts a never-resolving wake when the shared deadline expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    let wakeSignal: AbortSignal | undefined;
    const wake = vi.fn(({ signal }: { signal: AbortSignal }) => {
      wakeSignal = signal;
      return new Promise<{ ok: true }>(() => {});
    });

    const pending = wakeDormantBackendForAttach({
      target,
      wake,
      probe: () => 'missing',
      timeoutMs: 20,
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('超时'),
    });
    expect(wake).toHaveBeenCalledOnce();
    expect(wakeSignal?.aborted).toBe(true);
  });
});
