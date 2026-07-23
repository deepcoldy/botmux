/**
 * Unified file-sandbox policy (FsPolicy) — the single source of truth for BOTH
 * platform sandbox engines.
 *
 * Model (three-tier whitelist, per product decision 2026-07-16, design doc
 * "botmux 文件沙盒重构方案"): every path gets one of three access levels —
 * readWrite / readOnly / deny — and EVERYTHING NOT COVERED BY A RULE IS
 * INACCESSIBLE (deny-by-default). Nested black/white lists are supported: the
 * DEEPEST matching rule wins (longest-prefix), so `readOnly ~/Library` +
 * `deny ~/Library/Keychains` and `deny bots/` + `readWrite bots/<self>` both
 * work. This replaces the previous "read-everything + enumerated blocklist"
 * model whose failure mode was silent secret exposure; here a missing baseline
 * entry fails loud (CLI error), never silent.
 *
 * Architecture: this module is PURE (no fs / no spawn — fully unit-testable).
 *   buildFsPolicy(ctx)      merges baseline preset + botmux-internal + adapter
 *                           + user rules into one ordered rule list
 *   compileToSeatbelt(...)  → macOS sandbox-exec profile text
 *   compileToBwrap(...)     → Linux bwrap argv prefix
 * Both engines resolve conflicts by "last emitted wins" (Seatbelt last-match /
 * bwrap mount order), so emitting rules sorted shallow→deep yields
 * longest-prefix-wins on BOTH platforms by construction — cross-platform
 * parity needs no hand-synced rule lists.
 *
 * The worker resolves every impure input up front (realpath, existence
 * filtering, sibling-free by design) and passes canonical absolute paths.
 */

export type FsAccess = 'readWrite' | 'readOnly' | 'deny';
export type FsRuleSource = 'baseline' | 'adapter' | 'internal' | 'user' | 'mandatory';

export interface FsRule {
  /** Canonical absolute path (no trailing slash). */
  path: string;
  access: FsAccess;
  /** Where the rule came from — for the dashboard policy viewer / path tester. */
  source: FsRuleSource;
}

export interface FsPolicy {
  /** Deduped rules sorted shallow→deep (emission order = precedence order). */
  rules: FsRule[];
  /** Keep network egress (bwrap-only knob; Seatbelt does not confine net here). */
  net: boolean;
  /** Extra Seatbelt write-allow regexes (e.g. ~/.claude.json.tmp.* atomic-save
   *  siblings when the CLI data dir is NOT redirected into BOT_HOME). */
  writeRegexes: string[];
  /** Final host-security denies that cannot be represented as path prefixes. */
  denyRegexes?: string[];
  /** Narrow read-only exceptions emitted after denyRegexes (macOS gateway socket). */
  finalReadOnlyPaths?: string[];
}

export interface FsPolicyUserPaths {
  readWrite?: readonly string[];
  readOnly?: readonly string[];
  deny?: readonly string[];
}

export interface FsPolicyContext {
  platform: 'darwin' | 'linux';
  /** All paths below must be CANONICAL (realpath'd by the worker). */
  homeDir: string;
  botmuxHome: string;
  sessionDataDir: string;
  workingDir: string;
  currentAppId: string;
  /** This bot's BOT_HOME (`<botmuxHome>/bots/<appId>`) — always readWrite. */
  botHome: string;
  /** True when the CLI's data root is redirected into BOT_HOME
   *  (CLAUDE_CONFIG_DIR / CODEX_HOME). False → cliDataPaths are exposed rw. */
  redirectedCliData: boolean;
  /** The CLI's REAL data paths (e.g. ~/.claude, ~/.claude.json, ~/.codex) to
   *  keep readWrite when NOT redirected. Ignored when redirectedCliData. */
  cliDataPaths?: readonly string[];
  /** Adapter auth/login paths kept readWrite (token refresh must persist). */
  authPaths?: readonly string[];
  /** Directories of every executable spawned inside the sandbox (cliBin dir,
   *  node dir, adapter second-stage bins) — exposed readOnly. */
  execPaths?: readonly string[];
  /** Trusted runtime read-only roots (skill/plugin dirs, botmux dist). */
  readonlyRoots?: readonly string[];
  /** The botmux install/checkout root (dir containing dist/ + node_modules).
   *  Exposed readOnly so the agent's `botmux` CLI and the claude hooks (which
   *  exec `node <checkout>/dist/cli.js …`) can load — without this a sandboxed
   *  `botmux send` / SessionStart+AskUserQuestion hooks EPERM on cli.js. */
  botmuxInstallRoot?: string;
  /** Daemon-mediated relay outbox (Linux) — readWrite. */
  outbox?: string;
  /** Extra writable roots (resolved TMPDIR, admin extras). */
  extraWritePaths?: readonly string[];
  /** Per-bot user config (bots.json sandboxPaths) — highest precedence. */
  userPaths?: FsPolicyUserPaths;
  /** Host-owned boundaries that user policy may not override. */
  mandatoryDenyPaths?: readonly string[];
  mandatoryDenyRegexes?: readonly string[];
  mandatoryReadOnlyPaths?: readonly string[];
  net?: boolean;
  /** Seatbelt write-allow regex passthrough (see FsPolicy.writeRegexes). */
  writeRegexes?: readonly string[];
}

/** Normalize: require absolute, strip trailing slashes, reject `..` segments.
 *  Returns null for anything unusable (silently-dropped relative paths are a
 *  fail-open trap — callers log dropped entries). */
export function normalizeFsPath(p: string): string | null {
  if (!p || typeof p !== 'string') return null;
  const t = p.replace(/\/+$/, '') || '/';
  if (!t.startsWith('/')) return null;
  if (t.split('/').includes('..')) return null;
  return t;
}

/** Path depth for emission ordering ('/' = 0, '/a' = 1, '/a/b' = 2 …). */
function pathDepth(p: string): number {
  if (p === '/') return 0;
  return p.split('/').length - 1;
}

/** Is `p` equal to or an ancestor of `child`? (both normalized) */
export function coversPath(p: string, child: string): boolean {
  if (p === child) return true;
  const prefix = p === '/' ? '/' : `${p}/`;
  return child.startsWith(prefix);
}

const SOURCE_RANK: Record<FsRuleSource, number> = {
  baseline: 0,
  adapter: 1,
  internal: 2,
  user: 3,
  mandatory: 4,
};
const RESTRICTIVENESS: Record<FsAccess, number> = { readWrite: 0, readOnly: 1, deny: 2 };

/**
 * Merge candidate rules into the final ordered list:
 *  - normalize paths, drop unusable entries
 *  - dedupe same-path conflicts: higher source rank wins (user > internal >
 *    adapter > baseline); tie → the MORE RESTRICTIVE access wins (deny >
 *    readOnly > readWrite) so a duplicated entry can never widen access
 *  - sort shallow→deep (stable within a depth) — the emission order both
 *    compilers rely on for longest-prefix-wins
 */
export function mergeFsRules(candidates: readonly FsRule[]): FsRule[] {
  const byPath = new Map<string, FsRule>();
  for (const c of candidates) {
    const path = normalizeFsPath(c.path);
    if (!path) continue;
    const rule: FsRule = { path, access: c.access, source: c.source };
    const prev = byPath.get(path);
    if (!prev) { byPath.set(path, rule); continue; }
    const rankNew = SOURCE_RANK[rule.source], rankOld = SOURCE_RANK[prev.source];
    if (rankNew > rankOld) { byPath.set(path, rule); continue; }
    if (rankNew === rankOld && RESTRICTIVENESS[rule.access] > RESTRICTIVENESS[prev.access]) {
      byPath.set(path, rule);
    }
  }
  return [...byPath.values()].sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The effective access for `path` under `rules`: the DEEPEST rule whose path
 * covers it; no match → 'none' (inaccessible). This one function IS the policy
 * semantics — the dashboard path tester and the unit tests both call it, and
 * both compilers are tested to agree with it.
 */
export function accessForPath(rules: readonly FsRule[], path: string): { access: FsAccess | 'none'; rule?: FsRule } {
  const p = normalizeFsPath(path);
  if (!p) return { access: 'none' };
  let best: FsRule | undefined;
  for (const r of rules) {
    if (!coversPath(r.path, p)) continue;
    if (!best || pathDepth(r.path) > pathDepth(best.path)) best = r;
  }
  return best ? { access: best.access, rule: best } : { access: 'none' };
}

// ───────────────────────────── baseline presets ──────────────────────────────

/** Home-relative entries shared by both platforms. Existence-filtered by the
 *  worker before compiling (a missing path has nothing to protect or expose). */
function commonHomeBaseline(h: string): FsRule[] {
  const ro = (p: string): FsRule => ({ path: p, access: 'readOnly', source: 'baseline' });
  const rw = (p: string): FsRule => ({ path: p, access: 'readWrite', source: 'baseline' });
  const deny = (p: string): FsRule => ({ path: p, access: 'deny', source: 'baseline' });
  return [
    // Shell/env init read by non-interactive subshells (the Bash tool sources
    // .zshenv — botmux's lark-cli identity mapping lives there) + git identity.
    ro(`${h}/.zshenv`), ro(`${h}/.zprofile`), ro(`${h}/.zshrc`),
    ro(`${h}/.profile`), ro(`${h}/.bashrc`), ro(`${h}/.bash_profile`),
    ro(`${h}/.gitconfig`), ro(`${h}/.config/git`), ro(`${h}/.gitignore_global`), ro(`${h}/.gitattributes`),
    // Language toolchains / version managers / package caches commonly under
    // $HOME (read+exec so python/perl/ruby/rust/go/node/java built or managed
    // there just work — the deny-by-default read posture would otherwise hide a
    // pyenv python or a cargo-built binary). READ-ONLY: the agent runs them, it
    // doesn't need to mutate the toolchain. Credential files that live INSIDE a
    // few of these (crates.io / rubygems / maven tokens) are re-denied DEEPER
    // below so longest-prefix keeps them secret.
    ro(`${h}/.fnm`), ro(`${h}/.nvm`), ro(`${h}/.volta`), ro(`${h}/.npm-global`),
    ro(`${h}/.nodenv`), ro(`${h}/.yarn`), ro(`${h}/.pnpm`), ro(`${h}/.bun`), ro(`${h}/.deno`),
    ro(`${h}/.pyenv`), ro(`${h}/Library/Python`), ro(`${h}/.local/lib`), ro(`${h}/.pipx`),
    ro(`${h}/.rbenv`), ro(`${h}/.rvm`), ro(`${h}/.gem`), ro(`${h}/perl5`), ro(`${h}/.cpanm`), ro(`${h}/.cpan`),
    ro(`${h}/.cargo`), ro(`${h}/.rustup`),
    ro(`${h}/go`), ro(`${h}/.gvm`), ro(`${h}/.goenv`),
    ro(`${h}/.sdkman`), ro(`${h}/.jenv`), ro(`${h}/.m2`), ro(`${h}/.gradle`),
    ro(`${h}/.asdf`), ro(`${h}/.mise`), ro(`${h}/.plenv`),
    ro(`${h}/.opam`), ro(`${h}/.ghcup`), ro(`${h}/.stack`), ro(`${h}/.nimble`), ro(`${h}/.pub-cache`),
    ro(`${h}/.local/share`), ro(`${h}/.local/bin`),
    // Toolchain credential files sitting inside the read-allowed dirs above —
    // re-denied deeper (registry/publish tokens, maven server passwords).
    deny(`${h}/.cargo/credentials`), deny(`${h}/.cargo/credentials.toml`),
    deny(`${h}/.gem/credentials`),
    deny(`${h}/.m2/settings.xml`), deny(`${h}/.m2/settings-security.xml`),
    deny(`${h}/.gradle/gradle.properties`),
    // Scratch/caches every CLI + spawned tool needs.
    rw(`${h}/.cache`), rw(`${h}/.npm`), rw(`${h}/.local/state`),
    // The daemon-written botmux wrapper (head of PATH) + skill plugin dir.
    ro(`${h}/.botmux/bin`), ro(`${h}/.botmux/claude-plugin`),
    // Crown jewels — most are already unreachable via deny-by-default; these
    // explicit denies guard the ones that could fall under an allowed tree
    // (workingDir = $HOME, a broad user readOnly, …). Defence-in-depth.
    deny(`${h}/.ssh`), deny(`${h}/.aws`), deny(`${h}/.azure`), deny(`${h}/.gnupg`),
    deny(`${h}/.netrc`), deny(`${h}/.config/gh`), deny(`${h}/.config/glab-cli`),
    deny(`${h}/.config/gcloud`), deny(`${h}/.config/op`), deny(`${h}/.config/1Password`),
    deny(`${h}/.1password`), deny(`${h}/.password-store`), deny(`${h}/.git-credentials`),
    deny(`${h}/.npmrc`), deny(`${h}/.pypirc`), deny(`${h}/.docker/config.json`), deny(`${h}/.kube`),
    deny(`${h}/.lark-cli`),
  ];
}

function darwinBaseline(h: string): FsRule[] {
  const ro = (p: string): FsRule => ({ path: p, access: 'readOnly', source: 'baseline' });
  const rw = (p: string): FsRule => ({ path: p, access: 'readWrite', source: 'baseline' });
  const deny = (p: string): FsRule => ({ path: p, access: 'deny', source: 'baseline' });
  return [
    ...commonHomeBaseline(h),
    // System: dyld/frameworks/toolchain — broad readOnly + surgical deny holes.
    ro('/System'), ro('/usr'), ro('/bin'), ro('/sbin'), ro('/Library'), ro('/opt'),
    ro('/private/etc'),
    ro('/private/var/select'),   // /var/select/sh
    ro('/private/var/db/timezone'),
    ro('/private/var/run'),      // resolv.conf
    deny('/Library/Keychains'),
    // Scratch: macOS per-user TMPDIR root + tmp family + devices.
    rw('/dev'), rw('/private/tmp'), rw('/private/var/tmp'), rw('/private/var/folders'),
    // ~/Library: CLIs need broad read (fonts/prefs/frameworks caches) and write
    // into Caches + Application Support — with the secret stores denied DEEPER
    // (longest-prefix beats the rw grant).
    ro(`${h}/Library`),
    rw(`${h}/Library/Caches`),
    rw(`${h}/Library/Application Support`),
    rw(`${h}/Library/Logs`),
    deny(`${h}/Library/Keychains`),
    // lark-cli's key store holds EVERY bot's app-secret ciphertext + master key
    // (the known pre-refactor leak — see design doc §2.4). Deny the dir; the
    // bot's OWN send path uses send-cred.json in BOT_HOME, not this store.
    deny(`${h}/Library/Application Support/lark-cli`),
  ];
}

function linuxBaseline(h: string): FsRule[] {
  const ro = (p: string): FsRule => ({ path: p, access: 'readOnly', source: 'baseline' });
  const rw = (p: string): FsRule => ({ path: p, access: 'readWrite', source: 'baseline' });
  return [
    ...commonHomeBaseline(h),
    // Toolchain + config. /bin,/lib*… on usrmerge distros are symlinks — the
    // bwrap compiler replicates them (see CompileBwrapOpts.symlinks); on
    // non-usrmerge hosts the worker passes them as existing dirs instead.
    ro('/usr'), ro('/etc'), ro('/opt'),
    // /run is a fresh tmpfs (compiler primitive); fnm/nvm farms under /run are
    // re-exposed via ctx.execPaths. /tmp,/dev/shm,/var/tmp fresh tmpfs; /dev,
    // /proc via bwrap primitives — all emitted by the compiler, not rules.
    rw(`${h}/.cache`), rw(`${h}/.npm`),
  ];
}

// ───────────────────────────── policy assembly ───────────────────────────────

/**
 * Build the unified FsPolicy: baseline preset (platform) + adapter-declared
 * paths + botmux-internal injections + user sandboxPaths (highest precedence).
 * Pure — the worker canonicalizes and existence-filters all ctx paths first.
 */
export function buildFsPolicy(ctx: FsPolicyContext): FsPolicy {
  const candidates: FsRule[] = [];
  const push = (paths: readonly string[] | undefined, access: FsAccess, source: FsRuleSource) => {
    for (const p of paths ?? []) candidates.push({ path: p, access, source });
  };

  candidates.push(...(ctx.platform === 'darwin' ? darwinBaseline(ctx.homeDir) : linuxBaseline(ctx.homeDir)));

  // Adapter-declared surfaces.
  push(ctx.execPaths, 'readOnly', 'adapter');
  push(ctx.authPaths, 'readWrite', 'adapter');
  if (!ctx.redirectedCliData) push(ctx.cliDataPaths, 'readWrite', 'adapter');

  // botmux internals.
  push([ctx.workingDir, ctx.botHome], 'readWrite', 'internal');
  push(ctx.outbox ? [ctx.outbox] : [], 'readWrite', 'internal');
  push(ctx.extraWritePaths, 'readWrite', 'internal');
  push(ctx.readonlyRoots, 'readOnly', 'internal');
  // Own routing metadata (`botmux send` reply routing) — read-only.
  push([`${ctx.sessionDataDir}/sessions-${ctx.currentAppId}.json`], 'readOnly', 'internal');
  // Own upload bucket — readWRITE: `botmux quoted` / downloadResources writes the
  // downloaded attachment under attachments/<self>/<messageId>/… (not just reads
  // pre-uploaded files). The worker mkdirs it pre-spawn so it survives the
  // existence-filter and gets bound rw. Siblings' buckets stay uncovered.
  push([`${ctx.sessionDataDir}/attachments/${ctx.currentAppId}`], 'readWrite', 'internal');
  // Own per-bot lark-cli config (agent-facing lark-cli identity).
  push([`${ctx.homeDir}/.lark-cli-bots/${ctx.currentAppId}`], 'readWrite', 'internal');

  // ── botmux CLI runtime surface (deny-by-default ALLOW-LIST) ──
  // The agent runs `botmux …` and claude fires SessionStart / AskUserQuestion
  // hooks that exec `node <install>/dist/cli.js …`. They need the install dir +
  // a SMALL set of ~/.botmux files. We do NOT expose ~/.botmux wholesale: it
  // holds live credentials (config.json's voice accessKey/secretKey/apiKey, .env,
  // data/webhook-master.key + webhook-secrets.json) and other bots' private
  // content (data/schedules.json prompts+routing, sibling sessions/identities/
  // send-creds, connectors/federations/…). A readOnly umbrella + deny-list is
  // the fragile "expose-then-blocklist" pattern this refactor exists to kill —
  // and it fails OPEN for files created after spawn. So allow-list ONLY what the
  // CLI/hooks genuinely read; everything else (incl. future files + all creds)
  // stays denied by construction. (Verified against codex review 2026-07-16.)
  const bh = ctx.botmuxHome, sd = ctx.sessionDataDir, app = ctx.currentAppId;
  push(ctx.botmuxInstallRoot ? [ctx.botmuxInstallRoot] : [], 'readOnly', 'internal');
  push([
    `${bh}/.data-dir`,          // resolves DATA_DIR location
    `${bh}/.dashboard-port`,    // dashboard port (owner term-link; harmless port int)
    `${bh}/bin`,                // the daemon-written `botmux` wrapper (head of PATH)
    `${bh}/claude-plugin`,      // skill/plugin dir (claude --plugin-dir); no secrets
    `${bh}/lark-scopes.json`,   // static scope catalog
    `${sd}/dashboard-daemons`,  // per-bot {ipcPort, resolvedAllowedUsers} — hook IPC discovery (operational, not secret)
    `${sd}/bots-info.json`,     // bot display names / avatars for <available_bots> + recipient rendering
    `${sd}/bot-openids-${app}.json`,  // OWN routing cross-ref (sibling ones stay denied)
    // own sessions-<self>.json + attachments/<self> already pushed above (readOnly)
  ], 'readOnly', 'internal');
  // turn-sends: the CLI APPENDS a send-marker here (dedup); needs write, not read.
  // Exposed readWrite (write-only isn't expressible); it holds only message-id
  // markers (no content/creds) so read-exposure of the OWN-appended markers is benign.
  push([`${sd}/turn-sends`], 'readWrite', 'internal');
  // schedules.json: `botmux schedule` is a READ-MODIFY-WRITE store shared by all
  // bots (one file). It must be readWrite — a read-deny makes a sandboxed
  // `botmux schedule` load an empty map and overwrite, wiping EVERY bot's tasks.
  // This DOES expose other bots' task prompts+routing; accepted by the owner
  // (王旭 2026-07-16) as the cost of the schedule feature — same call the old
  // read-isolation made (schedules.json deliberately never denied).
  push([`${sd}/schedules.json`], 'readWrite', 'internal');
  // macOS lark-cli key store carve-out. The baseline DENIES the whole
  // `~/Library/Application Support/lark-cli` dir (it holds EVERY bot's appsecret
  // ciphertext + the master key — the pre-refactor cross-bot leak). But this bot
  // needs its OWN appsecret + the master key to decrypt it and authenticate
  // (verified: without these `lark-cli auth scopes` fails "keychain Get failed …
  // operation not permitted"). Re-allow ONLY those two, read-only, at a DEEPER
  // path than the deny so longest-prefix-wins. Siblings' `appsecret_*.enc` and
  // user tokens stay denied → the master key alone can't decrypt what it can't
  // read (verified: sibling ciphertext still DENIED). Linux keeps its keys in the
  // per-bot `.lark-cli-bots/<self>` dir (already readWrite above), so this is
  // darwin-only.
  if (ctx.platform === 'darwin') {
    const larkStore = `${ctx.homeDir}/Library/Application Support/lark-cli`;
    push([`${larkStore}/master.key.file`, `${larkStore}/appsecret_${ctx.currentAppId}.enc`], 'readOnly', 'internal');
  }

  // User config — highest precedence.
  push(ctx.userPaths?.readWrite, 'readWrite', 'user');
  push(ctx.userPaths?.readOnly, 'readOnly', 'user');
  push(ctx.userPaths?.deny, 'deny', 'user');
  push(ctx.mandatoryDenyPaths, 'deny', 'mandatory');
  push(ctx.mandatoryReadOnlyPaths, 'readOnly', 'mandatory');

  return {
    rules: mergeFsRules(candidates),
    net: ctx.net !== false,
    writeRegexes: [...(ctx.writeRegexes ?? [])],
    denyRegexes: [...(ctx.mandatoryDenyRegexes ?? [])],
    finalReadOnlyPaths: [...(ctx.mandatoryReadOnlyPaths ?? [])],
  };
}

// ───────────────────────────── Seatbelt compiler ─────────────────────────────

function escSb(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function escSbRegex(r: string): string {
  return r.replace(/"/g, '.'); // a `"` would terminate the #"…" literal
}

/** Every strict ancestor of every non-deny rule path. Under read-deny-default,
 *  realpath()/stat of an intermediate dir fails and crashes CLIs that
 *  canonicalize their config dir — so each ancestor needs file-read-metadata
 *  (literal, NOT subpath: no listing/enumeration is granted). */
export function ancestorsNeedingTraverse(rules: readonly FsRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.access === 'deny') continue;
    let p = r.path;
    for (;;) {
      const parent = p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/';
      if (!parent) break;
      out.add(parent);
      if (parent === '/') break;
      p = parent;
    }
  }
  return [...out].sort((a, b) => pathDepth(a) - pathDepth(b) || (a < b ? -1 : 1));
}

/** Apple's stock base profile — sets up the process-bootstrap file reads
 *  (dyld shared cache, sysctl-backed system paths, mach services) that a raw
 *  `(deny file-read* (subpath "/"))` would block, aborting the process before
 *  main(). Empirically required: with a blanket read-deny even `/usr/bin/true`
 *  SIGABRTs at dyld; importing this base fixes bootstrap WITHOUT opening the
 *  disk (verified: /etc/hosts and $HOME stay denied under it). */
const SEATBELT_BASE_PROFILE = '/System/Library/Sandbox/Profiles/bsd.sb';

/**
 * Compile the policy to a macOS Seatbelt profile. `(deny default)` + Apple's
 * bsd.sb base makes it deny-by-default for BOTH files and other operations,
 * then we re-allow the non-file operation classes the CLI needs (process/mach/
 * ipc/sysctl/signal, network gated on policy.net) and the three file tiers
 * emitted shallow→deep (Seatbelt applies the LAST matching rule → deepest rule
 * wins, matching accessForPath()).
 */
export function compileToSeatbelt(policy: FsPolicy): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    `(import "${SEATBELT_BASE_PROFILE}")`,
    // Non-file operation classes. `(allow default)` used to grant these wholesale;
    // under `(deny default)` we re-grant exactly what a CLI + its subprocesses need.
    '(allow process*)',
    '(allow signal)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow sysctl*)',
    '(allow file-ioctl)',
    ...(policy.net ? ['(allow network*)', '(allow system-socket)'] : []),
  ];
  for (const r of policy.rules) {
    const p = escSb(r.path);
    if (r.access === 'deny') {
      lines.push(`(deny file-read* (subpath "${p}"))`);
      lines.push(`(deny file-write* (subpath "${p}"))`);
    } else {
      lines.push(`(allow file-read* (subpath "${p}"))`);
      if (r.access === 'readWrite') lines.push(`(allow file-write* (subpath "${p}"))`);
      else lines.push(`(deny file-write* (subpath "${p}"))`); // re-assert: deeper ro inside a rw tree must drop write
    }
  }
  // Traversal metadata for ancestors of every allowed path — emitted AFTER the
  // rules so a broad deny cannot clobber the narrow literal grants a nested
  // allow needs (deny ~/x + readWrite ~/x/y: realpath must stat ~/x). Literal
  // (not subpath): grants stat/readlink of the dir itself, never listing.
  for (const p of ancestorsNeedingTraverse(policy.rules)) {
    lines.push(`(allow file-read-metadata (literal "${escSb(p)}"))`);
  }
  for (const re of policy.writeRegexes) {
    lines.push(`(allow file-write* (regex #"${escSbRegex(re)}"))`);
  }
  for (const re of policy.denyRegexes ?? []) {
    lines.push(`(deny file-read* (regex #"${escSbRegex(re)}"))`);
    lines.push(`(deny file-write* (regex #"${escSbRegex(re)}"))`);
  }
  for (const path of policy.finalReadOnlyPaths ?? []) {
    lines.push(`(allow file-read* (subpath "${escSb(path)}"))`);
    lines.push(`(deny file-write* (subpath "${escSb(path)}"))`);
  }
  return lines.join('\n') + '\n';
}

// ───────────────────────────── bwrap compiler ────────────────────────────────

export interface CompileBwrapOpts {
  /** Top-level symlinks to replicate inside the tmpfs root (usrmerge /bin →
   *  usr/bin etc.). Resolved by the worker (impure readlink). */
  symlinks?: readonly { path: string; target: string }[];
  /** Directory that will hold empty placeholder files for FILE-shaped deny
   *  rules (dirs are masked with tmpfs; files need an empty ro-bind source).
   *  The worker creates the returned `emptyFiles` before spawning. */
  emptiesDir: string;
  /** Rule paths that are FILES (not dirs) on the host — deny compiles to an
   *  empty-file bind, readOnly/readWrite file binds work as-is. Resolved by
   *  the worker (impure stat). */
  filePaths?: ReadonlySet<string>;
  /** chdir target (the project working dir). */
  chdir: string;
}

export interface BwrapCompilation {
  /** bwrap argv prefix (caller appends --setenv pairs and `-- cli args`). */
  args: string[];
  /** Empty placeholder files the worker must create before spawn. */
  emptyFiles: { path: string; maskedPath: string }[];
}

/**
 * Compile the policy to a bwrap argv prefix. Deny-by-default is bwrap's
 * natural shape: a fresh tmpfs root, then ONLY the rule paths are bound in
 * (later mounts win → emitting shallow→deep gives deepest-rule-wins, matching
 * accessForPath()). deny rules materialize as tmpfs/empty-file masks and are
 * only emitted when they sit under an exposed tree (outside it they're
 * unreachable already, and bwrap would fail mounting onto a void path).
 */
export function compileToBwrap(policy: FsPolicy, opts: CompileBwrapOpts): BwrapCompilation {
  const a: string[] = [];
  const emptyFiles: { path: string; maskedPath: string }[] = [];
  a.push('--tmpfs', '/');
  a.push('--proc', '/proc', '--dev', '/dev');
  a.push('--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp', '--tmpfs', '/dev/shm');
  for (const s of opts.symlinks ?? []) a.push('--symlink', s.target, s.path);

  const exposed: string[] = []; // non-deny paths emitted so far (for deny reachability)
  let emptyIdx = 0;
  for (const r of policy.rules) {
    if (r.access === 'deny') {
      if (!exposed.some(e => coversPath(e, r.path))) continue; // unreachable → already denied by default
      if (opts.filePaths?.has(r.path)) {
        const empty = `${opts.emptiesDir}/mask-${emptyIdx++}`;
        emptyFiles.push({ path: empty, maskedPath: r.path });
        a.push('--ro-bind', empty, r.path);
      } else {
        a.push('--tmpfs', r.path);
      }
      continue;
    }
    a.push(r.access === 'readWrite' ? '--bind' : '--ro-bind', r.path, r.path);
    exposed.push(r.path);
  }

  a.push('--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  if (!policy.net) a.push('--unshare-net');
  a.push('--die-with-parent', '--new-session', '--chdir', opts.chdir);
  return { args: a, emptyFiles };
}

// ───────────────────────────── legacy config migration ───────────────────────

export interface LegacySandboxFields {
  sandbox?: boolean;
  readIsolation?: boolean;
  sandboxReadonlyPaths?: readonly string[];
  sandboxHidePaths?: readonly string[];
  readDenyExtraPaths?: readonly string[];
}

export interface MigratedSandboxFields {
  sandbox: boolean;
  sandboxPaths?: { readWrite?: string[]; readOnly?: string[]; deny?: string[] };
}

/**
 * old→new field mapping (lossless: the old fields' expressiveness is a subset
 * of the three-tier model). Used by the registry's load-time auto-migration,
 * which writes the NEW fields while KEEPING the old ones in bots.json — a
 * downgraded daemon reads the untouched old fields, so downgrade needs no
 * reverse script (design doc §6.2). Returns null when nothing to migrate.
 */
export function migrateLegacySandboxFields(entry: LegacySandboxFields & { sandboxPaths?: unknown }): MigratedSandboxFields | null {
  if (entry.sandboxPaths !== undefined) return null; // already on the new model
  const hasLegacy = entry.readIsolation === true
    || (entry.sandboxReadonlyPaths?.length ?? 0) > 0
    || (entry.sandboxHidePaths?.length ?? 0) > 0
    || (entry.readDenyExtraPaths?.length ?? 0) > 0;
  const sandbox = entry.sandbox === true || entry.readIsolation === true;
  if (!hasLegacy) return null; // plain `sandbox: true` needs no path migration
  const readOnly = [...(entry.sandboxReadonlyPaths ?? [])];
  const deny = [...(entry.sandboxHidePaths ?? []), ...(entry.readDenyExtraPaths ?? [])];
  const sandboxPaths: MigratedSandboxFields['sandboxPaths'] = {};
  if (readOnly.length) sandboxPaths.readOnly = readOnly;
  if (deny.length) sandboxPaths.deny = [...new Set(deny)];
  return {
    sandbox,
    ...(readOnly.length || deny.length ? { sandboxPaths } : {}),
  };
}
