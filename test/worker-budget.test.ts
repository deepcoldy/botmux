import { describe, expect, it } from 'vitest';

import { autoMaxLiveWorkers, resolveWorkerBudget } from '../src/core/worker-budget.js';

const gib = (n: number) => n * 1024 ** 3;

describe('resolveWorkerBudget', () => {
  it('derives the default live-worker budget from CPU and memory', () => {
    expect(resolveWorkerBudget(undefined, { cpuCount: 4, memoryBytes: gib(8) }).maxLiveWorkers).toBe(8);
    expect(resolveWorkerBudget(undefined, { cpuCount: 8, memoryBytes: gib(16) }).maxLiveWorkers).toBe(16);
    expect(resolveWorkerBudget(undefined, { cpuCount: 64, memoryBytes: gib(128) }).maxLiveWorkers).toBe(32);
  });

  it('splits the machine budget across daemons sharing the box', () => {
    const box = { cpuCount: 56, memoryBytes: gib(110) };
    // Single daemon: clamp(min(112, 110)) = 32 — unchanged legacy behavior.
    expect(autoMaxLiveWorkers(box)).toBe(32);
    expect(autoMaxLiveWorkers(box, 1)).toBe(32);
    // Six daemons (one bot each): floor(110 / 6) = 18 per daemon.
    expect(autoMaxLiveWorkers(box, 6)).toBe(18);
    expect(resolveWorkerBudget(undefined, box, 6).maxLiveWorkers).toBe(18);
    // The per-daemon share never drops below the MIN floor…
    expect(autoMaxLiveWorkers(box, 100)).toBe(4);
    // …and a bogus count is treated as a single daemon.
    expect(autoMaxLiveWorkers(box, 0)).toBe(32);
  });

  it('keeps an explicit maxLiveWorkers override per-daemon (not split)', () => {
    const resolved = resolveWorkerBudget({ maxLiveWorkers: 12 }, { cpuCount: 56, memoryBytes: gib(110) }, 6);
    expect(resolved.maxLiveWorkers).toBe(12);
    expect(resolved.maxLiveWorkersSource).toBe('config');
    expect(resolved.autoMaxLiveWorkers).toBe(18);
  });

  it('lets global config override max live workers and idle threshold independently', () => {
    const resolved = resolveWorkerBudget(
      { maxLiveWorkers: 12, idleSuspendMs: 45 * 60_000 },
      { cpuCount: 4, memoryBytes: gib(8) },
    );

    expect(resolved).toEqual({
      maxLiveWorkers: 12,
      idleSuspendMs: 45 * 60_000,
      idleSuspendMode: 'budget',
      autoMaxLiveWorkers: 8,
      maxLiveWorkersSource: 'config',
      idleSuspendMsSource: 'config',
      idleSuspendModeSource: 'default',
    });
  });

  it('defaults idleSuspendMode to budget and honors a configured always', () => {
    const box = { cpuCount: 4, memoryBytes: gib(8) };
    const def = resolveWorkerBudget(undefined, box);
    expect(def.idleSuspendMode).toBe('budget');
    expect(def.idleSuspendModeSource).toBe('default');

    const always = resolveWorkerBudget({ idleSuspendMode: 'always' }, box);
    expect(always.idleSuspendMode).toBe('always');
    expect(always.idleSuspendModeSource).toBe('config');
    // Mode alone doesn't touch the numeric budget fields.
    expect(always.maxLiveWorkers).toBe(8);
    expect(always.maxLiveWorkersSource).toBe('auto');
  });
});
