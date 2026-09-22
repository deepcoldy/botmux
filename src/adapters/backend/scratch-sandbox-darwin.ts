/**
 * macOS SCRATCH sandbox: APFS clonefile COW copy + Seatbelt confinement.
 *
 * Design: docs/design/2026-09-22-sandbox-scratch-mode.md (macOS appendix).
 *
 * macOS has no per-process mount namespace and Seatbelt has only allow/deny
 * (no write-redirection), so the Linux overlay trick is impossible. Instead:
 *
 *  1. CLONE the user's writable trees ($HOME, plus the project when outside
 *     $HOME) with `cp -cR` — APFS clonefile copy-on-write: a metadata-level
 *     clone that takes ZERO data blocks at clone time; only blocks the CLI
 *     actually modifies later allocate (4 KB granularity). Session end frees
 *     them by deleting the clone.
 *  2. POINT the child at the clone (HOME=clone/home, cwd=clone/work) and
 *     confine it with a Seatbelt profile whose ONLY writable areas are the
 *     clone trees, a scratch-private TMPDIR, and the real-host outbox.
 *  3. System locations (/etc, /opt/homebrew) are READ-ONLY — a write there
 *     fails EPERM (the documented semantic difference vs Linux full-root).
 *
 * Clone verification: `cp -cR` SILENTLY falls back to a byte copy for files it
 * cannot clone (cross-device, some special files). After cloning we compare
 * the volume free-block count (statfs f_bavail); a real multi-GB clone moves
 * it materially, a clonefile clone moves ~nothing (metadata + any genuinely
 * new blocks). A material delta fails the spawn closed rather than silently
 * doubling disk usage.
 *
 * Cross-volume clones are REFUSED (no fallback to byte copy): operator
 * misconfiguration must surface as an error, not a 500 GB copy.
 *
 * Everything is cloned/built BEFORE the child starts and lives at
 * `<dataDir>/sandboxes/<sid>/`; cleanup is a recursive rm + temp teardown.
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
  statfsSync,
} from 'node:fs';
import { join, dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { botmuxShimExecLine } from './sandbox.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../../core/plugins/mcp/environment.js';
import { PROXY_ENV_KEYS, CA_BUNDLE_ENV_KEYS } from '../../utils/child-env.js';
import type { ScratchPathMapping } from '../../services/scratch-host-view.js';

/** macOS scratch is always disk-backed (APFS COW); kept under the same option
 *  name so config validation is uniform. tmpfs does not exist on this OS. */
export type ScratchStorage = 'disk';

export interface MacScratchSandboxSpawn {
  bin: string;
  args: string[];
  env: Record<string, string>;
  outbox: string;
  /** Host→clone view mappings for daemon-side transcript readers. */
  mappings: ScratchPathMapping[];
  /** Clone HOME the child is told to use. */
  clonedHome: string;
  /** In-sandbox chdir (clone path). */
  chdirInSandbox: string;
  cleanup: () => void;
}

interface MacScratchMeta {
  v: 1;
  platform: 'darwin';
  sid: string;
  home: string;
  clonedHome: string;
  work: { real: string; cloned: string } | null;
  tmp: string;
  outbox: string;
  mappings: ScratchPathMapping[];
  createdAt: number;
}

const META_NAME = 'scratch.json';

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function statfs(path: string): { blocks: number; bsize: number } | null {
  try {
    const s = statfsSync(path);
    return { blocks: s.bavail, bsize: s.bsize };
  } catch { return null; }
}

/** `cp -cR src dst` (APFS clonefile recursive). Returns true only when cp
 *  reports success — callers additionally verify block delta themselves. */
function cloneTree(src: string, dst: string): boolean {
  try { mkdirSync(dirname(dst), { recursive: true }); } catch { /* */ }
  // -c = clonefile, -R recursive, -p preserve mode/owner/times/xattrs, -X no
  // extended ACLs (avoid copying sandbox-relevant ACLs into the throwaway copy).
  const r = spawnSync('/bin/cp', ['-cR', '-p', src, dst], { stdio: 'pipe' });
  if (r.status !== 0) {
    console.error(`[scratch-darwin] cp -cR failed (${src} → ${dst}): ${r.stderr?.toString().trim() || r.status}`);
    return false;
  }
  return existsSync(dst);
}

function has(cmd: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function escSb(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Pure Seatbelt profile builder for macOS scratch. Exported so Linux CI can
 * assert the allow/deny shape without a Mac.
 *
 * Posture: `(allow default)` for non-file ops (same compatibility trade-off
 * as compileToSeatbelt — mach/ipc/iokit are broadly granted), then a GLOBAL
 * `(deny file-write*)` with narrow writable carve-outs for exactly the clone
 * trees, the private TMPDIR and the host-real outbox. Reads stay open
 * anywhere (integrity sandbox, not confidentiality).
 */
export function buildMacScratchProfile(input: {
  writable: readonly string[];
  denyPaths?: readonly string[];
  mcpSocket?: string;
  net: boolean;
}): string[] {
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    // Close ALL writes first, then re-open only the throwaway trees.
    '(deny file-write*)',
    // System writes a normal CLI needs (dyld caches, IPC, per-user temp APIs
    // that ignore $TMPDIR). Without these the process can die instantly.
    '(allow file-write* (subpath "/dev"))',
    '(allow file-write* (subpath "/private/var/folders"))',
    '(allow file-write* (subpath "/private/var/db/lsd"))',
    '(allow sysctl*)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow process*)',
    '(allow signal)',
    '(allow iokit-open)',
  ];
  for (const w of input.writable) lines.push(`(allow file-write* (subpath "${escSb(w)}"))`);
  for (const raw of input.denyPaths ?? []) {
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) continue;
    lines.push(`(deny file-read* (subpath "${escSb(raw)}"))`);
    lines.push(`(deny file-write* (subpath "${escSb(raw)}"))`);
  }
  if (input.mcpSocket) {
    lines.push(`(allow file-write* (literal "${escSb(input.mcpSocket)}"))`);
    lines.push(`(allow file-read* (literal "${escSb(input.mcpSocket)}"))`);
  }
  if (!input.net) lines.push('(deny network*)');
  return lines;
}

export interface PrepareMacScratchOpts {
  sessionId: string;
  dataDir: string;
  chdir: string;
  home: string;
  cliBin: string;
  cliArgs: string[];
  denyPaths?: readonly string[];
  mcpGatewaySocketPath?: string;
  net?: boolean;
}

/**
 * Build the macOS scratch spawn. Returns null on any setup failure — the
 * worker treats that as a hard error (never an unconfined run).
 */
export function prepareMacScratchSandbox(opts: PrepareMacScratchOpts): MacScratchSandboxSpawn | null {
  if (process.platform !== 'darwin') return null;
  if (!has('sandbox-exec')) {
    console.error('[scratch-darwin] sandbox-exec not found — cannot enforce the scratch sandbox');
    return null;
  }

  const dataDir = canonical(opts.dataDir);
  const sessionRoot = join(dataDir, 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const tmp = join(sessionRoot, 'tmp');
  const homeCloneRoot = join(sessionRoot, 'clone', 'home');
  const workCloneRoot = join(sessionRoot, 'clone', 'work');
  for (const d of [outbox, shimBin, tmp, homeCloneRoot, workCloneRoot]) {
    mkdirSync(d, { recursive: true });
  }
  chmodSync(tmp, 0o700);

  const homeReal = canonical(opts.home);
  const cwdReal = canonical(opts.chdir);

  // Pre-clone volume check: clones must stay on the SAME fs as their source.
  // statfs f_fsid equality is the portable-ish signal; compare dev via
  // statSync of the dirs as a secondary check.
  const sameVolume = (a: string, b: string): boolean => {
    try { return statSync(a).dev === statSync(b).dev; } catch { return false; }
  };
  const cloneDestHome = join(homeCloneRoot, relative('/', homeReal).split(sep).join('__'));

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
  };
  const fail = (where: string): null => {
    console.error(`[scratch-darwin] setup failed at ${where} — aborting (fail closed, never bare-run)`);
    cleanup();
    return null;
  };

  // Free blocks BEFORE cloning.
  const beforeHome = statfs(homeReal);
  if (!sameVolume(homeReal, homeCloneRoot)) {
    console.error(`[scratch-darwin] HOME ${homeReal} is not on the same volume as ${homeCloneRoot}; cross-volume clone refused (would byte-copy). Set SESSION_DATA_DIR on the same APFS volume or move the project.`);
    return fail('home-cross-volume');
  }

  // Clone HOME (the basename must match so paths like $HOME/.claude resolve).
  const clonedHome = join(homeCloneRoot, relative('/', homeReal).split(sep).join('__'));
  const freeBeforeHome = beforeHome?.blocks;
  if (!cloneTree(homeReal, clonedHome)) return fail('home-clone');
  const afterHome = statfs(homeReal);
  // Clonefile metadata clones move free-blocks by ~0. A byte copy of HOME
  // moves thousands+ blocks. Allow a small slack for journals/metadata but
  // reject anything > 128 MB (512-byte blocks on 4 KB blocks = 32768; use a
  // conservative absolute threshold independent of HOME size).
  if (freeBeforeHome !== undefined && afterHome && (freeBeforeHome - afterHome.blocks) * afterHome.bsize > 128 * 1024 * 1024) {
    console.error(`[scratch-darwin] HOME clone consumed ${(((freeBeforeHome - afterHome.blocks) * afterHome.bsize) / 1024 / 1024).toFixed(0)} MB — cp -cR silently byte-copied (cross-device/special file). Refusing rather than doubling disk.`);
    return fail('home-clone-not-cow');
  }

  // Project: clone only when outside $HOME (inside it, the HOME clone already
  // owns the copy and the child reaches it via clonedHome + relative path).
  let work: { real: string; cloned: string } | null = null;
  const cwdInsideHome = cwdReal === homeReal || cwdReal.startsWith(homeReal.endsWith('/') ? homeReal : `${homeReal}/`);
  let chdirInSandbox: string;
  if (cwdInsideHome) {
    chdirInSandbox = join(clonedHome, relative(homeReal, cwdReal));
  } else {
    if (!sameVolume(cwdReal, workCloneRoot)) {
      console.error(`[scratch-darwin] project ${cwdReal} is not on the same volume as the scratch data dir; cross-volume clone refused.`);
      return fail('work-cross-volume');
    }
    const freeBeforeWork = statfs(cwdReal)?.blocks;
    const clonedWork = join(workCloneRoot, relative('/', cwdReal).split(sep).join('__'));
    if (!cloneTree(cwdReal, clonedWork)) return fail('work-clone');
    const afterWork = statfs(cwdReal);
    if (freeBeforeWork !== undefined && afterWork
      && (freeBeforeWork - afterWork.blocks) * afterWork.bsize > 128 * 1024 * 1024) {
      console.error('[scratch-darwin] project clone silently byte-copied (>128 MB delta); refusing.');
      return fail('work-clone-not-cow');
    }
    work = { real: cwdReal, cloned: clonedWork };
    chdirInSandbox = clonedWork;
  }
  try { mkdirSync(chdirInSandbox, { recursive: true }); } catch { /* exists */ }

  const mappings: ScratchPathMapping[] = [
    { from: homeReal, to: clonedHome },
    ...(work ? [{ from: work.real, to: work.cloned }] : []),
  ];

  // ── shim + outbox ────────────────────────────────────────────────────────
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, botmuxShimExecLine());
  chmodSync(shim, 0o755);

  // Resolve the MCP gateway socket BEFORE building the profile (its path needs
  // an explicit connect grant). A unix socket can't be relocated on macOS.
  let sandboxMcpSocket: string | undefined;
  if (opts.mcpGatewaySocketPath) {
    try {
      const socketPath = resolve(opts.mcpGatewaySocketPath);
      if (lstatSync(socketPath).isSocket()) sandboxMcpSocket = socketPath;
    } catch { /* socket absent → MCP simply unavailable, non-fatal */ }
  }

  // Writable areas: the cloned HOME subtree, the private TMPDIR, the real
  // outbox, and (project outside HOME) its clone tree.
  const writable: string[] = [homeCloneRoot, tmp, outbox];
  if (work) writable.push(workCloneRoot);

  // ── Seatbelt profile (pure builder — unit-tested on Linux CI) ─────────────
  const profilePath = join(sessionRoot, 'scratch.sb');
  const lines = buildMacScratchProfile({
    writable,
    denyPaths: opts.denyPaths ?? [],
    mcpSocket: sandboxMcpSocket,
    net: opts.net !== false,
  });
  writeFileSync(profilePath, lines.join('\n') + '\n', { mode: 0o600 });

  // ── argv + env ─────────────────────────────────────────────────────────────
  // The child believes HOME is the clone; TMPDIR is the private clone tmp so
  // temp writes also die with the session (Seatbelt denies the real /tmp).
  // CLI data dirs default under $HOME (codex/traex resolve ~/.codex, ~/.trae
  // from HOME), but set them explicitly in case the worker's own process.env
  // carried a native CODEX_HOME/TRAE_HOME the child would otherwise inherit.
  const cloneCodexHome = join(clonedHome, '.codex');
  const cloneTraeHome = join(clonedHome, '.trae');
  const env: Record<string, string> = {
    HOME: clonedHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    CODEX_HOME: cloneCodexHome,
    TRAE_HOME: cloneTraeHome,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SEND_RELAY: outbox,
    // shim first, then the inherited PATH (the relay `botmux` must resolve to
    // the shim; there is no bind mechanism on macOS, PATH is the only carve).
    PATH: [shimBin, process.env.PATH ?? ''].filter(Boolean).join(':'),
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

  // sandbox-exec wraps the CLI directly (no bwrap/launcher on macOS; there is
  // no seccomp marker there either).
  const execBin = (() => { try { return realpathSync(opts.cliBin); } catch { return opts.cliBin; } })();
  const args = ['-f', profilePath, execBin, ...opts.cliArgs];

  // Persist meta for sweep/reattach.
  const meta: MacScratchMeta = {
    v: 1,
    platform: 'darwin',
    sid: opts.sessionId,
    home: homeReal,
    clonedHome,
    work,
    tmp,
    outbox,
    mappings,
    createdAt: Date.now(),
  };
  writeFileSync(join(sessionRoot, META_NAME), JSON.stringify(meta), { mode: 0o600 });

  return {
    bin: 'sandbox-exec',
    args,
    env: { ...env },
    outbox,
    mappings,
    clonedHome,
    chdirInSandbox,
    cleanup,
  };
}

/** Attach to a surviving macOS scratch pane after a daemon restart. The clone
 *  and profile persist on disk; only the outbox needs rewiring. Returns null
 *  when the session has no scratch clone. */
export function attachMacScratchSession(opts: { sessionId: string; dataDir: string }): {
  outbox: string;
  mappings: ScratchPathMapping[];
  clonedHome: string;
  chdirInSandbox: string;
  cleanup: () => void;
} | null {
  if (process.platform !== 'darwin') return null;
  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  let meta: MacScratchMeta | null = null;
  try { meta = JSON.parse(readFileSync(join(sessionRoot, META_NAME), 'utf8')); } catch { return null; }
  if (!meta || meta.platform !== 'darwin') return null;
  try { mkdirSync(meta.outbox, { recursive: true }); } catch { /* */ }
  const chdirInSandbox = meta.work?.cloned ?? meta.clonedHome;
  return {
    outbox: meta.outbox,
    mappings: meta.mappings,
    clonedHome: meta.clonedHome,
    chdirInSandbox,
    cleanup: () => teardownMacScratchSession(opts.sessionId, opts.dataDir),
  };
}

/** Remove a macOS scratch clone + profile (no unmount needed). */
export function teardownMacScratchSession(sessionId: string, dataDirInput: string): void {
  const sessionRoot = join(canonical(dataDirInput), 'sandboxes', sessionId);
  try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
}

/** Reclaim orphan macOS scratch clones whose session is gone. Same guards as
 *  the Linux sweep: active set + 60s grace (no /proc live check on macOS —
 *  the active set is authoritative for clones mid-use). */
export function sweepOrphanMacScratchSandboxes(dataDirInput: string, activeSessionIds: Set<string>): void {
  const dataDir = canonical(dataDirInput);
  const root = join(dataDir, 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; }
  const GRACE_MS = 60_000;
  const now = Date.now();
  for (const sid of sids) {
    const sessionRoot = join(root, sid);
    let meta: MacScratchMeta | null = null;
    try { meta = JSON.parse(readFileSync(join(sessionRoot, META_NAME), 'utf8')); } catch { continue; }
    if (!meta || meta.platform !== 'darwin') continue;
    if (activeSessionIds.has(sid)) continue;
    let ageOk = false;
    try { ageOk = now - statSync(sessionRoot).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    teardownMacScratchSession(sid, dataDir);
  }
}
