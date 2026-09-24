import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonRegistry } from '../src/dashboard/registry.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-reg-'));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function writeDesc(larkAppId: string, port: number, hbAgo = 0, bootInstanceId?: string) {
  writeFileSync(join(dir, `${larkAppId}.json`), JSON.stringify({
    larkAppId, botName: larkAppId, botIndex: 0, ipcPort: port,
    pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now() - hbAgo,
    ...(bootInstanceId ? { bootInstanceId } : {}),
    ...(bootInstanceId ? { workflowIpcProtocol: 'v1' } : {}),
  }));
}

describe('DaemonRegistry', () => {
  it('reads existing descriptors on start', async () => {
    const bootInstanceId = 'B'.repeat(43);
    writeDesc('appA', 7892, 0, bootInstanceId);
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.list().length).toBe(1);
    expect(reg.getByAppId('appA')?.ipcPort).toBe(7892);
    expect(reg.getByAppId('appA')?.bootInstanceId).toBe(bootInstanceId);
    expect(reg.getByAppId('appA')?.workflowIpcProtocol).toBe('v1');
    reg.stop();
  });

  it('treats descriptor older than 90s as stale (excluded)', async () => {
    writeDesc('appOld', 7893, 95_000);
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.getByAppId('appOld')).toBeUndefined();
    reg.stop();
  });

  it('returns empty list when directory is missing or empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'botmux-reg-empty-'));
    const reg = new DaemonRegistry(empty);
    await reg.start();
    expect(reg.list()).toEqual([]);
    reg.stop();
    rmSync(empty, { recursive: true, force: true });
  });

  it('coalesces a burst of watch events into one refresh per window', async () => {
    // 55 daemons heartbeating together = ~220 watch events in a few seconds;
    // refreshing on each one re-read every descriptor ~220 times (measured
    // ~12,000 synchronous reads per burst on the dashboard's event loop).
    vi.useFakeTimers();
    writeDesc('appA', 7892);
    const reg = new DaemonRegistry(dir, { refreshIntervalMs: 0, watchDebounceMs: 250 });
    await reg.start();
    const refresh = vi.spyOn(reg as unknown as { refresh(): void }, 'refresh');
    const onWatchEvent = () => (reg as unknown as { scheduleWatchRefresh(): void }).scheduleWatchRefresh();

    for (let i = 0; i < 50; i++) onWatchEvent();
    expect(refresh).not.toHaveBeenCalled();     // nothing yet: the window is open

    writeDesc('appB', 7893);                    // a change landing inside the window…
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(1);   // …is picked up by the single coalesced refresh
    expect(reg.list().map(d => d.larkAppId).sort()).toEqual(['appA', 'appB']);

    // A second burst after the window closes gets its own refresh.
    for (let i = 0; i < 10; i++) onWatchEvent();
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
    reg.stop();
  });

  it('refreshes on every watch event when the coalescing window is disabled', async () => {
    vi.useFakeTimers();
    writeDesc('appA', 7892);
    const reg = new DaemonRegistry(dir, { refreshIntervalMs: 0, watchDebounceMs: 0 });
    await reg.start();
    const refresh = vi.spyOn(reg as unknown as { refresh(): void }, 'refresh');
    for (let i = 0; i < 5; i++) (reg as unknown as { scheduleWatchRefresh(): void }).scheduleWatchRefresh();
    expect(refresh).toHaveBeenCalledTimes(5);
    reg.stop();
  });

  it('polls descriptors so missed fs.watch heartbeat updates do not mark daemons stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    writeDesc('appA', 7892);

    const reg = new DaemonRegistry(dir, { refreshIntervalMs: 1_000 });
    await reg.start();

    // Simulate a platform where fs.watch misses the daemon's atomic descriptor rewrite.
    (reg as unknown as { watcher?: { close(): void } }).watcher?.close();

    expect(reg.list().length).toBe(1);

    vi.setSystemTime(95_000);
    expect(reg.list()).toEqual([]);

    writeDesc('appA', 7892);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reg.list().length).toBe(1);
    expect(reg.getByAppId('appA')?.ipcPort).toBe(7892);
    reg.stop();
  });
});
