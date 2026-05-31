/**
 * Ensure tmux is installed before the daemon starts. Strategy (first one
 * that fits wins):
 *
 *   1. Already installed AND functional → done.
 *   2. brew available → `brew install tmux` (no sudo)
 *   3. conda/mamba available → `conda install -y -c conda-forge tmux` (no sudo)
 *   4. Linux + system pkg manager:
 *        a. NOPASSWD sudo or running as root → run non-interactively
 *        b. Has TTY → run interactively (sudo will prompt for password)
 *        c. No TTY (autostart / pm2 fork) → skip with manual command
 *   5. Otherwise → return failure with manual command.
 *
 * Tmux is a NICE-TO-HAVE (enables /adopt + multi-pane Web terminal), not
 * load-bearing: PTY backend works without it. So this function never throws —
 * the caller inspects `installed` and routes accordingly. Earlier versions
 * threw on failure; that broke users whose tmux binary was present but
 * couldn't actually start a server (corrupt install / restricted /tmp /
 * broken ~/.tmux.conf — see daemon-error logs full of "error connecting to
 * /tmp/tmux-UID/default"), because `tmux -V` would pass but every subsequent
 * tmux command would fail. Functional probe + soft fallback fixes both.
 */
import { execSync, spawnSync } from 'node:child_process';
import { detectPlatform, type PackageManager, type PlatformInfo } from './detect-platform.js';

export interface TmuxResult {
  installed: boolean;
  version?: string;
  /** True iff we ran an installer (vs. tmux was already present). */
  freshInstall: boolean;
  /** Which strategy actually ran the install. */
  strategy?: PackageManager;
  /** When installed=false: human-readable reason for the caller's warning. */
  reason?: string;
  /** When installed=false: the manual command we'd have run, for the warning. */
  manualCommand?: string;
}

function probeTmuxVersion(): string | undefined {
  try {
    const out = execSync('tmux -V', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: tmuxEnv(),
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

/**
 * Strip tmux-injected env vars when spawning a tmux child process.
 *
 * If the parent (daemon / worker / cli wrapper) was launched from inside a
 * tmux session, tmux exports `TMUX=<socket-path>,<pid>,<session-id>` and
 * `TMUX_PANE=...` to the environment. Any `tmux` subcommand we run without
 * explicit `-L <socket>` then targets *that* parent server — when the user's
 * terminal tmux is gone (logged out, server killed, /tmp wiped) every
 * subsequent call fails with `error connecting to <stale-socket>`.
 *
 * This affects botmux even when the user's *new* `tmux -V` works fine on the
 * shell, because that test starts from a fresh shell with no stale `TMUX`.
 * The daemon, autostarted via pm2/systemd at login, inherited the original
 * shell's tmux env — `/tmp/tmux-1001/default` in the wild we see — and keeps
 * hammering at it forever.
 *
 * Caller pattern: every execSync / execFileSync / spawnSync / pty.spawn that
 * invokes the `tmux` binary must pass `env: tmuxEnv()` (or `tmuxEnv(opts.env)`
 * when forwarding caller-provided env). TMUX_TMPDIR is intentionally left
 * alone — it just changes the socket directory and is the user's deliberate
 * override if set.
 */
const TMUX_PATH_EXTRAS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function withTmuxSearchPath(pathValue: string | undefined): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...(pathValue?.split(':') ?? []), ...TMUX_PATH_EXTRAS]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    merged.push(part);
  }
  return merged.join(':');
}

export function tmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env;
  return {
    ...rest,
    PATH: withTmuxSearchPath(rest.PATH),
  };
}

/**
 * Functional tmux probe — actually starts a tmux server and tears it down.
 *
 * `tmux -V` only checks the binary, not whether tmux can create a socket and
 * fork a session. Real-world failures we've seen: (1) /tmp owned by another
 * user, (2) broken ~/.tmux.conf, (3) the binary is a libc-mismatched dynamic
 * link, (4) tmux 1.x on minimal images missing libevent. All of those make
 * `tmux -V` succeed but every `new-session` / `attach-session` fail, which
 * floods daemon-error.log and leaves the worker with no working backend.
 *
 * Uses a unique `-L <socket-name>` so the probe never clobbers an existing
 * user tmux server. Stderr is captured (not inherited) so the failure
 * reason can surface in the bootstrap warning without spilling onto the
 * user's terminal.
 */
export function probeTmuxFunctional(): { ok: true; version: string } | { ok: false; reason: string } {
  const version = probeTmuxVersion();
  if (!version) return { ok: false, reason: 'tmux 二进制不在 PATH 上' };
  const sockName = `bmx-probe-${process.pid}-${Date.now()}`;
  // env: tmuxEnv() — without this, if the daemon inherited TMUX from a tmux
  // session that has since died, this probe would target the dead server
  // (despite the `-L` flag tmux still walks $TMUX in some 2.x paths during
  // startup) and report "ok: false" even on a perfectly healthy install.
  const run = spawnSync('tmux', ['-L', sockName, 'new-session', '-d', '-s', 'probe', 'true'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5000,
    env: tmuxEnv(),
  });
  if (run.status !== 0) {
    const stderr = (run.stderr?.toString() ?? '').trim();
    return { ok: false, reason: stderr || `tmux new-session 失败 (exit ${run.status})` };
  }
  // Tear down the probe server. Best-effort — if this leaks, the kernel
  // will GC the abstract socket when the (now-empty) tmux server exits on
  // its own once the only client (which we didn't attach) goes away.
  spawnSync('tmux', ['-L', sockName, 'kill-server'], { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
  return { ok: true, version };
}

/** Wrap a system command with the appropriate sudo prefix for the current
 *  platform context, or return undefined if we cannot escalate (no
 *  passwordless sudo and no TTY to prompt on). */
function sudoPrefix(cmd: string[], info: PlatformInfo): string[] | undefined {
  if (info.isRoot) return cmd;
  if (info.passwordlessSudo) return ['sudo', '-n', ...cmd];
  if (info.hasTty) return ['sudo', ...cmd];
  return undefined;
}

/** Build the install argv for a given package manager. Pure: returns argv[]
 *  ready for spawnSync, no side effects. Returns undefined if escalation
 *  isn't possible. */
function buildInstallArgv(pm: PackageManager, pkg: string, info: PlatformInfo): string[] | undefined {
  switch (pm) {
    case 'brew':    return ['brew', 'install', pkg];
    case 'conda':   return ['conda', 'install', '-y', '-c', 'conda-forge', pkg];
    case 'apt':     return sudoPrefix(['apt-get', 'install', '-y', pkg], info);
    case 'dnf':     return sudoPrefix(['dnf', 'install', '-y', pkg], info);
    case 'yum':     return sudoPrefix(['yum', 'install', '-y', pkg], info);
    case 'pacman':  return sudoPrefix(['pacman', '-S', '--noconfirm', pkg], info);
    case 'apk':     return sudoPrefix(['apk', 'add', pkg], info);
    case 'zypper':  return sudoPrefix(['zypper', 'install', '-y', pkg], info);
    case 'unknown': return undefined;
  }
}

/** apt-get specifically needs an updated package list on minimal images
 *  before the install will find tmux. This is NOT part of buildInstallArgv
 *  (which is pure) — it runs once just before the apt install attempt.
 *  Failure here is non-fatal; the actual install will fail loudly if it
 *  can't find the package. */
function aptUpdateBeforeInstall(info: PlatformInfo): void {
  const argv = sudoPrefix(['apt-get', 'update'], info);
  if (!argv) return;
  try {
    spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', timeout: 120_000 });
  } catch { /* best-effort */ }
}

/** Suggest the manual command we'd have run, for the failure message. */
function suggestManualCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case 'brew': return `brew install ${pkg}`;
    case 'conda': return `conda install -y -c conda-forge ${pkg}`;
    case 'apt': return `sudo apt-get update && sudo apt-get install -y ${pkg}`;
    case 'dnf': return `sudo dnf install -y ${pkg}`;
    case 'yum': return `sudo yum install -y ${pkg}`;
    case 'pacman': return `sudo pacman -S --noconfirm ${pkg}`;
    case 'apk': return `sudo apk add ${pkg}`;
    case 'zypper': return `sudo zypper install -y ${pkg}`;
    default: return `(请手动安装 ${pkg})`;
  }
}

function runInstall(argv: string[]): boolean {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    stdio: 'inherit',
    timeout: 10 * 60_000, // 10 min — apt-get on slow networks
  });
  return result.status === 0;
}

export async function ensureTmux(info?: PlatformInfo): Promise<TmuxResult> {
  const platform = info ?? detectPlatform();

  // Step 1: already installed AND functional?
  // `tmux -V` alone is not enough — see probeTmuxFunctional jsdoc for the
  // failure modes (broken /tmp perms / bad ~/.tmux.conf / mismatched libs)
  // that pass -V but fail every actual tmux command.
  const initialProbe = probeTmuxFunctional();
  if (initialProbe.ok) {
    return { installed: true, version: initialProbe.version, freshInstall: false };
  }

  // If the binary exists but the server can't start, no amount of
  // `apt-get install tmux` will help — surface the underlying reason and
  // let the caller fall back to PTY backend.
  const versionPresent = probeTmuxVersion();
  if (versionPresent) {
    return {
      installed: false,
      freshInstall: false,
      reason: `${versionPresent} 已安装但启动 server 失败：${initialProbe.reason}`,
      manualCommand: '排查 ~/.tmux.conf / /tmp 权限 / libevent 依赖后再试',
    };
  }

  console.log('⚠️  tmux 未检测到，正在安装...');

  // Step 2..4: walk the package-manager preference list.
  const tried: string[] = [];
  for (const pm of platform.packageManagers) {
    if (pm === 'unknown') continue;
    const argv = buildInstallArgv(pm, 'tmux', platform);
    if (!argv) {
      tried.push(`${pm}（跳过：当前用户无 sudo 且无 TTY）`);
      continue;
    }
    if (pm === 'apt') aptUpdateBeforeInstall(platform);
    console.log(`   尝试 ${pm}: ${argv.join(' ')}`);
    if (runInstall(argv)) {
      const postInstall = probeTmuxFunctional();
      if (postInstall.ok) {
        console.log(`✅ tmux ${postInstall.version} 安装完成 (via ${pm})`);
        return { installed: true, version: postInstall.version, freshInstall: true, strategy: pm };
      }
      tried.push(`${pm}（装上了但 server 起不来：${postInstall.reason}）`);
    } else {
      tried.push(`${pm}（命令返回非零）`);
    }
  }

  // Build a useful failure message with the most relevant manual command.
  const preferred = platform.packageManagers.find(p => p !== 'unknown') ?? 'unknown';
  const manual = suggestManualCommand(preferred, 'tmux');
  const reasonLines = [
    '自动安装 tmux 失败',
    '已尝试：',
    ...tried.map(t => `  - ${t}`),
  ];
  if (platform.os === 'darwin' && !platform.packageManagers.includes('brew')) {
    reasonLines.push('macOS 推荐先安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
  }
  if (!platform.hasTty && !platform.isRoot && !platform.passwordlessSudo && platform.os === 'linux') {
    reasonLines.push('提示：当前不是交互式 TTY 且 sudo 需要密码，systemd/pm2 自启下无法弹密码 — 先在 shell 跑一次 `botmux start`，或配置 NOPASSWD sudoers。');
  }
  return {
    installed: false,
    freshInstall: false,
    reason: reasonLines.join('\n'),
    manualCommand: manual,
  };
}
