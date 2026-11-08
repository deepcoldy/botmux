/**
 * Regression tests for the boot hook's PATH.
 *
 * THE BUG (observed in production on a Linux fleet):
 *
 *   The systemd unit's `Environment=PATH=` was rendered from the PATH of
 *   whatever process happened to run `botmux start` / `botmux restart`, and
 *   the previous value was REPLACED, not merged. A restart issued from inside a
 *   botmux CLI session — whose PATH is the daemon's sanitized one, without the
 *   user's tool dirs — therefore rewrote the unit with a NARROWER PATH.
 *
 *   From that moment the fleet booted without `node` on PATH, and every
 *   Node-based CLI died instantly: `codex` is a `#!/usr/bin/env node` script, so
 *   the spawn failed with `env: 'node': No such file or directory` (exit 127).
 *   Native-binary CLIs (minimax) kept working, so only part of the fleet broke
 *   — and the unit file looked perfectly normal, which is why the cause stayed
 *   invisible from the outside.
 *
 * THE FIX: the boot hook's PATH is a MERGE of
 *   1. the user's login-shell PATH (what the user expects to find),
 *   2. the PATH the hook already carries (never shrink it),
 *   3. the PATH of the process writing the hook right now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const calls: { cmd: string; args: string[] }[] = [];
vi.mock('node:child_process', () => ({
  // Default stub: a login shell that reports a PATH. Tests that need a
  // different answer replace the implementation and restore it in afterEach.
  spawnSync: vi.fn((cmd: string, args: string[] | undefined) => {
    calls.push({ cmd, args: [...(args || [])] });
    return { status: 0, stdout: 'BOTMUX_LOGIN_PATH=/home/u/.local/bin:/usr/bin\n', stderr: '' };
  }),
}));

import {
  AUTOSTART_UNIT_ENV,
  autostartHookFileExists,
  autostartPath,
  bootHookPath,
  enableAutostart,
  mergePathEntries,
  plistPathFromContent,
  refreshAutostart,
  resolveLoginShellPath,
  unitPathFromContent,
  type AutostartOpts,
} from '../src/autostart.js';

let home: string;
function opts(over: Partial<AutostartOpts> = {}): AutostartOpts {
  return {
    pkgRoot: join(home ?? '/tmp', 'pkg'),
    configDir: join(home ?? '/tmp', '.botmux'),
    logDir: join(home ?? '/tmp', '.botmux', 'logs'),
    standalone: true,
    execPath: '/opt/botmux',
    environmentPath: '/usr/bin:/bin',
    ...over,
  };
}

function unitDir(): string {
  return join(home, '.config', 'systemd', 'user');
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
  calls.length = 0;
  // Restore the module-level stub: a test that replaced the implementation
  // must not leak a "shell failed" stub into the next one.
  vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[] | undefined) => {
    calls.push({ cmd, args: [...(args || [])] });
    return { status: 0, stdout: 'BOTMUX_LOGIN_PATH=/home/u/.local/bin:/usr/bin\n', stderr: '' };
  }) as never);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('boot hook PATH merge', () => {
  it('keeps the preferred order and appends only missing entries', () => {
    expect(mergePathEntries('/a:/b', '/b:/c')).toBe('/a:/b:/c');
    expect(mergePathEntries('', '/x:/y')).toBe('/x:/y');
    expect(mergePathEntries('/a', '')).toBe('/a');
    expect(mergePathEntries('/a:/a:/b', '/b')).toBe('/a:/b');
  });

  it('uses ";" as separator on Windows', () => {
    expect(mergePathEntries('C:\\a;C:\\b', 'C:\\b;C:\\c', ';')).toBe('C:\\a;C:\\b;C:\\c');
  });

  it('bootHookPath never drops the login-shell or already-persisted entries', () => {
    const merged = bootHookPath({
      callerPath: '/usr/bin:/bin',
      existingPath: '/home/u/.local/bin:/usr/bin',
      loginPath: '/home/u/.local/bin:/opt/tools',
      targetPlatform: 'linux',
    });
    // The narrow caller PATH must not have removed the user's tool dirs.
    expect(merged).toContain('/home/u/.local/bin');
    expect(merged).toContain('/opt/tools');
    expect(merged).toContain('/usr/bin');
  });

  it('bootHookPath falls back to the caller PATH when there is nothing else', () => {
    expect(bootHookPath({ callerPath: '/usr/bin', targetPlatform: 'linux' })).toBe('/usr/bin');
  });

  it('bootHookPath drops session-scoped identity paths', () => {
    const merged = bootHookPath({
      callerPath: '/home/u/.botmux/data/cli-identity/abc.bin:/usr/bin',
      targetPlatform: 'linux',
    });
    expect(merged).not.toContain('cli-identity');
    expect(merged).toContain('/usr/bin');
  });

  it('bootHookPath rewrites fnm per-shell shims to the durable install dir', () => {
    // fnm gives every shell its own pid/timestamp-stamped shim directory in
    // tmpfs (/run/user/<uid>/...) or under ~/.local/state, and that directory
    // is a symlink to the version's installation. Persisting the shim path is
    // useless twice over: it is gone by the next boot and it makes every
    // render differ. But on a stock fnm install it is ALSO the only entry that
    // provides `node`, so it must be rewritten, never dropped.
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const installation = join(home, 'share/fnm/node-versions/v22.21.1/installation');
    mkdirSync(join(installation, 'bin'), { recursive: true });
    const shims = ['run', 'state'].map((kind, i) => {
      const multishell = join(home, kind, 'fnm_multishells', `${1000 + i}_179392831059${i}`);
      mkdirSync(dirname(multishell), { recursive: true });
      // fnm symlinks the pid/timestamp directory itself to the installation.
      symlinkSync(installation, multishell);
      return join(multishell, 'bin');
    });

    const merged = bootHookPath({
      callerPath: `${shims[0]}:${shims[1]}:/usr/bin`,
      targetPlatform: 'linux',
    });
    expect(merged).not.toContain('fnm_multishells');
    // The rewrite is what keeps `node` reachable at boot: the durable dir is
    // the shim's own target (realpath'd, hence the tmpdir symlink resolution),
    // and both shims collapse onto it.
    const durable = join(realpathSync(installation), 'bin');
    expect(merged).toBe(`${durable}:/usr/bin`);

    // Sanitizing is terminal: a shim is rewritten no matter which tier
    // (login / existing / caller) brought it in.
    const fromExisting = bootHookPath({
      callerPath: '/usr/bin',
      existingPath: `${shims[0]}:/keep`,
      targetPlatform: 'linux',
    });
    expect(fromExisting).not.toContain('fnm_multishells');
    expect(fromExisting).toContain(durable);
    expect(fromExisting).toContain('/keep');
  });

  it('drops an fnm shim that no longer resolves', () => {
    // A shim whose target was removed (fnm GC, uninstalled version) has no
    // durable directory to point at; keeping the dead path only accumulates.
    const out = autostartPath('/nonexistent/fnm_multishells/42_1/bin:/usr/bin', 'linux');
    expect(out).not.toContain('fnm_multishells');
    expect(out).toBe('/usr/bin');
  });

  it('rewrites backslash-form multishell entries too', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const installation = join(home, 'share\\fnm\\node-versions\\v22.21.1\\installation');
    mkdirSync(installation, { recursive: true });
    const multishell = join(home, 'state\\fnm_multishells\\42_1');
    mkdirSync(dirname(multishell), { recursive: true });
    symlinkSync(installation, multishell);

    const out = autostartPath(`${multishell}\\bin;C:\\Windows`, 'win32');
    expect(out).not.toContain('fnm_multishells');
    expect(out).toContain('C:\\Windows');
  });
});

describe('boot hook PATH parsing', () => {
  it('reads the PATH out of a systemd unit', () => {
    expect(unitPathFromContent('[Service]\nEnvironment=PATH=/a:/b\nEnvironment=X=1\n')).toBe('/a:/b');
    expect(unitPathFromContent('[Service]\nEnvironment=X=1\n')).toBeUndefined();
  });

  it('reads the PATH out of a launchd plist', () => {
    const plist = '<dict>\n<key>EnvironmentVariables</key>\n<dict>\n<key>PATH</key>\n<string>/a:/b</string>\n</dict>\n</dict>';
    expect(plistPathFromContent(plist)).toBe('/a:/b');
    expect(plistPathFromContent('<dict></dict>')).toBeUndefined();
  });
});

describe('login shell PATH', () => {
  it('reads the marked PATH line and ignores rc banners', () => {
    vi.mocked(spawnSync).mockImplementationOnce((() => ({
      status: 0,
      stdout: 'welcome to my shell\nBOTMUX_LOGIN_PATH=/home/u/.local/bin\n',
      stderr: '',
    })) as never);
    // Every probe contributes; the banner never does.
    expect(resolveLoginShellPath()).toBe('/home/u/.local/bin:/usr/bin');
  });

  it('returns undefined when no shell answers', () => {
    vi.mocked(spawnSync).mockImplementation((() => ({ status: 1, stdout: '', stderr: '' })) as never);
    expect(resolveLoginShellPath()).toBeUndefined();
  });
});

describe('refreshAutostart keeps the unit PATH', () => {
  it('does not shrink an existing unit PATH when re-rendered from a narrow environment', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const dir = unitDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'botmux.service'),
      '[Unit]\nDescription=botmux daemon\n\n[Service]\nEnvironment=PATH=/home/u/.local/bin:/usr/bin\nEnvironment=X=1\n',
    );

    // A CLI session's PATH: no user tool dirs at all.
    refreshAutostart(opts({ environmentPath: '/opt/botmux/bin:/usr/bin:/bin' }));

    const unit = readFileSync(join(dir, 'botmux.service'), 'utf-8');
    expect(unitPathFromContent(unit)).toContain('/home/u/.local/bin');
    expect(unitPathFromContent(unit)).toContain('/usr/bin');
  });

  it('adds the login-shell PATH to an existing unit', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const dir = unitDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'botmux.service'), '[Service]\nEnvironment=PATH=/usr/bin\n');

    refreshAutostart(opts({
      environmentPath: '/usr/bin:/bin',
      loginShellPath: '/home/u/.local/bin:/usr/bin',
    }));

    const unit = readFileSync(join(dir, 'botmux.service'), 'utf-8');
    expect(unitPathFromContent(unit)).toContain('/home/u/.local/bin');
  });

  it('keeps the watchdog service PATH in sync with the same rule', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    enableAutostart(opts({ environmentPath: '/home/u/.local/bin:/usr/bin' }));

    const dir = unitDir();
    const service = readFileSync(join(dir, 'botmux-watchdog.service'), 'utf-8');
    expect(service).toContain('Environment=PATH=/home/u/.local/bin:/usr/bin');
    expect(service).toContain(`Environment=${AUTOSTART_UNIT_ENV}=1`);
  });

  it('re-enabling does not shrink a unit that already carried a wider PATH', () => {
    // enableAutostart path (not just refresh): a pre-existing unit file must
    // keep entries neither the caller PATH nor the login PATH has.
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const dir = unitDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'botmux.service'),
      '[Service]\nEnvironment=PATH=/home/u/legacy-tools:/usr/bin\n',
    );

    enableAutostart(opts({
      environmentPath: '/usr/bin:/bin',
      loginShellPath: undefined,
    }));

    const unit = readFileSync(join(dir, 'botmux.service'), 'utf-8');
    expect(unitPathFromContent(unit)).toContain('/home/u/legacy-tools');
  });

  it('refresh keeps a wider PATH already carried by the watchdog service', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const dir = unitDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'botmux.service'), '[Service]\nEnvironment=PATH=/usr/bin\n');
    writeFileSync(
      join(dir, 'botmux-watchdog.service'),
      `[Service]\nEnvironment=PATH=/home/u/watchdog-tools:/usr/bin\n`
      + `Environment=${AUTOSTART_UNIT_ENV}=1\nExecStart=x __watchdog\n`,
    );

    refreshAutostart(opts({
      environmentPath: '/usr/bin:/bin',
      loginShellPath: undefined,
    }));

    const service = readFileSync(join(dir, 'botmux-watchdog.service'), 'utf-8');
    expect(unitPathFromContent(service)).toContain('/home/u/watchdog-tools');
  });

  it('a second refresh with an unchanged login PATH is a no-op', () => {
    // Regression: per-shell shim dirs (fnm_multishells) made the rendered unit
    // differ on every probe, so refresh rewrote + reloaded on every run even
    // when nothing real changed. With those stripped, stable inputs must render
    // a stable file.
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const dir = unitDir();
    mkdirSync(dir, { recursive: true });
    const unitFile = join(dir, 'botmux.service');
    writeFileSync(unitFile, '[Service]\nEnvironment=PATH=/usr/bin\n');
    // The stubbed "login shell" reports the SAME stable PATH on every probe.
    const stableOpts = () => opts({
      environmentPath: '/usr/bin:/bin',
      loginShellPath: '/home/u/.local/bin:/usr/bin',
    });

    expect(refreshAutostart(stableOpts())).toBe(true);
    const afterFirst = readFileSync(unitFile, 'utf-8');
    expect(unitPathFromContent(afterFirst)).toContain('/home/u/.local/bin');

    expect(refreshAutostart(stableOpts())).toBe(false);
    expect(readFileSync(unitFile, 'utf-8')).toBe(afterFirst);
  });
});

describe('login-shell probe gate', () => {
  it('reports whether a boot hook file exists without spawning anything', () => {
    // This is the \"is the probe worth paying for\" gate used by start/restart:
    // refresh is a no-op when no hook file exists, so eight synchronous shell
    // probes there would be pure latency for users who never enabled autostart.
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(autostartHookFileExists()).toBe(false);
    expect(calls).toHaveLength(0);

    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'botmux.service'), '[Service]\nEnvironment=PATH=/usr/bin\n');
    expect(autostartHookFileExists()).toBe(true);
    // File checks only: the answer must never cost a child process.
    expect(calls).toHaveLength(0);
  });

  it('reports a launchd plist on macOS', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    expect(autostartHookFileExists()).toBe(false);
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'com.botmux.daemon.plist'), '<plist/>');
    expect(autostartHookFileExists()).toBe(true);
  });

  it('reports nothing installable on an unsupported platform', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('aix');
    expect(autostartHookFileExists()).toBe(false);
  });
});
