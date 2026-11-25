import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginProcesses, changePluginService } from '../src/core/plugins/supervisor-client.js';
import { assertPluginServiceStopped } from '../src/core/plugins/service-manager.js';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';
import {
  pluginSupervisorDir, pluginSupervisorDesiredPath, pluginSupervisorResultPath,
  pluginSupervisorStatePath, readPluginSupervisorDesired,
} from '../src/core/plugins/supervisor-store.js';

const legacy = vi.hoisted(() => ({ alive: false }));
const zombiePids = vi.hoisted(() => new Set<number>());
const identityOverride = vi.hoisted(() => ({ value: undefined as string | undefined | null }));
vi.mock('../src/core/legacy-pm2-reaper.js', () => ({ liveGodAt: () => legacy.alive }));
vi.mock('../src/utils/process-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/process-identity.js')>();
  return {
    ...actual,
    isLinuxZombie: (pid: number) => zombiePids.has(pid) || actual.isLinuxZombie(pid),
    readDurableProcessIdentity: (pid: number) =>
      identityOverride.value === null ? actual.readDurableProcessIdentity(pid) : identityOverride.value,
  };
});

describe('plugin supervisor lifecycle evidence', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-supervisor-state-'));
    vi.stubEnv('HOME', home);
    legacy.alive = false;
    zombiePids.clear();
    identityOverride.value = null;
    mkdirSync(pluginSupervisorDir(), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  const stopped = { name: 'botmux-plugin-demo', appId: '', pid: 0, status: 'stopped' };

  it.each([{ value: null }, { value: [] }, { value: { revision: 3 } }, { value: { revision: '', target: '', services: [] } }])(
    'rejects malformed desired state: %j', ({ value }) => {
      write(pluginSupervisorDesiredPath(), value);
      expect(() => readPluginSupervisorDesired()).toThrow();
    },
  );

  it.each([
    { procs: [{ ...stopped, pid: '123' }] },
    { procs: [{ pid: process.pid, status: 'online' }] },
    { procs: [{ ...stopped, status: 'unknown' }] },
    { procs: [stopped, stopped] },
  ])('never hides a malformed process row: %j', value => {
    write(pluginSupervisorStatePath(), value);
    expect(() => readPluginProcesses()).toThrow();
  });

  it('keeps a pending remove guarded, including when its last recorded PID is zero', () => {
    write(pluginSupervisorDesiredPath(), { revision: 'remove', target: 'demo', services: {} });
    write(pluginSupervisorResultPath(), { revision: 'old', pid: process.pid });
    write(pluginSupervisorStatePath(), { procs: [stopped] });
    expect(readPluginProcesses()).toEqual([expect.objectContaining({ name: stopped.name, status: 'launching' })]);
    write(pluginSupervisorStatePath(), { procs: [] });
    expect(readPluginProcesses()).toEqual([{ name: stopped.name, status: 'launching' }]);
    write(pluginSupervisorResultPath(), { revision: 'remove', pid: process.pid });
    expect(readPluginProcesses()).toEqual([]);
  });

  it('does not call a missing acknowledged process file proof of a stopped service', () => {
    write(pluginSupervisorDesiredPath(), {
      revision: 'start', target: 'demo',
      services: { demo: { running: true, spec: { name: stopped.name, external: { command: '/bin/echo' } } } },
    });
    write(pluginSupervisorResultPath(), { revision: 'start', pid: process.pid });
    expect(() => readPluginProcesses()).toThrow('plugin_supervisor_missing_process_state');
    write(pluginSupervisorStatePath(), { procs: [] });
    expect(() => readPluginProcesses()).toThrow('plugin_supervisor_missing_process:demo');
  });

  it('blocks a live legacy God without creating native state or killing anything', async () => {
    legacy.alive = true;
    expect(() => readPluginProcesses()).toThrow('plugin_legacy_pm2_running');
    await expect(changePluginService('demo', 'stop')).rejects.toThrow('plugin_legacy_pm2_running');
    expect(existsSync(pluginSupervisorDesiredPath())).toBe(false);
    expect(existsSync(pluginSupervisorStatePath())).toBe(false);
  });

  it('verifies processStart identity and rejects recycled or zombie PIDs in readPluginProcesses', () => {
    const selfStart = readDurableProcessIdentity(process.pid);
    expect(selfStart).toBeTruthy();

    write(pluginSupervisorStatePath(), {
      procs: [{ name: stopped.name, appId: '', pid: process.pid, processStart: selfStart, status: 'online' }],
    });
    expect(readPluginProcesses()).toEqual([expect.objectContaining({
      name: stopped.name,
      pid: process.pid,
      processStart: selfStart,
      status: 'online',
    })]);

    // Recycled PID (mismatched processStart): the pid is live but cannot be
    // proven to be the supervised process, so it is 'unknown' with the pid
    // retained — never 'stopped', which would let uninstall/update proceed.
    write(pluginSupervisorStatePath(), {
      procs: [{ name: stopped.name, appId: '', pid: process.pid, processStart: 'recycled-boot:999', status: 'online' }],
    });
    const recycled = readPluginProcesses()[0];
    expect(recycled.status).toBe('unknown');
    expect(recycled.pid).toBe(process.pid);
    expect(recycled.processStart).toBeUndefined();
    // Fail-closed: uninstall/update must refuse while the live pid is unverified.
    expect(() => assertPluginServiceStopped('demo', 'update')).toThrow();

    // Zombie PID with matching processStart is treated as stopped
    zombiePids.add(process.pid);
    write(pluginSupervisorStatePath(), {
      procs: [{ name: stopped.name, appId: '', pid: process.pid, processStart: selfStart, status: 'online' }],
    });
    const zombie = readPluginProcesses()[0];
    expect(zombie.status).toBe('stopped');
    expect(zombie.pid).toBeUndefined();
    expect(zombie.processStart).toBeUndefined();
  });

  it('keeps a live PID as unknown (not stopped) when birth identity is temporarily unreadable', () => {
    const selfStart = readDurableProcessIdentity(process.pid);
    expect(selfStart).toBeTruthy();
    write(pluginSupervisorStatePath(), {
      procs: [{ name: stopped.name, appId: '', pid: process.pid, processStart: selfStart, status: 'online' }],
    });

    // /proc hiccup, permission blip, unreadable boot id: kill(0) still succeeds
    // but the durable birth identity cannot be read right now.
    identityOverride.value = undefined;
    const unreadable = readPluginProcesses()[0];
    expect(unreadable.status).toBe('unknown');
    expect(unreadable.pid).toBe(process.pid);
    expect(unreadable.processStart).toBeUndefined();

    // Lifecycle protection must stay fail-closed: an unknown-but-live process
    // cannot be treated as stopped for uninstall/update.
    
    expect(() => assertPluginServiceStopped('demo', 'uninstall')).toThrow();

    // Recovery: once the identity is readable again and matches, online returns.
    identityOverride.value = null;
    const recovered = readPluginProcesses()[0];
    expect(recovered.status).toBe('online');
    expect(recovered.pid).toBe(process.pid);
    expect(recovered.processStart).toBe(selfStart);
  });
});
