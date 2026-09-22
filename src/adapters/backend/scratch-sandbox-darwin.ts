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

/** Max time a single clonefile subtree copy may take. Core CLI dirs get the
 *  full budget; best-effort dot-dirs get a shorter one before degrading. */
const CLONE_TIMEOUT_CORE_MS = 5 * 60_000;
const CLONE_TIMEOUT_BESTEFFORT_MS = 45_000;

/** CLI state dirs cloned REQUIRED (fail-closed): sessions/auth/config of the
 *  supported CLIs must be writable COW for scratch to function. */
const CORE_CLONE_HOME_DIRS = new Set([
  '.claude',
  '.codex',
  '.trae',
  '.trae-cn',
  '.claude-runtime',
]);

/** Top-level dot-dirs NEVER cloned (TCC-protected / virtual / guaranteed
 *  useless to a CLI): symlinked and write-sealed. */
const NEVER_CLONE_HOME_DIRS = new Set([
  '.Trash',
]);

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

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function sameVolume(a: string, b: string): boolean {
  try { return statSync(a).dev === statSync(b).dev; } catch { return false; }
}

/** `cp -c src dst` (APFS clonefile). Never -p (would copy ACL/uchg/flags that
 *  later block cleanup). Bounded timeout so a stuck/oversized subtree fails
 *  fast and the caller can degrade it to a symlink instead of hanging. */
function clonePath(src: string, dst: string, timeoutMs: number): boolean {
  try { mkdirSync(dirname(dst), { recursive: true }); } catch { /* */ }
  const r = spawnSync('/bin/cp', ['-cR', src, dst], {
    stdio: 'pipe',
    timeout: timeoutMs,
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

function has(cmd: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function escSb(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Pure Seatbelt profile builder (unit-tested on Linux CI).
 *
 * Rule ordering (last match wins in Seatbelt):
 *  1. global `(deny file-write*)` + system/host-cache grants
 *  2. authorityRootDenies — broad READ+write seal over botmux secret roots
 *     (~/.botmux …). Emitted before the scratch-tree re-open so that when the
 *     session tree lives UNDER a sealed root (default dataDir=~/.botmux/data)
 *     the deeper grant below can carve it back out.
 *  3. writable — the session clone trees / tmp / outbox / shim (re-open)
 *  4. mcp socket literal grants
 *  5. fileDenyPaths — file/subtree credential denies + symlink-degraded
 *     subtree write-denies + user denies, emitted LAST so they always win. */
export function buildMacScratchProfile(input: {
  /** Scratch trees granted read+write (clone trees, session tmp/outbox/shim). */
  writable: readonly string[];
  /** Secret/authority roots sealed READ+write before the scratch re-open. */
  authorityRootDenies?: readonly string[];
  /** Final file/subtree denies (read+write for secrets; write-only callers
   *  should be pre-suffixed via the input shape below if needed). */
  fileDenyPaths?: readonly string[];
  /** Final WRITE-only denies (subtrees degraded from clone to symlink must be
   *  read-native but never writable, so writes can't silently reach the host). */
  fileWriteDenyPaths?: readonly string[];
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
  // $HOME/TMPDIR).
  for (const w of input.hostWritable ?? []) {
    lines.push(`(allow file-write* (subpath "${escSb(w)}"))`);
  }
  // Stage 2: broad secret-root seal (read+write).
  for (const root of input.authorityRootDenies ?? []) {
    if (!root || !isAbsolute(root)) continue;
    lines.push(`(deny file-read* (subpath "${escSb(root)}"))`);
    lines.push(`(deny file-write* (subpath "${escSb(root)}"))`);
  }
  // Stage 3: re-open the session scratch trees (deeper than a sealed root).
  for (const w of input.writable ?? []) {
    lines.push(`(allow file-read* (subpath "${escSb(w)}"))`);
    lines.push(`(allow file-write* (subpath "${escSb(w)}"))`);
  }
  if (input.mcpSocket) {
    lines.push(`(allow file-write* (literal "${escSb(input.mcpSocket)}"))`);
    lines.push(`(allow file-read* (literal "${escSb(input.mcpSocket)}"))`);
  }
  // Stage 5: final denies win over everything above.
  for (const raw of input.fileDenyPaths ?? []) {
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) continue;
    lines.push(`(deny file-read* (subpath "${escSb(raw)}"))`);
    lines.push(`(deny file-write* (subpath "${escSb(raw)}"))`);
  }
  for (const raw of input.fileWriteDenyPaths ?? []) {
    if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) continue;
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
    // Clones hold clonefile copies (no -p, but mode bits are preserved: a 555
    // dir would defeat rm) and symlinks. Strip flags, ACLs AND add user-write
    // recursively before deleting — otherwise read-only subtrees leak as
    // residuals (sweep/teardown share this function).
    spawnSync('/usr/sbin/chflags', ['-R', 'nouchg,noschg', cloneRoot], { stdio: 'ignore' });
    spawnSync('/bin/chmod', ['-RN', cloneRoot], { stdio: 'ignore' });
    spawnSync('/bin/chmod', ['-R', 'u+w', cloneRoot], { stdio: 'ignore' });
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

  // Secret/authority roots. Computed HERE from first principles (NOT trusted
  // from the worker's deny list, which may not enumerate bots.json):
  //  - standard botmux home ~/.botmux and any custom BOTMUX_HOME envs
  //  - the data dir when it lives under $HOME (session trees are carved back
  //    out by the deeper session grant in the profile)
  // Each is sealed READ+write as an authority root in the profile; the farm
  // entry stays a symlink (never cloned, so no secret copy exists).
  const authorityRoots = new Set<string>();
  const addAuthority = (p: string | undefined): void => {
    if (!p) return;
    const c = canonical(p);
    if (c === homeReal || !c.startsWith(homeReal.endsWith(sep) ? homeReal : `${homeReal}${sep}`)) return;
    authorityRoots.add(c);
  };
  addAuthority(join(homeReal, '.botmux'));
  addAuthority(process.env.BOTMUX_HOME);
  addAuthority(process.env.BOTMUX_BOT_HOME);
  addAuthority(process.env.BOTMUX_DATA_HOME);
  if (dataDir.startsWith(homeReal)) {
    // Seal only the botmux DATA parent that holds config/credentials, never the
    // session root itself (which must stay writable).
    addAuthority(dirname(dataDir));
  }
  // Extra top-level homes named by the caller's deny paths (e.g. ~/.ssh).
  for (const p of opts.denyPaths ?? []) {
    if (typeof p !== 'string' || !p) continue;
    let cur = canonical(p);
    while (dirname(cur) !== homeReal && cur !== dirname(cur) && cur.startsWith(homeReal)) cur = dirname(cur);
    if (dirname(cur) === homeReal) authorityRoots.add(cur);
  }

  // Project inside HOME → relative path + materialised ancestor dirs.
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

  // Subtrees that had to DEGRADE from clone → symlink (TCC denial, timeout,
  // size cap). They stay read-native but get a final WRITE-only deny so agent
  // writes can't silently land on the real host.
  const degradedWriteDeny = new Set<string>();
  const failedCore: string[] = [];

  const symlinkEntry = (target: string, link: string): void => {
    try { symlinkSync(target, link); } catch { /* already materialised */ }
  };

  /** Clone a subtree; on failure degrade to a symlink + write-seal. When
   *  `required` (core CLI dirs / the project leaf) failure is fatal. */
  const cloneOrDegrade = (src: string, dst: string, kind: 'core' | 'besteffort'): void => {
    const timeout = kind === 'core' ? CLONE_TIMEOUT_CORE_MS : CLONE_TIMEOUT_BESTEFFORT_MS;
    if (clonePath(src, dst, timeout)) return;
    // Fallback to a read-native symlink, sealed against writes.
    try { rmSync(dst, { recursive: true, force: true }); } catch { /* */ }
    symlinkEntry(src, dst);
    degradedWriteDeny.add(src);
    if (kind === 'core') failedCore.push(src);
  };

  for (const ent of homeEntries) {
    const name = ent.name;
    const linkInClone = join(homeCloneRoot, name);
    const realEntry = join(homeReal, name);
    const isProjectAncestor = cwdAncestorDirs.has(name);

    if (isProjectAncestor && ent.isDirectory()) {
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
      if (authorityRoots.has(realEntry)) {
        // Credential root: symlink + real-path seal (read+write in profile).
        symlinkEntry(realEntry, linkInClone);
      } else if (NEVER_CLONE_HOME_DIRS.has(name)) {
        // Known TCC/virtual: read-native symlink, write-sealed.
        symlinkEntry(realEntry, linkInClone);
        degradedWriteDeny.add(realEntry);
      } else if (name.startsWith('.')) {
        // Core CLI state dirs = required; other dot-dirs best-effort (bounded,
        // degrade to sealed symlink on TCC/timeout instead of failing spawn).
        cloneOrDegrade(realEntry, linkInClone, CORE_CLONE_HOME_DIRS.has(name) ? 'core' : 'besteffort');
      } else {
        // Non-dot dirs (Library/Documents/Desktop…): read-native, write sealed.
        symlinkEntry(realEntry, linkInClone);
        degradedWriteDeny.add(realEntry);
      }
      continue;
    }

    if (ent.isFile()) {
      // Dotfiles (.claude.json/.zshrc/.gitconfig — Claude rewrites .claude.json
      // every run) are tiny: required clone. Non-dot files pass through.
      if (name.startsWith('.')) {
        cloneOrDegrade(realEntry, linkInClone, 'core');
      } else {
        symlinkEntry(realEntry, linkInClone);
      }
    }
  }

  // Project leaf nested under HOME — required clone.
  if (cwdRel) {
    const leaf = join(homeCloneRoot, cwdRel);
    if (!existsSync(leaf)) cloneOrDegrade(cwdReal, leaf, 'core');
  }

  if (failedCore.length > 0) {
    console.error(`[scratch-darwin] required CLI state/project clone failed: ${failedCore.join(', ')}`);
    return fail('core-clone');
  }

  // ── 2. Project outside HOME → required bounded clone ───────────────────────
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
    cloneOrDegrade(cwdReal, clonedWork, 'core');
    if (failedCore.length > 0) return fail('work-clone');
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
  // Three-stage sealing (empirically validated on Mac): secret/authority roots
  // are broadly sealed BEFORE the session re-open; the session trees are
  // granted AFTER (so a session dir under ~/.botmux/data still works); the
  // individual credential files + symlink-degraded subtrees deny LAST.
  const hostWritable = [
    '/private/tmp',
    '/private/var/tmp',
    '/private/var/folders',
    join(homeReal, 'Library', 'Caches'),
    join(homeReal, 'Library', 'Application Support'),
    join(homeReal, 'Library', 'Logs'),
  ];
  // Claude CLI per-project MCP traffic logs (sessionId/cwd/tool flow) in the
  // real host cache: deny WRITE after the broad Caches grant — Claude ignores
  // the EPERM (validated on Mac), keeps scratch sessions off the host cache.
  const claudeMcpCache = join(homeReal, 'Library', 'Caches', 'claude-cli-nodejs');
  // File-level caller-supplied denies outside the authority roots / session
  // tree (the sessionRoot is NOT denied on macOS: clones/outbox live under it).
  const callerFileDenies = (opts.denyPaths ?? [])
    .filter((p): p is string => typeof p === 'string' && !!p && isAbsolute(p))
    .map(p => canonical(p))
    .filter(p => !p.startsWith(sessionRoot + sep) && p !== sessionRoot)
    .filter(p => ![...authorityRoots].some(root => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)));

  const profilePath = join(sessionRoot, 'scratch.sb');
  const lines = buildMacScratchProfile({
    net: opts.net !== false,
    authorityRootDenies: [...authorityRoots].sort((a, b) => b.length - a.length),
    writable: [homeCloneRoot, workCloneRoot, tmp, outbox, shimBin],
    hostWritable,
    fileDenyPaths: [...new Set([...callerFileDenies])],
    fileWriteDenyPaths: [...degradedWriteDeny, claudeMcpCache]
      .filter(p => !authorityRoots.has(p)),
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
  const cloneRoot = join(sessionRoot, 'clone');
  spawnSync('/usr/sbin/chflags', ['-R', 'nouchg,noschg', cloneRoot], { stdio: 'ignore' });
  spawnSync('/bin/chmod', ['-RN', cloneRoot], { stdio: 'ignore' });
  // Read-only (555) cloned dirs need a user-write bit or rm fails EACCES.
  spawnSync('/bin/chmod', ['-R', 'u+w', cloneRoot], { stdio: 'ignore' });
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
