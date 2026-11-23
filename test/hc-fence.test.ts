/**
 * The hc test fence (test/helpers/hc-fence.ts) must refuse every route to the
 * host's hc cores and let private ones through. The shim under test wraps a
 * FAKE "real hc" that only echoes its argv, so no hc core is ever contacted or
 * started here.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyHcFenceEnv,
  createHcFence,
  hcFenceShimScript,
  readHcFenceDenials,
  teardownHcFence,
  type HcFence,
} from './helpers/hc-fence.js';

const posix = process.platform !== 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const hostRun = `/run/user/${uid}`;
const hostSocket = `${hostRun}/herdr-core/default.sock`;
const work = mkdtempSync('/tmp/bmxh-selftest-');
const binDir = join(work, 'bin');
mkdirSync(binDir);
const fakeReal = join(work, 'real-hc');
writeFileSync(fakeReal, '#!/bin/sh\necho "REAL:$*"\n');
chmodSync(fakeReal, 0o755);
const denyLog = join(work, 'denied.log');
const hostHome = join(work, 'host-home');
const hostConfig = join(hostHome, '.config', 'herdr-core', 'config.toml');
mkdirSync(dirname(hostConfig), { recursive: true });
writeFileSync(hostConfig, '');
const shim = join(binDir, 'hc');
writeFileSync(shim, hcFenceShimScript(denyLog, binDir, [hostConfig]));
chmodSync(shim, 0o755);
const privateRun = join(work, 'run');
mkdirSync(privateRun, { mode: 0o700 });
const privateHome = join(work, 'home');
mkdirSync(privateHome);
const privateEnv = { XDG_RUNTIME_DIR: privateRun, HOME: privateHome };

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined>, shimPath = shim) {
  writeFileSync(denyLog, '');
  const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH, BOTMUX_HC_TEST_BIN: fakeReal };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  const r = spawnSync(shimPath, args, { env: clean, encoding: 'utf8', cwd: work });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, denied: readFileSync(denyLog, 'utf8') };
}

let configs = 0;
function configHome(toml: string): string {
  const home = join(work, `config-${++configs}`);
  mkdirSync(join(home, 'herdr-core'), { recursive: true });
  writeFileSync(join(home, 'herdr-core', 'config.toml'), toml);
  return home;
}

describe.skipIf(!posix)('hc test fence shim', () => {
  it('refuses an unset or empty XDG_RUNTIME_DIR, from which hc falls back to the host runtime dir', () => {
    for (const env of [{ HOME: privateHome }, { HOME: privateHome, XDG_RUNTIME_DIR: '' }]) {
      const r = run(['ls'], env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.denied).not.toBe('');
    }
  });

  it('refuses the host runtime dir however it is spelled', () => {
    for (const dir of [hostRun, `${hostRun}/`, `${hostRun}//`, `${hostRun}/sub`, `${hostRun}/../${uid}`]) {
      const r = run(['ls'], { HOME: privateHome, XDG_RUNTIME_DIR: dir });
      expect(r.status, dir).toBe(1);
      expect(r.stdout, dir).toBe('');
    }
  });

  it.skipIf(!existsSync(hostRun))('refuses a symlink to the host runtime dir', () => {
    const link = join(work, 'run-link');
    symlinkSync(hostRun, link);
    try {
      expect(run(['ls'], { HOME: privateHome, XDG_RUNTIME_DIR: link }).status).toBe(1);
      expect(run(['ls'], { ...privateEnv, HC_SOCKET: join(link, 'herdr-core', 'default.sock') }).status).toBe(1);
    } finally {
      unlinkSync(link);
    }
  });

  it('refuses HC_SOCKET in the host runtime dir even with a private XDG_RUNTIME_DIR', () => {
    const r = run(['ls'], { ...privateEnv, HC_SOCKET: hostSocket });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.denied).toContain(hostSocket);
  });

  it('refuses a top-level socket key in hc\'s config that points into the host runtime dir', () => {
    for (const toml of [
      `socket = "${hostSocket}"\n`,
      `socket = '${hostSocket}'  # pinned\n`,
      `"socket" = "${hostSocket}"\n`,
      `title = "x"\n  socket="${hostSocket}"\n[ui]\n`,
    ]) {
      const r = run(['ls'], { ...privateEnv, XDG_CONFIG_HOME: configHome(toml) });
      expect(r.status, toml).toBe(1);
      expect(r.stdout, toml).toBe('');
    }
  });

  it('refuses a socket key it cannot read without a TOML parser', () => {
    for (const toml of [
      `socket = "${hostRun}/herdr-core/d\\u0065fault.sock"\n`,
      `socket = """\n${hostSocket}"""\n`,
      'socket = 1\n',
    ]) {
      const r = run(['ls'], { ...privateEnv, XDG_CONFIG_HOME: configHome(toml) });
      expect(r.status, toml).toBe(1);
      expect(r.stdout, toml).toBe('');
    }
  });

  it('follows hc in ignoring a socket key inside a table and in letting HC_SOCKET win over the config', () => {
    const inTable = run(['ls'], { ...privateEnv, XDG_CONFIG_HOME: configHome(`[ui]\nsocket = "${hostSocket}"\n`) });
    expect(inTable.status).toBe(0);
    expect(inTable.stdout.trim()).toBe('REAL:ls');
    const overridden = run(['ls'], {
      ...privateEnv,
      XDG_CONFIG_HOME: configHome(`socket = "${hostSocket}"\n`),
      HC_SOCKET: join(privateRun, 'herdr-core', 'x.sock'),
    });
    expect(overridden.status).toBe(0);
  });

  it('refuses the host\'s own hc config, whatever it holds', () => {
    expect(run(['ls'], { ...privateEnv, XDG_CONFIG_HOME: join(hostHome, '.config') }).status).toBe(1);
    expect(run(['ls'], { XDG_RUNTIME_DIR: privateRun, HOME: hostHome }).status).toBe(1);
  });

  it('refuses a `..` it cannot resolve yet', () => {
    const r = run(['ls'], { ...privateEnv, HC_SOCKET: `${privateRun}/missing/../../../..${hostRun}/herdr-core/x.sock` });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('refuses a holder socket in the host runtime dir', () => {
    const holder = `${hostRun}/herdr-core/default.holder.00000000.sock`;
    expect(run(['hold', '--socket', holder], privateEnv).status).toBe(1);
    expect(run(['hold', `--socket=${holder}`], privateEnv).status).toBe(1);
  });

  it('runs BOTMUX_HC_TEST_BIN with the arguments untouched for a private core', () => {
    const r = run(['server', 'stop'], { ...privateEnv, HC_SESSION: 'bmt-x' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('REAL:server stop');
    expect(r.denied).toBe('');
    expect(run(['ls'], { ...privateEnv, HC_SOCKET: join(privateRun, 'herdr-core', 'x.sock') }).status).toBe(0);
    expect(run(['hold', '--socket', join(privateRun, 'herdr-core', 'x.holder.1.sock')], privateEnv).status).toBe(0);
  });

  it('reports hc as not installed (exit 127) without a usable BOTMUX_HC_TEST_BIN', () => {
    for (const bin of [undefined, 'herdr-core', join(binDir, 'herdr-core')]) {
      const r = run(['ls'], { ...privateEnv, BOTMUX_HC_TEST_BIN: bin });
      expect(r.status, String(bin)).toBe(127);
      expect(r.stdout).toBe('');
      expect(r.denied).toBe('');
    }
  });

  it('runs the run\'s binary for a caller whose env lost BOTMUX_HC_TEST_BIN, as hc\'s control env does', () => {
    const bakedDir = join(work, 'baked-bin');
    mkdirSync(bakedDir);
    const baked = join(bakedDir, 'hc');
    writeFileSync(baked, hcFenceShimScript(denyLog, bakedDir, [hostConfig], fakeReal));
    chmodSync(baked, 0o755);

    const r = run(['ls'], { ...privateEnv, BOTMUX_HC_TEST_BIN: undefined }, baked);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('REAL:ls');
    expect(run(['ls'], { ...privateEnv, BOTMUX_HC_TEST_BIN: 'herdr-core' }, baked).status).toBe(127);
    expect(run(['ls'], { HOME: privateHome, BOTMUX_HC_TEST_BIN: undefined }, baked).status).toBe(1);
  });

  it('lets version and help probes through without a runtime dir', () => {
    expect(run(['--version'], {}).stdout.trim()).toBe('REAL:--version');
    expect(run(['--help'], {}).status).toBe(0);
  });
});

describe.skipIf(!posix)('applyHcFenceEnv', () => {
  let fence: HcFence;
  beforeAll(() => { fence = createHcFence({ HOME: hostHome }); });
  afterAll(() => teardownHcFence(fence, {}));

  const inherited = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin:/bin',
    HOME: hostHome,
    XDG_RUNTIME_DIR: hostRun,
    HC_SOCKET: hostSocket,
    HC_SESSION: 'default',
    HC_TERMINAL_ID: 't1',
    HC_TERMINAL_SOCKET: `${hostRun}/herdr-core/default.holder.00000000.sock`,
    HC_QUIET_MS: '5',
    _HC_RESPONSIBLE_PID: '1',
    BOTMUX_HC_TEST_BIN: fakeReal,
  });

  it('drops every inherited HC_* variable and hands each process its own session and runtime dir', () => {
    const a = inherited();
    const b = inherited();
    applyHcFenceEnv(fence, a);
    applyHcFenceEnv(fence, b);
    expect(Object.keys(a).filter(k => /^_?HC_/.test(k))).toEqual(['HC_SESSION']);
    expect(a.HC_SESSION).not.toBe('default');
    expect(a.HC_SESSION).not.toBe(b.HC_SESSION);
    expect(a.XDG_RUNTIME_DIR).not.toBe(b.XDG_RUNTIME_DIR);
    expect(a.BOTMUX_HC_TEST_BIN).toBe(fakeReal);
  });

  it('gives an existing, private, short runtime dir and keeps hc state out of the real home', () => {
    const env = inherited();
    applyHcFenceEnv(fence, env);
    const dir = env.XDG_RUNTIME_DIR!;
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(dir === hostRun || dir.startsWith(`${hostRun}/`)).toBe(false);
    // hc caps socket paths, holder sockets included, at 107 bytes.
    expect(`${dir}/herdr-core/${env.HC_SESSION}.holder.ffffffff.sock`.length).toBeLessThanOrEqual(107);
    expect(env.XDG_STATE_HOME).toBeTruthy();
    expect(env.XDG_STATE_HOME!.startsWith(hostHome)).toBe(false);
  });

  it('puts hc config and state in the fenced home when there is one', () => {
    const home = join(work, 'fenced-home');
    const env = inherited();
    applyHcFenceEnv(fence, env, { home });
    expect(env.XDG_CONFIG_HOME).toBe(join(home, '.config'));
    expect(env.XDG_STATE_HOME).toBe(join(home, '.local', 'state'));
  });

  it('puts the shims first on PATH and names one in BOTMUX_HC_BIN', () => {
    const env = inherited();
    applyHcFenceEnv(fence, env);
    const first = env.PATH!.split(delimiter)[0]!;
    expect(env.BOTMUX_HC_BIN).toBeTruthy();
    expect(dirname(env.BOTMUX_HC_BIN!)).toBe(first);
    for (const name of ['hc', 'herdr-core']) expect(statSync(join(first, name)).mode & 0o111).not.toBe(0);
  });

  it('records a refusal where the run collects it', () => {
    const env = inherited();
    applyHcFenceEnv(fence, env);
    delete env.XDG_RUNTIME_DIR;
    const before = readHcFenceDenials(fence).length;
    const r = spawnSync(env.BOTMUX_HC_BIN!, ['ls'], { env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(readHcFenceDenials(fence).length).toBe(before + 1);
  });
});

/** The fence's shim behind `name` on this process's PATH, proven by a run that reaches no core. */
function shimOnPath(name: string): string {
  const located = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  expect(located).toBeTruthy();
  expect(dirname(located)).toBe(dirname(process.env.BOTMUX_HC_BIN ?? ''));
  const probe = spawnSync(located, ['--version'], {
    env: { PATH: process.env.PATH, BOTMUX_HC_TEST_BIN: fakeReal },
    encoding: 'utf8',
  });
  expect(probe.stdout.trim()).toBe('REAL:--version');
  return located;
}

describe.skipIf(!posix)('this test process is fenced', () => {
  it('carries no inherited HC_* variable, only its own HC_SESSION', () => {
    expect(Object.keys(process.env).filter(k => /^_?HC_/.test(k))).toEqual(['HC_SESSION']);
    expect(process.env.HC_SESSION).not.toBe('default');
  });

  it('has an existing, private, short XDG_RUNTIME_DIR and hc state in the fenced home', () => {
    const dir = process.env.XDG_RUNTIME_DIR;
    expect(dir).toBeTruthy();
    expect(statSync(dir!).isDirectory()).toBe(true);
    expect(statSync(dir!).mode & 0o777).toBe(0o700);
    expect(dir === hostRun || dir!.startsWith(`${hostRun}/`)).toBe(false);
    expect(`${dir}/herdr-core/${process.env.HC_SESSION}.holder.ffffffff.sock`.length).toBeLessThanOrEqual(107);
    expect(process.env.XDG_STATE_HOME?.startsWith(`${process.env.HOME}/`)).toBe(true);
  });

  it('resolves hc and herdr-core on PATH to the shim', () => {
    expect(shimOnPath('herdr-core')).toBe(process.env.BOTMUX_HC_BIN);
    expect(dirname(shimOnPath('hc'))).toBe(dirname(process.env.BOTMUX_HC_BIN!));
  });

  it.skipIf(!!process.env.BOTMUX_HC_TEST_BIN)('reports hc as missing in a run without a test binary', () => {
    for (const name of ['hc', 'herdr-core']) {
      expect(spawnSync(shimOnPath(name), ['ls'], { env: process.env, encoding: 'utf8' }).status).toBe(127);
    }
  });

  it.skipIf(!process.env.BOTMUX_HC_TEST_BIN)('reaches the run\'s test binary from a child env without BOTMUX* keys', () => {
    for (const name of ['hc', 'herdr-core']) {
      const r = spawnSync(shimOnPath(name), ['--version'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
      expect(r.stdout).toMatch(/^hc \d+\.\d+\.\d+/);
    }
  });

  it('makes the hc on PATH refuse a call that would reach the host runtime dir', () => {
    // Throwaway log: this deliberate refusal must not fail the file's own fence.
    const log = join(work, 'self-check.log');
    writeFileSync(log, '');
    const r = spawnSync(shimOnPath('hc'), ['ls'], {
      env: { PATH: process.env.PATH, BOTMUX_HC_FENCE_LOG: log, BOTMUX_HC_TEST_BIN: fakeReal },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(readFileSync(log, 'utf8')).not.toBe('');
  });
});
