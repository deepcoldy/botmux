import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runMarginalAdmissionRetry,
  coalesceMarginalAdmissionRetry,
  MARGINAL_ADMISSION_RETRY_DELAY_MS,
} from '../src/core/admission-reclaim.js';
import {
  evaluateWorkerAdmission,
  type HostMemoryPressure,
} from '../src/core/worker-budget.js';

const GIB = 1024 ** 3;

function decision(allowed: boolean): ReturnType<typeof evaluateWorkerAdmission> {
  const pressure: HostMemoryPressure = {
    totalMemoryBytes: 32 * GIB,
    ...(allowed ? {} : { availableMemoryBytes: 9.5 * GIB }),
    ...(allowed ? { availableMemoryBytes: 12 * GIB } : {}),
    totalMemorySource: 'host',
    availableMemorySource: 'host',
    memoryFullAvg10: 1,
    memoryFullAvg10Source: 'host',
    warnings: [],
  };
  const d = evaluateWorkerAdmission(pressure, { minAvailableMemoryBytes: 10 * GIB });
  expect(d.allowed).toBe(allowed);
  return d;
}

afterEach(() => {
  delete process.env.BOTMUX_TIME_SCALE;
});

describe('runMarginalAdmissionRetry (reclaim → sleep → recheck)', () => {
  it('reclaims, waits the injected delay, then proceeds when the re-check passes', async () => {
    const order: string[] = [];
    const reclaim = vi.fn(async () => {
      order.push('reclaim');
      return [{ sessionId: 'a', reason: 'admission_memory' }];
    });
    const sleep = vi.fn(async (ms: number) => {
      order.push(`sleep:${ms}`);
    });
    const readAdmission = vi.fn(() => {
      order.push('recheck');
      return decision(true);
    });

    const outcome = await runMarginalAdmissionRetry({ reclaim, sleep, readAdmission, delayMs: 25 });

    expect(outcome).toMatchObject({ result: 'allowed', reclaimed: 1 });
    expect(order).toEqual(['reclaim', 'sleep:25', 'recheck']);
  });

  it('reports still_blocked and the suspended count when the re-check fails', async () => {
    const reclaim = vi.fn(async () => [
      { sessionId: 'a', reason: 'admission_memory' },
      { sessionId: 'b', reason: 'admission_memory' },
    ]);
    const sleep = vi.fn(async () => {});
    const readAdmission = vi.fn(() => decision(false));

    const outcome = await runMarginalAdmissionRetry({ reclaim, sleep, readAdmission, delayMs: 1 });

    expect(outcome.result).toBe('still_blocked');
    if (outcome.result === 'still_blocked') {
      expect(outcome.reclaimed).toBe(2);
      expect(outcome.decision.allowed).toBe(false);
    }
  });

  it('reclaims zero sessions and still performs the single re-check', async () => {
    const reclaim = vi.fn(async () => []);
    const readAdmission = vi.fn(() => decision(true));
    const outcome = await runMarginalAdmissionRetry({
      reclaim,
      sleep: vi.fn(async () => {}),
      readAdmission,
      delayMs: 1,
    });
    expect(outcome).toMatchObject({ result: 'allowed', reclaimed: 0 });
    expect(readAdmission).toHaveBeenCalledTimes(1);
  });

  it('defaults to the ~2s constant delay through the BOTMUX_TIME_SCALE-aware timer', async () => {
    process.env.BOTMUX_TIME_SCALE = '0.0001'; // 2000ms → 0.2ms, keeps the real default sleep path fast
    const start = Date.now();
    const outcome = await runMarginalAdmissionRetry({
      reclaim: vi.fn(async () => []),
      readAdmission: vi.fn(() => decision(true)),
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(outcome.result).toBe('allowed');
    expect(MARGINAL_ADMISSION_RETRY_DELAY_MS).toBe(2000);
  });

  it('propagates a reclaim failure and never re-checks', async () => {
    const readAdmission = vi.fn(() => decision(true));
    await expect(runMarginalAdmissionRetry({
      reclaim: vi.fn(async () => { throw new Error('gate busy'); }),
      sleep: vi.fn(async () => {}),
      readAdmission,
      delayMs: 1,
    })).rejects.toThrow('gate busy');
    expect(readAdmission).not.toHaveBeenCalled();
  });
});

describe('coalesceMarginalAdmissionRetry', () => {
  it('shares one reclaim+recheck between concurrent requests for the same key', async () => {
    const reclaim = vi.fn(async () => [{ sessionId: 'a', reason: 'admission_memory' }]);
    const readAdmission = vi.fn(() => decision(true));
    const pending = new WeakMap<object, ReturnType<typeof runMarginalAdmissionRetry>>();
    const key = { session: 's1' };

    const [o1, o2] = await Promise.all([
      coalesceMarginalAdmissionRetry(pending, key, { reclaim, sleep: async () => {}, readAdmission, delayMs: 1 }),
      coalesceMarginalAdmissionRetry(pending, key, { reclaim, sleep: async () => {}, readAdmission, delayMs: 1 }),
    ]);

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(readAdmission).toHaveBeenCalledTimes(1);
    expect(o1).toMatchObject({ result: 'allowed', reclaimed: 1 });
    expect(o2).toMatchObject({ result: 'allowed', reclaimed: 1 });
  });

  it('runs independent retries for different keys', async () => {
    const reclaim = vi.fn(async () => []);
    const readAdmission = vi.fn(() => decision(true));
    const pending = new WeakMap<object, ReturnType<typeof runMarginalAdmissionRetry>>();

    await Promise.all([
      coalesceMarginalAdmissionRetry(pending, { id: 1 }, { reclaim, sleep: async () => {}, readAdmission, delayMs: 1 }),
      coalesceMarginalAdmissionRetry(pending, { id: 2 }, { reclaim, sleep: async () => {}, readAdmission, delayMs: 1 }),
    ]);

    expect(reclaim).toHaveBeenCalledTimes(2);
  });

  it('clears the latch after settling so a later request reclaims again', async () => {
    let blocked = true;
    const reclaim = vi.fn(async () => []);
    const readAdmission = vi.fn(() => decision(!blocked ? true : false));
    const pending = new WeakMap<object, ReturnType<typeof runMarginalAdmissionRetry>>();
    const key = { session: 's2' };

    const first = await coalesceMarginalAdmissionRetry(pending, key, {
      reclaim, sleep: async () => {}, readAdmission, delayMs: 1,
    });
    expect(first.result).toBe('still_blocked');

    blocked = false;
    const second = await coalesceMarginalAdmissionRetry(pending, key, {
      reclaim, sleep: async () => {}, readAdmission, delayMs: 1,
    });
    expect(second.result).toBe('allowed');
    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(readAdmission).toHaveBeenCalledTimes(2);
  });
});
