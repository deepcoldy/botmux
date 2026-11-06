/**
 * What this machine can give a scratch sandbox, and why a scratch session did
 * not start.
 *
 * Two halves:
 *  - `probeScratchCapability`: a READ-ONLY look at the host (uid, PATH, sysctls,
 *    /proc/filesystems, whether /dev/fuse opens). It mounts nothing, starts no
 *    bwrap and installs nothing, so the dashboard can call it on every bot
 *    payload. Its verdict is advice: the dashboard shows it next to the scratch
 *    choice and still lets the operator save (the first session is the real
 *    test; a sysctl we cannot read is "unknown", not "broken").
 *  - `scratchFailureNotice`: the chat text for a prepare that returned a
 *    failure reason (see `prepareScratchSandboxDetailed`), with the fix that
 *    matches that reason. Only a tmpfs upper lost in a reboot is told to start a
 *    new session — every other reason has a fix on the host or in the config,
 *    and a new session would fail the same way.
 */
import { closeSync, constants as fsConstants, openSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ScratchStorageKind = 'tmpfs' | 'disk';

/** Why a storage cannot (or may not) be used on this machine. */
export type ScratchCapabilityProblem =
  | 'unsupported-platform'
  | 'sandbox-exec-missing'
  | 'bwrap-missing'
  | 'userns-blocked'
  | 'tmpfs-needs-root'
  | 'kernel-overlay-missing'
  | 'fuse-overlayfs-missing'
  | 'fusermount-missing'
  | 'no-new-privs'
  | 'dev-fuse-missing'
  | 'dev-fuse-denied';

export interface ScratchStorageVerdict {
  /** 'unknown' = no blocking problem found, but a check could not be decided. */
  usable: 'yes' | 'no' | 'unknown';
  problems: ScratchCapabilityProblem[];
}

export interface ScratchCapability {
  platform: string;
  /** 'all' = every storage usable; 'disk-only' = tmpfs is not; 'none' = scratch
   *  cannot start here; 'unknown' = nothing blocking found, something undecided. */
  summary: 'all' | 'disk-only' | 'none' | 'unknown';
  /** Linux only (macOS scratch has no storage choice). */
  storages?: Record<ScratchStorageKind, ScratchStorageVerdict>;
  /** macOS: the single verdict. */
  problems?: ScratchCapabilityProblem[];
  /** Checks that could not be decided (shown as a caveat, never blocking). */
  undecided: string[];
  /** Non-root: other mounted disks (e.g. /data00) are read-only inside, so the
   *  working dir must sit on the root filesystem. */
  submountsReadOnly: boolean;
  /** Missing bwrap / fuse-overlayfs is installed by the first session when the
   *  daemon runs as root and a package manager is present. */
  autoInstall: boolean;
  /** Install hint for the missing packages (empty when nothing is missing). */
  installHint?: string;
}

/** Raw facts. Gathered by `gatherScratchFacts`; tests hand-build them. */
export interface ScratchFacts {
  platform: string;
  uid: number | undefined;
  /** BOTMUX_SANDBOX_FUSE=1: root also goes through fuse-overlayfs. */
  forceFuse: boolean;
  has: {
    bwrap: boolean;
    fuseOverlayfs: boolean;
    fusermount: boolean;
    sandboxExec: boolean;
    packageManager: string | null;
  };
  bwrapSetuid: boolean;
  /** NoNewPrivs=1 (e.g. systemd NoNewPrivileges=yes): setuid helpers —
   *  fusermount3, a setuid bwrap — run without their privilege. */
  noNewPrivs: boolean;
  devFuse: 'ok' | 'missing' | 'denied';
  /** undefined = /proc/filesystems unreadable. */
  kernelOverlay: boolean | undefined;
  /** User-namespace creation for THIS uid. */
  userns: { state: 'ok' | 'blocked' | 'unknown'; detail?: string };
}

export interface ScratchProbeIo {
  platform: string;
  uid: number | undefined;
  env: NodeJS.ProcessEnv;
  readText(path: string): string | undefined;
  /** st_mode of the path (following symlinks), undefined when absent. */
  statMode(path: string): number | undefined;
  /** Open read+write and close at once. */
  openReadWrite(path: string): 'ok' | 'missing' | 'denied';
}

const defaultIo = (): ScratchProbeIo => ({
  platform: process.platform,
  uid: process.getuid?.(),
  env: process.env,
  readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
  statMode: (p) => { try { return statSync(p).mode; } catch { return undefined; } },
  openReadWrite: (p) => {
    try { closeSync(openSync(p, fsConstants.O_RDWR)); return 'ok'; } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'denied';
    }
  },
});

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

function findOnPath(io: ScratchProbeIo, cmd: string): string | undefined {
  for (const dir of (io.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    const mode = io.statMode(p);
    if (mode !== undefined && (mode & S_IFMT) === S_IFREG && (mode & 0o111) !== 0) return p;
  }
  return undefined;
}

function sysctlInt(io: ScratchProbeIo, path: string): number | undefined {
  const raw = io.readText(path)?.trim();
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** Whether this uid may create a user namespace (bwrap --unshare-user). */
function usernsState(io: ScratchProbeIo): ScratchFacts['userns'] {
  const max = sysctlInt(io, '/proc/sys/user/max_user_namespaces');
  if (max === 0) return { state: 'blocked', detail: 'user.max_user_namespaces=0' };
  if (io.uid === 0) return max === undefined ? { state: 'unknown', detail: 'user.max_user_namespaces unreadable' } : { state: 'ok' };
  // Debian/older Ubuntu kernels gate unprivileged user namespaces separately.
  if (sysctlInt(io, '/proc/sys/kernel/unprivileged_userns_clone') === 0) {
    return { state: 'blocked', detail: 'kernel.unprivileged_userns_clone=0' };
  }
  // Ubuntu 23.10+: AppArmor confines unprivileged user namespaces unless the
  // program has a profile allowing them (distro bwrap usually ships one), so
  // it cannot be decided without trying.
  if (sysctlInt(io, '/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === 1) {
    return { state: 'unknown', detail: 'kernel.apparmor_restrict_unprivileged_userns=1' };
  }
  return max === undefined ? { state: 'unknown', detail: 'user.max_user_namespaces unreadable' } : { state: 'ok' };
}

export function gatherScratchFacts(io: ScratchProbeIo = defaultIo()): ScratchFacts {
  const bwrapPath = findOnPath(io, 'bwrap');
  const bwrapMode = bwrapPath ? io.statMode(bwrapPath) : undefined;
  const filesystems = io.readText('/proc/filesystems');
  const pm = ['apt-get', 'dnf', 'yum', 'apk', 'pacman'].find(c => findOnPath(io, c)) ?? null;
  return {
    platform: io.platform,
    uid: io.uid,
    forceFuse: io.env.BOTMUX_SANDBOX_FUSE === '1',
    has: {
      bwrap: !!bwrapPath,
      fuseOverlayfs: !!findOnPath(io, 'fuse-overlayfs'),
      fusermount: !!(findOnPath(io, 'fusermount3') || findOnPath(io, 'fusermount')),
      sandboxExec: !!(findOnPath(io, 'sandbox-exec') || io.statMode('/usr/bin/sandbox-exec') !== undefined),
      packageManager: pm,
    },
    bwrapSetuid: bwrapMode !== undefined && (bwrapMode & 0o4000) !== 0,
    noNewPrivs: /^NoNewPrivs:\s*1\s*$/m.test(io.readText('/proc/self/status') ?? ''),
    devFuse: io.platform === 'linux' ? io.openReadWrite('/dev/fuse') : 'missing',
    kernelOverlay: filesystems === undefined ? undefined : /\boverlay$/m.test(filesystems),
    userns: io.platform === 'linux' ? usernsState(io) : { state: 'unknown' },
  };
}

/**
 * Pure verdict over the facts. Mirrors what prepareScratchSandbox needs:
 *  - bwrap with --unshare-user (setuid bwrap needs no unprivileged userns);
 *  - tmpfs: a host-namespace tmpfs mount (root only) + kernel overlay (the
 *    tmpfs main overlay has no FUSE fallback) — or FUSE when forced;
 *  - disk: root kernel overlay with fuse-overlayfs fallback; non-root (or
 *    forced) fuse-overlayfs, which needs /dev/fuse and, unprivileged, the
 *    setuid fusermount helper (powerless under NoNewPrivs).
 */
export function evaluateScratchCapability(facts: ScratchFacts): ScratchCapability {
  const isRoot = facts.uid === 0;
  const autoInstall = isRoot && !!facts.has.packageManager;
  if (facts.platform === 'darwin') {
    const problems: ScratchCapabilityProblem[] = facts.has.sandboxExec ? [] : ['sandbox-exec-missing'];
    return {
      platform: facts.platform, summary: problems.length ? 'none' : 'all', problems,
      undecided: [], submountsReadOnly: false, autoInstall: false,
    };
  }
  if (facts.platform !== 'linux') {
    return {
      platform: facts.platform, summary: 'none', problems: ['unsupported-platform'],
      undecided: [], submountsReadOnly: false, autoInstall: false,
    };
  }

  const common: ScratchCapabilityProblem[] = [];
  const undecided: string[] = [];
  const missingPkgs: string[] = [];
  if (!facts.has.bwrap) { common.push('bwrap-missing'); missingPkgs.push('bubblewrap'); }
  if (!facts.bwrapSetuid || facts.noNewPrivs) {
    if (facts.userns.state === 'blocked') common.push('userns-blocked');
    else if (facts.userns.state === 'unknown') undecided.push(facts.userns.detail ?? 'user namespaces');
  }

  const fuseProblems = (): ScratchCapabilityProblem[] => {
    const out: ScratchCapabilityProblem[] = [];
    if (!facts.has.fuseOverlayfs) { out.push('fuse-overlayfs-missing'); if (!missingPkgs.includes('fuse-overlayfs')) missingPkgs.push('fuse-overlayfs'); }
    // Root mounts FUSE itself; an unprivileged mount goes through the setuid helper.
    const setuidHelperWorks = !isRoot && facts.has.fusermount && !facts.noNewPrivs;
    if (facts.devFuse === 'missing') out.push('dev-fuse-missing');
    // The setuid helper opens /dev/fuse as root, so a device this uid cannot
    // open (an old 0660 root:root node) does not settle it.
    else if (facts.devFuse === 'denied' && setuidHelperWorks) undecided.push('/dev/fuse not openable by this user (fusermount3 opens it as root)');
    else if (facts.devFuse === 'denied') out.push('dev-fuse-denied');
    if (!isRoot && !facts.has.fusermount) {
      out.push('fusermount-missing');
      if (!missingPkgs.includes('fuse3')) missingPkgs.push('fuse3');
    } else if (!isRoot && facts.noNewPrivs) out.push('no-new-privs');
    return out;
  };
  const kernelOverlayProblems = (): ScratchCapabilityProblem[] => {
    if (facts.kernelOverlay === false) return ['kernel-overlay-missing'];
    if (facts.kernelOverlay === undefined) undecided.push('/proc/filesystems unreadable');
    return [];
  };

  const tmpfs: ScratchCapabilityProblem[] = [...common];
  if (!isRoot) tmpfs.push('tmpfs-needs-root');
  else tmpfs.push(...(facts.forceFuse ? fuseProblems() : kernelOverlayProblems()));

  const disk: ScratchCapabilityProblem[] = [...common];
  if (!isRoot || facts.forceFuse || facts.kernelOverlay === false) disk.push(...fuseProblems());
  else if (facts.kernelOverlay === undefined) undecided.push('/proc/filesystems unreadable');

  const verdict = (problems: ScratchCapabilityProblem[]): ScratchStorageVerdict => ({
    usable: problems.length ? 'no' : (undecided.length ? 'unknown' : 'yes'),
    problems: [...new Set(problems)],
  });
  const storages = { tmpfs: verdict(tmpfs), disk: verdict(disk) };
  const summary: ScratchCapability['summary'] =
    storages.disk.usable === 'no' && storages.tmpfs.usable === 'no' ? 'none'
      : storages.tmpfs.usable === 'no' ? 'disk-only'
        : (undecided.length ? 'unknown' : 'all');
  const installHint = missingPkgs.length ? scratchInstallHint(facts.has.packageManager, isRoot, missingPkgs) : undefined;
  return {
    platform: facts.platform,
    summary,
    storages,
    undecided: [...new Set(undecided)],
    submountsReadOnly: !isRoot,
    autoInstall: autoInstall && missingPkgs.length > 0,
    ...(installHint ? { installHint } : {}),
  };
}

/** Same command ensureScratchDeps would run (sudo for a non-root daemon). */
export function scratchInstallHint(pm: string | null, isRoot: boolean, packages: readonly string[]): string {
  if (!pm) return `install: ${packages.join(', ')}`;
  const argv = pm === 'apk' ? ['apk', 'add'] : pm === 'pacman' ? ['pacman', '-S', '--noconfirm'] : [pm, 'install', '-y'];
  return [...(isRoot ? [] : ['sudo']), ...argv, ...packages].join(' ');
}

export function probeScratchCapability(io?: ScratchProbeIo): ScratchCapability {
  return evaluateScratchCapability(gatherScratchFacts(io));
}

// ───────────────────────── prepare failure → chat notice ─────────────────────

/** Why prepareScratchSandbox (Linux) / prepareMacScratchSandbox returned no spawn. */
export const SCRATCH_FAILURE_REASONS = [
  'unsupported-platform',
  'deps-missing',
  'tmpfs-needs-root',
  'tmpfs-mount-failed',
  'tmpfs-upper-lost',
  'overlay-mount-failed',
  'storage-conflict',
  'prepare-in-progress',
  'stale-mount',
  'state-write-failed',
  'cwd-on-ro-submount',
  'cwd-not-writable',
  'cwd-write-leaked',
  'mcp-socket',
  'mac-sandbox-exec-missing',
  'mac-cross-volume',
  'mac-clone-failed',
  'mac-unsafe-session-id',
] as const;
export type ScratchFailureReason = (typeof SCRATCH_FAILURE_REASONS)[number];

export interface ScratchFailure {
  reason: ScratchFailureReason;
  /** Short host detail (stderr line, path, missing packages) for the notice. */
  detail?: string;
  /** deps-missing: the install command the operator can run. */
  installHint?: string;
  /** storage-conflict: the storage this session was created with. */
  recordedStorage?: ScratchStorageKind;
  /** overlay-mount-failed: which driver was used last. */
  driver?: 'kernel' | 'fuse';
}

const REASON_TEXT: Record<ScratchFailureReason, (f: ScratchFailure) => { what: string; fix: string }> = {
  'unsupported-platform': () => ({ what: '当前平台不支持 scratch', fix: 'scratch 只支持 Linux 和 macOS；请把文件沙盒改成「关闭」或「oncall 分享」' }),
  'deps-missing': f => ({
    what: `缺少依赖${f.detail ? `（${f.detail}）` : ''}，自动安装没有成功`,
    fix: `在 daemon 所在机器上安装${f.installHint ? `：\`${f.installHint}\`` : '缺少的包'}，然后重试`,
  }),
  'tmpfs-needs-root': () => ({
    what: '内存存储（tmpfs）需要 daemon 以 root 运行，这台机器只能用磁盘存储',
    fix: '到 Dashboard → Bot 配置 → 权限与安全 → 文件沙盒，把 scratch 存储改成「磁盘」，然后重试',
  }),
  'tmpfs-mount-failed': f => ({
    what: `内存存储（tmpfs）挂载失败${f.detail ? `：${f.detail}` : ''}`,
    fix: '检查 /var/tmp 是否可写、内存是否充足；也可以把 scratch 存储改成「磁盘」后重试',
  }),
  'tmpfs-upper-lost': () => ({
    what: '这个会话的内存存储在机器重启时已经丢失，原来的改动无法恢复',
    fix: '请新开一个会话',
  }),
  'overlay-mount-failed': f => ({
    what: `写时复制层（overlay）挂载失败${f.detail ? `：${f.detail}` : ''}`,
    fix: f.driver === 'fuse'
      ? '检查 fuse-overlayfs 是否已安装、/dev/fuse 能否打开；非 root 运行时还需要 fusermount3（fuse3 包），且 daemon 不能带 NoNewPrivileges（systemd 单元里的 NoNewPrivileges=yes 会让 fusermount3 失去权限）。改好后重试'
      : '内核 overlay 不可用时会改用 fuse-overlayfs：安装 fuse-overlayfs 并确认 /dev/fuse 可用后重试',
  }),
  'storage-conflict': f => ({
    what: `这个会话建立时用的是${f.recordedStorage === 'disk' ? '磁盘' : '内存'}存储，和当前配置不一致`,
    fix: `把 scratch 存储改回「${f.recordedStorage === 'disk' ? '磁盘' : '内存'}」后重试；新的存储设置只对之后新建的会话生效`,
  }),
  'prepare-in-progress': () => ({
    what: '另一个进程正在准备这个会话的沙盒',
    fix: '稍等片刻后重试',
  }),
  'stale-mount': f => ({
    what: `这个会话的沙盒目录上还挂着上次留下的挂载，但缺少对应记录${f.detail ? `（${f.detail}）` : ''}`,
    fix: f.detail ? `在宿主上执行 \`umount -R ${f.detail}\` 后重试` : '卸掉该会话 sandboxes 目录下的残留挂载后重试',
  }),
  'state-write-failed': f => ({
    what: `写不进沙盒状态文件${f.detail ? `：${f.detail}` : ''}`,
    fix: '检查 botmux 数据目录所在磁盘是否已满、是否可写，然后重试',
  }),
  'cwd-on-ro-submount': f => ({
    what: `工作目录所在的挂载${f.detail ? `（${f.detail}）` : ''}没法做写时复制，在沙盒里只能只读`,
    fix: '非 root 运行时，根文件系统之外的挂载盘在沙盒里都是只读的。把工作目录换到根文件系统上，或以 root 运行 daemon',
  }),
  'cwd-not-writable': f => ({
    what: `工作目录在写时复制视图里写不进去${f.detail ? `：${f.detail}` : ''}`,
    fix: '检查工作目录是否存在、daemon 用户是否有权限访问，然后重试',
  }),
  'cwd-write-leaked': () => ({
    what: '自检发现沙盒里的写入穿透到了真实目录',
    fix: '已拒绝启动。请把 daemon 日志里 [scratch-sandbox] 开头的几行反馈给维护者',
  }),
  'mcp-socket': () => ({
    what: 'MCP 网关的 socket 不可用',
    fix: '重试一次；仍然失败请检查 daemon 日志里的 MCP gateway 报错',
  }),
  'mac-sandbox-exec-missing': () => ({ what: '找不到 sandbox-exec', fix: 'macOS 自带 /usr/bin/sandbox-exec，请确认系统没有移除它' }),
  'mac-cross-volume': f => ({
    what: `HOME 与 botmux 数据目录不在同一个卷上${f.detail ? `（${f.detail}）` : ''}，无法做 APFS 克隆`,
    fix: '把 botmux 数据目录放到 HOME 所在的卷上',
  }),
  'mac-clone-failed': f => ({
    what: `复制 HOME 或项目目录失败${f.detail ? `（${f.detail}）` : ''}`,
    fix: '检查磁盘空间，以及 daemon 是否有「完全磁盘访问」权限，然后重试',
  }),
  'mac-unsafe-session-id': () => ({ what: '会话 ID 含有不安全字符', fix: '请把 daemon 日志反馈给维护者' }),
};

/** Chat text for a scratch prepare failure: what went wrong + the matching fix. */
export function scratchFailureNotice(failure: ScratchFailure): string {
  const { what, fix } = REASON_TEXT[failure.reason](failure);
  return `scratch 沙箱没能建立：${what}。${fix}。（已拒绝启动，不会在沙箱外运行）`;
}
