/**
 * File-isolation sandbox (bubblewrap + overlayfs) for oncall bots.
 *
 * Model (OVERLAYFS read-all / write-isolated, per product decision 2026-06-10):
 * the sandboxed agent READS the entire real filesystem natively — the real CLI
 * config/auth/env/project, NO scrub, the CLI just works. WRITES are isolated via
 * an overlayfs mount: the real lower layer is NEVER modified, only changed files
 * copy-up into a per-session UPPER layer (zero-copy reads, only the delta uses
 * disk, NO git clone). Landing copies that UPPER changeset back to the real
 * project. Privacy masking is per-bot opt-in with NO defaults.
 *
 * Mechanism (empirically verified — runs as root on this 5.15 kernel):
 *   mount -t overlay overlay -o lowerdir=REAL,upperdir=UPPER,workdir=WORK MERGED
 * bwrap 0.8.0 has NO --overlay, so we mount the overlay ON THE HOST then bind the
 * merged dir into bwrap. overlayfs forbids upper/work INSIDE lower, so the HOME
 * overlay (lower=/root) puts upper/work OUTSIDE /root (under /var/tmp/...). The
 * PROJECT overlay upper/work under <dataDir>/sandboxes/<sessionId>/ is fine.
 *
 * Linux-only (overlayfs + bwrap depend on Linux). macOS reuses Anthropic's
 * sandbox-exec approach and is handled elsewhere.
 */
import { homedir } from 'node:os';
import { mkdirSync, existsSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, statSync, openSync, fstatSync, readSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

/** Host root for the HOME overlay's upper/work — MUST be OUTSIDE the home lower
 *  (overlayfs forbids upper/work inside lower). */
const VARTMP_ROOT = '/var/tmp/botmux-sbx';

// ───────────────────────────── overlay primitives ────────────────────────────

/**
 * Mount an overlayfs: reads fall through to `lower` (real, zero copy); writes
 * copy-up into `upper` (the landable changeset). `work` is overlayfs scratch on
 * the same fs as `upper`. Returns true iff `mount` exited 0.
 */
export function mountOverlay(opts: { lower: string; upper: string; work: string; merged: string }): boolean {
  for (const d of [opts.upper, opts.work, opts.merged]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* */ }
  }
  const optStr = `lowerdir=${opts.lower},upperdir=${opts.upper},workdir=${opts.work}`;
  // A privileged (root) daemon uses the kernel overlayfs driver — fastest. A
  // non-root daemon CANNOT mount kernel overlayfs even inside bwrap's userns (the
  // hardened mount env rejects it on this kernel), so it falls back to
  // fuse-overlayfs — a userspace overlay needing no root, only /dev/fuse. Same
  // lowerdir/upperdir/workdir semantics → landing, the bridge redirect, and the
  // privacy masks all work identically; only the mount mechanism differs.
  // BOTMUX_SANDBOX_FUSE=1 forces the userspace path even as root (escape hatch +
  // lets a root daemon exercise exactly what unprivileged users hit).
  const forceFuse = process.env.BOTMUX_SANDBOX_FUSE === '1';
  if (!forceFuse && process.getuid?.() === 0) {
    const r = spawnSync('mount', ['-t', 'overlay', 'overlay', '-o', optStr, opts.merged], { stdio: 'pipe' });
    if (r.status === 0) return true;
    // root but kernel mount failed (rare) → fall through to fuse-overlayfs
  }
  const f = spawnSync('fuse-overlayfs', ['-o', optStr, opts.merged], { stdio: 'pipe' });
  return f.status === 0;
}

/** True iff `path` is currently a mountpoint (host-side overlay still mounted). */
export function isMounted(path: string): boolean {
  return spawnSync('mountpoint', ['-q', path], { stdio: 'ignore' }).status === 0;
}

/** Unmount an overlay merged dir. Best-effort: lazy-umount (`-l`) if a normal
 *  umount fails (busy fd from a still-draining child). No-op if not a mount. */
export function unmountOverlay(merged: string): void {
  if (!isMounted(merged)) return; // not a mountpoint
  // kernel overlay → `umount`; fuse-overlayfs → `fusermount -u` (a non-root
  // daemon can't `umount` its own fuse mount); lazy `-l` as a last resort for a
  // busy fd from a still-draining child.
  if (spawnSync('umount', [merged], { stdio: 'ignore' }).status === 0) return;
  if (spawnSync('fusermount', ['-u', merged], { stdio: 'ignore' }).status === 0) return;
  spawnSync('umount', ['-l', merged], { stdio: 'ignore' });
}

/** Verify (and best-effort auto-install) the sandbox runtime deps so the user
 *  needn't pre-install: `bubblewrap` always, `fuse-overlayfs` when the userspace
 *  overlay path is used (non-root daemon, or BOTMUX_SANDBOX_FUSE=1). Installs via
 *  the system package manager when the daemon can (root, or passwordless sudo);
 *  otherwise logs a one-line manual-install hint and returns false so the caller
 *  fails the spawn (never a silent unsandboxed run). Returns true if all present. */
function ensureSandboxDeps(needFuse: boolean): boolean {
  const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  const missing: string[] = [];
  if (!has('bwrap')) missing.push('bubblewrap');
  if (needFuse && !has('fuse-overlayfs')) missing.push('fuse-overlayfs');
  if (!missing.length) return true;

  const pm =
    has('apt-get') ? ['apt-get', 'install', '-y', ...missing] :
    has('dnf')     ? ['dnf', 'install', '-y', ...missing] :
    has('yum')     ? ['yum', 'install', '-y', ...missing] :
    has('apk')     ? ['apk', 'add', ...missing] :
    has('pacman')  ? ['pacman', '-S', '--noconfirm', ...missing] :
    null;
  const isRoot = process.getuid?.() === 0;
  if (pm) {
    // root installs directly; a non-root daemon tries passwordless sudo only
    // (never blocks on an interactive prompt).
    const argv = isRoot ? pm : ['sudo', '-n', ...pm];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 180_000 });
    if (r.status === 0 && !missing.some(m => !has(m === 'bubblewrap' ? 'bwrap' : m))) return true;
  }
  const guide = pm ? `${isRoot ? '' : 'sudo '}${pm.join(' ')}` : `install: ${missing.join(', ')}`;
  console.error(`[sandbox] missing deps (${missing.join(', ')}); auto-install unavailable — install manually then retry: ${guide}`);
  return false;
}

// ───────────────────────────── argv builder ──────────────────────────────────

export interface SandboxPlan {
  /** In-sandbox path the project is bound at — equals the original workingDir the
   *  CLI was given, so the CLI's existing path args resolve. Also the child's chdir. */
  projectMount: string;
  /** Host path of the merged project overlay (reads=real lower, writes=upper). */
  projectMerged: string;
  /** In-sandbox path the home overlay is bound at — equals the real home path so
   *  every CLI's hardcoded `~/.<cli>` resolves there. */
  home: string;
  /** Host path of the merged home overlay. */
  homeMerged: string;
  /** Daemon-mediated `botmux send` outbox — bound LAST so it wins over any mask. */
  outbox: string;
  /** Per-bot privacy masks: directories blanked with an empty tmpfs. */
  hideDirs: string[];
  /** Per-bot privacy masks: files blanked with a read-only empty placeholder. */
  hideFiles: { path: string; empty: string }[];
  /** CLI auth/login paths kept REAL + writable (bound rw over the isolated home so
   *  the CLI's token refresh / login persists — unlike project edits which are
   *  isolated). Resolved + existence-filtered by prepareSandbox. */
  authReal?: string[];
  /** Keep network egress. File-only scope ⇒ default true (npm/pip/git work). */
  net?: boolean;
}

/**
 * Build the bwrap argv prefix. Final spawn becomes:
 *   bwrap <these args> -- <cliBin> <cliArgs...>
 *
 * Mount order matters (later mounts win): the whole real fs read-only first, then
 * the home + project merged overlays bind over it (so writes there are isolated),
 * then privacy masks blank specific paths, then the outbox binds LAST so it stays
 * writable even if a mask covers a parent dir.
 */
export function buildSandboxArgs(plan: SandboxPlan): string[] {
  const a: string[] = [];
  // Read the entire real fs (zero scrub — the CLI's config/auth/env just work).
  a.push('--ro-bind', '/', '/');
  // Fresh kernel/runtime dirs (the ro-bind of / would otherwise carry host /tmp etc.).
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/dev/shm');
  // Write-isolated home + project (overlay merged: reads=real lower, writes=upper).
  a.push('--bind', plan.homeMerged, plan.home);
  a.push('--bind', plan.projectMerged, plan.projectMount);
  // CLI auth/login dirs kept REAL + writable (bind over the isolated home) so token
  // refresh / login persists. Narrow (auth only) → session history stays isolated.
  for (const p of plan.authReal ?? []) a.push('--bind', p, p);
  // Per-bot privacy masks (opt-in, no defaults).
  for (const dir of plan.hideDirs) a.push('--tmpfs', dir);
  for (const f of plan.hideFiles) a.push('--ro-bind', f.empty, f.path);
  // Outbox LAST so it wins even if a mask covers a parent dir.
  a.push('--bind', plan.outbox, plan.outbox);
  // Isolate namespaces (keep net unless explicitly disabled).
  a.push('--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  if (plan.net === false) a.push('--unshare-net');
  a.push('--die-with-parent', '--new-session', '--chdir', plan.projectMount);
  return a;
}

// ───────────────────────────── orchestration ─────────────────────────────────

/** Absolute path to this build's compiled cli.js (dist/cli.js), derived from
 *  this module's own location (dist/adapters/backend/sandbox.js → ../../cli.js). */
function distCliJs(): string {
  return fileURLToPath(new URL('../../cli.js', import.meta.url));
}

/** Is file-sandbox enabled for this session? Spike gate = env; the real
 *  per-bot BotConfig.sandbox flag is decided by the caller. */
export function sandboxEnabled(): boolean {
  return process.env.BOTMUX_SANDBOX === '1';
}

export interface SandboxSpawn {
  /** Replace the CLI binary with this (always 'bwrap'). */
  bin: string;
  /** bwrap args + '--' + original (bin, ...args). */
  args: string[];
  /** Env overrides to merge into childEnv (HOME, PATH, BOTMUX_SEND_RELAY, proxies). */
  env: Record<string, string>;
  /** Outbox dir the daemon watcher must service. */
  outbox: string;
  /** Project overlay UPPER dir — THE LANDABLE CHANGESET (used by sandbox-land). */
  workDir: string;
  /** HOME overlay UPPER dir (/var/tmp/botmux-sbx/<sid>/home-upper). The sandboxed
   *  CLI's $HOME writes — INCLUDING its session jsonl under CLAUDE_CONFIG_DIR —
   *  land here (invisible at the real path). The worker redirects its bridge/idle
   *  watch into this via sandboxedClaudeDataDir() so it sees the CLI's turns. */
  homeUpper: string;
  /** Unmount the overlays + remove the per-session sandbox tree. */
  cleanup: () => void;
}

/** The path where a sandboxed session's CLI actually writes a $HOME-relative
 *  data dir (e.g. CLAUDE_CONFIG_DIR / `.claude-runtime`): the HOME overlay's
 *  ephemeral UPPER copy. The worker redirects its jsonl/bridge watch here so it
 *  sees the sandboxed CLI's writes (which are invisible at the real host path).
 *  Mirrors prepareSandbox's homeUpper layout — keep in sync. */
export function sandboxedClaudeDataDir(sessionId: string, realDataDir: string): string {
  return join(VARTMP_ROOT, sessionId, 'home-upper', relative(homedir(), realDataDir));
}

/** Proxy env vars forwarded into the sandbox so the CLI reaches the API even on
 *  the tmux backend (which otherwise only forwards a fixed whitelist). */
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY'] as const;

/**
 * Build the sandboxed spawn for a CLI session, or return null when sandboxing
 * is off / unsupported / a required overlay mount fails (fail-safe = the worker
 * treats null as a hard error and does NOT silently run unsandboxed).
 *
 * Layout under <dataDir>/sandboxes/<sessionId>/: outbox, shimbin, proj-upper
 * (the landable changeset), proj-work, proj-merged, home-merged. The HOME
 * overlay's upper/work live under /var/tmp/botmux-sbx/<sessionId>/ because
 * overlayfs forbids upper/work inside the lower (= the real home).
 */
export function prepareSandbox(opts: {
  /** Whether the sandbox is on for THIS session (per-bot BotConfig.sandbox OR
   *  the BOTMUX_SANDBOX env force). Decided by the caller — prepareSandbox does
   *  NOT re-read the env, so the dashboard per-bot toggle actually takes effect. */
  enabled: boolean;
  cliId: string;
  sessionId: string;
  sourceWorkingDir: string;
  dataDir: string;
  cliBin: string;
  cliArgs: string[];
  /** Per-bot privacy masks (opt-in, no defaults). Paths existing as dirs are
   *  blanked with a tmpfs; files with an empty read-only placeholder. */
  hidePaths?: string[];
  /** This CLI's auth/login paths (CliAdapter.authPaths) to keep real+writable so
   *  token refresh / login persists. `~` expanded; missing paths skipped. */
  authPaths?: readonly string[];
}): SandboxSpawn | null {
  if (!opts.enabled) return null;
  if (process.platform !== 'linux') return null; // overlayfs + bwrap are Linux-only

  // Auto-provision deps so the user needn't pre-install (bwrap; + fuse-overlayfs
  // for the rootless/userspace overlay path). Fail the spawn if unavailable.
  const needFuse = process.env.BOTMUX_SANDBOX_FUSE === '1' || process.getuid?.() !== 0;
  if (!ensureSandboxDeps(needFuse)) return null;

  const sessionRoot = join(opts.dataDir, 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const empties = join(sessionRoot, 'empties');
  const projUpper = join(sessionRoot, 'proj-upper');   // THE LANDABLE CHANGESET
  const projWork = join(sessionRoot, 'proj-work');
  const projMerged = join(sessionRoot, 'proj-merged');
  const homeMerged = join(sessionRoot, 'home-merged');  // merged may live under sessionRoot
  // HOME overlay upper/work MUST be OUTSIDE the home lower (overlayfs constraint).
  const vartmp = join(VARTMP_ROOT, opts.sessionId);
  const homeUpper = join(vartmp, 'home-upper');
  const homeWork = join(vartmp, 'home-work');
  for (const d of [outbox, shimBin, empties]) mkdirSync(d, { recursive: true });

  const home = homedir();
  // BOTMUX_SANDBOX_SRC overrides the LOWER project source for spike testing only.
  const projectSource = process.env.BOTMUX_SANDBOX_SRC || opts.sourceWorkingDir;
  const projectMount = opts.sourceWorkingDir;

  // A same-session re-spawn (e.g. in-pane /clear) re-enters here; unmount any
  // stale merged overlays first so we don't stack a second mount on the same dir.
  unmountOverlay(projMerged);
  unmountOverlay(homeMerged);

  // Mount the HOME overlay (lower=real home → reads pass through, writes isolate).
  const homeOk = mountOverlay({ lower: home, upper: homeUpper, work: homeWork, merged: homeMerged });
  if (!homeOk) {
    return null; // fail-safe: no silent unsandboxed run
  }
  // Mount the PROJECT overlay. proj-upper = the landable changeset.
  const projOk = mountOverlay({ lower: projectSource, upper: projUpper, work: projWork, merged: projMerged });
  if (!projOk) {
    unmountOverlay(homeMerged);
    return null; // fail-safe
  }

  // Record the project LOWER source so landing can tell a wholesale-REPLACED dir
  // (existed in the lower at create time) from a purely-NEW dir (overlayfs marks
  // BOTH opaque, so the lower is the only reliable discriminator — and the live
  // landing target may have drifted, so we must check the lower-at-create, not it).
  try { writeFileSync(join(sessionRoot, 'meta.json'), JSON.stringify({ projectLower: projectSource })); } catch { /* */ }

  // `botmux` shim → THIS build's cli.js (readable natively via --ro-bind / /), so
  // in-sandbox `botmux send` hits relay mode (and never the host bots.json).
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(distCliJs())} "$@"\n`);
  chmodSync(shim, 0o755);

  // Per-bot privacy masks: existing dirs → tmpfs blank; everything else → empty
  // read-only placeholder file. No defaults (caller passes hidePaths explicitly).
  const hideDirs: string[] = [];
  const hideFiles: { path: string; empty: string }[] = [];
  let emptyIdx = 0;
  for (const p of opts.hidePaths ?? []) {
    if (!p || typeof p !== 'string') continue;
    let isDir = false;
    try { isDir = existsSync(p) && statSync(p).isDirectory(); } catch { /* */ }
    if (isDir) {
      hideDirs.push(p);
    } else {
      const empty = join(empties, `mask-${emptyIdx++}`);
      try { writeFileSync(empty, ''); } catch { /* */ }
      hideFiles.push({ path: p, empty });
    }
  }

  // CLI auth/login paths kept real+writable (token refresh / login must persist,
  // unlike isolated project edits). Resolve `~` and bind only existing paths — a
  // missing auth file isn't a valid mountpoint (the CLI must be logged in on the
  // host; login-from-scratch inside the sandbox isn't supported).
  const authReal: string[] = [];
  for (const raw of opts.authPaths ?? []) {
    if (!raw || typeof raw !== 'string') continue;
    const p = raw.replace(/^~(?=\/|$)/, home);
    try { if (existsSync(p)) authReal.push(p); } catch { /* */ }
  }

  const plan: SandboxPlan = {
    projectMount,
    projectMerged: projMerged,
    home,
    homeMerged,
    outbox,
    hideDirs,
    hideFiles,
    authReal,
    net: true,
  };
  const args = buildSandboxArgs(plan);
  // Shim bin at a fixed path UNDER the /run tmpfs — the whole real fs is bound
  // read-only (`--ro-bind / /`), so bwrap can't mkdir a new mountpoint at the
  // root (/sbxbin) → it must live under a writable tmpfs (/run). PATH points here.
  args.push('--ro-bind', shimBin, '/run/sbxbin');
  // botmux skill/plugin dir (claude `--plugin-dir` points here; carries the
  // botmux-send etc. skills, no secrets). Re-exposed read-only at its real path.
  const pluginDir = join(home, '.botmux', 'claude-plugin');
  args.push('--ro-bind-try', pluginDir, pluginDir);

  // Authoritative child env via bwrap --setenv (works on pty AND tmux — the tmux
  // backend only forwards a fixed whitelist, which excludes HOME/PATH/relay).
  const env: Record<string, string> = {
    HOME: home,                                      // home overlay is bound AT the real home path
    BOTMUX_SEND_RELAY: outbox,                       // routes `botmux send` to the daemon outbox watcher
    PATH: `/run/sbxbin:${process.env.PATH ?? ''}`,   // /run/sbxbin first so `botmux` = the relay shim
  };
  // Forward proxy vars so the CLI reaches the API on the tmux backend too.
  for (const k of PROXY_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--', opts.cliBin, ...opts.cliArgs);

  return {
    bin: 'bwrap',
    args,
    env,
    outbox,
    workDir: projUpper,
    homeUpper,
    cleanup: () => {
      unmountOverlay(projMerged);
      unmountOverlay(homeMerged);
      try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(vartmp, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/**
 * Re-attach the daemon/worker side to an ALREADY-spawned sandbox session WITHOUT
 * touching the overlays. Used on daemon-restart reattach to a persistent
 * (tmux/herdr/zellij) pane whose bwrap'd CLI is still alive: the CLI is bound to
 * its own namespace-pinned overlay, so we must NOT unmount/remount (that would
 * leave a duplicate host-side mount the CLI isn't using). We only need the outbox
 * path back so the watcher can keep servicing the live CLI's `botmux send`, plus
 * the workDir (upper changeset for landing) and a cleanup that tears the residue
 * down at close/exit. Returns null if the session has no sandbox tree on disk
 * (never sandboxed). Linux-only, mirrors prepareSandbox's layout.
 */
export function attachSandboxOutbox(opts: { sessionId: string; dataDir: string }): { outbox: string; workDir: string; cleanup: () => void } | null {
  if (process.platform !== 'linux') return null;
  const sessionRoot = join(opts.dataDir, 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const projUpper = join(sessionRoot, 'proj-upper');
  if (!existsSync(outbox) && !existsSync(projUpper)) return null; // never sandboxed
  // Ensure the outbox exists (the watcher reads it); never (re)mount here.
  try { mkdirSync(outbox, { recursive: true }); } catch { /* */ }
  const projMerged = join(sessionRoot, 'proj-merged');
  const homeMerged = join(sessionRoot, 'home-merged');
  const vartmp = join(VARTMP_ROOT, opts.sessionId);
  return {
    outbox,
    workDir: projUpper,
    cleanup: () => {
      unmountOverlay(projMerged);
      unmountOverlay(homeMerged);
      try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(vartmp, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/** Reclaim one session's overlay residue: unmount both merged overlays + rm the
 *  per-session tree (incl. the /var/tmp home scratch). Idempotent / best-effort. */
function reclaimSandbox(dataDir: string, sid: string): void {
  const sessionRoot = join(dataDir, 'sandboxes', sid);
  unmountOverlay(join(sessionRoot, 'proj-merged'));
  unmountOverlay(join(sessionRoot, 'home-merged'));
  try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(join(VARTMP_ROOT, sid), { recursive: true, force: true }); } catch { /* */ }
}

/** Scan the process table for sandbox session-ids referenced by any running
 *  process's argv. A live bwrap's bind/overlay paths contain `sandboxes/<sid>`
 *  and `botmux-sbx/<sid>`, so this physically detects which sandbox dirs are
 *  still in use — by overlay sessions AND old clone-model sessions alike. Used as
 *  a hard guard so the sweep never deletes a dir out from under a live CLI. */
function liveSandboxSids(): Set<string> {
  const live = new Set<string>();
  let pids: string[];
  try { pids = readdirSync('/proc'); } catch { return live; }
  const re = /(?:sandboxes|botmux-sbx)\/([^/\0]+)/g;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; } // gone/perms
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd))) live.add(m[1]);
  }
  return live;
}

/**
 * Reclaim leaked sandbox residue.
 *
 * Two classes of leak are reclaimed:
 *  1. NON-ACTIVE orphans — sid not in `activeSessionIds`: the session is gone, so
 *     any leftover mount/dir is pure residue (the original startup-sweep case,
 *     guarding against a daemon crash/kill that skipped killCli()).
 *  2. ACTIVE-but-DEAD — sid IS in `activeSessionIds`, yet NEITHER of its merged
 *     overlays is still mounted. This closes the blind spot where a sandboxed
 *     worker was SIGKILL'd (straggler reaper) or crashed: the session stays
 *     status='active' on disk, so the old "skip if active" rule would let the
 *     leaked upper/work dirs survive across restarts indefinitely. We only GC an
 *     active sid when its mounts are ALREADY gone — we NEVER tear down a live
 *     mount (a CLI persisting in a tmux/herdr/zellij pane is still bound to it),
 *     so a genuinely-live persistent session keeps its changeset.
 *
 * Safe to call repeatedly: wire once at daemon bootstrap AND on a periodic timer
 * (the SIGKILL/straggler path can't run worker-side killCli(), so a startup-only
 * sweep would let a crashed-active session's mount survive for the whole next
 * daemon lifetime — one daemon per bot can run for days).
 */
export function sweepOrphanSandboxes(dataDir: string, activeSessionIds: Set<string>): void {
  const root = join(dataDir, 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; } // no sandboxes dir yet
  // Grace before reclaiming an ACTIVE-but-unmounted sandbox: a worker that just
  // (re)spawned creates the outbox/shimbin dirs a few syscalls BEFORE it mounts
  // the overlay. Without this, a sweep firing in that tiny window would nuke an
  // in-progress session's outbox. Non-active orphans are reclaimed immediately
  // (no live worker can be mid-spawn for a session that isn't active).
  const ACTIVE_DEAD_GRACE_MS = 60_000;
  const now = Date.now();
  // Hard physical guard: NEVER reclaim a session whose dir is referenced by a
  // live process. A running bwrap binds/overlays paths containing the sid, so a
  // process-table scan catches BOTH overlay sessions (merged mounts) AND old
  // clone-model sessions re-attached after a daemon restart (which have NO
  // overlay mount, so the isMounted check below would wrongly deem them dead and
  // delete their bind-source dirs out from under the live CLI). This is the root
  // cause of the 2026-06-10 incident — keep it as the FIRST gate.
  const live = liveSandboxSids();
  for (const sid of sids) {
    const sessionRoot = join(root, sid);
    if (live.has(sid)) continue; // a running process holds this sandbox — leave it
    if (activeSessionIds.has(sid)) {
      // Active session: keep it while a host-side overlay is still mounted (= a
      // live CLI may be bound to the changeset). If BOTH merged overlays are gone
      // AND the tree is older than the spawn grace, the worker/CLI is dead →
      // reclaim the dead residue. We NEVER tear down a live mount, so a genuinely
      // live persistent (tmux/herdr/zellij) session keeps its changeset.
      if (isMounted(join(sessionRoot, 'proj-merged')) || isMounted(join(sessionRoot, 'home-merged'))) continue;
      let ageOk = false;
      try { ageOk = now - statSync(sessionRoot).mtimeMs > ACTIVE_DEAD_GRACE_MS; } catch { ageOk = false; }
      if (!ageOk) continue; // too fresh — could be a worker mid-spawn
    }
    reclaimSandbox(dataDir, sid);
  }
}

// Relay request schema (written by cli.ts relaySend, validated here). The
// watcher NEVER executes sandbox-supplied argv — it rebuilds the command from
// these validated fields. This is the security boundary: a malicious agent can
// write any outbox file, so everything here is treated as untrusted.
//   { contentFile: <basename in outbox>, attachments: [<basename>...], flags: [...] }
export interface RelayRequest {
  contentFile?: unknown;
  attachments?: unknown;
  flags?: unknown;
}
// Presentation-only flags the sandbox may pass through. Path-bearing flags
// (--content-file/--file(s)/--image(s)), routing flags (--chat-id/--into/
// --top-level), and --session-id are NOT allowlisted: content/attachments come
// from validated outbox files, and session-id is forced by the worker.
const RELAY_FLAGS_NOVAL = new Set(['--mention-back', '--no-mention', '--no-quote', '--voice']);
const RELAY_FLAGS_VAL = new Set(['--mention', '--quote']);

export interface ValidatedRelay { contentName: string; attachmentNames: string[]; flags: string[]; }

/**
 * PURE validation of an outbox relay request (schema + flag allowlist only — no
 * filesystem access, so it's deterministically testable):
 *  - contentFile/attachments must be plain basenames (no `/`, `\`, `..`).
 *  - only allowlisted presentation flags pass; any other flag → reject (this
 *    rejects raw `--content-file`/`--session-id`/path flags etc.).
 * The TOCTOU-safe filesystem read is handled separately by materializeOutboxFile,
 * NOT here — this function deliberately resolves no paths.
 */
export function validateRelayRequest(req: RelayRequest): { ok: true; value: ValidatedRelay } | { ok: false; error: string } {
  const safeName = (n: unknown): n is string =>
    typeof n === 'string' && !!n && !n.includes('/') && !n.includes('\\') && !n.includes('..');

  if (!safeName(req.contentFile)) return { ok: false, error: 'contentFile must be a plain outbox basename' };
  const attachmentNames: string[] = [];
  for (const a of Array.isArray(req.attachments) ? req.attachments : []) {
    if (!safeName(a)) return { ok: false, error: 'attachment must be a plain outbox basename' };
    attachmentNames.push(a);
  }
  const flags: string[] = [];
  const rawFlags = Array.isArray(req.flags) ? req.flags : [];
  for (let i = 0; i < rawFlags.length; i++) {
    const f = rawFlags[i];
    if (typeof f !== 'string') return { ok: false, error: 'flag must be a string' };
    if (RELAY_FLAGS_NOVAL.has(f)) { flags.push(f); continue; }
    if (RELAY_FLAGS_VAL.has(f)) {
      const v = rawFlags[i + 1];
      if (typeof v !== 'string') return { ok: false, error: `flag ${f} needs a string value` };
      // The value must NOT itself be a flag — else a sandbox could pass
      // ['--mention','--session-id'] and have --session-id swallowed as the
      // value, corrupting the worker-forced session-id (self-DoS).
      if (v.startsWith('--')) return { ok: false, error: `flag ${f} value must not be a flag` };
      flags.push(f, v); i++; continue;
    }
    return { ok: false, error: `flag not allowed: ${f}` };
  }
  return { ok: true, value: { contentName: req.contentFile, attachmentNames, flags } };
}

/**
 * TOCTOU-safe copy of an outbox file (`outbox/<name>`, name already validated as
 * a plain basename) into a host-private `dest`. Opens with O_NOFOLLOW so a
 * symlink swapped in by the sandbox AFTER validation is rejected at open time,
 * and O_NONBLOCK so opening a FIFO/special the sandbox dropped into the (rw-bound)
 * outbox returns IMMEDIATELY instead of blocking the synchronous watcher tick
 * forever (a FIFO with no writer would otherwise hang the whole worker event
 * loop — an agent-triggerable DoS). After open we fstat-reject anything that
 * isn't a regular file (a FIFO opened O_NONBLOCK|O_RDONLY succeeds but isFile()
 * is false → rejected here). Reads from the fd (not the path), so the inode can't
 * be swapped under us. Returns false (reject) on symlink / non-regular / any error.
 */
export function materializeOutboxFile(outbox: string, name: string, dest: string): boolean {
  let fd: number;
  try { fd = openSync(join(outbox, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch { return false; }  // symlink (ELOOP), FIFO w/o writer is non-blocking now, or missing
  let outFd: number | null = null;
  try {
    if (!fstatSync(fd).isFile()) return false;  // reject dir/fifo/device/etc.
    outFd = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      writeSync(outFd, buf, 0, n);
    }
    return true;
  } catch { return false; }
  finally { closeSync(fd); if (outFd !== null) closeSync(outFd); }
}

/**
 * Daemon/worker-side outbox watcher. The sandboxed `botmux send` (relay mode)
 * drops `<id>.req.json`; we validate (validateRelayRequest) and then MATERIALIZE
 * the content/attachments into a host-private staging dir that is NOT bound into
 * the sandbox — closing the TOCTOU window where the sandbox could swap an outbox
 * file for a symlink between check and the host-side read. We then re-exec THIS
 * build's `send` OUTSIDE the sandbox (full creds) against the private copies,
 * with the session-id FORCED. This keeps every Lark credential out of the sandbox.
 */
export function startOutboxWatcher(outbox: string, baseEnv: NodeJS.ProcessEnv, sessionId: string): () => void {
  const cli = distCliJs();
  const env = { ...baseEnv };
  delete env.BOTMUX_SEND_RELAY;
  const inFlight = new Set<string>();
  // Host-private staging — a sibling of the outbox, NOT bound into the sandbox.
  const staging = join(dirname(outbox), 'relay-staging');

  const finish = (id: string, reqPath: string, name: string, staged: string[], code: number, stdout: string, stderr: string) => {
    // 原子写：沙盒侧 CLI 在 existsSync 轮询这个 res.json，rename 保证它读到完整 JSON。
    try { atomicWriteFileSync(join(outbox, `${id}.res.json`), JSON.stringify({ code, stdout, stderr })); } catch { /* */ }
    try { rmSync(reqPath, { force: true }); } catch { /* */ }
    for (const p of staged) { try { rmSync(p, { force: true }); } catch { /* */ } }
    inFlight.delete(name);
  };

  const tick = () => {
    let entries: string[] = [];
    try { entries = readdirSync(outbox); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith('.req.json') || inFlight.has(name)) continue;
      inFlight.add(name);
      const reqPath = join(outbox, name);
      const id = name.slice(0, -'.req.json'.length);
      const staged: string[] = [];
      let req: RelayRequest;
      try { req = JSON.parse(readFileSync(reqPath, 'utf8')); }
      catch { finish(id, reqPath, name, staged, 1, '', 'relay: bad json'); continue; }

      const v = validateRelayRequest(req);
      if (!v.ok) { finish(id, reqPath, name, staged, 1, '', `relay rejected: ${v.error}`); continue; }

      try { mkdirSync(staging, { recursive: true }); } catch { /* */ }
      // Materialize content (TOCTOU-safe) into the private staging dir.
      const contentDest = join(staging, `${id}.content`);
      if (!materializeOutboxFile(outbox, v.value.contentName, contentDest)) {
        finish(id, reqPath, name, staged, 1, '', 'relay rejected: content not a regular file in outbox');
        continue;
      }
      staged.push(contentDest);
      let attBad = false;
      const attPaths: string[] = [];
      v.value.attachmentNames.forEach((an, i) => {
        if (attBad) return;
        const dest = join(staging, `${id}-att${i}-${an}`);
        if (!materializeOutboxFile(outbox, an, dest)) { attBad = true; return; }
        staged.push(dest); attPaths.push(dest);
      });
      if (attBad) { finish(id, reqPath, name, staged, 1, '', 'relay rejected: attachment not a regular file in outbox'); continue; }

      const hostArgs = [
        ...v.value.flags,
        '--content-file', contentDest,
        ...attPaths.flatMap(a => ['--files', a]),
        '--session-id', sessionId,  // forced — sandbox cannot target another session
      ];
      const child = spawn(process.execPath, [cli, 'send', ...hostArgs], { env });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', (code) => finish(id, reqPath, name, staged, code ?? 1, out, err));
    }
  };

  const timer = setInterval(tick, 200);
  timer.unref?.();
  return () => clearInterval(timer);
}
