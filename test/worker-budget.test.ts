import { describe, expect, it } from 'vitest';

import { resolveWorkerBudget } from '../src/core/worker-budget.js';

const gib = (n: number) => n * 1024 ** 3;

describe('resolveWorkerBudget', () => {
  it('derives the default live-worker budget from CPU and memory', () => {
    expect(resolveWorkerBudget(undefined, { cpuCount: 4, memoryBytes: gib(8) }).maxLiveWorkers).toBe(8);
    expect(resolveWorkerBudget(undefined, { cpuCount: 8, memoryBytes: gib(16) }).maxLiveWorkers).toBe(16);
    expect(resolveWorkerBudget(undefined, { cpuCount: 64, memoryBytes: gib(128) }).maxLiveWorkers).toBe(32);
  });

  it('lets global config override max live workers and idle threshold independently', () => {
    const resolved = resolveWorkerBudget(
      { maxLiveWorkers: 12, idleSuspendMs: 45 * 60_000 },
      { cpuCount: 4, memoryBytes: gib(8) },
    );

    expect(resolved).toEqual({
      maxLiveWorkers: 12,
      idleSuspendMs: 45 * 60_000,
      autoMaxLiveWorkers: 8,
      maxLiveWorkersSource: 'config',
      idleSuspendMsSource: 'config',
    });
  });
});
