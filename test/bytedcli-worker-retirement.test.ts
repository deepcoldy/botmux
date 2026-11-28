import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytedcliWorkerRetirementPending, deferBytedcliWorkerRetirement, __testOnly_resetBytedcliWorkerRetirement } from '../src/core/bytedcli-worker-retirement.js';

afterEach(() => __testOnly_resetBytedcliWorkerRetirement());

describe('strict replacement retirement gate', () => {
  it('rejects duplicate work without replacing the pending cleanup and settles the original successor', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const retire = vi.fn(() => cleanup), continued = vi.fn(), failed = vi.fn();
    const input = { sessionId: 's', workerGeneration: 3, strict: true, retire, continue: continued, fail: failed };
    expect(deferBytedcliWorkerRetirement(input)).toBe(true);
    expect(bytedcliWorkerRetirementPending('s')).toBe(true);
    expect(deferBytedcliWorkerRetirement({ ...input, continue: vi.fn() })).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledTimes(0);
    await Promise.resolve(); expect(retire).toHaveBeenCalledTimes(1);
    expect(continued).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(1));
    expect(bytedcliWorkerRetirementPending('s')).toBe(false);
    expect(deferBytedcliWorkerRetirement(input)).toBe(true);
    await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(2));
  });

  it('does not let a later generation overwrite an unfinished retirement', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const firstRetire = vi.fn(() => cleanup), secondRetire = vi.fn(async () => undefined);
    const firstContinue = vi.fn(), secondContinue = vi.fn(), firstFail = vi.fn(), secondFail = vi.fn();
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 1, strict: true,
      retire: firstRetire, continue: firstContinue, fail: firstFail })).toBe(true);
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 2, strict: true,
      retire: secondRetire, continue: secondContinue, fail: secondFail })).toBe(true);
    expect(secondFail).toHaveBeenCalledTimes(1);
    await Promise.resolve(); expect(firstRetire).toHaveBeenCalledTimes(1);
    expect(secondRetire).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(firstContinue).toHaveBeenCalledTimes(1));
    expect(secondContinue).not.toHaveBeenCalled();
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 2, strict: true,
      retire: secondRetire, continue: secondContinue, fail: secondFail })).toBe(true);
    await vi.waitFor(() => expect(secondContinue).toHaveBeenCalledTimes(1));
  });

  it('fails the current spawn without continuing and permits an explicit retry', async () => {
    const continued = vi.fn(), failed = vi.fn();
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 7, strict: true,
      retire: async () => { throw new Error('cleanup failed'); }, continue: continued, fail: failed })).toBe(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(continued).not.toHaveBeenCalled();
    expect(deferBytedcliWorkerRetirement({ sessionId: 's', workerGeneration: 7, strict: true,
      retire: async () => undefined, continue: continued, fail: failed })).toBe(true);
    await vi.waitFor(() => expect(continued).toHaveBeenCalledTimes(1));
  });
});
