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
import { execFileSync, spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { detectPlatform, type PackageManager, type PlatformInfo } from './detect-platform.js';
import { isBotmuxManagedTmuxEnvKey } from '../utils/child-env.js';

export interface TmuxResult {
  installed: boolean;
  version?: string;
  /** True iff we ran an installer (vs. tmux was already present). */
  freshInstall: boolean;
  /**
   * False only when the version probe authoritatively returns ENOENT. True also
   * covers timeout/EMFILE/EACCES, where presence cannot be disproved and startup
   * must not hard-fail with a misleading PATH diagnosis. Lets the start-gate
   * distinguish "tmux genuinely absent" from "probe got no answer" (see
   * shouldHardFailStartupForMissingTmux). Set on every return.
   */
  binaryPresent?: boolean;
  /** Which strategy actually ran the install. */
  strategy?: PackageManager;
  /** When installed=false: human-readable reason for the caller's warning. */
  reason?: string;
  /** When installed=false: the manual command we'd have run, for the warning. */
  manualCommand?: string;
}

type TmuxVersionProbe =
  | { ok: true; version: string }
  | { ok: false; reason: string; binaryPresent: boolean; retryable: boolean };

export type TmuxFunctionalProbe =
  | { ok: true; version: string }
  | { ok: false; reason: string; binaryPresent: boolean; retryable: boolean; version?: string };

function childFailureReason(command: string, failure: any, timeoutMs: number): string {
  const nested = failure?.error;
  const code = failure?.code ?? nested?.code;
  const signal = failure?.signal ?? nested?.signal;
  const stderr = (failure?.stderr?.toString?.() ?? nested?.stderr?.toString?.() ?? '').trim();

  if (code === 'ENOENT') return `${command} 启动失败：找不到 tmux 可执行文件（ENOENT）`;
  if (code === 'EACCES') return `${command} 启动失败：tmux 不可执行（EACCES）`;
  if (code === 'EMFILE' || code === 'ENFILE') return `${command} 启动失败：文件描述符耗尽（${code}）`;
  if (code === 'ETIMEDOUT' || signal || failure?.killed || nested?.killed) {
    const detail = signal ? `，signal=${signal}` : '';
    return `${command} 探测超时（${timeoutMs}ms${detail}）`;
  }
  if (stderr) return `${command} 失败：${stderr}`;
  if (typeof failure?.status === 'number') return `${command} 失败（exit ${failure.status}）`;
  const message = nested?.message ?? failure?.message;
  return `${command} 启动/探测失败${message ? `：${message}` : ''}`;
}

function probeTmuxVersion(): TmuxVersionProbe {
  try {
    const out = execFileSync('tmux', ['-V'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env: tmuxEnv(),
    });
    return { ok: true, version: out.trim() };
  } catch (err: any) {
    const code = err?.code;
    return {
      ok: false,
      reason: childFailureReason('tmux -V', err, 3000),
      // Only ENOENT proves absence. Timeout/EMFILE/EACCES must not be turned
      // into the old, misleading "not on PATH" diagnosis or a startup hard
      // gate; they prove only that this particular probe got no answer.
      binaryPresent: code !== 'ENOENT',
      retryable: code !== 'ENOENT' && code !== 'EACCES',
    };
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
 *
 * tmuxEnv ALSO strips botmux's own session/bot-scoped vars
 * (isBotmuxManagedTmuxEnvKey): when botmux's first `tmux new-session` boots the
 * server, tmux copies this client env into the server's *global* environment,
 * which then leaks into every co-tenant session on the socket — including the
 * user's own interactive tmux, whose Claude Code would then misroute its
 * AskUserQuestion hook to whatever BOTMUX_SESSION_ID/CHAT_ID it inherited. The
 * pane gets the correct per-session values from the env(1) wrapper injection
 * instead, so this strip is invisible to botmux's own sessions. See
 * TMUX_CLIENT_STRIP_KEYS in utils/child-env.ts.
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
  const rest: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    // TMUX/TMUX_PANE would re-target a dead parent server; botmux-managed keys
    // would seed the server's shared global env and leak to co-tenant sessions.
    if (key === 'TMUX' || key === 'TMUX_PANE') continue;
    if (isBotmuxManagedTmuxEnvKey(key)) continue;
    rest[key] = value;
  }
  return {
    ...rest,
    PATH: withTmuxSearchPath(rest.PATH),
  };
}

export interface TmuxGlobalEnvScrubResult {
  /** False means no tmux server answered (or tmux was temporarily unavailable). */
  serverFound: boolean;
  removed: string[];
  failed: string[];
}

/**
 * Remove botmux-managed values from an already-running tmux server's global
 * environment. This repairs servers started by pre-isolation botmux builds,
 * including a user-owned server that survives while no bmx-* session exists.
 * Running panes keep their process environments; only future panes inherit the
 * cleaned table.
 *
 * socketName exists for isolated tests. Production intentionally targets the
 * default server after tmuxEnv() strips a possibly-stale parent $TMUX pointer.
 */
export function scrubTmuxServerGlobalEnv(socketName?: string): TmuxGlobalEnvScrubResult {
  const socketArgs = socketName ? ['-L', socketName] : [];
  let output: string;
  try {
    output = execFileSync('tmux', [...socketArgs, 'show-environment', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: tmuxEnv(),
    });
  } catch {
    return { serverFound: false, removed: [], failed: [] };
  }
  if (typeof output !== 'string') {
    return { serverFound: false, removed: [], failed: [] };
  }

  const names = output.split('\n')
    // `show-environment -g` prints `NAME=value`, or `-NAME` for an explicitly
    // removed entry. Take the name in both shapes.
    .map(line => (line.startsWith('-') ? line.slice(1) : line.split('=', 1)[0]).trim())
    .filter(name => name.length > 0 && isBotmuxManagedTmuxEnvKey(name));

  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of new Set(names)) {
    try {
      execFileSync('tmux', [...socketArgs, 'set-environment', '-g', '-u', name], {
        stdio: 'ignore',
        timeout: 2000,
        env: tmuxEnv(),
      });
      removed.push(name);
    } catch {
      // Keep the exact failed key observable to callers without exposing its
      // (potentially sensitive) old value in logs.
      failed.push(name);
    }
  }
  return { serverFound: true, removed, failed };
}

function cleanupTmuxProbeSocket(sockName: string, env: NodeJS.ProcessEnv = process.env): void {
  if (typeof process.getuid !== 'function') return;

  const baseDir = env.TMUX_TMPDIR || '/tmp';
  const socketPath = join(baseDir, `tmux-${process.getuid()}`, sockName);
  try {
    unlinkSync(socketPath);
  } catch {
    // Best-effort: some tmux builds unlink the socket themselves.
  }
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
export function probeTmuxFunctional(): TmuxFunctionalProbe {
  const versionProbe = probeTmuxVersion();
  if (!versionProbe.ok) return versionProbe;
  const version = versionProbe.version;
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
    spawnSync('tmux', ['-L', sockName, 'kill-server'], { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
    cleanupTmuxProbeSocket(sockName);
    return {
      ok: false,
      reason: childFailureReason('tmux new-session', run, 5000),
      binaryPresent: true,
      retryable: (run.error as NodeJS.ErrnoException | undefined)?.code !== 'EACCES',
      version,
    };
  }
  // Tear down the probe server and remove the socket file. Some platforms leave
  // bmx-probe-* sockets behind after the server exits; thousands of stale
  // entries make later probe storms slower and easier to time out.
  spawnSync('tmux', ['-L', sockName, 'kill-server'], { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
  cleanupTmuxProbeSocket(sockName);
  return { ok: true, version };
}

/**
 * Worker-side gate probe with a short exponential backoff. A daemon restart can
 * wake many worker processes at once; if the host is briefly under fd/process
 * pressure, one failed spawn must not immediately become a user-facing hard
 * gate. The retries stay local to the worker and callers should still stagger
 * their restart path so all workers do not retry in lockstep.
 */
export function probeTmuxFunctionalWithRetry(opts: { attempts?: number; baseDelayMs?: number } = {}): TmuxFunctionalProbe {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(opts.baseDelayMs ?? 150));
  let result = probeTmuxFunctional();
  let completed = 1;

  while (!result.ok && result.retryable && completed < attempts) {
    const backoff = baseDelayMs * (2 ** (completed - 1));
    const jitter = baseDelayMs > 0 ? Math.floor(Math.random() * baseDelayMs) : 0;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff + jitter);
    } catch { /* SharedArrayBuffer unavailable: retry immediately */ }
    result = probeTmuxFunctional();
    completed += 1;
  }

  if (!result.ok && completed > 1) {
    return { ...result, reason: `${result.reason}（已退避重试 ${completed - 1} 次）` };
  }
  return result;
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
export function buildInstallArgv(pm: PackageManager, pkg: string, info: PlatformInfo): string[] | undefined {
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
export function aptUpdateBeforeInstall(info: PlatformInfo): void {
  const argv = sudoPrefix(['apt-get', 'update'], info);
  if (!argv) return;
  try {
    spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', timeout: 120_000 });
  } catch { /* best-effort */ }
}

/** Suggest the manual command we'd have run, for the failure message. */
export function suggestManualCommand(pm: PackageManager, pkg: string): string {
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

export function runInstall(argv: string[]): boolean {
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
    return { installed: true, version: initialProbe.version, freshInstall: false, binaryPresent: true };
  }

  // Only an authoritative ENOENT should enter the installer path. A timeout,
  // EMFILE or permission failure is not evidence that PATH is missing; surface
  // the real probe reason and let the per-session gate retry later.
  if (initialProbe.binaryPresent) {
    return {
      installed: false,
      freshInstall: false,
      binaryPresent: true,
      version: initialProbe.version,
      reason: initialProbe.version
        ? `${initialProbe.version} 已安装但启动 server 失败：${initialProbe.reason}`
        : initialProbe.reason,
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
        return { installed: true, version: postInstall.version, freshInstall: true, strategy: pm, binaryPresent: true };
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
  const finalVersionProbe = probeTmuxVersion();
  return {
    installed: false,
    freshInstall: false,
    // An install attempt may have landed the binary even though the server
    // probe still fails — re-check PATH so the start-gate doesn't treat a
    // present-but-broken tmux as "genuinely absent".
    binaryPresent: finalVersionProbe.ok || finalVersionProbe.binaryPresent,
    reason: reasonLines.join('\n'),
    manualCommand: manual,
  };
}
