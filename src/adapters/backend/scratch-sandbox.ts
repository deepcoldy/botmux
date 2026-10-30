/**
 * Linux SCRATCH sandbox: full-root copy-on-write overlay, throwaway.
 *
 * Design: docs/design/2026-09-21-sandbox-scratch-mode.md
 *
 * Threat model is INTEGRITY/RECOVERABILITY, not confidentiality (that is the
 * oncall/fs-policy sandbox in ./sandbox.ts): the operator trusts the workload
 * but wants a disposable machine — the CLI reads the ENTIRE real filesystem
 * natively (real config/auth/state, zero allow-list friction), while EVERY
 * write copy-ups into a per-session overlay upper and NEVER reaches the host.
 * Discarding the session discards all writes; there is deliberately no
 * landing/export path.
 *
 * Mechanism (empirically verified on the live host, root + unprivileged):
 *   host side (this process, BEFORE bwrap):
 *     tmpfs storage: mount -t tmpfs           <slot>           # independent superblock
 *                    mount -t overlay lowerdir=/ upper=<slot>/upper work=<slot>/work <merged>
 *     disk   storage: mount -t overlay lowerdir=/ upper=<sRoot>/upper work=<sRoot>/work <merged>
 *   bwrap:
 *     --bind <merged> /          # container root = the full-root COW view
 *     …fresh /proc /dev /tmp /run /var/tmp /dev/shm…
 *     …deny masks on top (transport credentials + user scratchDenyPaths)…
 *     …shim / trusted botmux paths / MCP socket / outbox binds (identical
 *       to direct oncall mode; the outbox stays a REAL host directory)…
 *
 * root uses the kernel overlay driver; a non-root daemon (or BOTMUX_SANDBOX_FUSE=1)
 * uses fuse-overlayfs, which also tolerates `upper` living under `lower=/`
 * (kernel overlay on some hardened configs rejects that; tmpfs slot always
 * works, disk mode then fails closed with a clear message).
 *
 * SUBMOUNTS: with lowerdir=/ every mount UNDER `/` (a separate data disk such
 * as /data00, a bind mount, a tmpfs at a data path) would render as an EMPTY
 * directory in the merged view — overlayfs does not recurse into submounts.
 * Each relevant submount therefore gets its OWN overlay, whose merged tree is
 * bound into the main merged tree at the same path; writes there COW into its
 * own upper and never touch the real submount. A submount that cannot be
 * overlaid is exposed READ-ONLY; if the working dir sits under such a point,
 * spawn fails closed (never bind it read-write-through to the host).
 *
 * All mounts are created in the daemon/worker mount namespace (the host init
 * namespace — botmux does not unshare mounts), so they SURVIVE the daemon
 * process and a daemon restart: a live tmux/herdr/zellij pane keeps running
 * untouched (reattach rewires only the outbox), and a cold resume reuses or
 * re-mounts the same upper. Only a machine reboot wipes the tmpfs slot.
 *
 * Nothing in this module runs on macOS (the kernel has no COW primitive).
 */
import { writeCliNameLink } from '../../core/sandbox-wrapper-launch.js';
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, basename, dirname, isAbsolute, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import {
  botmuxShimExecLine,
  reattachableRelayOutbox,
  removeTreeUnlessMounted,
  reexposeRunBinArgs,
  hostResolverBindArgs,
  SCRATCH_TREE_MARKER,
} from './sandbox.js';
import { linuxIsolationLaunch, linuxIsolationLaunchViaArgsFile } from '../../core/linux-isolation.js';
import { bwrapExecutable } from '../../core/system-bwrap.js';
import { procStatStartTimeDigits } from '../../utils/proc-stat.js';
import { PROXY_ENV_KEYS, CA_BUNDLE_ENV_KEYS } from '../../utils/child-env.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../../core/plugins/mcp/environment.js';
import { scratchInstallHint, type ScratchFailure } from './scratch-capability.js';

/** Scratch upper storage selection. */
export type ScratchStorage = 'tmpfs' | 'disk';

/** Host-side /var/tmp root for the tmpfs upper slots (never visible in the
 *  container: bwrap masks /var/tmp with a fresh tmpfs). */
const VARTMP_ROOT = '/var/tmp/botmux-scratch';

export interface ScratchSandboxSpawn {
  /** Isolation launcher (seccomp-marker shell wrapping bwrap). */
  bin: string;
  /** Launcher args + bwrap args + '--' + original (bin, ...args). */
  args: string[];
  /** Path to private file containing NUL-separated bwrap options when using args-file launch. */
  argsFile?: string;
  /** Env overrides merged into childEnv (HOME/path/relay — REAL in-container
   *  paths; the container sees the normal filesystem layout). */
  env: Record<string, string>;
  /** Host-side outbox dir the daemon watcher services. */
  outbox: string;
  /** Host path of the overlay MERGED root — the host-side window into the
   *  container's filesystem: `/x` inside the sandbox maps to
   *  `${mergedHostPath}/x` on the host. The worker points its host-side
   *  transcript/state readers at this tree. */
  mergedHostPath: string;
  /** Set when the host had more submounts than SCRATCH_SUBMOUNT_OVERLAY_LIMIT:
   *  the excess is read-only in this session (see scratchSubmountOverflowNotice). */
  submountOverflow?: { eligible: number; readOnly: string[] };
  /** Mount/unmount + remove the whole session (overlay, tmpfs slot, trees). */
  cleanup: () => void;
}

export interface ScratchMeta {
  v: 1;
  sid: string;
  storage: ScratchStorage;
  lower: string;
  merged: string;
  upper: string;
  work: string;
  /** tmpfs slot mountpoint (tmpfs storage only). */
  slot?: string;
  /** Submounts wrapped with their own overlay (for restart-time teardown).
   *  `dir` names the sub-overlay's `subroots/<dir>` (and tmpfs `sub-<dir>-*`);
   *  absent in metas written before it was recorded (see assignSubDirs). */
  subs?: { mountpoint: string; dir?: string }[];
  /** Host-path → merged-tree view mappings for daemon-side transcript reads.
   *  Linux always has the single full-root mapping `'/' → merged`. */
  mappings?: { from: string; to: string }[];
  createdAt: number;
  /** Optional tmpfs size cap (MB), tmpfs storage only. */
  tmpfsSizeMb?: number;
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function hasCmd(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

/** Verify (best-effort auto-install) bwrap +, for the userspace path,
 *  fuse-overlayfs. Same provisioning policy as the oncall sandbox: root or
 *  passwordless sudo only, never block on a prompt. */
function ensureScratchDeps(needFuse: boolean): ScratchFailure | null {
  const missing: string[] = [];
  if (!bwrapExecutable()) missing.push('bubblewrap');
  if (needFuse && !hasCmd('fuse-overlayfs')) missing.push('fuse-overlayfs');
  if (!missing.length) return null;
  const pm =
    hasCmd('apt-get') ? ['apt-get', 'install', '-y', ...missing] :
    hasCmd('dnf') ? ['dnf', 'install', '-y', ...missing] :
    hasCmd('yum') ? ['yum', 'install', '-y', ...missing] :
    hasCmd('apk') ? ['apk', 'add', ...missing] :
    hasCmd('pacman') ? ['pacman', '-S', '--noconfirm', ...missing] :
    null;
  const isRoot = process.getuid?.() === 0;
  if (pm) {
    const argv = isRoot ? pm : ['sudo', '-n', ...pm];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 180_000 });
    if (r.status === 0 && missing.every(m => (m === 'bubblewrap' ? !!bwrapExecutable() : hasCmd(m)))) return null;
  }
  const guide = scratchInstallHint(pm?.[0] ?? null, isRoot, missing);
  console.error(`[scratch-sandbox] missing deps (${missing.join(', ')}); auto-install unavailable — ${guide}`);
  return { reason: 'deps-missing', detail: missing.join(', '), installHint: guide };
}

/** Mount an overlayfs. root → kernel `mount -t overlay`; otherwise (or when
 *  BOTMUX_SANDBOX_FUSE=1) → fuse-overlayfs. Returns null on success, else the
 *  driver tried last and its error. When the
 *  kernel mount fails and allowFuseFallback is set, FUSE is tried (the
 *  userspace driver tolerates upper-under-lower for lower=/). */
function mountOverlay(opts: {
  lower: string;
  upper: string;
  work: string;
  merged: string;
  allowFuseFallback: boolean;
}): { driver: 'kernel' | 'fuse'; detail: string } | null {
  for (const d of [opts.upper, opts.work, opts.merged]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* */ }
  }
  const optStr = `lowerdir=${opts.lower},upperdir=${opts.upper},workdir=${opts.work}`;
  const forceFuse = process.env.BOTMUX_SANDBOX_FUSE === '1';
  if (!forceFuse && process.getuid?.() === 0) {
    const r = spawnSync('mount', ['-t', 'overlay', 'overlay', '-o', optStr, opts.merged], { stdio: 'pipe' });
    if (r.status === 0) return null;
    if (!opts.allowFuseFallback) {
      const detail = spawnErrorText(r);
      console.error(`[scratch-sandbox] kernel overlay mount failed: ${detail}`);
      return { driver: 'kernel', detail };
    }
  }
  const f = spawnSync('fuse-overlayfs', ['-o', optStr, opts.merged], { stdio: 'pipe' });
  if (f.status !== 0) {
    const detail = spawnErrorText(f);
    console.error(`[scratch-sandbox] overlay mount failed (kernel/fuse): ${detail}`);
    return { driver: 'fuse', detail };
  }
  return null;
}

/** First stderr line (mount appends a generic dmesg hint after the real
 *  error), else the spawn error / exit status, for a failure notice. */
function spawnErrorText(r: ReturnType<typeof spawnSync>): string {
  const line = (r.stderr?.toString() ?? '').split('\n').map(l => l.trim()).find(Boolean);
  return line ?? (r.error ? r.error.message : `exit ${r.status}`);
}

export function isMountpoint(p: string): boolean {
  return spawnSync('mountpoint', ['-q', p], { stdio: 'ignore' }).status === 0;
}

/** Unmount best-effort: kernel mount → umount; FUSE → fusermount -u; finally
 *  lazy umount for a busy draining fd. Idempotent. */
function unmountAny(p: string): void {
  if (!isMountpoint(p)) return;
  if (spawnSync('umount', [p], { stdio: 'ignore' }).status === 0) return;
  if (spawnSync('fusermount', ['-u', p], { stdio: 'ignore' }).status === 0) return;
  spawnSync('umount', ['-l', p], { stdio: 'ignore' });
}

function isWithin(parent: string, p: string): boolean {
  if (parent === p) return true;
  const rel = relative(parent, p);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

// ───────────────────────── submount handling ─────────────────────────────────

/** fs types worth recursing into when wrapping submounts. Virtual filesystems
 *  under /proc /sys /dev /run are excluded by PATH instead, so tmpfs at a real
 *  data path (e.g. a RAM disk at /data/ram) is included. `fuse.*` and
 *  `fuseblk` (external drives, many network FS) included too. */
const SUBMOUNT_FSTYPES = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'bcachefs', 'zfs', 'f2fs', 'jfs',
  'reiserfs', 'ocfs2', 'gfs2', 'vfat', 'exfat', 'ntfs', 'ntfs3', '9p',
  'virtiofs', 'nfs', 'nfs4', 'cifs', 'ceph', 'overlay', 'tmpfs', 'ramfs',
  'fuseblk',
]);

/** Mount prefixes replaced INSIDE the container by bwrap primitives/fresh
 *  tmpfs — host submounts there are irrelevant to the COW view. */
const CONTAINER_OWNED_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/tmp', '/var/tmp', '/dev/shm'];

/** Most submounts one session wraps in their own overlay. Each costs a host
 *  overlay mount plus a bind into the merged tree (and, under FUSE, one
 *  fuse-overlayfs daemon) for the whole life of the session. A workstation has
 *  a handful (the live host: /data00, two binds and 9 docker rootfs = 12); 64
 *  leaves room for a docker host with a few dozen containers while capping what
 *  a host full of mounts botmux cannot recognise costs every new session. */
export const SCRATCH_SUBMOUNT_OVERLAY_LIMIT = 64;

export interface HostMountEntry { mountpoint: string; fstype: string }

export interface ScratchSubmountPlan {
  /** Wrapped in their own COW overlay, shallow first (parent bind before child). */
  overlay: HostMountEntry[];
  /** Over the limit: exposed read-only, like a submount that cannot be overlaid. */
  readOnly: HostMountEntry[];
  /** Skipped: mounts inside scratch session trees (any session, any data dir). */
  scratchTreeMounts: number;
}

function decodeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** `<…>/sandboxes/<sid>` trees a mountpoint sits in, outermost first, when it is
 *  at or under the tree's `root` (main overlay + the binds into it) or
 *  `subroots` (sub-overlays): the only places a Linux scratch session mounts. */
function scratchTreeRootsOf(mountpoint: string): string[] {
  const parts = mountpoint.split('/');
  const roots: string[] = [];
  for (let i = 1; i + 2 < parts.length; i++) {
    if (parts[i] !== 'sandboxes' || !parts[i + 1]) continue;
    if (parts[i + 2] !== 'root' && parts[i + 2] !== 'subroots') continue;
    roots.push(parts.slice(0, i + 2).join('/'));
  }
  return roots;
}

/** prepareScratchSandbox creates `subroots` before its first mount and writes
 *  the marker after the last; the tree is never removed while mounted. A user
 *  directory that merely looks like `sandboxes/x/root` has neither. */
function isScratchTreeOnDisk(sessionRoot: string): boolean {
  try { if (lstatSync(join(sessionRoot, 'subroots')).isDirectory()) return true; } catch { /* */ }
  try { lstatSync(join(sessionRoot, SCRATCH_TREE_MARKER)); return true; } catch { return false; }
}

/**
 * Pick the host mounts UNDER `/` that the full-root overlay would render EMPTY.
 *
 * Mounts that belong to a scratch session tree are skipped — whatever data dir
 * it lives in (another BOTMUX_HOME, a test or probe dir under the session TMPDIR,
 * a lab under /tmp). Wrapping them made each new session overlay every earlier
 * session's overlays and binds again, so the host mount table (and, nested past
 * the kernel's overlay depth, the fuse-overlayfs daemons) grew geometrically
 * with every session. Matched by tree layout, not by fs type: a root daemon's
 * own overlays are kernel `overlay`, and overlay / fuse-overlayfs mounts that
 * are not botmux's (container rootfs, a user's own) are real data to wrap.
 *
 * At most `limit` get an overlay; the rest are reported in `readOnly` instead
 * of being wrapped silently. Ranked: mounts holding a `writable` path (the
 * working dir, HOME) first, then mounts below one, then the others; shallow
 * first within each.
 */
export function planScratchSubmounts(input: {
  mountinfo: string;
  infraRoots: readonly string[];
  /** Paths the CLI must be able to write (working dir, HOME). */
  writable: readonly string[];
  limit?: number;
  isScratchTree?: (sessionRoot: string) => boolean;
}): ScratchSubmountPlan {
  const isScratchTree = input.isScratchTree ?? isScratchTreeOnDisk;
  const treeVerdicts = new Map<string, boolean>();
  const insideScratchTree = (mountpoint: string): boolean => scratchTreeRootsOf(mountpoint).some(root => {
    let verdict = treeVerdicts.get(root);
    if (verdict === undefined) treeVerdicts.set(root, verdict = isScratchTree(root));
    return verdict;
  });
  const picked = new Map<string, HostMountEntry>();
  let scratchTreeMounts = 0;
  for (const line of input.mountinfo.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    const mountpoint = decodeMountPath(left[4] ?? '');
    const fstype = right[0] ?? '';
    if (!mountpoint.startsWith('/') || mountpoint === '/') continue;
    if (CONTAINER_OWNED_PREFIXES.some(p => mountpoint === p || isWithin(p, mountpoint))) continue;
    if (input.infraRoots.some(p => isWithin(p, mountpoint))) continue;
    const baseType = fstype.split('.')[0] ?? '';
    if (!SUBMOUNT_FSTYPES.has(fstype) && !SUBMOUNT_FSTYPES.has(baseType) && !fstype.startsWith('fuse.')) continue;
    if (picked.has(mountpoint)) continue;
    if (insideScratchTree(mountpoint)) { scratchTreeMounts++; continue; }
    picked.set(mountpoint, { mountpoint, fstype });
  }
  const shallowFirst = (a: HostMountEntry, b: HostMountEntry): number =>
    a.mountpoint.split('/').length - b.mountpoint.split('/').length || a.mountpoint.localeCompare(b.mountpoint);
  const all = [...picked.values()].sort(shallowFirst);
  const limit = input.limit ?? SCRATCH_SUBMOUNT_OVERLAY_LIMIT;
  if (all.length <= limit) return { overlay: all, readOnly: [], scratchTreeMounts };
  // A parent of a mount in a tier is in that tier or an earlier one, so an
  // overlaid child always has its parent overlaid.
  const tier = (m: HostMountEntry): number => {
    if (input.writable.some(p => isWithin(m.mountpoint, p))) return 0;
    if (input.writable.some(p => isWithin(p, m.mountpoint))) return 1;
    return 2;
  };
  const ranked = [0, 1, 2].flatMap(t => all.filter(m => tier(m) === t));
  return {
    overlay: ranked.slice(0, limit).sort(shallowFirst),
    readOnly: ranked.slice(limit).sort(shallowFirst),
    scratchTreeMounts,
  };
}

function readMountinfo(): string {
  try { return readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return ''; }
}

function mountpointSet(mountinfo: string): Set<string> {
  const out = new Set<string>();
  for (const line of mountinfo.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep >= 0) out.add(decodeMountPath(line.slice(0, sep).split(' ')[4] ?? ''));
  }
  return out;
}

/**
 * `subroots/<dir>` for each submount to overlay. A sub-overlay's disk upper
 * (tmpfs: `sub-<dir>-upper` in the slot) holds the session's writes to THAT
 * mount, so a re-mount must hand each mount its own dir back: an index into the
 * current mount list would give a disk upper written for one mount to another
 * once the host gained or lost a mount (or the plan's ranking changed).
 *  - recorded `dir` → reused;
 *  - a meta written before dirs were recorded → the index the old code gave it
 *    (its position in `legacyOrder`, the unfiltered shallow-first list);
 *  - otherwise → the lowest integer not used on disk or by another mount.
 */
export function assignSubDirs(input: {
  mountpoints: readonly string[];
  recorded: readonly { mountpoint: string; dir?: string }[];
  legacyOrder: () => readonly string[];
  usedOnDisk: readonly string[];
}): Map<string, string> {
  const dirs = new Map<string, string>();
  const claimed = new Set<string>();
  const claim = (mountpoint: string, dir: string | undefined): void => {
    if (dir === undefined || !/^[0-9]+$/.test(dir) || claimed.has(dir) || dirs.has(mountpoint)) return;
    dirs.set(mountpoint, dir);
    claimed.add(dir);
  };
  for (const s of input.recorded) claim(s.mountpoint, s.dir);
  // A reconstructed index that another mount already holds is not this mount's:
  // never hand one upper to two overlays.
  const legacy = input.recorded.filter(s => s.dir === undefined);
  const order = legacy.length > 0 ? input.legacyOrder() : [];
  for (const s of legacy) claim(s.mountpoint, order.includes(s.mountpoint) ? String(order.indexOf(s.mountpoint)) : undefined);
  const taken = new Set([...input.usedOnDisk, ...dirs.values()]);
  let next = 0;
  const out = new Map<string, string>();
  for (const mp of input.mountpoints) {
    let dir = dirs.get(mp);
    if (dir === undefined) {
      while (taken.has(String(next))) next++;
      dir = String(next);
      taken.add(dir);
    }
    out.set(mp, dir);
  }
  return out;
}

// ───────────────────────── prepare-in-progress record ───────────────────────

/** Written before a prepare's first mount, removed once its marker is written:
 *  names the process still building the tree. */
const PREPARING_RECORD = 'preparing';

function processStartTime(pid: number): string | undefined {
  try { return procStatStartTimeDigits(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return undefined; }
}

function readPreparingOwner(sessionRoot: string): { pid: number; start: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(sessionRoot, PREPARING_RECORD), 'utf8')) as { pid?: unknown; start?: unknown };
    if (Number.isInteger(raw.pid) && typeof raw.start === 'string') return { pid: raw.pid as number, start: raw.start };
  } catch { /* none / torn */ }
  return null;
}

/** Another process, still running (same pid AND start time), is building this
 *  tree right now: the sweep, a close-time teardown and a second prepare all
 *  keep out (a prepare stuck on a mount is not residue). */
function preparingByOther(sessionRoot: string): boolean {
  const owner = readPreparingOwner(sessionRoot);
  return !!owner && owner.pid !== process.pid && processStartTime(owner.pid) === owner.start;
}

/** A prepare started this tree and nobody is finishing it: the recorded
 *  preparer is gone, or it is this process (an earlier attempt that failed). */
function preparingAbandoned(sessionRoot: string): boolean {
  const owner = readPreparingOwner(sessionRoot);
  return !!owner && (owner.pid === process.pid || processStartTime(owner.pid) !== owner.start);
}

/** User-facing notice for a session whose submounts went over the limit. */
export function scratchSubmountOverflowNotice(overflow: { eligible: number; readOnly: readonly string[] }): string {
  const shown = overflow.readOnly.slice(0, 5).join('、');
  const more = overflow.readOnly.length > 5 ? ` 等 ${overflow.readOnly.length} 个` : '';
  return `⚠️ scratch 沙箱：本机有 ${overflow.eligible} 个需要写时复制的子挂载，超过单会话上限 ${SCRATCH_SUBMOUNT_OVERLAY_LIMIT}，`
    + `超出的在本会话里只读（${shown}${more}）。工作目录和 HOME 所在的挂载不受影响；如果是残留挂载，清理宿主后新开会话即可恢复。`;
}

// ───────────────────────── layout + meta ────────────────────────────────────

function metaPath(sessionRoot: string): string {
  return join(sessionRoot, SCRATCH_TREE_MARKER);
}

function readMeta(sessionRoot: string): ScratchMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(sessionRoot), 'utf8')) as ScratchMeta;
    if (m && m.v === 1 && typeof m.merged === 'string') return m;
  } catch { /* not a scratch session */ }
  return null;
}

/** Layout resolution for a session — single source of truth shared by
 *  prepare / attach / teardown / sweep. */
function scratchLayout(sessionId: string, dataDir: string, storage: ScratchStorage): {
  sessionRoot: string;
  merged: string;
  upper: string;
  work: string;
  slot: string | undefined;
  subroots: string;
} {
  const sessionRoot = join(canonical(dataDir), 'sandboxes', sessionId);
  const merged = join(sessionRoot, 'root');
  const subroots = join(sessionRoot, 'subroots');
  if (storage === 'tmpfs') {
    const slot = join(VARTMP_ROOT, sessionId);
    return { sessionRoot, merged, upper: join(slot, 'upper'), work: join(slot, 'work'), slot, subroots };
  }
  return {
    sessionRoot, merged,
    upper: join(sessionRoot, 'upper'), work: join(sessionRoot, 'work'),
    slot: undefined, subroots,
  };
}

/** Bring the tmpfs upper slot up (tmpfs storage only). Size 0/undefined =
 *  kernel default. A non-root daemon cannot mount a tmpfs in the host
 *  namespace — fail honestly (use disk storage + fuse-overlayfs), never
 *  silently change the RAM-backed promise. */
function mountSlot(slot: string, sizeMb?: number): ScratchFailure | null {
  try { mkdirSync(slot, { recursive: true }); } catch { /* */ }
  if (isMountpoint(slot)) return null; // already there (daemon restart)
  const sizeKb = sizeMb && sizeMb > 0 ? `,size=${Math.trunc(sizeMb * 1024)}k` : '';
  const args = sizeKb
    ? ['-t', 'tmpfs', '-o', `mode=700${sizeKb}`, 'tmpfs', slot]
    : ['-t', 'tmpfs', '-o', 'mode=700', 'tmpfs', slot];
  const r = spawnSync('mount', args, { stdio: 'pipe' });
  if (r.status === 0) return null;
  const detail = spawnErrorText(r);
  console.error(`[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk"): ${detail}`);
  // Only root can mount a tmpfs in the host namespace: say so rather than
  // passing mount's "must be superuser" through (no automatic switch to disk).
  return process.getuid?.() === 0 ? { reason: 'tmpfs-mount-failed', detail } : { reason: 'tmpfs-needs-root', detail };
}

export interface PrepareScratchOpts {
  sessionId: string;
  dataDir: string;
  storage: ScratchStorage;
  /** tmpfs size cap in MB (tmpfs storage only). 0/undefined = kernel default. */
  tmpfsSizeMb?: number;
  /** Session temp path; recreate its short alias after the private /tmp mount. */
  tempDir?: string;
  /** Keep network (default true). */
  net?: boolean;
  /** Absolute host paths to hide inside the sandbox ON TOP OF the full-root
   *  view (mode-000 masks). The worker passes the fixed transport-credential
   *  set + the bot's `scratchDenyPaths`. Non-existent entries are masked as
   *  dirs; existing files get file-shaped masks. */
  denyPaths?: readonly string[];
  chdir: string;
  home: string;
  cliBin: string;
  cliArgs: string[];
  /** Transport bwrap options via a private file when launching under a backend
   *  with command-length limits (tmux new-session). */
  useBwrapArgsFile?: boolean;
  /** wrapperCli inside the sandbox: `<cli name>` alias placed in the private
   *  shim dir (first on PATH) pointing at the real, already-allowed CLI. */
  cliNameLink?: { name: string; target: string };
  /** Absolute `botmux` command paths to overlay with the relay shim. */
  shimBindTargets?: readonly string[];
  mcpGatewaySocketPath?: string;
  /** Host paths that must be READABLE inside the sandbox even though they live
   *  under a denied directory (e.g. this session's own trigger-user identity
   *  files under the otherwise-sealed cli-identity/ dir). Bound READ-ONLY. */
  readOnlyCarvePaths?: readonly string[];
  /** Host paths that must be READ+WRITABLE inside even under a denied dir
   *  (the outbox is handled internally; reserved for future carve-outs). */
  writableCarvePaths?: readonly string[];
  /** Env keys the WORKER may repoint at the host-side merged tree for its own
   *  transcript reads (CODEX_HOME / TRAE_HOME). The container child must keep
   *  seeing the NATIVE path (the merged host path does not exist inside the
   *  container), so each key is force-set to its host value (or unset) via
   *  authoritative --setenv/--unsetenv. */
  childEnvForce?: Record<string, string | undefined>;
  /** Drop --unshare-pid (nested sandbox), mirrors direct mode. */
  skipPidNamespace?: boolean;
}

export type ScratchPrepareResult =
  | { ok: true; spawn: ScratchSandboxSpawn }
  | { ok: false; failure: ScratchFailure };

/** prepareScratchSandboxDetailed without the reason: null on any failure. */
export function prepareScratchSandbox(opts: PrepareScratchOpts): ScratchSandboxSpawn | null {
  const r = prepareScratchSandboxDetailed(opts);
  return r.ok ? r.spawn : null;
}

/**
 * Build the scratch-sandboxed spawn for a CLI session. Fails ONLY when the
 * platform/deps/storage cannot serve it, with the reason (the worker turns it
 * into a notice and a hard error — never a silent unsandboxed run).
 *
 * Re-entry semantics (same-session re-spawn, daemon-restart cold resume):
 *  - an already-mounted matching overlay (+submounts) is REUSED;
 *  - an unmounted disk session is REMOUNTED with its recorded upper/work;
 *  - a tmpfs session whose slot vanished (machine reboot) is unrecoverable:
 *    the caller must surface that, never fabricate a fresh upper (the CLI
 *    would "resume" against a state it never had).
 */
export function prepareScratchSandboxDetailed(opts: PrepareScratchOpts): ScratchPrepareResult {
  const refuse = (failure: ScratchFailure): ScratchPrepareResult => ({ ok: false, failure });
  if (process.platform !== 'linux') return refuse({ reason: 'unsupported-platform' });

  const storage: ScratchStorage = opts.storage === 'disk' ? 'disk' : 'tmpfs';
  const needFuse = process.env.BOTMUX_SANDBOX_FUSE === '1' || process.getuid?.() !== 0;
  const depsFailure = ensureScratchDeps(needFuse);
  if (depsFailure) return refuse(depsFailure);
  // ensureScratchDeps resolves through the same bwrapExecutable(), so this is
  // present; keep the resolved path explicit at the launch sites (never a bare
  // bwrap) and fail closed in the (unreachable) event it vanished.
  const bwrap = bwrapExecutable();
  if (!bwrap) {
    return refuse({
      reason: 'deps-missing',
      detail: 'bubblewrap',
      installHint: scratchInstallHint(null, process.getuid?.() === 0, ['bubblewrap']),
    });
  }

  const launch = linuxIsolationLaunch(bwrap, []);
  const { sessionRoot, merged, upper, work, slot, subroots } =
    scratchLayout(opts.sessionId, opts.dataDir, storage);
  // A prepare killed between its first mount and its marker left mounts and no
  // marker. The marker is written before any CLI starts, so nothing ever ran on
  // that view: take it down and build afresh (otherwise the session could never
  // start again — "already mounted but meta missing").
  if (!readMeta(sessionRoot) && isMountpoint(merged) && preparingAbandoned(sessionRoot)) {
    console.error(`[scratch-sandbox] session ${opts.sessionId}: reclaiming a half-prepared tree left by a prepare that never finished`);
    teardownScratchSession(opts.sessionId, opts.dataDir);
    if (slot) { unmountAny(slot); removeTreeUnlessMounted(slot); }
  }
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const empties = join(sessionRoot, 'empties');
  const emptyDir = join(sessionRoot, 'empty');
  for (const d of [outbox, shimBin, empties, emptyDir, merged, subroots]) {
    mkdirSync(d, { recursive: true });
  }
  try { chmodSync(emptyDir, 0o000); } catch { /* */ }

  const existing = readMeta(sessionRoot);
  if (existing && (existing.storage !== storage || existing.upper !== upper)) {
    console.error(`[scratch-sandbox] session ${opts.sessionId}: on-disk scratch meta (${existing.storage}) conflicts with requested ${storage} — refusing to spawn`);
    return refuse({ reason: 'storage-conflict', recordedStorage: existing.storage === 'disk' ? 'disk' : 'tmpfs' });
  }

  // Two prepares of one session never run at once (one worker per session);
  // if they somehow did, the second would stack a view over the first's.
  if (preparingByOther(sessionRoot)) {
    console.error(`[scratch-sandbox] session ${opts.sessionId}: another live process is preparing this sandbox — refusing to spawn`);
    return refuse({ reason: 'prepare-in-progress' });
  }

  const preparingRecord = join(sessionRoot, PREPARING_RECORD);
  const rolledBack: string[] = [];
  const fail = (where: string, failure: ScratchFailure): ScratchPrepareResult => {
    console.error(`[scratch-sandbox] setup failed at ${where} — aborting spawn (fail closed, never bare-run)`);
    for (const p of [...rolledBack].reverse()) unmountAny(p);
    if (!existing && storage === 'tmpfs' && slot && isMountpoint(slot)) unmountAny(slot);
    // A recorded session's tree IS its state (a disk upper, the outbox its pane
    // binds): keep it for the next attempt. Only a fresh tree is ours to drop —
    // and never by rm through anything still mounted.
    if (existing) rmSync(preparingRecord, { force: true });
    else removeTreeUnlessMounted(sessionRoot);
    return refuse(failure);
  };

  // A recorded view that is not what its marker says — a re-mount or teardown
  // that stopped half-way: a recorded submount's bind is missing, one that is
  // not recorded is bound, or a re-mount's preparer died. Adopting it would run
  // the CLI on empty dirs where those mounts belong; take the stack down
  // (files untouched) and mount it again from the recorded layout.
  if (existing && existing.merged === merged && isMountpoint(merged)) {
    const mountinfo = readMountinfo();
    const mounted = mountpointSet(mountinfo);
    const recorded = new Set((existing.subs ?? []).map(sub => sub.mountpoint));
    const plan = planScratchSubmounts({ mountinfo, infraRoots: [canonical(opts.dataDir), VARTMP_ROOT], writable: [] });
    const incomplete = preparingAbandoned(sessionRoot)
      || [...recorded].some(mp => !mounted.has(join(merged, mp)))
      || [...plan.overlay, ...plan.readOnly].some(m => !recorded.has(m.mountpoint) && mounted.has(join(merged, m.mountpoint)));
    if (incomplete) {
      console.error(`[scratch-sandbox] session ${opts.sessionId}: its mounted view does not match its marker — re-mounting from the recorded layout`);
      unmountScratchStack(sessionRoot, merged);
    }
  }

  // ── bring the main overlay up (or adopt an existing one) ─────────────────
  const cwdCanonical = canonical(opts.chdir);
  const infraRoots = [canonical(opts.dataDir), VARTMP_ROOT];
  const writable = [cwdCanonical, canonical(opts.home)];
  const subMounts: { mountpoint: string; kind: 'overlay' | 'ro'; dir?: string }[] = [];
  let submountOverflow: ScratchSandboxSpawn['submountOverflow'];
  if (!isMountpoint(merged)) {
    // Before the first mount: lets the sweep tell this tree from residue, and a
    // later prepare tell residue from a tree still being built.
    // Nothing is mounted yet, and a recorded (disk) session's tree holds its
    // upper: refuse without fail()'s tree removal.
    try {
      atomicWriteFileSync(preparingRecord, JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) ?? '' }), { mode: 0o600, followTargetSymlink: false });
    } catch (err) {
      console.error(`[scratch-sandbox] session ${opts.sessionId}: cannot record the prepare in progress (${(err as Error)?.message ?? err}) — refusing to spawn`);
      return refuse({ reason: 'state-write-failed', detail: (err as Error)?.message ?? String(err) });
    }
    if (storage === 'tmpfs') {
      // A RECORDED tmpfs session whose slot is gone means the machine rebooted
      // and the in-RAM upper died with it. The meta is still on disk, but
      // mounting a brand-new empty slot would silently fabricate a fresh COW
      // view while keeping the old session identity — violating the documented
      // "unrecoverable, start a new session" contract. Refuse. (A genuinely
      // fresh session has existing === null and mounts normally; a recorded one
      // whose slot survives is re-mounted onto the same upper.)
      if (existing && !isMountpoint(slot!)) {
        console.error(`[scratch-sandbox] tmpfs upper for recorded session ${opts.sessionId} is gone (machine reboot wiped it) — refusing to fabricate a fresh COW view; start a new session`);
        return refuse({ reason: 'tmpfs-upper-lost' });
      }
      const slotFailure = mountSlot(slot!, opts.tmpfsSizeMb);
      if (slotFailure) return refuse(slotFailure);
    }
    // disk: a cold resume normally arrives here (overlay unmounted at the last
    // process exit; upper/work persist on disk and are cleanly re-mounted).
    const mainOverlayFailure = mountOverlay({
      lower: '/', upper, work, merged,
      // disk upper under lower=/ fails the kernel overlapping-layer check on
      // hardened kernels; fuse-overlayfs serves it. tmpfs slot never overlaps.
      allowFuseFallback: storage === 'disk',
    });
    if (mainOverlayFailure) {
      if (!existing && storage === 'tmpfs' && slot && isMountpoint(slot)) unmountAny(slot);
      return fail('main-overlay', { reason: 'overlay-mount-failed', ...mainOverlayFailure });
    }
    rolledBack.push(merged);

    // ── recursive submount overlays (each host submount else renders EMPTY) ──
    const mountinfo = readMountinfo();
    const plan = planScratchSubmounts({ mountinfo, infraRoots, writable });
    if (plan.scratchTreeMounts > 0) {
      console.error(`[scratch-sandbox] session ${opts.sessionId}: skipped ${plan.scratchTreeMounts} mount(s) inside other scratch session trees (never re-overlaid)`);
    }
    if (plan.readOnly.length > 0) {
      const eligible = plan.overlay.length + plan.readOnly.length;
      submountOverflow = { eligible, readOnly: plan.readOnly.map(m => m.mountpoint) };
      console.error(`[scratch-sandbox] session ${opts.sessionId}: ${eligible} host submounts exceed the overlay limit ${SCRATCH_SUBMOUNT_OVERLAY_LIMIT} — `
        + `overlaying ${plan.overlay.length} (working dir / HOME first), exposing ${plan.readOnly.length} read-only: `
        + `${plan.readOnly.slice(0, 10).map(m => m.mountpoint).join(', ')}${plan.readOnly.length > 10 ? ', …' : ''}`);
    }
    let usedOnDisk: string[] = [];
    try { usedOnDisk = readdirSync(subroots); } catch { /* fresh */ }
    const subDirs = assignSubDirs({
      mountpoints: plan.overlay.map(m => m.mountpoint),
      recorded: existing?.subs ?? [],
      legacyOrder: () => planScratchSubmounts({
        mountinfo, infraRoots, writable, limit: Number.POSITIVE_INFINITY, isScratchTree: () => false,
      }).overlay.map(m => m.mountpoint),
      usedOnDisk,
    });
    plan.overlay.forEach((m) => {
      const dir = subDirs.get(m.mountpoint)!;
      const subDir = join(subroots, dir);
      const subMerged = join(subDir, 'merged');
      const subUpper = storage === 'tmpfs' ? join(slot!, `sub-${dir}-upper`) : join(subDir, 'upper');
      const subWork = storage === 'tmpfs' ? join(slot!, `sub-${dir}-work`) : join(subDir, 'work');
      const targetInMerged = join(merged, m.mountpoint);
      const ok = mountOverlay({ lower: m.mountpoint, upper: subUpper, work: subWork, merged: subMerged, allowFuseFallback: true }) === null;
      try { mkdirSync(targetInMerged, { recursive: true }); } catch { /* present from lower */ }
      if (ok && spawnSync('mount', ['--bind', subMerged, targetInMerged], { stdio: 'pipe' }).status === 0) {
        subMounts.push({ mountpoint: m.mountpoint, kind: 'overlay', dir });
        rolledBack.push(subMerged);
        rolledBack.push(targetInMerged);
        return;
      }
      if (ok) unmountAny(subMerged);
      // Un-overlayable submount → exposed read-only at the bwrap layer below.
      subMounts.push({ mountpoint: m.mountpoint, kind: 'ro' });
    });
    for (const m of plan.readOnly) subMounts.push({ mountpoint: m.mountpoint, kind: 'ro' });
  } else {
    // Adopting a live mount after a daemon restart: trust the recorded subs.
    if (!existing || existing.merged !== merged) {
      console.error(`[scratch-sandbox] ${merged} already mounted but meta missing/mismatch — refusing to spawn`);
      return refuse({ reason: 'stale-mount', detail: merged });
    }
    for (const s of existing.subs ?? []) subMounts.push({ mountpoint: s.mountpoint, dir: s.dir, kind: 'overlay' });
    // Any submount that appeared since may need the read-only fallback at least;
    // re-scan cheaply (host-side binds of recorded subs are skipped as mounted).
    const plan = planScratchSubmounts({ mountinfo: readMountinfo(), infraRoots, writable });
    for (const m of [...plan.overlay, ...plan.readOnly]) {
      if (subMounts.some(s => s.mountpoint === m.mountpoint)) continue;
      const target = join(merged, m.mountpoint);
      if (isMountpoint(target)) { subMounts.push({ mountpoint: m.mountpoint, kind: 'overlay' }); continue; }
      subMounts.push({ mountpoint: m.mountpoint, kind: 'ro' });
    }
  }

  // The working dir MUST be COW-writable through the merged view. Prove it with
  // a real write and a host-side zero-leak check; a read-only-fallback submount
  // under the cwd is a hard error (never bind the real project RW to host).
  const roFallbackPoints = subMounts.filter(s => s.kind === 'ro').map(s => s.mountpoint)
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (roFallbackPoints.some(p => p === cwdCanonical || isWithin(p, cwdCanonical))) {
    console.error(`[scratch-sandbox] working dir ${cwdCanonical} sits on a submount that cannot be overlaid (would be read-only) — refusing to spawn`);
    const roPoint = roFallbackPoints.filter(p => p === cwdCanonical || isWithin(p, cwdCanonical)).at(-1);
    return fail('cwd-on-ro-submount', { reason: 'cwd-on-ro-submount', ...(roPoint ? { detail: roPoint } : {}) });
  }
  const probeName = `.botmux-scratch-probe-${process.pid}-${Date.now()}`;
  const probeInMerged = join(merged, relative('/', cwdCanonical), probeName);
  const probeOnHost = join(cwdCanonical, probeName);
  try {
    mkdirSync(dirname(probeInMerged), { recursive: true });
    writeFileSync(probeInMerged, 'x');
    if (existsSync(probeOnHost)) {
      rmSync(probeInMerged, { force: true });
      console.error(`[scratch-sandbox] cwd COW probe leaked to the real host (${probeOnHost}) — refusing to spawn`);
      return fail('cwd-write-leaked-to-host', { reason: 'cwd-write-leaked' });
    }
    rmSync(probeInMerged, { force: true });
  } catch (err) {
    console.error(`[scratch-sandbox] working dir ${cwdCanonical} is not writable inside the COW view: ${(err as Error)?.message ?? err}`);
    return fail('cwd-cow-probe', { reason: 'cwd-not-writable', detail: (err as Error)?.message ?? String(err) });
  }

  const currentOverlaySubs = subMounts.filter(s => s.kind === 'overlay')
    .map(({ mountpoint, dir }) => (dir === undefined ? { mountpoint } : { mountpoint, dir }));
  const meta: ScratchMeta = existing
    // Re-mount (disk cold resume): keep identity/createdAt but refresh the
    // submount set — the machine may have gained/lost mounts since.
    ? { ...existing, subs: currentOverlaySubs, mappings: [{ from: '/', to: merged }] }
    : {
      v: 1,
      sid: opts.sessionId,
      storage,
      lower: '/',
      merged, upper, work, slot,
      subs: currentOverlaySubs,
      mappings: [{ from: '/', to: merged }],
      createdAt: Date.now(),
      tmpfsSizeMb: storage === 'tmpfs' ? opts.tmpfsSizeMb : undefined,
    };
  // Atomic (tmp + rename): a truncated marker would read as "not a scratch
  // session" to the scratch sweep while still being a scratch marker to the
  // generic sweep, so neither would ever reclaim the upper.
  // A fresh session without its marker would run on mounts that attach, the
  // sweeps and the next prepare cannot recognise: fail closed. A re-mount keeps
  // its previous (still valid) marker.
  try {
    atomicWriteFileSync(metaPath(sessionRoot), JSON.stringify(meta), { mode: 0o600, followTargetSymlink: false, durable: true });
  } catch (err) {
    if (!existing) return fail(`meta-write: ${(err as Error)?.message ?? err}`, { reason: 'state-write-failed', detail: (err as Error)?.message ?? String(err) });
    console.error(`[scratch-sandbox] session ${opts.sessionId}: could not refresh its marker (keeping the previous one): ${(err as Error)?.message ?? err}`);
  }
  rmSync(preparingRecord, { force: true });

  // ── shim + outbox (REAL host tree, passthrough-bound over the merged root) ──
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, botmuxShimExecLine());
  try { chmodSync(shim, 0o755); } catch { /* */ }
  // A wrapperCli running inside the sandbox may exec the CLI by name: alias
  // that name to the (already allowed) real CLI binary in this private dir.
  writeCliNameLink(shimBin, opts.cliNameLink);

  // Real-host passthrough carve-outs layered AFTER deny masks (later mount
  // wins). The outbox MUST stay host-real: the daemon watcher reads it without
  // any merged-tree awareness.
  const carveTargets = new Set<string>([outbox]);

  // ── bwrap argv ───────────────────────────────────────────────────────────
  const args: string[] = [];
  args.push('--unshare-user');
  if (!opts.skipPidNamespace) args.push('--unshare-pid');
  args.push('--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  if (opts.net === false) args.push('--unshare-net');
  args.push('--die-with-parent', '--new-session');
  // THE load-bearing bind: container root is the merged full-root COW tree.
  args.push('--bind', merged, '/');
  args.push('--proc', '/proc', '--dev', '/dev');
  args.push('--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp', '--tmpfs', '/dev/shm');
  // Point into the merged COW view, never bind the host cache writable.
  // Install before deny masks so denied descendants remain hidden via the alias.
  if (opts.tempDir && resolve(opts.tempDir) !== canonical(opts.tempDir)) {
    args.push('--dir', dirname(resolve(opts.tempDir)),
      '--symlink', canonical(opts.tempDir), resolve(opts.tempDir));
  }
  if (existsSync('/sys')) args.push('--ro-bind', '/sys', '/sys');
  // /var/tmp mask also hides the tmpfs upper slot from the container.

  // The fresh /tmp|/var/tmp|/run tmpfs mounts can SHADOW the working dir (a
  // project under /tmp is normal for tests/CI). Re-expose the cwd's MERGED
  // subtree (COW, not the host-real dir) before deny masks so a deny under the
  // cwd still wins.
  const FRESH_TMPFS_PREFIXES = ['/tmp', '/var/tmp', '/run', '/dev/shm'];
  const cwdShadowedBy = FRESH_TMPFS_PREFIXES.find(
    p => cwdCanonical === p || isWithin(p, cwdCanonical),
  );
  if (cwdShadowedBy) {
    const cwdInMerged = join(merged, relative('/', cwdCanonical));
    args.push('--bind', cwdInMerged, cwdCanonical);
  }

  // Un-overlayable submounts: read-only real bind (never read-write-through).
  for (const mp of roFallbackPoints) {
    if (existsSync(mp)) args.push('--ro-bind', mp, mp);
  }

  // ── deny masks over the merged view ──────────────────────────────────────
  // Empty mask SOURCES live in the real sessionRoot (out of the merged tree);
  // bwrap resolves bind sources in the host namespace. Mask TARGETS are
  // in-container paths. A deny dir that must HOST a nested carve-out (outbox
  // under a user-denied ancestor) uses --tmpfs + later --remount-ro, same
  // technique as compileToBwrap: a mode-000 ro source cannot host a child bind.
  const remountRo: string[] = [];
  let maskIdx = 0;
  const seen = new Set<string>();
  const denies: string[] = [];
  for (const raw of opts.denyPaths ?? []) {
    if (typeof raw !== 'string' || !raw) continue;
    let p: string;
    try { p = canonical(raw); } catch { continue; }
    if (!isAbsolute(p) || p === '/' || seen.has(p)) continue;
    seen.add(p);
    denies.push(p);
    const hostsCarve = [...carveTargets].some(t => isWithin(p, t));
    let isFile = false;
    try { isFile = statSync(p).isFile(); } catch { /* absent → dir mask */ }
    if (hostsCarve) {
      args.push('--tmpfs', p);
      remountRo.push(p);
      continue;
    }
    if (isFile) {
      const empty = join(empties, `mask-${maskIdx++}`);
      writeFileSync(empty, '', { mode: 0o000 });
      // Ensure a file target exists in the MERGED tree (copy-up) for bwrap to
      // bind onto; the host stays untouched.
      try { mkdirSync(dirname(join(merged, p)), { recursive: true }); writeFileSync(join(merged, p), ''); } catch { /* */ }
      args.push('--ro-bind', empty, p);
    } else {
      try { mkdirSync(join(merged, p), { recursive: true }); } catch { /* present from lower */ }
      args.push('--ro-bind', emptyDir, p);
    }
  }

  // ── internal binds: shim, trusted botmux command paths, MCP socket ────────
  args.push('--ro-bind', shimBin, '/run/sbxbin');
  let selfExec: string | undefined;
  try { selfExec = realpathSync(process.execPath); } catch { selfExec = undefined; }
  for (const rawTarget of [...new Set(opts.shimBindTargets ?? [])]) {
    if (typeof rawTarget !== 'string' || !isAbsolute(rawTarget)) continue;
    const target = resolve(rawTarget);
    try {
      if (!lstatSync(target).isFile()) continue;
      if (selfExec !== undefined && realpathSync(target) === selfExec) continue;
      args.push('--ro-bind', shim, target);
    } catch { /* missing/stale target */ }
  }
  let sandboxMcpSocket: string | undefined;
  if (opts.mcpGatewaySocketPath) {
    try {
      const socketPath = resolve(opts.mcpGatewaySocketPath);
      if (!lstatSync(socketPath).isSocket()) return fail('mcp-socket-not-socket', { reason: 'mcp-socket' });
      const hostDir = realpathSync(dirname(socketPath));
      const sandboxDir = '/run/botmux-mcp';
      args.push('--dir', sandboxDir, '--ro-bind', hostDir, sandboxDir);
      sandboxMcpSocket = join(sandboxDir, basename(socketPath));
      carveTargets.add(hostDir);
    } catch {
      return fail('mcp-socket-setup', { reason: 'mcp-socket' });
    }
  }
  // Read-only carve-outs under denied directories (this session's own
  // trigger-user identity files under the sealed cli-identity dir).
  //
  // bwrap cannot create a nested mountpoint under a read-only masked dir
  // ("Can't create file ... Read-only file system"), so for each denied
  // DIRECTORY that hosts ro-carve files we re-mount it as a fresh tmpfs (the
  // earlier empty-dir mask is overlaid, hiding all sibling files), bind the
  // individual read-only files into it, then remount the dir read-only.
  // (Same shape as the writable outbox carve, but the contents are ro.)
  const roCarveByDir = new Map<string, string[]>();
  for (const raw of opts.readOnlyCarvePaths ?? []) {
    const p = canonical(raw);
    if (!isAbsolute(p) || !existsSync(p)) continue;
    const dir = dirname(p);
    if (!roCarveByDir.has(dir)) roCarveByDir.set(dir, []);
    roCarveByDir.get(dir)!.push(p);
  }
  // Emit tmpfs for each masked parent dir that needs ro carves. These must
  // land AFTER the deny masks (later mount wins) — they do, this block runs
  // after the deny-mask loop above.
  for (const [dir, files] of roCarveByDir) {
    // Only when the dir itself (or an ancestor) is denied does the tmpfs
    // replacement make sense; otherwise a plain ro-bind works.
    const denied = denies.some(d => d === dir);
    if (denied) {
      args.push('--tmpfs', dir);
      remountRo.push(dir);
    }
    for (const f of files) {
      args.push('--ro-bind', f, f);
    }
  }

  // fnm/nvm/volta bin farms under /run get masked by the fresh /run tmpfs.
  args.push(...reexposeRunBinArgs([opts.cliBin, process.execPath]));
  // /etc/resolv.conf → /run/... (systemd-resolved) dangles under the fresh
  // /run tmpfs; re-expose that one file unless the operator denied it.
  args.push(...hostResolverBindArgs({ denied: path => denies.some(d => isWithin(d, path)) }));

  // Outbox real-host passthrough (daemon watcher reads THIS dir).
  args.push('--bind', outbox, outbox);
  // Re-seal the deny dirs that host a nested carve AFTER the carve binds.
  for (const p of remountRo) args.push('--remount-ro', p);

  // ── env (in-container paths are the NORMAL host paths — root is merged) ──
  const canonicalExecDirs: string[] = [];
  const pushExecDir = (p: string | undefined) => {
    if (!p) return;
    try {
      const d = dirname(realpathSync(p));
      if (isAbsolute(d) && !canonicalExecDirs.includes(d)) canonicalExecDirs.push(d);
    } catch { /* */ }
  };
  pushExecDir(process.execPath);
  pushExecDir(opts.cliBin);
  const env: Record<string, string> = {
    HOME: opts.home,
    SESSION_DATA_DIR: canonical(opts.dataDir),
    BOTMUX_SEND_RELAY: outbox,
    PATH: ['/run/sbxbin', ...canonicalExecDirs, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
  if (process.env.BOTMUX_DAEMON_IPC_PORT) env.BOTMUX_DAEMON_IPC_PORT = process.env.BOTMUX_DAEMON_IPC_PORT;
  if (sandboxMcpSocket) {
    env[MCP_GATEWAY_SOCKET_ENV] = sandboxMcpSocket;
    env[MCP_GATEWAY_REQUIRED_ENV] = '1';
  }
  for (const k of PROXY_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  for (const k of CA_BUNDLE_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  args.push('--unsetenv', 'BOTS_CONFIG');
  // Keep the child's CLI-home env at the NATIVE host path even when the worker
  // repointed its own copy at the merged tree (see childEnvForce).
  for (const [k, v] of Object.entries(opts.childEnvForce ?? {})) {
    if (typeof v === 'string' && v) args.push('--setenv', k, v);
    else args.push('--unsetenv', k);
  }
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--chdir', cwdCanonical);
  let execBin = opts.cliBin;
  try { execBin = realpathSync(opts.cliBin); } catch { /* keep lexical; fails closed */ }
  const command = [execBin, ...opts.cliArgs];
  let compactLaunch: ReturnType<typeof linuxIsolationLaunchViaArgsFile> | null = null;
  try {
    compactLaunch = opts.useBwrapArgsFile
      ? linuxIsolationLaunchViaArgsFile(bwrap, args, command, sessionRoot)
      : null;
  } catch (error) {
    teardownScratchSession(opts.sessionId, opts.dataDir);
    throw error;
  }
  if (!compactLaunch) args.push('--', ...command);

  const spawn: ScratchSandboxSpawn = {
    bin: compactLaunch?.bin ?? launch.bin,
    args: compactLaunch?.args ?? [...launch.args, ...args],
    ...(compactLaunch ? { argsFile: compactLaunch.argsFile } : {}),
    env,
    outbox,
    mergedHostPath: merged,
    ...(submountOverflow ? { submountOverflow } : {}),
    cleanup: () => {
      compactLaunch?.cleanup();
      teardownScratchSession(opts.sessionId, opts.dataDir);
    },
  };
  return { ok: true, spawn };
}

/** Re-attach the daemon side to a LIVE scratch pane after a daemon restart or
 *  a topic transfer: the mount lives in the host mount namespace and the
 *  pane's bwrap keeps its own namespace — never unmount/remount here. Returns
 *  the outbox + host-view root, or null when the session has no scratch tree or
 *  the outbox the pane bound by inode is gone (never recreated — see
 *  reattachableRelayOutbox). */
export function attachScratchSession(opts: { sessionId: string; dataDir: string }): {
  outbox: string;
  mergedHostPath: string;
  cleanup: () => void;
} | null {
  if (process.platform !== 'linux') return null;
  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  const meta = readMeta(sessionRoot);
  if (!meta) return null;
  const outbox = reattachableRelayOutbox(sessionRoot);
  if (!outbox) return null;
  return {
    outbox,
    mergedHostPath: meta.merged,
    cleanup: () => teardownScratchSession(opts.sessionId, opts.dataDir),
  };
}

/** Enumerate mount targets under `root` from mountinfo, deepest first. Used to
 *  peel sub-binds (submount overlays bound INTO the merged tree) before the
 *  main overlay can be unmounted — umount of the parent is EBUSY otherwise. */
function mountsUnder(root: string): string[] {
  let raw = '';
  try { raw = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const mp = decodeMountPath(line.slice(0, sep).split(' ')[4] ?? '');
    if (mp && mp !== root && isWithin(root, mp)) out.push(mp);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Unmount + remove a scratch session from DISK state alone (no live pane).
 *  Used by sweep and close-time cleanup. Idempotent. */
/** Take a session's overlay stack down (not its tmpfs slot); touches no file. */
function unmountScratchStack(sessionRoot: string, merged: string): void {
  // 1. binds into the merged tree (submount overlays), deepest first
  for (const mp of mountsUnder(merged)) unmountAny(mp);
  // 2. the sub-overlay merged dirs themselves
  try {
    for (const entry of readdirSync(join(sessionRoot, 'subroots'), { withFileTypes: true })) {
      if (entry.isDirectory()) unmountAny(join(sessionRoot, 'subroots', entry.name, 'merged'));
    }
  } catch { /* no subroots */ }
  // 3. main overlay
  unmountAny(merged);
}

export function teardownScratchSession(sessionId: string, dataDirInput: string): void {
  const dataDir = canonical(dataDirInput);
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  // Never pull a tree out from under the prepare still building it.
  if (preparingByOther(sessionRoot)) {
    console.error(`[scratch-sandbox] session ${sessionId}: not tearing down — another live process is preparing it`);
    return;
  }
  const meta = readMeta(sessionRoot);
  const merged = meta?.merged ?? join(sessionRoot, 'root');
  unmountScratchStack(sessionRoot, merged);
  if (meta?.slot) unmountAny(meta.slot);
  // 4. remove — but never THROUGH a mount that refused to go away (a recursive
  //    rm crosses filesystem boundaries; through the merged root that walks the
  //    whole host). Anything still mounted is left for the next teardown/sweep.
  removeTreeUnlessMounted(sessionRoot);
  if (meta?.slot) removeTreeUnlessMounted(meta.slot);
}

/** Whether a scratch session's overlay can be brought back for a COLD resume
 *  (new CLI process after the pane died, possibly post daemon restart).
 *  - disk: always remountable (upper on disk);
 *  - tmpfs: remountable while the tmpfs slot survives (same machine); after a
 *    reboot the slot is gone → unrecoverable. */
export function scratchSessionRecoverable(sessionId: string, dataDir: string): boolean {
  const sessionRoot = join(canonical(dataDir), 'sandboxes', sessionId);
  const meta = readMeta(sessionRoot);
  if (!meta) return false;
  if (meta.storage === 'disk') return true;
  return !!meta.slot && isMountpoint(meta.slot);
}

/**
 * Reclaim orphan scratch sessions: scratch trees (a scratch.json marker, or
 * mounts without one) whose session is not active and no live process
 * references. Unlike the
 * oncall sweep (plain rm), scratch must UNMOUNT the overlay, the submount binds
 * and the tmpfs slot first. Slot dirs under /var/tmp/botmux-scratch with no
 * matching session tree are also swept. Guards mirror the oncall sweep:
 * /proc cmdline detection, active set, mtime grace.
 *
 * A marker that no longer parses (truncated by a crash mid-write on an older
 * build) still marks a scratch tree: the generic sweep leaves it alone, so this
 * sweep must not skip it either. teardownScratchSession then works from the
 * default layout (`<tree>/root` + subroots) and still never removes through
 * anything that stays mounted.
 *
 * `slotRoot` exists for tests only: the slot pass is host-wide.
 */
export function sweepOrphanScratchSandboxes(
  dataDir: string,
  activeSessionIds: Set<string>,
  opts: { slotRoot?: string } = {},
): void {
  const slotRoot = opts.slotRoot ?? VARTMP_ROOT;
  const live = new Set<string>();
  let pids: string[];
  try { pids = readdirSync('/proc'); } catch { return; }
  const re = /(?:sandboxes|botmux-scratch)\/([^/\0]+)/g;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    // A fuse-overlayfs daemon names the tree's own mountpoint/upper in its argv
    // but only serves that mount: it exits once the teardown unmounts it, and
    // must not keep an orphan tree "live" forever.
    if (basename(cmd.split('\0', 1)[0] ?? '') === 'fuse-overlayfs') continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd))) live.add(m[1]);
  }

  const root = join(canonical(dataDir), 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; }
  const GRACE_MS = 60_000;
  const now = Date.now();
  // A prepare killed between its first mount and the marker write leaves a
  // tree with mounts but no marker. Only scratch mounts anything into a tree
  // (same rule as recordedSandboxTreeFlavour), and the generic sweep never
  // touches a mounted tree, so without this nothing would ever reclaim it.
  const mountedSids = new Set<string>();
  for (const mp of mountsUnder(root)) {
    const sid = relative(root, mp).split('/')[0];
    if (sid) mountedSids.add(sid);
  }
  for (const sid of sids) {
    const sessionRoot = join(root, sid);
    // No marker and nothing mounted → oncall/off session, the generic sweep's.
    // A marker that does not parse is still ours (see above).
    let marked = true;
    try { lstatSync(metaPath(sessionRoot)); } catch { marked = false; }
    if (!marked && !mountedSids.has(sid)) continue;
    if (live.has(sid) || activeSessionIds.has(sid)) continue;
    let ageOk = false;
    try { ageOk = now - statSync(sessionRoot).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    teardownScratchSession(sid, dataDir);
  }

  // /var/tmp slot orphans (tmpfs mounts whose session tree is already gone).
  let slots: string[] = [];
  try { slots = readdirSync(slotRoot); } catch { return; }
  for (const sid of slots) {
    if (live.has(sid) || activeSessionIds.has(sid)) continue;
    if (existsSync(join(root, sid))) continue; // tree still around → tree sweep owns it
    const slotDir = join(slotRoot, sid);
    let ageOk = false;
    try { ageOk = now - statSync(slotDir).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    unmountAny(slotDir);
    removeTreeUnlessMounted(slotDir); // never through a slot that stayed mounted
  }
}

/**
 * Map a HOST-side absolute path (what daemon/worker code would read in an
 * unsandboxed run) to the same file inside the overlay's host-side merged
 * tree (where the sandboxed CLI's writes actually land). The container mounts
 * merged at `/`, so `/x` ↔ `<merged>/x`.
 *
 * The input is realpath-canonicalised by the caller when it names an existing
 * file: the overlay lower is the real host (symlinks included), and copy-ups
 * land at the CANONICAL path — a lexical symlinked-HOME path resolved inside
 * the merged tree would miss them.
 */
export function scratchHostView(mergedHostPath: string, hostAbsPath: string): string {
  if (!isAbsolute(hostAbsPath)) {
    throw new Error(`scratchHostView expects an absolute path, got: ${hostAbsPath}`);
  }
  let canonicalPath: string;
  try { canonicalPath = realpathSync(hostAbsPath); } catch { canonicalPath = resolve(hostAbsPath); }
  return join(mergedHostPath, canonicalPath);
}

/** Back-compat alias used by the probe/early call sites. */
export const remapIntoMerged = scratchHostView;
