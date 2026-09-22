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
import { botmuxShimExecLine, reexposeRunBinArgs } from './sandbox.js';
import { linuxIsolationLaunch } from '../../core/linux-isolation.js';
import { PROXY_ENV_KEYS, CA_BUNDLE_ENV_KEYS } from '../../utils/child-env.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../../core/plugins/mcp/environment.js';

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
  /** Submounts wrapped with their own overlay (for restart-time teardown). */
  subs?: { mountpoint: string }[];
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
function ensureScratchDeps(needFuse: boolean): boolean {
  const missing: string[] = [];
  if (!hasCmd('bwrap')) missing.push('bubblewrap');
  if (needFuse && !hasCmd('fuse-overlayfs')) missing.push('fuse-overlayfs');
  if (!missing.length) return true;
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
    if (r.status === 0 && missing.every(m => hasCmd(m === 'bubblewrap' ? 'bwrap' : m))) return true;
  }
  const guide = pm ? `${isRoot ? '' : 'sudo '}${pm.join(' ')}` : `install: ${missing.join(', ')}`;
  console.error(`[scratch-sandbox] missing deps (${missing.join(', ')}); auto-install unavailable — ${guide}`);
  return false;
}

/** Mount an overlayfs. root → kernel `mount -t overlay`; otherwise (or when
 *  BOTMUX_SANDBOX_FUSE=1) → fuse-overlayfs. Returns true on success. When the
 *  kernel mount fails and allowFuseFallback is set, FUSE is tried (the
 *  userspace driver tolerates upper-under-lower for lower=/). */
function mountOverlay(opts: {
  lower: string;
  upper: string;
  work: string;
  merged: string;
  allowFuseFallback: boolean;
}): boolean {
  for (const d of [opts.upper, opts.work, opts.merged]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* */ }
  }
  const optStr = `lowerdir=${opts.lower},upperdir=${opts.upper},workdir=${opts.work}`;
  const forceFuse = process.env.BOTMUX_SANDBOX_FUSE === '1';
  if (!forceFuse && process.getuid?.() === 0) {
    const r = spawnSync('mount', ['-t', 'overlay', 'overlay', '-o', optStr, opts.merged], { stdio: 'pipe' });
    if (r.status === 0) return true;
    if (!opts.allowFuseFallback) {
      console.error(`[scratch-sandbox] kernel overlay mount failed: ${r.stderr?.toString().trim() || r.status}`);
      return false;
    }
  }
  const f = spawnSync('fuse-overlayfs', ['-o', optStr, opts.merged], { stdio: 'pipe' });
  if (f.status !== 0) {
    console.error(`[scratch-sandbox] overlay mount failed (kernel/fuse): ${f.stderr?.toString().trim() || f.status}`);
    return false;
  }
  return true;
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

interface HostMountEntry { mountpoint: string; fstype: string }

function decodeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Enumerate host mounts UNDER `/` that the full-root overlay would render
 *  EMPTY, shallow first so nested binds can be emitted parent-before-child. */
function readRelevantSubmounts(infraRoots: readonly string[]): HostMountEntry[] {
  let raw = '';
  try { raw = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const picked = new Map<string, HostMountEntry>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    const mountpoint = decodeMountPath(left[4] ?? '');
    const fstype = right[0] ?? '';
    if (!mountpoint.startsWith('/') || mountpoint === '/') continue;
    if (CONTAINER_OWNED_PREFIXES.some(p => mountpoint === p || isWithin(p, mountpoint))) continue;
    if (infraRoots.some(p => isWithin(p, mountpoint))) continue;
    const baseType = fstype.split('.')[0] ?? '';
    if (!SUBMOUNT_FSTYPES.has(fstype) && !SUBMOUNT_FSTYPES.has(baseType) && !fstype.startsWith('fuse.')) continue;
    if (!picked.has(mountpoint)) picked.set(mountpoint, { mountpoint, fstype });
  }
  return [...picked.values()].sort(
    (a, b) => a.mountpoint.split('/').length - b.mountpoint.split('/').length || a.mountpoint.localeCompare(b.mountpoint),
  );
}

// ───────────────────────── layout + meta ────────────────────────────────────

function metaPath(sessionRoot: string): string {
  return join(sessionRoot, 'scratch.json');
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
function mountSlot(slot: string, sizeMb?: number): boolean {
  try { mkdirSync(slot, { recursive: true }); } catch { /* */ }
  if (isMountpoint(slot)) return true; // already there (daemon restart)
  const sizeKb = sizeMb && sizeMb > 0 ? `,size=${Math.trunc(sizeMb * 1024)}k` : '';
  const args = sizeKb
    ? ['-t', 'tmpfs', '-o', `mode=700${sizeKb}`, 'tmpfs', slot]
    : ['-t', 'tmpfs', '-o', 'mode=700', 'tmpfs', slot];
  const r = spawnSync('mount', args, { stdio: 'pipe' });
  if (r.status === 0) return true;
  console.error(`[scratch-sandbox] tmpfs upper slot mount failed (non-root host? use scratchStorage "disk"): ${r.stderr?.toString().trim() || r.status}`);
  return false;
}

export interface PrepareScratchOpts {
  sessionId: string;
  dataDir: string;
  storage: ScratchStorage;
  /** tmpfs size cap in MB (tmpfs storage only). 0/undefined = kernel default. */
  tmpfsSizeMb?: number;
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

/**
 * Build the scratch-sandboxed spawn for a CLI session. Returns null ONLY when
 * the platform/deps/storage cannot serve it (the worker treats null as a hard
 * error — never a silent unsandboxed run).
 *
 * Re-entry semantics (same-session re-spawn, daemon-restart cold resume):
 *  - an already-mounted matching overlay (+submounts) is REUSED;
 *  - an unmounted disk session is REMOUNTED with its recorded upper/work;
 *  - a tmpfs session whose slot vanished (machine reboot) is unrecoverable:
 *    the caller must surface that, never fabricate a fresh upper (the CLI
 *    would "resume" against a state it never had).
 */
export function prepareScratchSandbox(opts: PrepareScratchOpts): ScratchSandboxSpawn | null {
  if (process.platform !== 'linux') return null;

  const storage: ScratchStorage = opts.storage === 'disk' ? 'disk' : 'tmpfs';
  const needFuse = process.env.BOTMUX_SANDBOX_FUSE === '1' || process.getuid?.() !== 0;
  if (!ensureScratchDeps(needFuse)) return null;

  const launch = linuxIsolationLaunch('bwrap', []);
  const { sessionRoot, merged, upper, work, slot, subroots } =
    scratchLayout(opts.sessionId, opts.dataDir, storage);
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
    return null;
  }

  const rolledBack: string[] = [];
  const fail = (where: string): null => {
    console.error(`[scratch-sandbox] setup failed at ${where} — aborting spawn (fail closed, never bare-run)`);
    if (!isMountpoint(merged)) try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
    return null;
  };

  // ── bring the main overlay up (or adopt an existing one) ─────────────────
  const subMounts: { mountpoint: string; kind: 'overlay' | 'ro' }[] = [];
  if (!isMountpoint(merged)) {
    if (storage === 'tmpfs') {
      // A RECORDED tmpfs session whose overlay/slot is gone means the machine
      // rebooted and the in-RAM upper died with it. The meta is still on disk,
      // but mounting a brand-new empty slot would silently fabricate a fresh
      // COW view while keeping the old session identity — violating the
      // documented "unrecoverable, start a new session" contract. Refuse.
      // (A genuinely fresh session has existing === null and mounts normally.)
      if (existing) {
        console.error(`[scratch-sandbox] tmpfs upper for recorded session ${opts.sessionId} is gone (machine reboot wiped it) — refusing to fabricate a fresh COW view; start a new session`);
        return null;
      }
      if (!mountSlot(slot!, opts.tmpfsSizeMb)) return null;
    }
    // disk: a cold resume normally arrives here (overlay unmounted at the last
    // process exit; upper/work persist on disk and are cleanly re-mounted).
    const mounted = mountOverlay({
      lower: '/', upper, work, merged,
      // disk upper under lower=/ fails the kernel overlapping-layer check on
      // hardened kernels; fuse-overlayfs serves it. tmpfs slot never overlaps.
      allowFuseFallback: storage === 'disk',
    });
    if (!mounted) {
      if (storage === 'tmpfs' && slot && isMountpoint(slot)) unmountAny(slot);
      return fail('main-overlay');
    }
    rolledBack.push(merged);

    // ── recursive submount overlays (each host submount else renders EMPTY) ──
    const candidates = readRelevantSubmounts([canonical(opts.dataDir), VARTMP_ROOT]);
    candidates.forEach((m, idx) => {
      const subDir = join(subroots, String(idx));
      const subMerged = join(subDir, 'merged');
      const subUpper = storage === 'tmpfs' ? join(slot!, `sub-${idx}-upper`) : join(subDir, 'upper');
      const subWork = storage === 'tmpfs' ? join(slot!, `sub-${idx}-work`) : join(subDir, 'work');
      const targetInMerged = join(merged, m.mountpoint);
      const ok = mountOverlay({ lower: m.mountpoint, upper: subUpper, work: subWork, merged: subMerged, allowFuseFallback: true });
      try { mkdirSync(targetInMerged, { recursive: true }); } catch { /* present from lower */ }
      if (ok && spawnSync('mount', ['--bind', subMerged, targetInMerged], { stdio: 'pipe' }).status === 0) {
        subMounts.push({ mountpoint: m.mountpoint, kind: 'overlay' });
        return;
      }
      if (ok) unmountAny(subMerged);
      // Un-overlayable submount → exposed read-only at the bwrap layer below.
      subMounts.push({ mountpoint: m.mountpoint, kind: 'ro' });
    });
  } else {
    // Adopting a live mount after a daemon restart: trust the recorded subs.
    if (!existing || existing.merged !== merged) {
      console.error(`[scratch-sandbox] ${merged} already mounted but meta missing/mismatch — refusing to spawn`);
      return null;
    }
    for (const s of existing.subs ?? []) subMounts.push({ ...s, kind: 'overlay' });
    // Any submount that appeared since may need the read-only fallback at least;
    // re-scan cheaply (host-side binds of recorded subs are skipped as mounted).
    for (const m of readRelevantSubmounts([canonical(opts.dataDir), VARTMP_ROOT])) {
      if (subMounts.some(s => s.mountpoint === m.mountpoint)) continue;
      const target = join(merged, m.mountpoint);
      if (isMountpoint(target)) { subMounts.push({ mountpoint: m.mountpoint, kind: 'overlay' }); continue; }
      subMounts.push({ mountpoint: m.mountpoint, kind: 'ro' });
    }
  }

  // The working dir MUST be COW-writable through the merged view. Prove it with
  // a real write and a host-side zero-leak check; a read-only-fallback submount
  // under the cwd is a hard error (never bind the real project RW to host).
  const cwdCanonical = canonical(opts.chdir);
  const roFallbackPoints = subMounts.filter(s => s.kind === 'ro').map(s => s.mountpoint);
  if (roFallbackPoints.some(p => p === cwdCanonical || isWithin(p, cwdCanonical))) {
    console.error(`[scratch-sandbox] working dir ${cwdCanonical} sits on a submount that cannot be overlaid (would be read-only) — refusing to spawn`);
    return fail('cwd-on-ro-submount');
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
      return fail('cwd-write-leaked-to-host');
    }
    rmSync(probeInMerged, { force: true });
  } catch (err) {
    console.error(`[scratch-sandbox] working dir ${cwdCanonical} is not writable inside the COW view: ${(err as Error)?.message ?? err}`);
    return fail('cwd-cow-probe');
  }

  const currentOverlaySubs = subMounts.filter(s => s.kind === 'overlay');
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
  try { writeFileSync(metaPath(sessionRoot), JSON.stringify(meta), { mode: 0o600 }); } catch { /* */ }

  // ── shim + outbox (REAL host tree, passthrough-bound over the merged root) ──
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, botmuxShimExecLine());
  try { chmodSync(shim, 0o755); } catch { /* */ }

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
      if (!lstatSync(socketPath).isSocket()) return fail('mcp-socket-not-socket');
      const hostDir = realpathSync(dirname(socketPath));
      const sandboxDir = '/run/botmux-mcp';
      args.push('--dir', sandboxDir, '--ro-bind', hostDir, sandboxDir);
      sandboxMcpSocket = join(sandboxDir, basename(socketPath));
      carveTargets.add(hostDir);
    } catch {
      return fail('mcp-socket-setup');
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
  args.push('--', execBin, ...opts.cliArgs);

  return {
    bin: launch.bin,
    args: [...launch.args, ...args],
    env,
    outbox,
    mergedHostPath: merged,
    cleanup: () => teardownScratchSession(opts.sessionId, opts.dataDir),
  };
}

/** Re-attach the daemon side to a LIVE scratch pane after a daemon restart:
 *  the mount lives in the host mount namespace and the pane's bwrap keeps its
 *  own namespace — never unmount/remount here. Returns the outbox + host-view
 *  root, or null when the session has no scratch tree. */
export function attachScratchSession(opts: { sessionId: string; dataDir: string }): {
  outbox: string;
  mergedHostPath: string;
  cleanup: () => void;
} | null {
  if (process.platform !== 'linux') return null;
  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  const meta = readMeta(sessionRoot);
  if (!meta) return null;
  const outbox = join(sessionRoot, 'outbox');
  try { mkdirSync(outbox, { recursive: true }); } catch { /* */ }
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
export function teardownScratchSession(sessionId: string, dataDirInput: string): void {
  const dataDir = canonical(dataDirInput);
  const sessionRoot = join(dataDir, 'sandboxes', sessionId);
  const meta = readMeta(sessionRoot);
  const merged = meta?.merged ?? join(sessionRoot, 'root');
  // 1. binds into the merged tree (submount overlays), deepest first
  for (const mp of mountsUnder(merged)) unmountAny(mp);
  // 2. the sub-overlay merged dirs themselves
  try {
    for (const entry of readdirSync(join(sessionRoot, 'subroots'), { withFileTypes: true })) {
      if (entry.isDirectory()) unmountAny(join(sessionRoot, 'subroots', entry.name, 'merged'));
    }
  } catch { /* no subroots */ }
  // 3. main overlay + tmpfs slot
  unmountAny(merged);
  if (meta?.slot) unmountAny(meta.slot);
  try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
  if (meta?.slot) {
    try { rmSync(meta.slot, { recursive: true, force: true }); } catch { /* */ }
  }
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
 * Reclaim orphan scratch sessions: scratch trees WITH a scratch.json whose
 * session is not active and no live process references. Unlike the oncall
 * sweep (plain rm), scratch must UNMOUNT the overlay, the submount binds and
 * the tmpfs slot first. Slot dirs under /var/tmp/botmux-scratch with no
 * matching session tree are also swept. Guards mirror the oncall sweep:
 * /proc cmdline detection, active set, mtime grace.
 */
export function sweepOrphanScratchSandboxes(dataDir: string, activeSessionIds: Set<string>): void {
  const live = new Set<string>();
  let pids: string[];
  try { pids = readdirSync('/proc'); } catch { return; }
  const re = /(?:sandboxes|botmux-scratch)\/([^/\0]+)/g;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd))) live.add(m[1]);
  }

  const root = join(canonical(dataDir), 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; }
  const GRACE_MS = 60_000;
  const now = Date.now();
  for (const sid of sids) {
    const sessionRoot = join(root, sid);
    if (!readMeta(sessionRoot)) continue; // oncall/off session — other sweep
    if (live.has(sid) || activeSessionIds.has(sid)) continue;
    let ageOk = false;
    try { ageOk = now - statSync(sessionRoot).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    teardownScratchSession(sid, dataDir);
  }

  // /var/tmp slot orphans (tmpfs mounts whose session tree is already gone).
  let slots: string[] = [];
  try { slots = readdirSync(VARTMP_ROOT); } catch { return; }
  for (const sid of slots) {
    if (live.has(sid) || activeSessionIds.has(sid)) continue;
    if (existsSync(join(root, sid))) continue; // tree still around → tree sweep owns it
    const slotDir = join(VARTMP_ROOT, sid);
    let ageOk = false;
    try { ageOk = now - statSync(slotDir).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    unmountAny(slotDir);
    try { rmSync(slotDir, { recursive: true, force: true }); } catch { /* */ }
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
