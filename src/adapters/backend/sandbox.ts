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
import { mkdirSync, existsSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, statSync, lstatSync, readlinkSync, realpathSync, openSync, fstatSync, readSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { compileToBwrap, type FsPolicy } from '../cli/fs-policy.js';
import { PROXY_ENV_KEYS } from '../../utils/child-env.js';
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
 *  this module's own location (dist/adapters/backend/sandbox.js → ../../cli.js). */
function distCliJs(): string {
  const colocated = fileURLToPath(new URL('../../cli.js', import.meta.url));
  if (existsSync(colocated)) return colocated;
  // `pnpm daemon` loads this module from src/ through tsx, while the trusted
  // sandbox shim must still execute the built CLI entrypoint.
  return fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
}

/** Is the file sandbox globally forced for this daemon? The real per-bot
 *  BotConfig.sandbox flag is decided by the caller. */
export function sandboxEnabled(): boolean {
  return process.env.BOTMUX_SANDBOX === '1';
}

/**
 * Whether a LOCAL sandbox engine applies to this backend at all. riff has NO
 * local CLI process to wrap (execution happens in riff's own remote sandbox);
 * without this bypass the worker's fail-safe "backend not sandboxable" hard
 * error would brick every sandbox-enabled bot the moment it switches to riff.
 * Platform is no longer a factor — fs-policy sandboxes darwin AND linux.
 */
export function localSandboxApplies(backendType: string): boolean {
  return backendType !== 'riff';
}

/** Top-level dirs that are symlinks on usrmerge distros (/bin → usr/bin …) —
 *  replicated inside the tmpfs root so `#!/bin/sh` etc. resolve. */
const USRMERGE_CANDIDATES = ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32'] as const;

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
}): DirectSandboxSpawn | null {
  if (process.platform !== 'linux') return null;
  if (!ensureSandboxDeps()) return null;

  const sessionRoot = join(canonical(opts.dataDir), 'sandboxes', opts.sessionId);
  const outbox = join(sessionRoot, 'outbox');
  const shimBin = join(sessionRoot, 'shimbin');
  const empties = join(sessionRoot, 'empties');
  for (const d of [outbox, shimBin, empties]) mkdirSync(d, { recursive: true });

  // `botmux` shim → THIS build's cli.js so in-sandbox `botmux send` hits relay
  // mode (and never needs bots.json, which the policy doesn't expose).
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(distCliJs())} "$@"\n`);
  chmodSync(shim, 0o755);

  // usrmerge symlinks to replicate; deny rules that are FILES on the host
  // (dir denies mask with tmpfs, file denies need an empty ro-bind source).
  const symlinks: { path: string; target: string }[] = [];
  for (const p of USRMERGE_CANDIDATES) {
    try {
      if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) });
    } catch { /* absent on this distro */ }
  }
  const filePaths = new Set<string>();
  for (const r of opts.policy.rules) {
    if (r.access !== 'deny') continue;
    try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* */ }
  }

  const compiled = compileToBwrap(opts.policy, { symlinks, emptiesDir: empties, filePaths, chdir: opts.chdir });
  for (const f of compiled.emptyFiles) {
    try { writeFileSync(f.path, ''); } catch { /* */ }
  }

  const args = [...compiled.args];
  // Shim bin at a fixed path under the fresh /run tmpfs — appended after the
  // rule mounts (later mount wins over the tmpfs). PATH points here first.
  args.push('--ro-bind', shimBin, '/run/sbxbin');
  for (const rawTarget of [...new Set(opts.trustedBotmuxCommandPaths ?? [])]) {
    if (typeof rawTarget !== 'string' || !isAbsolute(rawTarget)) continue;
    const target = resolve(rawTarget);
    try {
      if (!lstatSync(target).isFile()) continue;
      args.push('--ro-bind', shim, target);
    } catch { /* missing/stale config target — PATH shim remains available */ }
  }

  let sandboxMcpGatewaySocketPath: string | undefined;
  if (opts.mcpGatewaySocketPath) {
    try {
      const socketPath = resolve(opts.mcpGatewaySocketPath);
      if (!lstatSync(socketPath).isSocket()) return null;
      const hostDir = realpathSync(dirname(socketPath));
      const sandboxDir = '/run/botmux-mcp';
      args.push('--dir', sandboxDir, '--ro-bind', hostDir, sandboxDir);
      sandboxMcpGatewaySocketPath = join(sandboxDir, basename(socketPath));
    } catch {
      return null;
    }
  }

  // Authoritative child env via bwrap --setenv (works on pty AND tmux — the
  // tmux backend only forwards a fixed whitelist).
  const env: Record<string, string> = {
    HOME: opts.home,
    BOTMUX_SEND_RELAY: outbox,
    PATH: `/run/sbxbin:${process.env.PATH ?? ''}`,
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
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--', opts.cliBin, ...opts.cliArgs);

  return {
    bin: 'bwrap',
    args,
    env,
    outbox,
    cleanup: () => {
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
    try { rmSync(sessionRoot, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─────────────────────── botmux send relay (unchanged) ───────────────────────

// Relay request schema (written by cli.ts relaySend, validated here). The
// watcher NEVER executes sandbox-supplied argv — it rebuilds the command from
// these validated fields. This is the security boundary: a malicious agent can
// write any outbox file, so everything here is treated as untrusted.
//   { contentFile: <basename>, preparedContentFile?: <basename>, cardFile?: <basename>, ... }
export interface RelayRequest {
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
const RELAY_FLAGS_NOVAL = new Set(['--mention-back', '--no-mention', '--no-quote', '--voice']);
const RELAY_FLAGS_VAL = new Set(['--mention', '--quote']);

export interface ValidatedRelay {
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
      | { ok: true; origin: { turnId?: string; dispatchAttempt?: number } }
      | { ok: false; error: string };
    cliPath?: string;
  } = {},
): () => void {
  const cli = opts.cliPath ?? distCliJs();
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
        ...(cardPath ? ['--card-file', cardPath] : ['--content-file', contentDest]),
        ...attPaths.flatMap(a => ['--files', a]),
        ...videoPaths.flatMap(a => ['--videos', a]),
        ...videoCoverPaths.flatMap(a => ['--video-covers', a]),
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
      const child = spawn(process.execPath, [cli, 'send', ...hostArgs], { env: requestEnv });
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
