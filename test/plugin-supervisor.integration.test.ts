import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTsScript } from './helpers/ts-runner.js';
import { fileURLToPath } from 'node:url';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  startPluginServices, stopPluginServices, listPluginServiceStatus,
  deletePluginServices, assertPluginServiceStopped, resolvePluginServiceSpec,
} from '../src/core/plugins/service-manager.js';
import { loadPluginServiceDefinition } from '../src/core/plugins/runtime.js';
import { changePluginService, readPluginProcesses } from '../src/core/plugins/supervisor-client.js';
import { readPluginSupervisorDesired, pluginSupervisorStatePath, pluginSupervisorResultPath, pluginSupervisorDir } from '../src/core/plugins/supervisor-store.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import {
  inspectFleetProcess, inspectSupervisorState, signalAttestedFleetProcess,
} from '../src/core/fleet-process-identity.js';
import { pidAlive } from '../src/core/fleet-supervisor.js';
import { userSystemdBusEnv } from '../src/core/session-scope.js';

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
    // The supervisor launched below is the real entry. Started from inside a
    // bot session it moves itself into a new scope over the host's user bus
    // (core/fleet-scope.ts), and that busctl runs with a fixed PATH the systemd
    // fence's shims never see. Declare no user bus, as scripts/fenced-run.ts
    // does, and stop before launching anything if that stops hiding it.
    vi.stubEnv('BOTMUX_FENCED_RUN', '1');
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    expect(userSystemdBusEnv()).toBeUndefined();
  });
  afterEach(async () => {
    const path = pluginSupervisorStatePath();
    const state = readFleetState(path);
    if (state && state.supervisorPid > 1 && state.supervisorPid !== process.pid
      && inspectSupervisorState(state).status === 'exact') {
      process.kill(state.supervisorPid, 'SIGTERM');
      await until(() => !pidAlive(state.supervisorPid), 'supervisor shutdown');
    }
    for (const p of state?.procs ?? []) {
      if (p.pid <= 1 || p.pid === process.pid) continue;
      const inspection = inspectFleetProcess(
        p.pid, p.processStart, undefined, () => false, undefined, /* verifyPersistedCommand */ false,
      );
      if (inspection.status === 'exact') {
        signalAttestedFleetProcess(inspection.attestation, 'SIGKILL');
      }
    }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function fixture(id: string, options: { auto?: boolean; linked?: boolean; autorestart?: boolean; killTimeoutMs?: number; body?: string } = {}) {
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
        autorestart: ${options.autorestart !== false}, killTimeoutMs: ${options.killTimeoutMs ?? 150}, watchDelayMs: 150 }
    };`);
    writeFileSync(join(root, 'dist', 'service', 'server.cjs'), options.body ?? `
      const fs = require('node:fs');
      process.on('SIGTERM', () => process.exit(0));
      // Write the marker ATOMICALLY (tmp + rename). The reader below polls every
      // 40ms while this child writes a multi-KB JSON blob (it embeds the whole
      // env), so a plain writeFileSync lets the poller read a half-written file
      // and blow up with \`SyntaxError: JSON Parse error: Unterminated string\`
      // — MEASURED on CI, and it reads like a supervisor defect when it is only
      // a torn read. rename(2) is atomic within a filesystem, so the reader sees
      // either the old absence or the complete file, never a prefix.
      const marker = process.env.MARKER;
      const tmp = marker + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({pid: process.pid, args: process.argv.slice(2), env: process.env, cwd: process.cwd()}));
      fs.renameSync(tmp, marker);
      setInterval(() => {}, 1000);
    `);
    return { ...installLocalPlugin(root, { link: options.linked }), root };
  }
  function signalFixtureBody(exitDelayMs?: number): string {
    return `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(process.env.MARKER + '.term', String(process.pid));
        ${exitDelayMs === undefined ? '' : `setTimeout(() => process.exit(0), ${exitDelayMs});`}
      });
      const tmp = process.env.MARKER + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));
      fs.renameSync(tmp, process.env.MARKER);
      setInterval(() => {}, 1000);
    `;
  }
  const proc = (id: string) => readPluginProcesses().find(p => p.name === `botmux-plugin-${id}`);
  // A predicate that THROWS aborts the poll loop and reports the parse error as
  // the test's failure, hiding what was actually being waited for. The marker is
  // written atomically (see the fixture), so a malformed read should no longer
  // happen — but if one ever does, the honest outcome is "timed out: <id> ready",
  // not a SyntaxError masquerading as a supervisor defect.
  const readyPid = (id: string): number | undefined => {
    const marker = join(home, id + '.ready');
    if (!existsSync(marker)) return undefined;
    try { return JSON.parse(readFileSync(marker, 'utf8')).pid as number; }
    catch { return undefined; }
  };
  const ready = (id: string) => until(() => readyPid(id) !== undefined && readyPid(id) === proc(id)?.pid, `${id} ready`);

  async function stopCli(id?: string) {
    const args = ['plugin', 'service', 'stop', ...(id ? [id] : [])];
    // Keep the parent's event loop running so it can reap its supervisor child
    // while the separate CLI waits for that host to exit.
    const child = spawnTsScript(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), args, {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdout!.resume();
    const status = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('stop CLI timed out')); }, 25_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    expect(status, stderr).toBe(0);
  }

  it('explicit stop --all exits the host and releases its owner lock after stopping members', async () => {
    fixture('one');
    fixture('two');
    await startPluginServices(['one', 'two']);
    await ready('one');
    await ready('two');
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    const one = proc('one')!.pid!;
    const two = proc('two')!.pid!;
    await stopCli('one');
    expect(pidAlive(one)).toBe(false);
    expect(proc('two')!.pid).toBe(two);
    expect(pidAlive(two)).toBe(true);
    expect(pidAlive(owner)).toBe(true);
    await stopCli('--all');
    expect(pidAlive(two)).toBe(false);
    expect(pidAlive(owner)).toBe(false);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
    expect(readFleetState(pluginSupervisorStatePath())!.supervisorPid).toBe(0);
  }, 60_000);

  it('keeps the host for implicit stop and exits an already idle host only for explicit --all', async () => {
    fixture('idle');
    await startPluginServices(['idle']);
    await ready('idle');
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    await stopCli();
    expect(pidAlive(owner)).toBe(true);
    expect(proc('idle')!.pid).toBeUndefined();
    await stopCli('--all');
    expect(pidAlive(owner)).toBe(false);
    const closedResult = readFileSync(pluginSupervisorResultPath(), 'utf8');
    await stopCli('--all');
    expect(readFileSync(pluginSupervisorResultPath(), 'utf8')).toBe(closedResult);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
  }, 60_000);

  it('explicit --all cancels a failed start restart even without an installed registry member', async () => {
    const { record } = fixture('template');
    const spec = resolvePluginServiceSpec(record, (await loadPluginServiceDefinition(record))!);
    spec.name = 'botmux-plugin-unregistered';
    spec.external.command = join(home, 'missing-executable');
    await expect(changePluginService('unregistered', 'start', spec)).rejects.toThrow();
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    await stopCli('--all');
    expect(readPluginSupervisorDesired().services.unregistered.running).toBe(false);
    expect(pidAlive(owner)).toBe(false);
    await delay(800);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
    expect(readPluginProcesses().every(p => !p.pid && p.status === 'stopped')).toBe(true);
  }, 60_000);

  it('keeps shutdown signals idempotent during asynchronous member cleanup', async () => {
    fixture('repeated-signal', { killTimeoutMs: 1_500, body: signalFixtureBody() });
    await startPluginServices(['repeated-signal']);
    await ready('repeated-signal');
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    process.kill(owner, 'SIGTERM');
    await until(() => existsSync(join(home, 'repeated-signal.ready.term')), 'member stop started');
    process.kill(owner, 'SIGTERM');
    await until(() => !pidAlive(owner), 'host exits after repeated signal', 8_000);
    const stopped = readFleetState(pluginSupervisorStatePath());
    expect(stopped?.supervisorPid).toBe(0);
    expect(stopped?.procs).toMatchObject([{ pid: 0, status: 'stopped' }]);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
  }, 30_000);

  it('reconciles an exited member when the stop deadline expires during a host pause', async () => {
    fixture('paused-stop', { killTimeoutMs: 1_000, body: signalFixtureBody(200) });
    await startPluginServices(['paused-stop']);
    await ready('paused-stop');
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    process.kill(owner, 'SIGTERM');
    await until(() => existsSync(join(home, 'paused-stop.ready.term')), 'member stop before pause');
    process.kill(owner, 'SIGSTOP');
    await delay(6_200);
    process.kill(owner, 'SIGCONT');
    await until(() => !pidAlive(owner), 'paused host exits', 8_000);
    const stopped = readFleetState(pluginSupervisorStatePath());
    expect(stopped?.supervisorPid).toBe(0);
    expect(stopped?.procs).toMatchObject([{ pid: 0, status: 'stopped' }]);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
  }, 30_000);

  it('starts the post-SIGKILL deadline after escalation across a host pause', async () => {
    fixture('paused-kill', { killTimeoutMs: 1_000, body: signalFixtureBody() });
    await startPluginServices(['paused-kill']);
    await ready('paused-kill');
    const owner = readFleetState(pluginSupervisorStatePath())!.supervisorPid;
    const member = proc('paused-kill')!.pid!;
    process.kill(owner, 'SIGTERM');
    await until(() => existsSync(join(home, 'paused-kill.ready.term')), 'member stop before kill pause');
    process.kill(member, 'SIGSTOP');
    process.kill(owner, 'SIGSTOP');
    await delay(6_200);
    process.kill(owner, 'SIGCONT');
    await until(() => !pidAlive(owner), 'host exits after delayed escalation', 12_000);
    const stopped = readFleetState(pluginSupervisorStatePath());
    expect(stopped?.supervisorPid).toBe(0);
    expect(stopped?.procs).toMatchObject([{ pid: 0, status: 'stopped' }]);
    expect(existsSync(join(pluginSupervisorDir(), 'owner.lock'))).toBe(false);
  }, 30_000);

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
      const fs = require('fs'); const tmp = process.env.MARKER + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({pid:process.pid})); fs.renameSync(tmp, process.env.MARKER);
      setInterval(()=>{},1000);` });
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

  it('recovers and starts a plugin service when its persisted pid was recycled by an unrelated process', async () => {
    fixture('recycled', { auto: true });
    const unrelated = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('unrelated fixture did not become ready')), 5_000);
        unrelated.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('ready')) { clearTimeout(timer); resolve(); }
        });
        unrelated.once('exit', () => { clearTimeout(timer); reject(new Error('unrelated fixture exited before ready')); });
      });
      mkdirSync(join(home, '.botmux', 'plugin-supervisor'), { recursive: true });
      writeFileSync(pluginSupervisorStatePath(), JSON.stringify({
        supervisorPid: 0,
        supervisorStartedAt: '2026-01-01T00:00:00.000Z',
        procs: [{
          name: 'botmux-plugin-recycled',
          appId: '',
          pid: unrelated.pid!,
          generation: 1,
          status: 'online',
          restarts: 0,
          lastExitCode: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          processStart: 'utc:Thu Jan 01 00:00:00 1970',
        }],
      }));
      const reports = await startPluginServices(['recycled']);
      expect(reports[0].action).toBe('started');
      await ready('recycled');
      expect(proc('recycled')!.status).toBe('online');
      expect(proc('recycled')!.pid).not.toBe(unrelated.pid);
      expect(pidAlive(unrelated.pid!)).toBe(true);
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        const exited = once(unrelated, 'exit');
        unrelated.kill('SIGKILL');
        await exited;
      }
    }
  }, 30_000);
});
