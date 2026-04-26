/**
 * Boot-time autostart integration for the botmux daemon.
 *
 * macOS  — installs a LaunchAgent at ~/Library/LaunchAgents/com.botmux.daemon.plist
 *          and bootstraps it into the GUI domain (no sudo).
 * Linux  — installs a user systemd unit at ~/.config/systemd/user/botmux.service
 *          and enables it (no sudo). Reminds the user to run
 *          `loginctl enable-linger` if the unit needs to survive logout.
 *
 * The unit invokes `node <PKG_ROOT>/dist/cli.js start`, which goes through
 * the same pm2 path as `botmux start`. PATH from the install-time shell is
 * captured into the unit so node-pty / claude / codex resolve correctly when
 * launchd or systemd starts us with a minimal environment.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';

export interface AutostartOpts {
  /** Absolute path to the botmux package root (one level up from dist/). */
  pkgRoot: string;
  /** Absolute path to ~/.botmux. */
  configDir: string;
  /** Absolute path to the daemon log dir (used for launchd stdout/err). */
  logDir: string;
}

const LABEL = 'com.botmux.daemon';
const SERVICE_NAME = 'botmux.service';

function platform(): 'macos' | 'linux' | 'unsupported' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
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

function nodeBin(): string {
  // process.execPath is the Node binary that's currently running cli.js.
  // Using its absolute path means launchd/systemd doesn't have to resolve
  // `node` from a stripped PATH (and we keep the same Node version the
  // user installed botmux under, which matters for native modules like
  // node-pty).
  return process.execPath;
}

function cliJs(opts: AutostartOpts): string {
  return join(opts.pkgRoot, 'dist', 'cli.js');
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

function plistContent(opts: AutostartOpts): string {
  const node = escapeXml(nodeBin());
  const cli = escapeXml(cliJs(opts));
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
        <string>${node}</string>
        <string>${cli}</string>
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
    console.log(`提示: plist 存在但未加载，运行 botmux autostart enable 重新激活`);
  }
}

// ─── Linux (user systemd) ────────────────────────────────────────────────────

function unitContent(opts: AutostartOpts): string {
  // Type=oneshot + RemainAfterExit=yes because `botmux start` calls pm2
  // start which forks and returns immediately; without RemainAfterExit
  // systemd would consider the unit "inactive (dead)" right after launch.
  return `[Unit]
Description=botmux daemon (IM <-> AI coding CLI bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${opts.configDir}
Environment=PATH=${currentPath()}
ExecStart=${nodeBin()} ${cliJs(opts)} start
ExecStop=${nodeBin()} ${cliJs(opts)} stop

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
    console.error(`     ${nodeBin()} ${cliJs(opts)} start`);
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

// ─── Public dispatch ─────────────────────────────────────────────────────────

export function enableAutostart(opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return enableMac(opts);
    case 'linux': return enableLinux(opts);
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      console.error(`   Windows 用户可用任务计划程序 (Task Scheduler) 调用:`);
      console.error(`     ${nodeBin()} ${cliJs(opts)} start`);
      process.exit(1);
  }
}

export function disableAutostart(_opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return disableMac();
    case 'linux': return disableLinux();
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      process.exit(1);
  }
}

export function autostartStatus(_opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return statusMac();
    case 'linux': return statusLinux();
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
    default: return false;
  }
}
