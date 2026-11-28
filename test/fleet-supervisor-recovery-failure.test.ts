import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetSupervisor, pidAlive } from '../src/core/fleet-supervisor.js';
import { waitFleetOnline } from '../src/core/fleet-runtime.js';
import { freshProc, type FleetState } from '../src/core/fleet-supervisor-policy.js';
import { readFleetState, writeFleetState } from '../src/core/fleet-state-store.js';
import { readFleetDurableProcessIdentity } from '../src/utils/process-identity.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const fault = vi.hoisted(() => ({ path: '', pid: 0, transition: '', failed: false }));
// Inject one write failure at the real store's atomic-write boundary. The rest
// of locking, persistence, process identity and supervision remains real.
vi.mock('../src/utils/atomic-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/utils/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      if (args[0] === fault.path && !fault.failed) {
        const state = JSON.parse(String(args[1])) as FleetState;
        if (fault.transition === 'retire-drop'
          ? state.procs.length === 0
          : state.procs.some(p => fault.transition === 'admission'
            ? p.pid === fault.pid && p.status === 'launching'
            : p.name === 'botmux-old' && p.pid === 0 && p.status === 'stopped')) {
          fault.failed = true;
          throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
        }
      }
      return actual.atomicWriteFileSync(...args);
    },
  };
});

describe('fleet orphan retirement with a failed durable write', () => {
  it('retains a removed online daemon when the first retirement write fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-removed-write-failure-'));
    const statePath = join(root, 'fleet.json');
    const distDir = join(root, 'dist'); mkdirSync(distDir);
    const script = join(distDir, 'index-daemon.js');
    writeFileSync(script, "process.on('SIGTERM', () => process.exit(90)); setInterval(() => {}, 1000); console.log('ready');");
    const orphan = spawnTsScript(script, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sup = new FleetSupervisor({ statePath, distDir, cwd: root, daemonEnv: {}, log: () => {} });
    try {
      let output = '';
      for await (const data of orphan.stdout!) {
        output += data.toString();
        if (output.includes('ready')) break;
      }
      expect(output).toContain('ready');
      writeFleetState(statePath, { supervisorPid: 999_999, supervisorStartedAt: 'prior',
        procs: [freshProc('botmux-removed', 'cli_a', orphan.pid!, 'T')] });
      Object.assign(fault, { path: statePath, pid: orphan.pid!, transition: 'admission', failed: false });
      vi.useFakeTimers();
      sup.start([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(fault.failed).toBe(true);
      expect(readFleetState(statePath)!.procs).toMatchObject([{ pid: orphan.pid, status: 'launching' }]);
      expect(pidAlive(orphan.pid!)).toBe(true);
      sup.start([]);
      if (orphan.exitCode === null && orphan.signalCode === null) await once(orphan, 'exit');
      await vi.advanceTimersByTimeAsync(500);
      expect(readFleetState(statePath)!.procs).toEqual([]);
    } finally {
      fault.path = '';
      if (orphan.exitCode === null && orphan.signalCode === null) {
        const exited = once(orphan, 'exit'); orphan.kill('SIGKILL'); await exited;
      }
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
      await sup.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['admission', 'completion'])('recovers after one %s write fails without reporting an orphan healthy', async transition => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-write-failure-'));
    const statePath = join(root, 'fleet.json');
    const distDir = join(root, 'dist'); mkdirSync(distDir);
    const script = join(distDir, 'index-daemon.js');
    writeFileSync(script, "process.on('SIGTERM', () => process.exit(90)); setInterval(() => {}, 1000); console.log('ready');");
    const orphan = spawnTsScript(script, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sup = new FleetSupervisor({ statePath, distDir, cwd: root, daemonEnv: {}, log: () => {} });
    const spec = { name: 'botmux-renamed', appId: 'cli_a', botIndex: 0 };
    try {
      let output = '';
      for await (const data of orphan.stdout!) {
        output += data.toString();
        if (output.includes('ready')) break;
      }
      expect(output).toContain('ready');
      writeFleetState(statePath, { supervisorPid: 999_999, supervisorStartedAt: 'prior',
        procs: [freshProc('botmux-old', 'cli_a', orphan.pid!, 'T')] });
      Object.assign(fault, { path: statePath, pid: orphan.pid!, transition, failed: false });
      vi.useFakeTimers();
      sup.start([spec]);
      if (transition === 'admission') {
        await vi.advanceTimersByTimeAsync(500);
        expect(fault.failed).toBe(true);
        expect(waitFleetOnline([spec], 0, statePath).healthy).toBe(false);
        expect(readFleetState(statePath)!.procs[0].pid).toBe(orphan.pid);
        expect(pidAlive(orphan.pid!)).toBe(true);
        sup.start([spec]);
      }
      if (orphan.exitCode === null && orphan.signalCode === null) await once(orphan, 'exit');
      await vi.advanceTimersByTimeAsync(500);
      expect(fault.failed).toBe(true);
      expect(waitFleetOnline([spec], 0, statePath).healthy).toBe(true);
      expect(readFleetState(statePath)!.procs[0].pid).not.toBe(orphan.pid);
    } finally {
      fault.path = '';
      if (orphan.exitCode === null && orphan.signalCode === null) {
        const exited = once(orphan, 'exit'); orphan.kill('SIGKILL'); await exited;
      }
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
      await sup.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops an unconfigured recycled pid row in start() filter when retireUnowned completion write fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-recycled-filter-'));
    const statePath = join(root, 'fleet.json');
    const distDir = join(root, 'dist'); mkdirSync(distDir);
    const script = join(distDir, 'unrelated.js');
    writeFileSync(script, "setInterval(() => {}, 1000); console.log('ready');");
    const unrelated = spawnTsScript(script, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sup = new FleetSupervisor({ statePath, distDir, cwd: root, daemonEnv: {}, log: () => {} });
    try {
      let output = '';
      for await (const data of unrelated.stdout!) {
        output += data.toString();
        if (output.includes('ready')) break;
      }
      const currentIdentity = readFleetDurableProcessIdentity(unrelated.pid!);
      if (!currentIdentity) throw new Error('cannot read unrelated fixture identity');
      writeFleetState(statePath, {
        supervisorPid: 0, supervisorStartedAt: 'prior',
        procs: [{
          ...freshProc('botmux-plugin-recycled', '', unrelated.pid!, 'T'),
          processStart: `${currentIdentity}:recycled`,
        }],
      });
      Object.assign(fault, { path: statePath, pid: unrelated.pid!, transition: 'retire-drop', failed: false });
      sup.start([]);
      expect(fault.failed).toBe(true);
      expect(readFleetState(statePath)!.procs).toEqual([]);
      expect(pidAlive(unrelated.pid!)).toBe(true);
    } finally {
      fault.path = '';
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        const exited = once(unrelated, 'exit'); unrelated.kill('SIGKILL'); await exited;
      }
      await sup.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
