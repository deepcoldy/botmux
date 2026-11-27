import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { wecomConfigId, wecomRoot } from '../src/im/wecom/config/discovery.js';
import { setWecomFleetDesiredState, wecomFleetDesiredStatePath } from '../src/im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import {
  anyDaemonBusy,
  anyWecomCoreBusyIn,
  HEARTBEAT_FRESH_MS,
  writeHeartbeatTo,
} from '../src/core/daemon-heartbeat.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(homedir(), '.botmux'), { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-18T03:00:00.000Z');

/** A registered connection whose managed core keeps its state in `stateDir`. */
function connection(root: string, name: string, options: { external?: boolean; relativeStateDir?: boolean } = {}) {
  const file = join(root, name, 'config.json');
  const stateDir = join(root, name, 'core-state');
  // A relative spelling of the same directory (from this process's cwd): only a
  // gate that resolved it would find the heartbeat written there.
  const configuredStateDir = options.relativeStateDir ? relative(process.cwd(), stateDir) : stateDir;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    botId: `bot-${name}`,
    coreUrl: 'http://127.0.0.1:18080',
    allowedUsers: ['u'],
    ...(options.external ? {} : {
      managedCore: { botId: `local_${name}`, cli: 'codex', backend: 'pty', workingDirectory: root, port: 18080, stateDir: configuredStateDir },
    }),
  }));
  const registry = join(root, 'config-registry.json');
  let paths: string[] = [];
  try { paths = JSON.parse(readFileSync(registry, 'utf8')).paths; } catch { /* first */ }
  writeFileSync(registry, JSON.stringify({ version: 1, paths: [...paths, file] }));
  const configId = wecomConfigId(file);
  return {
    configId,
    beat: (busyCount: number, ageMs = 0) => writeHeartbeatTo(stateDir, `local_${name}`, busyCount, new Date(NOW - ageMs).toISOString()),
  };
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-busy-'));
  dirs.push(dir);
  return dir;
}

describe('the auto-update busy gate sees WeCom cores the fleet runs', () => {
  it('is busy while a running connection\'s core reports a turn in progress', () => {
    const r = root();
    const a = connection(r, 'a');
    setWecomFleetDesiredState(a.configId, 'running', { root: r });
    a.beat(1);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(true);
  });

  it('is not busy for an idle core, a stale heartbeat, or no heartbeat yet', () => {
    const r = root();
    const a = connection(r, 'a');
    setWecomFleetDesiredState(a.configId, 'running', { root: r });
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);
    a.beat(0);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);
    a.beat(2, HEARTBEAT_FRESH_MS + 1);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);
  });

  it('ignores connections the fleet does not run: stopped, or never recorded (a terminal gateway)', () => {
    const r = root();
    const stopped = connection(r, 'stopped');
    const terminal = connection(r, 'terminal');
    const running = connection(r, 'running');
    setWecomFleetDesiredState(stopped.configId, 'stopped', { root: r });
    setWecomFleetDesiredState(running.configId, 'running', { root: r });
    stopped.beat(1);
    terminal.beat(1);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);
    running.beat(1);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(true);
  });

  it('looks no further than the desired-state file when there is none', () => {
    const r = root();
    connection(r, 'a').beat(3);
    let listed = 0;
    const list = (dir: string) => { listed += 1; return listWecomFleetConnections(dir); };
    expect(anyWecomCoreBusyIn(r, NOW, HEARTBEAT_FRESH_MS, list)).toBe(false);
    expect(listed).toBe(0);
  });

  it('reads anything it cannot trust as not busy, without throwing', () => {
    const r = root();
    const a = connection(r, 'a');
    setWecomFleetDesiredState(a.configId, 'running', { root: r });
    a.beat(1);
    writeFileSync(wecomFleetDesiredStatePath(r), '{ broken');
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);

    const r2 = root();
    const b = connection(r2, 'b');
    setWecomFleetDesiredState(b.configId, 'running', { root: r2 });
    writeFileSync(join(r2, 'config-registry.json'), 'garbage');
    expect(anyWecomCoreBusyIn(r2, NOW)).toBe(false);

    const r3 = root();
    const c = connection(r3, 'c', { external: true });
    setWecomFleetDesiredState(c.configId, 'running', { root: r3 });
    expect(anyWecomCoreBusyIn(r3, NOW)).toBe(false);
  });

  it('leaves out a configuration whose core state directory is a relative path', () => {
    const r = root();
    const a = connection(r, 'a', { relativeStateDir: true });
    setWecomFleetDesiredState(a.configId, 'running', { root: r });
    a.beat(1);
    expect(anyWecomCoreBusyIn(r, NOW)).toBe(false);
  });

  it('is part of the gate maintenance uses', () => {
    const r = wecomRoot();
    mkdirSync(r, { recursive: true });
    const a = connection(r, 'a');
    setWecomFleetDesiredState(a.configId, 'running', { root: r });
    expect(anyDaemonBusy(NOW)).toBe(false);
    a.beat(1);
    expect(anyDaemonBusy(NOW)).toBe(true);
  });
});
