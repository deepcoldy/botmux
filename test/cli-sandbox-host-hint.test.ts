import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectSandboxContext,
  explainFleetWriteError,
} from '../src/cli/sandbox-host-hint.js';
import { linuxIsolationLaunch } from '../src/core/linux-isolation.js';
import { IDENTITY_DENIED_EXIT_CODE, renderIdentityWrapper, writeSessionIdentity, bytedcliTurnHome } from '../src/core/cli-identity.js';
import { ensureSessionTempDir } from '../src/core/session-temp.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const cliEntry = join(repoRoot, 'src', 'cli.ts');
const linux = process.platform === 'linux';
// As root, nest the sandbox in its own private mount + PID namespace (see
// helpers/private-mount-ns.ts): nothing it mounts reaches the host, and its
// fresh /proc lets bwrap's own `--proc` work inside isolate-run too.
const nsPrefix = process.getuid?.() === 0
  ? ['setpriv', '--pdeathsig', 'KILL', 'unshare', '--mount', '--propagation', 'private',
    '--pid', '--fork', '--mount-proc', '--kill-child']
  : [];
function spawnBwrap(bin: string, args: readonly string[], options: Parameters<typeof spawnSync>[2] = {}) {
  const argv = [...nsPrefix, bin, ...args];
  return spawnSync(argv[0]!, argv.slice(1), { killSignal: 'SIGKILL', ...options });
}
const canRunBwrap = linux && ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch) && spawnBwrap('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/** A process whose cmdline carries the built-in supervisor role marker.
 *  /bin/sh is dash on Debian and its exec lacks -a, so use bash on Linux. */
function fakeSupervisor(): ChildProcess {
  const shell = process.platform === 'linux' ? '/bin/bash' : '/bin/sh';
  const child = spawn(shell, ['-c', 'exec -a __supervisor sleep 120'], { stdio: 'ignore' });
  if (typeof child.pid === 'number') children.push(child);
  return child;
}

/** A throwaway HOME with a fleet that "ran here": state file + logs dir. */
function fakeHome(opts: { logs?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-sbx-hint-'));
  roots.push(home);
  const botmux = join(home, '.botmux');
  mkdirSync(join(botmux, 'logs'), { recursive: true });
  mkdirSync(join(botmux, 'data'), { recursive: true });
  // Everything ensureConfigDir creates on a real host already exists.
  mkdirSync(join(botmux, 'heapshots'), { recursive: true });
  if (opts.logs) writeFileSync(join(botmux, 'logs', 'daemon-0-out.log'), 'hello from the daemon\n');
  return home;
}

function cliArgv(args: string[]): string[] {
  const { command, prefixArgs } = tsRunnerPrefix();
  return [command, ...prefixArgs, cliEntry, ...args];
}

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SESSION_DATA_DIR: join(home, '.botmux', 'data'),
    BOTS_CONFIG: join(home, '.botmux', 'bots.json'),
    ...extra,
  };
}

function runCli(home: string, args: string[], extra: Record<string, string> = {}) {
  const [command, ...rest] = cliArgv(args);
  return spawnSync(command!, rest, {
    cwd: repoRoot, env: cliEnv(home, extra), encoding: 'utf8', timeout: 60_000,
  });
}

/** Run the CLI the way a session sandbox does: bwrap with a fresh PID
 *  namespace, the host read-only, behind the botmux isolation seccomp marker
 *  (or without it, to model only a read-only home). */
function runCliInBwrap(home: string, args: string[], opts: { marker: boolean }) {
  const env = cliEnv(home);
  const bwrapArgs = ['--ro-bind', '/', '/', '--unshare-user', '--unshare-pid',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', home, home,
    ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]),
    '--chdir', repoRoot, '--', ...cliArgv(args)];
  const launch = opts.marker
    ? linuxIsolationLaunch('bwrap', bwrapArgs)
    : { bin: 'bwrap', args: bwrapArgs };
  return spawnBwrap(launch.bin, launch.args, { env, encoding: 'utf8', timeout: 60_000 }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}

describe('sandbox context detection', () => {
  it('treats a Linux isolation marker or a relay outbox as the sandbox, never BOTMUX_SANDBOX', () => {
    expect(detectSandboxContext({}, () => true)).toEqual({ hostProcessesHidden: true, inSandbox: true });
    expect(detectSandboxContext({ BOTMUX_SEND_RELAY: '/x/outbox' }, () => false))
      .toEqual({ hostProcessesHidden: false, inSandbox: true });
    // The host-side operator override also sits in the daemon's own env.
    expect(detectSandboxContext({ BOTMUX_SANDBOX: '1' }, () => false))
      .toEqual({ hostProcessesHidden: false, inSandbox: false });
    expect(detectSandboxContext({ BOTMUX_SEND_RELAY: '  ' }, () => false).inSandbox).toBe(false);
  });

  it('explains only read-only / permission errors and keeps the original error text', () => {
    const configDir = '/h/.botmux';
    const erofs = Object.assign(new Error("EROFS: read-only file system, open '/h/.botmux/pm2-fleet-mutation.lock'"), {
      code: 'EROFS', path: '/h/.botmux/pm2-fleet-mutation.lock',
    });
    const inSandbox = explainFleetWriteError(erofs, 'restart', { hostProcessesHidden: false, inSandbox: true }, configDir);
    expect(inSandbox?.message).toContain('/h/.botmux/pm2-fleet-mutation.lock');
    expect(inSandbox?.message).toContain('沙盒');
    expect(inSandbox?.message).toContain(erofs.message);
    const onHost = explainFleetWriteError(Object.assign(new Error('EACCES'), { code: 'EACCES' }), 'stop',
      { hostProcessesHidden: false, inSandbox: false }, configDir);
    expect(onHost?.message).not.toContain('沙盒内');
    expect(explainFleetWriteError(Object.assign(new Error('EPERM'), { code: 'EPERM' }), 'start',
      { hostProcessesHidden: false, inSandbox: false }, configDir)).toBeInstanceOf(Error);
    // A named path OUTSIDE the config dir (e.g. EACCES spawning a dependency
    // binary) must not be mislabelled a ~/.botmux write failure.
    const foreign = Object.assign(new Error('EACCES: permission denied, execve'), {
      code: 'EACCES', path: '/usr/local/bin/bun',
    });
    expect(explainFleetWriteError(foreign, 'restart',
      { hostProcessesHidden: false, inSandbox: true }, configDir)).toBeUndefined();
    // ENOENT from a recursive mkdir means "sealed home" only when the nearest
    // existing ancestor is not writable (Node reports ENOENT where Bun reports
    // EROFS for the same read-only bind mount).
    const enoent = Object.assign(new Error('ENOENT: no such file or directory, mkdir'), {
      code: 'ENOENT', path: '/h/.botmux/data',
    });
    const sealedProbe = { exists: (p: string) => p === '/h/.botmux', writable: () => false };
    const writableProbe = { exists: (p: string) => p === '/h/.botmux', writable: () => true };
    const sealed = explainFleetWriteError(enoent, 'start',
      { hostProcessesHidden: false, inSandbox: false }, configDir, sealedProbe);
    expect(sealed).toBeInstanceOf(Error);
    expect(sealed?.message).toContain('ENOENT');
    expect(explainFleetWriteError(enoent, 'start',
      { hostProcessesHidden: false, inSandbox: false }, configDir, writableProbe)).toBeUndefined();
    // A sealed ancestor on a path OUTSIDE the config dir is still not ours to explain.
    const foreignEnoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/etc/foo' });
    expect(explainFleetWriteError(foreignEnoent, 'start',
      { hostProcessesHidden: false, inSandbox: false }, configDir,
      { exists: () => true, writable: () => false })).toBeUndefined();
    for (const other of [Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), new Error('boom'), 'x', undefined]) {
      expect(explainFleetWriteError(other, 'stop', { hostProcessesHidden: false, inSandbox: true }, configDir)).toBeUndefined();
    }
  });
});

describe('fleet commands from a sandbox (no namespace needed)', () => {
  it('logs: missing host logs inside the sandbox are reported as unreadable, not as a stopped daemon', () => {
    const home = fakeHome();
    const inside = runCli(home, ['logs', '--no-follow'], { BOTMUX_SEND_RELAY: join(home, 'outbox') });
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain('沙盒');
    expect(inside.stderr).not.toContain('daemon 可能尚未启动');
    // Host behaviour is unchanged.
    const host = runCli(home, ['logs', '--no-follow']);
    expect(host.status).toBe(0);
    expect(host.stderr).toContain('daemon 可能尚未启动');
  }, 120_000);

  it('logs: visible logs are still printed inside the sandbox', () => {
    const home = fakeHome({ logs: true });
    const inside = runCli(home, ['logs', '--no-follow'], { BOTMUX_SEND_RELAY: join(home, 'outbox') });
    expect(inside.status).toBe(0);
    expect(inside.stdout).toContain('hello from the daemon');
  }, 60_000);

  it('status: a sandbox that can see processes keeps its output and adds a note', () => {
    const home = fakeHome();
    const inside = runCli(home, ['status'], { BOTMUX_SEND_RELAY: join(home, 'outbox') });
    expect(inside.status).toBe(0);
    expect(inside.stdout).toContain('daemon 未在运行');
    expect(inside.stdout).toContain('沙盒');
    const host = runCli(home, ['status']);
    expect(host.status).toBe(0);
    expect(host.stdout).not.toContain('沙盒');
  }, 120_000);

  it('status: a live supervisor with zero configured bots still carries the sandbox note', () => {
    const home = fakeHome();
    const sup = fakeSupervisor();
    expect(typeof sup.pid).toBe('number');
    writeFileSync(
      join(home, '.botmux', 'fleet-state.json'),
      JSON.stringify({ supervisorPid: sup.pid, supervisorStartedAt: new Date().toISOString(), procs: [] }),
    );
    const inside = runCli(home, ['status'], { BOTMUX_SEND_RELAY: join(home, 'outbox') });
    expect(inside.status).toBe(0);
    expect(inside.stdout).toContain('supervisor 在线');
    expect(inside.stdout).toContain('（无已配置机器人）');
    expect(inside.stdout).toContain('沙盒');
    const host = runCli(home, ['status']);
    expect(host.stdout).toContain('supervisor 在线');
    expect(host.stdout).not.toContain('沙盒');
  }, 120_000);
});

describe.skipIf(!canRunBwrap)('fleet commands inside a real PID-namespace sandbox', () => {
  it('status refuses instead of reporting a healthy fleet as stopped', () => {
    const home = fakeHome();
    const result = runCliInBwrap(home, ['status'], { marker: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('看不到宿主上的 supervisor');
    expect(result.stdout).not.toContain('supervisor 未在运行');
    expect(result.stdout).not.toContain('daemon 未在运行');
  }, 120_000);

  it('restart / stop refuse before touching the fleet lock', () => {
    const home = fakeHome();
    for (const command of ['restart', 'stop', 'start']) {
      const result = runCliInBwrap(home, [command], { marker: true });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`botmux ${command}`);
      expect(result.stderr).toContain('请在宿主终端执行');
      expect(result.stderr).not.toContain('EROFS');
    }
    expect(readdirSync(join(home, '.botmux')).some(name => name.endsWith('.lock'))).toBe(false);
  }, 180_000);

  it('a read-only ~/.botmux gives a readable error instead of the raw lock errno', () => {
    const home = fakeHome();
    const result = runCliInBwrap(home, ['stop'], { marker: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('没有写权限（EROFS）');
    expect(result.stderr).toContain('原始错误');
    expect(existsSync(join(home, '.botmux', 'watchdog-stopped'))).toBe(false);
  }, 120_000);

  it('start-bot/stop-bot on an existing read-only ~/.botmux converge on reason config_dir_not_writable', () => {
    // The lock error is thrown INSIDE ensureBotDaemonStarted/Stopped, whose
    // catch used to swallow it into reason supervisor_error with the raw EROFS.
    const home = fakeHome();
    const start = runCliInBwrap(home, ['start-bot', 'cli_x', '--json'], { marker: false });
    expect(start.status, start.stderr).toBe(1);
    expect(JSON.parse(start.stdout)).toMatchObject({ ok: false, reason: 'config_dir_not_writable' });
    const stop = runCliInBwrap(home, ['stop-bot', 'cli_x'], { marker: false });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toContain('需要写 ~/.botmux');
    expect(stop.stderr).toContain('EROFS');
    expect(stop.stderr).not.toContain('supervisor_error');
  }, 180_000);

  it('a missing ~/.botmux on a read-only home gives the SAME --json reason as an existing one', () => {
    // ensureConfigDir throws before the lock here (caught by the wrapper), so
    // the reason used to differ from the existing-dir path above.
    const bare = mkdtempSync(join(tmpdir(), 'botmux-bare-'));
    roots.push(bare);
    const result = runCliInBwrap(bare, ['start-bot', 'cli_x', '--json'], { marker: false });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, reason: 'config_dir_not_writable' });
  }, 120_000);

  it('the sandbox refusal is emitted as --json for the fleet mutation commands', () => {
    const home = fakeHome();
    const result = runCliInBwrap(home, ['start-bot', 'cli_x', '--json'], { marker: true });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'sandbox_host_processes_hidden' });
  }, 120_000);

  it('__watchdog is gated in a PID-namespace sandbox like start: silent exit 0, no fleet started', () => {
    const home = fakeHome();
    const result = runCliInBwrap(home, ['__watchdog'], { marker: true });
    // Exit 0 and silence on purpose: this is the host boot unit's periodic
    // entry, and a non-zero exit would drive a restart loop.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(existsSync(join(home, '.botmux', 'fleet-state.json'))).toBe(false);
    expect(readdirSync(join(home, '.botmux')).some(name => name.endsWith('.lock'))).toBe(false);
  }, 120_000);
});

describe('managed bytedcli wrapper: local login guard with a granted identity', () => {
  const SID = 'sess-bd-login';
  const OPEN = 'ou_bd_login_check';

  /** Publishes a real granted bytedcli user identity (so the post-identity
   *  guard is reachable) and returns the per-person scratch HOME #2550
   *  assigns this exec. The fake tool echoes a read-only-safe sentinel. */
  function fixture(): { root: string; wrapper: string; ranMarker: string; home: string; turnHome: string } {
    const root = mkdtempSync(join(tmpdir(), 'botmux-bd-login-'));
    roots.push(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    mkdirSync(join(home, '.local', 'share'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const ranMarker = join(root, 'ran');
    const real = join(root, 'real-bytedcli');
    writeFileSync(real, `#!/bin/sh
printf 'RAN:%s' "$*"
printf '%s\n' "$*" > '${ranMarker}' 2>/dev/null || true
exit 0
`);
    chmodSync(real, 0o755);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    let turnHome = '';
    try {
      // Establish the private 0700 /tmp/bm<uid> alias root in production order
      // FIRST. A bare recursive mkdirSync of turnHome below would otherwise
      // create the /tmp/bm<uid> ancestor as 0755 on a clean runner, tripping
      // ensureSessionTempRoot's private-dir fail-closed (and polluting every
      // other session-temp test in the same shard).
      ensureSessionTempDir(dataDir, SID);
      writeSessionIdentity(dataDir, SID, { tool: 'bytedcli', cloudJwt: 'jwt-x', openId: OPEN }, 'single');
      turnHome = bytedcliTurnHome(dataDir, SID, { openId: OPEN });
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
    mkdirSync(turnHome, { recursive: true });
    const wrapper = join(root, 'bytedcli');
    writeFileSync(wrapper, renderIdentityWrapper('bytedcli', real, 'single'));
    chmodSync(wrapper, 0o755);
    return { root, wrapper, ranMarker, home, turnHome };
  }

  function wrapperEnv(root: string): Record<string, string> {
    return {
      PATH: '/usr/bin:/bin', HOME: join(root, 'home'),
      SESSION_DATA_DIR: join(root, 'data'), BOTMUX_SESSION_ID: SID,
    };
  }

  it('lets a login through to the real tool on a writable (host) store', () => {
    const { root, wrapper, ranMarker } = fixture();
    const result = spawnSync('/bin/sh', [wrapper, 'auth', 'login'], {
      encoding: 'utf8', env: wrapperEnv(root),
    });
    expect(result.stderr).not.toContain('沙盒内不能本地登录');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RAN:auth login');
    expect(existsSync(ranMarker)).toBe(true);
  });

  it.skipIf(!canRunBwrap)('blocks login when the granted per-person HOME is read-only, other commands run', () => {
    const { root, wrapper, ranMarker, turnHome } = fixture();
    const run = (args: string[]) => {
      const env = wrapperEnv(root);
      // Whole fixture tree read-only, including the published scratch HOME.
      return spawnBwrap('bwrap', [
        '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
        '--ro-bind', root, root,
        ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]),
        '--', '/bin/sh', wrapper, ...args,
      ], { env, encoding: 'utf8', timeout: 20_000 }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
    };
    for (const args of [['auth', 'login'], ['login'], ['-j', 'auth', 'login'], ['-j', 'login']]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('沙盒内不能本地登录');
      // The message names the per-person HOME the login would really write to.
      expect(result.stderr).toContain(join(turnHome, '.local', 'share', 'bytedcli'));
      expect(result.stderr).not.toContain(join(root, 'home', '.local', 'share', 'bytedcli'));
      expect(result.stderr).toContain('/login');
      expect(result.stdout).toBe('');
    }
    // The guard is login-only: other commands reach the real tool.
    for (const args of [['auth', 'status'], ['-j', 'auth', 'status']]) {
      const status = run(args);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain('RAN:');
      expect(status.stderr).not.toContain('沙盒内不能本地登录');
    }
    // Login never ran; status's marker write fails on the read-only bind.
    expect(existsSync(ranMarker)).toBe(false);
  }, 90_000);

  it('still refuses with /login guidance when there is no usable identity (never execs)', () => {
    const { root, wrapper, ranMarker } = fixture();
    rmSync(join(root, 'data', 'cli-identity', `${SID}.bin`), { recursive: true, force: true });
    const result = spawnSync('/bin/sh', [wrapper, 'auth', 'login'], {
      encoding: 'utf8', env: wrapperEnv(root),
    });
    expect(result.status).toBe(IDENTITY_DENIED_EXIT_CODE);
    expect(result.stderr).toContain('/login');
    expect(existsSync(ranMarker)).toBe(false);
  });
});


describe.skipIf(!canRunBwrap)('bytedcli login guard vs the per-person scratch HOME (#2550 interaction)', () => {
  const SID = 'sess-bd-cross';
  const OPEN = 'ou_cross_pr_check';

  /** Real bwrap: machine HOME read-only; the published per-person HOME is a
   *  scratch dir. extraBinds add carve-outs on top of the read-only machine
   *  home (later binds win), modelling the worker's writable scratch bind. */
  function setup(opts: { writableScratch: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-bd-cross-'));
    roots.push(root);
    const machineHome = join(root, 'machine-home');
    mkdirSync(join(machineHome, '.local', 'share'), { recursive: true });
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    const real = join(root, 'real-bytedcli');
    writeFileSync(real, [
      '#!/bin/sh',
      'store="${XDG_DATA_HOME:-$HOME/.local/share}/bytedcli"',
      'if mkdir -p "$store/.__w" 2>/dev/null; then',
      '  rmdir "$store/.__w" 2>/dev/null',
      '  echo "login-ok" > "$store/login-ok"',
      '  printf "RAN store=%s HOME=%s" "$store" "$HOME"',
      '  exit 0',
      'fi',
      'printf "RFAIL store=%s" "$store" >&2',
      'exit 1',
    ].join('\n'));
    chmodSync(real, 0o755);

    // Publish a real granted user identity with the production HOME so the
    // scratch path is computed exactly as in production.
    const prevHome = process.env.HOME;
    process.env.HOME = machineHome;
    let turnHome = '';
    try {
      ensureSessionTempDir(dataDir, SID);
      writeSessionIdentity(dataDir, SID, { tool: 'bytedcli', cloudJwt: 'jwt-x', openId: OPEN }, 'single');
      turnHome = bytedcliTurnHome(dataDir, SID, { openId: OPEN });
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
    mkdirSync(turnHome, { recursive: true });
    const marker = join(turnHome, '.local', 'share', 'bytedcli', 'login-ok');

    const wrapper = join(root, 'bytedcli');
    writeFileSync(wrapper, renderIdentityWrapper('bytedcli', real, 'single'));
    chmodSync(wrapper, 0o755);

    const env = { PATH: '/usr/bin:/bin', HOME: machineHome, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: SID };
    const run = (args: string[]) => spawnBwrap('bwrap', [
      '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
      '--tmpfs', '/tmp',
      // The fixture (and the per-person scratch, which may live under /tmp)
      // must survive the private /tmp: on CI tmpdir() IS /tmp.
      '--ro-bind', root, root,
      '--ro-bind', machineHome, machineHome,
      ...(opts.writableScratch ? ['--bind', turnHome, turnHome] : ['--ro-bind', turnHome, turnHome]),
      '--bind', dataDir, dataDir,
      ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]),
      '--', '/bin/sh', wrapper, ...args,
    ], { env, encoding: 'utf8', timeout: 30_000 }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };

    return { run, marker, turnHome };
  }

  it('lets auth login run and write into the WRITABLE per-person scratch, not the read-only machine HOME', () => {
    const { run, marker, turnHome } = setup({ writableScratch: true });
    for (const args of [['auth', 'login'], ['-j', 'auth', 'login']]) {
      rmSync(marker, { force: true });
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('RAN');
      // It wrote under the per-person scratch HOME, nowhere near machine HOME.
      expect(result.stdout).toContain(`store=${join(turnHome, '.local', 'share', 'bytedcli')}`);
      expect(existsSync(marker)).toBe(true);
    }
  }, 90_000);

  it('still blocks auth login with guidance when the per-person target itself is not writable', () => {
    const { run, marker } = setup({ writableScratch: false });
    const result = run(['auth', 'login']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('沙盒内不能本地登录');
    expect(result.stdout).toBe('');
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});
