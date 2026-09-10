import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({
  cgroup: '0::/user.slice/app.slice/botmux-session-test.scope\n',
  spawn: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
  run: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: io.spawn, spawnSync: io.run,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
    args[0] === '/proc/self/cgroup' ? io.cgroup : actual.readFileSync(...args) };
});

describe('fleet isolation from a closing session scope', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-isolation-'));
    mkdirSync(join(home, '.botmux'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_SESSION_ID', 'test');
    vi.stubEnv('FLEET_TEST_SECRET', 'private value');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    io.cgroup = '0::/user.slice/app.slice/botmux-session-test.scope\n';
    io.spawn.mockClear();
    io.run.mockReset().mockImplementation((_command, args) => ({
      status: 0, stdout: args.includes('--property=MainPID') ? '5432\n' : '', stderr: '',
    }));
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    '0::/user.slice/app.slice/botmux-session-test.scope\n',
    '1:name=systemd:/user.slice/app.slice/botmux-session-test.scope\n',
    '0::/user.slice/app.slice/botmux-supervisor-old.service\n',
  ])('starts the supervisor outside its caller cgroup: %s', async (cgroup) => {
    io.cgroup = cgroup;
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');
    expect(startFleetViaSupervisor().supervisorPid).toBe(5432);
    expect(io.spawn).not.toHaveBeenCalled();
    const launch = io.run.mock.calls.find(([command, args]) => command === 'systemd-run' && args.includes('--service-type=exec'));
    expect(launch).toBeDefined();
    expect(launch![1]).toContain('--service-type=exec');
    // The supervisor itself reaps daemons. Killing the whole service cgroup
    // would also kill a maintenance restart driver before it can start a successor.
    expect(launch![1]).toContain('--property=KillMode=process');
    expect(launch![1]).toContain('--setenv=FLEET_TEST_SECRET');
    expect(launch![1].join(' ')).not.toContain('private value');
    expect(launch![2].env.FLEET_TEST_SECRET).toBe('private value');
  });

  it('refuses an unsafe fallback when service launch fails', async () => {
    io.run.mockImplementation((command, args) => ({ status: command === 'systemd-run' && args.includes('--service-type=exec') ? 1 : 0, stdout: '', stderr: 'unavailable' }));
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');
    expect(() => startFleetViaSupervisor()).toThrow(/supervisor/i);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.run.mock.calls.some(([command, args]) => command === 'systemctl' && args.includes('stop'))).toBe(true);
  });

  it('cleans up the attempted unit if MainPID cannot be read', async () => {
    io.run.mockImplementation((_command, args) => args.includes('--property=MainPID')
      ? { status: null, stdout: null, stderr: null, error: new Error('spawn failed') }
      : { status: 0, stdout: '', stderr: '' });
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');
    expect(() => startFleetViaSupervisor()).toThrow(/no live MainPID/);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.run.mock.calls.some(([command, args]) => command === 'systemctl' && args.includes('stop'))).toBe(true);
  });

  it('checks the user manager before stopping the live fleet', async () => {
    writeFileSync(join(home, '.botmux/fleet-state.json'), JSON.stringify({ supervisorPid: process.pid, procs: [] }));
    io.run.mockReturnValue({ status: 1, stdout: '', stderr: 'bus unavailable' });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { restartFleet } = await import('../src/core/fleet-runtime.js');
    expect(() => restartFleet({ timeoutMs: 0 })).toThrow(/supervisor/i);
    expect(kill.mock.calls.filter(([, signal]) => signal && signal !== 0)).toEqual([]);
  });

  it.each(['0::/user.slice/app.slice/botmux.service\n', '0::/user.slice/session-123.scope\n'])('preserves ordinary terminal/service startup: %s', async (cgroup) => {
    io.cgroup = cgroup;
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');
    expect(startFleetViaSupervisor().supervisorPid).toBe(4321);
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(io.run).not.toHaveBeenCalled();
  });

  it('preserves macOS startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');
    expect(startFleetViaSupervisor().supervisorPid).toBe(4321);
    expect(io.run).not.toHaveBeenCalled();
  });
});
