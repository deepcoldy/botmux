/**
 * macOS SCRATCH sandbox: symlink-farm HOME + selective APFS clonefile COW +
 * Seatbelt confinement.
 *
 * Design: docs/design/2026-09-21-sandbox-scratch-mode.md (macOS appendix),
 * revised after real-Mac testing (PR #1513 round 2).
 *
 * Why NOT a full $HOME clone (the v1 mac attempt, rejected by real hardware):
 *  - TCC-protected trees (~/Library/Containers, Application Support for
 *    Chrome/Edge/iCloud, Photos, Music, …) make `cp` exit nonzero — every real
 *    Mac with a browser/iCloud hits this.
 *  - clonefileat(2) HANGS indefinitely on iCloud CloudDocs online placeholders.
 *
 * Symlink-farm model instead:
 *  - The clone HOME contains, for every real $HOME top-level entry, a SYMLINK
 *    to the real entry — reads stay native/zero-copy, TCC and iCloud trees are
 *    never traversed or copied (no hang, no permission failure).
 *  - Only the subtrees/files a CLI must WRITE inside the home are replaced with
 *    real APFS clonefile copies (`cp -c`, clone-on-write: zero data blocks at
 *    copy time, only changed blocks allocate): the CLI data dirs
 *    (~/.claude, ~/.codex, ~/.trae, ~/.claude-runtime, ~/.cache), the home
 *    top-level regular dotfiles, and the working project.
 *  - Writes that follow a plain symlink resolve to the real path, where the
 *    Seatbelt profile denies them (symlink resolution is enforced by the
 *    kernel sandbox — empirically verified across 11 symlink/hardlink cases).
 *  - Cloned credential files (~/.botmux/*) are never copied: that entry stays a
 *    symlink, and real-path read denies seal it.
 *
 * System locations stay READ-ONLY (a documented semantic difference vs Linux
 * full-root). A few host-real cache areas Foundation/cfprefsd force regardless
 * of $HOME are granted write (and documented as host-visible):
 * ~/Library/{Caches,Application Support,Logs} and /private/var/folders.
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
  symlinkSync,
  readlinkSync,
} from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { botmuxShimExecLine } from './sandbox.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../../core/plugins/mcp/environment.js';
import { PROXY_ENV_KEYS, CA_BUNDLE_ENV_KEYS } from '../../utils/child-env.js';
import type { ScratchPathMapping } from '../../services/scratch-host-view.js';

export type ScratchStorage = 'disk';

/** Max time a single clonefile subtree copy may take. */
const CLONE_TIMEOUT_MS = 5 * 60_000;

export interface MacScratchSandboxSpawn {
  bin: string;
  args: string[];
  env: Record<string, string>;
  outbox: string;
  mappings: ScratchPathMapping[];
  clonedHome: string;
  chdirInSandbox: string;
  cleanup: () => void;
}

interface MacScratchMeta {
  v: 2;
  platform: 'darwin';
  sid: string;
  home: string;
  clonedHome: string;
  work: { real: string; cloned: string } | null;
  chdirInSandbox: string;
  tmp: string;
  outbox: string;
  mappings: ScratchPathMapping[];
  createdAt: number;
}

const META_NAME = 'scratch.json';

/** Subtrees under $HOME replaced with real clonefile copies (CLI state the
 *  session is allowed to mutate; everything else stays a read passthrough).
 *  In practice EVERY top-level dot-directory is cloned (dev state: .npm,
 *  .bun, .local, .config, .cache, .cargo, …) EXCEPT the botmux authority
 *  roots, which stay symlinks sealed by real-path denies (so a cloned copy
 *  can never carry bots.json into the sandbox). */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function sameVolume(a: string, b: string): boolean {
  try { return statSync(a).dev === statSync(b).dev; } catch { return false; }
}

/** `cp -c src dst` (APFS clonefile). Never -p (would copy ACL/uchg/flags that
 *  later block cleanup). Bounded timeout so a stuck clone (cloud placeholder)
 *  fails the spawn instead of hanging the worker forever. */
function clonePath(src: string, dst: string): boolean {
  try { mkdirSync(dirname(dst), { recursive: true }); } catch { /* */ }
  const r = spawnSync('/bin/cp', ['-cR', src, dst], {
    stdio: 'pipe',
    timeout: CLONE_TIMEOUT_MS,
  });
  if (r.error) {
    console.error(`[scratch-darwin] cp -c timed out/errored (${src}): ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`[scratch-darwin] cp -c failed (${src} → ${dst}): ${r.stderr?.toString().trim() || r.status}`);
    return false;
  }
  return existsSync(dst);
}

/** Logical size in bytes of a subtree (du -sk); null on failure. Used to sanity
 *  check the copy really was COW (disk consumed must not approach source size). */
function logicalSizeKb(path: string): number | null {
  const r = spawnSync('/usr/bin/du', ['-sk', path], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
  if (r.status !== 0) return null;
  const kb = parseInt(r.stdout.toString().trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(kb) ? kb : null;
}

function has(cmd: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function escSb(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Pure Seatbelt profile builder (unit-tested on Linux CI). */
export function buildMacScratchProfile(input: {
  /** Clone trees + scratch tmp/outbox granted read+write. */
  writable: readonly string[];
  /** REAL host paths denied read AND write (credentials; also seals reads
   *  reached via the symlink farm). Emitted LAST so they win. */
  realDenyPaths?: readonly string[];
  /** REAL host cache areas granted write (Foundation/cfprefsd ignore HOME). */
  hostWritable?: readonly string[];
  mcpSocket?: string;
  net: boolean;
}): string[] {
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    // Close ALL writes first; re-open only the scratch trees below.
    '(deny file-write*)',
    // System writes a normal CLI needs.
    '(allow file-write* (subpath "/dev"))',
    '(allow sysctl*)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow process*)',
    '(allow signal)',
    '(allow iokit-open)',
  ];
  // Host-real temp/cache areas some frameworks hard-code (independent of
  // $HOME/TMPDIR). Grant before the final deny block.
  for (const w of input.hostWritable ?? []) {
    lines.push(`(allow file-write* (subpath "${escSb(w)}"))`);
  }
  // The scratch clone trees + private tmp + outbox.
  for (const w of input.writable) {
    lines.push(`(allow file-write* (subpath "${escSb(w)}"))`);
  }
  if (input.mcpSocket) {
    lines.push(`(allow file-write* (literal "${escSb(input.mcpSocket)}"))`);
    lines.push(`(allow file-read* (literal "${escSb(input.mcpSocket)}"))`);
  }
  // Credential denies LAST — they must win over any broader grant and they
  // also block reads followed through the symlink farm.
  for (const raw of input.realDenyPaths ?? []) {
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) continue;
    lines.push(`(deny file-read* (subpath "${escSb(raw)}"))`);
    lines.push(`(deny file-write* (subpath "${escSb(raw)}"))`);
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
  /** Credential/secret REAL host paths (read+write denied in the child). */
  denyPaths?: readonly string[];
  mcpGatewaySocketPath?: string;
  net?: boolean;
}

export function prepareMacScratchSandbox(opts: PrepareMacScratchOpts): MacScratchSandboxSpawn | null {
  if (process.platform !== 'darwin') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(opts.sessionId)) {
    console.error('[scratch-darwin] unsafe sessionId for scratch tree');
    return null;
  }
  if (!has('sandbox-exec')) {
    console.error('[scratch-darwin] sandbox-exec not found — cannot enforce the scratch sandbox');
    return null;
  }

  const dataDir = canonical(opts.dataDir);
  const sessionRoot = join(dataDir, 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const tmp = join(sessionRoot, 'tmp');
  const cloneRoot = join(sessionRoot, 'clone');
  const homeCloneRoot = join(cloneRoot, 'home');
  const workCloneRoot = join(cloneRoot, 'work');
  for (const d of [outbox, shimBin, tmp, homeCloneRoot, workCloneRoot]) mkdirSync(d, { recursive: true });
  chmodSync(tmp, 0o700);

  const homeReal = canonical(opts.home);
  const cwdReal = canonical(opts.chdir);
  if (!sameVolume(homeReal, homeCloneRoot)) {
    console.error(`[scratch-darwin] HOME ${homeReal} not on the same volume as ${homeCloneRoot}; cross-volume scratch refused.`);
    rmSync(sessionRoot, { recursive: true, force: true });
    return null;
  }

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Clones contain symlinks (deleted without touching targets) plus clonefile
    // copies. Strip flags/ACLs defensively first (a cloned file could carry
    // uchg/ACL), then remove.
    spawnSync('/usr/sbin/chflags', ['-R', 'nouchg,noschg', cloneRoot], { stdio: 'ignore' });
    spawnSync('/bin/chmod', ['-RN', cloneRoot], { stdio: 'ignore' });
    try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const fail = (where: string): null => {
    console.error(`[scratch-darwin] setup failed at ${where} — aborting (fail closed, never bare-run)`);
    cleanup();
    return null;
  };

  // ── 1. Symlink-farm HOME ───────────────────────────────────────────────────
  let homeEntries: import('node:fs').Dirent[];
  try {
    homeEntries = readdirSync(homeReal, { withFileTypes: true });
  } catch (e) {
    console.error(`[scratch-darwin] cannot read HOME ${homeReal}: ${(e as Error).message}`);
    return fail('home-read');
  }

  // Botmux authority roots (bots.json, dashboard secret, BOT_HOMEs) must stay
  // symlinks so the real-path read denies below actually reach them — a
  // clonefile copy would carry the secrets into the sandbox.
  const authorityRoots = new Set<string>();
  for (const p of opts.denyPaths ?? []) {
    if (typeof p !== 'string' || !p) continue;
    // Each credential file; walk up to the first directory INSIDE $HOME.
    let cur = canonical(p);
    while (dirname(cur) !== homeReal && cur !== dirname(cur) && cur.startsWith(homeReal)) cur = dirname(cur);
    if (dirname(cur) === homeReal) authorityRoots.add(cur);
  }
  // Also always protect the data dir's botmux home derived from the standard
  // location (~/.botmux) regardless of which files surfaced in denyPaths.
  authorityRoots.add(join(homeReal, '.botmux'));

  // Project may live INSIDE home: collect its relative path so the farm copies
  // that leaf as a real clone instead of leaving a symlink.
  const cwdInsideHome = cwdReal === homeReal || cwdReal.startsWith(homeReal.endsWith(sep) ? homeReal : `${homeReal}${sep}`);
  const cwdRel = cwdInsideHome ? relative(homeReal, cwdReal) : null;
  const cwdAncestorDirs = new Set<string>();
  if (cwdRel) {
    const parts = cwdRel.split(sep).filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? join(acc, parts[i]!) : parts[i]!;
      cwdAncestorDirs.add(acc);
    }
  }

  const clonedSubtrees: { src: string; dst: string; logicalKb: number | null }[] = [];

  const symlinkEntry = (target: string, link: string): void => {
    try { symlinkSync(target, link); } catch { /* already materialised */ }
  };

  for (const ent of homeEntries) {
    const name = ent.name;
    const linkInClone = join(homeCloneRoot, name);
    const realEntry = join(homeReal, name);
    const isProjectAncestor = cwdAncestorDirs.has(name);

    if (isProjectAncestor && ent.isDirectory()) {
      // Materialise a real (sparse) dir so the cloned project leaf lands in it.
      mkdirSync(linkInClone, { recursive: true });
      continue;
    }

    if (ent.isSymbolicLink()) {
      let target: string;
      try { target = readlinkSync(realEntry); } catch { continue; }
      symlinkEntry(target, linkInClone);
      continue;
    }

    if (ent.isDirectory()) {
      // All dot-directories = real clonefile copies (CLI dev state; bounded,
      // no TCC/iCloud trees live there) EXCEPT botmux authority roots which
      // stay symlinks sealed by real-path read denies. Non-dot dirs (Library,
      // Documents, Desktop, …) are symlinks: native reads, writes denied — the
      // TCC/cloud trees are never traversed.
      if (name.startsWith('.') && !authorityRoots.has(realEntry)) {
        clonedSubtrees.push({ src: realEntry, dst: linkInClone, logicalKb: logicalSizeKb(realEntry) });
      } else {
        symlinkEntry(realEntry, linkInClone);
      }
      continue;
    }

    if (ent.isFile()) {
      // Dotfiles (.claude.json, .zshrc, .gitconfig, .npmrc — Claude rewrites
      // .claude.json every run) cloned for throwaway edits; others passthrough.
      if (name.startsWith('.')) {
        clonedSubtrees.push({ src: realEntry, dst: linkInClone, logicalKb: null });
      } else {
        symlinkEntry(realEntry, linkInClone);
      }
    }
  }

  // Project leaf nested under HOME (e.g. ~/iserver/proj).
  if (cwdRel) {
    const leaf = join(homeCloneRoot, cwdRel);
    if (!existsSync(leaf)) {
      clonedSubtrees.push({ src: cwdReal, dst: leaf, logicalKb: logicalSizeKb(cwdReal) });
    }
  }

  // Run the bounded clonefile copies.
  for (const c of clonedSubtrees) {
    const freeBefore = statfsSafe(c.src)?.bavail;
    if (!clonePath(c.src, c.dst)) return fail(`clone:${basename(c.src)}`);
    // COW guard: a byte-copy fallback consumes ~source size; clonefile consumes
    // ~nothing. Reject when consumed approaches the subtree's logical size.
    if (freeBefore !== undefined && c.logicalKb !== null) {
      const after = statfsSafe(c.src);
      if (after) {
        const consumedBytes = (freeBefore - after.bavail) * after.bsize;
        if (consumedBytes > c.logicalKb * 1024 * 1.25 && consumedBytes > 64 * 1024 * 1024) {
          console.error(`[scratch-darwin] clone of ${c.src} consumed ${(consumedBytes / 1024 / 1024).toFixed(0)}MB ≈ byte copy (cross-device/special file fallback); refusing.`);
          return fail('clone-not-cow');
        }
      }
    }
  }

  // ── 2. Project outside HOME → separate bounded clone ───────────────────────
  let work: { real: string; cloned: string } | null = null;
  let chdirInSandbox: string;
  if (cwdInsideHome) {
    chdirInSandbox = join(homeCloneRoot, cwdRel!);
  } else {
    if (!sameVolume(cwdReal, workCloneRoot)) {
      console.error(`[scratch-darwin] project ${cwdReal} not on the same volume as scratch data dir; refused.`);
      return fail('work-cross-volume');
    }
    const clonedWork = join(workCloneRoot, relative('/', cwdReal).split(sep).join('__'));
    const srcKb = logicalSizeKb(cwdReal);
    const freeBefore = statfsSafe(cwdReal)?.bavail;
    if (!clonePath(cwdReal, clonedWork)) return fail('work-clone');
    const after = statfsSafe(cwdReal);
    if (freeBefore !== undefined && srcKb !== null && after
      && (freeBefore - after.bavail) * after.bsize > srcKb * 1024 * 1.25
      && (freeBefore - after.bavail) * after.bsize > 64 * 1024 * 1024) {
      return fail('work-clone-not-cow');
    }
    work = { real: cwdReal, cloned: clonedWork };
    chdirInSandbox = clonedWork;
  }
  try { mkdirSync(chdirInSandbox, { recursive: true }); } catch { /* exists */ }

  const mappings: ScratchPathMapping[] = [
    { from: homeReal, to: homeCloneRoot },
    ...(work ? [{ from: work.real, to: work.cloned }] : []),
  ];

  // ── 3. shim (relay botmux via PATH; macOS has no bind) ─────────────────────
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, botmuxShimExecLine());
  chmodSync(shim, 0o755);

  // ── 4. env ─────────────────────────────────────────────────────────────────
  const env: Record<string, string> = {
    HOME: homeCloneRoot,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    CODEX_HOME: join(homeCloneRoot, '.codex'),
    TRAE_HOME: join(homeCloneRoot, '.trae'),
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SEND_RELAY: outbox,
    PATH: [shimBin, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
  if (process.env.BOTMUX_DAEMON_IPC_PORT) env.BOTMUX_DAEMON_IPC_PORT = process.env.BOTMUX_DAEMON_IPC_PORT;
  let sandboxMcpSocket: string | undefined;
  if (opts.mcpGatewaySocketPath) {
    try {
      const socketPath = resolve(opts.mcpGatewaySocketPath);
      if (lstatSync(socketPath).isSocket()) sandboxMcpSocket = socketPath;
    } catch { /* absent → MCP unavailable */ }
  }
  if (sandboxMcpSocket) {
    env[MCP_GATEWAY_SOCKET_ENV] = sandboxMcpSocket;
    env[MCP_GATEWAY_REQUIRED_ENV] = '1';
  }
  for (const k of PROXY_ENV_KEYS) { const v = process.env[k]; if (typeof v === 'string' && v) env[k] = v; }
  for (const k of CA_BUNDLE_ENV_KEYS) { const v = process.env[k]; if (typeof v === 'string' && v) env[k] = v; }

  // ── 5. Seatbelt profile ─────────────────────────────────────────────────────
  // NEVER deny the session root here (Linux does; on macOS the clone trees and
  // outbox live under it) — the credential denies are real-host paths.
  const realDeny = (opts.denyPaths ?? [])
    .filter((p): p is string => typeof p === 'string' && !!p && isAbsolute(p))
    .filter(p => !p.startsWith(sessionRoot + sep) && p !== sessionRoot);
  const hostWritable = [
    '/private/tmp',
    '/private/var/tmp',
    '/private/var/folders',
    join(homeReal, 'Library', 'Caches'),
    join(homeReal, 'Library', 'Application Support'),
    join(homeReal, 'Library', 'Logs'),
  ];
  // Claude CLI writes per-project MCP traffic logs (sessionId/cwd/tool flow)
  // into a real host cache subtree — the most visible "scratch session leaked
  // onto the host" trace. Empirically Claude ignores the EPERM here, so deny
  // it LAST (after the broad Caches allow) to keep sessions off the host.
  const extraRealDeny = [
    join(homeReal, 'Library', 'Caches', 'claude-cli-nodejs'),
  ];
  const profilePath = join(sessionRoot, 'scratch.sb');
  const lines = buildMacScratchProfile({
    net: opts.net !== false,
    writable: [homeCloneRoot, workCloneRoot, tmp, outbox],
    hostWritable,
    realDenyPaths: [...realDeny, ...extraRealDeny],
    mcpSocket: sandboxMcpSocket,
  });
  writeFileSync(profilePath, lines.join('\n') + '\n', { mode: 0o600 });

  let execBin: string;
  try { execBin = realpathSync(opts.cliBin); } catch { execBin = opts.cliBin; }
  const args = ['-f', profilePath, execBin, ...opts.cliArgs];

  const meta: MacScratchMeta = {
    v: 2,
    platform: 'darwin',
    sid: opts.sessionId,
    home: homeReal,
    clonedHome: homeCloneRoot,
    work,
    chdirInSandbox,
    tmp,
    outbox,
    mappings,
    createdAt: Date.now(),
  };
  writeFileSync(join(sessionRoot, META_NAME), JSON.stringify(meta), { mode: 0o600 });

  return {
    bin: 'sandbox-exec',
    args,
    env,
    outbox,
    mappings,
    clonedHome: homeCloneRoot,
    chdirInSandbox,
    cleanup,
  };
}


function statfsSafe(path: string): { bavail: number; bsize: number } | null {
  try { const s = statfsSync(path); return { bavail: s.bavail, bsize: s.bsize }; } catch { return null; }
}

export function attachMacScratchSession(opts: { sessionId: string; dataDir: string }): {
  outbox: string;
  mappings: ScratchPathMapping[];
  clonedHome: string;
  chdirInSandbox: string;
  cleanup: () => void;
} | null {
  if (process.platform !== 'darwin') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(opts.sessionId)) return null;
  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  let meta: MacScratchMeta | null = null;
  try { meta = JSON.parse(readFileSync(join(sessionRoot, META_NAME), 'utf8')); } catch { return null; }
  if (!meta || meta.platform !== 'darwin') return null;
  try { mkdirSync(meta.outbox, { recursive: true }); } catch { /* */ }
  return {
    outbox: meta.outbox,
    mappings: meta.mappings,
    clonedHome: meta.clonedHome,
    // Persisted at spawn time (P2 fix): correct subdir even when project is
    // inside HOME, instead of degrading to the clone root.
    chdirInSandbox: meta.chdirInSandbox,
    cleanup: () => teardownMacScratchSession(opts.sessionId, opts.dataDir),
  };
}

export function teardownMacScratchSession(sessionId: string, dataDirInput: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
  const sessionRoot = join(canonical(dataDirInput), 'sandboxes', sessionId);
  spawnSync('/usr/sbin/chflags', ['-R', 'nouchg,noschg', join(sessionRoot, 'clone')], { stdio: 'ignore' });
  spawnSync('/bin/chmod', ['-RN', join(sessionRoot, 'clone')], { stdio: 'ignore' });
  try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
}

export function sweepOrphanMacScratchSandboxes(dataDirInput: string, activeSessionIds: Set<string>): void {
  const dataDir = canonical(dataDirInput);
  const root = join(dataDir, 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; }
  const GRACE_MS = 60_000;
  const now = Date.now();
  for (const sid of sids) {
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) continue;
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
