/**
 * Boot-time autostart integration for the botmux daemon.
 *
 * macOS  — installs a LaunchAgent at ~/Library/LaunchAgents/com.botmux.daemon.plist
 *          and bootstraps it into the GUI domain (no sudo).
 * Linux  — installs a user systemd unit at ~/.config/systemd/user/botmux.service
 *          and enables it (no sudo). Reminds the user to run
 *          `loginctl enable-linger` if the unit needs to survive logout.
 * Windows — installs a per-user Task Scheduler task, or falls back to the
 *            current user's Startup folder if task registration is denied.
 *
 * The boot hook runs `botmux start`, the same path as a manual `botmux start`.
 * HOW it names botmux depends on the runtime shape — `node <PKG_ROOT>/dist/cli.js`
 * for a Node install, the compiled binary itself when there is no cli.js on disk;
 * see {@link launchProgram}, and do not reintroduce a `dist/cli.js` path that is
 * only correct for one of them. PATH from the install-time shell is captured into
 * the unit so node-pty / claude / codex resolve correctly when launchd or systemd
 * starts us with a minimal environment.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { isStandaloneBinary } from './core/self-spawn.js';

export interface AutostartOpts {
  /** Absolute path to the botmux package root (one level up from dist/). */
  pkgRoot: string;
  /** Absolute path to ~/.botmux. */
  configDir: string;
  /** Absolute path to the daemon log dir (used for launchd stdout/err). */
  logDir: string;
  /**
   * Runtime shape override, for tests. Production leaves this unset and the
   * answer comes from `isStandaloneBinary()`; the boot-hook renderers are pure
   * functions of their inputs so both shapes can be asserted without building a
   * real compiled binary. See {@link launchProgram}.
   */
  standalone?: boolean;
  /** Executable to name in the boot hook, for tests. Defaults to
   *  `process.execPath` (the Node binary, or the compiled binary itself). */
  execPath?: string;
}

/** Minimal registration state used by the Dashboard toggle. */
export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}

const LABEL = 'com.botmux.daemon';
const SERVICE_NAME = 'botmux.service';

/**
 * Env marker the generated boot hooks set on themselves, so `botmux start` can
 * tell it was launched at boot rather than by a person.
 *
 * WHY OUR OWN MARKER: systemd's `INVOCATION_ID` would match ANY systemd-run
 * process, not specifically our boot hook, and launchd/Windows set nothing
 * comparable — this works identically on all three.
 *
 * MUST BE CONSUMED AND DELETED by whoever reads it (see `cmdStart`). The fleet
 * spawns the supervisor with `{...process.env}`, and daemons/workers/session CLIs
 * inherit from there; a marker left in the environment would make any later
 * `botmux start` in a descendant look like a boot hook and silently skip the
 * autostart refresh and the dashboard hint.
 */
export const AUTOSTART_UNIT_ENV = 'BOTMUX_AUTOSTART_UNIT';

/**
 * Read the boot-hook marker and REMOVE it, whatever it held.
 *
 * Must be called before anything that can spawn a child or await: the fleet
 * supervisor is spawned with `{...process.env}` and daemons/workers/session CLIs
 * inherit from there, so a marker left in place would make a later `botmux start`
 * in any descendant look like a boot hook. Dependency probes/installers run as
 * children too, so "consume on entry" has to mean the very first statement.
 *
 * Deleting even on a non-'1' value is deliberate — the marker is single-use, and
 * leaving a stray unrecognised value behind would keep leaking to children.
 */
export function consumeAutostartUnitMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTOSTART_UNIT_ENV];
  delete env[AUTOSTART_UNIT_ENV];
  return raw === '1';
}

const WINDOWS_TASK_NAME = 'botmux-daemon';

function platform(): 'macos' | 'linux' | 'windows' | 'unsupported' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'windows';
  return 'unsupported';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SERVICE_NAME);
}

/**
 * The program arguments (executable first) that run botmux from a boot hook.
 * Callers append the subcommand (`start` / `stop`).
 *
 * NODE: `process.execPath` is the Node binary currently running cli.js, and the
 * script is `<pkgRoot>/dist/cli.js`. Using absolute paths means launchd/systemd
 * doesn't have to resolve `node` from a stripped PATH (and we keep the same Node
 * version the user installed botmux under, which matters for native modules like
 * node-pty).
 *
 * COMPILED BINARY: there is NO `dist/cli.js` on disk. The module graph lives in
 * the virtual, read-only `/$bunfs/`, so `join(pkgRoot,'dist','cli.js')` — pkgRoot
 * being `__dirname`-derived — yields a path that does not exist outside this
 * process. That is the documented `__dirname` hazard in CLAUDE.md, and a boot
 * hook is exactly the "path handed to another process" case it warns about.
 *
 * It FAILED SILENTLY, which is why this went unnoticed (MEASURED on a devbox
 * running the npm-installed compiled binary): the written unit was
 * `ExecStart=<binary> /$bunfs/dist/cli.js start`, and the binary parses that
 * bogus path as its subcommand token, does not recognise it, prints the help
 * text and exits 0. systemd sees success, `start` is swallowed as an argument,
 * and no daemon ever comes up — so the fleet does not return after a reboot and
 * nothing anywhere reports an error. `botmux restart` re-synced the unit on every
 * run, keeping the broken path fresh.
 *
 * The binary re-execs itself for every other child process (`resolveEntrySpawn`
 * in core/self-spawn.ts); a boot hook is the same shape, so it does the same
 * thing — and `process.execPath` IS the real on-disk binary in compiled mode
 * (verified: argv[1] is `/$bunfs/root/<name>` while execPath is the true path).
 */
export function launchProgram(opts: AutostartOpts): string[] {
  const exec = opts.execPath ?? process.execPath;
  const standalone = opts.standalone ?? isStandaloneBinary();
  if (standalone) return [exec];
  return [exec, join(opts.pkgRoot, 'dist', 'cli.js')];
}

/** {@link launchProgram} plus `sub`, rendered as one command line. `quote`
 *  wraps each element in double quotes (Windows .bat; systemd/launchd keep the
 *  historical unquoted/array forms). */
export function launchCommand(opts: AutostartOpts, sub: string, quote = false): string {
  const parts = [...launchProgram(opts), sub];
  return (quote ? parts.map((p) => `"${p}"`) : parts).join(' ');
}

function currentPath(): string {
  // Capture PATH from the install-time shell so the unit can find any
  // binaries the user expects (node-pty's `node`, the AI CLI binaries,
  // tmux, etc.). Falls back to a sane default if PATH is empty.
  const p = process.env.PATH || '';
  if (p) return p;
  return process.platform === 'darwin'
    ? '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin'
    : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

// ─── macOS (launchd) ─────────────────────────────────────────────────────────

export function plistContent(opts: AutostartOpts): string {
  // ProgramArguments is an array, so render one <string> per element: the
  // compiled binary contributes ONE element (itself), a Node install two
  // (node + dist/cli.js). See launchProgram.
  const program = launchProgram(opts)
    .map((p) => `        <string>${escapeXml(p)}</string>`)
    .join('\n');
  const cwd = escapeXml(opts.configDir);
  const path = escapeXml(currentPath());
  const outLog = escapeXml(join(opts.logDir, 'autostart-out.log'));
  const errLog = escapeXml(join(opts.logDir, 'autostart-err.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${program}
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${cwd}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path}</string>
        <key>${AUTOSTART_UNIT_ENV}</key>
        <string>1</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${outLog}</string>
    <key>StandardErrorPath</key>
    <string>${errLog}</string>
</dict>
</plist>
`;
}

function launchctlBootstrap(plist: string): boolean {
  // `launchctl bootstrap` is the modern replacement for `launchctl load -w`.
  // Falls back to the legacy form on older macOS where bootstrap is missing.
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'pipe' });
  if (r.status === 0) return true;
  const r2 = spawnSync('launchctl', ['load', '-w', plist], { stdio: 'pipe' });
  return r2.status === 0;
}

function launchctlBootout(): boolean {
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'pipe' });
  if (r.status === 0) return true;
  const r2 = spawnSync('launchctl', ['unload', '-w', plistPath()], { stdio: 'pipe' });
  return r2.status === 0;
}

function launchctlIsLoaded(): boolean {
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'pipe' });
  return r.status === 0;
}

function enableMac(opts: AutostartOpts): void {
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(opts.logDir, { recursive: true });
  writeFileSync(path, plistContent(opts));
  console.log(`✅ 已写入 LaunchAgent: ${path}`);
  // We deliberately do NOT bootstrap here — bootstrap on a RunAtLoad=true plist
  // would immediately fire `botmux start`, which surprises users who just
  // wanted to register autostart. launchd reads ~/Library/LaunchAgents/*.plist
  // at the next login and starts the agent then.
  if (launchctlIsLoaded()) {
    // If a previous version was already loaded, reload it so the freshly
    // written plist (with possibly updated paths) takes effect immediately.
    launchctlBootout();
    if (launchctlBootstrap(path)) {
      console.log(`✅ 已重新加载到 launchd (路径已更新)`);
    }
  } else {
    console.log(`   下次登录时自动启动。立即启动: botmux start`);
  }
}

function disableMac(): void {
  const path = plistPath();
  // bootout removes the agent from launchd's registry. Because the LaunchAgent's
  // ExecStart (`botmux start`) is fire-and-forget — pm2 forks away and the
  // launched process exits immediately — there is no live process for bootout
  // to kill. The pm2 daemon keeps running. To stop the daemon, the user runs
  // `botmux stop` explicitly.
  if (launchctlIsLoaded()) {
    if (launchctlBootout()) console.log(`✅ 已从 launchd 卸载 ${LABEL}`);
    else console.warn(`⚠️  launchctl 卸载失败，继续删除 plist`);
  }
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`✅ 已删除 ${path}`);
    console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
  } else {
    console.log(`ℹ️  ${path} 不存在，无需删除`);
  }
}

function statusMac(): void {
  const path = plistPath();
  const loaded = launchctlIsLoaded();
  console.log(`平台: macOS (launchd)`);
  console.log(`Plist 路径: ${path}`);
  console.log(`Plist 存在: ${existsSync(path) ? 'yes' : 'no'}`);
  console.log(`launchd 已加载: ${loaded ? 'yes' : 'no'}`);
  if (existsSync(path) && !loaded) {
    console.log(`提示: plist 已注册，将在下次登录时由 launchd 加载`);
  }
}

// ─── Linux (user systemd) ────────────────────────────────────────────────────

export function unitContent(opts: AutostartOpts): string {
  // Type=oneshot + RemainAfterExit=yes because `botmux start` hands the fleet to
  // the built-in supervisor, which is spawned detached and outlives the starting
  // process — `botmux start` then returns. Without RemainAfterExit systemd would
  // consider the unit "inactive (dead)" right after launch.
  return `[Unit]
Description=botmux daemon (IM <-> AI coding CLI bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${opts.configDir}
Environment=PATH=${currentPath()}
Environment=${AUTOSTART_UNIT_ENV}=1
ExecStart=${launchCommand(opts, 'start')}
ExecStop=${launchCommand(opts, 'stop')}

[Install]
WantedBy=default.target
`;
}

function userSystemdAvailable(): boolean {
  // Check the user manager is reachable. In containers / sshd-without-DBus
  // sessions `systemctl --user` will fail with "Failed to connect to bus".
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'pipe' });
  return r.status === 0;
}

function lingerEnabled(): boolean {
  const username = userInfo().username;
  const r = spawnSync('loginctl', ['show-user', username, '--property=Linger'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return r.stdout.toString().trim().endsWith('=yes');
}

function enableLinux(opts: AutostartOpts): void {
  if (!userSystemdAvailable()) {
    console.error(`❌ 当前会话连不上 user systemd（缺少 DBus / 容器环境）。`);
    console.error(``);
    console.error(`   回退方案：把下面这条写入系统级 cron / rc.local / 你常用的 init：`);
    console.error(`     ${launchCommand(opts, 'start')}`);
    console.error(``);
    console.error(`   或在有 systemd --user 的桌面环境里再次运行 botmux autostart enable。`);
    process.exit(1);
  }

  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitContent(opts));
  console.log(`✅ 已写入 systemd unit: ${path}`);

  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  if (reload.status !== 0) {
    console.error(`❌ systemctl --user daemon-reload 失败:`);
    console.error(reload.stderr.toString());
    process.exit(1);
  }

  // No `--now` here on purpose: enable should only register the autostart hook,
  // not interfere with whatever daemon state the user already has. Daemon
  // lifecycle stays under `botmux start`/`stop`. The unit will trigger on next
  // boot via WantedBy=default.target.
  const en = spawnSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'pipe' });
  if (en.status !== 0) {
    console.error(`❌ systemctl --user enable 失败:`);
    console.error(en.stderr.toString());
    process.exit(1);
  }
  console.log(`✅ 已启用 ${SERVICE_NAME}`);
  console.log(`   下次开机自动启动。立即启动: botmux start`);

  if (!lingerEnabled()) {
    const username = userInfo().username;
    console.log(``);
    console.log(`⚠️  Linger 未启用：登出当前会话后服务会停止。`);
    console.log(`   要让服务跨登出/重启常驻，运行（需要 sudo）:`);
    console.log(`     sudo loginctl enable-linger ${username}`);
  }
}

function disableLinux(): void {
  if (!userSystemdAvailable()) {
    console.error(`❌ 当前会话连不上 user systemd。`);
    console.error(`   如曾手工创建过 unit，请手动 rm: ${unitPath()}`);
    process.exit(1);
  }
  const path = unitPath();
  // No `--now`: only undo the boot hook. Without --now systemd skips ExecStop,
  // so the running pm2 daemon is left untouched. To stop it, the user runs
  // `botmux stop` (or `systemctl --user stop botmux.service` for a clean
  // ExecStop-mediated shutdown) explicitly.
  const dis = spawnSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'pipe' });
  if (dis.status === 0) console.log(`✅ 已禁用 ${SERVICE_NAME}`);
  else console.warn(`⚠️  disable 返回非零（可能本来就未启用）`);

  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`✅ 已删除 ${path}`);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  } else {
    console.log(`ℹ️  ${path} 不存在`);
  }
  console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
}

function statusLinux(): void {
  const path = unitPath();
  console.log(`平台: Linux (user systemd)`);
  console.log(`Unit 路径: ${path}`);
  console.log(`Unit 存在: ${existsSync(path) ? 'yes' : 'no'}`);
  if (!userSystemdAvailable()) {
    console.log(`user systemd: 不可用（缺少 DBus / 容器环境）`);
    return;
  }
  const isEnabled = spawnSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME], { stdio: 'pipe' });
  const isActive = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { stdio: 'pipe' });
  console.log(`enabled: ${isEnabled.stdout.toString().trim() || isEnabled.stderr.toString().trim()}`);
  console.log(`active: ${isActive.stdout.toString().trim() || isActive.stderr.toString().trim()}`);
  console.log(`Linger: ${lingerEnabled() ? 'yes' : 'no（登出后服务会停）'}`);
}

// ─── Windows (Task Scheduler / Startup folder) ─────────────────────────────

function escapeCmdValue(s: string): string {
  // Batch files expand %VAR% while parsing. Keep the captured PATH literal.
  return s.replace(/\^/g, '^^').replace(/%/g, '%%');
}

function escapeVbsString(s: string): string {
  return s.replace(/"/g, '""');
}

function windowsScriptPath(): string {
  return join(homedir(), '.botmux', 'autostart.cmd');
}

function windowsStartupDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}

function windowsStartupLauncherPath(): string {
  return join(windowsStartupDir(), 'botmux-autostart.vbs');
}

function windowsLogPath(opts: AutostartOpts, name: string): string {
  return join(opts.logDir, name);
}

export function windowsScriptContent(opts: AutostartOpts): string {
  const path = escapeCmdValue(currentPath());
  const cwd = opts.configDir;
  const outLog = windowsLogPath(opts, 'autostart-out.log');
  const errLog = windowsLogPath(opts, 'autostart-err.log');
  return `@echo off
setlocal
set "PATH=${path}"
set "${AUTOSTART_UNIT_ENV}=1"
cd /d "${cwd}"
${launchCommand(opts, 'start', true)} >> "${outLog}" 2>> "${errLog}"
`;
}

function windowsLauncherContent(scriptPath: string): string {
  const script = escapeVbsString(scriptPath);
  return `Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "${script}" & Chr(34), 0, False
`;
}

function windowsTaskExists(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { stdio: 'pipe' });
  return r.status === 0;
}

function createWindowsTask(scriptPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    'schtasks',
    ['/Create', '/TN', WINDOWS_TASK_NAME, '/SC', 'ONLOGON', '/TR', `"${scriptPath}"`, '/F'],
    { stdio: 'pipe' },
  );
}

function writeWindowsStartupLauncher(scriptPath: string): string {
  const launcher = windowsStartupLauncherPath();
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, windowsLauncherContent(scriptPath));
  return launcher;
}

function enableWindows(opts: AutostartOpts): void {
  const script = windowsScriptPath();
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(opts.logDir, { recursive: true });
  writeFileSync(script, windowsScriptContent(opts));
  console.log(`✅ 已写入 Windows 启动脚本: ${script}`);

  const r = createWindowsTask(script);
  if (r.status === 0) {
    console.log(`✅ 已创建/更新 Windows 任务计划: ${WINDOWS_TASK_NAME}`);
    const launcher = windowsStartupLauncherPath();
    if (existsSync(launcher)) {
      unlinkSync(launcher);
      console.log(`✅ 已清理 Startup 回退启动器: ${launcher}`);
    }
  } else {
    const msg = (r.stderr.toString() || r.stdout.toString()).trim();
    console.warn(`⚠️  任务计划创建失败，改用当前用户 Startup 文件夹自启。`);
    if (msg) console.warn(msg);
    const launcher = writeWindowsStartupLauncher(script);
    console.log(`✅ 已写入 Startup 启动器: ${launcher}`);
  }

  console.log(`   下次登录 Windows 时自动启动。立即启动: botmux start`);
}

function disableWindows(): void {
  const r = spawnSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], { stdio: 'pipe' });
  if (r.status === 0) {
    console.log(`✅ 已删除 Windows 任务计划: ${WINDOWS_TASK_NAME}`);
  } else {
    console.warn(`⚠️  删除任务计划返回非零（可能本来就未启用）`);
    const msg = (r.stderr.toString() || r.stdout.toString()).trim();
    if (msg) console.warn(msg);
  }

  const launcher = windowsStartupLauncherPath();
  if (existsSync(launcher)) {
    unlinkSync(launcher);
    console.log(`✅ 已删除 ${launcher}`);
  } else {
    console.log(`ℹ️  ${launcher} 不存在`);
  }

  const script = windowsScriptPath();
  if (existsSync(script)) {
    unlinkSync(script);
    console.log(`✅ 已删除 ${script}`);
  } else {
    console.log(`ℹ️  ${script} 不存在`);
  }
  console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
}

function statusWindows(): void {
  const script = windowsScriptPath();
  const launcher = windowsStartupLauncherPath();
  console.log(`平台: Windows (Task Scheduler / Startup folder)`);
  console.log(`任务名称: ${WINDOWS_TASK_NAME}`);
  console.log(`启动脚本: ${script}`);
  console.log(`启动脚本存在: ${existsSync(script) ? 'yes' : 'no'}`);
  console.log(`Startup 启动器: ${launcher}`);
  console.log(`Startup 启动器存在: ${existsSync(launcher) ? 'yes' : 'no'}`);

  const r = spawnSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V'], { stdio: 'pipe' });
  if (r.status === 0) {
    console.log(`任务计划存在: yes`);
    const text = r.stdout.toString().trim();
    if (text) console.log(text);
  } else {
    console.log(`任务计划存在: no`);
  }
}

// ─── Public dispatch ─────────────────────────────────────────────────────────

export function inspectAutostart(): AutostartState {
  switch (platform()) {
    case 'macos':
      return { supported: true, enabled: existsSync(plistPath()) };
    case 'linux': {
      if (!userSystemdAvailable()) {
        return { supported: true, enabled: existsSync(unitPath()) };
      }
      const result = spawnSync(
        'systemctl',
        ['--user', 'is-enabled', SERVICE_NAME],
        { stdio: 'pipe' },
      );
      return { supported: true, enabled: result.status === 0 };
    }
    case 'windows':
      return {
        supported: true,
        enabled: windowsTaskExists() || existsSync(windowsStartupLauncherPath()),
      };
    default:
      return { supported: false, enabled: false };
  }
}

export function enableAutostart(opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return enableMac(opts);
    case 'linux': return enableLinux(opts);
    case 'windows': return enableWindows(opts);
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      process.exit(1);
  }
}

export function disableAutostart(_opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return disableMac();
    case 'linux': return disableLinux();
    case 'windows': return disableWindows();
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      process.exit(1);
  }
}

export function autostartStatus(_opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return statusMac();
    case 'linux': return statusLinux();
    case 'windows': return statusWindows();
    default:
      console.log(`平台: ${process.platform} (不支持)`);
  }
}

/** Re-render the unit/plist file from the current paths without touching enable/disable state. */
export function refreshAutostart(opts: AutostartOpts): boolean {
  switch (platform()) {
    case 'macos': {
      const path = plistPath();
      if (!existsSync(path)) return false;
      // Only rewrite if content changed, to avoid unnecessary launchctl reload.
      const next = plistContent(opts);
      const prev = readFileSync(path, 'utf-8');
      if (prev === next) return false;
      writeFileSync(path, next);
      if (launchctlIsLoaded()) { launchctlBootout(); launchctlBootstrap(path); }
      return true;
    }
    case 'linux': {
      const path = unitPath();
      if (!existsSync(path)) return false;
      const next = unitContent(opts);
      const prev = readFileSync(path, 'utf-8');
      if (prev === next) return false;
      writeFileSync(path, next);
      if (userSystemdAvailable()) {
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
      }
      return true;
    }
    case 'windows': {
      const script = windowsScriptPath();
      const launcher = windowsStartupLauncherPath();
      if (!existsSync(script) && !existsSync(launcher) && !windowsTaskExists()) return false;

      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(opts.logDir, { recursive: true });
      const next = windowsScriptContent(opts);
      const prev = existsSync(script) ? readFileSync(script, 'utf-8') : '';
      let changed = prev !== next;
      if (changed) writeFileSync(script, next);

      const task = createWindowsTask(script);
      if (task.status === 0) {
        if (existsSync(launcher)) {
          unlinkSync(launcher);
          changed = true;
        }
        return changed;
      }

      const nextLauncher = windowsLauncherContent(script);
      const prevLauncher = existsSync(launcher) ? readFileSync(launcher, 'utf-8') : '';
      if (prevLauncher !== nextLauncher) {
        writeWindowsStartupLauncher(script);
        changed = true;
      }
      return changed;
    }
    default: return false;
  }
}
