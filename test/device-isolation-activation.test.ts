import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDeviceIsolationFreeze,
  currentDeviceIsolationFreezeLease,
  deferWorkerSpawnDuringDeviceIsolation,
  releaseDeviceIsolationFreeze,
  requireDeviceIsolationFreeze,
  resetDeviceIsolationActivationForTest,
} from '../src/core/device-isolation-activation.js';

afterEach(() => {
  resetDeviceIsolationActivationForTest();
  vi.useRealTimers();
});

describe('device isolation activation freeze', () => {
  it('reuses only the same nonce and binds release to the exact lease', () => {
    const first = acquireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32),
      inventoryGeneration: 'g1',
      now: 1_000,
      leaseIdFactory: () => 'lease-1',
    });
    expect(first).toMatchObject({ ok: true, reused: false });
    expect(acquireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32),
      inventoryGeneration: 'changed-is-ignored-for-idempotent-prepare',
      now: 1_001,
    })).toMatchObject({ ok: true, reused: true });
    expect(acquireDeviceIsolationFreeze({
      nonce: 'x'.repeat(32),
      inventoryGeneration: 'g2',
      now: 1_001,
    })).toEqual({ ok: false, reason: 'busy' });
    expect(requireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32), leaseId: 'wrong', now: 1_001,
    })).toBeNull();
    expect(releaseDeviceIsolationFreeze({
      nonce: 'n'.repeat(32), leaseId: 'lease-1', now: 1_001,
    })).toBe(true);
    expect(currentDeviceIsolationFreezeLease(1_001)).toBeNull();
  });

  it('deduplicates deferred spawns and flushes them on release', async () => {
    const calls: string[] = [];
    acquireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32), inventoryGeneration: 'g1', now: 1_000,
      leaseIdFactory: () => 'lease-1',
    });
    expect(deferWorkerSpawnDuringDeviceIsolation('s1', () => calls.push('first'), 1_001)).toBe(true);
    expect(deferWorkerSpawnDuringDeviceIsolation('s1', () => calls.push('second'), 1_001)).toBe(true);
    expect(deferWorkerSpawnDuringDeviceIsolation('s2', () => calls.push('other'), 1_001)).toBe(true);
    releaseDeviceIsolationFreeze({ nonce: 'n'.repeat(32), leaseId: 'lease-1', now: 1_002 });
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toEqual(['first', 'other']);
  });

  it('expires fail-safe without permanently wedging worker spawns', async () => {
    const callback = vi.fn();
    const started = 1_000;
    acquireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32), inventoryGeneration: 'g1', now: started,
      leaseMs: 1_000, leaseIdFactory: () => 'lease-1',
    });
    expect(deferWorkerSpawnDuringDeviceIsolation('s1', callback, started)).toBe(true);
    // Drive expiry through the `now` argument rather than fake timers: Bun's
    // fake clock does not move `Date.now()`, so `setTimeout` + `Date.now()`
    // fail-safes never fire under `bun test`. Passing the scheduled expiry
    // instant is the same branch production takes when the timer fires.
    expect(currentDeviceIsolationFreezeLease(started + 1_010)).toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
