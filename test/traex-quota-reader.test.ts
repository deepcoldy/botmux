import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTraexModelQuotas } from '../src/services/traex-quota.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('bounded native quota reader', () => {
  let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
  let callback: (error: Error | null, stdout: string) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      callback = args[3] as typeof callback;
      return child;
    }) as typeof execFile);
  });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('parses a successful catalog and leaves no timeout behind', async () => {
    const result = readTraexModelQuotas({ cliBin: '/fake/traex' });
    callback(null, JSON.stringify({ models: [{ slug: 'first', business_metadata: {
      internal_daily_usage: { isDepleted: false },
    } }] }));
    expect(await result).toEqual(new Map([['first', { depleted: false }]]));
    await vi.runAllTimersAsync();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it.each(['invalid-json', 'process-error'])('returns unknown for %s', failure => {
    const result = readTraexModelQuotas({ cliBin: '/fake/traex' });
    callback(failure === 'process-error' ? new Error('failed') : null, 'not json');
    return expect(result).resolves.toBeNull();
  });
  it('settles at the deadline and escalates when the child ignores SIGTERM', async () => {
    const result = readTraexModelQuotas({ cliBin: '/fake/traex' });
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(settled).toHaveBeenCalledExactlyOnceWith(null);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    callback(null, JSON.stringify({ models: [] }));
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
  });
  it('cancels escalation when the child exits after SIGTERM', async () => {
    const result = readTraexModelQuotas({ cliBin: '/fake/traex' });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(await result).toBeNull();
  });
});
