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
 * The unit invokes `node <PKG_ROOT>/dist/cli.js start`, which goes through
 * the same pm2 path as `botmux start`. PATH from the install-time shell is
 * captured into the unit so node-pty / claude / codex resolve correctly when
 * launchd or systemd starts us with a minimal environment.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import {
  BOTMUX_SYSTEMD_SERVICE,
  BOTMUX_SYSTEMD_SERVICE_ENV,
  ExternalPm2GodOwnershipError,
  describeExternalPm2Owner,
  inspectLinuxPm2GodOwnership,
  revalidateLinuxPm2GodProcess,
  type LinuxPm2GodProcess,
} from './core/pm2-lifecycle-owner.js';

export interface AutostartOpts {
  /** Absolute path to the botmux package root (one level up from dist/). */
  pkgRoot: string;
  /** Absolute path to ~/.botmux. */
  configDir: string;
  /** Absolute path to the daemon log dir (used for launchd stdout/err). */
  logDir: string;
}

/** Minimal registration state used by the Dashboard toggle. */
export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}

const LABEL = 'com.botmux.daemon';
const SERVICE_NAME = BOTMUX_SYSTEMD_SERVICE;
const SYSTEMCTL_DEFAULT_TIMEOUT_MS = 10_000;
// A restart job may wait behind unrelated user-manager work. Enqueue it
// without blocking, then poll explicitly; on expiry we cancel the unit job and
// keep the repair driver alive until systemd confirms there is no late restart.
const SYSTEMD_RESTART_JOB_WAIT_MS = 255_000;
const SYSTEMD_CANCEL_SETTLE_WAIT_MS = 240_000;
const SYSTEMD_JOB_POLL_MS = 200;
const SYSTEMD_JOB_POLL_BUFFER = new Int32Array(new SharedArrayBuffer(4));
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
    console.log(`提示: plist 已注册，将在下次登录时由 launchd 加载`);
  }
}

// ─── Linux (user systemd) ────────────────────────────────────────────────────

export function renderLinuxSystemdUnit(opts: AutostartOpts): string {
  // PM2 forks its God daemon and records the child PID before `botmux start`
  // returns. Type=forking + PIDFile makes that God the service's MainPID, so
  // systemd owns both its cgroup and its lifetime instead of merely remembering
  // that a one-shot launcher once succeeded.
  return `[Unit]
Description=botmux daemon (IM <-> AI coding CLI bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=${join(opts.configDir, 'pm2', 'pm2.pid')}
# ExecStop retires the Botmux fleet and then terminates the exact PM2 God.
# systemd must not terminate the God after a failed attested shutdown. ExecStop
# owns the exact SIGTERM; systemd's fallback signal is deliberately non-fatal.
# Persistent tmux/herdr/zellij sessions survive for the next daemon.
KillMode=process
KillSignal=SIGCONT
RestartKillSignal=SIGCONT
FinalKillSignal=SIGCONT
SendSIGKILL=no
TimeoutStopSec=45
TimeoutStartSec=180
WorkingDirectory=${opts.configDir}
Environment=PATH=${currentPath()}
Environment=${BOTMUX_SYSTEMD_SERVICE_ENV}=${SERVICE_NAME}
ExecStart=${nodeBin()} ${cliJs(opts)} start --systemd-service
ExecStop=${nodeBin()} ${cliJs(opts)} stop --systemd-service

[Install]
WantedBy=default.target
`;
}

export interface LinuxSystemdServiceState {
  loadState: string;
  activeState: string;
  subState: string;
  type: string;
  mainPid: number;
  killMode: string;
  killSignal: string;
  restartKillSignal: string;
  finalKillSignal: string;
  sendSigkill: string;
  timeoutStart: string;
  timeoutStop: string;
  workingDirectory: string;
  pidFile: string;
  environment: string;
  execStart: string;
  execStop: string;
  job: string;
}

export function parseLinuxSystemdShow(output: string): LinuxSystemdServiceState {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const parsedMainPid = Number.parseInt(values.get('MainPID') ?? '0', 10);
  return {
    loadState: values.get('LoadState') ?? '',
    activeState: values.get('ActiveState') ?? '',
    subState: values.get('SubState') ?? '',
    type: values.get('Type') ?? '',
    mainPid: Number.isSafeInteger(parsedMainPid) && parsedMainPid > 1 ? parsedMainPid : 0,
    killMode: values.get('KillMode') ?? '',
    killSignal: values.get('KillSignal') ?? '',
    restartKillSignal: values.get('RestartKillSignal') ?? '',
    finalKillSignal: values.get('FinalKillSignal') ?? '',
    sendSigkill: values.get('SendSIGKILL') ?? '',
    timeoutStart: values.get('TimeoutStartUSec') ?? '',
    timeoutStop: values.get('TimeoutStopUSec') ?? '',
    workingDirectory: values.get('WorkingDirectory') ?? '',
    pidFile: values.get('PIDFile') ?? '',
    environment: values.get('Environment') ?? '',
    execStart: values.get('ExecStart') ?? '',
    execStop: values.get('ExecStop') ?? '',
    job: values.get('Job') ?? '',
  };
}

export function assessLinuxSystemdService(input: {
  state: LinuxSystemdServiceState;
  expectedPidFile: string;
  expectedNodeBin: string;
  expectedCliJs: string;
  expectedWorkingDirectory: string;
  expectedPath: string;
  godPids: number[];
}): { errors: string[]; restartRequired: boolean } {
  const errors: string[] = [];
  const { state } = input;
  if (state.loadState !== 'loaded') errors.push(`LoadState=${state.loadState || '(empty)'}`);
  if (state.job) errors.push(`pending systemd Job=${state.job}`);
  if (new Set(['activating', 'deactivating', 'reloading']).has(state.activeState)) {
    errors.push(`ActiveState=${state.activeState}`);
  }
  if (state.type !== 'forking') errors.push(`Type=${state.type || '(empty)'}`);
  if (state.killMode !== 'process') errors.push(`KillMode=${state.killMode || '(empty)'}`);
  const sigcont = new Set(['18', 'SIGCONT']);
  if (!sigcont.has(state.killSignal)) errors.push(`KillSignal=${state.killSignal || '(empty)'}`);
  if (!sigcont.has(state.restartKillSignal)) {
    errors.push(`RestartKillSignal=${state.restartKillSignal || '(empty)'}`);
  }
  if (!sigcont.has(state.finalKillSignal)) {
    errors.push(`FinalKillSignal=${state.finalKillSignal || '(empty)'}`);
  }
  if (state.sendSigkill !== 'no') errors.push(`SendSIGKILL=${state.sendSigkill || '(empty)'}`);
  if (state.timeoutStart !== '3min') {
    errors.push(`TimeoutStartSec=${state.timeoutStart || '(empty)'}`);
  }
  if (state.timeoutStop !== '45s') {
    errors.push(`TimeoutStopSec=${state.timeoutStop || '(empty)'}`);
  }
  if (state.workingDirectory !== input.expectedWorkingDirectory) {
    errors.push(`WorkingDirectory=${state.workingDirectory || '(empty)'}`);
  }
  if (state.pidFile !== input.expectedPidFile) {
    errors.push(`PIDFile=${state.pidFile || '(empty)'}`);
  }
  const environmentAssignments = state.environment.match(/"[^"]*"|\S+/g)
    ?.map(value => value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)
    ?? [];
  if (!environmentAssignments.includes(`${BOTMUX_SYSTEMD_SERVICE_ENV}=${SERVICE_NAME}`)) {
    errors.push(`Environment 缺少 ${BOTMUX_SYSTEMD_SERVICE_ENV}=${SERVICE_NAME}`);
  }
  const effectivePaths = environmentAssignments.filter(value => value.startsWith('PATH='));
  if (JSON.stringify(effectivePaths) !== JSON.stringify([`PATH=${input.expectedPath}`])) {
    errors.push(`Environment PATH=${effectivePaths.join(',') || '(empty)'}`);
  }
  if (input.godPids.length > 1) {
    errors.push(`multiple PM2 God daemons: ${input.godPids.join(', ')}`);
  }
  const effectiveArgv = (value: string): string[] => [...value.matchAll(/argv\[\]=([^;]*?)\s*;/g)]
    .map(match => match[1]!.trim());
  const expectedStartArgv = `${input.expectedNodeBin} ${input.expectedCliJs} start --systemd-service`;
  if (JSON.stringify(effectiveArgv(state.execStart)) !== JSON.stringify([expectedStartArgv])) {
    errors.push(
      `systemd 有效 ExecStart 被 drop-in 覆盖: ${state.execStart || '(empty)'}`,
    );
  }
  const expectedStopArgv = `${input.expectedNodeBin} ${input.expectedCliJs} stop --systemd-service`;
  if (JSON.stringify(effectiveArgv(state.execStop)) !== JSON.stringify([expectedStopArgv])) {
    errors.push(`ExecStop=${state.execStop || '(empty)'}`);
  }
  const exactGod = input.godPids.length === 1 ? input.godPids[0] : 0;
  const restartRequired = state.activeState !== 'active'
    || state.subState !== 'running'
    || exactGod === 0
    || state.mainPid !== exactGod;
  return { errors, restartRequired };
}

function userSystemdAvailable(): boolean {
  // Check the user manager is reachable. In containers / sshd-without-DBus
  // sessions `systemctl --user` will fail with "Failed to connect to bus".
  const r = spawnSync('systemctl', ['--user', 'show-environment'], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
  return r.status === 0;
}

export function linuxUserSystemdAvailable(): boolean {
  return process.platform === 'linux' && userSystemdAvailable();
}

function assertLinuxServiceOwnershipAvailable(opts: AutostartOpts): void {
  const ownership = inspectLinuxPm2GodOwnership(join(opts.configDir, 'pm2'));
  if (ownership.kind !== 'external') return;
  throw new ExternalPm2GodOwnershipError(ownership);
}

function systemctlUser(args: string[], timeout = SYSTEMCTL_DEFAULT_TIMEOUT_MS): string {
  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    const detail = result.error?.message ?? (stderr || `status ${result.status}`);
    throw new Error(`systemctl --user ${args.join(' ')} 失败: ${detail}`);
  }
  return String(result.stdout ?? '');
}

function writeLinuxServiceUnit(opts: AutostartOpts): { path: string; changed: boolean } {
  const path = unitPath();
  let changed = false;
  const content = renderLinuxSystemdUnit(opts);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (previous !== content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    changed = true;
  }
  return { path, changed };
}

export function inspectLinuxSystemdService(): LinuxSystemdServiceState {
  return parseLinuxSystemdShow(systemctlUser([
    'show',
    SERVICE_NAME,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=Type',
    '--property=MainPID',
    '--property=KillMode',
    '--property=KillSignal',
    '--property=RestartKillSignal',
    '--property=FinalKillSignal',
    '--property=SendSIGKILL',
    '--property=TimeoutStartUSec',
    '--property=TimeoutStopUSec',
    '--property=WorkingDirectory',
    '--property=PIDFile',
    '--property=Environment',
    '--property=ExecStart',
    '--property=ExecStop',
    '--property=Job',
  ]));
}

function linuxServiceJobSettled(state: LinuxSystemdServiceState): boolean {
  return !state.job && !new Set(['activating', 'deactivating', 'reloading']).has(state.activeState);
}

function waitForLinuxServiceJobToSettle(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (linuxServiceJobSettled(inspectLinuxSystemdService())) return true;
    Atomics.wait(SYSTEMD_JOB_POLL_BUFFER, 0, 0, SYSTEMD_JOB_POLL_MS);
  } while (Date.now() < deadline);
  return false;
}

function cancelLinuxServiceJobsAndSettle(reason: string): string {
  let cancelFailure = '';
  try {
    const jobs = systemctlUser([
      'list-jobs',
      SERVICE_NAME,
      '--no-legend',
      '--plain',
      '--no-pager',
    ]);
    const jobIds = jobs.split(/\r?\n/)
      .map(line => line.trim().match(/^(\d+)\s/)?.[1])
      .filter((id): id is string => Boolean(id));
    for (const jobId of jobIds) systemctlUser(['cancel', jobId]);
  } catch (error) {
    cancelFailure = error instanceof Error ? error.message : String(error);
  }
  let settled = false;
  let settleFailure = '';
  try {
    settled = waitForLinuxServiceJobToSettle(SYSTEMD_CANCEL_SETTLE_WAIT_MS);
  } catch (error) {
    settleFailure = error instanceof Error ? error.message : String(error);
  }
  if (!settled) {
    throw new Error(
      `${reason}; 无法确认 systemd restart job 已终止`
      + `${cancelFailure ? `; cancel: ${cancelFailure}` : ''}`
      + `${settleFailure ? `; settle: ${settleFailure}` : ''}`,
    );
  }
  return `${reason}; 已取消并确认 systemd 不会延迟旋转 PM2 God`
    + `${cancelFailure ? ` (cancel 返回: ${cancelFailure})` : ''}`;
}

function cancelLinuxServiceJobAndThrow(reason: string): never {
  throw new Error(cancelLinuxServiceJobsAndSettle(reason));
}

function syncAndInspectLinuxService(opts: AutostartOpts): {
  changed: boolean;
  godProcesses: LinuxPm2GodProcess[];
  restartRequired: boolean;
} {
  if (!linuxUserSystemdAvailable()) {
    throw new Error('当前会话连不上 user systemd，无法校验或修复 botmux.service。');
  }
  const written = writeLinuxServiceUnit(opts);
  // Always reload when the unit exists. This deliberately retries a previous
  // failed reload even when the on-disk content is already up to date.
  systemctlUser(['daemon-reload']);

  const ownership = inspectLinuxPm2GodOwnership(join(opts.configDir, 'pm2'));
  if (ownership.kind === 'external') {
    throw new ExternalPm2GodOwnershipError(ownership);
  }
  const godProcesses = ownership.kind === 'owned' ? ownership.processes : [];
  const godPids = godProcesses.map(process => process.pid);
  const assessment = assessLinuxSystemdService({
    state: inspectLinuxSystemdService(),
    expectedPidFile: join(opts.configDir, 'pm2', 'pm2.pid'),
    expectedNodeBin: nodeBin(),
    expectedCliJs: cliJs(opts),
    expectedWorkingDirectory: opts.configDir,
    expectedPath: currentPath(),
    godPids,
  });
  if (assessment.errors.length > 0) {
    throw new Error(
      `${SERVICE_NAME} 有效配置校验失败: ${assessment.errors.join('; ')}。`
      + '请检查 ~/.config/systemd/user/botmux.service.d/ 下的覆盖配置。',
    );
  }
  return {
    changed: written.changed,
    godProcesses,
    restartRequired: assessment.restartRequired,
  };
}

function restartLinuxServiceAndVerify(opts: AutostartOpts): void {
  // The prepare snapshot may be minutes old after credential preflight and
  // plugin admission. Bind the comparison baseline again at the actual job
  // boundary, then prove its process generation one final time.
  let stateBefore = inspectLinuxSystemdService();
  if (!linuxServiceJobSettled(stateBefore)) {
    const detail = cancelLinuxServiceJobsAndSettle(
      `${SERVICE_NAME} restart 边界发现并发中的 systemd job`,
    );
    console.warn(`⚠️  ${detail}`);
    stateBefore = inspectLinuxSystemdService();
  }
  const before = inspectLinuxPm2GodOwnership(join(opts.configDir, 'pm2'));
  if (before.kind === 'external' || (before.kind === 'owned' && before.processes.length !== 1)) {
    throw new Error(
      `${SERVICE_NAME} restart 前 ownership 不唯一: `
      + (before.kind === 'external' ? describeExternalPm2Owner(before) : before.processes.map(p => p.pid).join(', ')),
    );
  }
  const restartBaseline = before.kind === 'owned' ? before.processes : [];
  const exactBefore = restartBaseline[0];
  if (exactBefore && !revalidateLinuxPm2GodProcess(exactBefore, join(opts.configDir, 'pm2'))) {
    throw new Error(`${SERVICE_NAME} restart 前 PM2 God generation 已变化，请重试`);
  }
  if (exactBefore && stateBefore.activeState !== 'active'
      && stateBefore.activeState !== 'failed'
      && stateBefore.activeState !== 'inactive') {
    throw new Error(
      `${SERVICE_NAME} restart 前状态无法安全分类: ActiveState=${stateBefore.activeState || '(empty)'}`,
    );
  }
  systemctlUser(['restart', '--no-block', SERVICE_NAME]);
  try {
    if (!waitForLinuxServiceJobToSettle(SYSTEMD_RESTART_JOB_WAIT_MS)) {
      cancelLinuxServiceJobAndThrow(`${SERVICE_NAME} restart job 排队或执行超时`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('已取消并确认') || message.includes('无法确认 systemd restart job')) throw error;
    cancelLinuxServiceJobAndThrow(`${SERVICE_NAME} restart job 状态读取失败: ${message}`);
  }

  // An older ExecStart selected by a systemd drop-in may itself rewrite the
  // main unit. Restore the current definition once more before readback.
  writeLinuxServiceUnit(opts);
  systemctlUser(['daemon-reload']);

  const ownership = inspectLinuxPm2GodOwnership(join(opts.configDir, 'pm2'));
  if (ownership.kind !== 'owned') {
    throw new Error(
      `${SERVICE_NAME} 启动后未得到 PM2 God Daemon ownership`
      + (ownership.kind === 'external' ? `: ${describeExternalPm2Owner(ownership)}` : '（PM2 God 不存在）'),
    );
  }
  const previous = restartBaseline.length === 1 ? restartBaseline[0] : undefined;
  const current = ownership.processes.length === 1 ? ownership.processes[0] : undefined;
  if (previous && current
      && current.pid === previous.pid
      && current.startIdentity === previous.startIdentity) {
    throw new Error(
      `${SERVICE_NAME} 重启后 PM2 God generation 未变化（pid ${previous.pid}）；`
      + 'ExecStop 可能未完成，拒绝把本次操作报告为成功。',
    );
  }
  const state = inspectLinuxSystemdService();
  const assessment = assessLinuxSystemdService({
    state,
    expectedPidFile: join(opts.configDir, 'pm2', 'pm2.pid'),
    expectedNodeBin: nodeBin(),
    expectedCliJs: cliJs(opts),
    expectedWorkingDirectory: opts.configDir,
    expectedPath: currentPath(),
    godPids: ownership.processes.map(process => process.pid),
  });
  if (assessment.errors.length > 0 || assessment.restartRequired) {
    const runtimeMismatch = assessment.restartRequired
      ? [`MainPID=${state.mainPid || 0}, God=${ownership.processes.map(process => process.pid).join(',')}, SubState=${state.subState}`]
      : [];
    throw new Error(
      `${SERVICE_NAME} 运行态迁移后校验失败: `
      + [...assessment.errors, ...runtimeMismatch].join('; '),
    );
  }
}

/**
 * Ensure the non-enabled service definition exists and start through systemd.
 * A missing God is created inside botmux.service; an owned God left behind by
 * a failed/inactive service is recovered through the same systemd boundary.
 */
export function handoffLinuxPm2Start(opts: AutostartOpts): void {
  assertLinuxServiceOwnershipAvailable(opts);
  syncAndInspectLinuxService(opts);
  restartLinuxServiceAndVerify(opts);
}

/** Write/reload/validate without stopping the current generation. */
export function prepareLinuxPm2ServiceRepair(opts: AutostartOpts): boolean {
  if (process.platform !== 'linux') return false;
  assertLinuxServiceOwnershipAvailable(opts);
  const synced = syncAndInspectLinuxService(opts);
  return synced.restartRequired;
}

/** Apply a previously validated repair and verify the exact new generation. */
export function applyLinuxPm2ServiceRepair(opts: AutostartOpts): void {
  restartLinuxServiceAndVerify(opts);
}

function lingerEnabled(): boolean {
  const username = userInfo().username;
  const r = spawnSync('loginctl', ['show-user', username, '--property=Linger'], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
  if (r.status !== 0) return false;
  return r.stdout.toString().trim().endsWith('=yes');
}

function enableLinux(opts: AutostartOpts): void {
  if (!userSystemdAvailable()) {
    console.error(`❌ 当前会话连不上 user systemd（缺少 DBus / 容器环境）。`);
    console.error(``);
    console.error(`   PM2 必须由独立的 botmux.service cgroup 创建，不能从 cron/rc.local 直接启动。`);
    console.error(`   请在有 systemd --user 的登录环境里再次运行 botmux autostart enable。`);
    process.exit(1);
  }

  assertLinuxServiceOwnershipAvailable(opts);
  const { path } = writeLinuxServiceUnit(opts);
  console.log(`✅ 已写入 systemd unit: ${path}`);
  const synced = syncAndInspectLinuxService(opts);
  if (synced.restartRequired && synced.godProcesses.length > 0) {
    throw new Error(
      `${SERVICE_NAME} 文件已修复，但当前 God 尚未成为 MainPID；`
      + '请运行 `botmux restart` 完成运行态迁移后再启用 autostart。',
    );
  }

  // No `--now` here on purpose: enable should only register the autostart hook,
  // not interfere with whatever daemon state the user already has. Daemon
  // lifecycle stays under `botmux start`/`stop`. The unit will trigger on next
  // boot via WantedBy=default.target.
  const en = spawnSync('systemctl', ['--user', 'enable', SERVICE_NAME], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
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
  const dis = spawnSync('systemctl', ['--user', 'disable', SERVICE_NAME], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
  if (dis.status === 0) console.log(`✅ 已禁用 ${SERVICE_NAME}`);
  else console.warn(`⚠️  disable 返回非零（可能本来就未启用）`);

  let removed = false;
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`✅ 已删除 ${path}`);
    removed = true;
  }
  if (removed) {
    systemctlUser(['daemon-reload']);
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
  const isEnabled = spawnSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
  const isActive = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_DEFAULT_TIMEOUT_MS,
  });
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

function windowsScriptContent(opts: AutostartOpts): string {
  const path = escapeCmdValue(currentPath());
  const cwd = opts.configDir;
  const outLog = windowsLogPath(opts, 'autostart-out.log');
  const errLog = windowsLogPath(opts, 'autostart-err.log');
  return `@echo off
setlocal
set "PATH=${path}"
cd /d "${cwd}"
"${nodeBin()}" "${cliJs(opts)}" start >> "${outLog}" 2>> "${errLog}"
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
      return syncAndInspectLinuxService(opts).changed;
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
