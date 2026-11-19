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
 *   3. the PATH of the process writing the hook right now,
 *   4. the tool dirs botmux's installer manages — the one tier no environment
 *      can lose, so a unit that was already rendered too narrow heals itself.
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
  managedToolDirs,
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

describe('installer-managed Node runtime', () => {
  // The one-click installer keeps its own Node under
  // ~/.local/share/botmux/node-<version>-<os>-<arch>, and `npm i -g` run with
  // that Node puts lark-cli / agentbuddy into its bin. The installer only adds
  // ~/.local/bin to the shell profile, so once a unit has lost this directory
  // neither the login shell nor a narrow caller can bring it back.
  const SYSTEM_DEFAULT = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  function installerNode(version: string, os = 'linux', arch = cpu, withBin = true): string {
    const root = join(home, '.local', 'share', 'botmux', `node-${version}-${os}-${arch}`);
    mkdirSync(withBin ? join(root, 'bin') : root, { recursive: true });
    return join(root, 'bin');
  }
  function linuxHome(): void {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  }
  function brokenUnits(): void {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'botmux.service'), `[Service]\nEnvironment=PATH=${SYSTEM_DEFAULT}\n`);
    writeFileSync(
      join(unitDir(), 'botmux-watchdog.service'),
      `[Service]\nEnvironment=PATH=${SYSTEM_DEFAULT}\nEnvironment=${AUTOSTART_UNIT_ENV}=1\nExecStart=x __watchdog\n`,
    );
  }
  const unitEntries = (name: string) =>
    unitPathFromContent(readFileSync(join(unitDir(), name), 'utf-8'))!.split(':');

  it('refresh restores the managed Node bin to units that lost it', () => {
    linuxHome();
    const bin = installerNode('v22.23.1');
    brokenUnits();
    const narrow = () => opts({
      environmentPath: SYSTEM_DEFAULT,
      loginShellPath: '/home/u/.local/bin:/usr/bin',
    });

    expect(refreshAutostart(narrow())).toBe(true);
    expect(unitEntries('botmux.service')).toContain(bin);
    expect(unitEntries('botmux-watchdog.service')).toContain(bin);

    // Stable inputs render a stable file: no rewrite + daemon-reload per start.
    const unit = readFileSync(join(unitDir(), 'botmux.service'), 'utf-8');
    expect(refreshAutostart(narrow())).toBe(false);
    expect(readFileSync(join(unitDir(), 'botmux.service'), 'utf-8')).toBe(unit);
  });

  it('autostart enable writes the managed Node bin over a broken unit', () => {
    linuxHome();
    const bin = installerNode('v22.23.1');
    brokenUnits();

    enableAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }));

    expect(unitEntries('botmux.service')).toContain(bin);
    expect(unitEntries('botmux-watchdog.service')).toContain(bin);
  });

  it('adds nothing when the installer has no Node for this machine', () => {
    linuxHome();
    installerNode('v22.23.1', 'linux', cpu === 'x64' ? 'arm64' : 'x64');
    installerNode('v22.23.1', 'darwin');
    installerNode('v24.1.0', 'linux', cpu, false);
    mkdirSync(join(home, '.local', 'share', 'botmux', 'installer', 'bin'), { recursive: true });
    brokenUnits();

    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }));

    expect(unitEntries('botmux.service').join(':')).toBe(SYSTEM_DEFAULT);
  });

  it('keeps a managed dir where a healthy unit already has it', () => {
    linuxHome();
    const bin = installerNode('v22.23.1');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'botmux.service'), `[Service]\nEnvironment=PATH=${bin}:${SYSTEM_DEFAULT}\n`);

    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }));

    // Its `node` must keep winning over /usr/bin/node.
    expect(unitEntries('botmux.service')).toEqual([bin, ...SYSTEM_DEFAULT.split(':')]);
  });

  it('follows the installer: a newer runtime goes ahead, a removed one drops out', () => {
    linuxHome();
    const old = installerNode('v22.9.0');
    brokenUnits();
    const narrow = () => opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined });
    refreshAutostart(narrow());
    expect(unitEntries('botmux.service')).toEqual([...SYSTEM_DEFAULT.split(':'), old]);

    // The unit now persists `old`, so it comes back as tier 2 on every render.
    const newer = installerNode('v22.23.1');
    expect(refreshAutostart(narrow())).toBe(true);
    expect(unitEntries('botmux.service')).toEqual([...SYSTEM_DEFAULT.split(':'), newer, old]);
    expect(unitEntries('botmux-watchdog.service')).toEqual([...SYSTEM_DEFAULT.split(':'), newer, old]);

    rmSync(dirname(old), { recursive: true });
    expect(refreshAutostart(narrow())).toBe(true);
    expect(unitEntries('botmux.service')).toEqual([...SYSTEM_DEFAULT.split(':'), newer]);
    expect(unitEntries('botmux-watchdog.service')).toEqual([...SYSTEM_DEFAULT.split(':'), newer]);
  });

  it('puts the new runtime where the unit had the one it replaced', () => {
    linuxHome();
    const old = installerNode('v22.9.0');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'botmux.service'), `[Service]\nEnvironment=PATH=${old}:${SYSTEM_DEFAULT}\n`);
    const newer = installerNode('v24.1.0');
    rmSync(dirname(old), { recursive: true });

    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }));

    expect(unitEntries('botmux.service')).toEqual([newer, ...SYSTEM_DEFAULT.split(':')]);
  });

  it('drops only installer runtimes that are gone, nothing else', () => {
    linuxHome();
    const bin = installerNode('v22.23.1');
    const otherCpu = installerNode('v22.9.0', 'linux', cpu === 'x64' ? 'arm64' : 'x64');
    const gone = join(home, '.local', 'share', 'botmux', `node-v18.0.0-linux-${cpu}`, 'bin');
    const elsewhere = join(home, 'opt', `node-v18.0.0-linux-${cpu}`, 'bin');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(
      join(unitDir(), 'botmux.service'),
      `[Service]\nEnvironment=PATH=${otherCpu}:${gone}:${elsewhere}:${SYSTEM_DEFAULT}\n`,
    );

    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }));

    // Another CPU's runtime still exists, and a lookalike outside the installer root is not ours.
    expect(unitEntries('botmux.service')).toEqual([otherCpu, bin, elsewhere, ...SYSTEM_DEFAULT.split(':')]);
  });

  it('keeps the entries while the installer shows no runtime at all', () => {
    linuxHome();
    const bin = installerNode('v22.23.1');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'botmux.service'), `[Service]\nEnvironment=PATH=${bin}:${SYSTEM_DEFAULT}\n`);
    const narrow = () => opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined });
    const root = join(home, '.local', 'share', 'botmux');

    // A re-install in progress or a share not mounted yet: missing, then empty.
    rmSync(root, { recursive: true });
    refreshAutostart(narrow());
    expect(unitEntries('botmux.service')).toEqual([bin, ...SYSTEM_DEFAULT.split(':')]);
    mkdirSync(root);
    refreshAutostart(narrow());
    expect(unitEntries('botmux.service')).toEqual([bin, ...SYSTEM_DEFAULT.split(':')]);

    installerNode('v22.23.1');
    refreshAutostart(narrow());
    expect(unitEntries('botmux.service')).toEqual([bin, ...SYSTEM_DEFAULT.split(':')]);
  });

  it("keeps the login shell's order when a later login probe fails", () => {
    linuxHome();
    const older = installerNode('v22.23.1');
    const newer = installerNode('v24.1.0');
    brokenUnits();

    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: `${older}:/usr/bin` }));
    const unit = readFileSync(join(unitDir(), 'botmux.service'), 'utf-8');
    expect(unitEntries('botmux.service').slice(0, 2)).toEqual([older, newer]);

    expect(refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: undefined }))).toBe(false);
    expect(readFileSync(join(unitDir(), 'botmux.service'), 'utf-8')).toBe(unit);

    // A login PATH that answers again still wins over the persisted order.
    refreshAutostart(opts({ environmentPath: SYSTEM_DEFAULT, loginShellPath: `${newer}:/usr/bin` }));
    expect(unitEntries('botmux.service').slice(0, 2)).toEqual([newer, older]);
  });

  it('writes the managed Node bin into the macOS LaunchAgent too', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const bin = installerNode('v22.23.1', 'darwin');
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const plist = join(agents, 'com.botmux.daemon.plist');
    writeFileSync(plist, '<dict>\n<key>PATH</key>\n<string>/usr/bin:/bin</string>\n</dict>\n');

    expect(refreshAutostart(opts({ environmentPath: '/usr/bin:/bin', loginShellPath: undefined }))).toBe(true);
    expect(plistPathFromContent(readFileSync(plist, 'utf-8'))).toBe(`/usr/bin:/bin:${bin}`);
  });

  it('lists the runtimes for this OS and CPU, newest first', () => {
    home = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    // Neither creation order nor name order is version order.
    const [v22_23_10, v24, v22_9, v22_23_1] = ['v22.23.10', 'v24.1.0', 'v22.9.0', 'v22.23.1']
      .map(version => installerNode(version, 'linux', 'x64'));
    installerNode('v24.2.0', 'linux', 'arm64');
    const mac = installerNode('v22.23.1', 'darwin', 'arm64');

    expect(managedToolDirs(home, 'linux', 'x64')).toEqual([v24, v22_23_10, v22_23_1, v22_9]);
    expect(managedToolDirs(home, 'darwin', 'arm64')).toEqual([mac]);
    expect(managedToolDirs(home, 'win32', 'x64')).toEqual([]);
  });

  it('only fills gaps: every other tier keeps its precedence', () => {
    const merged = bootHookPath({
      callerPath: '/usr/bin:/bin',
      existingPath: '/opt/kept',
      loginPath: '/home/u/.local/bin',
      managedDirs: ['/managed/node/bin'],
      targetPlatform: 'linux',
    });
    // A command any tier already resolves keeps resolving to the same file.
    expect(merged).toBe('/home/u/.local/bin:/opt/kept:/usr/bin:/bin:/managed/node/bin');
  });

  it("keeps the login shell's order of the managed dirs", () => {
    expect(bootHookPath({
      callerPath: '/usr/bin:/bin',
      loginPath: '/managed/v22/bin:/usr/bin',
      managedDirs: ['/managed/v24/bin', '/managed/v22/bin'],
      targetPlatform: 'linux',
    })).toBe('/managed/v22/bin:/managed/v24/bin:/usr/bin:/bin');
  });

  it('does not let the managed dirs replace the system default fallback', () => {
    const managedDirs = ['/managed/node/bin'];
    expect(bootHookPath({ callerPath: '', managedDirs, targetPlatform: 'linux' }))
      .toBe(`${SYSTEM_DEFAULT}:/managed/node/bin`);
    const onlyManaged = bootHookPath({ callerPath: '/managed/node/bin', managedDirs, targetPlatform: 'linux' });
    expect(onlyManaged).toBe(`/managed/node/bin:${SYSTEM_DEFAULT}`);
    // Read back as tier 2 on the next render, it must not flip.
    expect(bootHookPath({ callerPath: '/managed/node/bin', existingPath: onlyManaged, managedDirs, targetPlatform: 'linux' }))
      .toBe(onlyManaged);
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
