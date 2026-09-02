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
    vi.useFakeTimers();
    const callback = vi.fn();
    acquireDeviceIsolationFreeze({
      nonce: 'n'.repeat(32), inventoryGeneration: 'g1', now: Date.now(),
      leaseMs: 1_000, leaseIdFactory: () => 'lease-1',
    });
    deferWorkerSpawnDuringDeviceIsolation('s1', callback);
    await vi.advanceTimersByTimeAsync(1_010);
    await vi.runAllTimersAsync();
    expect(currentDeviceIsolationFreezeLease()).toBeNull();
    // The lease has now expired, so `flushDeferredSpawns()` has already run and
    // QUEUED the callback via `setImmediate` (see device-isolation-activation.ts).
    // Advancing fake timers is not enough to make it FIRE, because the two runners
    // fake different globals — measured on this exact nesting (a `setImmediate`
    // queued from inside a fired `setTimeout`):
    //
    //                                   bun 1.4.0   vitest 4.1.11
    //   useFakeTimers replaces setTimeout      no             yes
    //   useFakeTimers replaces setImmediate    no             yes
    //   fired after advance/runAllTimers       NO             yes
    //
    // Under vitest the faked `setImmediate` is driven by `runAllTimersAsync`, so
    // the assertion below passed without any extra yield. Under bun the real
    // `setImmediate` is left untouched by `useFakeTimers`, and the shim's async
    // timer fills end in `await Promise.resolve()` — microtasks only, which never
    // reaches the check phase where `setImmediate` runs. Hence the callback stayed
    // at 0 calls there.
    //
    // Dropping to REAL timers first and then yielding one macrotask is the only
    // shape that is green on both. The order is load-bearing: awaiting
    // `setImmediate` WHILE timers are still faked hangs vitest for the full
    // timeout (measured: "Test timed out in 30000ms") because vitest's fake
    // `setImmediate` has nothing left to advance it. So do NOT hoist this yield
    // above `useRealTimers()`, and do not replace it with `Promise.resolve()`.
    vi.useRealTimers();
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledOnce();
  });
});
