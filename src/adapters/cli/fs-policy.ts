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
  /** No-transport turns: caller-supplied allow paths (extraWrite / readonlyRoots /
   *  user RW+RO) that fell inside a Feishu-authority root and were dropped before
   *  merge (fail-closed). Empty/absent otherwise. The worker LOGS these so a
   *  silently-suppressed grant is diagnosable (codex: "至少要记录被抑制项"). */
  suppressedAuthorityPaths?: string[];
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
  /** This session's id — scopes the turn-sends dedup marker to a single file
   *  (`turn-sends/<sessionId>.jsonl`) so a sandboxed CLI cannot rewrite ANOTHER
   *  session's markers. Optional: when absent, no turn-sends grant is emitted
   *  (a non-session policy has no marker to write). */
  sessionId?: string;
  /** This bot's BOT_HOME (`<botmuxHome>/bots/<appId>`) — always readWrite. */
  botHome: string;
  /** This bot's OWN role-library subtree (`<roleLibraryRoot>/<appId>`) — readWrite.
   *  Optional: absent when the subtree does not exist (bot never used roles) or
   *  when building a non-session policy. See the emission site for why the whole
   *  subtree — not just the active role dir — has to be writable. */
  roleLibrarySubtree?: string;
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
  /** Per-adapter exact service-credential files. They are mandatory read-only
   *  for normal turns, but no-transport turns suppress entries inside Feishu
   *  authority roots before merge. Kept separate from mandatoryReadOnlyPaths:
   *  capability/attestation/MCP grants in that channel may legitimately live
   *  under botmux authority roots and must not be filtered wholesale. */
  serviceCredentialReadOnlyPaths?: readonly string[];
  /** Host-owned boundaries that user policy may not override. */
  mandatoryDenyPaths?: readonly string[];
  mandatoryDenyRegexes?: readonly string[];
  mandatoryReadOnlyPaths?: readonly string[];
  net?: boolean;
  /** Seatbelt write-allow regex passthrough (see FsPolicy.writeRegexes). */
  writeRegexes?: readonly string[];
  /** FALSE = a no-Lark-transport session (core-only apiOnly bot or HTTP virtual
   *  chat). Generic read-isolation is NOT a credential boundary: it still grants
   *  the bot's own lark-cli identity readWrite AND, when workingDir defaults to
   *  `~`, re-opens $HOME (incl. bots.json + sibling BOT_HOMEs) readWrite. When
   *  false, buildFsPolicy freezes the botmux authority ROOTS (configured + default
   *  `~/.botmux`, `~/.lark-cli(-bots)`, macOS lark-cli store) as WHOLE-DIR denies,
   *  withholds this bot's own lark-cli identity / keystore carve-out, and
   *  FAIL-CLOSES any caller allow path (workingDir / userPaths / readonlyRoots)
   *  that would fall inside an authority root — dropped BEFORE merge so a deeper
   *  grant can't re-open the deny (deepest-prefix-wins). The model CLI's own
   *  authPaths (`~/.codex` etc.) are NOT Feishu creds and stay granted readWrite.
   *  Absent/true = normal behavior. */
  larkTransportEnabled?: boolean;
  /** No-transport ONLY: the SECOND botmux authority root to freeze, when the
   *  daemon runs with a custom SESSION_DATA_DIR so `configuredBotmuxHome`
   *  (= dirname(dataDir), passed as `botmuxHome`) differs from the default
   *  `~/.botmux`. BOTH must be denied wholesale — the default root still holds
   *  the live `.dashboard-secret` HMAC + bots.json even when the data dir moved
   *  (codex P1: custom SESSION_DATA_DIR leaked the default `~/.botmux`). Ignored
   *  when equal to `botmuxHome`. MUST be canonical + host-frozen (never derived
   *  from agent-controllable env). */
  defaultBotmuxHome?: string;
  /** No-transport ONLY: the ACTUAL loaded bots-config path, frozen by the daemon
   *  (`getLoadedConfigPath()`), NOT guessed from BOTS_CONFIG env by the worker.
   *  When it lives INSIDE a frozen authority root the parent mask already covers
   *  it (no extra rule needed). When it lives OUTSIDE every authority root,
   *  buildFsPolicy THROWS {@link FsPolicyConfigError} — a no-transport turn must
   *  not silently mask an arbitrary parent dir (`/tmp`, `/etc`, a project root),
   *  which would break the core CLI (codex P1). Absent = default `~/.botmux/bots.json`. */
  loadedBotsConfigPath?: string;
  /** LINUX ONLY: the CANONICAL lark-cli data store dir that holds EVERY bot's
   *  `appsecret_<appId>.enc` + the shared `master.key` (the Linux analogue of the
   *  macOS `~/Library/Application Support/lark-cli` keystore). lark-cli resolves it
   *  to `${LARKSUITE_CLI_DATA_DIR}/lark-cli` (when that env var is ABSOLUTE) else
   *  `$HOME/.local/share/lark-cli` — it does NOT consult XDG_DATA_HOME (verified by
   *  strace on v1.0.76). So it is NOT purely a function of homeDir. The worker
   *  resolves it from the FROZEN host env (`resolveLarkCliLinuxStoreDir`) and
   *  canonicalizes it (this fn stays pure — it must never read env). Under the
   *  baseline `ro(~/.local/share)` grant the whole store is otherwise exposed
   *  read-only → a sandboxed bot could read its SIBLINGS' ciphertext + the shared
   *  master key and impersonate them (the pre-refactor cross-bot leak macOS already
   *  closes). buildFsPolicy DENIES the store and, for a transport-enabled turn,
   *  re-opens ONLY this bot's own `master.key` + `appsecret_<currentAppId>.enc`
   *  read-only at a deeper path (longest-prefix-wins), mirroring the darwin carve-out.
   *  A no-transport turn freezes it as an authority root with NO carve-out. Absent on
   *  Linux → falls back to the default `${homeDir}/.local/share/lark-cli` (correct
   *  whenever LARKSUITE_CLI_DATA_DIR is unset/relative — the common case — and still
   *  protective otherwise). Ignored on darwin. */
  larkCliLinuxStore?: string;
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

/**
 * Which adapter `authPaths` survive a CLI-data redirect into BOT_HOME.
 *
 * When a bot redirects its CLI data (CLAUDE_CONFIG_DIR/CODEX_HOME → BOT_HOME),
 * the adapter's REAL host data dir is rehomed: the isolated copy under BOT_HOME
 * is what the CLI reads/writes, and the host dir is denied-by-default (its
 * exposure was the whole point of read isolation). Any authPath that lives
 * INSIDE such a rehomed host root is therefore either (a) redundant — its
 * BOT_HOME equivalent is provisioned + covered readWrite by the botHome rule
 * (claude `.credentials.json`), or (b) an active leak we must NOT expose (codex's
 * whole `~/.codex`: history.jsonl, sessions/, state_*.sqlite). Both are dropped.
 *
 * But authPaths that live OUTSIDE every rehomed root are external login sources
 * the redirect does NOT rehome — e.g. Seed/Relay's `~/.local/share/bytedcli` SSO
 * dir (bytedcli login reuse). Dropping those regresses login (a fresh BOT_HOME /
 * expired token cold-start would have no credential source). They MUST survive.
 *
 * NOTE this is a SUPPRESSION-vs-KEEP decision only. A path inside a rehomed root
 * whose BOT_HOME copy is NOT provisioned (e.g. `<dataDir>/byted-cloud-auth.json`
 * — never seeded, and never the redirected read location since the CLI resolves
 * it under $CLAUDE_CONFIG_DIR=BOT_HOME) is still dropped: keeping the host path
 * would not help the redirected read anyway. Provisioning such files into
 * BOT_HOME is a separate concern (see provisionIsolatedBotHome), orthogonal to
 * closing the host-dir leak this filter exists for.
 *
 * @param authPaths     adapter authPaths, already `~`-expanded + normalized absolute
 * @param rehomedRoots  host data roots being redirected to BOT_HOME, normalized
 *                      (claude family: the host claudeDataDir; codex: `~/.codex`)
 */
export function authPathsSurvivingCliDataRedirect(
  authPaths: readonly string[],
  rehomedRoots: readonly string[],
): string[] {
  const roots = rehomedRoots.map(normalizeFsPath).filter((r): r is string => !!r);
  return authPaths.filter((raw) => {
    const p = normalizeFsPath(raw);
    if (!p) return false;
    // Keep iff NOT inside any rehomed host root.
    return !roots.some((root) => coversPath(root, p));
  });
}

/**
 * The COMPLETE authPaths the fs-policy should expose for a (possibly redirecting)
 * adapter. This is the single source of truth the worker calls — extracted so the
 * worker's call site and the tests exercise the SAME code, not a re-implementation
 * (a test that recomputes the rule would stay green if the worker stopped calling
 * this, which is exactly the wiring blind spot this avoids).
 *
 * - not redirected → expose the adapter's declared authPaths verbatim.
 * - redirected     → drop the ones inside a rehomed host data root
 *                    (authPathsSurvivingCliDataRedirect), keeping data-root-external
 *                    login sources (Seed/Relay bytedcli SSO).
 *
 * rehomedHostRoots is assembled from the adapter's ORIGINAL host data dir
 * (claude family) + the codex host root when applicable — passed in by the worker
 * (it owns `~`-expansion / existence-filter / canonicalization); this fn is pure.
 */
export function resolveRedirectedAdapterAuthPaths(input: {
  declaredAuthPaths: readonly string[];
  willRedirectCliData: boolean;
  rehomedHostRoots: readonly string[];
}): string[] {
  if (!input.willRedirectCliData) return [...input.declaredAuthPaths];
  return authPathsSurvivingCliDataRedirect(input.declaredAuthPaths, input.rehomedHostRoots);
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
 * A no-transport (apiOnly / HTTP-virtual) session whose layout cannot be safely
 * confined — e.g. an external `BOTS_CONFIG` sitting outside every botmux
 * authority root, or a `workingDir` that IS a Feishu-authority root. buildFsPolicy
 * throws this instead of silently masking an arbitrary parent dir (which would
 * hide `/tmp`/`/etc`/a project root and brick the core CLI) or silently dropping
 * the working dir. The worker turns it into a hard spawn-abort with a diagnostic —
 * fail-closed, never fail-open (codex P1). Carries `.kind` so callers/tests can
 * branch without string-matching the message. */
export class FsPolicyConfigError extends Error {
  readonly kind: 'external-bots-config' | 'working-dir-is-authority' | 'bots-config-in-carveout';
  constructor(kind: FsPolicyConfigError['kind'], message: string) {
    super(message);
    this.name = 'FsPolicyConfigError';
    this.kind = kind;
  }
}

/**
 * The Linux lark-cli keystore dir. lark-cli stores keys at
 * `${LARKSUITE_CLI_DATA_DIR}/lark-cli` (absolute) else `$HOME/.local/share/lark-cli`.
 * The worker resolves the real (env-aware, cleaned) path via
 * resolveLarkCliLinuxStoreDir + a nearest-existing-ancestor canonicalize, passing
 * it as `override`; when absent this falls back to the default under homeDir. PURE
 * — never reads env (that would break single-testability). Exported so the worker's
 * real assembly and the unit matrix share ONE resolver.
 *
 * `override` is expected to already be lexically clean (resolveLarkCliLinuxStoreDir
 * Cleans it); a defensive normalizeFsPath still rejects a `..`-bearing value — but
 * that must NEVER silently fall back to the default store (the pitfall this guards: the
 * default gets denied while the real `..`-cleaned store lark-cli reads stays exposed).
 * So a non-null-but-unnormalizable override returns null → the caller (buildFsPolicy)
 * emits NO Linux carve-out, and the store stays denied-by-default rather than
 * mis-anchored. In practice the worker always Cleans first, so this path is defensive.
 */
export function larkCliLinuxStorePath(homeDir: string, override?: string): string | null {
  if (override) return normalizeFsPath(override); // may be null → no carve-out (never silent default fallback)
  return normalizeFsPath(`${homeDir}/.local/share/lark-cli`);
}

/**
 * The CANONICAL lark-cli data root to pin into the sandbox child as
 * LARKSUITE_CLI_DATA_DIR, given the fully-canonical keystore dir the policy protects
 * (`canonStore` = worker's larkCliLinuxStore, leaf symlinks already followed). The
 * in-sandbox lark-cli opens `<pin>/lark-cli`, so the pin must be `dirname(canonStore)`
 * — but that is same-source with the policy-protected store ONLY when the canonical
 * store's basename is still `lark-cli` (the common case, incl. a symlink that resolves
 * to another dir also named `lark-cli`). If the `lark-cli` leaf was a symlink to a
 * DIFFERENTLY-named dir (basename !== 'lark-cli'), `<dirname>/lark-cli` would NOT equal
 * canonStore, so pinning it would point the child at an unbound/foreign path. There is
 * no leak either way (the policy denies the real store, and both candidate stores are
 * locked), so return null → the worker pins nothing and the child falls back to the
 * default store (also locked). Pure + total. (handles the symlinked keystore leaf case.)
 */
export function larkCliChildDataRoot(canonStore: string | null | undefined): string | null {
  const s = canonStore ? normalizeFsPath(canonStore) : null;
  if (!s || s === '/') return null;
  const lastSlash = s.lastIndexOf('/');
  const base = s.slice(lastSlash + 1);
  if (base !== 'lark-cli') return null; // symlinked-leaf to a different name → degrade safely
  return s.slice(0, lastSlash) || '/';
}

/**
 * Lexically clean an ABSOLUTE POSIX path the way Go's `filepath.Clean` does
 * (resolve `.`/`..` segments, collapse `//`, drop trailing `/`, clamp `..` at root)
 * — WITHOUT touching the filesystem. Returns null for a non-absolute input or one
 * containing NUL / control chars (lark-cli's `SafeEnvDirPath` rejects those). This
 * mirrors lark-cli's own env-path handling so the policy anchors the SAME dir the
 * in-sandbox CLI will open (a `..`-bearing `LARKSUITE_CLI_DATA_DIR` is
 * Clean'd by lark-cli to a real store, but an un-cleaned policy path was rejected by
 * normalizeFsPath and silently fell back to the default — leaving the real store
 * exposed). Pure + total.
 */
export function cleanPosixAbsPath(p: string): string | null {
  if (!p || typeof p !== 'string' || !p.startsWith('/')) return null;
  // Reject control chars (0x00–0x1F, 0x7F) — lark-cli's validator treats them as
  // invalid → falls back to $HOME; matching keeps policy == CLI.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; } // clamp at root (Go filepath.Clean semantics)
    out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * Resolve the lark-cli Linux store dir BEFORE canonicalization, replicating
 * lark-cli's OWN resolution (`internal/keychain/keychain_other.go::StorageDir` +
 * `SafeEnvDirPath`, verified by strace against v1.0.76): the keystore dir is
 * `<clean(LARKSUITE_CLI_DATA_DIR)>/lark-cli` when `LARKSUITE_CLI_DATA_DIR` is a VALID
 * ABSOLUTE path (lexically Cleaned — `..`/`.`/`//` resolved, control chars rejected),
 * else `$HOME/.local/share/lark-cli`. lark-cli does NOT consult `XDG_DATA_HOME` for
 * the keystore at all (strace: setting it has zero effect), and it IGNORES a relative
 * / tilde / empty / control-char `LARKSUITE_CLI_DATA_DIR` (spec-invalid → falls back
 * to $HOME). PURE (exported so the "absolute-cleaned / relative-ignored / unset /
 * `..`-cleaned / control-char-rejected" matrix is unit-locked against strace).
 *
 * CRITICAL: the `..` Clean must happen HERE, lexically, so the returned
 * path is already normalized (no `..`) — otherwise the worker's realpath throws on a
 * not-yet-existent store leaf, keeps the raw `..` path, normalizeFsPath rejects it,
 * and the policy silently anchors the DEFAULT store while lark-cli (which Cleans)
 * opens the real one → the real store stays exposed.
 *
 * The worker passes `process.env.LARKSUITE_CLI_DATA_DIR` + the (lexical) home, then
 * nearest-existing-ancestor `canonical()`s the result (a full-path realpath would
 * throw on the nonexistent leaf), and hands it to buildFsPolicy as `larkCliLinuxStore`.
 * This is the AUTHORITATIVE value the in-sandbox lark-cli reads: bwrap has NO
 * `--clearenv`, so the sandboxed child INHERITS `LARKSUITE_CLI_DATA_DIR` from the
 * worker's process env (redactChildEnv doesn't strip it), and the sandbox pins the
 * child's value to the SAME cleaned resolution (`--setenv`/`--unsetenv` in sandbox.ts)
 * so policy == CLI by construction.
 */
export function resolveLarkCliLinuxStoreDir(rawDataDir: string | undefined, homeDir: string): string {
  const cleaned = rawDataDir ? cleanPosixAbsPath(rawDataDir) : null;
  const base = cleaned ?? `${homeDir}/.local/share`;
  // Strip a trailing slash so a root base ('/') doesn't yield '//lark-cli' (the only
  // case that produces one — cleanPosixAbsPath returns '/' when all segments pop).
  return `${base === '/' ? '' : base}/lark-cli`;
}

/**
 * Compute the frozen Feishu-authority roots for a no-transport turn. PURE +
 * exported so the worker's real path assembly and the unit matrix lock the SAME
 * provenance logic (codex P2: prior tests hand-fed roots and never touched this).
 *
 *  - ALWAYS freezes BOTH the configured botmux root (`botmuxHome` = dirname of the
 *    data dir) AND the canonical default `~/.botmux` — a custom SESSION_DATA_DIR
 *    moves the data dir but the default root still holds the live `.dashboard-secret`
 *    HMAC + bots.json, so denying only one leaves the sibling-daemon escalation
 *    open (codex P1).
 *  - freezes the lark-cli identity/key stores: bare `~/.lark-cli` (repo marks it
 *    sensitive), `~/.lark-cli-bots`, macOS lark-cli store, AND the Linux lark-cli
 *    keystore (`$HOME/.local/share/lark-cli` or `<LARKSUITE_CLI_DATA_DIR>/lark-cli` — every bot's
 *    appsecret ciphertext + the shared master key; on Linux a no-transport turn
 *    must get NO carve-out into it, unlike the transport-enabled own-key carve-out).
 *  - the loaded bots-config path: OUTSIDE every root → THROW here (fail-closed);
 *    never mask its parent dir. Being INSIDE a root is necessary but NOT
 *    sufficient — a deeper trusted carve-out (own BOT_HOME / bin / attachments /
 *    outbox) can re-open it via deepest-prefix-wins, so buildFsPolicy ALSO runs a
 *    post-merge `accessForPath` self-check that the config + its dirname resolve
 *    to `deny`, else throws `bots-config-in-carveout` (codex P1).
 */
export function computeNoTransportAuthorityRoots(input: {
  platform: 'darwin' | 'linux';
  homeDir: string;
  botmuxHome: string;
  defaultBotmuxHome?: string;
  loadedBotsConfigPath?: string;
  larkCliLinuxStore?: string;
}): string[] {
  const roots = [...new Set([
    input.botmuxHome,
    ...(input.defaultBotmuxHome ? [input.defaultBotmuxHome] : []),
    `${input.homeDir}/.lark-cli`,
    `${input.homeDir}/.lark-cli-bots`,
    `${input.homeDir}/Library/Application Support/lark-cli`,
    // Linux keystore — BOTH candidate stores frozen (no own-key carve-out; transport-only).
    // lark-cli opens either `<resolved>/lark-cli` (custom LARKSUITE_CLI_DATA_DIR accepted) or
    // the default `$HOME/.local/share/lark-cli` (rejected/unset); a no-transport turn must
    // deny WHICHEVER, without depending on matching lark-cli's env-value validator.
    // LINUX-ONLY: macOS lark-cli uses the `Library/Application Support/lark-cli` store above,
    // NOT `~/.local/share/lark-cli`. Freezing the Linux paths on darwin is NOT a no-op — it
    // adds an authority root that would change darwin behavior (e.g. a no-transport
    // workingDir=~/.local/share/lark-cli would newly fail `working-dir-is-authority`). So
    // gate strictly on platform to keep darwin byte-identical to pre-refactor.
    ...(input.platform === 'linux' ? [
      `${input.homeDir}/.local/share/lark-cli`,
      ...(() => { const s = larkCliLinuxStorePath(input.homeDir, input.larkCliLinuxStore); return s ? [s] : []; })(),
    ] : []),
  ])].map(normalizeFsPath).filter((r): r is string => !!r);
  const cfg = input.loadedBotsConfigPath ? normalizeFsPath(input.loadedBotsConfigPath) : null;
  if (cfg && !roots.some(root => coversPath(root, cfg))) {
    throw new FsPolicyConfigError(
      'external-bots-config',
      `no-transport session refuses an external bots-config at ${cfg}: it lives outside every `
      + `botmux authority root (${roots.join(', ')}). A no-transport turn cannot safely mask its `
      + `parent directory (would hide arbitrary host paths like /tmp or /etc); move the config `
      + `under ~/.botmux or a dedicated data-dir root.`,
    );
  }
  return roots;
}

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

  // No-Lark-transport credential profile: a core-only (apiOnly) bot or HTTP
  // virtual session must never be handed any Feishu credential, even under a
  // wide workingDir=~ grant. When false we (a) suppress every Feishu-cred grant
  // below and (b) append MANDATORY denies for those paths so longest-prefix deny
  // beats any broad readWrite that would otherwise re-expose them.
  const larkTransport = ctx.larkTransportEnabled !== false;

  // No-Lark-transport authority roots (whole dirs, not exact files). A grant that
  // falls INSIDE one of these (workingDir=~, hostile user sandboxPaths, external
  // readonlyRoots) must be FAIL-CLOSED — dropped before it enters the rule set —
  // so a deeper allow can't re-open the authority deny (deepest-prefix wins).
  // The bot's OWN BOT_HOME is the sole exception (re-allowed deeper, minus
  // send-cred). Model-CLI authPaths live outside these roots and are unaffected.
  // computeNoTransportAuthorityRoots freezes BOTH the configured + default botmux
  // roots and THROWS on an external bots-config (fail-closed, never silent-mask).
  const authorityRoots = larkTransport ? [] : computeNoTransportAuthorityRoots({
    platform: ctx.platform,
    homeDir: ctx.homeDir,
    botmuxHome: ctx.botmuxHome,
    defaultBotmuxHome: ctx.defaultBotmuxHome,
    loadedBotsConfigPath: ctx.loadedBotsConfigPath,
    larkCliLinuxStore: ctx.larkCliLinuxStore,
  });
  // A path is authority-restricted when SOME authority root covers it — EXCEPT the
  // bot's own BOT_HOME carve-out (legitimately re-allowed deeper, minus send-cred).
  // That exception is scoped PER-ROOT: it fires only for a root that is an ANCESTOR
  // of BOT_HOME (the botmux root, of which BOT_HOME is a re-allowed subtree). An
  // authority root NESTED INSIDE BOT_HOME — e.g. the lark-cli keystore when a
  // deployment sets LARKSUITE_CLI_DATA_DIR into BOT_HOME so the store resolves to
  // `<BOT_HOME>/lark-cli` — is MORE SPECIFIC than the BOT_HOME carve-out and must
  // STILL restrict, or a deeper hostile user RW under the nested store escapes
  // dropAuthority and re-opens `master.key`/sibling appsecrets. So for
  // each root the BOT_HOME exception applies only when that root is an ancestor of
  // BOT_HOME AND p is inside BOT_HOME; a root at/under BOT_HOME keeps restricting.
  const insideAuthority = (p: string): boolean =>
    authorityRoots.some(root =>
      coversPath(root, p) && !(root !== ctx.botHome && coversPath(root, ctx.botHome) && coversPath(ctx.botHome, p)));
  // Dropped caller allow paths are RECORDED so the worker can log the suppression
  // (codex: a silently-dropped grant is a diagnosability hole).
  const suppressedAuthorityPaths: string[] = [];
  const dropAuthority = (paths: readonly string[] | undefined): string[] =>
    (paths ?? []).filter(p => {
      const n = normalizeFsPath(p);
      if (n === null) return false;
      if (insideAuthority(n)) { suppressedAuthorityPaths.push(n); return false; }
      return true;
    });
  const serviceCredentialReadOnlyPaths = dropAuthority(ctx.serviceCredentialReadOnlyPaths);

  // workingDir is the CLI's cwd — it MUST be granted, so we cannot silently drop
  // it. A workingDir that IS (or is inside) a Feishu-authority root — own BOT_HOME
  // excepted — is an unresolvable no-transport layout: fail-closed with a clear
  // config error rather than dropAuthority-then-spawn into an ungranted cwd
  // (codex P1). A workingDir that is merely an ANCESTOR of an authority root
  // (the common `workingDir=~` HTTP-trigger default) is fine — the deeper parent
  // deny masks the nested authority, so it stays granted below.
  if (!larkTransport) {
    const wd = normalizeFsPath(ctx.workingDir);
    if (wd !== null && insideAuthority(wd)) {
      throw new FsPolicyConfigError(
        'working-dir-is-authority',
        `no-transport session refuses workingDir ${wd}: it lives inside a Feishu-authority root `
        + `(${authorityRoots.join(', ')}) that a core-only turn must deny; choose a workingDir `
        + `outside these roots (or the bot's own BOT_HOME).`,
      );
    }
  }

  // Hoisted into a named const (vs the upstream inline `candidates.push(...)`)
  // because roleLibAccess() below inspects baseline's DENY entries.
  const baseline = ctx.platform === 'darwin' ? darwinBaseline(ctx.homeDir) : linuxBaseline(ctx.homeDir);
  candidates.push(...baseline);

  // Adapter-declared surfaces.
  push(ctx.execPaths, 'readOnly', 'adapter');
  // authPaths = the model CLI's OWN login/state surface (~/.codex, ~/.claude
  // credentials, Seed/bytedcli SSO, Gemini OAuth, OpenCode DB, …) — NOT Feishu.
  // These MUST stay granted even for a no-transport turn, else the CLI can't
  // authenticate and the core functionality breaks. The no-Lark-transport gate
  // only denies Feishu-authority paths (below), never the CLI's own auth.
  push(ctx.authPaths, 'readWrite', 'adapter');
  if (!ctx.redirectedCliData) push(ctx.cliDataPaths, 'readWrite', 'adapter');

  // botmux internals. workingDir/extraWrite/readonlyRoots are FAIL-CLOSED against
  // the authority roots for a no-transport turn (dropAuthority is identity when
  // larkTransport). botHome is always kept — it's the sanctioned carve-out.
  push([...dropAuthority([ctx.workingDir]), ctx.botHome], 'readWrite', 'internal');
  // Own role-library subtree (`~/botmux-roles/<self>`). workingDir alone covers
  // only the ACTIVE role dir, which silently disables the whole role system
  // under sandbox: 「切换角色/有哪些角色」enumerates the sibling role dirs and
  // reads each `.botmux-dir.json`, 「新建角色」writes `users/<openId>/<slug>/`
  // and copies the library-root `_role-protocol.md` into it, and after a switch
  // 「沉淀知识」writes `knowledge/` + `.botmux-dir.json` in the NEW role dir —
  // all of them outside the pre-switch workingDir. readWrite (not readOnly) for
  // that last reason: a read-only grant looks fine through switch+enumerate and
  // only EPERMs later, at the knowledge write.
  // Scoped to `<appId>` on purpose — NOT the shared library root: a sibling
  // bot's roles (and its users' private role dirs) stay denied by construction,
  // so cross-bot read isolation is preserved. (`validateRoleLibraryPath` narrows
  // `botmux role switch` to the same `<root>/<appId>` boundary, so the daemon-side
  // check and this fs-side grant agree — but the fs rule stands on its own: it
  // still holds for a session pointed elsewhere by other means.)
  // …and it never OVERRIDES a covering deny/readOnly. Source rank only settles
  // conflicts on the SAME path — different paths are always decided by depth — so
  // a shallower `deny: ["~/botmux-roles"]` (or `readOnly:`) would otherwise be
  // silently re-opened/upgraded at `<appId>` by this deeper internal rule. An
  // owner who locks the library must get a locked library, not a hole in it:
  //   covering deny (baseline / user / mandatory, path OR mandatory regex) → no rule
  //   covering readOnly (user / mandatoryReadOnly)                         → readOnly
  // A readOnly grant still lets the role system enumerate + switch; only the
  // knowledge write fails — strictly closer to what the owner asked for than
  // either silently upgrading to rw or dropping the rule entirely.
  // Asymmetry on purpose: baseline DENY counts (a ceiling), baseline readOnly does
  // NOT (a floor internal grants are meant to lift — e.g. toolchain dirs).
  // NO-TRANSPORT GATE: a core-only (apiOnly) / HTTP-virtual session has no Feishu
  // sender identity and no business with the role system, so it gets NO grant at
  // all. This is an EXPLICIT gate, not a consequence of dropAuthority /
  // authorityRoots — the role library (`~/botmux-roles`) is deliberately NOT one
  // of the authority roots (those are Feishu-credential dirs), and roleLibAccess
  // reads ctx.mandatoryDenyPaths, not the local authorityRoots list, so the
  // suppression above would never reach it. (This gate only withholds the SPECIAL
  // whole-subtree grant; it does not by itself make the role library unreadable —
  // a no-transport workingDir=~ still covers it via the parent grant. The claim is
  // narrow: "no extra role-library rw is injected for a no-transport turn".)
  const roleLibAccess = (raw: string): FsAccess | null => {
    const p = normalizeFsPath(raw);
    if (!p) return null; // unusable path → no rule (mergeFsRules would drop it anyway)
    const covered = (paths: readonly string[] | undefined) =>
      (paths ?? []).map(normalizeFsPath).some((d) => !!d && coversPath(d, p));
    if (covered([
      ...baseline.filter(r => r.access === 'deny').map(r => r.path),
      ...(ctx.userPaths?.deny ?? []),
      ...(ctx.mandatoryDenyPaths ?? []),
    ])) return null;
    // Regex denies: Seatbelt emits them after every path allow (deny wins there),
    // but compileToBwrap does not consume denyRegexes at all — Linux has no such
    // backstop, so an rw grant inside a regex-denied tree would simply win. Today
    // mandatoryDenyRegexes only ever point at BOT_HOME credential sidecars, never
    // at the role library; this keeps that from silently becoming a hole.
    // KNOWN BOUNDARY (codex review): this tests the subtree ROOT, which catches
    // ancestor-shaped regexes (the only shape botmux generates) but NOT one that
    // matches only a DESCENDANT (`<subtree>/secret$`) — regex-vs-subtree
    // intersection is not decidable from a prefix. Closing it properly means
    // either emitting a concrete deny path alongside every internal regex, or
    // making compileToBwrap consume denyRegexes (a pre-existing gap that applies
    // to EVERY rw grant — workingDir, botHome, … — not just this one).
    for (const rx of ctx.mandatoryDenyRegexes ?? []) {
      try { if (new RegExp(rx).test(p)) return null; } catch { /* unusable regex: not a grant decision */ }
    }
    if (covered([...(ctx.userPaths?.readOnly ?? []), ...(ctx.mandatoryReadOnlyPaths ?? [])])) return 'readOnly';
    return 'readWrite';
  };
  const roleLibGrant = larkTransport && ctx.roleLibrarySubtree ? roleLibAccess(ctx.roleLibrarySubtree) : null;
  if (roleLibGrant) push([ctx.roleLibrarySubtree!], roleLibGrant, 'internal');
  push(ctx.outbox ? [ctx.outbox] : [], 'readWrite', 'internal');
  push(dropAuthority(ctx.extraWritePaths), 'readWrite', 'internal');
  push(dropAuthority(ctx.readonlyRoots), 'readOnly', 'internal');
  // Own routing metadata (`botmux send` reply routing) — read-only. The store
  // is SQLite in its own per-bot DIRECTORY: the dir grant is deliberate — a
  // single-file bwrap bind pins the inode, and SQLite deletes/recreates
  // -wal/-shm across daemon restarts, so a persistent pane with file binds
  // would keep reading the dead WAL forever. A directory bind resolves names
  // live. Sibling bots' store dirs stay uncovered (deny-by-default).
  //
  // The pre-SQLite `sessions-<appId>.json` is granted too, and stays granted
  // until the upgrade window is provably closed: while the owning daemon still
  // runs a pre-SQLite build there is no `.db` at all, and a sandboxed
  // `botmux send` that cannot even stat that file reports "session not found"
  // — i.e. the agent silently loses the ability to reply.
  push([
    `${ctx.sessionDataDir}/sessions-${ctx.currentAppId}.json`,
    `${ctx.sessionDataDir}/session-stores/${ctx.currentAppId}`,
  ], 'readOnly', 'internal');
  // Own upload bucket — readWRITE: `botmux quoted` / downloadResources writes the
  // downloaded attachment under attachments/<self>/<messageId>/… (not just reads
  // pre-uploaded files). The worker mkdirs it pre-spawn so it survives the
  // existence-filter and gets bound rw. Siblings' buckets stay uncovered.
  push([`${ctx.sessionDataDir}/attachments/${ctx.currentAppId}`], 'readWrite', 'internal');
  // Own per-turn hook context（UserPromptSubmit sidecar，#794）——read-only。
  // daemon 在每次提交 user turn 前把 reminder/whiteboard 写到这里；hook 子进程
  // （在沙盒内）按内容指纹读回。worker 预创建目录以通过 existence-filter。
  if (ctx.sessionId) push([`${ctx.sessionDataDir}/prompt-ctx/${ctx.sessionId}`], 'readOnly', 'internal');
  // Own per-bot lark-cli config (agent-facing lark-cli identity). Withheld from
  // a no-transport turn — it IS this bot's Feishu credential surface.
  if (larkTransport) push([`${ctx.homeDir}/.lark-cli-bots/${ctx.currentAppId}`], 'readWrite', 'internal');

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
    // dashboard-daemons (sibling IPC port table) is the discovery half of the
    // trusted-host escalation — a no-transport turn must NOT get it (paired with
    // .dashboard-secret it lets an agent reach sibling daemons). Granted only for
    // transport-enabled bots; for no-transport it stays denied by the authority root.
    ...(larkTransport ? [`${sd}/dashboard-daemons`] : []),
    `${sd}/bots-info.json`,     // bot display names / avatars for <available_bots> + recipient rendering
    `${sd}/bot-openids-${app}.json`,  // OWN routing cross-ref (sibling ones stay denied)
    // own sessions-<self>.json + attachments/<self> already pushed above (readOnly)
  ], 'readOnly', 'internal');
  // turn-sends: the CLI APPENDS its OWN dedup marker to
  // `turn-sends/<sessionId>.jsonl` (write, not read). Grant the SINGLE file, not
  // the whole directory: a directory-wide readWrite let session A rewrite
  // session B's `<B>.jsonl` marker (corrupting B's send-dedup → dropped/duplicate
  // replies). The exact-file grant confines each session to its own marker. The
  // worker PRE-CREATES this file before spawn so it survives the existence
  // filter and bwrap can bind it (bwrap cannot bind a nonexistent source).
  if (ctx.sessionId) push([`${sd}/turn-sends/${ctx.sessionId}.jsonl`], 'readWrite', 'internal');
  // (schedules: stored PER BOT inside each BOT_HOME — the owner's dir is
  // already readWrite above and siblings' stores are denied by construction,
  // so the old shared data/schedules.json grant (and the cross-bot task-prompt
  // exposure it had to accept) is gone. The RMW sibling lock lives in the same
  // rw dir, so sandboxed `botmux schedule` mutations work on both platforms.)
  // macOS lark-cli key store carve-out. The baseline DENIES the whole
  // `~/Library/Application Support/lark-cli` dir (it holds EVERY bot's appsecret
  // ciphertext + the master key — the pre-refactor cross-bot leak). But this bot
  // needs its OWN appsecret + the master key to decrypt it and authenticate
  // (verified: without these `lark-cli auth scopes` fails "keychain Get failed …
  // operation not permitted"). Re-allow ONLY those two, read-only, at a DEEPER
  // path than the deny so longest-prefix-wins. Siblings' `appsecret_*.enc` and
  // user tokens stay denied → the master key alone can't decrypt what it can't
  // read (verified: sibling ciphertext still DENIED).
  if (ctx.platform === 'darwin' && larkTransport) {
    const larkStore = `${ctx.homeDir}/Library/Application Support/lark-cli`;
    push([`${larkStore}/master.key.file`, `${larkStore}/appsecret_${ctx.currentAppId}.enc`], 'readOnly', 'internal');
  }
  // LINUX lark-cli key store — SAME cross-bot leak, SAME carve-out (was missing).
  // lark-cli on Linux writes keys to `<LARKSUITE_CLI_DATA_DIR>/lark-cli` (when that env
  // var is a valid absolute path) else `$HOME/.local/share/lark-cli` — NOT the per-bot
  // `.lark-cli-bots/<self>` dir (that only holds config.json; secrets land in the shared
  // data store — verified on lark-cli 1.0.56/1.0.76). The linuxBaseline `ro(~/.local/share)`
  // grant exposed EVERY bot's `appsecret_*.enc` + the shared `master.key` read-only to any
  // sandboxed bot — a cross-bot impersonation hole macOS already closed. Mirror the darwin
  // fix: DENY the whole store (deeper than `~/.local/share` so longest-prefix wins), then
  // re-open ONLY this bot's own `master.key` (Linux name — NOT darwin's `master.key.file`)
  // + `appsecret_<self>.enc` read-only at a deeper path.
  //
  // TWO candidate stores, BOTH locked (lark-cli's env-value validator —
  // control chars / bidi / BOM rejection — is not perfectly replicable, so we do NOT try
  // to predict WHICH store it picks). lark-cli opens EITHER `<clean(env)>/lark-cli` (value
  // accepted) OR the default `$HOME/.local/share/lark-cli` (value rejected/unset/relative).
  // Denying both + carving own keys in both means: whichever lark-cli opens, siblings +
  // master stay denied (no leak) and this bot's own keys are readable (auth works) — with
  // ZERO dependence on matching lark-cli's char validator. Deduped when equal (common case:
  // no custom LARKSUITE_CLI_DATA_DIR → resolved == default → one store). `deny` tagged
  // `mandatory` (not `baseline` like darwin's): see the rank-collision note in the loop.
  // No-transport denies both stores wholesale via authorityRoots and gets NO carve-out.
  if (ctx.platform === 'linux' && larkTransport) {
    const stores = new Set<string>();
    const resolved = larkCliLinuxStorePath(ctx.homeDir, ctx.larkCliLinuxStore);
    if (resolved) stores.add(resolved);
    const dflt = normalizeFsPath(`${ctx.homeDir}/.local/share/lark-cli`);
    if (dflt) stores.add(dflt);
    for (const larkStore of stores) {
      // `mandatory` (not `baseline`): if a deployment wires the store onto BOT_HOME
      // itself (store === botHome — e.g. appId 'lark-cli' + LARKSUITE_CLI_DATA_DIR=<botmuxHome>/bots),
      // the internal BOT_HOME readWrite grant lands on the SAME path and would otherwise
      // outrank this deny by source rank (internal 2 > baseline 0), re-opening the whole
      // keystore rw. mandatory (4) keeps the ceiling; the deeper own-key carve-outs still win by depth.
      push([larkStore], 'deny', 'mandatory');
      push([`${larkStore}/master.key`, `${larkStore}/appsecret_${ctx.currentAppId}.enc`], 'readOnly', 'internal');
    }
  }

  // User config — highest precedence.
  // User config — highest precedence, but readWrite/readOnly grants are
  // FAIL-CLOSED against the authority roots for a no-transport turn (a hostile
  // `sandboxPaths.readWrite ~/.lark-cli-bots/<self>` must not re-open the deny).
  // User DENY entries are always kept (they only tighten).
  push(dropAuthority(ctx.userPaths?.readWrite), 'readWrite', 'user');
  push(dropAuthority(ctx.userPaths?.readOnly), 'readOnly', 'user');
  push(ctx.userPaths?.deny, 'deny', 'user');
  push(ctx.mandatoryDenyPaths, 'deny', 'mandatory');
  push(serviceCredentialReadOnlyPaths, 'readOnly', 'mandatory');
  push(ctx.mandatoryReadOnlyPaths, 'readOnly', 'mandatory');

  // No-Lark-transport HOST-AUTHORITY denies + minimal carve-out (codex escalation
  // fix). We DENY THE WHOLE authority ROOT(s) — not exact credential files, which
  // miss .bak/.tmp sidecars, future files, and `.dashboard-secret` (the
  // trusted-host HMAC that would let a no-transport agent sign sibling-daemon
  // routes). Conflicting deeper grants were already dropped above (dropAuthority),
  // so these denies aren't re-opened. The model CLI's own authPaths (~/.codex …)
  // live OUTSIDE these roots and stay granted.
  if (!larkTransport) {
    push(authorityRoots, 'deny', 'mandatory');
    // Minimal carve-out — re-allowed at a DEEPER prefix so it wins the
    // deepest-prefix resolution, WITHOUT re-exposing any authority file:
    //  • own BOT_HOME readWrite (working dir / scratch) — but its send-cred.json
    //    (the Feishu secret) stays denied at a deeper path still.
    push([ctx.botHome], 'readWrite', 'internal');
    push([`${ctx.botHome}/send-cred.json`], 'deny', 'mandatory');
    //  • own routing cross-ref + session file the CLI legitimately reads (read-only,
    //    own-app-scoped — NOT the shared secret/port table).
    push([
      `${ctx.sessionDataDir}/bots-info.json`,               // display names for <available_bots> (public-ish)
      `${ctx.sessionDataDir}/sessions-${ctx.currentAppId}.json`,
      // Own SQLite store DIRECTORY (see the larkTransport grant above for why
      // a dir, not the three files, and why the JSON is still granted).
      `${ctx.sessionDataDir}/session-stores/${ctx.currentAppId}`,
      `${ctx.sessionDataDir}/bot-openids-${ctx.currentAppId}.json`,
      // Core-only writes its `botmux` wrapper into <dataDir>/bin (dedicated, NOT
      // the shared ~/.botmux/bin) and prepends it to the worker PATH — read-only
      // so the sandboxed `botmux send` hook can exec it. Under the state root, so
      // no separate authority-root concern.
      `${ctx.sessionDataDir}/bin`,
    ], 'readOnly', 'internal');
    if (ctx.sessionId) push([`${ctx.sessionDataDir}/turn-sends/${ctx.sessionId}.jsonl`], 'readWrite', 'internal');
    // NOTE: dashboard-daemons (sibling IPC port table) and .dashboard-secret/-token
    // are deliberately NOT re-allowed — a no-transport turn has no business
    // reaching sibling daemons, and the secret is the escalation vector.
  }

  const rules = mergeFsRules(candidates);

  // Post-merge self-check for the loaded bots-config (codex P1). Being inside a
  // frozen authority root is necessary but NOT sufficient: this is a white-in-black
  // policy where the DEEPEST rule wins, and the no-transport carve-outs re-open
  // subtrees of the authority roots (own BOT_HOME readWrite, `bin` readOnly,
  // `attachments`/outbox readWrite, session metadata, install-root). BOTS_CONFIG
  // may be ANY file, so a config that happens to sit under one of those carve-outs
  // — or a future one — would be readable again, re-exposing every bot's secret
  // (and its .bak/.tmp sidecars). Assert the resolved policy actually DENIES both
  // the config file AND its containing dir (covers sidecars created next to it);
  // any readOnly/readWrite means a carve-out re-opened it → fail the layout closed.
  // This auto-covers carve-outs added later without re-enumerating filenames.
  if (!larkTransport && ctx.loadedBotsConfigPath) {
    const cfg = normalizeFsPath(ctx.loadedBotsConfigPath);
    if (cfg) {
      const dir = cfg.slice(0, cfg.lastIndexOf('/')) || '/';
      for (const probe of [cfg, dir]) {
        const eff = accessForPath(rules, probe).access;
        if (eff !== 'deny') {
          throw new FsPolicyConfigError(
            'bots-config-in-carveout',
            `no-transport session refuses bots-config at ${cfg}: it (or its directory ${dir}) `
            + `resolves to '${eff}', not 'deny' — a trusted carve-out (own BOT_HOME / bin / `
            + `attachments / outbox / install-root) re-opens it under deepest-prefix-wins, which `
            + `would re-expose every bot's secret. Move the config out of the botmux data/BOT_HOME `
            + `carve-out surface (a plain ~/.botmux/bots.json is denied wholesale).`,
          );
        }
      }
    }
  }

  return {
    rules,
    net: ctx.net !== false,
    writeRegexes: [...(ctx.writeRegexes ?? [])],
    denyRegexes: [...(ctx.mandatoryDenyRegexes ?? [])],
    finalReadOnlyPaths: [
      ...serviceCredentialReadOnlyPaths,
      ...(ctx.mandatoryReadOnlyPaths ?? []),
    ],
    suppressedAuthorityPaths: suppressedAuthorityPaths.length
      ? [...new Set(suppressedAuthorityPaths)].sort()
      : undefined,
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
 * ipc/sysctl/signal/iokit-open, network gated on policy.net) and the three file tiers
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
    // IOKit user clients. bsd.sb carries NO iokit rule, so `(deny default)` denies
    // every IOServiceOpen — and the frameworks that need one (CoreGraphics /
    // IOSurface / IOPMrootDomain power monitoring) often do NOT check the failure:
    // the process dies with a bare SIGSEGV inside IOKit, no sandbox diagnostic at
    // all. Reproduced with `chrome-headless-shell` (the binary behind an agent's
    // puppeteer/playwright screenshots): SEGV_ACCERR before first paint, every run.
    // NOT a claim that IOKit is security-irrelevant — opening user clients is real
    // kernel attack surface. It is an explicit COMPATIBILITY TRADE-OFF, of a piece
    // with the wholesale mach*/ipc*/sysctl* grants above: this sandbox's threat
    // model is the file isolation enforced by the tiers below (cross-bot reads and
    // credentials), not kernel-surface reduction. A per-user-client-class allow-list
    // would be tighter, but the required set drifts with macOS/silicon/toolchain and
    // every miss fails as that same silent crash. Tighten it behind an opt-in tier
    // if a deployment ever needs the kernel surface closed too.
    '(allow iokit-open)',
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
  /** A single MODE-000 EMPTY directory (worker-created, kept empty) ro-bound
   *  over DIRECTORY-shaped deny rules. `--ro-bind emptyDir <deny>` masks the
   *  real contents, makes the mountpoint read-only (unlike `--tmpfs <deny>`,
   *  which left a WRITABLE tmpfs), AND — because the source is mode 000 — a
   *  non-root process can't even list it (`ls`/`cat` fail, not just "returns
   *  empty"). Root bypasses DAC and can traverse it, but the source is EMPTY, so
   *  no real content leaks regardless of uid — emptiness is the guarantee, the
   *  000 mode only hardens listing for non-root. A real deny is neither readable
   *  (content), listable (non-root), nor writable. */
  emptyDir: string;
  /** Directory that will hold MODE-000 empty placeholder files for FILE-shaped
   *  deny rules (dirs are masked with the empty ro-bind above; files need an
   *  empty ro-bind source). The worker creates the returned `emptyFiles`
   *  (mode 000) first. */
  emptiesDir: string;
  /** Rule paths that are FILES (not dirs) on the host — deny compiles to an
   *  empty-file bind, readOnly/readWrite file binds work as-is. Resolved by
   *  the worker (impure stat). A deny path NOT in this set is masked as a
   *  DIRECTORY (covers both existing dirs and not-yet-existing paths). */
  filePaths?: ReadonlySet<string>;
  /** chdir target (the project working dir). */
  chdir: string;
  /** Drop `--unshare-pid` (keep the fresh `--proc /proc` mount, which works
   *  without a new pid namespace). Set ONLY in a nested sandbox that can't
   *  mount proc inside a new pid ns AND where no sibling secret is exposed via
   *  /proc — see sandbox.coreOnlyPidNamespaceDegrade. The filesystem deny/allow
   *  masks (the on-disk credential seal) are unaffected; this drops only the
   *  process-isolation defense-in-depth. Default false = full isolation. */
  skipPidNamespace?: boolean;
}

export interface BwrapCompilation {
  /** bwrap argv prefix (caller appends --setenv pairs and `-- cli args`). */
  args: string[];
  /** Mode-000 empty placeholder files the worker must create before spawn
   *  (the ro-bind SOURCE for file-shaped deny masks). */
  emptyFiles: { path: string; maskedPath: string }[];
  /** Every deny mountpoint that was masked, with its shape. The worker must
   *  ensure each exists on the host BEFORE spawn (bwrap cannot bind onto a
   *  missing target, and a missing target under a read-write parent would make
   *  bwrap materialise it on the host anyway) — creating a mountpoint the host
   *  can write to even when the policy makes its PARENT read-only in-sandbox,
   *  which is exactly what closes the "host/other process creates the secret
   *  mid-session" TOCTOU. Mountpoints the worker itself had to create (didn't
   *  pre-exist) are removed at teardown IFF still empty (never a recursive rm —
   *  content written by the host/a concurrent process is preserved). */
  maskMounts: { path: string; kind: 'dir' | 'file' }[];
}

/**
 * Compile the policy to a bwrap argv prefix. Deny-by-default is bwrap's
 * natural shape: a fresh tmpfs root, then ONLY the rule paths are bound in
 * (later mounts win → emitting shallow→deep gives deepest-rule-wins, matching
 * accessForPath()). deny rules materialize as READ-ONLY empty masks with the
 * real content HIDDEN (mode-000 empty-dir ro-bind for dirs, mode-000 empty-file
 * ro-bind for files; mode 000 additionally blocks listing for a non-root uid,
 * while root may list the empty mask — no real content leaks either way) and are
 * emitted whenever they sit under an exposed tree — outside it
 * they're unreachable already (deny-by-default), and bwrap would fail mounting
 * onto a void path.
 *
 * Two properties this must preserve (both cost real blockers in review):
 *  1. The mask is `--ro-bind` of an EMPTY source, NOT `--tmpfs`: a `--tmpfs
 *     <deny>` mount is WRITABLE inside the sandbox, so it hid the real contents
 *     but still let the CLI write into the denied path — not a real deny.
 *  2. A deny path is masked EVEN WHEN IT DOES NOT EXIST YET. Skipping absent
 *     denies left the path inside the read-write parent bind, so the sandbox
 *     could `mkdir`+write it straight onto the host, and anything the host
 *     created there mid-session became readable (a stat→exec TOCTOU). The
 *     worker pre-creates the mountpoint on the host so the mask always binds.
 */
export function compileToBwrap(policy: FsPolicy, opts: CompileBwrapOpts): BwrapCompilation {
  const a: string[] = [];
  const emptyFiles: { path: string; maskedPath: string }[] = [];
  const maskMounts: { path: string; kind: 'dir' | 'file' }[] = [];
  a.push('--tmpfs', '/');
  a.push('--proc', '/proc', '--dev', '/dev');
  a.push('--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp', '--tmpfs', '/dev/shm');
  for (const s of opts.symlinks ?? []) a.push('--symlink', s.target, s.path);

  const exposed: string[] = []; // non-deny paths emitted so far (for deny reachability)
  const remountRo: string[] = []; // deny tmpfs masks to re-seal read-only after nested binds
  let emptyIdx = 0;
  for (const r of policy.rules) {
    if (r.access === 'deny') {
      if (!exposed.some(e => coversPath(e, r.path))) continue; // unreachable → already denied by default
      // Does a DEEPER allow (white-in-black carve-out) live under this deny?
      // e.g. readWrite /proj → deny /proj/x → readWrite /proj/x/self. If so the
      // mask must be able to HOST a child submount — a mode-000 read-only bind
      // can't (bwrap: "Can't mkdir …/self: Read-only file system"). Use a fresh
      // `--tmpfs` mask (hides the real contents, accepts the nested bind) and
      // re-seal it read-only with `--remount-ro` AFTER the nested binds are
      // emitted. tmpfs writes are in-memory and NEVER touch the host; the mask
      // is listable only for the carve-out's own path (inherent to white-in-black).
      const hasNestedAllow = policy.rules.some(o =>
        o.access !== 'deny' && o.path !== r.path && coversPath(r.path, o.path));
      // A deny is REDUNDANT only when the NEAREST enclosing rule is ALSO a deny:
      // then this path is already masked by that ancestor and emitting a deeper
      // mask would (a) add nothing and (b) fail to mount onto the ancestor's
      // mode-000 read-only mask. Redundancy MUST be judged by the deepest strict
      // ancestor rule — NOT "any ancestor deny exists" — because an allow can
      // re-expose the tree between the two denies (deny /outer → allow
      // /outer/self → deny /outer/self/secret): there the nearest ancestor of
      // `secret` is the `self` ALLOW, so `secret` is a real leaf deny that MUST
      // be masked (skipping it leaks the secret). Find the deepest exposed strict
      // ancestor and skip only when it denies.
      let nearestAncestor: FsRule | undefined;
      for (const o of policy.rules) {
        if (o.path === r.path || !coversPath(o.path, r.path)) continue; // strict ancestor only
        if (o.access !== 'deny' && !exposed.includes(o.path)) continue; // allow ancestor must be emitted to count
        if (o.access === 'deny' && !exposed.some(e => coversPath(e, o.path))) continue; // deny ancestor must be reachable
        if (!nearestAncestor || pathDepth(o.path) > pathDepth(nearestAncestor.path)) nearestAncestor = o;
      }
      const shadowedByDeny = !hasNestedAllow && nearestAncestor?.access === 'deny';
      if (shadowedByDeny) continue;
      if (hasNestedAllow) {
        a.push('--tmpfs', r.path);
        remountRo.push(r.path);
        maskMounts.push({ path: r.path, kind: 'dir' });
      } else if (opts.filePaths?.has(r.path)) {
        // FILE-shaped leaf deny: ro-bind a mode-000 empty placeholder file
        // (content hidden + read-only; mode 000 blocks read for non-root).
        const empty = `${opts.emptiesDir}/mask-${emptyIdx++}`;
        emptyFiles.push({ path: empty, maskedPath: r.path });
        a.push('--ro-bind', empty, r.path);
        maskMounts.push({ path: r.path, kind: 'file' });
      } else {
        // DIRECTORY-shaped leaf deny (existing dir OR not-yet-existing path):
        // ro-bind the shared mode-000 empty dir → real contents hidden, mount
        // read-only; mode 000 additionally blocks listing for a non-root uid
        // (root may list the empty mask, but there is no real content to see —
        // not a writable/listable tmpfs).
        a.push('--ro-bind', opts.emptyDir, r.path);
        maskMounts.push({ path: r.path, kind: 'dir' });
      }
      continue;
    }
    a.push(r.access === 'readWrite' ? '--bind' : '--ro-bind', r.path, r.path);
    exposed.push(r.path);
  }
  // Re-seal white-in-black deny masks read-only AFTER their nested carve-out
  // binds were emitted (a --remount-ro before the child bind would block the
  // mkdir; after it, the child submount keeps its own writability while the
  // tmpfs parent becomes unwritable).
  for (const p of remountRo) a.push('--remount-ro', p);

  // --unshare-pid is the process-isolation half of the sandbox (defense in
  // depth), NOT the credential seal — that is the FS deny masks above. A NESTED
  // sandbox can't mount a fresh /proc inside a new pid ns (bwrap: "Can't mount
  // proc on /newroot/proc: Operation not permitted"), so it is dropped there
  // via skipPidNamespace. The fresh `--proc /proc` (line above) still mounts
  // fine WITHOUT a new pid ns. skipPidNamespace is gated (sandbox.coreOnly
  // PidNamespaceDegrade) to core-only, where no sibling worker holds a secret
  // in env → dropping pid isolation exposes no /proc/<pid>/environ secret.
  const unshares = ['--unshare-user'];
  if (!opts.skipPidNamespace) unshares.push('--unshare-pid');
  unshares.push('--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  a.push(...unshares);
  if (!policy.net) a.push('--unshare-net');
  a.push('--die-with-parent', '--new-session', '--chdir', opts.chdir);
  return { args: a, emptyFiles, maskMounts };
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
