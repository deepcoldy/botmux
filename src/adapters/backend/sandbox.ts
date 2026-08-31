/**
 * Linux file sandbox: bwrap DIRECT mode (fs-policy three-tier whitelist).
 *
 * Model (2026-07-16 refactor, design doc "botmux 文件沙盒重构方案"): the
 * sandboxed CLI writes the PROJECT DIRECTLY (same behaviour as an unsandboxed
 * run inside the policy's readWrite zones) and sees NOTHING outside the
 * policy's rules — a fresh tmpfs root, only the rule paths bound in. This
 * replaced the overlayfs+landing model: no mounts to leak, no landing step,
 * no bridge redirect (the CLI's data dir is a REAL host path).
 *
 * The policy is built by the worker (adapters/cli/fs-policy.ts — the single
 * source of truth for BOTH platforms) and compiled to bwrap argv here. macOS
 * enforces the SAME policy via Seatbelt (compileToSeatbelt) at the worker's
 * spawn site — nothing in this module runs on darwin.
 *
 * `botmux send` relay: unchanged from the previous model. The sandboxed CLI's
 * `botmux send` writes a validated request into a per-session outbox; the
 * daemon-side watcher re-executes the send OUTSIDE the sandbox with real
 * credentials. No Feishu credential ever enters the sandbox.
 */
import { isMojoFullyRemote } from './mojo-types.js';
import { mkdirSync, existsSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, statSync, lstatSync, readlinkSync, realpathSync, openSync, fstatSync, readSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { compileToBwrap, type FsPolicy } from '../cli/fs-policy.js';
import { PROXY_ENV_KEYS } from '../../utils/child-env.js';
import { isStandaloneBinary } from '../../core/self-spawn.js';
import {
  MCP_GATEWAY_REQUIRED_ENV,
  MCP_GATEWAY_SOCKET_ENV,
} from '../../core/plugins/mcp/environment.js';

/** Verify (and best-effort auto-install) bubblewrap so the user needn't
 *  pre-install. Installs via the system package manager when the daemon can
 *  (root, or passwordless sudo); otherwise logs a one-line manual-install hint
 *  and returns false so the caller fails the spawn (never a silent
 *  unsandboxed run). */
function ensureSandboxDeps(): boolean {
  const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  if (has('bwrap')) return true;
  const pm =
    has('apt-get') ? ['apt-get', 'install', '-y', 'bubblewrap'] :
    has('dnf')     ? ['dnf', 'install', '-y', 'bubblewrap'] :
    has('yum')     ? ['yum', 'install', '-y', 'bubblewrap'] :
    has('apk')     ? ['apk', 'add', 'bubblewrap'] :
    has('pacman')  ? ['pacman', '-S', '--noconfirm', 'bubblewrap'] :
    null;
  const isRoot = process.getuid?.() === 0;
  if (pm) {
    // root installs directly; a non-root daemon tries passwordless sudo only
    // (never blocks on an interactive prompt).
    const argv = isRoot ? pm : ['sudo', '-n', ...pm];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: 180_000 });
    if (r.status === 0 && has('bwrap')) return true;
  }
  const guide = pm ? `${isRoot ? '' : 'sudo '}${pm.join(' ')}` : 'install bubblewrap';
  console.error(`[sandbox] bwrap missing; auto-install unavailable — install manually then retry: ${guide}`);
  return false;
}

function assertCredentialIsolationPath(path: string, kind: string): string {
  const normalized = resolve(path);
  if (!isAbsolute(path) || normalized !== path || normalized === '/') {
    throw new Error(`invalid credential isolation ${kind}: ${path}`);
  }
  return normalized;
}

/** Lightweight bwrap used when only the one-way device credential boundary is
 * required and the full file sandbox is off. */
export function buildCredentialOnlySandboxArgs(input: {
  hideDirectories: string[];
  hideFiles: string[];
  readonlyPaths?: string[];
  privateReadonlyDirectories?: Array<{ parent: string; directory: string }>;
  workingDir: string;
  cliBin: string;
  cliArgs: string[];
}): string[] {
  if (!isAbsolute(input.workingDir) || !isAbsolute(input.cliBin)) {
    throw new Error('credential isolation requires absolute cwd and CLI binary paths');
  }
  const hideDirectories = [...new Set(input.hideDirectories.map(path =>
    assertCredentialIsolationPath(path, 'directory')))];
  const hideFiles = [...new Set(input.hideFiles.map(path =>
    assertCredentialIsolationPath(path, 'file')))];
  if (hideDirectories.length === 0 && hideFiles.length === 0) {
    throw new Error('credential isolation requires at least one authority mask');
  }

  const args: string[] = [
    '--bind', '/', '/',
    '--proc', '/proc',
  ];
  for (const entry of input.privateReadonlyDirectories ?? []) {
    const parent = assertCredentialIsolationPath(entry.parent, 'private readonly parent');
    const directory = assertCredentialIsolationPath(
      entry.directory,
      'private readonly directory',
    );
    if (!directory.startsWith(`${parent}/`)) {
      throw new Error(`private readonly directory must be below its parent: ${directory}`);
    }
    // Hide every sibling channel first, then expose only the owning directory.
    // A directory bind (rather than a file bind) observes the worker's atomic
    // rename-based capability rotations without pinning the old inode.
    args.push('--tmpfs', parent, '--ro-bind', directory, directory);
  }
  for (const path of [...new Set(input.readonlyPaths ?? [])].sort()) {
    const normalized = assertCredentialIsolationPath(path, 'readonly path');
    args.push('--ro-bind', normalized, normalized);
  }
  for (const directory of hideDirectories.sort()) args.push('--tmpfs', directory);
  for (const file of hideFiles.sort()) args.push('--ro-bind', '/dev/null', file);
  args.push(
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--new-session',
    '--chdir', input.workingDir,
    '--', input.cliBin, ...input.cliArgs,
  );
  return args;
}

export interface CredentialOnlySandboxSpawn {
  bin: string;
  args: string[];
}

export type HostCredentialIsolationMechanismProbe =
  | { supported: true; mechanism: 'seatbelt' | 'bwrap'; executable: string }
  | { supported: false; mechanism: null; reason: string };

function probeBubblewrapCredentialMasks(): HostCredentialIsolationMechanismProbe {
  const lookup = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  const located = lookup.status === 0 ? lookup.stdout.trim() : '';
  if (!located || !isAbsolute(located)) {
    return { supported: false, mechanism: null, reason: 'bubblewrap is unavailable' };
  }
  let executable = located;
  try { executable = realpathSync(located); } catch { /* spawn probe reports failure below */ }
  const probe = spawnSync(executable, ['--help'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return { supported: false, mechanism: null, reason: 'bubblewrap is unavailable' };
  }
  const runtime = spawnSync(executable, [
    '--bind', '/', '/',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--new-session',
    '--', '/bin/true',
  ], { stdio: 'ignore', timeout: 5_000 });
  if (runtime.status === 0) return { supported: true, mechanism: 'bwrap', executable };
  return {
    supported: false,
    mechanism: null,
    reason: runtime.error?.message
      ? `bubblewrap execution probe failed: ${runtime.error.message}`
      : 'bubblewrap cannot establish the required user/mount/PID namespaces',
  };
}

export function probeHostCredentialIsolationMechanism(): HostCredentialIsolationMechanismProbe {
  if (process.platform === 'darwin') {
    const executable = '/usr/bin/sandbox-exec';
    try {
      if (existsSync(executable) && statSync(executable).isFile()) {
        const probe = spawnSync(executable, ['-h'], { stdio: 'ignore', timeout: 2_000 });
        if (!probe.error) return { supported: true, mechanism: 'seatbelt', executable };
      }
    } catch { /* fail closed below */ }
    return { supported: false, mechanism: null, reason: 'sandbox-exec is unavailable' };
  }
  if (process.platform === 'linux') return probeBubblewrapCredentialMasks();
  return {
    supported: false,
    mechanism: null,
    reason: `credential isolation unsupported on ${process.platform}`,
  };
}

export function credentialOnlySandboxAvailable(): boolean {
  if (process.platform !== 'linux' || !ensureSandboxDeps()) return false;
  const probe = probeBubblewrapCredentialMasks();
  if (probe.supported) return true;
  console.error(`[sandbox] ${probe.reason}`);
  return false;
}

export function prepareCredentialOnlySandbox(input: {
  hideDirectories: string[];
  hideFiles: string[];
  readonlyPaths?: string[];
  privateReadonlyDirectories?: Array<{ parent: string; directory: string }>;
  workingDir: string;
  cliBin: string;
  cliArgs: string[];
}): CredentialOnlySandboxSpawn | null {
  if (process.platform !== 'linux' || !ensureSandboxDeps()) return null;
  const probe = probeBubblewrapCredentialMasks();
  if (!probe.supported || probe.mechanism !== 'bwrap') return null;
  return {
    bin: probe.executable,
    args: buildCredentialOnlySandboxArgs(input),
  };
}

/** Re-expose trusted executable directories hidden below the fresh /run tmpfs. */
export function reexposeRunBinArgs(binPaths: (string | undefined)[]): string[] {
  const dirs = new Set<string>();
  for (const path of binPaths) {
    if (!path || typeof path !== 'string') continue;
    const dir = dirname(path);
    if (dir.startsWith('/run/')) dirs.add(dir);
  }
  const out: string[] = [];
  for (const dir of dirs) out.push('--ro-bind-try', dir, dir);
  return out;
}

/** Canonicalize if possible (Seatbelt/bwrap both resolve symlinks). */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Absolute path to this build's compiled cli.js (dist/cli.js), derived from
 *  this module's own location (dist/adapters/backend/sandbox.js → ../../cli.js).
 *
 *  ⚠️ NOT VALID IN A COMPILED BINARY. There is no cli.js on disk there: the module
 *  graph lives in the virtual, process-private `/$bunfs/`, so both candidates
 *  below resolve against `/$bunfs/root` and collapse onto the real filesystem
 *  root — MEASURED inside a real compiled binary: `/cli.js` and `/dist/cli.js`,
 *  neither existing. Callers must therefore go through `botmuxCliInvocation()` (a
 *  child spawn) or `botmuxShimExecLine()` (a shim handed to another process)
 *  rather than calling this directly. */
function distCliJs(): string {
  const colocated = fileURLToPath(new URL('../../cli.js', import.meta.url));
  if (existsSync(colocated)) return colocated;
  // `bun run daemon` loads this module from src/ through tsx, while the trusted
  // sandbox shim must still execute the built CLI entrypoint.
  return fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
}

/**
 * `#!/bin/sh` body for the in-sandbox `botmux` shim.
 *
 * WHY THIS CANNOT BE ONE FORM FOR BOTH RUNTIMES: the shim is written to the host
 * disk, ro-bound into the sandbox at `/run/sbxbin`, and then executed by a
 * DIFFERENT process inside that sandbox. Two things follow, both MEASURED:
 *
 *   • `/$bunfs/` is process-private — a child sees nothing there, so a compiled
 *     binary emitting `exec node "/dist/cli.js"` produces a shim whose target does
 *     not exist for the only process that will ever run it; and
 *   • `sh` expands the unescaped `$bunfs` inside double quotes to the empty
 *     string, so even the literal path is lost (`"/$bunfs/cli.js"` → `//cli.js`).
 *
 * Verified against a real binary: running the compiled form of this line prints
 * the botmux HELP BANNER and exits 0, so an in-sandbox `botmux send` silently
 * does nothing.
 *
 * The two runtimes genuinely need DIFFERENT values — the source form must name
 * `dist/cli.js` (a compiled binary has no such file) and the compiled form must
 * name the executable itself (`process.execPath`, a real on-disk path even under
 * --compile). Collapsing them is not possible; the guard here is that each branch
 * is exercised by a test, since a wrong shim fails silently.
 *
 * Also note the compiled form drops `node` entirely: re-introducing an
 * interpreter dependency would defeat the point of the self-contained binary, and
 * the sandbox policy does not expose a node.
 */
export function botmuxShimExecLine(): string {
  if (isStandaloneBinary()) {
    return `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`;
  }
  return `#!/bin/sh\nexec node ${JSON.stringify(distCliJs())} "$@"\n`;
}

/**
 * Command + leading args to run this build's CLI as a CHILD of the current
 * process (used by the relay watcher to re-exec `botmux send` on the host).
 *
 * Same split as `src/core/self-spawn.ts`: under Node the script path is required
 * (`node <dist/cli.js> send …`), while the compiled binary dispatches ordinary
 * subcommands itself (`<binary> send …`) and must NOT be handed a script path —
 * verified on a real binary that `<binary> "/dist/cli.js" send …` prints help and
 * exits 0 instead of sending anything.
 */
export function botmuxCliInvocation(cliPathOverride?: string): { command: string; args: string[] } {
  if (cliPathOverride) return { command: process.execPath, args: [cliPathOverride] };
  if (isStandaloneBinary()) return { command: process.execPath, args: [] };
  return { command: process.execPath, args: [distCliJs()] };
}

/** Is the file sandbox globally forced for this daemon? The real per-bot
 *  BotConfig.sandbox flag is decided by the caller. */
export function sandboxEnabled(): boolean {
  return process.env.BOTMUX_SANDBOX === '1';
}

/**
 * Whether this host can run bwrap with a NEW PID namespace + a fresh `/proc`
 * mount — i.e. `bwrap --unshare-pid --proc /proc`. In a NESTED sandbox (e.g.
 * riff's AIO sandbox) mounting a fresh procfs inside a new pid namespace is
 * denied by the kernel: `Can't mount proc on /newroot/proc: Operation not
 * permitted`. When that happens the file sandbox must degrade (drop
 * --unshare-pid) rather than fail every spawn — but ONLY in a context where
 * dropping pid isolation cannot leak a sibling bot's secret via
 * `/proc/<pid>/environ` (see coreOnlyPidNamespaceDegrade below).
 *
 * Probed ONCE per process and cached: it shells out to bwrap and the answer is
 * a fixed property of the host/namespace we booted in. Returns true when the
 * probe cannot run at all (bwrap missing) — the caller only consults this to
 * DECIDE A DEGRADE, and a missing bwrap is handled fail-closed elsewhere; we
 * must not spuriously degrade the normal fleet on an inconclusive probe.
 */
let _canUnsharePid: boolean | undefined;

/** Three-state classification of a single bwrap probe run. The distinction is
 *  load-bearing: only a `clean-nonzero` (bwrap RAN and returned a real verdict)
 *  is evidence about namespace support; a `timeout`/spawn-error/signal is
 *  `inconclusive` and must NEVER be treated as such evidence. */
export type BwrapProbeOutcome = 'success' | 'clean-nonzero' | 'inconclusive';

/**
 * Pure decision for the DUAL pid-ns probe — extracted for unit testing.
 *
 * We must distinguish "this env forbids a fresh /proc mount inside a NEW pid
 * namespace" (the real nested-sandbox condition → safe to drop --unshare-pid)
 * from "bwrap is broken / the probe couldn't run" (must NOT degrade). Two
 * probes, each classified into THREE states (success / clean-nonzero /
 * inconclusive):
 *   - full = `--unshare-user --unshare-pid --proc /proc …` (real sandbox shape)
 *   - weak = same MINUS `--unshare-pid`
 *
 * Degrade IFF `full === 'clean-nonzero' && weak === 'success'` — i.e. bwrap
 * DEFINITIVELY rejected the run WITH a new pid namespace but ACCEPTED it
 * WITHOUT one → removing --unshare-pid is precisely the fix (nested signature).
 * EVERY other combination keeps full isolation (fail-closed):
 *   - full success → no need to degrade
 *   - full inconclusive (timeout / spawn error / signal) → NOT evidence of a
 *     pid-ns restriction, even if weak succeeds → do NOT degrade
 *   - weak not a clean success (nonzero / inconclusive) → bwrap broken for a
 *     reason dropping pid-ns won't fix → do NOT degrade
 *
 * Returns whether the host CAN keep --unshare-pid (true = no degrade).
 */
export function pidNsDualProbeCanUnshare(
  full: BwrapProbeOutcome,
  weak: BwrapProbeOutcome,
): boolean {
  const degrade = full === 'clean-nonzero' && weak === 'success';
  return !degrade;
}

/** Classify a spawnSync result into the three probe states. A spawn error
 *  (ENOENT), a timeout/kill (`signal` set, e.g. SIGTERM), or a null exit status
 *  is `inconclusive` — the probe did not yield a real bwrap verdict. A clean
 *  numeric exit is `success` (0) or `clean-nonzero` (>0). */
function classifyProbe(r: ReturnType<typeof spawnSync>): BwrapProbeOutcome {
  if (r.error || r.signal !== null || r.status === null) return 'inconclusive';
  return r.status === 0 ? 'success' : 'clean-nonzero';
}

export function bwrapCanUnsharePid(): boolean {
  if (_canUnsharePid !== undefined) return _canUnsharePid;
  const lookup = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  const located = lookup.status === 0 ? lookup.stdout.trim() : '';
  if (!located || !isAbsolute(located)) { _canUnsharePid = true; return true; } // inconclusive → don't degrade
  let executable = located;
  try { executable = realpathSync(located); } catch { /* fall through to probe */ }
  // Same SHAPE as the real fs-policy compile (compileToBwrap): --unshare-user
  // is always present there, and its userns interacts with the proc mount, so
  // the probe must carry it too or it isn't testing the real condition.
  const base = ['--dev-bind', '/', '/', '--proc', '/proc', '--unshare-user', '--', '/bin/true'];
  // FULL: real shape WITH --unshare-pid. Nested pid-ns-restricted sandbox →
  // clean-nonzero ("Can't mount proc … Operation not permitted"); normal host
  // → success.
  const full = classifyProbe(spawnSync(executable, ['--unshare-pid', ...base], { stdio: 'ignore', timeout: 5_000 }));
  if (full === 'success') { _canUnsharePid = true; return true; } // full works → never degrade
  // WEAK: same minus --unshare-pid. Only a clean-nonzero full + success weak is
  // the nested signature; a full timeout/spawn-error (inconclusive) never
  // degrades even if weak succeeds.
  const weak = classifyProbe(spawnSync(executable, base, { stdio: 'ignore', timeout: 5_000 }));
  _canUnsharePid = pidNsDualProbeCanUnshare(full, weak);
  return _canUnsharePid;
}

/** Test-only: reset the cached pid-ns probe. */
export function __testOnly_resetPidNamespaceProbe(): void {
  _canUnsharePid = undefined;
}

/**
 * Whether compileToBwrap should DROP `--unshare-pid` for this spawn. Gated on
 * BOTH conditions, deliberately conservative (security review):
 *   1. BOTMUX_CORE_ONLY=1 — core-only synthesizes EXACTLY ONE apiOnly bot
 *      (bot-registry.maybeSynthesizeCoreOnlyConfig), whose worker carries
 *      LARK_APP_SECRET='' (no-transport). There is NO sibling worker holding a
 *      secret in env, so exposing the host pid namespace (a fresh --proc in the
 *      host pid ns enumerates host processes) cannot leak any bot secret via
 *      /proc/<pid>/environ. On a normal/mixed fleet a sibling transport bot's
 *      worker DOES carry the plaintext secret in env (worker-pool.ts:2404), so
 *      --unshare-pid MUST stay — hence this gate never fires there.
 *   2. The host actually can't unshare-pid (nested sandbox) — otherwise keep
 *      full isolation; there's no reason to weaken it when it works.
 * The on-disk credential seal (fs-policy deny masks) is UNCHANGED regardless;
 * only the pid-namespace defense-in-depth is dropped, and only where it both
 * (a) can't work and (b) protects nothing.
 */
export function coreOnlyPidNamespaceDegrade(): boolean {
  return process.env.BOTMUX_CORE_ONLY === '1' && !bwrapCanUnsharePid();
}

/**
 * Whether a LOCAL sandbox engine applies to this backend at all.
 *
 * riff has NO local CLI process to wrap — execution happens entirely in riff's
 * own remote sandbox. Without that bypass the worker's fail-safe "backend not
 * sandboxable" hard error would brick every sandbox-enabled bot the moment it
 * switches to riff. Platform is no longer a factor — fs-policy sandboxes darwin
 * AND linux.
 *
 * mojo is NOT unconditionally remote, and this is the important asymmetry:
 * MojoBackend spawns the `mojo` binary locally on every turn. Only with
 * `cloud: true` do the agent's TOOLS run off-box; `cloud` is optional, and
 * `localDaemon: true` explicitly opts INTO local execution. Treating mojo as
 * remote regardless would silently skip the local sandbox for a bot that asked
 * for `sandbox: true` — a fail-OPEN. So a mojo bypass requires proof of remote
 * execution, and anything else keeps the local sandbox engaged (fail closed).
 */
export function localSandboxApplies(
  backendType: string,
  // `jwtEnv` / `env` are part of the proof: the launcher env decides which binary
  // the next turn actually executes (see mojoUnprovableEnvKeys). A narrower type
  // here silently DROPPED a caller's env and re-opened the bypass.
  remoteExecution?: {
    cloud?: boolean;
    localDaemon?: boolean;
    wrapperCli?: string;
    jwtEnv?: string;
    env?: Record<string, string>;
  },
): boolean {
  if (backendType === 'riff') return false;
  if (backendType === 'mojo') {
    return !isMojoFullyRemote(remoteExecution);
  }
  return true;
}


/** Top-level dirs that are symlinks on usrmerge distros (/bin → usr/bin …) —
 *  replicated inside the tmpfs root so `#!/bin/sh` etc. resolve. */
const USRMERGE_CANDIDATES = ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32'] as const;

/** Basename of the per-session manifest of deny-mask mountpoints the worker
 *  had to CREATE on the host (they didn't pre-exist) so bwrap could bind an
 *  empty mask over them. Persisted (not just held in an in-memory cleanup
 *  closure) because a Linux tmux sandbox can survive a daemon restart — after
 *  restart the close path only knows `sessionRoot`, and without this manifest
 *  the empty host mountpoints would leak forever. Read + acted on by EVERY
 *  teardown path (normal close, reattach-then-close, spawn-failure rollback,
 *  stale sweep) BEFORE the sessionRoot is removed.
 *
 *  TRUST MODEL: the manifest lives inside `sessionRoot`, which the policy makes
 *  a MANDATORY deny in-sandbox (only the outbox is a nested RW carve-out), so a
 *  sandboxed CLI cannot read or rewrite it. But it can be reached OUT of band
 *  (a custom data dir under the project, a future policy hole), so cleanup does
 *  NOT trust the self-reported path as a delete authorization: each entry also
 *  records the (dev, ino) captured at creation, and cleanup re-`lstat`s and
 *  removes ONLY when the on-disk inode still matches. That defeats both a
 *  swapped manifest pointing at a victim path AND the "empty mountpoint deleted,
 *  a new empty object created at the same path" reuse race. */
const MASK_MANIFEST_NAME = 'mask-mounts.json';

interface MaskMountEntry {
  path: string;
  kind: 'dir' | 'file';
  /** Host device + inode captured right after WE created the mountpoint. The
   *  delete-time identity check: only remove if lstat still reports these. */
  dev: number;
  ino: number;
}

/** Atomically persist the created-mountpoint manifest (0600). Returns false on
 *  failure so the caller can FAIL CLOSED (roll back + abort spawn) rather than
 *  start a session whose pre-created host mountpoints could later leak. */
function writeMaskManifest(sessionRoot: string, created: MaskMountEntry[]): boolean {
  if (!created.length) return true;
  try {
    atomicWriteFileSync(join(sessionRoot, MASK_MANIFEST_NAME), JSON.stringify(created), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Reclaim a list of created-mountpoint entries (the IN-MEMORY truth). Runs on
 *  ALL teardown paths — normal close reads the entries back from the manifest,
 *  spawn-failure rollback passes the in-memory accumulator directly (the
 *  manifest may never have been written). Fail-safe & NON-RECURSIVE:
 *  - rejects any entry whose path is non-absolute, contains `..`, or is a
 *    symlink on disk (a swapped entry can't trick us into deleting elsewhere);
 *  - IDENTITY-BINDS: removes only when the on-disk (dev, ino) still matches what
 *    WE recorded at creation — so a tampered manifest pointing at a pre-existing
 *    victim, or a path whose empty object was replaced after we created ours,
 *    is left untouched;
 *  - a dir is removed with `rmdir` only (throws ENOTEMPTY if the host/a
 *    concurrent process wrote into it → content preserved, never rm -rf);
 *  - a file is `unlink`ed only when it is a regular, zero-byte file.
 *  Entries are processed in order; the caller records them deepest-first so a
 *  child is removed before its now-empty parent. */
function reclaimMaskEntries(entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const { path, kind, dev, ino } = e as MaskMountEntry;
    if (typeof path !== 'string' || !isAbsolute(path)) continue;
    if (path.split('/').includes('..')) continue;
    if (kind !== 'dir' && kind !== 'file') continue;
    if (typeof dev !== 'number' || typeof ino !== 'number') continue; // pre-identity / forged → refuse
    let st;
    try { st = lstatSync(path); } catch { continue; } // already gone
    if (st.isSymbolicLink()) continue;                     // never follow a swapped symlink
    if (st.dev !== dev || st.ino !== ino) continue;        // not the object WE created → leave it
    try {
      if (kind === 'dir' && st.isDirectory()) {
        rmdirSync(path); // rmdir — throws ENOTEMPTY if host wrote into it → kept
      } else if (kind === 'file' && st.isFile() && st.size === 0) {
        unlinkSync(path); // unlink a still-empty placeholder only
      }
    } catch { /* non-empty / concurrent write / perms → leave it, never recurse */ }
  }
}

/** Reclaim the empty deny-mask mountpoints recorded in the persisted manifest,
 *  then (implicitly) the manifest goes with the sessionRoot. Used by the NORMAL
 *  teardown paths (close, reattach-close, stale sweep) — where the manifest was
 *  written successfully. Spawn-failure rollback does NOT use this (it can't
 *  trust a manifest that may never have been written); it passes the in-memory
 *  accumulator to reclaimMaskEntries directly. MUST run BEFORE removing
 *  sessionRoot (which holds the manifest). */
function reclaimMaskMounts(sessionRoot: string): void {
  const manifestPath = join(sessionRoot, MASK_MANIFEST_NAME);
  let raw: string;
  try { raw = readFileSync(manifestPath, 'utf8'); } catch { return; } // none created / already gone
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return; }
  reclaimMaskEntries(entries);
}

/** Spawn-setup rollback: reclaim the mountpoints we pre-created FROM THE
 *  IN-MEMORY accumulator (NOT the manifest — on the failure paths the manifest
 *  may never have been written, so reading it back would reclaim nothing and
 *  leak every created ancestor), then drop the per-session tree. Used when
 *  prepareDirectSandbox bails after masks were materialised (a mkdir/write
 *  threw mid-way, the MCP gateway socket check fails, or the manifest write
 *  itself fails). */
function rollbackSandboxSetup(sessionRoot: string, createdMasks: MaskMountEntry[]): void {
  reclaimMaskEntries(createdMasks);
  try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
}

/** Create a mask mountpoint on the host (all missing ancestors too), pushing
 *  EACH level we actually create — deepest first — into the caller-owned
 *  `sink` accumulator IMMEDIATELY (before attempting the next level), each with
 *  its (dev, ino). This is what lets rollback reclaim partially-created chains:
 *  if a deeper level throws (e.g. ENAMETOOLONG on the leaf), every ancestor we
 *  already made is already in `sink` for the caller's rollback. `kind` applies
 *  to the leaf; ancestors are always dirs. No-op when the leaf already exists
 *  (a pre-existing host path is never our cleanup target). Throws on failure so
 *  the caller can fail closed — with `sink` holding whatever succeeded. */
function createMaskMount(leaf: string, kind: 'dir' | 'file', sink: MaskMountEntry[]): void {
  if (existsSync(leaf)) return; // pre-existing host path — never our cleanup target
  // Walk up to the shallowest missing ancestor, creating each level so we can
  // record + later reclaim exactly what WE added (mkdir recursive would create
  // them but hide which levels were ours).
  const toCreate: string[] = [];
  let p = leaf;
  while (!existsSync(p)) {
    toCreate.push(p);
    const parent = dirname(p);
    if (parent === p) break; // reached '/'
    p = parent;
  }
  toCreate.reverse(); // shallowest → deepest so mkdir parents exist first
  for (let i = 0; i < toCreate.length; i++) {
    const path = toCreate[i]!;
    const isLeaf = i === toCreate.length - 1;
    if (isLeaf && kind === 'file') writeFileSync(path, '');
    else mkdirSync(path);
    const st = lstatSync(path);
    // record deepest-first (unshift) so teardown removes children before parents
    // — and record IMMEDIATELY so a throw on the next level still leaves this
    // one visible to the caller's rollback.
    sink.unshift({ path, kind: isLeaf ? kind : 'dir', dev: st.dev, ino: st.ino });
  }
}

// Test-only surface for the deny-mask lifecycle (trust-boundary regression
// coverage: manifest tamper defense, dev+ino identity, multi-level cleanup,
// partial-create rollback).
export const __testOnly_maskMounts = {
  MASK_MANIFEST_NAME,
  createMaskMount,
  writeMaskManifest,
  reclaimMaskMounts,
  reclaimMaskEntries,
};

export interface DirectSandboxSpawn {
  /** Replace the CLI binary with this (always 'bwrap'). */
  bin: string;
  /** bwrap args + '--' + original (bin, ...args). */
  args: string[];
  /** Env overrides to merge into childEnv (HOME, PATH, BOTMUX_SEND_RELAY, proxies). */
  env: Record<string, string>;
  /** Outbox dir the daemon watcher must service. */
  outbox: string;
  /** Remove the per-session sandbox tree (plain rm — no mounts exist). */
  cleanup: () => void;
}

/**
 * Build the bwrap DIRECT-mode spawn for a CLI session, or return null when the
 * runtime deps are unavailable / setup fails (fail-safe: the worker treats
 * null as a hard error and never silently runs unsandboxed).
 *
 * Layout under <dataDir>/sandboxes/<sessionId>/: outbox, shimbin, empties.
 * No overlays, no upper/work dirs — writes inside readWrite zones hit the
 * real filesystem directly.
 */
export function prepareDirectSandbox(opts: {
  sessionId: string;
  dataDir: string;
  /** Compile-ready policy (canonical + existence-filtered by the worker). */
  policy: FsPolicy;
  /** Child chdir (the canonical project working dir). */
  chdir: string;
  /** Canonical $HOME to set for the child. */
  home: string;
  cliBin: string;
  cliArgs: string[];
  /** Absolute Botmux command paths already persisted in CLI MCP configs.
   * Bind the worker-generated relay shim at those exact paths so a stale or
   * tampered host wrapper cannot replace the trusted gateway entry. */
  trustedBotmuxCommandPaths?: readonly string[];
  /** Worker-owned Unix socket for the credential-bearing MCP Gateway. */
  mcpGatewaySocketPath?: string;
  /** CANONICAL lark-cli data root (the parent of the frozen keystore dir, i.e.
   *  `dirname(larkCliLinuxStore)`) the worker resolved + nearest-ancestor-canonicalized.
   *  Pinned into the child as LARKSUITE_CLI_DATA_DIR so the in-sandbox lark-cli resolves
   *  the SAME keystore the policy denied/carved-out — NOT the lexical env value, which on a
   *  symlinked data root resolves to an unbound path inside the sandbox (ENOENT → auth
   *  breaks) or a namespace the policy never anchored. Absent/empty →
   *  unset in the child (default store, matching the policy's default resolution). */
  larkCliDataDir?: string | null;
}): DirectSandboxSpawn | null {
  if (process.platform !== 'linux') return null;
  if (!ensureSandboxDeps()) return null;

  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const empties = join(sessionRoot, 'empties');
  // A single, always-empty directory ro-bound over DIRECTORY-shaped deny rules
  // (real content hidden + read-only mount). Kept empty for the session's life.
  const emptyDir = join(sessionRoot, 'empty');
  for (const d of [outbox, shimBin, empties, emptyDir]) mkdirSync(d, { recursive: true });

  // `botmux` shim → THIS build's cli.js so in-sandbox `botmux send` hits relay
  // mode (and never needs bots.json, which the policy doesn't expose).
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, botmuxShimExecLine());
  chmodSync(shim, 0o755);

  // usrmerge symlinks to replicate; deny rules that are FILES on the host need
  // a file-shaped mask, everything else (existing dir OR a not-yet-existing
  // path) is masked as a directory. We do NOT skip absent denies: leaving a
  // denied path unmasked inside a read-write parent let the sandbox mkdir+write
  // it onto the host and read anything created there mid-session (a TOCTOU).
  const symlinks: { path: string; target: string }[] = [];
  for (const p of USRMERGE_CANDIDATES) {
    try {
      if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) });
    } catch { /* absent on this distro */ }
  }
  const filePaths = new Set<string>();
  for (const r of opts.policy.rules) {
    if (r.access !== 'deny') continue;
    try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* absent → dir-shaped mask */ }
  }

  const compiled = compileToBwrap(opts.policy, { symlinks, emptyDir, emptiesDir: empties, filePaths, chdir: opts.chdir, skipPidNamespace: coreOnlyPidNamespaceDegrade() });
  // The shared empty dir + every empty placeholder file are the ro-bind SOURCES
  // for deny masks: real content hidden + read-only. mode 000 additionally makes
  // the mask unlistable for a NON-root uid (a real deny, not a listable "empty");
  // a root uid bypasses DAC (CAP_DAC_OVERRIDE) and can traverse it, but the source
  // is an EMPTY dir/file so no real content is exposed either way — emptiness, not
  // the permission bits, is the load-bearing guarantee.
  try { chmodSync(emptyDir, 0o000); } catch { /* */ }
  for (const f of compiled.emptyFiles) {
    try { writeFileSync(f.path, '', { mode: 0o000 }); } catch { /* */ }
  }
  // bwrap cannot bind onto a MISSING target, and a missing target under a
  // read-write parent would make bwrap materialise it on the host anyway (true
  // for BOTH the ro-bind and the tmpfs mask branches). So pre-create every mask
  // mountpoint that doesn't already exist — recording EACH host level we create
  // (leaf + any missing ancestors, with dev+ino identity) in a persisted
  // manifest so any teardown path (incl. after a daemon restart, when only
  // sessionRoot is known) can rmdir/unlink-if-empty exactly those, never a user
  // path. Pre-creating a DIRECTORY for a not-yet-existing deny also blocks the
  // host from later creating a same-named FILE there — fail-closed, an accepted
  // compat cost of never leaking a denied path.
  //
  // FAIL CLOSED: if creating a mountpoint OR persisting the manifest fails, roll
  // back everything and abort the spawn — starting the session anyway would
  // either break the mask (bwrap bind fails) or leak host mountpoints with no
  // record to reclaim them.
  const createdMasks: MaskMountEntry[] = [];
  try {
    for (const m of compiled.maskMounts) {
      // createMaskMount pushes each level into createdMasks IMMEDIATELY, so a
      // mid-chain throw still leaves the partial ancestors visible for rollback.
      createMaskMount(m.path, m.kind, createdMasks);
    }
  } catch (err) {
    rollbackSandboxSetup(sessionRoot, createdMasks);
    console.error(`[sandbox] failed to pre-create deny mask mountpoint (${(err as Error)?.message ?? err}) — aborting spawn (fail closed)`);
    return null;
  }
  if (!writeMaskManifest(sessionRoot, createdMasks)) {
    rollbackSandboxSetup(sessionRoot, createdMasks);
    console.error('[sandbox] failed to persist deny-mask cleanup manifest — aborting spawn (fail closed)');
    return null;
  }

  const args = [...compiled.args];
  // Shim bin at a fixed path under the fresh /run tmpfs — appended after the
  // rule mounts (later mount wins over the tmpfs). PATH points here first.
  args.push('--ro-bind', shimBin, '/run/sbxbin');
  // Overlay the shim onto every configured absolute `botmux` command path so an
  // in-sandbox call by absolute path also reaches relay mode.
  //
  // ⚠️ EXCEPT when that path IS this executable. install.sh moves the compiled
  // binary to `~/.botmux/bin/botmux` (install.sh:106) and the daemon runs from
  // there, while `trustedBotmuxCommandPaths` defaults to exactly that path
  // (gateway-installer.ts — `BOTMUX_BIN_PATH` has no writer anywhere, so the
  // default is what production uses). Binding the shim over it makes the shim's
  // own `exec "<process.execPath>"` resolve back to the shim: MEASURED with bwrap,
  // the real binary never runs and the process ends in SILENT exit 0 (the kernel
  // caps shebang recursion and gives up), i.e. an in-sandbox `botmux send` looks
  // like it worked and sent nothing — the exact failure class this whole change
  // exists to remove.
  //
  // Skipping the overlay is safe: `execPaths` always contains
  // `dirname(canonical(process.execPath))` (worker.ts), so the real binary is
  // already reachable inside the sandbox, and an absolute-path call lands on it
  // directly. The PATH-shaped `botmux` still goes through `/run/sbxbin`, and relay
  // mode is driven by env (BOTMUX_SANDBOX_OUTBOX etc.), not by which file answers
  // the call. The npm layout — where the launcher and the platform binary are
  // different files — still gets the overlay.
  let selfExec: string | undefined;
  try { selfExec = realpathSync(process.execPath); } catch { selfExec = undefined; }
  for (const rawTarget of [...new Set(opts.trustedBotmuxCommandPaths ?? [])]) {
    if (typeof rawTarget !== 'string' || !isAbsolute(rawTarget)) continue;
    const target = resolve(rawTarget);
    try {
      if (!lstatSync(target).isFile()) continue;
      // Compare resolved paths: either side may be reached through a symlink.
      if (selfExec !== undefined && realpathSync(target) === selfExec) continue;
      args.push('--ro-bind', shim, target);
    } catch { /* missing/stale config target — PATH shim remains available */ }
  }

  let sandboxMcpGatewaySocketPath: string | undefined;
  if (opts.mcpGatewaySocketPath) {
    try {
      const socketPath = resolve(opts.mcpGatewaySocketPath);
      if (!lstatSync(socketPath).isSocket()) { rollbackSandboxSetup(sessionRoot, createdMasks); return null; }
      const hostDir = realpathSync(dirname(socketPath));
      const sandboxDir = '/run/botmux-mcp';
      args.push('--dir', sandboxDir, '--ro-bind', hostDir, sandboxDir);
      sandboxMcpGatewaySocketPath = join(sandboxDir, basename(socketPath));
    } catch {
      // Spawn-setup failure AFTER mask mountpoints were pre-created: reclaim the
      // empty ones (from the in-memory list) and drop the tree so nothing leaks.
      rollbackSandboxSetup(sessionRoot, createdMasks);
      return null;
    }
  }

  // Authoritative child env via bwrap --setenv (works on pty AND tmux — the
  // tmux backend only forwards a fixed whitelist).
  //
  // PATH: the fresh tmpfs root binds executable dirs at their CANONICAL host
  // paths (the policy's readOnly exec rules are realpath'd by the worker). The
  // host's own $PATH is LEXICAL and can point at symlink-form dirs (e.g.
  // ~/.local/bin → a shared-drive/fnm/nvm path) that don't exist in the fresh
  // root — so the trusted `botmux` shim's bare `node` would fail `not found`
  // and the MCP gateway would exit (Connection closed). Prepend the canonical
  // dirs of node + the CLI bin (deduped) so bare-name resolution always hits a
  // bound path, THEN keep the host PATH as a lexical fallback.
  const canonicalExecDirs: string[] = [];
  const pushExecDir = (p: string | undefined) => {
    if (!p) return;
    try {
      const dir = dirname(realpathSync(p));
      if (isAbsolute(dir) && !canonicalExecDirs.includes(dir)) canonicalExecDirs.push(dir);
    } catch { /* unresolvable — skip */ }
  };
  pushExecDir(process.execPath); // node
  pushExecDir(opts.cliBin);      // the CLI binary
  const env: Record<string, string> = {
    HOME: opts.home,
    BOTMUX_SEND_RELAY: outbox,
    PATH: ['/run/sbxbin', ...canonicalExecDirs, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
  if (process.env.BOTMUX_DAEMON_IPC_PORT) {
    env.BOTMUX_DAEMON_IPC_PORT = process.env.BOTMUX_DAEMON_IPC_PORT;
  }
  if (sandboxMcpGatewaySocketPath) {
    env[MCP_GATEWAY_SOCKET_ENV] = sandboxMcpGatewaySocketPath;
    env[MCP_GATEWAY_REQUIRED_ENV] = '1';
  }
  for (const k of PROXY_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  args.push('--unsetenv', 'BOTS_CONFIG');
  args.push('--unsetenv', 'BOTMUX_HOST_RELAY_AUTHORIZED');
  // LARKSUITE_CLI_DATA_DIR relocates the lark-cli keystore dir on Linux to
  // `<value>/lark-cli`. Pin the child to the CANONICAL data root the worker resolved
  // (opts.larkCliDataDir = dirname of the frozen keystore dir) so the in-sandbox lark-cli
  // opens EXACTLY the keystore the policy denied/carved-out — same canonical namespace,
  // not the lexical env value (which on a symlinked data root resolves to an unbound path
  // inside the sandbox → ENOENT/auth-break, or a namespace the policy never anchored).
  // Absent → unset so the child falls back to $HOME/.local/share,
  // matching the policy's default resolution. Authoritative: applied last, and bwrap has
  // no --clearenv so this overrides any inherited/rc-injected value.
  if (opts.larkCliDataDir && opts.larkCliDataDir.startsWith('/')) {
    args.push('--setenv', 'LARKSUITE_CLI_DATA_DIR', opts.larkCliDataDir);
  } else {
    args.push('--unsetenv', 'LARKSUITE_CLI_DATA_DIR');
  }
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  // Canonicalize the CLI binary before execvp: on a symlinked-$HOME host
  // (e.g. /home/u → /data00/home/u shared-drive mount) the worker hands us the
  // lexical path (~/.local/bin/claude → /home/u/.local/bin/claude), but the
  // sandbox only binds CANONICAL exec dirs (/data00/...). The lexical /home/u
  // prefix does not exist in the fresh bwrap root, so bwrap's execvp fails with
  // "No such file or directory" and the CLI never starts (pane dies instantly).
  // realpath makes the exec target land on a bound path. Best-effort: an
  // unresolvable path falls back to the lexical form (bwrap will fail-closed).
  let execBin = opts.cliBin;
  try { execBin = realpathSync(opts.cliBin); } catch { /* keep lexical; spawn fails closed */ }
  args.push('--', execBin, ...opts.cliArgs);

  return {
    bin: 'bwrap',
    args,
    env,
    outbox,
    cleanup: () => {
      // Reclaim empty deny-mask mountpoints we created on the host BEFORE
      // dropping the manifest with the rest of the tree.
      reclaimMaskMounts(sessionRoot);
      try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/**
 * Re-attach the daemon/worker side to an ALREADY-spawned sandbox session (a
 * live bwrap'd CLI surviving in a tmux/herdr/zellij pane across a daemon
 * restart). Only the outbox path is needed back so the watcher keeps servicing
 * the live CLI's `botmux send`, plus a cleanup that removes the tree at
 * close/exit. Returns null if the session has no sandbox tree on disk (never
 * sandboxed). Linux-only, mirrors prepareDirectSandbox's layout.
 */
export function attachSandboxOutbox(opts: { sessionId: string; dataDir: string }): { outbox: string; cleanup: () => void } | null {
  if (process.platform !== 'linux') return null;
  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  if (!existsSync(sessionRoot)) return null; // never sandboxed
  const outbox = join(sessionRoot, 'outbox');
  try { mkdirSync(outbox, { recursive: true }); } catch { /* */ }
  return {
    outbox,
    cleanup: () => {
      // Reclaim empty deny-mask mountpoints we created on the host BEFORE
      // dropping the manifest with the rest of the tree.
      reclaimMaskMounts(sessionRoot);
      try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/** Scan the process table for sandbox session-ids referenced by any running
 *  process's argv (a live bwrap's bind paths contain `sandboxes/<sid>`). Hard
 *  guard so the sweep never deletes an outbox out from under a live CLI whose
 *  session record was lost — the outbox is bind-mounted INTO the live sandbox,
 *  so removing the host-side source would break its relay. */
function liveSandboxSids(): Set<string> {
  const live = new Set<string>();
  let pids: string[];
  try { pids = readdirSync('/proc'); } catch { return live; }
  const re = /sandboxes\/([^/\0]+)/g;
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
 * Reclaim leaked per-session sandbox trees (outbox/shim/empties of sessions
 * that no longer exist) — plain directory residue in the direct model, no
 * mounts. Guards: never touch an ACTIVE session's tree (it may be suspended,
 * intending to resume — its outbox must survive) and never touch a tree
 * referenced by a live process (a reattached pane whose session record was
 * lost). Safe to call repeatedly: wired at daemon bootstrap AND on a periodic
 * timer.
 */
export function sweepOrphanSandboxes(dataDir: string, activeSessionIds: Set<string>): void {
  const root = join(canonical(dataDir), 'sandboxes');
  let sids: string[] = [];
  try { sids = readdirSync(root); } catch { return; } // no sandboxes dir yet
  // Grace so a worker mid-spawn (dirs created a few syscalls before the CLI
  // process appears in /proc) can't have its outbox swept.
  const GRACE_MS = 60_000;
  const now = Date.now();
  const live = liveSandboxSids();
  for (const sid of sids) {
    if (live.has(sid)) continue;              // a running process holds this tree
    if (activeSessionIds.has(sid)) continue;  // active (possibly suspended) session
    const sessionRoot = join(root, sid);
    let ageOk = false;
    try { ageOk = now - statSync(sessionRoot).mtimeMs > GRACE_MS; } catch { ageOk = false; }
    if (!ageOk) continue;
    // Reclaim empty deny-mask mountpoints recorded in this tree's manifest
    // BEFORE removing the tree (which holds the manifest). Only runs once we've
    // confirmed no live bwrap references the sid (liveSandboxSids above).
    reclaimMaskMounts(sessionRoot);
    try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─────────────────────── botmux send / dispatch relay ───────────────────────

// Relay request schema (written by cli.ts relaySend, validated here). The
// watcher NEVER executes sandbox-supplied argv — it rebuilds the command from
// these validated fields. This is the security boundary: a malicious agent can
// write any outbox file, so everything here is treated as untrusted.
//   { contentFile: <basename>, preparedContentFile?: <basename>, cardFile?: <basename>, ... }
export interface RelayRequest {
  command?: unknown;
  contentFile?: unknown;
  preparedContentFile?: unknown;
  cardFile?: unknown;
  attachments?: unknown;
  videos?: unknown;
  videoCovers?: unknown;
  flags?: unknown;
  originTurnId?: unknown;
  originDispatchAttempt?: unknown;
  originCapability?: unknown;
}
// Presentation-only flags the sandbox may pass through. Path-bearing flags
// (--content-file/--file(s)/--image(s)/--video(s)), routing flags
// (--chat-id/--into/--top-level), and --session-id are NOT allowlisted:
// content/attachments come from validated outbox files, and session-id is
// forced by the worker.
const RELAY_FLAGS_NOVAL = new Set(['--mention-back', '--no-mention', '--no-quote', '--voice', '--slash']);
const RELAY_FLAGS_VAL = new Set(['--mention', '--quote', '--response-kind', '--layout']);

export interface ValidatedRelay {
  command: 'send' | 'dispatch';
  contentName: string;
  preparedContentName?: string;
  cardName?: string;
  attachmentNames: string[];
  videoNames: string[];
  videoCoverNames: string[];
  flags: string[];
  originTurnId?: string;
  originDispatchAttempt?: number;
  originCapability?: string;
}

/**
 * PURE validation of an outbox relay request (schema + flag allowlist only — no
 * filesystem access, so it's deterministically testable):
 *  - contentFile/preparedContentFile/cardFile/attachments/videos/videoCovers
 *    must be plain basenames (no `/`, `\`, `..`).
 *  - only allowlisted presentation flags pass; any other flag → reject (this
 *    rejects raw `--content-file`/`--session-id`/path flags etc.).
 * The TOCTOU-safe filesystem read is handled separately by materializeOutboxFile,
 * NOT here — this function deliberately resolves no paths.
 */
export function validateRelayRequest(req: RelayRequest): { ok: true; value: ValidatedRelay } | { ok: false; error: string } {
  const safeName = (n: unknown): n is string =>
    typeof n === 'string' && !!n && !n.includes('/') && !n.includes('\\') && !n.includes('..');

  if (!safeName(req.contentFile)) return { ok: false, error: 'contentFile must be a plain outbox basename' };
  const preparedContentName = req.preparedContentFile === undefined
    ? undefined
    : safeName(req.preparedContentFile)
      ? req.preparedContentFile
      : null;
  if (preparedContentName === null) {
    return { ok: false, error: 'preparedContentFile must be a plain outbox basename' };
  }
  const cardName = req.cardFile === undefined
    ? undefined
    : safeName(req.cardFile)
      ? req.cardFile
      : null;
  if (cardName === null) return { ok: false, error: 'cardFile must be a plain outbox basename' };
  const attachmentNames: string[] = [];
  for (const a of Array.isArray(req.attachments) ? req.attachments : []) {
    if (!safeName(a)) return { ok: false, error: 'attachment must be a plain outbox basename' };
    attachmentNames.push(a);
  }
  const videoNames: string[] = [];
  for (const a of Array.isArray(req.videos) ? req.videos : []) {
    if (!safeName(a)) return { ok: false, error: 'video must be a plain outbox basename' };
    videoNames.push(a);
  }
  const videoCoverNames: string[] = [];
  for (const a of Array.isArray(req.videoCovers) ? req.videoCovers : []) {
    if (!safeName(a)) return { ok: false, error: 'video cover must be a plain outbox basename' };
    videoCoverNames.push(a);
  }
  const command = req.command === undefined || req.command === 'send'
    ? 'send'
    : req.command === 'dispatch'
      ? 'dispatch'
      : null;
  if (command === null) return { ok: false, error: 'command must be send or dispatch' };
  if (command === 'dispatch' && (
    preparedContentName !== undefined
    || cardName !== undefined
    || attachmentNames.length > 0
    || videoNames.length > 0
    || videoCoverNames.length > 0
  )) {
    return { ok: false, error: 'dispatch relay does not accept cards or attachments' };
  }
  const flags: string[] = [];
  const rawFlags = Array.isArray(req.flags) ? req.flags : [];
  const dispatchValueFlags = new Set(['--title', '--bot-app', '--chat-id']);
  for (let i = 0; i < rawFlags.length; i++) {
    const f = rawFlags[i];
    if (typeof f !== 'string') return { ok: false, error: 'flag must be a string' };
    if (command === 'dispatch') {
      if (f === '--steer') { flags.push(f); continue; }
      if (!dispatchValueFlags.has(f)) return { ok: false, error: `dispatch flag not allowed: ${f}` };
      const v = rawFlags[i + 1];
      if (typeof v !== 'string' || !v || v.startsWith('--') || v.length > 512) {
        return { ok: false, error: `dispatch flag ${f} needs a bounded string value` };
      }
      if (f === '--bot-app' && !/^cli_[A-Za-z0-9_-]{1,128}(?::[^\0]{1,200})?$/.test(v)) {
        return { ok: false, error: 'dispatch --bot-app must be a stable app id' };
      }
      if (f === '--chat-id' && !/^oc_[A-Za-z0-9_-]{1,128}$/.test(v)) {
        return { ok: false, error: 'dispatch --chat-id is invalid' };
      }
      flags.push(f, v); i++; continue;
    }
    if (RELAY_FLAGS_NOVAL.has(f)) { flags.push(f); continue; }
    if (RELAY_FLAGS_VAL.has(f)) {
      const v = rawFlags[i + 1];
      if (typeof v !== 'string') return { ok: false, error: `flag ${f} needs a string value` };
      // The value must NOT itself be a flag — else a sandbox could pass
      // ['--mention','--session-id'] and have --session-id swallowed as the
      // value, corrupting the worker-forced session-id (self-DoS).
      if (v.startsWith('--')) return { ok: false, error: `flag ${f} value must not be a flag` };
      if (f === '--response-kind' && !['progress', 'final', 'auxiliary'].includes(v)) {
        return { ok: false, error: 'flag --response-kind must be progress, final, or auxiliary' };
      }
      if (f === '--layout' && !['result', 'progress', 'risk', 'blocked', 'handoff'].includes(v)) {
        return { ok: false, error: 'flag --layout must be result, progress, risk, blocked, or handoff' };
      }
      flags.push(f, v); i++; continue;
    }
    return { ok: false, error: `flag not allowed: ${f}` };
  }
  const originTurnId = req.originTurnId === undefined
    ? undefined
    : typeof req.originTurnId === 'string' && req.originTurnId.trim() && req.originTurnId.length <= 256
      ? req.originTurnId
      : null;
  if (originTurnId === null) return { ok: false, error: 'originTurnId must be a non-empty bounded string' };
  const originDispatchAttempt = req.originDispatchAttempt === undefined
    ? undefined
    : typeof req.originDispatchAttempt === 'number'
      && Number.isSafeInteger(req.originDispatchAttempt)
      && req.originDispatchAttempt > 0
      ? req.originDispatchAttempt
      : null;
  if (originDispatchAttempt === null) return { ok: false, error: 'originDispatchAttempt must be a positive safe integer' };
  if (originDispatchAttempt !== undefined && originTurnId === undefined) {
    return { ok: false, error: 'originDispatchAttempt requires originTurnId' };
  }
  const originCapability = req.originCapability === undefined
    ? undefined
    : typeof req.originCapability === 'string'
      && /^[a-f0-9]{32,128}$/i.test(req.originCapability)
      ? req.originCapability
      : null;
  if (originCapability === null) return { ok: false, error: 'originCapability must be a bounded hex token' };
  return {
    ok: true,
    value: {
      command,
      contentName: req.contentFile,
      preparedContentName,
      cardName,
      attachmentNames,
      videoNames,
      videoCoverNames,
      flags,
      ...(originTurnId !== undefined ? { originTurnId } : {}),
      ...(originDispatchAttempt !== undefined ? { originDispatchAttempt } : {}),
      ...(originCapability !== undefined ? { originCapability } : {}),
    },
  };
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
export function buildRelayHostEnv(
  baseEnv: NodeJS.ProcessEnv,
  preparedContentFile?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.BOTMUX_SEND_RELAY;
  delete env.BOTMUX_CARD_PREPARED_CONTENT_FILE;
  delete env.BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER;
  if (preparedContentFile) {
    env.BOTMUX_CARD_LOCAL_LINK_MODE = 'disabled';
    env.BOTMUX_CARD_PREPARED_CONTENT_FILE = preparedContentFile;
  } else {
    // A hand-written/incomplete relay request must never fall back to host
    // filesystem probes. It may lose relative-path disambiguation, but cannot
    // turn the worker into a host existence oracle.
    env.BOTMUX_CARD_LOCAL_LINK_MODE = 'lexical';
  }
  return env;
}

export function startOutboxWatcher(
  outbox: string,
  baseEnv: NodeJS.ProcessEnv,
  sessionId: string,
  opts: {
    /** Host-side authorization for a relay's claimed origin capability. When
     *  absent the relay still runs, but carries NO durable origin — a missing
     *  hook must never let the sandbox promote its own origin fields. */
    authorize?: (claim: { capability?: string }) =>
      | {
          ok: true;
          origin: {
            turnId?: string;
            dispatchAttempt?: number;
            /** The worker matched an unsettled Codex App ledger entry. The
             * host child must still find that exact entry before any provider
             * side effect; terminal settlement/revocation between authorize
             * and re-exec therefore fails closed instead of degrading to an
             * ordinary mutable-session send. */
            requiresCodexAppLedger?: boolean;
          };
        }
      | { ok: false; error: string };
    cliPath?: string;
  } = {},
): () => void {
  const cliInvocation = botmuxCliInvocation(opts.cliPath);
  const authorize = opts.authorize;
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
      const authorization = authorize?.({ capability: v.value.originCapability });
      if (authorization && !authorization.ok) {
        finish(id, reqPath, name, staged, 2, '', `relay rejected: ${authorization.error}`);
        continue;
      }

      try { mkdirSync(staging, { recursive: true }); } catch { /* */ }
      // Materialize content (TOCTOU-safe) into the private staging dir.
      const contentDest = join(staging, `${id}.content`);
      if (!materializeOutboxFile(outbox, v.value.contentName, contentDest)) {
        finish(id, reqPath, name, staged, 1, '', 'relay rejected: content not a regular file in outbox');
        continue;
      }
      staged.push(contentDest);
      let preparedContentPath: string | undefined;
      if (v.value.preparedContentName) {
        preparedContentPath = join(staging, `${id}.card-content`);
        if (!materializeOutboxFile(outbox, v.value.preparedContentName, preparedContentPath)) {
          finish(id, reqPath, name, staged, 1, '', 'relay rejected: prepared content not a regular file in outbox');
          continue;
        }
        staged.push(preparedContentPath);
      }
      let cardPath: string | undefined;
      if (v.value.cardName) {
        cardPath = join(staging, `${id}.card.json`);
        if (!materializeOutboxFile(outbox, v.value.cardName, cardPath)) {
          finish(id, reqPath, name, staged, 1, '', 'relay rejected: card not a regular file in outbox');
          continue;
        }
        staged.push(cardPath);
      }
      let attBad = false;
      const attPaths: string[] = [];
      v.value.attachmentNames.forEach((an, i) => {
        if (attBad) return;
        const dest = join(staging, `${id}-att${i}-${an}`);
        if (!materializeOutboxFile(outbox, an, dest)) { attBad = true; return; }
        staged.push(dest); attPaths.push(dest);
      });
      if (attBad) { finish(id, reqPath, name, staged, 1, '', 'relay rejected: attachment not a regular file in outbox'); continue; }
      let videoBad = false;
      const videoPaths: string[] = [];
      v.value.videoNames.forEach((vn, i) => {
        if (videoBad) return;
        const dest = join(staging, `${id}-video${i}-${vn}`);
        if (!materializeOutboxFile(outbox, vn, dest)) { videoBad = true; return; }
        staged.push(dest); videoPaths.push(dest);
      });
      if (videoBad) { finish(id, reqPath, name, staged, 1, '', 'relay rejected: video not a regular file in outbox'); continue; }
      let coverBad = false;
      const videoCoverPaths: string[] = [];
      v.value.videoCoverNames.forEach((cn, i) => {
        if (coverBad) return;
        const dest = join(staging, `${id}-video-cover${i}-${cn}`);
        if (!materializeOutboxFile(outbox, cn, dest)) { coverBad = true; return; }
        staged.push(dest); videoCoverPaths.push(dest);
      });
      if (coverBad) { finish(id, reqPath, name, staged, 1, '', 'relay rejected: video cover not a regular file in outbox'); continue; }

      const hostArgs = [
        ...v.value.flags,
        ...(v.value.command === 'dispatch'
          ? ['--brief-file', contentDest]
          : cardPath ? ['--card-file', cardPath] : ['--content-file', contentDest]),
        ...(v.value.command === 'send' ? attPaths.flatMap(a => ['--files', a]) : []),
        ...(v.value.command === 'send' ? videoPaths.flatMap(a => ['--videos', a]) : []),
        ...(v.value.command === 'send' ? videoCoverPaths.flatMap(a => ['--video-covers', a]) : []),
        '--session-id', sessionId,  // forced — sandbox cannot target another session
      ];
      // Fail closed: a durable origin (turnId/dispatchAttempt) may come ONLY
      // from a host-side authorize decision. The sandbox controls every byte of
      // the relay request, so its originTurnId/dispatchAttempt are never trusted
      // — without an authorize hook the relay runs with no durable origin.
      const trustedOrigin = authorization?.ok ? authorization.origin : undefined;
      // Master's relay host env (BOTMUX_SEND_RELAY stripped + prepared-content
      // local-link mode) is the base for the watcher-spawned host re-exec.
      const requestEnv: NodeJS.ProcessEnv = {
        ...buildRelayHostEnv(baseEnv, preparedContentPath),
        BOTMUX_SESSION_ID: sessionId,
      };
      // The host re-exec itself is trusted (the sandbox child has this marker
      // explicitly unset). Scrub any inherited durable-origin markers first,
      // then re-apply only what the host authorized; cmdSend still re-validates
      // the exact receipt/IM origin carried below.
      requestEnv.BOTMUX_HOST_RELAY_AUTHORIZED = '1';
      delete requestEnv.BOTMUX_TURN_ID;
      delete requestEnv.BOTMUX_DISPATCH_ATTEMPT;
      if (trustedOrigin?.turnId !== undefined) requestEnv.BOTMUX_TURN_ID = trustedOrigin.turnId;
      if (trustedOrigin?.dispatchAttempt !== undefined) {
        requestEnv.BOTMUX_DISPATCH_ATTEMPT = String(trustedOrigin.dispatchAttempt);
      }
      if (trustedOrigin?.requiresCodexAppLedger) {
        requestEnv.BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER = '1';
      } else {
        delete requestEnv.BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER;
      }
      const child = spawn(cliInvocation.command, [...cliInvocation.args, v.value.command, ...hostArgs], { env: requestEnv });
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

// Single definition, re-exported for the callers that historically imported it
// from here. See mojo-types.ts for why a wrapperCli voids the proof.
export { isMojoFullyRemote };
