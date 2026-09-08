import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  startPluginServices, stopPluginServices, listPluginServiceStatus,
  deletePluginServices, assertPluginServiceStopped, resolvePluginServiceSpec,
} from '../src/core/plugins/service-manager.js';
import { loadPluginServiceDefinition } from '../src/core/plugins/runtime.js';
import { changePluginService, readPluginProcesses } from '../src/core/plugins/supervisor-client.js';
import { readPluginSupervisorDesired, pluginSupervisorStatePath, pluginSupervisorResultPath } from '../src/core/plugins/supervisor-store.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { pidAlive } from '../src/core/fleet-supervisor.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await delay(40);
  }
}

describe('plugin services on the built-in supervisor', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-supervisor-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(async () => {
    const path = pluginSupervisorStatePath();
    const state = readFleetState(path);
    if (state && state.supervisorPid > 1 && pidAlive(state.supervisorPid)) {
      process.kill(state.supervisorPid, 'SIGTERM');
      await until(() => !pidAlive(state.supervisorPid), 'supervisor shutdown');
    }
    for (const p of state?.procs ?? []) if (pidAlive(p.pid)) process.kill(p.pid, 'SIGKILL');
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function fixture(id: string, options: { auto?: boolean; linked?: boolean; autorestart?: boolean; body?: string } = {}) {
    const root = join(home, id);
    mkdirSync(join(root, 'dist', 'service'), { recursive: true });
    mkdirSync(join(root, 'dist', 'botmux-build'));
    writeFileSync(join(root, 'dist', 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: `@botmux-ai/plugin-${id}`, version: '1.0.0', keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id, service: { mode: options.auto ? 'auto' : 'manual' } },
    }));
    writeFileSync(join(root, 'dist', 'service', 'index.js'), `module.exports = {
      pm2: { script: './service/server.cjs', args: ['hello world'],
        env: { MARKER: ${JSON.stringify(join(home, id + '.ready'))},
          OWN_VALUE: 'kept', CODEX_HOME: '/must-not-leak', BOTMUX_SESSION_ID: 'forged' },
        autorestart: ${options.autorestart !== false}, killTimeoutMs: 150, watchDelayMs: 150 }
    };`);
    writeFileSync(join(root, 'dist', 'service', 'server.cjs'), options.body ?? `
      const fs = require('node:fs');
      process.on('SIGTERM', () => process.exit(0));
      fs.writeFileSync(process.env.MARKER, JSON.stringify({pid: process.pid, args: process.argv.slice(2), env: process.env, cwd: process.cwd()}));
      setInterval(() => {}, 1000);
    `);
    return { ...installLocalPlugin(root, { link: options.linked }), root };
  }
  const proc = (id: string) => readPluginProcesses().find(p => p.name === `botmux-plugin-${id}`);
  const ready = (id: string) => until(() => existsSync(join(home, id + '.ready'))
    && JSON.parse(readFileSync(join(home, id + '.ready'), 'utf8')).pid === proc(id)?.pid, `${id} ready`);

  it('installs and queries without creating a supervisor; update/uninstall guard checks actual liveness', async () => {
    const { root, runtimeDir } = fixture('demo');
    expect((await listPluginServiceStatus())[0].status).toBe('stopped');
    expect(existsSync(pluginSupervisorStatePath())).toBe(false);
    expect((await startPluginServices(['demo']))[0].action).toBe('started');
    await ready('demo');
    const pid = proc('demo')!.pid;
    const seen = JSON.parse(readFileSync(join(home, 'demo.ready'), 'utf8'));
    expect(seen.args).toEqual(['hello world']);
    expect(seen.env.OWN_VALUE).toBe('kept');
    expect(seen.env.CODEX_HOME).toBeUndefined();
    expect(seen.env.BOTMUX_SESSION_ID).toBeUndefined();
    expect(() => installLocalPlugin(root)).toThrow('plugin_service_running');
    expect(() => assertPluginServiceStopped('demo', 'uninstall')).toThrow('plugin_service_running');
    expect((await startPluginServices(['demo']))[0].action).toBe('already-running');
    expect(proc('demo')!.pid).toBe(pid);
    expect((await stopPluginServices(['demo']))[0].action).toBe('stopped');
    expect(pidAlive(pid!)).toBe(false);
    expect(() => installLocalPlugin(root)).not.toThrow();
    expect((await deletePluginServices(['demo']))[0].action).toBe('deleted');
    expect(readPluginSupervisorDesired().services.demo).toBeUndefined();
    expect(readFleetState(pluginSupervisorStatePath())!.procs).toEqual([]);
    expect(existsSync(runtimeDir)).toBe(true);
    expect(existsSync(join(home, '.botmux', 'pm2', 'pm2.pid'))).toBe(false);
  }, 30_000);

  it('adds and removes services dynamically without restarting another member', async () => {
    fixture('one');
    expect((await startPluginServices(['one']))[0].action).toBe('started');
    await ready('one');
    const pid = proc('one')!.pid;
    fixture('two');
    expect((await startPluginServices(['two']))[0].action).toBe('started');
    await ready('two');
    expect(proc('one')!.pid).toBe(pid);
    const secondPid = proc('two')!.pid;
    expect((await deletePluginServices(['two']))[0].action).toBe('deleted');
    expect(pidAlive(secondPid!)).toBe(false);
    expect(proc('one')!.pid).toBe(pid);
  }, 30_000);

  it('honours autoOnly and keeps a stopped manual service stopped', async () => {
    fixture('automatic', { auto: true });
    fixture('manual');
    expect((await startPluginServices(undefined, { autoOnly: true })).map(r => r.pluginId)).toEqual(['automatic']);
    await ready('automatic');
    expect(proc('manual')).toBeUndefined();
    await startPluginServices(['manual']);
    await ready('manual');
    const manualPid = proc('manual')!.pid;
    await stopPluginServices(undefined, { autoOnly: true });
    expect(proc('manual')!.pid).toBe(manualPid);
    await stopPluginServices(['manual']);
    await startPluginServices(undefined, { autoOnly: true });
    expect(proc('manual')!.status).toBe('stopped');
  }, 30_000);

  it('restarts a crashed service but never resurrects a deleted member', async () => {
    fixture('crash');
    await startPluginServices(['crash']);
    await ready('crash');
    const oldPid = proc('crash')!.pid!;
    process.kill(oldPid, 'SIGKILL');
    await until(() => !!proc('crash')?.pid && proc('crash')!.pid !== oldPid, 'crash restart');
    await ready('crash');
    process.kill(proc('crash')!.pid!, 'SIGKILL');
    expect((await deletePluginServices(['crash']))[0].action).toBe('deleted');
    await delay(700); // exceeds the known crash backoff; proves cancellation
    expect(proc('crash')).toBeUndefined();
  }, 30_000);

  it('honours autorestart=false and escalates a non-cooperative stop', async () => {
    fixture('once', { autorestart: false });
    await startPluginServices(['once']);
    await ready('once');
    process.kill(proc('once')!.pid!, 'SIGKILL');
    await until(() => proc('once')?.status === 'stopped', 'autorestart=false');
    await delay(600);
    expect(proc('once')!.pid).toBeUndefined();
    fixture('stubborn', { body: `process.on('SIGTERM',()=>{});
      require('fs').writeFileSync(process.env.MARKER, JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);` });
    await startPluginServices(['stubborn']);
    await ready('stubborn');
    const pid = proc('stubborn')!.pid!;
    const start = Date.now();
    expect((await stopPluginServices(['stubborn']))[0].action).toBe('stopped');
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(pidAlive(pid)).toBe(false);
  }, 30_000);

  it('watches linked builds and disables the watcher on stop', async () => {
    const { root } = fixture('linked', { linked: true });
    await startPluginServices(['linked']);
    await ready('linked');
    const oldPid = proc('linked')!.pid;
    writeFileSync(join(root, 'dist', 'botmux-build', 'stamp'), 'new build');
    await until(() => !!proc('linked')?.pid && proc('linked')!.pid !== oldPid, 'linked rebuild');
    await ready('linked');
    const nextPid = proc('linked')!.pid!;
    await stopPluginServices(['linked']);
    writeFileSync(join(root, 'dist', 'botmux-build', 'stamp'), 'another build');
    await delay(800);
    expect(pidAlive(nextPid)).toBe(false);
    expect(proc('linked')!.status).toBe('stopped');
  }, 30_000);

  it('replaces changed configuration, waits for the old pid, and preserves argument boundaries', async () => {
    const { record } = fixture('config');
    const definition = (await loadPluginServiceDefinition(record))!;
    const first = resolvePluginServiceSpec(record, definition);
    await changePluginService('config', 'start', first);
    await ready('config');
    const oldPid = proc('config')!.pid!;
    definition.pm2.args = ['changed argument'];
    const second = resolvePluginServiceSpec(record, definition);
    await changePluginService('config', 'start', second);
    await ready('config');
    expect(pidAlive(oldPid)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'config.ready'), 'utf8')).args).toEqual(['changed argument']);
    expect(proc('config')!.configHash).toBe(second.external.configHash);
  }, 30_000);

  it('requires an explicit stop when a linked service exits but its watcher remains armed', async () => {
    const { root } = fixture('watched-exit', { linked: true, autorestart: false });
    await startPluginServices(['watched-exit']);
    await ready('watched-exit');
    const pid = proc('watched-exit')!.pid!;
    process.kill(pid, 'SIGKILL');
    await until(() => !proc('watched-exit')?.pid, 'linked child exit');
    expect(() => installLocalPlugin(root)).toThrow('plugin_service_running');
    await stopPluginServices(['watched-exit']);
    expect(() => installLocalPlugin(root)).not.toThrow();
  }, 30_000);

  it.skipIf(process.platform === 'win32')('isolates a broken linked watcher from other services', async () => {
    const { root } = fixture('broken-watch', { linked: true });
    fixture('unrelated');
    await startPluginServices(['broken-watch', 'unrelated']);
    await ready('broken-watch');
    await ready('unrelated');
    const first = proc('broken-watch')!.pid;
    const second = proc('unrelated')!.pid;
    const buildDir = join(root, 'dist', 'botmux-build');
    rmSync(buildDir, { recursive: true });
    symlinkSync('botmux-build', buildDir); // ELOOP even when tests run as root
    await delay(700);
    expect(proc('broken-watch')!.pid).toBe(first);
    expect(proc('unrelated')!.pid).toBe(second);
    expect(pidAlive(first!)).toBe(true);
    expect(pidAlive(second!)).toBe(true);
  }, 30_000);

  it('recovers orphaned children after owner SIGKILL without reviving an explicitly stopped service', async () => {
    fixture('survivor');
    fixture('stopped', { autorestart: false });
    await startPluginServices(['survivor', 'stopped']);
    await ready('survivor');
    await ready('stopped');
    process.kill(proc('stopped')!.pid!, 'SIGKILL');
    await until(() => proc('stopped')?.status === 'stopped', 'natural exit');
    await stopPluginServices(['stopped']); // must persist stop even if already down
    expect(readPluginSupervisorDesired().services.stopped.running).toBe(false);
    const oldPid = proc('survivor')!.pid!;
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    process.kill(owner, 'SIGKILL');
    await until(() => !pidAlive(owner), 'killed owner');
    expect((await startPluginServices(['survivor']))[0].action).not.toBe('failed');
    await ready('survivor');
    expect(proc('survivor')!.pid).not.toBe(oldPid);
    expect(pidAlive(oldPid)).toBe(false);
    expect(proc('stopped')!.status).toBe('stopped');
    expect(readFleetState(pluginSupervisorStatePath())!.procs.filter(p => p.pid > 1)).toHaveLength(1);
  }, 30_000);

  it('reports exec failure and removes its pending restart before allowing uninstall', async () => {
    const { record } = fixture('missing');
    const spec = resolvePluginServiceSpec(record, (await loadPluginServiceDefinition(record))!);
    spec.external.command = join(home, 'no-such-executable');
    await expect(changePluginService('missing', 'start', spec)).rejects.toThrow();
    expect(() => assertPluginServiceStopped('missing', 'uninstall')).toThrow('plugin_service_running');
    expect((await deletePluginServices(['missing']))[0].action).toBe('deleted');
    await delay(700);
    expect(proc('missing')).toBeUndefined();
    expect(readFleetState(pluginSupervisorStatePath())!.procs).toEqual([]);
  }, 30_000);

  it('fails closed on a malformed acknowledgement instead of approving an update', async () => {
    const { root } = fixture('corrupt');
    await startPluginServices(['corrupt']);
    await ready('corrupt');
    writeFileSync(pluginSupervisorResultPath(), '{}');
    expect(() => installLocalPlugin(root)).toThrow('plugin_supervisor_invalid_result');
    expect(() => assertPluginServiceStopped('corrupt', 'uninstall')).toThrow('plugin_supervisor_invalid_result');
  }, 30_000);
});
