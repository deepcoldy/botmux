import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopPluginServices } from '../src/core/plugins/service-manager.js';
import { pluginSupervisorDir, pluginSupervisorDesiredPath, pluginSupervisorResultPath, pluginSupervisorStatePath } from '../src/core/plugins/supervisor-store.js';

const runtime = vi.hoisted(() => ({ identity: vi.fn(), zombie: vi.fn(), signal: vi.fn() }));
vi.mock('../src/utils/process-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/process-identity.js')>(),
  readDurableProcessIdentity: runtime.identity,
  isLinuxZombie: runtime.zombie,
}));
vi.mock('../src/core/fleet-process-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet-process-identity.js')>(),
  signalAttestedFleetProcess: runtime.signal,
}));

// Exercise the same service-manager seam used by the explicit CLI flag.
const stopAll = () => stopPluginServices(undefined, { shutdownSupervisor: true } as any);

describe('explicit plugin host shutdown failures', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-shutdown-'));
    vi.stubEnv('HOME', home);
    mkdirSync(pluginSupervisorDir(), { recursive: true });
    runtime.identity.mockReset().mockReturnValue('known-birth');
    runtime.zombie.mockReset().mockReturnValue(false);
    runtime.signal.mockReset().mockReturnValue(true); // never signal the test process
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const result = (extra: object = {}) => writeFileSync(pluginSupervisorResultPath(), JSON.stringify({
    revision: '', pid: process.pid, ...extra,
  }));
  const state = (value: object) => writeFileSync(pluginSupervisorStatePath(), JSON.stringify(value));

  it('does not accept a missing host with an outstanding running desired member', async () => {
    writeFileSync(pluginSupervisorDesiredPath(), JSON.stringify({ revision: 'pending', target: 'lost',
      services: { lost: { running: true, spec: { name: 'botmux-plugin-lost', external: { command: '/bin/echo' } } } },
    }));
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_incomplete');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('validates corrupt desired state even when the host has never published a result', async () => {
    writeFileSync(pluginSupervisorDesiredPath(), '[]');
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_invalid_desired_state');
  });
  it('rejects a live host without a recorded birth identity', async () => {
    result();
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_unknown');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects an unreadable live birth identity', async () => {
    result({ processStart: 'known-birth' });
    runtime.identity.mockReturnValue(undefined);
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_unknown');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects a recycled host PID', async () => {
    result({ processStart: 'old-birth' });
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_mismatch');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects ownership uncertainty when the result is missing but the lock remains', async () => {
    writeFileSync(join(pluginSupervisorDir(), 'owner.lock'), 'unknown');
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_unknown');
  });
  it('rejects conflicting durable host records before attempting a signal', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: 2_147_483_647, procs: [] });
    runtime.signal.mockReturnValue(false);
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_mismatch');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects a reused host PID when its state birth identity disagrees', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: process.pid, supervisorProcessStart: 'old-birth', procs: [] });
    runtime.signal.mockReturnValue(false);
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_mismatch');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects a host state without a recorded birth identity', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: process.pid, procs: [] });
    runtime.signal.mockReturnValue(false);
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_unknown');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('reports a host exit timeout instead of accepting signal delivery as completion', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: process.pid, supervisorProcessStart: 'known-birth', procs: [] });
    vi.useFakeTimers();
    const assertion = expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_timeout');
    await vi.waitFor(() => expect(runtime.signal).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
  it('does not let a historical result error veto a later shutdown retry', async () => {
    result({ processStart: 'known-birth', error: 'old stop failure' });
    state({ supervisorPid: process.pid, supervisorProcessStart: 'known-birth', procs: [] });
    runtime.signal.mockImplementation(() => {
      state({ supervisorPid: 0, procs: [] });
      runtime.zombie.mockReturnValue(true);
      return true;
    });
    await expect(stopAll()).resolves.toEqual([]);
    expect(runtime.signal).toHaveBeenCalledTimes(1);
  });
  it('accepts a zombie host only after its completed state is durable', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: process.pid, supervisorProcessStart: 'known-birth', procs: [] });
    runtime.signal.mockImplementation(() => {
      state({ supervisorPid: 0, procs: [] });
      runtime.zombie.mockReturnValue(true);
      return true;
    });
    vi.useFakeTimers();
    const completion = expect(stopAll()).resolves.toEqual([]);
    await vi.waitFor(() => expect(runtime.signal).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_000);
    await completion;
  });
  it('rejects a zombie host while its durable state is still incomplete', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: process.pid, supervisorProcessStart: 'known-birth',
      procs: [{ name: 'botmux-plugin-lost', appId: '', pid: 0, status: 'launching' }] });
    runtime.zombie.mockReturnValue(true);
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_incomplete');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('ignores a retained result whose live PID belongs to a new process after completion', async () => {
    result({ processStart: 'old-birth' });
    state({ supervisorPid: 0, procs: [] });
    await expect(stopAll()).resolves.toEqual([]);
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('does not let a completed state conceal the same still-live host generation', async () => {
    result({ processStart: 'known-birth' });
    state({ supervisorPid: 0, procs: [] });
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_identity_mismatch');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects a dead host with unfinished member state', async () => {
    result({ pid: 2_147_483_647, processStart: 'old-birth' });
    state({ supervisorPid: 2_147_483_647, procs: [{ name: 'botmux-plugin-lost', appId: '', pid: 0, status: 'launching' }] });
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_incomplete');
  });
  it('rejects a dead host whose durable process-state file vanished', async () => {
    result({ pid: 2_147_483_647, processStart: 'old-birth' });
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_incomplete');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
  it('rejects a still live member after the host exited', async () => {
    result({ pid: 2_147_483_647, processStart: 'old-birth' });
    state({ supervisorPid: 0, procs: [{ name: 'botmux-plugin-lost', appId: '', pid: process.pid, status: 'online' }] });
    await expect(stopAll()).rejects.toThrow('plugin_supervisor_shutdown_incomplete');
    expect(runtime.signal).not.toHaveBeenCalled();
  });
});
