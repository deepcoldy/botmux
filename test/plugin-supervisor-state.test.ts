import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginProcesses, changePluginService } from '../src/core/plugins/supervisor-client.js';
import {
  pluginSupervisorDir, pluginSupervisorDesiredPath, pluginSupervisorResultPath,
  pluginSupervisorStatePath, readPluginSupervisorDesired,
} from '../src/core/plugins/supervisor-store.js';

const legacy = vi.hoisted(() => ({ alive: false }));
vi.mock('../src/core/legacy-pm2-reaper.js', () => ({ liveGodAt: () => legacy.alive }));

describe('plugin supervisor lifecycle evidence', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-supervisor-state-'));
    vi.stubEnv('HOME', home);
    legacy.alive = false;
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
});
