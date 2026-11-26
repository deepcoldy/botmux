import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetSupervisor } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const dirs: string[] = [];
const hosts: ChildProcess[] = [];
const strayPids: number[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-maintenance-'));
  dirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function observeExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('maintenance host did not exit after its stop request'));
    }, 5000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

interface Fixture {
  controlPath: string;
  host: ChildProcess;
  launchesPath: string;
  statePath: string;
}

function startMaintenanceHost(mode: 'run' | 'stopAll' | 'stopOneBot'): Fixture {
  const root = tmp();
  const dataDir = join(root, 'data');
  const distDir = join(root, 'dist');
  mkdirSync(dataDir);
  mkdirSync(distDir);
  const statePath = join(root, 'fleet.json');
  const controlPath = join(dataDir, 'feedback-maintenance.json');
  const launchesPath = join(root, 'launches');
  writeFileSync(controlPath, JSON.stringify({
    migrationId: 'test', state: 'frozen', generation: 1, participants: [], blockers: [],
  }));
  writeFileSync(join(distDir, 'index-daemon.js'), `
require('fs').appendFileSync(${JSON.stringify(launchesPath)}, String(process.pid) + '\\n');
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
`);
  const host = spawnTsScript(resolve('test/fixtures/fleet-supervisor-maintenance-host.ts'),
    [statePath, distDir, root, dataDir, mode], { stdio: 'ignore' });
  hosts.push(host);
  return { controlPath, host, launchesPath, statePath };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    try { host.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const pid of strayPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FleetSupervisor maintenance deferral lifecycle', () => {
  it('keeps a single-member supervisor alive and launches its daemon after maintenance', async () => {
    const fixture = startMaintenanceHost('run');
    expect(await waitFor(() => readFleetState(fixture.statePath)?.procs[0]?.status === 'launching')).toBe(true);

    // Cross a full deferral interval while maintenance remains active. With an
    // unref'd deferral timer this dedicated host has already exited with code 0.
    await delay(1250);
    expect(fixture.host.exitCode).toBeNull();
    expect(fixture.host.signalCode).toBeNull();
    expect(existsSync(fixture.launchesPath)).toBe(false);

    unlinkSync(fixture.controlPath);
    expect(await waitFor(() => {
      const proc = readFleetState(fixture.statePath)?.procs[0];
      return proc?.status === 'online' && proc.pid > 1;
    })).toBe(true);
    const proc = readFleetState(fixture.statePath)!.procs[0];
    strayPids.push(proc.pid);
    // The supervisor persists the child PID before the child finishes booting.
    expect(await waitFor(() => existsSync(fixture.launchesPath)
      && readFileSync(fixture.launchesPath, 'utf8').trim() === String(proc.pid))).toBe(true);
  });

  it.each(['stopAll', 'stopOneBot'] as const)('%s cancels a pending deferral and exits without a timer leak', async mode => {
    const fixture = startMaintenanceHost(mode);
    const exited = observeExit(fixture.host);

    // The unref'd stop trigger cannot prop up the host. A ref'd deferral timer
    // keeps it alive until the stop runs; cancelling that timer then lets the
    // process drain naturally instead of hanging until the next retry.
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(readFleetState(fixture.statePath)!.procs[0]).toMatchObject({ status: 'stopped', pid: 0 });
    if (mode === 'stopAll') expect(readFleetState(fixture.statePath)!.supervisorPid).toBe(0);
    expect(existsSync(fixture.launchesPath)).toBe(false);
    expect(existsSync(fixture.controlPath)).toBe(true);
  });

  it.each(['stopAll', 'stopOneBot'] as const)('%s clears the deferral timer synchronously', async mode => {
    const root = tmp();
    const dataDir = join(root, 'data');
    const distDir = join(root, 'dist');
    mkdirSync(dataDir);
    mkdirSync(distDir);
    const statePath = join(root, 'fleet.json');
    writeFileSync(join(dataDir, 'feedback-maintenance.json'), JSON.stringify({
      migrationId: 'test', state: 'frozen', generation: 1, participants: [], blockers: [],
    }));
    const sup = new FleetSupervisor({
      statePath, distDir, daemonEnv: { SESSION_DATA_DIR: dataDir }, cwd: root, log: () => {},
    });
    sup.start([]);
    vi.useFakeTimers();
    try {
      sup.startOneBot({ name: 'botmux-0', appId: 'cli_a', botIndex: 0 });
      expect(vi.getTimerCount()).toBe(1);
      if (mode === 'stopAll') await sup.stopAll();
      else await sup.stopOneBot('botmux-0');
      expect(vi.getTimerCount()).toBe(0);
      expect(readFleetState(statePath)!.procs[0]).toMatchObject({ status: 'stopped', pid: 0 });
    } finally {
      vi.useRealTimers();
      await sup.stopAll();
    }
  });
});
