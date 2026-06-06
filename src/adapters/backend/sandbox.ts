/**
 * File-isolation sandbox (bubblewrap) for oncall bots.
 *
 * Wraps a CLI invocation so the agent can only read/write a per-session project
 * copy + a scoped, de-identified config dir — never the host's home, secrets
 * (~/.ssh, ~/.aws, bots.json), or other sessions'/projects' data.
 *
 * Scope = FILE ISOLATION ONLY (per product decision 2026-06-05): host files
 * can't be touched; network is intentionally NOT isolated (npm/pip/git keep
 * working). This is bwrap's "default-deny + allowlist" model, NOT a defence
 * against a determined kernel-level escape — see
 * docs/sandbox-oncall-research-20260605.md.
 *
 * Linux-only (bwrap depends on Linux user/mount namespaces). macOS reuses
 * Anthropic's sandbox-exec approach and is handled elsewhere.
 */
import { homedir } from 'node:os';
import { cpSync, mkdirSync, existsSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, realpathSync, openSync, fstatSync, readSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export interface SandboxPlan {
  /** Host path of the per-session writable project copy (a `git clone` of the
   *  source). Mounted INSIDE the sandbox at `projectMount`, not at this path. */
  workDir: string;
  /** In-sandbox path the clone is mounted at — MUST equal the original
   *  workingDir the CLI was given (e.g. codex `-C <dir>`), so the CLI's existing
   *  args resolve to the clone. Also the child's chdir. */
  projectMount: string;
  /** Per-session scoped HOME — bound over the real home path so every CLI's
   *  hardcoded `~/.<cli>` resolves into this de-identified area. */
  scopedHome: string;
  /** Daemon-mediated `botmux send` outbox — the ONLY IPC surface bound in, so
   *  bots.json / Lark creds never enter the sandbox. */
  outbox: string;
  /** Extra read-only paths the toolchain lives under (node/CLI binaries via
   *  fnm, the botmux dist) — re-exposed AFTER the scoped-home mask because on
   *  this host they sit under $HOME (e.g. ~/.local/share/fnm, ~/iserver/botmux). */
  toolchainRo: string[];
  /** Keep network egress. File-only scope ⇒ default true (npm/pip/git work). */
  net?: boolean;
}

/** System dirs the toolchain needs, mounted read-only. `-try` so a missing
 *  path (e.g. /lib64 on some arches) is skipped rather than aborting. */
const SYS_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt'] as const;

/**
 * Build the bwrap argv prefix. Final spawn becomes:
 *   bwrap <these args> -- <cliBin> <cliArgs...>
 *
 * Mount order matters: the scoped HOME is bound over the real home FIRST, then
 * toolchain/work/outbox paths (some under home) are re-bound on top — bwrap
 * applies binds in order, so the later, more specific mounts win.
 */
export function buildSandboxArgs(plan: SandboxPlan): string[] {
  const home = homedir();
  const a: string[] = [];
  for (const p of SYS_RO) a.push('--ro-bind-try', p, p);
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
  // Mask the real home with the de-identified scoped home (same path → no env
  // translation; ~/.codex, ~/.claude, ~/.config/* all resolve into scopedHome).
  a.push('--bind', plan.scopedHome, home);
  // Re-expose toolchain that lives under $HOME (node/CLI/botmux dist).
  for (const p of plan.toolchainRo) a.push('--ro-bind-try', p, p);
  // Writable: the project copy (mounted AT the original workingDir so the CLI's
  // existing path args resolve) and the send-outbox (its own host path).
  a.push('--bind', plan.workDir, plan.projectMount);
  a.push('--bind', plan.outbox, plan.outbox);
  // Isolate namespaces (keep net unless explicitly disabled).
  a.push('--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  if (plan.net === false) a.push('--unshare-net');
  a.push('--die-with-parent', '--new-session', '--chdir', plan.projectMount);
  return a;
}

/** Per-CLI config-dir scoping: which `~/<subdir>` to recreate, and which files
 *  to SEED (auth/config). Everything not listed is scrubbed — history, session
 *  transcripts, logs, other-project data all stay out of the sandbox. */
interface ConfigScope { subdir: string; seed: readonly string[]; }

const CONFIG_SCOPE: Record<string, ConfigScope> = {
  // codex: seed auth + config only. history.jsonl / sessions / logs_2.sqlite /
  // goals_*.sqlite / cache are deliberately dropped (cross-session privacy AND
  // the multi-GB logs_2.sqlite WAL bloat — see project_codex_logs_wal_bloat).
  codex: {
    subdir: '.codex',
    seed: ['auth.json', 'config.toml', 'config.toml.old', 'config.toml.current', 'hooks.json', 'installation_id'],
  },
  'codex-app': {
    subdir: '.codex',
    seed: ['auth.json', 'config.toml', 'config.toml.old', 'config.toml.current', 'hooks.json', 'installation_id'],
  },
  // claude family: seed credentials + settings; projects/ (per-project history)
  // and todos/ stay out. (.claude.json folder-trust lives beside ~/.claude and
  // is handled by the caller when needed.)
  'claude-code': {
    subdir: '.claude',
    seed: ['.credentials.json', 'settings.json'],
  },
};

/**
 * Materialise a de-identified config dir inside `scopedHome`: copy ONLY the
 * auth/config files from the host's real config, never history/sessions.
 * `dereference` resolves symlinks (codex's config.toml → config.toml.old) into
 * real files, since the symlink target won't exist inside the masked home.
 *
 * Returns false if this CLI has no persistent config to scope (hermes/aiden/…).
 */
export function seedScopedConfig(cliId: string, scopedHome: string): boolean {
  const scope = CONFIG_SCOPE[cliId];
  if (!scope) return false;
  const hostRoot = join(homedir(), scope.subdir);
  const dstRoot = join(scopedHome, scope.subdir);
  mkdirSync(dstRoot, { recursive: true });
  for (const f of scope.seed) {
    const src = join(hostRoot, f);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(dstRoot, f), { recursive: true, dereference: true });
    } catch {
      /* best-effort: a missing/locked config file shouldn't block the sandbox */
    }
  }
  return true;
}

// ───────────────────────────── orchestration ─────────────────────────────
//
// Everything below wires the primitives above into the worker's spawn path:
// per-session dirs, a project clone, a PATH-injected `botmux` shim that runs
// THIS build (so `botmux send` hits relay mode), and the daemon-side outbox
// watcher that delivers relayed sends with the worker's creds.

/** Absolute path to this build's compiled cli.js (dist/cli.js), derived from
 *  this module's own location (dist/adapters/backend/sandbox.js → ../../cli.js). */
function distCliJs(): string {
  return fileURLToPath(new URL('../../cli.js', import.meta.url));
}

/** Is file-sandbox enabled for this session? Spike gate = env; the real
 *  per-bot BotConfig.sandbox flag is a follow-up. */
export function sandboxEnabled(): boolean {
  return process.env.BOTMUX_SANDBOX === '1';
}

export interface SandboxSpawn {
  /** Replace the CLI binary with this (always 'bwrap'). */
  bin: string;
  /** bwrap args + '--' + original (bin, ...args). */
  args: string[];
  /** Env overrides to merge into childEnv (HOME, PATH, BOTMUX_SEND_RELAY). */
  env: Record<string, string>;
  /** Outbox dir the daemon watcher must service. */
  outbox: string;
  /** Per-session project copy (for logging / landing). */
  workDir: string;
  /** Remove the per-session sandbox tree. */
  cleanup: () => void;
}

function cloneProject(src: string, dst: string): void {
  if (existsSync(join(src, '.git'))) {
    // --no-hardlinks → fully independent object store; the sandbox can never
    // corrupt the source repo, even with the shared-checkout setup.
    const r = spawnSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', src, dst], { stdio: 'ignore' });
    if (r.status === 0) return;
    // fall through to cp on any git failure (non-repo edge, detached, etc.)
  }
  cpSync(src, dst, { recursive: true });
}

/**
 * Build the sandboxed spawn for a CLI session, or return null when sandboxing
 * is off / unsupported. Creates per-session dirs under
 * <dataDir>/sandboxes/<sessionId>/, clones the source project, seeds a
 * de-identified config dir, and installs a `botmux` shim on PATH.
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
}): SandboxSpawn | null {
  if (!opts.enabled) return null;
  if (process.platform !== 'linux') return null; // bwrap is Linux-only

  const root = join(opts.dataDir, 'sandboxes', opts.sessionId);
  const scopedHome = join(root, 'home');
  const workDir = join(root, 'work');
  const outbox = join(root, 'outbox');
  const shimBin = join(root, 'shimbin');
  for (const d of [scopedHome, outbox, shimBin]) mkdirSync(d, { recursive: true });

  // Project copy (BOTMUX_SANDBOX_SRC overrides for spike testing — the bot's
  // configured workingDir may be huge/unsuitable).
  const src = process.env.BOTMUX_SANDBOX_SRC || opts.sourceWorkingDir;
  if (!existsSync(workDir)) cloneProject(src, workDir);

  // De-identified CLI config (auth only, history scrubbed).
  seedScopedConfig(opts.cliId, scopedHome);

  // `botmux` shim → THIS build's cli.js, so in-sandbox `botmux send` hits relay
  // mode (and never the host's shared dist / bots.json).
  const shim = join(shimBin, 'botmux');
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(distCliJs())} "$@"\n`);
  chmodSync(shim, 0o755);

  // Toolchain that lives under $HOME and must survive the scoped-home mask:
  // the fnm node/CLI install + this build's dist (for the shim's cli.js).
  const home = homedir();
  const toolchainRo: string[] = [];
  const nodeDir = dirname(process.execPath);                 // .../installation/bin
  toolchainRo.push(dirname(nodeDir));                         // .../installation (node + npm-global CLIs)
  const pkgRoot = dirname(dirname(distCliJs()));             // <build>/dist's parent (the package root)
  toolchainRo.push(pkgRoot);
  // node_modules may be a symlink (worktree → main checkout); bind its realpath
  // too or the shim's cli.js can't load its deps inside the namespace.
  try {
    const real = realpathSync(join(pkgRoot, 'node_modules'));
    if (real !== join(pkgRoot, 'node_modules')) toolchainRo.push(real);
  } catch { /* no node_modules symlink to chase */ }

  // Mount target = the original workingDir the CLI was told about (NOT the
  // clone source, which BOTMUX_SANDBOX_SRC may override). codex's `-C <dir>` etc.
  // then resolve to the clone.
  const plan: SandboxPlan = { workDir, projectMount: opts.sourceWorkingDir, scopedHome, outbox, toolchainRo, net: true };
  const args = buildSandboxArgs(plan);
  // Mount the shim bin at a fixed, host-absent path and prepend it to PATH.
  args.push('--ro-bind', shimBin, '/sbxbin');
  args.push('--', opts.cliBin, ...opts.cliArgs);

  const env: Record<string, string> = {
    HOME: home,                          // scoped home is mounted AT the real home path
    BOTMUX_SEND_RELAY: outbox,
    PATH: `/sbxbin:${process.env.PATH ?? ''}`,
  };

  return {
    bin: 'bwrap',
    args,
    env,
    outbox,
    workDir,
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } },
  };
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
      flags.push(f, v); i++; continue;
    }
    return { ok: false, error: `flag not allowed: ${f}` };
  }
  return { ok: true, value: { contentName: req.contentFile, attachmentNames, flags } };
}

/**
 * TOCTOU-safe copy of an outbox file (`outbox/<name>`, name already validated as
 * a plain basename) into a host-private `dest`. Opens with O_NOFOLLOW so a
 * symlink swapped in by the sandbox AFTER validation is rejected at open time;
 * reads from the fd (not the path), so the inode can't be swapped under us.
 * Returns false (reject) on symlink / non-regular / any error.
 */
export function materializeOutboxFile(outbox: string, name: string, dest: string): boolean {
  let fd: number;
  try { fd = openSync(join(outbox, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch { return false; }  // symlink (ELOOP) or missing
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
    try { writeFileSync(join(outbox, `${id}.res.json`), JSON.stringify({ code, stdout, stderr })); } catch { /* */ }
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
