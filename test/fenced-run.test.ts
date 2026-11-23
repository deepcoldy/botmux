/**
 * scripts/fenced-run.ts: the wrapper for ad-hoc probes and hand-written test
 * configs, which the repo's vitest / bun test fences never reach. Runs the real
 * script as a child process and checks what the probe it launches observes.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fencedRunEnv } from '../scripts/fenced-run.js';
import { userSystemdBusEnv } from '../src/core/session-scope.js';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'fenced-run.ts');
const SESSION_SCOPE = resolve(__dirname, '..', 'src', 'core', 'session-scope.ts');
let bun: string | undefined;
try { bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(bun!, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env });

describe.skipIf(!bun)('fenced-run', () => {
  it('rejects a missing command with a usage error', () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  it('gives the probe a temp HOME (even under Bun) and no user bus by default', () => {
    const home = process.env.HOME ?? '';
    const probe = 'const os=require("os"),fs=require("fs");const run=process.env.XDG_RUNTIME_DIR;'
      + 'console.log(JSON.stringify({home:os.homedir(),run:run??null,busSocket:!!run&&fs.existsSync(run+"/bus"),'
      + 'dbus:process.env.DBUS_SESSION_BUS_ADDRESS??null,fenced:process.env.BOTMUX_FENCED_RUN??null}))';
    const r = run(['--', bun!, '-e', probe], { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' });
    expect(r.status).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(seen.home).not.toBe(home);
    expect(seen.home).toMatch(/bmx-fenced-home-/);
    // The runtime dir is the hc fence's private one, which holds no bus.
    expect(seen.run ?? '').not.toMatch(/^\/run\/user\//);
    expect(seen.busSocket).toBe(false);
    expect(seen.dbus).toBeNull();
    // Marker a probe can check to know it is running behind the fences.
    expect(seen.fenced).toBe('1');
  });

  it('keeps the user bus only when asked', () => {
    const r = run(['--keep-user-bus', '--', bun!, '-e', 'console.log(process.env.XDG_RUNTIME_DIR ?? "none")'],
      { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('/run/user/0');
  });

  it.skipIf(process.platform !== 'linux')('stops botmux deriving the user bus from /run/user unless the bus is kept', () => {
    // The socket check is stubbed so the probe means the same on a host without a user bus.
    const probe = `const s=await import(${JSON.stringify(SESSION_SCOPE)});`
      + 'console.log(JSON.stringify(s.userSystemdBusEnv({isSocket:()=>true})??null))';
    const invoker = { ...process.env, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' };
    const fenced = run(['--', bun!, '-e', probe], invoker);
    expect(fenced.status, fenced.stderr).toBe(0);
    const declared = JSON.parse(fenced.stdout.trim().split('\n').pop()!) as Record<string, string> | null;
    expect(declared?.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(declared?.XDG_RUNTIME_DIR ?? '').not.toMatch(/^\/run\/user\//);

    const kept = run(['--keep-user-bus', '--', bun!, '-e', probe], invoker);
    expect(kept.status, kept.stderr).toBe(0);
    expect(JSON.parse(kept.stdout.trim().split('\n').pop()!)).toEqual({
      XDG_RUNTIME_DIR: invoker.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: invoker.DBUS_SESSION_BUS_ADDRESS,
    });
  });

  it('keeps config.session.dataDir, mojo workspaces and session markers out of the live fleet', async () => {
    // config.session.dataDir honours SESSION_DATA_DIR BEFORE the HOME fallback,
    // so a redirected HOME alone would not fence it.
    const cfgPath = resolve(__dirname, '..', 'src', 'config.ts');
    const keys = ['BOTMUX_SESSION_ID', 'BOTMUX_TURN_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_DAEMON_IPC_PORT',
      'BOTMUX_LARK_TOOL_BINDING', 'BOTMUX_IDENTITY_BIN'];
    const probe = `const c=await import(${JSON.stringify(cfgPath)});`
      + `console.log(JSON.stringify({dataDir:c.config.session.dataDir,`
      + `mojo:process.env.BOTMUX_MOJO_WORKSPACE_ROOT??null,`
      + `markers:${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null])}))`;
    const inherited: NodeJS.ProcessEnv = {
      ...process.env,
      BOTMUX_MOJO_WORKSPACE_ROOT: '/real-mojo-root',
      BOTMUX_SESSION_ID: 'sess', BOTMUX_TURN_ID: 'turn', BOTMUX_CHAT_ID: 'chat',
      BOTMUX_DAEMON_IPC_PORT: '7974', BOTMUX_LARK_TOOL_BINDING: 'binding', BOTMUX_IDENTITY_BIN: '/x/cli-identity/y.bin',
    };
    const r = run(['--', bun!, '-e', probe], inherited);
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(seen.dataDir).toMatch(/bmx-fenced-home-/);
    expect(seen.dataDir).not.toMatch(/^\/root/);
    expect(seen.mojo).toMatch(/bmx-fenced-home-/);
    expect(seen.mojo).not.toBe('/real-mojo-root');
    for (const [key, value] of seen.markers as Array<[string, string | null]>) {
      expect(value, `${key} must be scrubbed`).toBeNull();
    }
  });

  it.skipIf(!realTmux)('fails the run when the probe addresses a host tmux socket', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    // A path in the host socket directory: the shim refuses it before tmux runs.
    const r = run(['--', 'tmux', '-S', `/tmp/tmux-${uid}/botmux`, 'list-sessions']);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/refus/i);
  });

  it.skipIf(process.platform === 'win32')('gives the probe a private hc runtime dir and none of the invoker\'s HC_* variables', () => {
    const probe = 'const fs=require("fs"),path=require("path");const e=process.env;'
      + 'console.log(JSON.stringify({hc:Object.keys(e).filter(k=>/^_?HC_/.test(k)),session:e.HC_SESSION??null,'
      + 'run:e.XDG_RUNTIME_DIR??null,runIsDir:!!e.XDG_RUNTIME_DIR&&fs.statSync(e.XDG_RUNTIME_DIR).isDirectory(),'
      + 'bin:e.BOTMUX_HC_BIN??null,path0:(e.PATH??"").split(path.delimiter)[0]}))';
    const invoker: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: '/run/user/0',
      HC_SOCKET: '/run/user/0/herdr-core/default.sock',
      HC_SESSION: 'default',
      HC_TERMINAL_ID: 't1',
      _HC_RESPONSIBLE_PID: '1',
    };
    const r = run(['--', bun!, '-e', probe], invoker);
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(seen.hc).toEqual(['HC_SESSION']);
    expect(seen.session).not.toBe('default');
    expect(seen.run).not.toMatch(/^\/run\/user\//);
    expect(seen.runIsDir).toBe(true);
    // hc caps socket paths, holder sockets included, at 107 bytes.
    expect(`${seen.run}/herdr-core/${seen.session}.holder.ffffffff.sock`.length).toBeLessThanOrEqual(107);
    expect(seen.bin).toBeTruthy();
    expect(dirname(seen.bin)).toBe(seen.path0);
  });

  it.skipIf(process.platform === 'win32')('fails the run when the probe sends hc to the host runtime dir', () => {
    const invoker: NodeJS.ProcessEnv = { ...process.env };
    delete invoker.BOTMUX_HC_TEST_BIN;
    const r = run(['--', 'env', '-u', 'XDG_RUNTIME_DIR', 'hc', 'ls'], invoker);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/refus/i);
  });
});

describe.skipIf(process.platform !== 'linux')('fencedRunEnv user bus', () => {
  const uid = process.getuid?.() ?? 0;
  const derived = { XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
  const isSocket = () => true;

  function childEnv(base: NodeJS.ProcessEnv, keepUserBus: boolean): NodeJS.ProcessEnv {
    const root = mkdtempSync(join(tmpdir(), 'bmx-frb-'));
    const fence = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      return { root: dir, binDir: null, denyLog: join(dir, 'denied.log') };
    };
    try {
      return fencedRunEnv(base, join(root, 'home'), { tmux: fence('tmux'), hc: fence('hc') },
        { keepUserBus, isBusSocket: isSocket });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const busVars = (env: NodeJS.ProcessEnv) => ({
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  });

  it('leaves botmux no user bus to derive by default', () => {
    const env = childEnv({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' }, false);
    // The hc fence's private runtime dir, which holds no bus.
    expect(env.XDG_RUNTIME_DIR).not.toMatch(/^\/run\/user\//);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(userSystemdBusEnv({ env, isSocket })).toEqual({ XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR });
  });

  it('passes the invoker bus through unchanged with --keep-user-bus', () => {
    const env = childEnv({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' }, true);
    expect(busVars(env)).toEqual({ XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' });
    expect(userSystemdBusEnv({ env, isSocket })).toEqual({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' });
  });

  it('does not complete a bus variable the probe exported itself into the real user bus', () => {
    const fenced = childEnv({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' }, false);
    expect(userSystemdBusEnv({ env: { ...fenced, XDG_RUNTIME_DIR: '/tmp/probe-runtime' }, isSocket }))
      .toEqual({ XDG_RUNTIME_DIR: '/tmp/probe-runtime' });
    expect(userSystemdBusEnv({ env: { ...fenced, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' }, isSocket }))
      .toEqual({ XDG_RUNTIME_DIR: fenced.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' });
  });

  it('hands --keep-user-bus the bus botmux would derive when the invoker exported none', () => {
    const env = childEnv({}, true);
    expect(busVars(env)).toEqual(derived);
    expect(userSystemdBusEnv({ env, isSocket })).toEqual(derived);
  });

  it('cannot win the bus back by nesting --keep-user-bus inside a fence that dropped it', () => {
    const outer = childEnv({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' }, false);
    const env = childEnv(outer, true);
    expect(busVars(env)).toEqual({ XDG_RUNTIME_DIR: outer.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: undefined });
    expect(userSystemdBusEnv({ env, isSocket })).toEqual({ XDG_RUNTIME_DIR: outer.XDG_RUNTIME_DIR });
    const viaPrivateBus = childEnv({ ...outer, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' }, true);
    expect(userSystemdBusEnv({ env: viaPrivateBus, isSocket }))
      .toEqual({ XDG_RUNTIME_DIR: outer.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' });
  });
});
