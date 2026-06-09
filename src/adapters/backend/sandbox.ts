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

/** Per-CLI config-dir scoping for `~/<subdir>`. Two modes:
 *   - `seed`  (allowlist): copy ONLY these entries — safest, for CLIs whose
 *     minimal auth set is known (codex).
 *   - `scrub` (blocklist): copy the WHOLE dir EXCEPT these entries — robust for
 *     CLIs that need their full config to run (claude needs settings.json's env
 *     proxy block, settings.local.json, MCP config, …; coco needs its plugins).
 *     Only the cross-session-history items are excluded.
 *  `claudeTrust` additionally writes a minimal `~/.claude.json` trusting only the
 *  current project (the host's 69-project list is dropped). */
interface ConfigScope { subdir: string; seed?: readonly string[]; scrub?: readonly string[]; claudeTrust?: boolean; }

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
  // claude: ALLOWLIST (default-deny) — ~/.claude has many session/privacy dirs
  // (history.jsonl, projects/, file-history/, paste-cache/, plans/, tasks/,
  // downloads/, debug/ …) that must NOT enter the sandbox, so we copy only the
  // config/auth files. settings.json is critical: its `env` block carries
  // http_proxy/https_proxy — without it claude can't reach the API. + folder-trust.
  'claude-code': {
    subdir: '.claude',
    seed: ['.credentials.json', 'settings.json', 'settings.local.json', 'mcp-needs-auth-cache.json'],
    claudeTrust: true,
  },
  // coco (Rust): copy ~/.cache/coco EXCEPT history/sessions/logs; keep plugins/
  // (its API config). coco recreates history/sessions fresh inside the sandbox.
  coco: {
    subdir: '.cache/coco',
    scrub: ['history.jsonl', 'sessions', 'log', 'crashmarks', 'event-queue'],
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
export function seedScopedConfig(cliId: string, scopedHome: string, projectMount?: string): boolean {
  const scope = CONFIG_SCOPE[cliId];
  if (!scope) return false;
  const hostRoot = join(homedir(), scope.subdir);
  const dstRoot = join(scopedHome, scope.subdir);
  mkdirSync(dstRoot, { recursive: true });

  const copy = (name: string) => {
    const src = join(hostRoot, name);
    if (!existsSync(src)) return;
    try { cpSync(src, join(dstRoot, name), { recursive: true, dereference: true }); }
    catch { /* best-effort: a missing/locked entry shouldn't block the sandbox */ }
  };

  if (scope.seed) {
    for (const f of scope.seed) copy(f);
  } else if (scope.scrub) {
    const skip = new Set<string>(scope.scrub);
    let entries: string[] = [];
    try { entries = readdirSync(hostRoot); } catch { /* host config absent */ }
    for (const name of entries) if (!skip.has(name)) copy(name);
  }

  if (scope.claudeTrust && projectMount) seedClaudeTrust(scopedHome, projectMount);
  scrubSeededHooks(dstRoot);
  return true;
}

/** Fix the hooks in the seeded config (claude settings.json, codex hooks.json …)
 *  so they don't fail inside the sandbox:
 *   - botmux's OWN hook (`<node> <host>/dist/cli.js hook <cli>`, e.g. claude's
 *     AskUserQuestion → Lark card) → KEEP, but rewrite its paths to the
 *     in-sandbox relocated runtime: `…/dist/cli.js` → /botmux-runtime/dist/cli.js,
 *     absolute `…/bin/node` → `node` (resolved on the sandbox PATH).
 *   - every OTHER hook (the owner's host tooling, e.g. `/root/.flux/bin/...`) →
 *     STRIP. Those binaries aren't bound in the sandbox, so they'd exit 127
 *     ("command not found") and spam the CLI's hook UI; the owner's personal
 *     host hooks also shouldn't run inside an isolated oncall sandbox. */
function scrubSeededHooks(dstRoot: string): void {
  const isBotmuxHook = (cmd: unknown): cmd is string =>
    typeof cmd === 'string' && /\/cli\.js\b/.test(cmd) && /\bhook\b/.test(cmd);
  const rewrite = (cmd: string): string =>
    cmd.replace(/"[^"]*\/dist\/cli\.js"/g, '"/botmux-runtime/dist/cli.js"')
       .replace(/"[^"]*\/bin\/node"/g, '"node"');
  let names: string[] = [];
  try { names = readdirSync(dstRoot); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = join(dstRoot, name);
    let data: any;
    try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    if (!data?.hooks || typeof data.hooks !== 'object') continue;
    let changed = false;
    for (const event of Object.keys(data.hooks)) {
      const entries = data.hooks[event];
      if (!Array.isArray(entries)) continue;
      const keptEntries: any[] = [];
      for (const entry of entries) {
        const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
        const keptHooks = hooks.filter((h: any) => {
          if (!isBotmuxHook(h?.command)) { changed = true; return false; }   // strip host hook
          const nc = rewrite(h.command); if (nc !== h.command) { h.command = nc; changed = true; }
          return true;
        });
        if (keptHooks.length) { entry.hooks = keptHooks; keptEntries.push(entry); }
        else changed = true;
      }
      if (keptEntries.length) data.hooks[event] = keptEntries;
      else { delete data.hooks[event]; changed = true; }
    }
    if (changed) { try { writeFileSync(p, JSON.stringify(data, null, 2)); } catch { /* */ } }
  }
}

/** Write a minimal `<scopedHome>/.claude.json` that pre-accepts folder-trust for
 *  ONLY `projectMount`. We start from the host file (to keep claude's onboarding/
 *  account state so it doesn't re-run first-run) but REPLACE its `projects` map
 *  so the host's full project list never enters the sandbox. */
function seedClaudeTrust(scopedHome: string, projectMount: string): void {
  const hostJson = join(homedir(), '.claude.json');
  let data: any = {};
  if (existsSync(hostJson)) {
    try { data = JSON.parse(readFileSync(hostJson, 'utf8')); } catch { data = {}; }
  }
  if (!data || typeof data !== 'object') data = {};
  data.projects = { [projectMount]: { hasTrustDialogAccepted: true } };  // drop host's project list
  try { writeFileSync(join(scopedHome, '.claude.json'), JSON.stringify(data)); } catch { /* */ }
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
    if (r.status === 0) {
      try {
        // `git clone` only carries committed content. Overlay the source's
        // WORKING TREE (uncommitted edits + untracked files) so the agent sees
        // exactly what the owner sees — otherwise an owner's untracked file
        // looks "new" to the agent and `/land` fails with "already exists".
        overlayWorkingTree(src, dst);
        // Baseline-commit the overlaid working tree. `/land` then diffs the
        // agent's changes against THIS baseline (not the source's last commit),
        // so landing applies only the agent's delta — not the owner's
        // pre-existing uncommitted work (which the real repo already has).
        spawnSync('git', ['-C', dst, 'add', '-A'], { stdio: 'ignore' });
        spawnSync('git', ['-C', dst, '-c', 'user.email=sandbox@botmux.local', '-c', 'user.name=botmux-sandbox', 'commit', '-q', '--no-verify', '-m', 'botmux sandbox baseline (working tree)'], { stdio: 'ignore' });
        const head = spawnSync('git', ['-C', dst, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
        if (head) writeFileSync(join(dirname(dst), 'clone-base'), head);
      } catch { /* non-fatal: land falls back to HEAD */ }
      return;
    }
    // fall through to cp on any git failure (non-repo edge, detached, etc.)
  }
  cpSync(src, dst, { recursive: true });
}

/** Make dst's working tree match src's: apply tracked edits + copy untracked. */
function overlayWorkingTree(src: string, dst: string): void {
  // Tracked modifications/deletions vs HEAD → apply onto the fresh checkout.
  const diff = spawnSync('git', ['-C', src, 'diff', 'HEAD', '--binary'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (diff.status === 0 && diff.stdout && diff.stdout.trim()) {
    const tmp = join(dirname(dst), 'wt-overlay.patch');
    writeFileSync(tmp, diff.stdout);
    spawnSync('git', ['-C', dst, 'apply', '--whitespace=nowarn', tmp], { stdio: 'ignore' });
    try { rmSync(tmp); } catch { /* */ }
  }
  // Untracked, non-ignored files (skips node_modules/.gitignore'd cruft).
  const others = spawnSync('git', ['-C', src, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (others.status === 0 && others.stdout) {
    for (const rel of others.stdout.split('\0').filter(Boolean)) {
      try {
        mkdirSync(dirname(join(dst, rel)), { recursive: true });
        cpSync(join(src, rel), join(dst, rel));
      } catch { /* skip unreadable/vanished */ }
    }
  }
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

  // De-identified CLI config (auth + settings/proxy-env; cross-session history
  // scrubbed). projectMount lets claude-family pre-accept folder-trust for it.
  seedScopedConfig(opts.cliId, scopedHome, opts.sourceWorkingDir);

  // `botmux` shim → THIS build's cli.js, so in-sandbox `botmux send` hits relay
  // mode (and never the host's shared dist / bots.json).
  const shim = join(shimBin, 'botmux');
  // Run the relocated runtime (see /botmux-runtime binds below), NOT the cli.js
  // at its host path — that path can be shadowed by the project clone.
  writeFileSync(shim, `#!/bin/sh\nexec node /botmux-runtime/dist/cli.js "$@"\n`);
  chmodSync(shim, 0o755);

  // Toolchain that lives under $HOME and must survive the scoped-home mask:
  // the fnm node/CLI install + this build's dist (for the shim's cli.js).
  const home = homedir();
  const toolchainRo: string[] = [];
  const nodeDir = dirname(process.execPath);                 // .../installation/bin
  toolchainRo.push(dirname(nodeDir));                         // .../installation (node + npm-global CLIs)
  const pkgRoot = dirname(dirname(distCliJs()));             // <build>/dist's parent (the package root)
  // NOTE: the botmux runtime (dist / node_modules / package.json) is deliberately
  // NOT bound here at its real pkgRoot path. It's relocated to /botmux-runtime
  // below. Binding it at pkgRoot lets the project clone shadow it whenever a bot
  // dogfoods botmux (workingDir == the botmux dir), which broke the `botmux send`
  // shim (clone has no dist/node_modules — they're .gitignore'd). [B3]
  // The CLI binary's own dir + its symlink-resolved dir. Critical: claude/coco
  // live in ~/.local/bin (under the masked home), so without this they're not
  // found inside the sandbox and exec fails. (codex happened to be under the
  // fnm install above; not all CLIs are.)
  toolchainRo.push(dirname(opts.cliBin));
  try { toolchainRo.push(dirname(realpathSync(opts.cliBin))); } catch { /* */ }

  // Mount target = the original workingDir the CLI was told about (NOT the
  // clone source, which BOTMUX_SANDBOX_SRC may override). codex's `-C <dir>` etc.
  // then resolve to the clone.
  const plan: SandboxPlan = { workDir, projectMount: opts.sourceWorkingDir, scopedHome, outbox, toolchainRo, net: true };
  const args = buildSandboxArgs(plan);
  // Mount the shim bin at a fixed, host-absent path and prepend it to PATH.
  args.push('--ro-bind', shimBin, '/sbxbin');
  // Botmux runtime at a FIXED sandbox-private path (/botmux-runtime), bound LAST
  // and at a path no user projectMount can equal — so the project clone can
  // never shadow it (B3), and we never drop a read-only package.json onto the
  // user's clone. The shim runs /botmux-runtime/dist/cli.js; node resolves deps
  // from /botmux-runtime/node_modules (walk-up from dist/), and package.json
  // gives cli.js its "type":"module". node_modules may be a symlink → the bind
  // follows it to the real deps.
  args.push('--ro-bind', join(pkgRoot, 'dist'), '/botmux-runtime/dist');
  args.push('--ro-bind-try', join(pkgRoot, 'package.json'), '/botmux-runtime/package.json');
  args.push('--ro-bind', join(pkgRoot, 'node_modules'), '/botmux-runtime/node_modules');
  // botmux skill/plugin dir (claude `--plugin-dir` points here; carries the
  // botmux-send etc. skills, no secrets). Re-exposed read-only on top of the
  // masked ~/.botmux so the agent's skills load (but bots.json stays hidden).
  const pluginDir = join(home, '.botmux', 'claude-plugin');
  if (existsSync(pluginDir)) args.push('--ro-bind-try', pluginDir, pluginDir);

  // Set the sandbox env via bwrap --setenv (authoritative for the child) rather
  // than relying on the spawn env. The tmux backend only forwards a fixed
  // whitelist (BOTMUX_INJECTED_ENV_KEYS) to its pane, which does NOT include
  // HOME / PATH / BOTMUX_SEND_RELAY — so without --setenv the sandbox would only
  // work under the pty backend. --setenv makes pty AND tmux both work.
  const env: Record<string, string> = {
    HOME: home,                          // scoped home is mounted AT the real home path
    BOTMUX_SEND_RELAY: outbox,           // routes `botmux send` to the daemon outbox watcher
    PATH: `/sbxbin:${process.env.PATH ?? ''}`,  // /sbxbin first so `botmux` = the relay shim
  };
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--', opts.cliBin, ...opts.cliArgs);

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
