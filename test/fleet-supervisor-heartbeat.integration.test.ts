import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetSupervisor, pidAlive } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';

const dirs: string[] = [];
const pids: number[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    if (pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FleetSupervisor daemon event-loop watchdog', () => {
  it('retries a stalled daemon when ChildProcess.kill reports that SIGKILL was not accepted', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-supervisor-kill-retry-'));
    dirs.push(root);
    const kill = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const child = { pid: 42_424, killed: false, kill };
    const sup = new FleetSupervisor({
      statePath: join(root, 'fleet.json'),
      distDir: join(root, 'dist'),
      daemonEnv: { SESSION_DATA_DIR: root },
      cwd: root,
      heartbeat: {
        dataDir: root,
        scanIntervalMs: 20,
        staleMs: 50,
        startupGraceMs: 10,
      },
      log: () => {},
    });
    const internal = sup as any;
    internal.children.set('botmux-0', child);
    internal.knownSpecs.set('botmux-0', {
      name: 'botmux-0', appId: 'cli_hb', botIndex: 0,
    });
    internal.childStartedAtMs.set('botmux-0', 0);

    internal.scanDaemonHeartbeats(1_000);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(internal.heartbeatKillInFlight.has('botmux-0')).toBe(false);

    internal.scanDaemonHeartbeats(1_001);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(internal.heartbeatKillInFlight.has('botmux-0')).toBe(true);
  });

  it('SIGKILLs and crash-restarts a live daemon whose heartbeat stops advancing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-supervisor-heartbeat-'));
    dirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    const body = `
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = path.join(process.env.SESSION_DATA_DIR, 'heartbeats');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cli_hb.json'), JSON.stringify({
        larkAppId: 'cli_hb', busyCount: 0, at: new Date().toISOString(), pid: process.pid,
      }));
      process.on('SIGTERM', () => process.exit(90));
      setInterval(() => {}, 1000);
    `;
    writeFileSync(join(dist, 'index-daemon.js'), body);
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath,
      distDir: dist,
      daemonEnv: { SESSION_DATA_DIR: root },
      cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 },
      heartbeat: {
        dataDir: root,
        scanIntervalMs: 20,
        staleMs: 80,
        startupGraceMs: 40,
      },
      log: () => {},
    });

    try {
      sup.start([{ name: 'botmux-0', appId: 'cli_hb', botIndex: 0 }]);
      expect(await waitFor(() => existsSync(join(root, 'heartbeats', 'cli_hb.json')))).toBe(true);
      const first = readFleetState(statePath)!.procs[0];
      pids.push(first.pid);

      const restarted = await waitFor(() => {
        const current = readFleetState(statePath)?.procs[0];
        return !!current
          && current.status === 'online'
          && current.generation >= 2
          && current.pid > 1
          && current.pid !== first.pid;
      });
      expect(restarted).toBe(true);
      const currentPid = readFleetState(statePath)!.procs[0].pid;
      pids.push(currentPid);
      expect(pidAlive(first.pid)).toBe(false);
      expect(pidAlive(currentPid)).toBe(true);
    } finally {
      // Stop the scanner/children before afterEach removes the heartbeat root;
      // otherwise a failed assertion can race a live interval against rmSync.
      await sup.stopAll();
    }
  });

  it('excludes dashboard members that do not own daemon heartbeat files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-supervisor-dashboard-heartbeat-'));
    dirs.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index-dashboard.js'), 'setInterval(() => {}, 1000);');
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath,
      distDir: dist,
      daemonEnv: { SESSION_DATA_DIR: root },
      cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 },
      heartbeat: {
        dataDir: root,
        scanIntervalMs: 20,
        staleMs: 50,
        startupGraceMs: 30,
      },
      log: () => {},
    });

    try {
      sup.start([{ name: 'botmux-dashboard', appId: 'dashboard', botIndex: -1, entry: 'dashboard' }]);
      const initial = readFleetState(statePath)!.procs[0];
      pids.push(initial.pid);
      await delay(150);
      const current = readFleetState(statePath)!.procs[0];
      expect(current.pid).toBe(initial.pid);
      expect(current.generation).toBe(initial.generation);
      expect(current.status).toBe('online');
      expect(pidAlive(current.pid)).toBe(true);
    } finally {
      await sup.stopAll();
    }
  });
});
