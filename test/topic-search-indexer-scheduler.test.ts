import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createIndexerScheduler,type IndexerSchedulerOptions } from '../src/services/topic-search/indexer-scheduler.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
function fixture(sync = vi.fn<IndexerSchedulerOptions['sync']>().mockResolvedValue(undefined)) {
  const changes = new Map<string,(name?: string) => void>();
  const failures = new Map<string,() => void>();
  const closed = new Set<string>();
  const available = new Set(['','queues','turn-sends','group-context','output-delivery-journals']);
  const errors = vi.fn();
  const parent = { pid: 42 };
  const parentLost = vi.fn();
  const scheduler = createIndexerScheduler({
    clock: { setTimeout: (callback,delay) => setTimeout(callback,delay),clearTimeout: timer => clearTimeout(timer) },
    watch(path,changed,failed) {
      if (!available.has(path)) return undefined;
      changes.set(path,changed); failures.set(path,failed);
      return { close: () => { closed.add(path); } };
    },sync,onError: errors,parentPid: 42,readParentPid: () => parent.pid,onParentLost: parentLost,
  });
  return { scheduler,sync,changes,failures,closed,available,errors,parent,parentLost };
}

describe('topic indexer scheduling', () => {
  it('exits before starting another synchronization after its parent disappears', async () => {
    const f = fixture(); f.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    f.parent.pid = 1; f.changes.get('queues')?.('om_after_parent.jsonl');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.parentLost).toHaveBeenCalledTimes(1); expect(f.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.sync).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    await f.scheduler.stop();
  });
  it('starts with a full check and throttles continuous writes without indefinitely delaying synchronization', async () => {
    const f = fixture(); f.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.sync.mock.calls[0][0].paths).toBeUndefined();
    for (let i=0;i<6;i++) { f.changes.get('queues')?.('om_root.jsonl'); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.sync.mock.calls.filter(call => call[0].paths?.includes('queues/om_root.jsonl')).length).toBeGreaterThanOrEqual(3);
    await f.scheduler.stop();
  });
  it('throttles pending changes after an active synchronization finishes', async () => {
    let release: (() => void) | undefined;
    const sync = vi.fn<IndexerSchedulerOptions['sync']>().mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const f = fixture(sync); f.scheduler.start();
    f.changes.get('output-delivery-journals')?.('cli_app.db-wal');
    expect(sync).toHaveBeenCalledTimes(1);
    release?.(); await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[1][0].paths).toEqual(['output-delivery-journals/cli_app.db']);
    await f.scheduler.stop();
  });
  it('checks all sources after a missed event and attaches directories that appear later', async () => {
    const f = fixture(); f.available.delete('group-context');
    f.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.changes.has('group-context')).toBe(false);
    f.available.add('group-context'); f.changes.get('')?.('group-context');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.changes.has('group-context')).toBe(true);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(f.sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.sync.mock.calls.at(-1)?.[0].paths).toBeUndefined();
    expect(f.sync).toHaveBeenCalledTimes(3);
    await f.scheduler.stop();
  });
  it('ignores unrelated root events and temporary filenames, but checks all sources without a filename', async () => {
    const f = fixture(); f.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    f.changes.get('')?.('botmux-feedback.sqlite-wal');
    f.changes.get('')?.();
    f.changes.get('queues')?.('temporary.tmp');
    f.changes.get('queues')?.('');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.sync).toHaveBeenCalledTimes(1);
    f.changes.get('queues')?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(f.sync.mock.calls[1][0].paths).toBeUndefined();
    await f.scheduler.stop();
  });
  it('reports a failed synchronization and recovers on a later change or fallback', async () => {
    const sync = vi.fn<IndexerSchedulerOptions['sync']>().mockResolvedValue(undefined).mockRejectedValueOnce(new Error('broken source'));
    const f = fixture(sync); f.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.errors).toHaveBeenCalledTimes(1);
    f.failures.get('queues')?.(); await vi.advanceTimersByTimeAsync(2000);
    expect(sync).toHaveBeenCalledTimes(2);
    await f.scheduler.stop();
  });
  it('stops watches and timers, asks the current page to stop, and starts no more work after shutdown', async () => {
    let release: (() => void) | undefined;
    const sync = vi.fn<IndexerSchedulerOptions['sync']>().mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const f = fixture(sync); f.scheduler.start();
    const current = sync.mock.calls[0][0]; expect(current.shouldStop()).toBe(false);
    const stopped = f.scheduler.stop(); expect(current.shouldStop()).toBe(true);
    f.changes.get('queues')?.('om_late.jsonl'); release?.(); await stopped;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).toHaveBeenCalledTimes(1); expect(f.closed.size).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
