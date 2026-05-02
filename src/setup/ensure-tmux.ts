/**
 * Ensure tmux is installed before the daemon starts. Strategy (first one
 * that fits wins):
 *
 *   1. Already installed → done.
 *   2. brew available → `brew install tmux` (no sudo)
 *   3. conda/mamba available → `conda install -y -c conda-forge tmux` (no sudo)
 *   4. Linux + system pkg manager:
 *        a. NOPASSWD sudo or running as root → run non-interactively
 *        b. Has TTY → run interactively (sudo will prompt for password)
 *        c. No TTY (autostart / pm2 fork) → skip and throw with manual command
 *   5. Otherwise → throw with manual command.
 *
 * The caller (cli.ts) treats a thrown error as fatal: tmux is non-negotiable
 * for the /adopt + multi-pane Web terminal experience, and the user explicitly
 * opted into hard-fail-on-missing.
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
}

function probeTmuxVersion(): string | undefined {
  try {
    const out = execSync('tmux -V', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.trim();
  } catch {
    return undefined;
  }
}

/** Build the install argv for a given package manager. Returns argv[] suitable
 *  for spawnSync; the first element decides whether we wrap with sudo. */
function buildInstallArgv(pm: PackageManager, pkg: string, info: PlatformInfo): string[] | undefined {
  const sudoPrefix = (cmd: string[]): string[] => {
    if (info.isRoot) return cmd;
    if (info.passwordlessSudo) return ['sudo', '-n', ...cmd];
    if (info.hasTty) return ['sudo', ...cmd];
    return []; // can't escalate non-interactively
  };

  switch (pm) {
    case 'brew':
      return ['brew', 'install', pkg];
    case 'conda':
      return ['conda', 'install', '-y', '-c', 'conda-forge', pkg];
    case 'apt': {
      // apt-get update first ensures the package list isn't stale on minimal
      // images; we only run it once per ensure call. Failure is non-fatal —
      // the install will fail loudly if a needed package is missing.
      const update = sudoPrefix(['apt-get', 'update']);
      if (update.length === 0) return undefined;
      try { spawnSync(update[0]!, update.slice(1), { stdio: 'inherit', timeout: 120_000 }); } catch { /* best-effort */ }
      return sudoPrefix(['apt-get', 'install', '-y', pkg]).length === 0
        ? undefined
        : sudoPrefix(['apt-get', 'install', '-y', pkg]);
    }
    case 'dnf':
      return sudoPrefix(['dnf', 'install', '-y', pkg]).length === 0 ? undefined : sudoPrefix(['dnf', 'install', '-y', pkg]);
    case 'yum':
      return sudoPrefix(['yum', 'install', '-y', pkg]).length === 0 ? undefined : sudoPrefix(['yum', 'install', '-y', pkg]);
    case 'pacman':
      return sudoPrefix(['pacman', '-S', '--noconfirm', pkg]).length === 0 ? undefined : sudoPrefix(['pacman', '-S', '--noconfirm', pkg]);
    case 'apk':
      return sudoPrefix(['apk', 'add', pkg]).length === 0 ? undefined : sudoPrefix(['apk', 'add', pkg]);
    case 'zypper':
      return sudoPrefix(['zypper', 'install', '-y', pkg]).length === 0 ? undefined : sudoPrefix(['zypper', 'install', '-y', pkg]);
    case 'unknown':
      return undefined;
  }
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

  // Step 1: already installed?
  const existing = probeTmuxVersion();
  if (existing) {
    return { installed: true, version: existing, freshInstall: false };
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
    console.log(`   尝试 ${pm}: ${argv.join(' ')}`);
    if (runInstall(argv)) {
      const v = probeTmuxVersion();
      if (v) {
        console.log(`✅ tmux ${v} 安装完成 (via ${pm})`);
        return { installed: true, version: v, freshInstall: true, strategy: pm };
      }
      tried.push(`${pm}（命令成功但 tmux -V 仍失败）`);
    } else {
      tried.push(`${pm}（命令返回非零）`);
    }
  }

  // Build a useful failure message with the most relevant manual command.
  const preferred = platform.packageManagers.find(p => p !== 'unknown') ?? 'unknown';
  const manual = suggestManualCommand(preferred, 'tmux');
  const lines = [
    '❌ 自动安装 tmux 失败',
    '',
    '已尝试：',
    ...tried.map(t => `  - ${t}`),
    '',
    '请手动安装后重试：',
    `  ${manual}`,
  ];
  if (!platform.hasTty && !platform.isRoot && !platform.passwordlessSudo && platform.os === 'linux') {
    lines.push('');
    lines.push('提示：当前不是交互式 TTY 且 sudo 需要密码，systemd/pm2 自启场景下无法弹密码。');
    lines.push('请在 shell 中手动跑一次 `botmux start`，或配置 NOPASSWD sudoers 后再启用 autostart。');
  }
  throw new Error(lines.join('\n'));
}
