import { describe, expect, it, vi } from 'vitest';
import {
  canWakeDormantBackendForAttach,
  wakeDormantBackendForAttach,
} from '../src/cli/session-list-wake.js';

const target = { backendType: 'tmux' as const, sessionName: 'bmx-deadbeef' };

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
    const wake = vi.fn(async () => ({ ok: true as const }));
    const probe = vi.fn()
      .mockReturnValueOnce('missing')
      .mockReturnValueOnce('unknown')
      .mockReturnValueOnce('exists');
    const sleep = vi.fn(async () => {});

    await expect(wakeDormantBackendForAttach({
      target,
      wake,
      probe,
      sleep,
      timeoutMs: 30,
      pollIntervalMs: 10,
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
    const result = await wakeDormantBackendForAttach({
      target,
      wake: async () => ({ ok: true }),
      probe: () => 'unknown',
      sleep: async () => {},
      timeoutMs: 20,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      lastProbe: 'unknown',
      error: expect.stringContaining('无法确认'),
    });
  });
});
