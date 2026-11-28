import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferBytedcliWorkerRetirement, __testOnly_resetBytedcliWorkerRetirement } from '../src/core/bytedcli-worker-retirement.js';

afterEach(() => __testOnly_resetBytedcliWorkerRetirement());

describe('strict replacement retirement gate', () => {
  it('deduplicates a pending generation and releases its continuation only after cleanup', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const retire = vi.fn(() => cleanup), continued = vi.fn(), failed = vi.fn();
    const input = { sessionId: 's', workerGeneration: 3, strict: true, retire, continue: continued, fail: failed };
    expect(deferBytedcliWorkerRetirement(input)).toBe(true);
    expect(deferBytedcliWorkerRetirement({ ...input, continue: vi.fn() })).toBe(true);
    expect(retire).toHaveBeenCalledTimes(0);
    await Promise.resolve(); expect(retire).toHaveBeenCalledTimes(1);
    expect(continued).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(1));
    expect(failed).not.toHaveBeenCalled();
    // The completed generation is consumed once; a new generation needs its own cleanup.
    expect(deferBytedcliWorkerRetirement(input)).toBe(false);
    expect(deferBytedcliWorkerRetirement({ ...input, workerGeneration: 4 })).toBe(true);
    await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(2));
  });

  it('fails the current spawn without continuing and permits an explicit retry', async () => {
    const continued = vi.fn(), failed = vi.fn();
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 7, strict: true,
      retire: async () => { throw new Error('cleanup failed'); }, continue: continued, fail: failed })).toBe(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(continued).not.toHaveBeenCalled();
    const retried = deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 7, strict: true,
      retire: async () => undefined, continue: continued, fail: failed });
    expect(retried).toBe(true);
    await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(1));
  });
});
