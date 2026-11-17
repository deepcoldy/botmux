import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTraexCatalogWithRetry } from '../src/services/traex-model-catalog-retry.js';

afterEach(() => vi.useRealTimers());
const snapshot = { loads: new Map<string, number>(), reasoningEfforts: new Map(),
  catalogModels: new Set(['core']) };

describe('bounded TraeX catalog flow', () => {
  it('retries at 30-second intervals and stops after three failed reads', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => null);
    const wait = vi.fn((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const done = readTraexCatalogWithRetry({ read, isCurrent: () => true, wait });
    // Establish the first failed-read boundary before advancing the clock.
    // Bun need not drain that promise before moving fake time by 29,999ms.
    await read.mock.results[0]!.value;
    expect(wait).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await read.mock.results[1]!.value;
    expect(wait).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('returns a successful catalog even when every load is unknown', async () => {
    const read = vi.fn(async () => snapshot);
    expect(await readTraexCatalogWithRetry({ read, isCurrent: () => true })).toBe(snapshot);
    expect(read).toHaveBeenCalledOnce();
  });

  it('counts an already failed startup read toward the same three-attempt budget', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => null);
    const done = readTraexCatalogWithRetry({ read, isCurrent: () => true, firstReadFailed: true });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not issue another read after cancellation during the waiting window', async () => {
    vi.useFakeTimers();
    let current = true;
    const read = vi.fn(async () => null);
    const done = readTraexCatalogWithRetry({ read, isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(1);
    current = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('discards an in-flight result from a superseded generation', async () => {
    let finish!: (value: typeof snapshot) => void;
    let current = true;
    const done = readTraexCatalogWithRetry({
      read: () => new Promise(resolve => { finish = resolve; }), isCurrent: () => current,
    });
    current = false;
    finish(snapshot);
    expect(await done).toBeNull();
  });
});
