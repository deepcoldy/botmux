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

function writeDesc(larkAppId: string, port: number, hbAgo = 0) {
  writeFileSync(join(dir, `${larkAppId}.json`), JSON.stringify({
    larkAppId, botName: larkAppId, botIndex: 0, ipcPort: port,
    pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now() - hbAgo,
  }));
}

describe('DaemonRegistry', () => {
  it('reads existing legacy descriptors as lark instances', async () => {
    writeDesc('appA', 7892);
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.list().length).toBe(1);
    expect(reg.getByAppId('appA')?.ipcPort).toBe(7892);
    expect(reg.getByRef({ platform: 'lark', instanceId: 'appA' })).toEqual(expect.objectContaining({
      platform: 'lark',
      instanceId: 'appA',
      larkAppId: 'appA',
    }));
    reg.stop();
  });

  it('prefers explicit generic identity fields and exposes capabilities', async () => {
    writeFileSync(join(dir, 'generic.json'), JSON.stringify({
      platform: 'lark',
      instanceId: 'explicit-instance',
      larkAppId: 'explicit-instance',
      capabilities: { cards: true, reactions: false },
      botName: 'Generic bot',
      botIndex: 3,
      ipcPort: 7894,
      pid: 44,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }));

    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.getByRef({ platform: 'lark', instanceId: 'explicit-instance' })).toEqual(expect.objectContaining({
      larkAppId: 'explicit-instance',
      capabilities: { cards: true, reactions: false },
    }));
    expect(reg.getByAppId('explicit-instance')?.instanceId).toBe('explicit-instance');
    reg.stop();
  });

  it('keys registry entries by platform and instance id without collisions', async () => {
    const common = {
      instanceId: 'same-instance',
      botIndex: 0,
      pid: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    writeFileSync(join(dir, 'lark.json'), JSON.stringify({
      ...common,
      platform: 'lark',
      larkAppId: 'same-instance',
      botName: 'Lark bot',
      ipcPort: 7895,
    }));
    writeFileSync(join(dir, 'discord.json'), JSON.stringify({
      ...common,
      platform: 'discord',
      larkAppId: 'discord-compat',
      botName: 'Discord bot',
      ipcPort: 7896,
    }));

    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.list()).toHaveLength(1);
    expect(reg.listAll()).toHaveLength(2);
    expect(reg.getByRef({ platform: 'lark', instanceId: 'same-instance' })?.ipcPort).toBe(7895);
    expect(reg.getByRef({ platform: 'discord', instanceId: 'same-instance' })?.ipcPort).toBe(7896);
    expect(reg.getByAppId('same-instance')?.ipcPort).toBe(7895);
    expect(reg.getByAppId('discord-compat')).toBeUndefined();
    reg.stop();
  });

  it('rejects split-brain Lark descriptors whose generic and legacy ids differ', async () => {
    writeFileSync(join(dir, 'split.json'), JSON.stringify({
      platform: 'lark', instanceId: 'generic-id', larkAppId: 'legacy-id',
      botName: 'Split bot', botIndex: 0, ipcPort: 7899, pid: 1,
      startedAt: Date.now(), lastHeartbeat: Date.now(),
    }));
    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.listAll()).toEqual([]);
    reg.stop();
  });

  it('skips malformed descriptor records', async () => {
    writeFileSync(join(dir, 'bad-json.json'), '{');
    writeFileSync(join(dir, 'missing-id.json'), JSON.stringify({
      botName: 'Missing identity', botIndex: 0, ipcPort: 7897,
      pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(dir, 'bad-capability.json'), JSON.stringify({
      platform: 'lark', instanceId: 'bad', capabilities: { cards: 'yes' },
      botName: 'Bad capability', botIndex: 0, ipcPort: 7898,
      pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(dir, 'bad-runtime.json'), JSON.stringify({
      larkAppId: 'bad-runtime', botName: 'Bad runtime', botIndex: 0, ipcPort: -1,
      pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now(),
    }));

    const reg = new DaemonRegistry(dir);
    await reg.start();
    expect(reg.list()).toEqual([]);
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
